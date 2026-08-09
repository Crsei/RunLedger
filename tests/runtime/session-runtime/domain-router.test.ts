import { afterEach, describe, expect, it } from "vitest";
import { createRuntimeHarness, type RuntimeHarness } from "./harness.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/ids.ts";

let harness: RuntimeHarness | undefined;

afterEach(async () => {
	if (harness === undefined) return;
	await harness.server.close();
	harness.store.database().close();
	harness.cleanup();
	harness = undefined;
});

describe("S1 Session Domain Router", () => {
	it("rejects malformed correlation/effect envelopes before reading the catalog", async () => {
		harness = await createRuntimeHarness("domain-invalid-envelope");
		const result = await harness.runtime.handleQuery({
			kind: "domain_query",
			body: {
				sessionId: harness.sessionId,
				generation: harness.fence.generation,
				correlationId: "",
				effectId: "effect_valid",
				operation: "session.catalog.list",
				payload: {},
			},
		});
		expect(result).toEqual({ ok: false, status: "failed", code: "invalid_domain_envelope", operation: "session.catalog.list" });
	});

	it("rejects an invalid expected revision before attempts or catalog mutation", async () => {
		harness = await createRuntimeHarness("domain-invalid-revision");
		const result = await harness.runtime.handleCommand({
			commandId: createRuntimeId("command", "domain-invalid-revision"),
			kind: "domain_command",
			body: {
				sessionId: harness.sessionId,
				generation: harness.fence.generation,
				correlationId: "correlation_valid",
				effectId: "effect_valid",
				operation: "session.create",
				expectedRevision: -1,
				payload: {},
			},
		}, {
			connectionId: createRuntimeId("connection", "domain-invalid-revision"),
			clientId: "client_domain_invalid_revision",
			isDriver: true,
		});
		expect(result).toMatchObject({ ok: true, result: { ok: false, status: "failed", code: "invalid_expected_revision" } });
		expect(harness.store.listAllAttemptReceipts(harness.sessionId)).toHaveLength(0);
		expect(harness.store.listSessions()).toHaveLength(1);
	});

	it("returns a typed unavailable result for an unregistered operation", async () => {
		harness = await createRuntimeHarness("domain-unavailable");
		const result = await harness.runtime.handleQuery({
			kind: "domain_query",
			body: {
				sessionId: harness.sessionId,
				generation: harness.fence.generation,
				correlationId: "correlation_domain_unavailable",
				effectId: "effect_domain_unavailable",
				operation: "plan.inspect",
				payload: {},
			},
		});

		expect(result).toEqual({
			ok: false,
			status: "unavailable",
			code: "operation_unavailable",
			operation: "plan.inspect",
		});
	});

	it("rejects a stale generation before operation lookup", async () => {
		harness = await createRuntimeHarness("domain-stale-generation");
		const result = await harness.runtime.handleQuery({
			kind: "domain_query",
			body: {
				sessionId: harness.sessionId,
				generation: harness.fence.generation + 1,
				correlationId: "correlation_domain_stale",
				effectId: "effect_domain_stale",
				operation: "session.catalog.list",
				payload: {},
			},
		});

		expect(result).toEqual({
			ok: false,
			status: "stale",
			code: "generation_mismatch",
			operation: "session.catalog.list",
		});
	});

	it("publishes and serves the canonical SQLite session catalog without path or invented metadata", async () => {
		harness = await createRuntimeHarness("domain-catalog-list");
		const secondId = createRuntimeId("session", "catalog-second");
		harness.store.createSession({
			sessionId: secondId,
			workspaceId: createRuntimeId("workspace", "catalog-w"),
			repositoryId: createRuntimeId("repository", "catalog-r"),
			settingsDigest: "e".repeat(64),
			worktreeLocator: JSON.stringify({ root: "/private/worktree" }),
		});

		expect(harness.runtime.protocolManifest().operationManifest).toEqual(expect.arrayContaining([
			expect.objectContaining({ operation: "session.catalog.list", access: "read" }),
		]));
		const result = await harness.runtime.handleQuery({
			kind: "domain_query",
			body: {
				sessionId: harness.sessionId,
				generation: harness.fence.generation,
				correlationId: "correlation_catalog_list",
				effectId: "effect_catalog_list",
				operation: "session.catalog.list",
				payload: {},
			},
		});

		expect(result).toMatchObject({
			ok: true,
			status: "ok",
			operation: "session.catalog.list",
			domainRevision: 2,
			value: {
				items: expect.arrayContaining([
					expect.objectContaining({
						sessionId: secondId,
						workspaceId: createRuntimeId("workspace", "catalog-w"),
						repositoryId: createRuntimeId("repository", "catalog-r"),
						status: "active",
						headSequence: 0,
						driverRevision: 0,
						current: false,
					}),
					]),
			},
		});
		expect(JSON.stringify(result)).not.toContain("/private/worktree");
		expect(JSON.stringify(result)).not.toContain("settingsDigest");
		expect(JSON.stringify(result)).not.toContain("title");
	});

	it("rejects a stale catalog mutation before creating a session or recording an attempt", async () => {
		harness = await createRuntimeHarness("domain-create-stale");
		const result = await harness.runtime.handleCommand({
			commandId: createRuntimeId("command", "catalog-create-stale"),
			kind: "domain_command",
			body: {
				sessionId: harness.sessionId,
				generation: harness.fence.generation,
				correlationId: "correlation_catalog_create_stale",
				effectId: "effect_catalog_create_stale",
				operation: "session.create",
				expectedRevision: 0,
				payload: {},
			},
		}, {
			connectionId: createRuntimeId("connection", "catalog-create-driver"),
			clientId: "client_catalog_create_driver",
			isDriver: true,
		});

		expect(result).toMatchObject({
			ok: true,
			kind: "domain_command",
			result: {
				ok: false,
				status: "stale",
				code: "domain_revision_conflict",
				operation: "session.create",
				currentRevision: 1,
			},
		});
		expect(harness.store.listSessions()).toHaveLength(1);
		expect(harness.store.listAllAttemptReceipts(harness.sessionId)).toHaveLength(0);
	});

	it("creates a session through the recovery barrier and settles an append-only attempt receipt", async () => {
		harness = await createRuntimeHarness("domain-create-success");
		const result = await harness.runtime.handleCommand({
			commandId: createRuntimeId("command", "catalog-create-success"),
			kind: "domain_command",
			body: {
				sessionId: harness.sessionId,
				generation: harness.fence.generation,
				correlationId: "correlation_catalog_create_success",
				effectId: "effect_catalog_create_success",
				operation: "session.create",
				expectedRevision: 1,
				payload: {},
			},
		}, {
			connectionId: createRuntimeId("connection", "catalog-create-success-driver"),
			clientId: "client_catalog_create_success_driver",
			isDriver: true,
		});

		expect(result).toMatchObject({
			ok: true,
			kind: "domain_command",
			result: {
				ok: true,
				status: "ok",
				operation: "session.create",
				domainRevision: 2,
				value: { targetSessionId: expect.stringMatching(/^session_/u) },
				receipt: {
					attemptId: expect.stringMatching(/^attempt_/u),
					commandId: expect.stringMatching(/^command_/u),
					outcome: "committed",
				},
			},
		});
		expect(harness.store.listSessions()).toHaveLength(2);
		expect(harness.store.listAllAttemptReceipts(harness.sessionId).map((receipt) => receipt.outcome)).toEqual([
			"started",
			"committed",
		]);
	});

	it("returns recovery_required without spawning a catalog mutation while the barrier is open", async () => {
		harness = await createRuntimeHarness("domain-create-recovery", { crashTakeover: true });
		const result = await harness.runtime.handleCommand({
			commandId: createRuntimeId("command", "catalog-create-recovery"),
			kind: "domain_command",
			body: {
				sessionId: harness.sessionId,
				generation: harness.fence.generation,
				correlationId: "correlation_catalog_create_recovery",
				effectId: "effect_catalog_create_recovery",
				operation: "session.create",
				expectedRevision: 1,
				payload: {},
			},
		}, {
			connectionId: createRuntimeId("connection", "catalog-create-recovery-driver"),
			clientId: "client_catalog_create_recovery_driver",
			isDriver: true,
		});

		expect(result).toMatchObject({
			ok: true,
			result: {
				ok: false,
				status: "recovery_required",
				code: "recovery_barrier_active",
				operation: "session.create",
				currentRevision: 1,
			},
		});
		expect(harness.runtime.sideEffectSpawnCount).toBe(0);
		expect(harness.store.listSessions()).toHaveLength(1);
		expect(harness.store.listAllAttemptReceipts(harness.sessionId)).toHaveLength(0);
	});

	it("validates a resumable SQLite target without changing catalog state", async () => {
		harness = await createRuntimeHarness("domain-resume-target");
		const targetSessionId = createRuntimeId("session", "resume-target");
		harness.store.createSession({
			sessionId: targetSessionId,
			workspaceId: createRuntimeId("workspace", "resume-w"),
			repositoryId: createRuntimeId("repository", "resume-r"),
			settingsDigest: "f".repeat(64),
			status: "paused",
		});
		const result = await harness.runtime.handleCommand({
			commandId: createRuntimeId("command", "catalog-resume"),
			kind: "domain_command",
			body: {
				sessionId: harness.sessionId,
				generation: harness.fence.generation,
				correlationId: "correlation_catalog_resume",
				effectId: "effect_catalog_resume",
				operation: "session.resume",
				expectedRevision: 2,
				payload: { targetSessionId },
			},
		}, {
			connectionId: createRuntimeId("connection", "catalog-resume-driver"),
			clientId: "client_catalog_resume_driver",
			isDriver: true,
		});

		expect(result).toMatchObject({
			ok: true,
			result: {
				ok: true,
				status: "ok",
				operation: "session.resume",
				domainRevision: 2,
				value: { targetSessionId },
			},
		});
		expect(harness.store.listSessions()).toHaveLength(2);
		expect(harness.store.listAllAttemptReceipts(harness.sessionId)).toHaveLength(0);
	});

	it("rejects a fork intent whose source head is stale before recording an attempt", async () => {
		harness = await createRuntimeHarness("domain-fork-stale");
		const source = harness.store.getSession(harness.sessionId);
		if (source === undefined || source.headSequence < 1) throw new Error("expected durable owner events");
		const result = await harness.runtime.handleCommand({
			commandId: createRuntimeId("command", "catalog-fork-stale"),
			kind: "domain_command",
			body: {
				sessionId: harness.sessionId,
				generation: harness.fence.generation,
				correlationId: "correlation_catalog_fork_stale",
				effectId: "effect_catalog_fork_stale",
				operation: "session.fork",
				expectedRevision: 1,
				payload: {
					sourceSessionId: harness.sessionId,
					expectedSourceHeadSequence: source.headSequence - 1,
				},
			},
		}, {
			connectionId: createRuntimeId("connection", "catalog-fork-stale-driver"),
			clientId: "client_catalog_fork_stale_driver",
			isDriver: true,
		});

		expect(result).toMatchObject({
			ok: true,
			result: {
				ok: false,
				status: "stale",
				code: "fork_source_head_conflict",
				operation: "session.fork",
				currentRevision: source.headSequence,
			},
		});
		expect(harness.store.listSessions()).toHaveLength(1);
		expect(harness.store.listAllAttemptReceipts(harness.sessionId)).toHaveLength(0);
	});

	it("forks the exact durable source head and returns the independent target", async () => {
		harness = await createRuntimeHarness("domain-fork-success");
		const source = harness.store.getSession(harness.sessionId);
		if (source === undefined) throw new Error("source missing");
		const result = await harness.runtime.handleCommand({
			commandId: createRuntimeId("command", "catalog-fork-success"),
			kind: "domain_command",
			body: {
				sessionId: harness.sessionId,
				generation: harness.fence.generation,
				correlationId: "correlation_catalog_fork_success",
				effectId: "effect_catalog_fork_success",
				operation: "session.fork",
				expectedRevision: 1,
				payload: {
					sourceSessionId: harness.sessionId,
					expectedSourceHeadSequence: source.headSequence,
				},
			},
		}, {
			connectionId: createRuntimeId("connection", "catalog-fork-success-driver"),
			clientId: "client_catalog_fork_success_driver",
			isDriver: true,
		});

		expect(result).toMatchObject({
			ok: true,
			result: {
				ok: true,
				status: "ok",
				operation: "session.fork",
				domainRevision: 2,
				value: {
					targetSessionId: expect.stringMatching(/^session_/u),
					sourceSessionId: harness.sessionId,
					sourceHeadSequence: source.headSequence,
				},
				receipt: { outcome: "committed" },
			},
		});
		if (!result.ok || result.result.ok !== true) throw new Error("fork failed");
		const targetSessionId = String(result.result.value.targetSessionId);
		expect(harness.store.getSession(targetSessionId)?.headSequence).toBe(source.headSequence);
		expect(harness.store.listSessions()).toHaveLength(2);
		expect(harness.store.listAllAttemptReceipts(harness.sessionId).map((receipt) => receipt.outcome)).toEqual(["started", "committed"]);
	});
});
