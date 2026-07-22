/** authority/tenant canonical Event Store 的生产生命周期 owner。 */

import { lstat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { canonicalDigest } from "../runtime/protocol/v3/canonical-json.ts";
import { createAuthorityTenantEventStreamRef } from "../runtime/protocol/v3/events.ts";
import type { RuntimeInstanceId } from "../runtime/protocol/v3/ids.ts";
import type { RuntimeIdentityContext } from "../runtime/identity/types.ts";
import { RuntimeGenerationRepository } from "../runtime/control-plane/runtime-generation-repository.ts";
import { AuthorityLifecycleRepository } from "../runtime/session/authority-lifecycle-repository.ts";
import { EventWriter, openEventWriter } from "../runtime/session/event-writer.ts";
import { JsonlV3EventStore } from "../runtime/session/jsonl-v3-store.ts";
import {
	DEFAULT_WRITER_LEASE_DURATION_MS,
	FileWriterLeaseStore,
	type WriterLeaseRecord,
} from "../runtime/session/writer-lease.ts";
import type { SessionResult } from "../runtime/session/types.ts";
import { getProjectDir } from "./paths.ts";

const AUTHORITY_DIRECTORY = "authority-v3";
const AUTHORITY_EVENT_FILE = "events.jsonl";
const AUTHORITY_LEASE_FILE = "writer-lease.json";

export interface AuthorityRuntimeManagerOpenOptions {
	cwd: string;
	identity: RuntimeIdentityContext;
	runtimeId: RuntimeInstanceId;
	stateDirectory?: string;
	clock?: () => Date;
	leaseDurationMs?: number;
}

function resultValue<T>(result: SessionResult<T>, operation: string): T {
	if (!result.ok) throw new Error(`${operation}: ${result.error.code}: ${result.error.message}`);
	return result.value;
}

function isNotFound(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function pathExists(path: string): Promise<boolean> {
	try {
		const stats = await lstat(path);
		if (!stats.isFile()) throw new Error("authority Event Store path is not a regular file");
		return true;
	} catch (error) {
		if (isNotFound(error)) return false;
		throw error;
	}
}

function authorityDirectory(options: AuthorityRuntimeManagerOpenOptions): string {
	if (options.stateDirectory) return resolve(options.stateDirectory);
	const scopeDigest = canonicalDigest({
		authorityId: options.identity.authorityId,
		tenantId: options.identity.tenantId,
	}).slice(0, 32);
	return join(getProjectDir(resolve(options.cwd)), AUTHORITY_DIRECTORY, scopeDigest);
}

function acquireAuthorityLease(
	store: FileWriterLeaseStore,
	scope: {
		authorityId: RuntimeIdentityContext["authorityId"];
		tenantId: RuntimeIdentityContext["tenantId"];
		stream: ReturnType<typeof createAuthorityTenantEventStreamRef>;
	},
	runtimeId: RuntimeInstanceId,
	durationMs: number,
	clock: () => Date,
): WriterLeaseRecord {
	const acquired = store.acquire({ ...scope, ownerRuntimeId: runtimeId, durationMs });
	if (acquired.ok) return acquired.value;
	const inspected = store.inspect(scope);
	if (!inspected.ok || !inspected.value || clock().getTime() < Date.parse(inspected.value.expiresAt)) {
		throw new Error(`authority writer lease unavailable: ${acquired.error.code}: ${acquired.error.message}`);
	}
	return resultValue(store.takeover({
		expectedFence: inspected.value,
		ownerRuntimeId: runtimeId,
		durationMs,
	}), "authority stale writer takeover failed");
}

export class AuthorityRuntimeManager {
	readonly #directory: string;
	readonly #eventFile: string;
	readonly #identity: RuntimeIdentityContext;
	readonly #runtimeId: RuntimeInstanceId;
	readonly #leaseStore: FileWriterLeaseStore;
	#fence: WriterLeaseRecord;
	readonly #writer: EventWriter;
	readonly #authority: AuthorityLifecycleRepository;
	readonly #generation: RuntimeGenerationRepository;
	readonly #leaseDurationMs: number;
	#heartbeat: ReturnType<typeof setInterval> | undefined;
	#closed = false;
	#closePromise: Promise<void> | undefined;

	private constructor(options: {
		directory: string;
		eventFile: string;
		identity: RuntimeIdentityContext;
		runtimeId: RuntimeInstanceId;
		leaseStore: FileWriterLeaseStore;
		fence: WriterLeaseRecord;
		writer: EventWriter;
		authority: AuthorityLifecycleRepository;
		leaseDurationMs: number;
	}) {
		this.#directory = options.directory;
		this.#eventFile = options.eventFile;
		this.#identity = options.identity;
		this.#runtimeId = options.runtimeId;
		this.#leaseStore = options.leaseStore;
		this.#fence = options.fence;
		this.#writer = options.writer;
		this.#authority = options.authority;
		this.#generation = new RuntimeGenerationRepository(options.authority);
		this.#leaseDurationMs = options.leaseDurationMs;
		this.#startHeartbeat();
	}

	public static async open(options: AuthorityRuntimeManagerOpenOptions): Promise<AuthorityRuntimeManager> {
		const clock = options.clock ?? (() => new Date());
		const leaseDurationMs = options.leaseDurationMs ?? DEFAULT_WRITER_LEASE_DURATION_MS;
		const directory = authorityDirectory(options);
		const eventFile = join(directory, AUTHORITY_EVENT_FILE);
		const stream = createAuthorityTenantEventStreamRef(options.identity);
		const scope = {
			authorityId: options.identity.authorityId,
			tenantId: options.identity.tenantId,
			stream,
		};
		const leaseStore = new FileWriterLeaseStore(join(directory, AUTHORITY_LEASE_FILE), {
			scope,
			now: clock,
			defaultDurationMs: leaseDurationMs,
		});
		const fence = acquireAuthorityLease(leaseStore, scope, options.runtimeId, leaseDurationMs, clock);
		let store: JsonlV3EventStore | undefined;
		try {
			const exists = await pathExists(eventFile);
			const opened = exists
				? await JsonlV3EventStore.open({
					filePath: eventFile,
					...scope,
					validateFence: (candidate) => leaseStore.validate(candidate).ok,
				})
				: await JsonlV3EventStore.create({
					filePath: eventFile,
					...scope,
					validateFence: (candidate) => leaseStore.validate(candidate).ok,
				});
			store = resultValue(opened, "authority Event Store open failed");
			const writer = exists
				? resultValue(await openEventWriter({ ...scope, store, fence, clock }), "authority EventWriter open failed")
				: new EventWriter({ ...scope, store, fence, clock });
			const authority = resultValue(await AuthorityLifecycleRepository.open({
				authorityId: options.identity.authorityId,
				tenantId: options.identity.tenantId,
				store,
				writer,
			}), "authority repository open failed");
			return new AuthorityRuntimeManager({
				directory,
				eventFile,
				identity: options.identity,
				runtimeId: options.runtimeId,
				leaseStore,
				fence,
				writer,
				authority,
				leaseDurationMs,
			});
		} catch (error) {
			await store?.close().catch(() => undefined);
			leaseStore.release(fence);
			throw error;
		}
	}

	#startHeartbeat(): void {
		const intervalMs = Math.max(250, Math.floor(this.#leaseDurationMs / 3));
		this.#heartbeat = setInterval(() => {
			if (this.#closed) return;
			const renewed = this.#leaseStore.heartbeat(this.#fence, this.#leaseDurationMs);
			if (renewed.ok) this.#fence = renewed.value;
		}, intervalMs);
		this.#heartbeat.unref?.();
	}

	public stateDirectory(): string {
		return this.#directory;
	}

	public eventFilePath(): string {
		return this.#eventFile;
	}

	public identity(): RuntimeIdentityContext {
		return { ...this.#identity };
	}

	public runtimeId(): RuntimeInstanceId {
		return this.#runtimeId;
	}

	public authorityRepository(): AuthorityLifecycleRepository {
		return this.#authority;
	}

	public runtimeGenerations(): RuntimeGenerationRepository {
		return this.#generation;
	}

	public writer(): EventWriter {
		return this.#writer;
	}

	public isClosed(): boolean {
		return this.#closed;
	}

	public close(): Promise<void> {
		this.#closePromise ??= this.#closeRuntime();
		return this.#closePromise;
	}

	async #closeRuntime(): Promise<void> {
		if (this.#heartbeat) {
			clearInterval(this.#heartbeat);
			this.#heartbeat = undefined;
		}
		const closed = await this.#writer.close();
		const released = this.#leaseStore.release(this.#fence);
		if (!closed.ok) throw new Error(`authority EventWriter close failed: ${closed.error.code}`);
		if (!released.ok) throw new Error(`authority writer lease release failed: ${released.error.code}`);
		this.#closed = true;
	}
}
