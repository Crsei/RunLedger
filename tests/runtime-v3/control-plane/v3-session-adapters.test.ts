import { mkdtempSync, rmSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	DirectoryV3SessionLocator,
	V3ArtifactStoreQueryAdapter,
	V3DaemonRuntimeRecoveryPortAdapter,
	V3EventSubscriptionSourceAdapter,
	V3QueryExecutorAdapter,
	V3SessionControlStateAdapter,
	V3SessionEvidenceReader,
	V3ManagedSessionRuntime,
	V3SessionRuntimeFactoryAdapter,
} from "../../../src/daemon/v3-session-adapters.ts";
import { projectRuntimeActivityEvents } from "../../../src/runtime/activity/projection.ts";
import { runtimeActivityProjectionBody } from "../../../src/runtime/activity/types.ts";
import { canonicalDigest } from "../../../src/runtime/protocol/v3/canonical-json.ts";
import type { EventCursor } from "../../../src/runtime/protocol/v3/events.ts";
import type { SessionMutationAdmissionGatePort } from "../../../src/runtime/lifecycle/mutation-gate.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/v3/ids.ts";
import type { RuntimeIdentityContext } from "../../../src/runtime/identity/types.ts";
import { DEFAULT_RUNTIME_FEATURES, type RuntimeFeatureFlags } from "../../../src/runtime/runtime-features.ts";
import { ControlPlaneQueryService } from "../../../src/runtime/control-plane/query-service.ts";
import { SessionRuntimeRegistry } from "../../../src/runtime/control-plane/session-registry.ts";
import { BoundedEventSubscription } from "../../../src/runtime/control-plane/subscriptions.ts";
import type {
	ActivityGetQuery,
	ArtifactMetadataQuery,
	ArtifactReadQuery,
	ControlPlaneQuery,
	ControlPlaneRequestContext,
	EventSubscriptionRequest,
} from "../../../src/runtime/control-plane/types.ts";
import type { SessionHandleValidationPort } from "../../../src/runtime/control-plane/query-service.ts";
import { readAllRuntimeEvents } from "../../../src/runtime/session/snapshot.ts";
import { projectRuntimeActivityFromCanonicalEvents } from "../../../src/runtime/telemetry/canonical-events.ts";
import { V3SessionManager } from "../../../src/storage/v3-session-manager.ts";

const AUTHORITY_ID = createRuntimeId("authority", "v3-adapter");
const TENANT_ID = createRuntimeId("tenant", "v3-adapter");
const PRINCIPAL_ID = createRuntimeId("principal", "v3-adapter");
const IDENTITY: RuntimeIdentityContext = {
	authorityId: AUTHORITY_ID,
	tenantId: TENANT_ID,
	principalId: PRINCIPAL_ID,
	source: "managed",
	issuedAt: "2026-07-22T00:00:00.000Z",
};
const FEATURES: RuntimeFeatureFlags = { ...DEFAULT_RUNTIME_FEATURES, sessionV3: true };
const roots: string[] = [];

function temporaryRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "runledger-v3-control-adapter-"));
	roots.push(root);
	return root;
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function setup(root: string) {
	const sessionDir = join(root, "sessions");
	const locator = new DirectoryV3SessionLocator({ cwd: root, sessionDir });
	const factory = new V3SessionRuntimeFactoryAdapter({
		cwd: root,
		sessionDir,
		features: FEATURES,
		identity: IDENTITY,
		locator,
	});
	const registry = new SessionRuntimeRegistry(factory);
	const handles: SessionHandleValidationPort = {
		validate: (handle) => {
			const result = registry.validate(handle);
			return result.ok ? { ok: true, value: undefined } : result;
		},
	};
	const evidence = new V3SessionEvidenceReader({ locator, identity: IDENTITY });
	const states = new V3SessionControlStateAdapter({ sessions: factory, evidence });
	return { sessionDir, locator, factory, registry, handles, evidence, states };
}

