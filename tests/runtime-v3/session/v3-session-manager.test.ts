import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { forkV3FromCli, migrateLegacyFromCli } from "../../../src/cli/v3-session-commands.ts";
import { ArtifactCasStore, ArtifactRepository } from "../../../src/runtime/artifacts/cas-store.ts";
import { UnavailableArtifactKeyProvider } from "../../../src/runtime/artifacts/key-provider.ts";
import { ArtifactMetadataStore } from "../../../src/runtime/artifacts/metadata-store.ts";
import { SessionArtifactJournal } from "../../../src/runtime/artifacts/session-journal.ts";
import { canonicalDigest } from "../../../src/runtime/protocol/v3/canonical-json.ts";
import type { ArtifactRef } from "../../../src/runtime/protocol/v3/capability.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/v3/ids.ts";
import { createLocalIdentityContext } from "../../../src/runtime/identity/local-principal.ts";
import { DEFAULT_RUNTIME_FEATURES, type RuntimeFeatureFlags } from "../../../src/runtime/runtime-features.ts";
import { AgentLoopSessionEvents } from "../../../src/runtime/session/agent-loop-events.ts";
import { EventWriter } from "../../../src/runtime/session/event-writer.ts";
import { JsonlV3EventStore } from "../../../src/runtime/session/jsonl-v3-store.ts";
import { reduceSessionEvents } from "../../../src/runtime/session/reducer.ts";
import { readSessionPublication } from "../../../src/runtime/session/session-publication.ts";
import {
	createSessionRestoreDependencySnapshot,
	type SessionRestoreDependencyBinding,
} from "../../../src/runtime/session/restore-dependencies.ts";
import { FileWriterLeaseStore } from "../../../src/runtime/session/writer-lease.ts";
import {
	createSessionSnapshot,
	readAllRuntimeEvents,
	writeSessionSnapshot,
} from "../../../src/runtime/session/snapshot.ts";
import type { SessionResult } from "../../../src/runtime/session/types.ts";
import { SessionManager } from "../../../src/storage/session-manager.ts";
import {
	V3SessionInitializationError,
	V3SessionManager,
} from "../../../src/storage/v3-session-manager.ts";

const FLAGS: RuntimeFeatureFlags = { ...DEFAULT_RUNTIME_FEATURES, sessionV3: true };
const roots: string[] = [];

function temporaryRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "runledger-v3-manager-"));
	roots.push(root);
	return root;
}

function valueOf<T>(result: SessionResult<T>): T {
	if (!result.ok) {
		throw new Error(`${result.error.code}: ${result.error.message}`);
	}
	return result.value;
}

async function writeQueuedArtifact(
	manager: V3SessionManager,
	seed: string,
): Promise<ArtifactRef> {
	const identity = manager.identity();
	const written = await manager.artifactRepository().write({
		authorityId: identity.authorityId,
		tenantId: identity.tenantId,
		artifactId: createRuntimeId("artifact", seed),
		intentId: createRuntimeId("command", `${seed}-intent`),
		principalId: identity.principalId,
		source: {
			sessionId: manager.sessionId(),
			producerId: identity.principalId,
		},
		kind: "tool_output",
		mediaType: "application/json",
		content: JSON.stringify({ role: "user", content: [{ type: "text", text: seed }] }),
		createdAt: "2026-07-23T00:00:00.000Z",
	});
	if (!written.ok) throw new Error(written.error.message);
	if (written.value.state !== "committed" || !written.value.reference) {
		throw new Error("queue Artifact fixture did not commit");
	}
	return written.value.reference;
}

function artifactBlobPath(stateDirectory: string, artifact: ArtifactRef): string {
	const digest = artifact.storedDigest;
	return join(
		stateDirectory,
		"artifacts",
		"blobs",
		"sha256",
		digest.slice(0, 2),
		digest.slice(2, 4),
		`${digest}.blob`,
	);
}

