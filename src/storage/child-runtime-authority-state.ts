/** Child runtime authority record 的私有、原子、跨进程文件存储。 */

import { randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  realpath,
  readdir,
  rename,
  unlink,
} from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { TextDecoder } from "node:util";
import lockfile from "proper-lockfile";
import {
  isChildRuntimeAuthorityRecord,
  matchesChildRuntimeAuthorityExpectation,
  validateChildRuntimeAuthorityTransition,
  type ChildRuntimeAuthorityRecord,
  type ChildRuntimeAuthorityStorePort,
} from "../runtime/agents/child-runtime-authority.ts";
import {
  canonicalDigest,
  canonicalJson,
} from "../runtime/protocol/v3/canonical-json.ts";
import { isRuntimeId, type AgentId } from "../runtime/protocol/v3/ids.ts";

const MAX_RECORD_BYTES = 8 * 1024 * 1024;
const PUBLISH_TEMP =
  /^\.[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.tmp$/u;

function privateRecordIdentityStats(stats: Stats): boolean {
  return (
    stats.isFile() &&
    !stats.isSymbolicLink() &&
    stats.nlink === 1 &&
    (process.platform === "win32" || (stats.mode & 0o077) === 0)
  );
}

function privateRecordStats(stats: Stats): boolean {
  return (
    privateRecordIdentityStats(stats) &&
    stats.size > 0 &&
    stats.size <= MAX_RECORD_BYTES
  );
}

function sameRecordFile(left: Stats, right: Stats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.size === right.size
  );
}