function context(): ControlPlaneRequestContext {
	return {
		peer: {
			kind: "local",
			transport: "jsonl",
			pid: 123,
			uid: 1000,
			principalId: PRINCIPAL_ID,
			authenticatedVia: "stdio_parent",
		},
		handshake: {
			kind: "handshake_result",
			requestId: "hello-v3-adapter",
			protocol: { major: 1, minor: 0 },
			controlPlaneSchemaVersion: 1,
			runtimeSchemaVersion: 3,
			features: ["session", "artifact", "event_subscription", "health", "activity"],
			serverInstanceId: "runtime_v3-adapter",
			remoteAccess: "disabled",
			deliveryGuarantee: "at_least_once",
		},
	};
}

function cursor(manager: V3SessionManager): EventCursor {
	const head = manager.writer().currentHead();
	if (!head) throw new Error("fixture manager has no durable head");
	return head;
}

describe("V3SessionManager lifecycle adapters", () => {
	it("does not mark or unregister a managed runtime when manager close fails", async () => {
		const root = temporaryRoot();
		const manager = await V3SessionManager.create({
			cwd: root,
			sessionDir: join(root, "sessions"),
			features: FEATURES,
			identity: IDENTITY,
		});
		const onClosed = vi.fn();
		const close = vi.spyOn(manager, "closeAll").mockRejectedValue(new Error("injected close failure"));
		const mutationGate: SessionMutationAdmissionGatePort = {
			async revalidate() {
				return {
					ok: false,
					error: { code: "external_unavailable", message: "fixture gate", retryable: false },
				};
			},
		};
		const runtime = new V3ManagedSessionRuntime(manager, mutationGate, onClosed);

		try {
			await expect(runtime.teardown("shutdown")).resolves.toMatchObject({
				ok: false,
				error: { code: "adapter_unavailable" },
			});
			expect(runtime.isClosed()).toBe(false);
			expect(onClosed).not.toHaveBeenCalled();

			await expect(runtime.teardown("shutdown")).resolves.toMatchObject({
				ok: false,
				error: { code: "adapter_unavailable" },
			});
			expect(close).toHaveBeenCalledTimes(2);
			expect(runtime.isClosed()).toBe(false);
			expect(onClosed).not.toHaveBeenCalled();
		} finally {
			close.mockRestore();
			await manager.closeAll();
		}
	});

	it("releases the replaced writer lease and fences the old Control Plane handle", async () => {
		const root = temporaryRoot();
		const { factory, registry } = setup(root);
		const first = await registry.start();
		if (!first.ok) throw new Error(first.error.message);
		const firstPath = factory.activeRuntime(first.value.sessionId)?.manager().filePath();
		if (!firstPath) throw new Error("first runtime was not registered");

		const second = await registry.start();
		expect(second).toMatchObject({ ok: true, value: { recovery: "new" } });
		expect(registry.validate(first.value.handle)).toMatchObject({
			ok: false,
			error: { code: "stale_session_handle" },
		});
		const reopened = await V3SessionManager.open(firstPath, FEATURES, IDENTITY);
		expect(reopened.recoveryDecision()).toMatchObject({ kind: "resume" });
		await reopened.closeAll();
		await registry.shutdown();
	});

	it("resumes a stable session and forks only the exact durable parent cursor", async () => {
		const root = temporaryRoot();
		const { factory, registry } = setup(root);
		const started = await registry.start();
		if (!started.ok) throw new Error(started.error.message);
		const parent = factory.activeRuntime(started.value.sessionId)?.manager();
		if (!parent) throw new Error("parent runtime missing");
		await parent.sessionEvents().recordMessage({ role: "user", content: [{ type: "text", text: "forked history" }] });
		const parentCursor = cursor(parent);
		const parentId = parent.sessionId();
		await registry.shutdown();

		const resumed = await registry.resume(parentId);
		expect(resumed).toMatchObject({ ok: true, value: { sessionId: parentId, recovery: "resumed" } });
		if (!resumed.ok) throw new Error(resumed.error.message);
		const resumedParent = factory.activeRuntime(parentId)?.manager();
		expect(await resumedParent?.replayMessages()).toEqual([
			{ role: "user", content: [{ type: "text", text: "forked history" }] },
		]);
		if (!resumedParent) throw new Error("resumed parent runtime missing");
		const lateReplay = vi.spyOn(resumedParent, "replayMessages")
			.mockRejectedValue(new Error("fork must use the admitted canonical snapshot"));

		const forked = await registry.fork(parentId, parentCursor, "continue_existing_goal");
		expect(lateReplay).not.toHaveBeenCalled();
		lateReplay.mockRestore();
		if (!forked.ok) throw new Error(`${forked.error.code}: ${forked.error.message}`);
		expect(forked).toMatchObject({ ok: true, value: { recovery: "forked" } });
		expect(forked.value.sessionId).not.toBe(parentId);
		const child = factory.activeRuntime(forked.value.sessionId)?.manager();
		expect(await child?.replayMessages()).toEqual([
			{ role: "user", content: [{ type: "text", text: "forked history" }] },
		]);

		const divergent = await factory.fork(
			parentId,
			{ ...parentCursor, eventHash: "0".repeat(64) },
			"continue_existing_goal",
		);
		expect(divergent).toMatchObject({ ok: false, error: { code: "cursor_mismatch" } });
		await registry.shutdown();
	});
});

