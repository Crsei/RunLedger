/** Durable Host-owned domain revision state used for cold replay fencing. */

import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { canonicalJson } from "../../runtime/protocol/canonical-json.ts";
import { runtimeDigest } from "../../runtime/protocol/foundation.ts";
import {
	isContainedRuntimePath,
	RUNLEDGER_DIRECTORY_MODE,
	RUNLEDGER_FILE_MODE,
	type RunledgerLayout,
} from "../../runtime/contracts/storage-layout.ts";

const DOMAIN_REVISION_SNAPSHOT_VERSION = 1 as const;

export interface HostDomainRevisionStore {
	load(sessionId: string): Promise<ReadonlyMap<string, number>>;
	save(sessionId: string, revisions: ReadonlyMap<string, number>): Promise<void>;
}

interface DomainRevisionSnapshot {
	readonly version: typeof DOMAIN_REVISION_SNAPSHOT_VERSION;
	readonly sessionId: string;
	readonly revisions: Readonly<Record<string, number>>;
	readonly snapshotDigest: ReturnType<typeof runtimeDigest>;
}

export interface JsonHostDomainRevisionStoreOptions {
	readonly layout: RunledgerLayout;
	readonly workspaceStorageKey: string;
}

/** One exact-format snapshot per session; no legacy or implicit migration path. */
export class JsonHostDomainRevisionStore implements HostDomainRevisionStore {
	readonly #root: string;
	readonly #tails = new Map<string, Promise<void>>();

	public constructor(options: JsonHostDomainRevisionStoreOptions) {
		if (!/^ws-[a-f0-9]{64}$/u.test(options.workspaceStorageKey)) throw new Error("invalid domain revision workspace storage key");
		const home = resolve(options.layout.home);
		const root = resolve(join(options.layout.state, "hosts", options.workspaceStorageKey, "domain-revisions"));
		if (!isContainedRuntimePath(home, root, "posix")) throw new Error("domain revision store must remain under the injected runledgerHome");
		this.#root = root;
	}

	public load(sessionId: string): Promise<ReadonlyMap<string, number>> {
		return this.#serial(sessionId, async () => {
			let content: string;
			try {
				content = await readFile(this.#path(sessionId), "utf8");
			} catch (error) {
				if (isNotFound(error)) return new Map();
				throw error;
			}
			let value: unknown;
			try {
				value = JSON.parse(content) as unknown;
			} catch {
				throw new Error("domain revision snapshot is invalid JSON");
			}
			if (!isDomainRevisionSnapshot(value) || value.sessionId !== sessionId) throw new Error("domain revision snapshot failed current-format validation");
			return new Map(Object.entries(value.revisions));
		});
	}

	public save(sessionId: string, revisions: ReadonlyMap<string, number>): Promise<void> {
		return this.#serial(sessionId, async () => {
			const normalized = normalizeRevisions(revisions);
			const body = { version: DOMAIN_REVISION_SNAPSHOT_VERSION, sessionId, revisions: normalized };
			const snapshot: DomainRevisionSnapshot = { ...body, snapshotDigest: runtimeDigest(body) };
			await mkdir(this.#root, { recursive: true, mode: RUNLEDGER_DIRECTORY_MODE });
			const target = this.#path(sessionId);
			const temporary = join(this.#root, `.revision-${randomUUID()}.tmp`);
			try {
				await writeFile(temporary, `${canonicalJson(snapshot)}\n`, { encoding: "utf8", mode: RUNLEDGER_FILE_MODE });
				const handle = await open(temporary, "r");
				try {
					await handle.sync();
				} finally {
					await handle.close();
				}
				await rename(temporary, target);
				await chmod(target, RUNLEDGER_FILE_MODE);
			} finally {
				await unlink(temporary).catch(() => undefined);
			}
		});
	}

	#path(sessionId: string): string {
		if (!/^[A-Za-z0-9._~-]{1,160}$/u.test(sessionId)) throw new Error("domain revision session id is invalid");
		return join(this.#root, `${sessionId}.json`);
	}

	async #serial<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
		const previous = this.#tails.get(sessionId) ?? Promise.resolve();
		let release!: () => void;
		const next = new Promise<void>((resolveNext) => { release = resolveNext; });
		this.#tails.set(sessionId, previous.then(() => next));
		await previous;
		try {
			return await operation();
		} finally {
			release();
		}
	}
}

/** Bounded in-process implementation for unit composition without a canonical home. */
export class BoundedHostDomainRevisionStore implements HostDomainRevisionStore {
	readonly #records = new Map<string, Map<string, number>>();

	public async load(sessionId: string): Promise<ReadonlyMap<string, number>> {
		return new Map(this.#records.get(sessionId) ?? []);
	}

	public async save(sessionId: string, revisions: ReadonlyMap<string, number>): Promise<void> {
		normalizeRevisions(revisions);
		this.#records.set(sessionId, new Map(revisions));
	}
}

function normalizeRevisions(revisions: ReadonlyMap<string, number>): Record<string, number> {
	const entries = [...revisions.entries()].sort(([left], [right]) => left.localeCompare(right));
	const result: Record<string, number> = {};
	for (const [key, value] of entries) {
		if (!/^[A-Za-z0-9._~-]{1,96}:[A-Za-z0-9._~-]{1,160}$/u.test(key)) throw new Error("domain revision key is invalid");
		if (!Number.isSafeInteger(value) || value < 0) throw new Error("domain revision value is invalid");
		result[key] = value;
	}
	return result;
}

function isDomainRevisionSnapshot(value: unknown): value is DomainRevisionSnapshot {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	if (record.version !== DOMAIN_REVISION_SNAPSHOT_VERSION || typeof record.sessionId !== "string" || typeof record.revisions !== "object" || record.revisions === null || Array.isArray(record.revisions)) return false;
	const revisions = record.revisions as Record<string, unknown>;
	if (Object.keys(revisions).some((key) => typeof revisions[key] !== "number" || !Number.isSafeInteger(revisions[key]) || (revisions[key] as number) < 0)) return false;
	const digest = record.snapshotDigest;
	if (!isDigest(digest)) return false;
	const { snapshotDigest: _ignored, ...body } = record;
	return runtimeDigest(body).digest === digest.digest;
}

function isDigest(value: unknown): value is ReturnType<typeof runtimeDigest> {
	return typeof value === "object" && value !== null && (value as Record<string, unknown>).algorithm === "sha256" && typeof (value as Record<string, unknown>).digest === "string" && /^[a-f0-9]{64}$/u.test((value as Record<string, unknown>).digest as string);
}

function isNotFound(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