function errno(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : undefined;
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function readBoundedRecord(handle: FileHandle): Promise<Buffer> {
  const bytes = Buffer.allocUnsafe(MAX_RECORD_BYTES + 1);
  let offset = 0;
  while (offset < bytes.byteLength) {
    const { bytesRead } = await handle.read(
      bytes,
      offset,
      bytes.byteLength - offset,
      offset,
    );
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  if (offset > MAX_RECORD_BYTES) {
    throw new Error("child runtime authority record exceeds its byte bound");
  }
  return bytes.subarray(0, offset);
}

function parseRecord(
  raw: Buffer,
  agentId: AgentId,
): ChildRuntimeAuthorityRecord {
  if (raw.byteLength <= 0 || raw.byteLength > MAX_RECORD_BYTES) {
    throw new Error(
      "child runtime authority record has an invalid byte length",
    );
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
  } catch {
    throw new Error("child runtime authority record has malformed UTF-8");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new Error("child runtime authority record is corrupted");
  }
  if (!isChildRuntimeAuthorityRecord(parsed) || parsed.agentId !== agentId) {
    throw new Error(
      "child runtime authority record identity, digest, or encoding is invalid",
    );
  }
  const canonical = Buffer.from(canonicalJson(parsed), "utf8");
  if (!canonical.equals(raw)) {
    throw new Error(
      "child runtime authority record identity, digest, or encoding is invalid",
    );
  }
  return parsed;
}

class PrivateAuthorityDirectory {
  readonly #root: string;

  public constructor(root: string) {
    if (!isAbsolute(root) || resolve(root) !== root || root.includes("\0")) {
      throw new TypeError(
        "child runtime authority root must be an exact absolute path",
      );
    }
    this.#root = root;
  }

  public async verify(): Promise<void> {
    await mkdir(this.#root, { recursive: true, mode: 0o700 });
    const stats = await lstat(this.#root);
    if (
      !stats.isDirectory() ||
      stats.isSymbolicLink() ||
      resolve(await realpath(this.#root)) !== this.#root
    ) {
      throw new Error(
        "child runtime authority root is not a private canonical directory",
      );
    }
    if (process.platform !== "win32" && (stats.mode & 0o077) !== 0) {
      throw new Error("child runtime authority root permissions are unsafe");
    }
  }

  public path(agentId: AgentId): string {
    return join(this.#root, `${canonicalDigest(agentId)}.json`);
  }

  private async recoverInterruptedPublish(
    path: string,
    stats: Stats,
  ): Promise<Stats> {
    if (stats.nlink === 1) return stats;
    if (
      stats.nlink !== 2 ||
      !stats.isFile() ||
      stats.isSymbolicLink() ||
      (process.platform !== "win32" && (stats.mode & 0o077) !== 0)
    )
      return stats;

    const candidates: string[] = [];
    for (const entry of await readdir(this.#root, { withFileTypes: true })) {
      if (!PUBLISH_TEMP.test(entry.name)) continue;
      const candidate = join(this.#root, entry.name);
      let candidateStats: Stats;
      try {
        candidateStats = await lstat(candidate);
      } catch (error) {
        if (errno(error) === "ENOENT") continue;
        throw error;
      }
      if (
        candidateStats.isFile() &&
        !candidateStats.isSymbolicLink() &&
        candidateStats.dev === stats.dev &&
        candidateStats.ino === stats.ino &&
        candidateStats.nlink === 2 &&
        candidateStats.mode === stats.mode &&
        candidateStats.size === stats.size &&
        resolve(await realpath(candidate)) === candidate
      ) {
        candidates.push(candidate);
      }
    }
    if (candidates.length !== 1) {
      throw new Error(
        "child runtime authority interrupted publish is ambiguous or unsafe",
      );
    }
    try {
      await unlink(candidates[0]!);
    } catch (error) {
      if (errno(error) !== "ENOENT") throw error;
    }
    await syncDirectory(this.#root);
    const recovered = await lstat(path);
    if (
      !privateRecordIdentityStats(recovered) ||
      !sameRecordFile(stats, recovered)
    ) {
      throw new Error(
        "child runtime authority interrupted publish recovery changed the final record",
      );
    }
    return recovered;
  }

  public async read(
    path: string,
    agentId: AgentId,
  ): Promise<ChildRuntimeAuthorityRecord | undefined> {
    let stats;
    try {
      stats = await lstat(path);
    } catch (error) {
      if (errno(error) === "ENOENT") return undefined;
      throw error;
    }
    stats = await this.recoverInterruptedPublish(path, stats);
    if (
      !privateRecordIdentityStats(stats) ||
      resolve(await realpath(path)) !== path
    ) {
      throw new Error(
        "child runtime authority record file identity or permissions are unsafe",
      );
    }
    const handle = await open(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    try {
      const opened = await handle.stat();
      if (!privateRecordStats(opened) || !sameRecordFile(stats, opened)) {
        throw new Error(
          "child runtime authority opened record identity, link count, size, or permissions are unsafe",
        );
      }
      const raw = await readBoundedRecord(handle);
      const after = await handle.stat();
      if (!privateRecordStats(after) || !sameRecordFile(opened, after)) {
        throw new Error(
          "child runtime authority record changed while it was being read",
        );
      }
      return parseRecord(raw, agentId);
    } finally {
      await handle.close();
    }
  }

  public async create(
    path: string,
    record: ChildRuntimeAuthorityRecord,
  ): Promise<"created" | "exists"> {
    const content = canonicalJson(record);
    if (Buffer.byteLength(content, "utf8") > MAX_RECORD_BYTES) {
      throw new Error("child runtime authority record exceeds its byte bound");
    }
    const temporary = join(this.#root, `.${randomUUID()}.tmp`);
    try {
      const handle = await open(
        temporary,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          (constants.O_NOFOLLOW ?? 0),
        0o600,
      );
      try {
        await handle.writeFile(content, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      try {
        await link(temporary, path);
      } catch (error) {
        if (errno(error) !== "EEXIST") throw error;
        await unlink(temporary);
        await syncDirectory(this.#root);
        return "exists";
      }
      await unlink(temporary);
      await syncDirectory(this.#root);
      return "created";
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }

  public async replace(
    path: string,
    record: ChildRuntimeAuthorityRecord,
  ): Promise<void> {
    const content = canonicalJson(record);
    if (Buffer.byteLength(content, "utf8") > MAX_RECORD_BYTES) {
      throw new Error("child runtime authority record exceeds its byte bound");
    }
    const temporary = join(this.#root, `.${randomUUID()}.tmp`);
    try {
      const handle = await open(
        temporary,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          (constants.O_NOFOLLOW ?? 0),
        0o600,
      );
      try {
        await handle.writeFile(content, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, path);
      await syncDirectory(this.#root);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }

  public async lock<T>(path: string, operation: () => Promise<T>): Promise<T> {
    const release = await lockfile.lock(path, {
      realpath: false,
      lockfilePath: `${path}.lock`,
      stale: 30_000,
      retries: { retries: 50, minTimeout: 10, maxTimeout: 50, factor: 1 },
    });
    try {
      return await operation();
    } finally {
      await release();
    }
  }

  public async files(): Promise<readonly string[]> {
    const entries = await readdir(this.#root, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => join(this.#root, entry.name))
      .sort();
  }
}

export class FileChildRuntimeAuthorityStore implements ChildRuntimeAuthorityStorePort {
  readonly #records: PrivateAuthorityDirectory;

  public constructor(root: string) {
    this.#records = new PrivateAuthorityDirectory(root);
  }

  public async read(
    agentId: AgentId,
  ): Promise<ChildRuntimeAuthorityRecord | undefined> {
    if (!isRuntimeId(agentId, "agent"))
      throw new TypeError("child runtime authority Agent identity is invalid");
    await this.#records.verify();
    return this.#records.read(this.#records.path(agentId), agentId);
  }

  public async begin(
    record: ChildRuntimeAuthorityRecord,
  ): Promise<"applied" | "replay" | "conflict"> {
    if (!isChildRuntimeAuthorityRecord(record) || record.state !== "claimed") {
      throw new TypeError(
        "child runtime authority begin requires an initial claimed record",
      );
    }
    await this.#records.verify();
    const path = this.#records.path(record.agentId);
    return this.#records.lock(path, async () => {
      await this.#records.verify();
      const current = await this.#records.read(path, record.agentId);
      if (current)
        return current.recordDigest === record.recordDigest
          ? "replay"
          : "conflict";
      const created = await this.#records.create(path, record);
      if (created === "created") return "applied";
      const raced = await this.#records.read(path, record.agentId);
      if (!raced)
        throw new Error(
          "child runtime authority record disappeared after create collision",
        );
      return raced.recordDigest === record.recordDigest ? "replay" : "conflict";
    });
  }

  public async compareAndSwap(
    agentId: AgentId,
    expectedRevision: number,
    expectedRecordDigest: string,
    next: ChildRuntimeAuthorityRecord,
  ): Promise<"applied" | "replay" | "conflict"> {
    if (
      !isRuntimeId(agentId, "agent") ||
      !Number.isSafeInteger(expectedRevision) ||
      !isChildRuntimeAuthorityRecord(next) ||
      next.agentId !== agentId ||
      next.state === "claimed" ||
      !/^[a-f0-9]{64}$/u.test(expectedRecordDigest)
    ) {
      throw new TypeError("child runtime authority CAS input is invalid");
    }
    await this.#records.verify();
    const path = this.#records.path(agentId);
    const existing = await this.#records.read(path, agentId);
    if (!existing) return "conflict";
    return this.#records.lock(path, async () => {
      await this.#records.verify();
      const current = await this.#records.read(path, agentId);
      if (!current) return "conflict";
      if (current.recordDigest === next.recordDigest)
        return matchesChildRuntimeAuthorityExpectation(
          expectedRevision,
          expectedRecordDigest,
          next,
        )
          ? "replay"
          : "conflict";
      if (
        current.revision !== expectedRevision ||
        current.recordDigest !== expectedRecordDigest
      ) {
        return "conflict";
      }
      validateChildRuntimeAuthorityTransition(current, next);
      await this.#records.replace(path, next);
      return "applied";
    });
  }
}
