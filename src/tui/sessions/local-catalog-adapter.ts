import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import type { LedgerHeader } from "../../runtime/ledger/types.ts";
import { MAX_RUNTIME_EVENT_BYTES, validateRuntimeEvent } from "../../runtime/protocol/v3/schemas.ts";
import { readSessionPublication } from "../../runtime/session/session-publication.ts";
import type { SessionCatalogPort } from "./catalog.ts";
import type {
  SessionCatalogCurrentRef,
  SessionCatalogError,
  SessionDetailResult,
  SessionDiagnostic,
  SessionListResult,
  SessionPreviewResult,
  SessionSummary,
} from "./types.ts";

const MAX_LEGACY_HEADER_BYTES = 64 * 1024;
const FIRST_LINE_READ_BYTES = MAX_RUNTIME_EVENT_BYTES + 2;

export interface LocalSessionCatalogAdapterOptions {
  cwd: string;
  sessionDir: string;
  currentSession?: SessionCatalogCurrentRef;
}

interface FirstLine {
  bytes: Uint8Array;
  text: string;
}

export class LocalSessionCatalogAdapter implements SessionCatalogPort {
  private readonly cwd: string;
  private readonly sessionDir: string;
  private readonly currentSession: SessionCatalogCurrentRef | undefined;

  constructor(options: LocalSessionCatalogAdapterOptions) {
    this.cwd = resolve(options.cwd);
    this.sessionDir = resolve(options.sessionDir);
    this.currentSession = options.currentSession
      ? { id: options.currentSession.id, filePath: resolve(options.currentSession.filePath) }
      : undefined;
  }

  async listLite(input: {
    query: string;
    listRequestId: string;
    signal: AbortSignal;
  }): Promise<SessionListResult> {
    void input.listRequestId;
    if (input.signal.aborted) return failure("aborted", "session listing was cancelled", false);
    let names: string[];
    try {
      names = (await readdir(this.sessionDir)).filter((name) => name.endsWith(".jsonl"));
    } catch (error) {
      if (isNodeError(error, "ENOENT")) {
        return { ok: true, value: { sessions: [], diagnostics: [] } };
      }
      return failure(
        "directory_unavailable",
        `session directory is unavailable: ${nodeErrorMessage(error)}`,
        true,
      );
    }

    const sessions: SessionSummary[] = [];
    const diagnostics: SessionDiagnostic[] = [];
    for (const name of names.sort()) {
      if (input.signal.aborted) return failure("aborted", "session listing was cancelled", false);
      const filePath = join(this.sessionDir, name);
      const inspected = await this.inspectLite(filePath, input.signal);
      if (inspected.ok) sessions.push(inspected.value);
      else diagnostics.push({ ...inspected.diagnostic, fileName: name });
    }
    const query = input.query.trim().toLocaleLowerCase();
    const filtered = query.length === 0
      ? sessions
      : sessions.filter((session) =>
        `${session.id} ${session.title}`.toLocaleLowerCase().includes(query)
      );
    filtered.sort((left, right) =>
      right.modifiedAt - left.modifiedAt || left.id.localeCompare(right.id)
    );
    return { ok: true, value: { sessions: filtered, diagnostics } };
  }

  async enrich(input: {
    sessionId: string;
    enrichRequestId: string;
    signal: AbortSignal;
  }): Promise<SessionDetailResult> {
    void input;
    return failure("not_found", "session detail is not available in this slice", false);
  }

  async loadFullPreview(input: {
    sessionId: string;
    previewRequestId: string;
    signal: AbortSignal;
  }): Promise<SessionPreviewResult> {
    void input;
    return failure("not_found", "session preview is not available in this slice", false);
  }