describe("V3 event and query adapters", () => {
	function queryExecutor(
		factory: V3SessionRuntimeFactoryAdapter,
		handles: SessionHandleValidationPort,
		states: V3SessionControlStateAdapter,
	): V3QueryExecutorAdapter {
		return new V3QueryExecutorAdapter({
			sessions: factory,
			inspections: states,
			handles,
			artifacts: new V3ArtifactStoreQueryAdapter({
				authorize: async () => ({ ok: true, value: undefined }),
			}),
			operationalQueries: {
				execute: async (query) => query.type === "health"
					? {
							ok: true,
							value: {
								type: "health",
								status: "ok",
								protocolMajor: 1,
								protocolMinor: 0,
								uptimeMs: 1,
								shuttingDown: false,
							},
						}
					: {
							ok: false,
							error: { code: "adapter_unavailable", message: "activity not injected", retryable: false },
							effect: "none",
						},
			},
		});
	}

	function activityQuery(
		sessionId: ReturnType<V3SessionManager["sessionId"]>,
		sessionHandle: ActivityGetQuery["payload"]["sessionHandle"],
	): ActivityGetQuery {
		return {
			kind: "query",
			type: "activity:get",
			queryId: "activity-consistency",
			authorityId: AUTHORITY_ID,
			tenantId: TENANT_ID,
			principalId: PRINCIPAL_ID,
			payload: { sessionId, sessionHandle },
		};
	}

	it("uses one RuntimeActivity event projector and digest across replay, telemetry, daemon, and query validation", async () => {
		const root = temporaryRoot();
		const { factory, registry, handles, states } = setup(root);
		const started = await registry.start();
		if (!started.ok) throw new Error(started.error.message);
		const manager = factory.activeRuntime(started.value.sessionId)?.manager();
		if (!manager) throw new Error("active runtime missing");
		await manager.sessionEvents().beginTurn();

		const executor = queryExecutor(factory, handles, states);
		const query = activityQuery(manager.sessionId(), started.value.handle);
		const daemonResult = await executor.execute(query, context());
		expect(daemonResult).toMatchObject({ ok: true, value: { type: "activity:get", state: "running" } });
		if (!daemonResult.ok || daemonResult.value.type !== "activity:get" || !daemonResult.value.snapshot) {
			throw new Error("daemon activity projection failed");
		}

		const replay = await readAllRuntimeEvents(manager.eventStore());
		if (!replay.ok) throw new Error(replay.error.message);
		const direct = projectRuntimeActivityEvents(replay.value);
		const telemetry = projectRuntimeActivityFromCanonicalEvents(replay.value);
		expect(direct).toMatchObject({ ok: true });
		expect(telemetry).toMatchObject({ ok: true });
		if (!direct.ok || !telemetry.ok) throw new Error("canonical activity replay failed");
		expect(telemetry.value).toEqual(direct.value);
		expect(daemonResult.value.snapshot).toEqual(direct.value);
		expect(daemonResult.value.snapshot.projectionDigest).toBe(direct.value.projectionDigest);
		expect(direct.value.projectionDigest).toBe(canonicalDigest(runtimeActivityProjectionBody(direct.value)));

		const service = new ControlPlaneQueryService({ executor, handles });
		const validated = await service.execute(query, context());
		expect(validated).toMatchObject({
			ok: true,
			value: {
				result: {
					type: "activity:get",
					snapshot: { projectionDigest: direct.value.projectionDigest },
				},
			},
		});
		await registry.shutdown();
	});

	it.each([
		["committed", "committed", "none"],
		["none", "none", "none"],
		["uncertain", "uncertain", "uncertain"],
		["absent", undefined, "uncertain"],
	] as const)("maps a %s session flush failure through the query effect table", async (_label, storeEffect, expectedEffect) => {
		const root = temporaryRoot();
		const { factory, registry, handles, states } = setup(root);
		const started = await registry.start();
		if (!started.ok) throw new Error(started.error.message);
		const manager = factory.activeRuntime(started.value.sessionId)?.manager();
		if (!manager) throw new Error("active runtime missing");
		vi.spyOn(manager.writer(), "flush").mockResolvedValueOnce({
			ok: false,
			error: {
				code: "durable_write_failed",
				message: "injected activity barrier failure",
				retryable: false,
				...(storeEffect === undefined ? {} : { effect: storeEffect }),
			},
		});

		const result = await queryExecutor(factory, handles, states).execute(
			activityQuery(manager.sessionId(), started.value.handle),
			context(),
		);
		expect(result).toMatchObject({
			ok: false,
			error: { code: "recovery_required", details: { storeEffect: storeEffect ?? "unspecified" } },
			effect: expectedEffect,
		});
		await registry.shutdown();
	});

	it("replays from an exact cursor and keeps a captured stream on the old runtime generation", async () => {
		const root = temporaryRoot();
		const { factory, registry } = setup(root);
		const started = await registry.start();
		if (!started.ok) throw new Error(started.error.message);
		const manager = factory.activeRuntime(started.value.sessionId)?.manager();
		if (!manager) throw new Error("active runtime missing");
		await manager.sessionEvents().recordMessage({ role: "user", content: [{ type: "text", text: "one" }] });
		const stable = cursor(manager);
		await manager.sessionEvents().recordMessage({ role: "assistant", content: [{ type: "text", text: "two" }], api: "openai-completions", provider: "fixture", model: "fixture", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 0 });
		const replayFlush = await manager.writer().flush();
		if (!replayFlush.ok) throw new Error(replayFlush.error.message);
		const request: EventSubscriptionRequest = {
			kind: "subscription",
			type: "events:subscribe",
			subscriptionId: "v3-events",
			authorityId: AUTHORITY_ID,
			tenantId: TENANT_ID,
			principalId: PRINCIPAL_ID,
			sessionId: manager.sessionId(),
			sessionHandle: started.value.handle,
			fromCursor: stable,
			bufferCapacity: 8,
		};
		const subscription = new BoundedEventSubscription(
			request,
			new V3EventSubscriptionSourceAdapter(factory),
		);
		await expect(subscription.next()).resolves.toMatchObject({ value: { sequence: stable.sequence, delivery: "replay" } });
		await expect(subscription.next()).resolves.toMatchObject({ value: { sequence: stable.sequence + 1, delivery: "replay" } });
		await manager.sessionEvents().recordMessage({ role: "user", content: [{ type: "text", text: "three" }] });
		const liveFlush = await manager.writer().flush();
		if (!liveFlush.ok) throw new Error(liveFlush.error.message);
		await expect(subscription.next()).resolves.toMatchObject({ value: { sequence: stable.sequence + 2, delivery: "live" } });

		const replacement = await registry.start();
		expect(replacement.ok).toBe(true);
		await expect(subscription.next()).resolves.toEqual({ done: true, value: undefined });
		expect(registry.validate(started.value.handle)).toMatchObject({ ok: false, error: { code: "stale_session_handle" } });
		await registry.shutdown();
	});

	it("serves authorized committed artifact metadata/content and rejects stale scope, digest, and byte bounds", async () => {
		const root = temporaryRoot();
		const { factory, registry, handles, states } = setup(root);
		const started = await registry.start();
		if (!started.ok) throw new Error(started.error.message);
		const manager = factory.activeRuntime(started.value.sessionId)?.manager();
		if (!manager) throw new Error("active runtime missing");
		const artifactId = createRuntimeId("artifact", "control-query");
		const written = await manager.artifactRepository().write({
			authorityId: AUTHORITY_ID,
			tenantId: TENANT_ID,
			artifactId,
			intentId: createRuntimeId("command", "control-query"),
			principalId: PRINCIPAL_ID,
			source: { sessionId: manager.sessionId(), producerId: PRINCIPAL_ID },
			kind: "tool_output",
			mediaType: "text/plain",
			content: "bounded artifact",
		});
		expect(written).toMatchObject({ ok: true, value: { state: "committed" } });
		if (!written.ok || written.value.state !== "committed") throw new Error("artifact fixture did not commit");
		const authorize = vi.fn(async () => ({ ok: true as const, value: undefined }));
		const executor = new V3QueryExecutorAdapter({
			sessions: factory,
			inspections: states,
			handles,
			artifacts: new V3ArtifactStoreQueryAdapter({ authorize }),
			operationalQueries: {
				execute: async (query) => query.type === "health"
					? {
							ok: true,
							value: { type: "health", status: "ok", protocolMajor: 1, protocolMinor: 0, uptimeMs: 1, shuttingDown: false },
						}
					: { ok: false, error: { code: "adapter_unavailable", message: "activity not injected", retryable: false }, effect: "none" },
			},
		});
		const base = {
			kind: "query" as const,
			authorityId: AUTHORITY_ID,
			tenantId: TENANT_ID,
			principalId: PRINCIPAL_ID,
		};
		const metadataQuery: ArtifactMetadataQuery = {
			...base,
			type: "artifact:metadata",
			queryId: "artifact-metadata",
			payload: { sessionId: manager.sessionId(), sessionHandle: started.value.handle, artifactId },
		};
		await expect(executor.execute(metadataQuery, context())).resolves.toMatchObject({
			ok: true,
			value: { type: "artifact:metadata", artifactId, storedSize: 16, redaction: "redacted" },
		});
		const readQuery: ArtifactReadQuery = {
			...base,
			type: "artifact:read",
			queryId: "artifact-read",
			payload: {
				sessionId: manager.sessionId(),
				sessionHandle: started.value.handle,
				artifactId,
				expectedDigest: written.value.metadata.storedDigest,
				maxBytes: 16,
			},
		};
		const read = await executor.execute(readQuery, context());
		expect(read).toMatchObject({ ok: true, value: { type: "artifact:read", byteLength: 16 } });
		if (!read.ok || read.value.type !== "artifact:read") throw new Error("artifact read failed");
		expect(Buffer.from(read.value.content, "base64").toString("utf8")).toBe("bounded artifact");
		expect(authorize).toHaveBeenCalledTimes(2);

		await expect(executor.execute({
			...readQuery,
			queryId: "wrong-digest",
			payload: { ...readQuery.payload, expectedDigest: "f".repeat(64) },
		}, context())).resolves.toMatchObject({ ok: false, error: { code: "recovery_required" } });
		await expect(executor.execute({
			...readQuery,
			queryId: "too-small",
			payload: { ...readQuery.payload, maxBytes: 15 },
		}, context())).resolves.toMatchObject({ ok: false, error: { code: "recovery_required" } });
		const wrongTenant = createRuntimeId("tenant", "wrong");
		await expect(executor.execute({ ...metadataQuery, tenantId: wrongTenant }, context())).resolves.toMatchObject({
			ok: false,
			error: { code: "unauthorized_peer" },
		});

		const inspected = await executor.execute({
			...base,
			type: "session:inspect",
			queryId: "inspect-active",
			payload: { sessionId: manager.sessionId(), sessionHandle: started.value.handle },
		}, context());
		expect(inspected).toMatchObject({ ok: true, value: { type: "session:inspect", lifecycle: "active" } });
		await registry.shutdown();
		await expect(executor.execute(metadataQuery, context())).resolves.toMatchObject({
			ok: false,
			error: { code: "session_replacing" },
		});
	});
});

