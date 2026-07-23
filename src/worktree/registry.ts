/** append-only Worktree registry；存储端以 expectedRevision 提供原子 CAS。 */

import { canonicalDigest } from "../runtime/protocol/v3/canonical-json.ts";
import type { WorkspaceId } from "../runtime/protocol/v3/ids.ts";
import type { WorktreeRegistryMutationPort } from "./ports.ts";
import type { WorktreeRecord, WorktreeRegistryEntry, WorktreeResult } from "./types.ts";

function failure(message: string, retryable = false): WorktreeResult<never> {
	return { ok: false, error: { code: "registry_failed", message, retryable } };
}

function entryDigest(entry: Omit<WorktreeRegistryEntry, "entryDigest">): string {
	return canonicalDigest(entry);
}

function validateEntries(entries: readonly WorktreeRegistryEntry[]): WorktreeResult<void> {
	for (let index = 0; index < entries.length; index += 1) {
		const entry = entries[index]!;
		if (entry.revision !== index + 1 || entry.entryDigest !== entryDigest({ revision: entry.revision, operation: entry.operation, record: entry.record })) {
			return failure("worktree registry sequence or digest is corrupted");
		}
	}
	return { ok: true, value: undefined };
}

export class MemoryWorktreeRegistryMutationPort implements WorktreeRegistryMutationPort {
	readonly #entries: WorktreeRegistryEntry[] = [];

	public async read(): Promise<readonly WorktreeRegistryEntry[]> {
		return this.#entries.map((entry) => structuredClone(entry));
	}

	public async append(entry: WorktreeRegistryEntry, expectedRevision: number): Promise<"applied" | "conflict"> {
		if (this.#entries.length !== expectedRevision || entry.revision !== expectedRevision + 1) return "conflict";
		this.#entries.push(structuredClone(entry));
		return "applied";
	}
}

export class WorktreeRegistry {
	readonly #storage: WorktreeRegistryMutationPort;

	public constructor(storage: WorktreeRegistryMutationPort) {
		this.#storage = storage;
	}

	async #load(): Promise<WorktreeResult<readonly WorktreeRegistryEntry[]>> {
		try {
			const entries = await this.#storage.read();
			const valid = validateEntries(entries);
			return valid.ok ? { ok: true, value: entries } : valid;
		} catch {
			return failure("worktree registry storage is unavailable", true);
		}
	}

	public async list(includeRemoved = false): Promise<WorktreeResult<readonly WorktreeRecord[]>> {
		const loaded = await this.#load();
		if (!loaded.ok) return loaded;
		const latest = new Map<WorkspaceId, WorktreeRecord>();
		for (const entry of loaded.value) latest.set(entry.record.workspaceId, entry.record);
		return {
			ok: true,
			value: [...latest.values()]
				.filter((record) => includeRemoved || record.state !== "removed")
				.sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.workspaceId.localeCompare(right.workspaceId)),
		};
	}

	public async get(workspaceId: WorkspaceId): Promise<WorktreeResult<WorktreeRecord | undefined>> {
		const listed = await this.list(true);
		return listed.ok ? { ok: true, value: listed.value.find((record) => record.workspaceId === workspaceId) } : listed;
	}

	public async findByCreateRequest(requestId: WorktreeRecord["createRequestId"]): Promise<WorktreeResult<WorktreeRecord | undefined>> {
		const listed = await this.list(true);
		return listed.ok ? { ok: true, value: listed.value.find((record) => record.createRequestId === requestId) } : listed;
	}

	public async append(operation: WorktreeRegistryEntry["operation"], record: WorktreeRecord): Promise<WorktreeResult<WorktreeRegistryEntry>> {
		for (let attempt = 0; attempt < 3; attempt += 1) {
			const loaded = await this.#load();
			if (!loaded.ok) return loaded;
			const body = { revision: loaded.value.length + 1, operation, record } as const;
			const entry: WorktreeRegistryEntry = { ...body, entryDigest: entryDigest(body) };
			try {
				if (await this.#storage.append(entry, loaded.value.length) === "applied") return { ok: true, value: entry };
			} catch {
				return failure("worktree registry append outcome is uncertain", true);
			}
		}
		return failure("worktree registry CAS conflict", true);
	}

	/**
	 * 只在目标 workspace 的 latest projection 仍与调用方读取值一致时追加。
	 * 全局 registry 的无关并发可重试，目标 workspace 漂移则不得盲写旧 projection。
	 */
	public async appendIfCurrent(
		operation: WorktreeRegistryEntry["operation"],
		record: WorktreeRecord,
		expectedCurrentDigest: string,
	): Promise<WorktreeResult<WorktreeRegistryEntry>> {
		for (let attempt = 0; attempt < 3; attempt += 1) {
			const loaded = await this.#load();
			if (!loaded.ok) return loaded;
			const current = [...loaded.value]
				.reverse()
				.find((entry) => entry.record.workspaceId === record.workspaceId)?.record;
			if (!current || canonicalDigest(current) !== expectedCurrentDigest) {
				return failure("worktree registry target changed during conditional append", true);
			}
			const body = { revision: loaded.value.length + 1, operation, record } as const;
			const entry: WorktreeRegistryEntry = { ...body, entryDigest: entryDigest(body) };
			try {
				if (await this.#storage.append(entry, loaded.value.length) === "applied") {
					return { ok: true, value: entry };
				}
			} catch {
				return failure("worktree registry conditional append outcome is uncertain", true);
			}
		}
		return failure("worktree registry conditional append CAS conflict", true);
	}
}
