import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRuntimeId } from "../../../src/runtime/protocol/v3/ids.ts";
import { ArtifactCasStore, ArtifactRepository } from "../../../src/runtime/artifacts/cas-store.ts";
import type { ArtifactCasStoreOptions } from "../../../src/runtime/artifacts/cas-store.ts";
import { OsKeyringArtifactKeyProvider, UnavailableArtifactKeyProvider } from "../../../src/runtime/artifacts/key-provider.ts";
import type {
	ArtifactKeyProvider,
	ArtifactKeyProviderStatus,
	OsKeyringPort,
	OsKeyringReadResult,
} from "../../../src/runtime/artifacts/key-provider.ts";
import { ArtifactMetadataStore } from "../../../src/runtime/artifacts/metadata-store.ts";
import type { ArtifactMetadataStoreOptions } from "../../../src/runtime/artifacts/metadata-store.ts";
import type {
	ArtifactAbortRecord,
	ArtifactCommitRecord,
	ArtifactEventJournalPort,
	ArtifactIntentRecord,
	ArtifactJournalState,
	ArtifactResult,
	ArtifactWriteRequest,
} from "../../../src/runtime/artifacts/types.ts";
import type { CommandId } from "../../../src/runtime/protocol/v3/ids.ts";

export const NOW = "2026-07-22T00:00:00.000Z";
export const DIGEST = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

export function valueOf<T>(result: ArtifactResult<T>): T {
	if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
	return result.value;
}

export class MemoryArtifactJournal implements ArtifactEventJournalPort {
	readonly intents = new Map<CommandId, ArtifactIntentRecord>();
	readonly commits = new Map<CommandId, ArtifactCommitRecord>();
	readonly aborts = new Map<CommandId, ArtifactAbortRecord>();
	failIntent = false;
	failCommit = false;
	failAbort = false;

	public async recordIntent(intent: ArtifactIntentRecord): Promise<ArtifactResult<void>> {
		if (this.failIntent) {
			return { ok: false, error: { code: "durable_write_failed", message: "intent failed", retryable: true } };
		}
		const existing = this.intents.get(intent.intentId);
		if (this.commits.has(intent.intentId)) {
			return { ok: false, error: { code: "invalid_request", message: "intent is already committed", retryable: false } };
		}
		if (this.aborts.has(intent.intentId)) {
			return { ok: false, error: { code: "invalid_request", message: "intent is already aborted", retryable: false } };
		}
		if (existing && JSON.stringify(existing) !== JSON.stringify(intent)) {
			return { ok: false, error: { code: "invalid_request", message: "intent collision", retryable: false } };
		}
		this.intents.set(intent.intentId, intent);
		return { ok: true, value: undefined };
	}

	public async recordCommit(commit: ArtifactCommitRecord): Promise<ArtifactResult<void>> {
		if (this.failCommit) {
			return { ok: false, error: { code: "durable_write_failed", message: "commit failed", retryable: true } };
		}
		this.commits.set(commit.intentId, commit);
		return { ok: true, value: undefined };
	}

	public async recordAbort(abort: ArtifactAbortRecord): Promise<ArtifactResult<void>> {
		if (this.failAbort) {
			return { ok: false, error: { code: "durable_write_failed", message: "abort failed", retryable: true } };
		}
		this.aborts.set(abort.intentId, abort);
		return { ok: true, value: undefined };
	}

	public async stateForIntent(intentId: CommandId): Promise<ArtifactResult<ArtifactJournalState>> {
		const intent = this.intents.get(intentId);
		if (!intent) return { ok: true, value: { state: "absent" } };
		const commit = this.commits.get(intentId);
		const abort = this.aborts.get(intentId);
		if (abort) return { ok: true, value: { state: "aborted", intent, abort } };
		return commit
			? { ok: true, value: { state: "committed", intent, commit } }
			: { ok: true, value: { state: "intent_recorded", intent } };
	}