describe("V3 daemon recovery adapter", () => {
	it("restores projections without replaying side effects and keeps paused/corrupted sessions fail closed", async () => {
		const root = temporaryRoot();
		const { sessionDir, factory, registry, evidence } = setup(root);
		const paused = await registry.start();
		if (!paused.ok) throw new Error(paused.error.message);
		const pausedManager = factory.activeRuntime(paused.value.sessionId)?.manager();
		if (!pausedManager) throw new Error("paused fixture runtime missing");
		await pausedManager.sessionEvents().beginTurn();
		const pausedId = pausedManager.sessionId();
		await registry.shutdown();
		expect(await factory.resume(pausedId)).toMatchObject({
			ok: false,
			error: { code: "recovery_required", details: { recoveryState: "pause_for_approval" } },
		});

		const corrupt = await V3SessionManager.create({ cwd: root, sessionDir, features: FEATURES, identity: IDENTITY });
		await corrupt.sessionEvents().recordMessage({ role: "user", content: [{ type: "text", text: "tamper target" }] });
		const corruptId = corrupt.sessionId();
		const corruptPath = corrupt.filePath();
		await corrupt.closeAll();
		const lines = (await readFile(corruptPath, "utf8")).trimEnd().split("\n");
		const second = JSON.parse(lines[1] ?? "null") as Record<string, unknown>;
		second.currentEventHash = "0".repeat(64);
		lines[1] = JSON.stringify(second);
		await writeFile(corruptPath, `${lines.join("\n")}\n`, "utf8");

		const activate = vi.fn(async () => ({ ok: true as const, value: undefined }));
		const recovery = new V3DaemonRuntimeRecoveryPortAdapter({ evidence, activation: { activate } });
		const discovered = await recovery.discover();
		expect(discovered).toMatchObject({
			ok: true,
			value: expect.arrayContaining([
				expect.objectContaining({ sessionId: pausedId, state: "pause_for_approval" }),
				expect.objectContaining({ sessionId: corruptId, state: "corrupted" }),
			]),
		});
		if (!discovered.ok) throw new Error(discovered.error.message);
		const pausedDescriptor = discovered.value.find((entry) => entry.sessionId === pausedId);
		const corruptDescriptor = discovered.value.find((entry) => entry.sessionId === corruptId);
		if (!pausedDescriptor || !corruptDescriptor) throw new Error("recovery fixtures were not discovered");
		await expect(recovery.restoreProjection(pausedDescriptor, "active_candidate")).resolves.toMatchObject({
			ok: false,
			error: { code: "recovery_required" },
		});
		const restoredPaused = await recovery.restoreProjection(pausedDescriptor, "paused");
		expect(restoredPaused).toMatchObject({ ok: true, value: { sessionId: pausedId, mode: "paused" } });
		if (!restoredPaused.ok) throw new Error(restoredPaused.error.message);
		await expect(recovery.activate(restoredPaused.value)).resolves.toMatchObject({
			ok: false,
			error: { code: "recovery_required" },
		});
		await expect(recovery.restoreProjection(corruptDescriptor, "read_only")).resolves.toMatchObject({
			ok: true,
			value: { sessionId: corruptId, mode: "read_only" },
		});
		expect(activate).not.toHaveBeenCalled();
	});
});
