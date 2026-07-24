import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import type { LedgerHeader } from "../../runtime/ledger/types.ts";
import type { ModelThinkingLevel } from "../../types.ts";
import { canonicalDigest } from "../../runtime/protocol/v3/canonical-json.ts";
import { MAX_RUNTIME_EVENT_BYTES, validateRuntimeEvent } from "../../runtime/protocol/v3/schemas.ts";
import type { RuntimeEventV3 } from "../../runtime/protocol/v3/events.ts";
import { replayRuntimeConfigurationEvents } from "../../runtime/session/conversation-replay.ts";
import { scanJsonlV3EventLog } from "../../runtime/session/jsonl-v3-store.ts";
import { reduceSessionEvents } from "../../runtime/session/reducer.ts";
import {
  readSessionPublication,
  type SessionPublicationRecord,
} from "../../runtime/session/session-publication.ts";
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
const MAX_ENRICH_BYTES = 64 * 1024 * 1024;
const MAX_ENRICH_RECORDS = 1_000_000;

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
    void input.enrichRequestId;
    if (input.signal.aborted) return failure("aborted", "session detail was cancelled", false);
    const located = await this.locate(input.sessionId, input.signal);
    if (!located) return failure("not_found", `session not found: ${input.sessionId}`, false);
    try {
      const before = await lstat(located.filePath);
      if (!before.isFile() || before.isSymbolicLink()) {
        return failure("corrupt", "session detail target is not a regular file", false);
      }
      if (before.size > MAX_ENRICH_BYTES) {
        return failure("oversize", "session detail exceeds the 64 MiB scan limit", false);
      }
      const handle = await open(located.filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
      let bytes: Buffer;
      try {
        bytes = await handle.readFile();
      } finally {
        await handle.close();
      }
      if (input.signal.aborted) return failure("aborted", "session detail was cancelled", false);
      const after = await lstat(located.filePath);
      if (
        bytes.byteLength > MAX_ENRICH_BYTES ||
        !sameFileSnapshot(before, after) ||
        bytes.byteLength !== after.size
      ) {
        return failure("changed", "session changed while detail metadata was scanned", true);
      }
      return located.summary.format === "v3"
        ? this.enrichV3(located.filePath, located.summary, bytes)
        : this.enrichLegacy(located.filePath, located.summary, bytes);
    } catch (error) {
      return failure("corrupt", nodeErrorMessage(error), false);
    }
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

  private async locate(
    sessionId: string,
    signal: AbortSignal,
  ): Promise<{ filePath: string; summary: SessionSummary } | undefined> {
    if (this.currentSession?.id === sessionId) {
      const inspected = await this.inspectLite(this.currentSession.filePath, signal);
      if (inspected.ok && inspected.value.id === sessionId) {
        return { filePath: this.currentSession.filePath, summary: inspected.value };
      }
      return undefined;
    }
    let names: string[];
    try {
      names = await readdir(this.sessionDir);
    } catch {
      return undefined;
    }
    for (const name of names.filter((value) => value.endsWith(".jsonl")).sort()) {
      if (signal.aborted) return undefined;
      const filePath = join(this.sessionDir, name);
      const inspected = await this.inspectLite(filePath, signal);
      if (inspected.ok && inspected.value.id === sessionId) {
        return { filePath, summary: inspected.value };
      }
    }
    return undefined;
  }

  private enrichLegacy(
    filePath: string,
    summary: SessionSummary,
    bytes: Uint8Array,
  ): SessionDetailResult {
    const decoded = decodeStrictJsonLines(bytes);
    if (!decoded.ok) return failure("corrupt", decoded.message, false);
    if (decoded.records.length > MAX_ENRICH_RECORDS) {
      return failure("oversize", "session detail exceeds the record-count limit", false);
    }
    if (!isLedgerHeader(decoded.records[0])) {
      return failure("corrupt", "legacy session header is invalid", false);
    }
    let messageCount = 0;
    let turnCount = 0;
    let toolCount = 0;
    let provider: string | undefined;
    let model: string | undefined;
    let thinkingLevel: ModelThinkingLevel | undefined;
    for (const record of decoded.records.slice(1)) {
      if (!isRecord(record) || record.sessionId !== summary.id || typeof record.type !== "string") {
        return failure("corrupt", "legacy session contains an invalid entry", false);
      }
      if (record.type === "message") messageCount++;
      else if (record.type === "turn") turnCount++;
      else if (record.type === "tool_call") toolCount++;
      if (
        record.type === "custom" &&
        isRecord(record.payload) &&
        record.payload.kind === "runtime.config"
      ) {
        if (typeof record.payload.provider === "string") provider = record.payload.provider;
        if (typeof record.payload.model === "string") model = record.payload.model;
        if (isThinkingLevel(record.payload.thinkingLevel)) {
          thinkingLevel = record.payload.thinkingLevel;
        }
      }
    }
    const header = decoded.records[0];
    const parentSessionId = typeof header.metadata?.parentSessionId === "string"
      ? header.metadata.parentSessionId
      : undefined;
    return {
      ok: true,
      value: {
        summary,
        filePath,
        messageCount,
        turnCount,
        toolCount,
        ...(provider ? { provider } : {}),
        ...(model ? { model } : {}),
        ...(thinkingLevel ? { thinkingLevel } : {}),
        ...(parentSessionId ? { parentSessionId } : {}),
      },
    };
  }

  private async enrichV3(
    filePath: string,
    summary: SessionSummary,
    bytes: Uint8Array,
  ): Promise<SessionDetailResult> {
    const firstNewline = bytes.indexOf(0x0a);
    if (firstNewline < 0) return failure("corrupt", "v3 session has no complete genesis", false);
    const firstParsed = parseJson(new TextDecoder().decode(bytes.subarray(0, firstNewline)));
    if (!firstParsed.ok) return failure("corrupt", "v3 genesis is malformed", false);
    const genesis = validateRuntimeEvent(firstParsed.value);
    if (!genesis.ok || genesis.value.stream.scope !== "session") {
      return failure("corrupt", "v3 genesis is invalid", false);
    }
    const scan = scanJsonlV3EventLog(bytes, {
      authorityId: genesis.value.authorityId,
      tenantId: genesis.value.tenantId,
      stream: genesis.value.stream,
    });
    if (scan.firstError || scan.tornTail) {
      return failure("corrupt", scan.firstError?.message ?? "v3 session has a torn tail", false);
    }
    if (scan.events.length > MAX_ENRICH_RECORDS) {
      return failure("oversize", "session detail exceeds the event-count limit", false);
    }
    const projection = reduceSessionEvents(scan.events);
    if (!projection.ok) return failure("corrupt", projection.error.message, false);
    const publication = await readPublishedV3Binding(filePath);
    if (!publication.ok) return publication;
    const published = publication.value;
    const publishedHead = published.head
      ? scan.events[published.head.sequence]
      : undefined;
    if (
      !published.head ||
      !publishedHead ||
      published.head.eventId !== publishedHead.eventId ||
      published.head.eventHash !== publishedHead.currentEventHash
    ) {
      return failure("changed", "v3 publication head does not match the verified log", true);
    }
    const publishedProjection = reduceSessionEvents(
      scan.events.slice(0, published.head.sequence + 1),
    );
    if (
      !publishedProjection.ok ||
      published.projectionDigest !== canonicalDigest(publishedProjection.value)
    ) {
      return failure("corrupt", "v3 publication projection digest is invalid", false);
    }
    const configuration = replayRuntimeConfigurationEvents(scan.events);
    if (!configuration.ok) return failure("corrupt", configuration.error.message, false);
    const v3Summary: SessionSummary = {
      ...summary,
      lifecycle: mapLifecycle(projection.value.lifecycle),
    };
    const parentSessionId = projection.value.genesis.kind === "forked"
      ? projection.value.genesis.parentSessionId
      : undefined;
    const lastModel = projection.value.modelRequests.at(-1)?.modelId;
    return {
      ok: true,
      value: {
        summary: v3Summary,
        filePath,
        messageCount: countV3Messages(scan.events),
        turnCount: projection.value.turns.length,
        toolCount: projection.value.toolCalls.length,
        ...(configuration.value.provider ? { provider: configuration.value.provider } : {}),
        ...(configuration.value.model ?? lastModel
          ? { model: configuration.value.model ?? lastModel }
          : {}),
        ...(configuration.value.thinkingLevel
          ? { thinkingLevel: configuration.value.thinkingLevel }
          : {}),
        headSequence: projection.value.headSequence,
        headEventHash: projection.value.headEventHash,
        ...(parentSessionId ? { parentSessionId } : {}),
      },
    };
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

function decodeStrictJsonLines(
  bytes: Uint8Array,
): { ok: true; records: unknown[] } | { ok: false; message: string } {
  if (bytes.byteLength === 0 || bytes[bytes.byteLength - 1] !== 0x0a) {
    return { ok: false, message: "session JSONL has a torn tail" };
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { ok: false, message: "session JSONL is not valid UTF-8" };
  }
  if (text.includes("\r")) return { ok: false, message: "session JSONL uses invalid CR framing" };
  const lines = text.slice(0, -1).split("\n");
  if (lines.some((line) => line.length === 0)) {
    return { ok: false, message: "session JSONL contains an empty record" };
  }
  if (lines.length > MAX_ENRICH_RECORDS) {
    return { ok: false, message: "session JSONL exceeds the record-count limit" };
  }
  const records: unknown[] = [];
  for (const line of lines) {
    try {
      records.push(JSON.parse(line) as unknown);
    } catch {
      return { ok: false, message: "session JSONL contains malformed JSON" };
    }
  }
  return { ok: true, records };
}

async function readPublishedV3Binding(
  filePath: string,
): Promise<
  | { ok: true; value: SessionPublicationRecord }
  | { ok: false; error: SessionCatalogError }
> {
  const publication = await readSessionPublication(`${filePath}.state`);
  if (!publication.ok) return failure("corrupt", publication.error.message, false);
  if (!publication.value || publication.value.state !== "published") {
    return failure("corrupt", "v3 session is not durably published", false);
  }
  return { ok: true, value: publication.value };
}

function isThinkingLevel(value: unknown): value is ModelThinkingLevel {
  return value === "off" ||
    value === "minimal" ||
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh" ||
    value === "max";
}

function mapLifecycle(
  lifecycle: string,
): SessionSummary["lifecycle"] {
  if (lifecycle === "active") return "active";
  if (lifecycle === "stopped") return "stopped";
  if (lifecycle === "closed") return "closed";
  if (lifecycle === "corrupted" || lifecycle === "migration_failed") {
    return "recovery-required";
  }
  return "unknown";
}

function countV3Messages(events: readonly RuntimeEventV3[]): number {
  return events.filter((event) =>
    event.type === "conversation.message_recorded" ||
    (
      event.type === "session.legacy_message_imported" &&
      event.payload.disposition === "recovered"
    )
  ).length;
}