	public async listOpenIntents(scope: Pick<ArtifactIntentRecord, "authorityId" | "tenantId">): Promise<ArtifactResult<readonly ArtifactIntentRecord[]>> {
		return {
			ok: true,
			value: [...this.intents.values()].filter((intent) =>
				intent.authorityId === scope.authorityId &&
				intent.tenantId === scope.tenantId &&
				!this.commits.has(intent.intentId) &&
				!this.aborts.has(intent.intentId),
			),
		};
	}
}

export class FakeOsKeyring implements OsKeyringPort {
	readonly backend = "os_keyring" as const;
	state: ArtifactKeyProviderStatus["state"] = "available";
	activeVersion = "v1";
	readonly keys = new Map<string, Uint8Array>([["v1", Uint8Array.from({ length: 32 }, (_, index) => index + 1)]]);

	public async readArtifactKey(version?: string): Promise<OsKeyringReadResult> {
		if (this.state !== "available") {
			return { status: this.state, activeVersion: this.activeVersion, availableVersions: [...this.keys.keys()] };
		}
		const selected = version ?? this.activeVersion;
		const key = this.keys.get(selected);
		return key
			? { status: "available", version: selected, key: Uint8Array.from(key) }
			: { status: "lost", activeVersion: this.activeVersion, availableVersions: [...this.keys.keys()] };
	}

	public async status(): Promise<ArtifactKeyProviderStatus> {
		return {
			state: this.state,
			activeVersion: this.activeVersion,
			availableVersions: [...this.keys.keys()],
			backend: "os_keyring",
		};
	}
}

export interface ArtifactHarness {
	rootDir: string;
	cas: ArtifactCasStore;
	metadata: ArtifactMetadataStore;
	journal: MemoryArtifactJournal;
	keyring: FakeOsKeyring;
	keyProvider: ArtifactKeyProvider;
	repository: ArtifactRepository;
	request(seed?: string): ArtifactWriteRequest;
	cleanup(): Promise<void>;
}

export async function createArtifactHarness(options?: {
	cas?: Omit<ArtifactCasStoreOptions, "rootDir">;
	metadata?: Omit<ArtifactMetadataStoreOptions, "rootDir">;
	keyProvider?: "available" | "unavailable";
}): Promise<ArtifactHarness> {
	const rootDir = await mkdtemp(join(tmpdir(), "runledger-artifacts-"));
	const cas = new ArtifactCasStore({ rootDir, ...options?.cas });
	const metadata = new ArtifactMetadataStore({ rootDir, ...options?.metadata });
	const journal = new MemoryArtifactJournal();
	const keyring = new FakeOsKeyring();
	const keyProvider: ArtifactKeyProvider = options?.keyProvider === "unavailable"
		? new UnavailableArtifactKeyProvider()
		: new OsKeyringArtifactKeyProvider(keyring);
	const repository = new ArtifactRepository({
		cas,
		metadata,
		journal,
		keyProvider,
		clock: () => new Date(NOW),
	});
	const authorityId = createRuntimeId("authority", "artifact-test");
	const tenantId = createRuntimeId("tenant", "artifact-test");
	const principalId = createRuntimeId("principal", "artifact-test");
	const sessionId = createRuntimeId("session", "artifact-test");
	const workspaceId = createRuntimeId("workspace", "artifact-test");
	return {
		rootDir,
		cas,
		metadata,
		journal,
		keyring,
		keyProvider,
		repository,
		request: (seed = "one") => ({
			authorityId,
			tenantId,
			artifactId: createRuntimeId("artifact", seed),
			intentId: createRuntimeId("command", `artifact-${seed}`),
			principalId,
			source: { sessionId, workspaceId, producerId: principalId },
			kind: "tool_output",
			mediaType: "text/plain",
			content: "visible output password=hunter2 /home/alice/private.txt",
			createdAt: NOW,
		}),
		cleanup: () => rm(rootDir, { recursive: true, force: true }),
	};
}
