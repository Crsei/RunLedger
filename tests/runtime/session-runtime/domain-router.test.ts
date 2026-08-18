import { afterEach, describe, expect, it } from "vitest";
import { createRuntimeHarness, type RuntimeHarness } from "./harness.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/ids.ts";
import { SessionDomainRouter } from "../../../src/runtime/session-runtime/domain-router.ts";
import type { SessionDomainPort } from "../../../src/runtime/session-runtime/session-runtime.ts";

let harness: RuntimeHarness | undefined;

afterEach(async () => {
	if (harness === undefined) return;
	await harness.server.close();
	harness.store.database().close();
	harness.cleanup();
	harness = undefined;
});

describe("S1 Session Domain Router", () => {
	it("does not advertise approval or security capabilities without a real domain authority", async () => {
		harness = await createRuntimeHarness("security-capability-absent");
		const manifest = harness.runtime.protocolManifest();
		expect(manifest.protocolCapabilities).not.toContain("session.approval.reverse");
		expect(manifest.protocolCapabilities).not.toContain("session.security.inspect");
		expect(manifest.operationManifest).not.toContainEqual(expect.objectContaining({ operation: "session.security.inspect" }));
	});

	it("advertises approval reverse and read-only security only for a real domain authority", async () => {
		const domain: SessionDomainPort = {
			controller: {
				subscribe: () => () => undefined,
			} as unknown as SessionDomainPort["controller"],
			protocolCapabilities: ["session.approval.reverse", "session.security.inspect"],
			securityInspection: () => ({ profile: "workspace-write" }),
			snapshot: () => ({
				messages: [],
				warnings: [],
				auditEntries: [],
				selection: { thinkingLevel: "off" },
				toolCount: 0,
				inFlight: false,
				providerStatuses: [],
			}),
		};
		harness = await createRuntimeHarness("security-capability-present", { domain });
		const manifest = harness.runtime.protocolManifest();
		expect(manifest.protocolCapabilities).toEqual(expect.arrayContaining([
			"session.approval.reverse",
			"session.security.inspect",
		]));
		expect(manifest.operationManifest).toContainEqual({
			operation: "session.security.inspect",
			capability: "session.security.inspect",
			access: "read",
		});
		expect(manifest.operationManifest.some((entry) => entry.capability === "session.security.inspect" && entry.access === "mutate")).toBe(false);
	});

	it("publishes only the read-only Session security inspection supplied by real domain composition", () => {
		const calls: string[] = [];
		const router = new SessionDomainRouter(
			createRuntimeId("session", "security-inspect"),
			7,
			{
				listSessions: () => [],
			} as unknown as RuntimeHarness["store"],
			{
				beginAttempt: () => ({ error: "recovery_barrier_active" as const }),
				settleAttempt: () => ({ ok: false as const, code: "not_used" }),
			},
			{
				securityInspection: () => {
					calls.push("inspect");
					return {
						profile: "workspace-write",
						approvalPolicy: "on-request",
						filesystemMode: "workspace-write",
						networkMode: "deny",
						sandboxMode: "workspace-write",
						policyDigest: { algorithm: "sha256", digest: "a".repeat(64) },
						sourceCount: 2,
					};
				},
			},
		);

		expect(router.operationManifest).toContainEqual({
			operation: "session.security.inspect",
			capability: "session.security.inspect",
			access: "read",
		});
		expect(router.operationManifest.some((entry) => entry.operation.includes("security") && entry.access === "mutate")).toBe(false);
		expect(router.query({
			sessionId: createRuntimeId("session", "security-inspect"),
			generation: 7,
			correlationId: "correlation_security_inspect",
			effectId: "effect_security_inspect",
			operation: "session.security.inspect",
			payload: {},
		})).toMatchObject({
			ok: true,
			status: "ok",
			operation: "session.security.inspect",
			value: {
				profile: "workspace-write",
				approvalPolicy: "on-request",
				sourceCount: 2,
			},
		});
		expect(calls).toEqual(["inspect"]);
	});

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

	it("refuses session.title.set from an observer before opening an attempt", async () => {
		const domain: SessionDomainPort = {
			controller: { subscribe: () => () => undefined } as unknown as SessionDomainPort["controller"],
			snapshot: () => ({
				messages: [],
				warnings: [],
				auditEntries: [],
				selection: { thinkingLevel: "off" },
				toolCount: 0,
				inFlight: false,
				providerStatuses: [],
			}),
		};
		harness = await createRuntimeHarness("title-observer", { domain });
		const result = await harness.runtime.handleCommand({
			commandId: createRuntimeId("command", "title-observer"),
			kind: "domain_command",
			body: {
				sessionId: harness.sessionId,
				generation: harness.fence.generation,
				correlationId: "correlation_title_observer",
				effectId: "effect_title_observer",
				operation: "session.title.set",
				expectedRevision: 1,
				payload: { title: "Observer must not rename", source: "user" },
			},
		}, {
			connectionId: createRuntimeId("connection", "title-observer"),
			clientId: "client_title_observer",
			isDriver: false,
		});

		expect(result).toEqual({ ok: false, code: "observer_mutation_forbidden" });
		expect(harness.store.getSession(harness.sessionId)?.title).toBeUndefined();
		expect(harness.store.listAllAttemptReceipts(harness.sessionId)).toHaveLength(0);
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

	it("broadcasts one session.title_changed event after a committed title mutation", async () => {
		const domain: SessionDomainPort = {
			controller: { subscribe: () => () => undefined } as unknown as SessionDomainPort["controller"],
			snapshot: () => ({
				messages: [],
				warnings: [],
				auditEntries: [],
				selection: { thinkingLevel: "off" },
				toolCount: 0,
				inFlight: false,
				providerStatuses: [],
			}),
		};
		harness = await createRuntimeHarness("title-broadcast", { domain });
		const events: Array<{ readonly eventType: string; readonly payload: Record<string, unknown> }> = [];
		const unsubscribe = harness.runtime.onEvent((event) => events.push(event));
		try {
			const result = await harness.runtime.handleCommand({
				commandId: createRuntimeId("command", "title-broadcast"),
				kind: "domain_command",
				body: {
					sessionId: harness.sessionId,
					generation: harness.fence.generation,
					correlationId: "correlation_title_broadcast",
					effectId: "effect_title_broadcast",
					operation: "session.title.set",
					expectedRevision: 1,
					payload: { title: "Fix login flow", source: "user" },
				},
			}, {
				connectionId: createRuntimeId("connection", "title-broadcast"),
				clientId: "client_title_broadcast",
				isDriver: true,
			});
			expect(result).toMatchObject({ ok: true, kind: "domain_command", result: { ok: true, operation: "session.title.set" } });
			const titleEvents = events.filter((event) => event.eventType === "session.title_changed");
			expect(titleEvents).toHaveLength(1);
			expect(titleEvents[0]).toMatchObject({
				eventType: "session.title_changed",
				payload: expect.objectContaining({ title: "Fix login flow", source: "user" }),
				sequence: expect.any(Number),
			});
		} finally {
			unsubscribe();
		}
	});

	it("advances the catalog revision for title writes and rejects a stale rename", async () => {
		const domain: SessionDomainPort = {
			controller: { subscribe: () => () => undefined } as unknown as SessionDomainPort["controller"],
			snapshot: () => ({
				messages: [],
				warnings: [],
				auditEntries: [],
				selection: { thinkingLevel: "off" },
				toolCount: 0,
				inFlight: false,
				providerStatuses: [],
			}),
		};
		harness = await createRuntimeHarness("title-revision", { domain });
		const first = await harness.runtime.handleCommand({
			commandId: createRuntimeId("command", "title-revision-first"),
			kind: "domain_command",
			body: {
				sessionId: harness.sessionId,
				generation: harness.fence.generation,
				correlationId: "correlation_title_revision_first",
				effectId: "effect_title_revision_first",
				operation: "session.title.set",
				expectedRevision: 1,
				payload: { title: "First durable title", source: "user" },
			},
		}, {
			connectionId: createRuntimeId("connection", "title-revision-first"),
			clientId: "client_title_revision_first",
			isDriver: true,
		});
		expect(first).toMatchObject({ ok: true, result: { ok: true, domainRevision: 2 } });

		const stale = await harness.runtime.handleCommand({
			commandId: createRuntimeId("command", "title-revision-stale"),
			kind: "domain_command",
			body: {
				sessionId: harness.sessionId,
				generation: harness.fence.generation,
				correlationId: "correlation_title_revision_stale",
				effectId: "effect_title_revision_stale",
				operation: "session.title.set",
				expectedRevision: 1,
				payload: { title: "Stale durable title", source: "user" },
			},
		}, {
			connectionId: createRuntimeId("connection", "title-revision-stale"),
			clientId: "client_title_revision_stale",
			isDriver: true,
		});
		expect(stale).toMatchObject({
			ok: true,
			result: {
				ok: false,
				status: "stale",
				code: "domain_revision_conflict",
				currentRevision: 2,
			},
		});
		expect(harness.store.getSession(harness.sessionId)?.title).toBe("First durable title");
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