async function writeDependencyBoundSnapshot(
	manager: V3SessionManager,
	dependencies: readonly SessionRestoreDependencyBinding[],
): Promise<void> {
	valueOf(await manager.flushCurrentHead());
	const events = valueOf(await readAllRuntimeEvents(manager.eventStore()));
	const projection = valueOf(reduceSessionEvents(events));
	const snapshot = valueOf(createSessionSnapshot(events, {
		snapshotId: createRuntimeId("snapshot", "restore-dependencies"),
		activeLeafId: projection.activeLeafId,
		writtenAt: "2026-07-23T00:00:00.000Z",
		restoreDependencies: createSessionRestoreDependencySnapshot(dependencies),
	}));
	valueOf(await writeSessionSnapshot(join(manager.stateDirectory(), "snapshot.json"), snapshot));
}

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("V3SessionManager", () => {
	it("creates at an exact absolute session-bound file path", async () => {
		const root = temporaryRoot();
		const sessionDir = join(root, "sessions");
		const sessionId = createRuntimeId("session", "exact-create-path");
		const filePath = join(sessionDir, `2026-07-23T00-00-00-000Z_${sessionId}.jsonl`);

		const manager = await V3SessionManager.create({
			cwd: root,
			sessionDir,
			sessionId,
			filePath,
			features: FLAGS,
		});

		expect(manager.filePath()).toBe(filePath);
		expect(manager.sessionId()).toBe(sessionId);
		await manager.closeAll();
	});

	it("keeps a manual create invisible and non-resumable until its exact publication barrier", async () => {
		const root = temporaryRoot();
		const sessionDir = join(root, "sessions");
		const manager = await V3SessionManager.create({
			cwd: root,
			sessionDir,
			features: FLAGS,
			writeGenesis: false,
			publication: { kind: "create", mode: "manual" },
		});
		expect(manager.publicationState()).toBe("staging");
		expect(await SessionManager.list(root, sessionDir)).toEqual([]);
		await expect(V3SessionManager.open(manager.filePath(), FLAGS, manager.identity())).rejects.toThrow(
			"staging and is not resumable",
		);

		await manager.sessionEvents().ensureInitialized();
		const published = await manager.publishStagedTarget();
		expect(published).toMatchObject({
			state: "published",
			kind: "create",
			sessionId: manager.sessionId(),
			writerEpoch: manager.writerFenceReceipt().writerEpoch,
			genesis: { sequence: 0 },
			head: { sequence: 0 },
		});
		expect(await SessionManager.list(root, sessionDir)).toEqual([
			expect.objectContaining({ filePath: manager.filePath(), format: "v3" }),
		]);
		const filePath = manager.filePath();
		const identity = manager.identity();
		await manager.closeAll();
		const reopened = await V3SessionManager.open(filePath, FLAGS, identity);
		expect(reopened.publicationState()).toBe("published");
		await reopened.closeAll();
	});

	it("reconciles a lost publication acknowledgement only from the durable published record", async () => {
		const root = temporaryRoot();
		const manager = await V3SessionManager.create({
			cwd: root,
			sessionDir: join(root, "sessions"),
			features: FLAGS,
			publication: {
				kind: "create",
				mode: "automatic",
				onWritePhase: (phase) => {
					if (phase === "after_publish_sync") {
						throw new Error("injected publication acknowledgement loss");
					}
				},
			},
		});
		expect(manager.publicationState()).toBe("published");
		expect(await readSessionPublication(manager.stateDirectory())).toMatchObject({
			ok: true,
			value: { state: "published", sessionId: manager.sessionId() },
		});
		await manager.closeAll();
	});

	it.each([
		{
			label: "intent before write",
			phase: "before_intent_write" as const,
			stage: "intent",
		},
		{
			label: "intent directory barrier",
			phase: "after_intent_rename_before_sync" as const,
			stage: "intent",
		},
		{
			label: "publish commit before rename",
			phase: "before_publish_write" as const,
			stage: "publish",
		},
		{
			label: "publish directory barrier",
			phase: "after_publish_rename_before_sync" as const,
			stage: "publish",
		},
	])("cleans a target that fails at the $label", async ({ phase, stage }) => {
		const root = temporaryRoot();
		const sessionDir = join(root, "sessions");
		const sessionId = createRuntimeId("session", `publication-${stage}`);
		const filePath = join(sessionDir, `2026-07-23T00-00-00-000Z_${sessionId}.jsonl`);
		await expect(V3SessionManager.create({
			cwd: root,
			sessionDir,
			sessionId,
			filePath,
			features: FLAGS,
			publication: {
				kind: "create",
				mode: "automatic",
				onWritePhase: (candidate) => {
					if (candidate === phase) throw new Error(`injected ${phase}`);
				},
			},
		})).rejects.toMatchObject({
			name: "V3SessionInitializationError",
			stage,
			filePath,
			sessionId,
			cleanup: { status: "cleaned", errors: [] },
		});
		expect(existsSync(filePath)).toBe(false);
		expect(existsSync(`${filePath}.state`)).toBe(false);
		expect(await SessionManager.list(root, sessionDir)).toEqual([]);
	});

	it("removes a failed fork target before it can appear in recent sessions", async () => {
		const root = temporaryRoot();
		const sessionDir = join(root, "sessions");
		const parent = await V3SessionManager.create({
			cwd: root,
			sessionDir,
			features: FLAGS,
		});
		await parent.sessionEvents().recordMessage({
			role: "user",
			content: [{ type: "text", text: "copy failure" }],
		});
		const parentPath = parent.filePath();
		await parent.closeAll();
		vi.spyOn(AgentLoopSessionEvents.prototype, "recordMessage").mockRejectedValueOnce(
			new Error("injected fork import failure"),
		);

		await expect(forkV3FromCli({
			sourcePath: parentPath,
			cwd: root,
			sessionDir,
			features: FLAGS,
		})).rejects.toThrow("cleanup=cleaned");

		const listed = await SessionManager.list(root, sessionDir);
		expect(listed.map((entry) => entry.filePath)).toEqual([parentPath]);
		expect(readdirSync(sessionDir).filter((entry) => entry.endsWith(".jsonl"))).toEqual([
			expect.stringContaining(parent.sessionId()),
		]);
	});

	it("fails closed when a published record is corrupted instead of treating it as legacy-unmanaged", async () => {
		const root = temporaryRoot();
		const sessionDir = join(root, "sessions");
		const manager = await V3SessionManager.create({
			cwd: root,
			sessionDir,
			features: FLAGS,
		});
		const filePath = manager.filePath();
		const stateDirectory = manager.stateDirectory();
		const identity = manager.identity();
		await manager.closeAll();
		writeFileSync(join(stateDirectory, "publication.json"), "{}\n");

		await expect(V3SessionManager.open(filePath, FLAGS, identity)).rejects.toThrow(
			"publication state read failed",
		);
		expect(await SessionManager.list(root, sessionDir)).toEqual([]);
		expect(existsSync(filePath)).toBe(true);
	});

	it("registers restore dependencies before any durable session open or mutable handle exists", async () => {
		const root = temporaryRoot();
		const eventStoreOpen = vi.spyOn(JsonlV3EventStore, "open");
		const reconcile = vi.spyOn(ArtifactRepository.prototype, "reconcile");
		const primary = new Error("injected dependency registration failure");

		await expect(V3SessionManager.restore(
			join(root, "missing.jsonl"),
			FLAGS,
			createLocalIdentityContext(),
			{ registerDependencies: async () => { throw primary; } },
		)).rejects.toMatchObject({
			code: "registration_failed",
			cause: primary,
		});

		expect(eventStoreOpen).not.toHaveBeenCalled();
		expect(reconcile).not.toHaveBeenCalled();
	});

	it("validates dependency identity and generation before replay, then retains registered handles", async () => {
		const root = temporaryRoot();
		const manager = await V3SessionManager.create({
			cwd: root,
			sessionDir: join(root, "sessions"),
			features: FLAGS,
		});
		const providerHandle = { provider: "deepseek" };
		const dependencies: readonly SessionRestoreDependencyBinding[] = [{
			kind: "provider",
			identity: "provider:deepseek",
			generation: 7,
			handle: providerHandle,
		}];
		await writeDependencyBoundSnapshot(manager, dependencies);
		const filePath = manager.filePath();
		const snapshotPath = join(manager.stateDirectory(), "snapshot.json");
		const identity = manager.identity();
		await manager.closeAll();

		const order: string[] = [];
		const originalOpen = JsonlV3EventStore.open;
		vi.spyOn(JsonlV3EventStore, "open").mockImplementation(async (options) => {
			order.push("event-store-open");
			// 已验证的 snapshot 必须贯穿 recovery，禁止在此处二次读取被替换的文件。
			writeFileSync(snapshotPath, "{}\n");
			return originalOpen(options);
		});
		const restored = await V3SessionManager.restore(filePath, FLAGS, identity, {
			registerDependencies: async () => {
				order.push("register");
				return dependencies;
			},
		});

		expect(order).toEqual(["register", "event-store-open"]);
		expect(restored.restoreDependency("provider", "provider:deepseek")).toBe(providerHandle);
		expect(restored.recoveryDecision()).toMatchObject({
			kind: "resume",
			snapshotSource: "snapshot",
		});
		await restored.closeAll();
	});

	it.each([
		{
			label: "identity",
			dependency: {
				kind: "provider" as const,
				identity: "provider:other",
				generation: 7,
				handle: {},
			},
			code: "identity_mismatch",
		},
		{
			label: "generation",
			dependency: {
				kind: "provider" as const,
				identity: "provider:deepseek",
				generation: 8,
				handle: {},
			},
			code: "generation_mismatch",
		},
	])("rejects a restore dependency $label mismatch before Event Store replay or reconciliation", async ({
		dependency,
		code,
	}) => {
		const root = temporaryRoot();
		const manager = await V3SessionManager.create({
			cwd: root,
			sessionDir: join(root, "sessions"),
			features: FLAGS,
		});
		await writeDependencyBoundSnapshot(manager, [{
			kind: "provider",
			identity: "provider:deepseek",
			generation: 7,
			handle: {},
		}]);
		const filePath = manager.filePath();
		const identity = manager.identity();
		await manager.closeAll();
		const eventStoreOpen = vi.spyOn(JsonlV3EventStore, "open");
		const reconcile = vi.spyOn(ArtifactRepository.prototype, "reconcile");

		await expect(V3SessionManager.restore(filePath, FLAGS, identity, {
			registerDependencies: async () => [dependency],
		})).rejects.toMatchObject({ code });

		expect(eventStoreOpen).not.toHaveBeenCalled();
		expect(reconcile).not.toHaveBeenCalled();
	});

	it("reissues an exact durable receipt for the current delayed-genesis head", async () => {
		const root = temporaryRoot();
		const sessionId = createRuntimeId(
			"session",
			"delayed-genesis-durable-head",
		);
		const manager = await V3SessionManager.create({
			cwd: root,
			sessionDir: join(root, "sessions"),
			sessionId,
			features: FLAGS,
			writeGenesis: false,
		});

		expect(await manager.flushCurrentHead()).toMatchObject({
			ok: false,
			error: {
				code: "sequence_conflict",
				effect: "none",
			},
		});
		await manager.sessionEvents().ensureInitialized();
		const first = await manager.flushCurrentHead();
		const replay = await manager.flushCurrentHead();
		expect(first).toMatchObject({
			ok: true,
			value: {
				cursor: {
					stream: {
						scope: "session",
						sessionId,
					},
					sequence: 0,
				},
			},
		});
		expect(replay).toMatchObject({
			ok: true,
			value: {
				cursor:
					first.ok
						? first.value.cursor
						: expect.any(Object),
			},
		});
		await manager.closeAll();
	});

	it.each([
		{
			label: "relative",
			path: (root: string, sessionId: string) => join("sessions", `exact_${sessionId}.jsonl`),
			message: "must be absolute",
		},
		{
			label: "outside the resolved session directory",
			path: (root: string, sessionId: string) => join(root, "other", `exact_${sessionId}.jsonl`),
			message: "resolved session directory",
		},
		{
			label: "not bound to the session id",
			path: (root: string) => join(root, "sessions", "2026-07-23T00-00-00-000Z_session_other.jsonl"),
			message: "must be bound to sessionId",
		},
	])("rejects an exact create path that is $label", async ({ path, message }) => {
		const root = temporaryRoot();
		const sessionId = createRuntimeId("session", "exact-create-path");
		await expect(V3SessionManager.create({
			cwd: root,
			sessionDir: join(root, "sessions"),
			sessionId,
			filePath: path(root, sessionId),
			features: FLAGS,
		})).rejects.toThrow(message);
	});

	it("closes writer and store, releases the lease, and stops heartbeat when automatic genesis fails", async () => {
		vi.useFakeTimers();
		const root = temporaryRoot();
		const sessionDir = join(root, "sessions");
		const sessionId = createRuntimeId("session", "genesis-cleanup");
		const filePath = join(sessionDir, `2026-07-23T00-00-00-000Z_${sessionId}.jsonl`);
		const primary = new Error("injected automatic genesis failure");
		vi.spyOn(AgentLoopSessionEvents.prototype, "ensureInitialized").mockRejectedValueOnce(primary);
		const writerClose = vi.spyOn(EventWriter.prototype, "close");
		const storeClose = vi.spyOn(JsonlV3EventStore.prototype, "close");
		const release = vi.spyOn(FileWriterLeaseStore.prototype, "release");
		const heartbeat = vi.spyOn(FileWriterLeaseStore.prototype, "heartbeat");

		await expect(V3SessionManager.create({
			cwd: root,
			sessionDir,
			sessionId,
			filePath,
			features: FLAGS,
		})).rejects.toMatchObject({
			name: "V3SessionInitializationError",
			stage: "genesis",
			filePath,
			sessionId,
			effect: "none",
			cleanup: { status: "cleaned", errors: [] },
			cause: primary,
		});

		expect(writerClose).toHaveBeenCalledTimes(1);
		expect(storeClose).toHaveBeenCalled();
		expect(release).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(31_000);
		expect(heartbeat).not.toHaveBeenCalled();
	});

	it("retains automatic-genesis primary and every cleanup failure", async () => {
		const root = temporaryRoot();
		const primary = new Error("injected automatic genesis failure");
		const writerFailure = new Error("injected writer close failure");
		vi.spyOn(AgentLoopSessionEvents.prototype, "ensureInitialized").mockRejectedValueOnce(primary);
		vi.spyOn(EventWriter.prototype, "close").mockRejectedValueOnce(writerFailure);
		const originalStoreClose = JsonlV3EventStore.prototype.close;
		vi.spyOn(JsonlV3EventStore.prototype, "close").mockImplementationOnce(async function () {
			await originalStoreClose.call(this);
			return {
				ok: false,
				error: {
					code: "durable_write_failed",
					message: "injected store close failure",
					retryable: false,
					effect: "uncertain",
				},
			};
		});
		const release = vi.spyOn(FileWriterLeaseStore.prototype, "release").mockReturnValueOnce({
			ok: false,
			error: {
				code: "durable_write_failed",
				message: "injected lease release failure",
				retryable: true,
				effect: "none",
			},
		});

		let caught: unknown;
		try {
			await V3SessionManager.create({
				cwd: root,
				sessionDir: join(root, "sessions"),
				features: FLAGS,
			});
		} catch (error) {
			caught = error;
		}

		expect(caught).toBeInstanceOf(V3SessionInitializationError);
		expect(caught).toMatchObject({
				stage: "genesis",
				cause: primary,
				cleanup: {
					status: "incomplete",
				},
			});
		expect((caught as V3SessionInitializationError).cleanup.errors.join("\n")).toContain(
			"injected writer close failure",
		);
		expect((caught as V3SessionInitializationError).cleanup.errors.join("\n")).toContain(
			"injected store close failure",
		);
		expect((caught as V3SessionInitializationError).cleanup.errors.join("\n")).toContain(
			"injected lease release failure",
		);
		expect(release).toHaveBeenCalledTimes(1);
	});

	it("creates, releases, reopens, recovers, and replays canonical model history", async () => {
		const root = temporaryRoot();
		const sessions = join(root, "sessions");
		const manager = await V3SessionManager.create({ cwd: root, sessionDir: sessions, features: FLAGS });
		const fence = manager.writerFenceReceipt();
		expect(() => manager.writerLeaseReleasedEvidence()).toThrow("release is not confirmed");
		await manager.sessionEvents().recordMessage({ role: "user", content: [{ type: "text", text: "hello" }] });
		const filePath = manager.filePath();
		const sessionId = manager.sessionId();
		const closeWithEvidence = manager.closeAllWithWriterLeaseEvidence();
		expect(manager.closeAllWithWriterLeaseEvidence()).toBe(closeWithEvidence);
		const evidence = await closeWithEvidence;
		const { evidenceDigest, ...evidenceBody } = evidence;
		expect(evidenceBody).toEqual({
			authorityId: fence.authorityId,
			tenantId: fence.tenantId,
			sessionId,
			runtimeInstanceId: fence.runtimeId,
			leaseId: fence.leaseId,
			writerEpoch: fence.writerEpoch,
			fencingTokenDigest: fence.fencingTokenDigest,
			releasedAt: expect.any(String),
		});
		expect(evidenceDigest).toBe(canonicalDigest(evidenceBody));
		expect(evidence).not.toHaveProperty("fencingToken");
		expect(manager.writerLeaseReleasedEvidence()).toEqual(evidence);

		const reopened = await V3SessionManager.open(filePath, FLAGS);
		expect(reopened.sessionId()).toBe(sessionId);
		expect(reopened.recoveryDecision()).toMatchObject({ kind: "resume", snapshotSource: "full" });
		expect(await reopened.replayMessages()).toEqual([
			{ role: "user", content: [{ type: "text", text: "hello" }] },
		]);
		await reopened.closeAll();
	});

	it("recovers exact released evidence when the release commit acknowledgement is lost", async () => {
		const root = temporaryRoot();
		const manager = await V3SessionManager.create({
			cwd: root,
			sessionDir: join(root, "sessions"),
			features: FLAGS,
		});
		const originalRelease = FileWriterLeaseStore.prototype.release;
		const release = vi.spyOn(FileWriterLeaseStore.prototype, "release").mockImplementationOnce(function (fence) {
			const committed = originalRelease.call(this, fence);
			expect(committed.ok).toBe(true);
			return {
				ok: false,
				error: {
					code: "durable_write_failed",
					message: "injected acknowledgement loss after durable release",
					retryable: true,
					effect: "uncertain",
				},
			};
		});
		const inspectReleased = vi.spyOn(FileWriterLeaseStore.prototype, "inspectReleased");

		await expect(manager.closeAll()).resolves.toBeUndefined();
		expect(manager.isClosed()).toBe(true);
		expect(release).toHaveBeenCalledTimes(1);
		expect(inspectReleased).toHaveBeenCalledTimes(1);
		expect(manager.writerLeaseReleasedEvidence()).toMatchObject({
			runtimeInstanceId: manager.runtimeId(),
			releasedAt: expect.any(String),
			evidenceDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
		});
	});

	it("publishes the latest durable writer lease expiry after heartbeat renewal", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-07-23T02:00:00.000Z"));
		const root = temporaryRoot();
		const manager = await V3SessionManager.create({
			cwd: root,
			sessionDir: join(root, "sessions"),
			features: FLAGS,
		});
		const initial = manager.writerFenceReceipt();

		await vi.advanceTimersByTimeAsync(10_000);
		const renewed = manager.writerFenceReceipt();

		expect(renewed.acquiredAt).toBe(initial.acquiredAt);
		expect(renewed.expiresAt).toBe("2026-07-23T02:00:40.000Z");
		expect(Date.parse(renewed.expiresAt)).toBeGreaterThan(Date.parse(initial.expiresAt));
		expect(renewed.receiptDigest).not.toBe(initial.receiptDigest);
		await manager.closeAll();
	});

	it("permanently fences writer-fence claims after a heartbeat failure", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-07-23T03:00:00.000Z"));
		const root = temporaryRoot();
		const manager = await V3SessionManager.create({
			cwd: root,
			sessionDir: join(root, "sessions"),
			features: FLAGS,
		});
		const heartbeat = vi.spyOn(FileWriterLeaseStore.prototype, "heartbeat").mockReturnValueOnce({
			ok: false,
			error: {
				code: "durable_write_failed",
				message: "injected heartbeat failure",
				retryable: true,
				effect: "uncertain",
			},
		});

		await vi.advanceTimersByTimeAsync(10_000);
		expect(heartbeat).toHaveBeenCalledTimes(1);
		expect(() => manager.writerFenceReceipt()).toThrow("v3 writer lease is fenced");

		heartbeat.mockRestore();
		expect(() => manager.writerFenceReceipt()).toThrow("v3 writer lease is fenced");
		await manager.closeAll();
	});

	it("fails writer-fence claims closed when the exact durable lease cannot be validated", async () => {
		const root = temporaryRoot();
		const manager = await V3SessionManager.create({
			cwd: root,
			sessionDir: join(root, "sessions"),
			features: FLAGS,
		});
		const validate = vi.spyOn(FileWriterLeaseStore.prototype, "validate").mockReturnValueOnce({
			ok: false,
			error: {
				code: "writer_fenced",
				message: "injected exact-fence mismatch",
				retryable: false,
				effect: "none",
			},
		});

		expect(() => manager.writerFenceReceipt()).toThrow("v3 writer lease is fenced");
		expect(validate).toHaveBeenCalledTimes(1);

		validate.mockRestore();
		expect(() => manager.writerFenceReceipt()).toThrow("v3 writer lease is fenced");
		await manager.closeAll();
	});

	it("releases the lease and keeps release evidence when writer close acknowledgement is uncertain", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-07-23T00:00:00.000Z"));
		const root = temporaryRoot();
		const manager = await V3SessionManager.create({
			cwd: root,
			sessionDir: join(root, "sessions"),
			features: FLAGS,
		});
		const firstFence = manager.writerFenceReceipt();
		const originalClose = JsonlV3EventStore.prototype.close;
		let closeAttempts = 0;
		vi.spyOn(JsonlV3EventStore.prototype, "close").mockImplementation(async function () {
			closeAttempts += 1;
			const result = await originalClose.call(this);
			if (closeAttempts === 1 && result.ok) {
				return {
					ok: false,
					error: {
						code: "durable_write_failed",
						message: "injected result loss after the event store closed",
						retryable: false,
						effect: "uncertain",
					},
				};
			}
			return result;
		});
		const heartbeat = vi.spyOn(FileWriterLeaseStore.prototype, "heartbeat");

		const failedClose = manager.closeAll();
		await expect(failedClose).rejects.toThrow("v3 event writer close failed");
		expect(manager.isClosed()).toBe(true);
		expect(manager.writerLeaseReleasedEvidence()).toMatchObject({
			runtimeInstanceId: manager.runtimeId(),
			writerEpoch: firstFence.writerEpoch,
			releasedAt: expect.any(String),
		});
		expect(manager.closeAll()).toBe(failedClose);
		expect(closeAttempts).toBe(1);
		await vi.advanceTimersByTimeAsync(31_000);
		expect(heartbeat).not.toHaveBeenCalled();
		const recovered = await V3SessionManager.open(
			manager.filePath(),
			FLAGS,
			manager.identity(),
			{ runtimeId: createRuntimeId("runtime", "released-takeover") },
		);

		expect(recovered.writerFenceReceipt().writerEpoch).toBe(firstFence.writerEpoch + 1);
		expect(recovered.recoveryDecision()).toMatchObject({ kind: "resume" });
		await recovered.closeAll();
	});

	it("releases compose resources when replay fails after writer construction", async () => {
		const root = temporaryRoot();
		const seed = await V3SessionManager.create({
			cwd: root,
			sessionDir: join(root, "sessions"),
			features: FLAGS,
		});
		const filePath = seed.filePath();
		const identity = seed.identity();
		await seed.closeAll();
		const readPage = vi.spyOn(JsonlV3EventStore.prototype, "readPage").mockResolvedValueOnce({
			ok: false,
			error: {
				code: "corrupted_log",
				message: "injected replay failure",
				retryable: false,
				effect: "none",
			},
		});
		const writerClose = vi.spyOn(EventWriter.prototype, "close");
		const storeClose = vi.spyOn(JsonlV3EventStore.prototype, "close");
		const release = vi.spyOn(FileWriterLeaseStore.prototype, "release");

		await expect(V3SessionManager.open(filePath, FLAGS, identity)).rejects.toThrow(
			"v3 session state replay failed",
		);
		expect(writerClose).toHaveBeenCalledTimes(1);
		expect(storeClose).toHaveBeenCalled();
		expect(release).toHaveBeenCalledTimes(1);

		readPage.mockRestore();
		const recovered = await V3SessionManager.open(filePath, FLAGS, identity);
		await recovered.closeAll();
	});

	it("continues store close and lease release after writer close throws, retaining all failures", async () => {
		const root = temporaryRoot();
		const manager = await V3SessionManager.create({
			cwd: root,
			sessionDir: join(root, "sessions"),
			features: FLAGS,
		});
		const writerFailure = new Error("injected writer close throw");
		vi.spyOn(EventWriter.prototype, "close").mockRejectedValueOnce(writerFailure);
		const originalStoreClose = JsonlV3EventStore.prototype.close;
		const storeClose = vi.spyOn(JsonlV3EventStore.prototype, "close").mockImplementationOnce(async function () {
			await originalStoreClose.call(this);
			return {
				ok: false,
				error: {
					code: "durable_write_failed",
					message: "injected store close failure",
					retryable: false,
					effect: "uncertain",
				},
			};
		});
		const release = vi.spyOn(FileWriterLeaseStore.prototype, "release").mockReturnValueOnce({
			ok: false,
			error: {
				code: "durable_write_failed",
				message: "injected lease release failure",
				retryable: true,
				effect: "none",
			},
		});

		let caught: unknown;
		try {
			await manager.closeAll();
		} catch (error) {
			caught = error;
		}

		expect(caught).toBeInstanceOf(AggregateError);
		expect((caught as AggregateError).errors).toEqual([
			writerFailure,
			expect.objectContaining({ message: expect.stringContaining("injected store close failure") }),
			expect.objectContaining({ message: expect.stringContaining("injected lease release failure") }),
		]);
		expect(storeClose).toHaveBeenCalledTimes(1);
		expect(release).toHaveBeenCalledTimes(1);
		expect(manager.isClosed()).toBe(false);
		expect(() => manager.writerLeaseReleasedEvidence()).toThrow("release is not confirmed");
	});

	it("does not revive its heartbeat when lease release fails after a confirmed writer close", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-07-23T01:00:00.000Z"));
		const root = temporaryRoot();
		const manager = await V3SessionManager.create({
			cwd: root,
			sessionDir: join(root, "sessions"),
			features: FLAGS,
		});
		const firstFence = manager.writerFenceReceipt();
		const release = vi.spyOn(FileWriterLeaseStore.prototype, "release").mockReturnValueOnce({
			ok: false,
			error: {
				code: "durable_write_failed",
				message: "injected lease release failure",
				retryable: true,
				effect: "none",
			},
		});
		const heartbeat = vi.spyOn(FileWriterLeaseStore.prototype, "heartbeat");

		const failedClose = manager.closeAll();
		await expect(failedClose).rejects.toThrow("v3 writer lease release failed");
		expect(manager.isClosed()).toBe(false);
		expect(() => manager.writerLeaseReleasedEvidence()).toThrow("release is not confirmed");
		expect(manager.closeAll()).toBe(failedClose);
		expect(release).toHaveBeenCalledTimes(1);

		await vi.advanceTimersByTimeAsync(31_000);
		expect(heartbeat).not.toHaveBeenCalled();
		const recovered = await V3SessionManager.open(
			manager.filePath(),
			FLAGS,
			manager.identity(),
			{ runtimeId: createRuntimeId("runtime", "release-failure-takeover") },
		);
		expect(recovered.writerFenceReceipt().writerEpoch).toBe(firstFence.writerEpoch + 1);
		await recovered.closeAll();
	});

	it("keeps renewing its writer lease while a slow writer close is still pending", async () => {
		vi.useFakeTimers();
		const root = temporaryRoot();
		const manager = await V3SessionManager.create({
			cwd: root,
			sessionDir: join(root, "sessions"),
			features: FLAGS,
		});
		const originalClose = EventWriter.prototype.close;
		let releaseClose: (() => void) | undefined;
		const closeGate = new Promise<void>((resolve) => {
			releaseClose = resolve;
		});
		vi.spyOn(EventWriter.prototype, "close").mockImplementationOnce(async function () {
			await closeGate;
			return originalClose.call(this);
		});
		const heartbeat = vi.spyOn(FileWriterLeaseStore.prototype, "heartbeat");

		const closing = manager.closeAll();
		await vi.advanceTimersByTimeAsync(20_000);
		expect(heartbeat).toHaveBeenCalledTimes(2);
		expect(manager.isClosed()).toBe(false);

		releaseClose?.();
		await expect(closing).resolves.toBeUndefined();
		expect(manager.isClosed()).toBe(true);
	});

	it("migrates legacy v2 through an explicit empty v3 target and lists it as v3", async () => {
		const root = temporaryRoot();
		const legacyDir = join(root, "legacy");
		const v3Dir = join(root, "v3");
		const legacy = await SessionManager.create({ cwd: root, sessionDir: legacyDir });
		const message = { role: "user", content: [{ type: "text", text: "migrate me" }] } as const;
		await legacy.ledger().append({
			id: "legacy-message",
			sessionId: legacy.sessionId(),
			parentId: legacy.ledger().header().id,
			timestamp: Date.now(),
			type: "message",
			payload: { schema: "agent-message/v1", role: "user", message },
		});
		await legacy.ledger().append({
			id: "legacy-config",
			sessionId: legacy.sessionId(),
			parentId: "legacy-message",
			timestamp: Date.now(),
			type: "custom",
			payload: { kind: "runtime.config", provider: "fixture", model: "fixture-model", thinkingLevel: "high" },
		});
		const sourcePath = legacy.filePath();
		await legacy.closeAll();

		const migrated = await migrateLegacyFromCli({
			sourcePath,
			mode: "migrate",
			cwd: root,
			sessionDir: v3Dir,
			features: FLAGS,
		});
		expect(migrated.importedMessageCount).toBe(1);
		const listed = await SessionManager.list(root, v3Dir);
		expect(listed).toHaveLength(1);
		expect(listed[0]).toMatchObject({ filePath: migrated.filePath, format: "v3", version: 3 });

		const manager = await V3SessionManager.open(migrated.filePath, FLAGS);
		expect(await manager.replayMessages()).toEqual([message]);
		expect(await manager.replayRuntimeConfig()).toEqual({
			provider: "fixture",
			model: "fixture-model",
			thinkingLevel: "high",
		});
		await manager.closeAll();
	});

	it("opens an interrupted migration inspect-only until it is resumed or durably failed", async () => {
		const root = temporaryRoot();
		const target = await V3SessionManager.create({
			cwd: root,
			sessionDir: join(root, "sessions"),
			features: FLAGS,
			writeGenesis: false,
		});
		const manifest = {
			mode: "migrate" as const,
			sourceVersion: 2 as const,
			sourceDigest: canonicalDigest("legacy-source"),
			sourceSize: 42,
			headerDigest: canonicalDigest("legacy-header"),
			sourceSessionId: "legacy-session",
			importerVersion: "fixture-importer",
			importSchema: "runtime-session-migration/v1",
			configurationJson: "{}",
			configurationDigest: canonicalDigest("{}"),
			recoveredFields: [],
			lostFields: [],
			expectedRecordCount: 1,
			expectedRecordSetDigest: canonicalDigest(["pending-record"]),
		};
		const started = await target.writer().append({
			type: "session.migration_started",
			principalId: target.identity().principalId,
			traceId: createRuntimeId("trace", "partial-migration"),
			payload: {
				...manifest,
				manifestDigest: canonicalDigest(manifest),
				idempotencyKey: createRuntimeId("command", "partial-migration"),
			},
		});
		expect(started.ok).toBe(true);
		const filePath = target.filePath();
		await target.closeAll();

		const paused = await V3SessionManager.open(filePath, FLAGS);
		expect(paused.artifactReconciliation()).toBeUndefined();
		expect(paused.recoveryDecision()).toMatchObject({
			kind: "reconciliation_required",
			reasons: ["uncertain_operation"],
			projection: { lifecycle: "migration_in_progress", migration: { status: "in_progress" } },
		});
		await expect(paused.replayMessages()).rejects.toThrow("legacy migration is not durably committed");
		const failed = await paused.markLegacyMigrationFailed("operator_abandoned", "operator chose a new target");
		expect(failed).toMatchObject({ head: { sequence: 1 }, importedRecordCount: 0 });
		expect(paused.recoveryDecision()).toMatchObject({ kind: "stopped", reason: "migration_failed" });
		await paused.closeAll();

		const terminal = await V3SessionManager.open(filePath, FLAGS);
		expect(terminal.recoveryDecision()).toMatchObject({ kind: "stopped", reason: "migration_failed" });
		expect(terminal.artifactReconciliation()).toBeUndefined();
		await terminal.closeAll();
	});

	it("durably interrupts an in-flight tool and turn once, then keeps the mutation gate in reconciliation", async () => {
		const root = temporaryRoot();
		const manager = await V3SessionManager.create({
			cwd: root,
			sessionDir: join(root, "sessions"),
			features: FLAGS,
		});
		const turn = await manager.sessionEvents().beginTurn();
		const tool = await manager.sessionEvents().requestTool(
			turn,
			"provider-crash",
			"fixture",
			{ sideEffect: true },
		);
		const filePath = manager.filePath();
		const identity = manager.identity();
		await manager.closeAll();

		const recovered = await V3SessionManager.open(filePath, FLAGS, identity);
		expect(recovered.recoveryDecision()).toMatchObject({
			kind: "reconciliation_required",
			reasons: ["uncertain_operation"],
			projection: {
				activeTurnId: null,
				activeModelRequestId: null,
				hasUncertainOperations: true,
			},
		});
		const recoveredEvents = valueOf(await readAllRuntimeEvents(recovered.eventStore()));
		expect(recoveredEvents.filter((event) => event.type === "tool.interrupted")).toEqual([
			expect.objectContaining({
				payload: {
					toolCallId: tool.toolCallId,
					outcomeCertain: false,
					reason: expect.any(String),
				},
			}),
		]);
		expect(recoveredEvents.filter((event) => event.type === "turn.interrupted")).toHaveLength(1);
		await recovered.closeAll();

		const secondRecovery = await V3SessionManager.open(filePath, FLAGS, identity);
		const replay = valueOf(await readAllRuntimeEvents(secondRecovery.eventStore()));
		expect(replay.filter((event) => event.type === "tool.interrupted")).toHaveLength(1);
		expect(replay.filter((event) => event.type === "turn.interrupted")).toHaveLength(1);
		await secondRecovery.closeAll();
	});

	it("forks only a stable v3 boundary into a distinct lineage without copying event IDs", async () => {
		const root = temporaryRoot();
		const sessions = join(root, "sessions");
		const parent = await V3SessionManager.create({ cwd: root, sessionDir: sessions, features: FLAGS });
		await parent.sessionEvents().recordMessage({ role: "user", content: [{ type: "text", text: "fork me" }] });
		const parentPath = parent.filePath();
		await parent.closeAll();

		const forked = await forkV3FromCli({ sourcePath: parentPath, cwd: root, sessionDir: sessions, features: FLAGS });
		const child = await V3SessionManager.open(forked.filePath, FLAGS);
		const childEvents = await readAllRuntimeEvents(child.eventStore());
		expect(childEvents.ok).toBe(true);
		if (!childEvents.ok) throw new Error(childEvents.error.message);
		expect(childEvents.value[0]).toMatchObject({
			type: "session.forked",
			payload: {
				parentEventHash: forked.parentHeadDigest,
				goalMode: "continue_existing_goal",
				initialGoalId: forked.initialGoalId,
				rootAgentId: forked.rootAgentId,
				parentRootAgentId: forked.parentRootAgentId,
			},
		});
		expect(child.sessionEvents().lineage()).toEqual({
			goalId: forked.initialGoalId,
			agentId: forked.rootAgentId,
		});
		const parentReopened = await V3SessionManager.open(parentPath, FLAGS);
		const parentEvents = await readAllRuntimeEvents(parentReopened.eventStore());
		if (!parentEvents.ok) throw new Error(parentEvents.error.message);
		expect(new Set(parentEvents.value.map((event) => event.eventId)).has(childEvents.value[0]!.eventId)).toBe(false);
		expect(await child.replayMessages()).toEqual([
			{ role: "user", content: [{ type: "text", text: "fork me" }] },
		]);
		await parentReopened.closeAll();
		await child.closeAll();
	});

	it("persists an explicit create-child-goal selection through CLI fork and reopen", async () => {
		const root = temporaryRoot();
		const sessions = join(root, "sessions");
		const parent = await V3SessionManager.create({ cwd: root, sessionDir: sessions, features: FLAGS });
		const parentLineage = parent.sessionEvents().lineage();
		const parentPath = parent.filePath();
		await parent.closeAll();
		const childGoalId = createRuntimeId("goal", "cli-child-goal");
		const forked = await forkV3FromCli({
			sourcePath: parentPath,
			cwd: root,
			sessionDir: sessions,
			features: FLAGS,
			goalMode: "create_child_goal",
			initialGoalId: childGoalId,
		});
		expect(forked).toMatchObject({
			goalMode: "create_child_goal",
			initialGoalId: childGoalId,
			parentRootAgentId: parentLineage.agentId,
		});
		expect(forked.rootAgentId).not.toBe(parentLineage.agentId);
		const child = await V3SessionManager.open(forked.filePath, FLAGS);
		expect(child.sessionEvents().lineage()).toEqual({ goalId: childGoalId, agentId: forked.rootAgentId });
		await child.closeAll();
	});

	it("writes a stop tombstone before terminal stop and never resumes it", async () => {
		const root = temporaryRoot();
		const manager = await V3SessionManager.create({ cwd: root, sessionDir: join(root, "sessions"), features: FLAGS });
		const filePath = manager.filePath();
		await manager.requestStop("operator stop");
		await manager.closeAll();

		const reopened = await V3SessionManager.open(filePath, FLAGS);
		expect(reopened.recoveryDecision()).toMatchObject({ kind: "stopped", reason: "stop_tombstone" });
		await reopened.closeAll();
	});

	it("reconciles a committed Artifact left pending by a crash before CAS promotion", async () => {
		const root = temporaryRoot();
		const manager = await V3SessionManager.create({ cwd: root, sessionDir: join(root, "sessions"), features: FLAGS });
		const artifactRoot = join(manager.stateDirectory(), "artifacts");
		const identity = manager.identity();
		const artifactId = createRuntimeId("artifact", "startup-reconcile");
		const intentId = createRuntimeId("command", "startup-reconcile");
		const crashingRepository = new ArtifactRepository({
			cas: new ArtifactCasStore({
				rootDir: artifactRoot,
				onWritePhase: (phase, targetPath) => {
					if (phase === "before_rename" && targetPath.includes("/blobs/")) throw new Error("simulated crash");
				},
			}),
			metadata: new ArtifactMetadataStore({ rootDir: artifactRoot }),
			journal: new SessionArtifactJournal({
				writer: manager.writer(),
				store: manager.eventStore(),
				principalId: identity.principalId,
			}),
			keyProvider: new UnavailableArtifactKeyProvider(),
			clock: () => new Date("2026-07-22T00:00:00.000Z"),
		});
		const pending = await crashingRepository.write({
			authorityId: identity.authorityId,
			tenantId: identity.tenantId,
			artifactId,
			intentId,
			principalId: identity.principalId,
			source: { sessionId: manager.sessionId(), producerId: identity.principalId },
			kind: "tool_output",
			mediaType: "text/plain",
			content: "durable output",
		});
		expect(pending).toMatchObject({ ok: true, value: { state: "pending" } });
		if (!pending.ok) throw new Error(pending.error.message);
		const storedDigest = pending.value.metadata.storedDigest;
		const filePath = manager.filePath();
		await manager.closeAll();

		const reopened = await V3SessionManager.open(filePath, FLAGS, identity);
		expect(reopened.artifactReconciliation()).toMatchObject({
			ok: true,
			value: { recovered: [intentId], failed: [] },
		});
		const committed = await new ArtifactMetadataStore({ rootDir: artifactRoot }).readCommitted(
			identity.authorityId,
			identity.tenantId,
			artifactId,
		);
		expect(committed).toMatchObject({ ok: true, value: { state: "committed", storedDigest } });
		expect(await new ArtifactCasStore({ rootDir: artifactRoot }).read(storedDigest)).toMatchObject({ ok: true });
		expect(reopened.recoveryDecision()).toMatchObject({ kind: "resume" });
		await reopened.closeAll();
	});

	it("preserves the genesis goal and root agent lineage across reopen", async () => {
		const root = temporaryRoot();
		const manager = await V3SessionManager.create({
			cwd: root,
			sessionDir: join(root, "sessions"),
			features: FLAGS,
		});
		const initialLineage = manager.sessionEvents().lineage();
		const firstTurn = await manager.sessionEvents().beginTurn();
		const firstTool = await manager.sessionEvents().requestTool(firstTurn, "provider-1", "fixture", {});
		await manager.sessionEvents().failTool(firstTool, new Error("fixture"), true);
		await manager.sessionEvents().finishTurn(firstTurn, { ok: false }, "stop");
		const filePath = manager.filePath();
		await manager.closeAll();

		const reopened = await V3SessionManager.open(filePath, FLAGS);
		expect(reopened.sessionEvents().lineage()).toEqual(initialLineage);
		const secondTurn = await reopened.sessionEvents().beginTurn();
		const secondTool = await reopened.sessionEvents().requestTool(secondTurn, "provider-2", "fixture", {});
		await reopened.sessionEvents().failTool(secondTool, new Error("fixture"), true);
		await reopened.sessionEvents().finishTurn(secondTurn, { ok: false }, "stop");
		const events = await readAllRuntimeEvents(reopened.eventStore());
		if (!events.ok) throw new Error(events.error.message);
		const genesis = events.value[0];
		expect(genesis).toMatchObject({
			type: "session.created",
			payload: {
				initialGoalId: initialLineage.goalId,
				rootAgentId: initialLineage.agentId,
			},
		});
		expect(
			events.value.filter((event) => event.type === "turn.started").map((event) => event.payload.goalId),
		).toEqual([initialLineage.goalId, initialLineage.goalId]);
		expect(
			events.value.filter((event) => event.type === "tool.requested").map((event) => event.payload.agentId),
		).toEqual([initialLineage.agentId, initialLineage.agentId]);
		await reopened.closeAll();
	});

	it("restores pending queue bodies, references, kinds, and enqueue order", async () => {
		const root = temporaryRoot();
		const manager = await V3SessionManager.create({
			cwd: root,
			sessionDir: join(root, "sessions"),
			features: FLAGS,
		});
		const messages = [
			{ kind: "steer" as const, message: { role: "user" as const, content: [{ type: "text" as const, text: "one" }] } },
			{ kind: "follow_up" as const, message: { role: "user" as const, content: [{ type: "text" as const, text: "two" }] } },
			{ kind: "steer" as const, message: { role: "user" as const, content: [{ type: "text" as const, text: "three" }] } },
		];
		const receipts = [];
		for (const item of messages) {
			receipts.push(await manager.sessionEvents().enqueueWithReceipt(item.kind, item.message));
		}
		const filePath = manager.filePath();
		await manager.closeAll();

		const reopened = await V3SessionManager.open(filePath, FLAGS);
		expect(reopened.recoveryDecision()).toMatchObject({ kind: "resume" });
		expect(reopened.sessionEvents().pendingQueueItems().map((item) => ({
			queueItemId: item.reference.queueItemId,
			kind: item.reference.kind,
			message: item.message,
		}))).toEqual(messages.map((item, index) => ({
			queueItemId: receipts[index]!.queueItemId,
			kind: item.kind,
			message: item.message,
		})));
		await reopened.closeAll();
	});

	it("restarts, lists, replays, and cancels an ArtifactRef-backed QueueItemV3 losslessly", async () => {
		const root = temporaryRoot();
		const manager = await V3SessionManager.create({
			cwd: root,
			sessionDir: join(root, "sessions"),
			features: FLAGS,
		});
		const artifact = await writeQueuedArtifact(manager, "queued-prompt");
		const sourceCommandId = createRuntimeId("command", "queued-prompt-source");
		const receipt = await manager.sessionEvents().enqueueArtifactWithReceipt("follow_up", artifact, {
			sourceCommandId,
		});
		const before = await manager.sessionEvents().inspectQueue();
		expect(before.items).toEqual([
			expect.objectContaining({
				queueItemId: receipt.queueItemId,
				sourceCommandId,
				kind: "follow_up",
				nextTurnPolicy: "after_active_run",
				content: { storage: "artifact", artifact },
				message: null,
			}),
		]);
		const filePath = manager.filePath();
		await manager.closeAll();

		const reopened = await V3SessionManager.open(filePath, FLAGS);
		const restored = await reopened.sessionEvents().inspectQueue();
		expect(restored).toEqual(before);
		expect(() => reopened.sessionEvents().adoptPendingQueueItems()).toThrow("requires artifact resolution");
		const cancellationCommandId = createRuntimeId("command", "queued-prompt-cancel");
		const cancelled = await reopened.sessionEvents().cancelQueueItems(
			restored.queueRevision,
			[{ queueItemId: receipt.queueItemId, kind: "follow_up" }],
			"operator cancelled artifact prompt",
			cancellationCommandId,
		);
		expect(cancelled.receipts).toEqual([
			expect.objectContaining({
				queueItemId: receipt.queueItemId,
				sourceCommandId,
				kind: "follow_up",
				contentDigest: receipt.contentDigest,
			}),
		]);
		const events = await readAllRuntimeEvents(reopened.eventStore());
		if (!events.ok) throw new Error(events.error.message);
		expect(events.value.find((event) => event.type === "queue.enqueued")?.payload).toMatchObject({
			sourceCommandId,
			content: { storage: "artifact", artifact },
		});
		expect(events.value.find((event) => event.type === "queue.cancelled")?.payload).toMatchObject({
			sourceCommandId,
			kind: "follow_up",
			contentDigest: receipt.contentDigest,
			cancellationCommandId,
		});
		await reopened.closeAll();

		const terminalReplay = await V3SessionManager.open(filePath, FLAGS);
		expect((await terminalReplay.sessionEvents().inspectQueue()).items).toEqual([]);
		await terminalReplay.closeAll();
	});

	it("pauses recovery when an Artifact-backed queue blob is missing", async () => {
		const root = temporaryRoot();
		const manager = await V3SessionManager.create({
			cwd: root,
			sessionDir: join(root, "sessions"),
			features: FLAGS,
		});
		const artifact = await writeQueuedArtifact(manager, "queued-prompt-missing");
		await manager.sessionEvents().enqueueArtifactWithReceipt("follow_up", artifact);
		const filePath = manager.filePath();
		const stateDirectory = manager.stateDirectory();
		const identity = manager.identity();
		await manager.closeAll();
		rmSync(artifactBlobPath(stateDirectory, artifact), { force: true });

		const reopened = await V3SessionManager.open(filePath, FLAGS, identity);
		expect(reopened.recoveryDecision()).toMatchObject({
			kind: "reconciliation_required",
			reasons: expect.arrayContaining(["pending_queue_artifact_unavailable"]),
		});
		await reopened.closeAll();
	});

	it("marks recovery corrupted when an Artifact-backed queue blob digest is wrong", async () => {
		const root = temporaryRoot();
		const manager = await V3SessionManager.create({
			cwd: root,
			sessionDir: join(root, "sessions"),
			features: FLAGS,
		});
		const artifact = await writeQueuedArtifact(manager, "queued-prompt-tampered");
		await manager.sessionEvents().enqueueArtifactWithReceipt("follow_up", artifact);
		const filePath = manager.filePath();
		const stateDirectory = manager.stateDirectory();
		const identity = manager.identity();
		await manager.closeAll();
		writeFileSync(artifactBlobPath(stateDirectory, artifact), "tampered");

		const reopened = await V3SessionManager.open(filePath, FLAGS, identity);
		expect(reopened.recoveryDecision()).toMatchObject({
			kind: "corrupted",
			error: {
				code: "corrupted_log",
				details: { reason: "blob_digest_mismatch" },
			},
		});
		await reopened.closeAll();
	});

	it("does not resume an Artifact-backed queue when startup reconciliation is disabled", async () => {
		const root = temporaryRoot();
		const manager = await V3SessionManager.create({
			cwd: root,
			sessionDir: join(root, "sessions"),
			features: FLAGS,
		});
		const artifact = await writeQueuedArtifact(manager, "queued-prompt-no-reconcile");
		await manager.sessionEvents().enqueueArtifactWithReceipt("follow_up", artifact);
		const filePath = manager.filePath();
		const identity = manager.identity();
		await manager.closeAll();

		const reopened = await V3SessionManager.open(filePath, FLAGS, identity, {
			reconcileArtifacts: false,
		});
		expect(reopened.recoveryDecision()).toMatchObject({
			kind: "reconciliation_required",
			reasons: expect.arrayContaining(["pending_queue_artifact_unavailable"]),
		});
		await reopened.closeAll();
	});

	it("rejects a digest-only queue event before it can become durable v3 state", async () => {
		const root = temporaryRoot();
		const manager = await V3SessionManager.create({
			cwd: root,
			sessionDir: join(root, "sessions"),
			features: FLAGS,
		});
		const appended = await manager.writer().append({
			type: "queue.enqueued",
			principalId: manager.identity().principalId,
			traceId: createRuntimeId("trace", "legacy-queue-body"),
			payload: {
				queueItemId: createRuntimeId("queueItem", "legacy-queue-body"),
				kind: "steer",
				contentDigest: "0".repeat(64),
				idempotencyKey: createRuntimeId("command", "legacy-queue-body"),
			} as never,
		});
		expect(appended.ok).toBe(false);
		if (!appended.ok) expect(appended.error.code).toBe("invalid_event");
		await manager.closeAll();
	});
});