  private async inspectLite(
    filePath: string,
    signal: AbortSignal,
  ): Promise<
    | { ok: true; value: SessionSummary }
    | { ok: false; diagnostic: Omit<SessionDiagnostic, "fileName"> }
  > {
    try {
      const before = await lstat(filePath);
      if (before.isSymbolicLink()) {
        return diagnostic("symlink", "symbolic-link session entries are not followed");
      }
      if (!before.isFile()) return diagnostic("corrupt", "session entry is not a regular file");
      const durablePublication = await readSessionPublication(`${filePath}.state`);
      if (!durablePublication.ok) return diagnostic("corrupt", durablePublication.error.message);
      if (durablePublication.value?.state === "staging") {
        return diagnostic("staging", "v3 session is still staging");
      }
      if (durablePublication.value?.state === "failed") {
        return diagnostic("unpublished", "v3 session publication failed");
      }
      const first = await readFirstLine(filePath, signal);
      if (!first.ok) return first;
      const parsed = parseJson(first.value.text);
      if (!parsed.ok) return diagnostic("corrupt", "session first record is malformed JSON");
      if (isLedgerHeader(parsed.value)) {
        if (first.value.bytes.byteLength > MAX_LEGACY_HEADER_BYTES) {
          return diagnostic("oversize", "legacy session header exceeds 64 KiB");
        }
        const after = await lstat(filePath);
        if (!sameFileSnapshot(before, after)) {
          return diagnostic("changed", "session changed while its header was read");
        }
        const title = explicitTitle(parsed.value.metadata);
        const cwd = explicitCwd(parsed.value.metadata);
        return {
          ok: true,
          value: {
            id: parsed.value.sessionId,
            title: title ?? "Untitled session",
            ...(cwd ? { cwd } : {}),
            createdAt: parsed.value.createdAt,
            modifiedAt: after.mtimeMs,
            format: parsed.value.version === 1 ? "v1" : "v2",
            compatibility: parsed.value.version === 1 ? "migration-required" : "read-only",
            lifecycle: "unknown",
            isCurrent: this.isCurrent(parsed.value.sessionId, filePath),
          },
        };
      }

      const validation = validateRuntimeEvent(parsed.value);
      if (!validation.ok || validation.value.sequence !== 0 || validation.value.stream.scope !== "session") {
        return diagnostic("corrupt", "session genesis is not a valid v3 session event");
      }
      const publication = durablePublication;
      if (!publication.value) return diagnostic("unpublished", "v3 session has no publication record");
      if (
        publication.value.fileName !== basename(filePath) ||
        publication.value.sessionId !== validation.value.stream.sessionId ||
        publication.value.genesis?.eventId !== validation.value.eventId ||
        publication.value.genesis.eventHash !== validation.value.currentEventHash
      ) {
        return diagnostic("corrupt", "v3 publication does not bind the session genesis");
      }
      const after = await lstat(filePath);
      if (!sameFileSnapshot(before, after)) {
        return diagnostic("changed", "session changed while its genesis was read");
      }
      return {
        ok: true,
        value: {
          id: validation.value.stream.sessionId,
          title: "Untitled session",
          createdAt: Date.parse(publication.value.createdAt),
          modifiedAt: after.mtimeMs,
          format: "v3",
          compatibility: "read-only",
          lifecycle: "unknown",
          isCurrent: this.isCurrent(validation.value.stream.sessionId, filePath),
        },
      };
    } catch (error) {
      return diagnostic("corrupt", nodeErrorMessage(error));
    }
  }

  private isCurrent(sessionId: string, filePath: string): boolean {
    return this.currentSession?.id === sessionId &&
      this.currentSession.filePath === resolve(filePath);
  }
}

async function readFirstLine(
  filePath: string,
  signal: AbortSignal,
): Promise<
  | { ok: true; value: FirstLine }
  | { ok: false; diagnostic: Omit<SessionDiagnostic, "fileName"> }
> {
  if (signal.aborted) return diagnostic("changed", "session listing was cancelled");
  const handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const buffer = Buffer.alloc(FIRST_LINE_READ_BYTES);
    const read = await handle.read(buffer, 0, buffer.byteLength, 0);
    const bytes = buffer.subarray(0, read.bytesRead);
    const newline = bytes.indexOf(0x0a);
    if (newline < 0) {
      return diagnostic("oversize", "session first record exceeds the bounded read limit");
    }
    const line = bytes.subarray(0, newline);
    if (line.includes(0x0d)) return diagnostic("corrupt", "session first record uses invalid CR framing");
    try {
      return {
        ok: true,
        value: {
          bytes: line,
          text: new TextDecoder("utf-8", { fatal: true }).decode(line),
        },
      };
    } catch {
      return diagnostic("corrupt", "session first record is not valid UTF-8");
    }
  } finally {
    await handle.close();
  }
}

function isLedgerHeader(value: unknown): value is LedgerHeader {
  if (!isRecord(value) || value.type !== "ledger") return false;
  return (value.version === 1 || value.version === 2) &&
    typeof value.id === "string" &&
    typeof value.sessionId === "string" &&
    typeof value.createdAt === "number";
}

function explicitTitle(metadata: Record<string, unknown> | undefined): string | undefined {
  const value = metadata?.title;
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function explicitCwd(metadata: Record<string, unknown> | undefined): string | undefined {
  const value = metadata?.cwd;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function parseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

function diagnostic(
  code: SessionDiagnostic["code"],
  message: string,
): { ok: false; diagnostic: Omit<SessionDiagnostic, "fileName"> } {
  return { ok: false, diagnostic: { code, message } };
}

function failure<T>(
  code: SessionCatalogError["code"],
  message: string,
  retryable: boolean,
): { ok: false; error: SessionCatalogError } {
  return { ok: false, error: { code, message, retryable } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sameFileSnapshot(
  before: { dev: number | bigint; ino: number | bigint; size: number; mtimeMs: number },
  after: { dev: number | bigint; ino: number | bigint; size: number; mtimeMs: number },
): boolean {
  return before.dev === after.dev &&
    before.ino === after.ino &&
    before.size === after.size &&
    before.mtimeMs === after.mtimeMs;
}

function isNodeError(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code;
}

function nodeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
