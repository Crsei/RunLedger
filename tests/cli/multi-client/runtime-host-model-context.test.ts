import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildRunledgerLayout } from "../../../src/runtime/contracts/storage-layout.ts";
import { runtimeDigest } from "../../../src/runtime/protocol/foundation.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/ids.ts";
import type { HostRuntimeDomainContext, HostRuntimeDomainPort } from "../../../src/cli/runtime-host-service.ts";
import { createHostModelContextDomainPort } from "../../../src/cli/runtime-host-model-context.ts";
import { SettingsResolver } from "../../../src/storage/settings-resolver.ts";

const timestamp = "2026-08-05T00:00:00.000Z";

function context(
	operation: string,
	body: Record<string, unknown>,
	domainRevision: number,
	mutation = true,
): HostRuntimeDomainContext {
	return {
		principal: {
			principalId: createRuntimeId("principal", "model-context-test"),
			connectionId: createRuntimeId("connection", "model-context-test"),
			attestationDigest: runtimeDigest("model-context-attestation"),
		},
		frame: {
			frameId: `model-context-${operation}-${domainRevision}`,
			kind: "command_request",
			protocolVersion: 1,
			body: { operation, sessionId: createRuntimeId("session", "model-context-test"), ...body },
		},
		operation,
		mutation,
		sessionId: createRuntimeId("session", "model-context-test"),
		controller: {} as HostRuntimeDomainContext["controller"],
		hostGeneration: 3,
		sessionGeneration: 2,
		driverRevision: 7,
		domainRevision,
	};
}

function value<T extends Record<string, unknown>>(result: Awaited<ReturnType<HostRuntimeDomainPort["execute"]>>): T {
	if (!result.ok || result.body === undefined) throw new Error(JSON.stringify(result));
	return result.body as T;
}

describe("Host model/context domain", () => {
	it("owns durable Plan Mode lifecycle and replays the approved revision", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-host-model-context-plan-"));
		const layout = buildRunledgerLayout(root, "posix");
		const domain = createHostModelContextDomainPort({
			layout,
			workspaceStorageKey: `ws-${"a".repeat(64)}`,
			authorityId: createRuntimeId("authority", "model-context-test"),
			tenantId: createRuntimeId("tenant", "model-context-test"),
			workspaceId: createRuntimeId("workspace", "model-context-test"),
			policyCeilingDigest: runtimeDigest("plan-policy-ceiling"),
			clock: () => new Date(timestamp),
		});
		try {
			const entered = await domain.execute(context("plan.enter", { requestedBy: "user", expectedRevision: 0 }, 0));
			expect(value<{ state: { status: string; revision: number } }>(entered).state).toMatchObject({ status: "pending", revision: 1 });
			const activated = await domain.execute(context("plan.activate", { expectedRevision: 1, content: "# Plan initial" }, 1));
			expect(value<{ state: { status: string; plan: { revision: number } } }>(activated).state).toMatchObject({ status: "active", plan: { revision: 0 } });
			const written = await domain.execute(context("plan.write", { expectedRevision: 2, expectedPlanRevision: 0, content: "# Plan revision one" }, 2));
			expect(value<{ state: { revision: number; plan: { revision: number } } }>(written).state).toMatchObject({ revision: 3, plan: { revision: 1 } });

			// internal 通道：agent 的 plan_write 工具在 active Plan Mode 下经
			// domain.internal 执行，带 Host-owned principal 与 durable receipt。
			const internalWrite = await domain.internal.command(createRuntimeId("session", "model-context-test"), "plan.write", {
				expectedRevision: 3,
				expectedPlanRevision: 1,
				content: "# internal plan revision",
			});
			expect(internalWrite.ok).toBe(true);
			if (internalWrite.ok) {
				const state = (internalWrite.body?.state ?? {}) as { revision?: number; plan?: { revision?: number } };
				expect(state.revision).toBeGreaterThan(3);
				expect(state.plan?.revision).toBeGreaterThan(1);
			}

			const requested = await domain.execute(context("plan.request_approval", {
				expectedRevision: 4,
				expectedPlanRevision: 2,
				expectedPlanDigest: runtimeDigest("# internal plan revision"),
			}, 4));
			const awaiting = value<{ state: { revision: number; approval: { approvalId: string } } }>(requested).state;
			expect(awaiting.approval.approvalId).toMatch(/^approval_/u);

			const resolved = await domain.execute(context("plan.resolve_approval", {
				expectedRevision: 5,
				decision: "approved",
				approvalId: awaiting.approval.approvalId,
			}, 5));
			expect(value<{ state: { status: string; approval: { status: string } } }>(resolved).state).toMatchObject({ status: "exit_pending", approval: { status: "approved" } });
			expect((resolved.events ?? []).map((event) => event.type)).toEqual(["plan.approved"]);

			const replayed = createHostModelContextDomainPort({
				layout,
				workspaceStorageKey: `ws-${"a".repeat(64)}`,
				authorityId: createRuntimeId("authority", "model-context-test"),
				tenantId: createRuntimeId("tenant", "model-context-test"),
				workspaceId: createRuntimeId("workspace", "model-context-test"),
				policyCeilingDigest: runtimeDigest("plan-policy-ceiling"),
				clock: () => new Date(timestamp),
			});
			const inspected = await replayed.execute(context("plan.inspect", {}, 0, false));
			expect(value<{ state: { status: string; revision: number } }>(inspected).state).toMatchObject({ status: "exit_pending", revision: 6 });
			expect((entered.events ?? []).map((event) => event.type)).toEqual(["plan.enter_requested"]);
			expect((activated.events ?? []).map((event) => event.type)).toEqual(["plan.entered"]);
			expect((written.events ?? []).map((event) => event.type)).toEqual(["artifact.created"]);
			expect((requested.events ?? []).map((event) => event.type)).toEqual(["plan.approval_requested"]);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("projects active Plan Mode and approved Memory into Host context sources", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-host-model-context-sources-"));
		const layout = buildRunledgerLayout(root, "posix");
		const workspaceId = createRuntimeId("workspace", "model-context-test");
		const domain = createHostModelContextDomainPort({
			layout,
			workspaceStorageKey: `ws-${"a".repeat(64)}`,
			authorityId: createRuntimeId("authority", "model-context-test"),
			tenantId: createRuntimeId("tenant", "model-context-test"),
			workspaceId,
			policyCeilingDigest: runtimeDigest("plan-policy-ceiling"),
			clock: () => new Date(timestamp),
		});
		const sessionId = createRuntimeId("session", "model-context-test");
		try {
			// 无 Plan Mode、无 memory 时只返回空 sources。
			expect(await domain.contextSources(sessionId)).toEqual([]);

			// 进入 Plan Mode 后产生 mode layer fragment。
			const entered = await domain.execute(context("plan.enter", { requestedBy: "user", expectedRevision: 0 }, 0));
			expect(value<{ state: { status: string } }>(entered).state.status).toBe("pending");
			const activated = await domain.execute(context("plan.activate", { expectedRevision: 1, content: "# Plan initial" }, 1));
			expect(value<{ state: { status: string } }>(activated).state.status).toBe("active");
			const planSources = await domain.contextSources(sessionId);
			expect(planSources.some((source) => source.layer === "mode" && source.key === "plan-mode")).toBe(true);
			expect(planSources.find((source) => source.layer === "mode")?.content).toContain("plan mode: active");

			// 批准一条 memory 后，带 query 调用可检索到 memory layer fragment。
			const proposed = await domain.execute(context("memory.propose", {
				scope: "workspace",
				title: "release process",
				content: "the release checklist requires sign-off",
				sourceKind: "user",
				sourceRef: { subjectKind: "content", digest: runtimeDigest("release"), mediaType: "text/plain", size: 7 },
				sourceDigest: runtimeDigest("release"),
			}, 2));
			const proposal = value<{ proposal: { proposalId: string } }>(proposed).proposal;
			const approval = await domain.execute(context("memory.approve", {
				proposalId: proposal.proposalId,
				approvalRef: { subjectKind: "receipt", digest: runtimeDigest("approval"), mediaType: "application/json", size: 0 },
			}, 3));
			expect(approval.ok).toBe(true);
			const memorySources = await domain.contextSources(sessionId, "release checklist");
			expect(memorySources.some((source) => source.layer === "memory")).toBe(true);
			expect(memorySources.find((source) => source.layer === "memory")?.content).toContain("release checklist");
			// 无命中 query 不产生 memory fragment。
			expect((await domain.contextSources(sessionId, "zzz-no-match-zzz")).some((source) => source.layer === "memory")).toBe(false);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("publishes approved Memory and completed manual compaction through the same domain", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-host-model-context-memory-"));
		const layout = buildRunledgerLayout(root, "posix");
		const domain = createHostModelContextDomainPort({
			layout,
			workspaceStorageKey: `ws-${"b".repeat(64)}`,
			authorityId: createRuntimeId("authority", "model-context-memory-test"),
			tenantId: createRuntimeId("tenant", "model-context-memory-test"),
			workspaceId: createRuntimeId("workspace", "model-context-memory-test"),
			policyCeilingDigest: runtimeDigest("memory-policy-ceiling"),
			clock: () => new Date(timestamp),
		});
		try {
			const sourceRef = { subjectKind: "content" as const, digest: runtimeDigest("source"), mediaType: "text/plain", size: 6 };
			const proposed = await domain.execute(context("memory.propose", {
				scope: "workspace",
				title: "release rule",
				content: "Always run the release check.",
				sourceKind: "user",
				sourceRef,
				sourceDigest: sourceRef.digest,
			}, 0));
			const proposal = value<{ proposal: { proposalId: string } }>(proposed).proposal;
			const approved = await domain.execute(context("memory.approve", {
				proposalId: proposal.proposalId,
				approvalRef: { subjectKind: "receipt", digest: runtimeDigest("memory-approval") },
			}, 1));
			expect(value<{ record: { trust: string } }>(approved).record.trust).toBe("approved");
			const memoryState = await domain.execute(context("memory.inspect", {}, 2, false));
			expect(value<{ memory: { generation: number; recordCount: number; proposalCount: number } }>(memoryState).memory).toEqual({ generation: 2, recordCount: 1, proposalCount: 1 });
			const searched = await domain.execute(context("memory.search", { scope: "workspace", query: "release" }, 2, false));
			expect(value<{ results: readonly { title: string }[] }>(searched).results).toMatchObject([{ title: "release rule" }]);

			// MEMORY.md projection 只含 approved record 且可重建。
			const projected = await domain.execute(context("memory.projection", {}, 2, false));
			const projection = value<{ text: string; digest: { digest: string }; recordCount: number }>(projected);
			expect(projection.recordCount).toBe(1);
			expect(projection.text).toContain("## release rule");
			expect(projection.text).not.toContain("proposed");
			expect(projection.digest.digest).toMatch(/^[a-f0-9]{64}$/u);

			const sessionId = createRuntimeId("session", "model-context-test");
			// internal 通道：agent 工具经 domain.internal 执行 memory.search。
			const internalSearch = await domain.internal.query(sessionId, "memory.search", { scope: "workspace", query: "release" });
			expect(internalSearch.ok).toBe(true);
			if (internalSearch.ok) {
				expect(Array.isArray(internalSearch.body?.results)).toBe(true);
			}
			const sourceRange = {
				stream: { scope: "session" as const, streamId: sessionId, sessionId },
				startSequence: 1,
				endSequence: 2,
				head: { streamId: sessionId, sequence: 2, eventHash: runtimeDigest("head") },
				rangeDigest: runtimeDigest("range"),
				complete: true,
			};
			const compacted = await domain.execute(context("compact.run", {
				reason: "manual",
				sourceRange,
				transcript: "user: compact this\nassistant: done",
				summary: "The user asked for a compact summary.",
			}, 3));
			expect(value<{ checkpoint: { status: string; attempt: number } }>(compacted).checkpoint).toMatchObject({ status: "completed", attempt: 1 });
			expect((compacted.events ?? []).map((event) => event.type)).toEqual(["compaction.started", "compaction.completed"]);
			const checkpoints = await domain.execute(context("compaction.list", {}, 4, false));
			expect(value<{ checkpoints: readonly { status: string }[] }>(checkpoints).checkpoints).toHaveLength(1);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("fails closed without mutating state when compaction is disabled by policy", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-host-model-context-compaction-disabled-"));
		const layout = buildRunledgerLayout(root, "posix");
		const domain = createHostModelContextDomainPort({
			layout,
			workspaceStorageKey: `ws-${"c".repeat(64)}`,
			authorityId: createRuntimeId("authority", "model-context-compaction-disabled-test"),
			tenantId: createRuntimeId("tenant", "model-context-compaction-disabled-test"),
			workspaceId: createRuntimeId("workspace", "model-context-compaction-disabled-test"),
			policyCeilingDigest: runtimeDigest("compaction-policy-ceiling"),
			clock: () => new Date(timestamp),
			compactionPolicy: {
				enabled: false,
				midTurnEnabled: false,
				strategy: "summary",
				thresholdPercent: 80,
				thresholdTokens: 0,
				retainRecentTurns: 1,
				minCompactedTurns: 1,
			},
		});
		try {
			const sessionId = createRuntimeId("session", "model-context-test");
			const sourceRange = {
				stream: { scope: "session" as const, streamId: sessionId, sessionId },
				startSequence: 1,
				endSequence: 2,
				head: { streamId: sessionId, sequence: 2, eventHash: runtimeDigest("head") },
				rangeDigest: runtimeDigest("range"),
				complete: true,
			};
			const result = await domain.execute(context("compact.run", {
				reason: "manual",
				sourceRange,
				transcript: "user: compact this",
				summary: "unused because policy is disabled",
			}, 0));
			expect(result).toMatchObject({ ok: false, body: { code: "compaction_disabled" } });
			expect(result.events).toBeUndefined();
			const checkpoints = await domain.execute(context("compaction.list", {}, 1, false));
			expect(value<{ checkpoints: readonly unknown[] }>(checkpoints).checkpoints).toEqual([]);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("uses the Host snapshot over legacy policy seams and binds provenance", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-host-model-context-runtime-settings-"));
		const layout = buildRunledgerLayout(root, "posix");
		const runtimeSettings = new SettingsResolver({
			user: { compaction: { enabled: false }, memory: { backend: "off" } },
			workspace: { compaction: { thresholdPercent: 101 } },
		}).effectiveRuntimeSnapshot();
		const domain = createHostModelContextDomainPort({
			layout,
			workspaceStorageKey: `ws-${"e".repeat(64)}`,
			authorityId: createRuntimeId("authority", "model-context-runtime-settings-test"),
			tenantId: createRuntimeId("tenant", "model-context-runtime-settings-test"),
			workspaceId: createRuntimeId("workspace", "model-context-runtime-settings-test"),
			policyCeilingDigest: runtimeDigest("runtime-settings-policy-ceiling"),
			runtimeSettings,
			compactionPolicy: {
				enabled: true,
				midTurnEnabled: true,
				strategy: "summary",
				thresholdPercent: 10,
				thresholdTokens: 1,
				retainRecentTurns: 0,
				minCompactedTurns: 0,
			},
			memoryBackend: "local",
		});
		try {
			const snapshot = domain.runtimeSettingsSnapshot?.();
			expect(snapshot).toBe(runtimeSettings);
			expect(snapshot?.digest).toEqual(runtimeSettings.digest);
			expect(snapshot?.sourceLayers["compaction.enabled"]).toBe("user");
			expect(snapshot?.sourceLayers["compaction.thresholdPercent"]).toBe("default");
			expect(snapshot?.diagnostics).toContainEqual(expect.objectContaining({
				code: "out_of_range",
				path: "compaction.thresholdPercent",
				source: "workspace",
			}));

			const sessionId = createRuntimeId("session", "model-context-runtime-settings-test");
			const sourceRange = {
				stream: { scope: "session" as const, streamId: sessionId, sessionId },
				startSequence: 1,
				endSequence: 2,
				head: { streamId: sessionId, sequence: 2, eventHash: runtimeDigest("head") },
				rangeDigest: runtimeDigest("range"),
				complete: true,
			};
			expect(await domain.execute(context("compact.run", {
				reason: "manual",
				sourceRange,
				transcript: "user: compact this",
				summary: "legacy policy must not enable compaction",
			}, 0))).toMatchObject({ ok: false, body: { code: "compaction_disabled" } });
			expect(await domain.internal.command(sessionId, "memory.propose", {
				scope: "workspace",
				title: "legacy memory backend must not enable local memory",
				content: "not persisted",
				sourceKind: "user",
				sourceRef: { subjectKind: "content", digest: runtimeDigest("source"), mediaType: "text/plain", size: 0 },
				sourceDigest: runtimeDigest("source"),
			})).toEqual({ ok: false, code: "memory_backend_disabled" });
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("keeps local Memory unavailable when the effective backend is off", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-host-model-context-memory-off-"));
		const layout = buildRunledgerLayout(root, "posix");
		const domain = createHostModelContextDomainPort({
			layout,
			workspaceStorageKey: `ws-${"d".repeat(64)}`,
			authorityId: createRuntimeId("authority", "model-context-memory-off-test"),
			tenantId: createRuntimeId("tenant", "model-context-memory-off-test"),
			workspaceId: createRuntimeId("workspace", "model-context-memory-off-test"),
			policyCeilingDigest: runtimeDigest("memory-policy-ceiling"),
			clock: () => new Date(timestamp),
			memoryBackend: "off",
		});
		try {
			const sessionId = createRuntimeId("session", "model-context-test");
			const result = await domain.internal.command(sessionId, "memory.propose", {
				scope: "workspace",
				title: "should remain unavailable",
				content: "this must not be persisted",
				sourceKind: "user",
				sourceRef: { subjectKind: "content", digest: runtimeDigest("source"), mediaType: "text/plain", size: 6 },
				sourceDigest: runtimeDigest("source"),
			});
			expect(result).toEqual({ ok: false, code: "memory_backend_disabled" });
			expect(await domain.contextSources(sessionId, "should remain unavailable")).toEqual([]);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("fails closed for every Host Plan operation when plan settings disable the capability", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-host-model-context-plan-disabled-"));
		const layout = buildRunledgerLayout(root, "posix");
		const runtimeSettings = new SettingsResolver({ user: { plan: { enabled: false } } }).effectiveRuntimeSnapshot();
		const domain = createHostModelContextDomainPort({
			layout,
			workspaceStorageKey: `ws-${"f".repeat(64)}`,
			authorityId: createRuntimeId("authority", "model-context-plan-disabled-test"),
			tenantId: createRuntimeId("tenant", "model-context-plan-disabled-test"),
			workspaceId: createRuntimeId("workspace", "model-context-plan-disabled-test"),
			policyCeilingDigest: runtimeDigest("plan-disabled-policy-ceiling"),
			runtimeSettings,
		});
		const sessionId = createRuntimeId("session", "model-context-test");
		try {
			expect(await domain.execute(context("plan.enter", { requestedBy: "user", expectedRevision: 0 }, 0))).toMatchObject({
				ok: false,
				body: { code: "plan_disabled" },
			});
			expect(await domain.execute(context("plan.inspect", {}, 0, false))).toMatchObject({
				ok: false,
				body: { code: "plan_disabled" },
			});
			expect(await domain.internal.command(sessionId, "plan.enter", { requestedBy: "agent", expectedRevision: 0 })).toEqual({
			ok: false,
			code: "plan_disabled",
		});
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("applies defaultOnStartup only to an uninitialized Session and preserves existing Plan state", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-host-model-context-plan-startup-"));
		const layout = buildRunledgerLayout(root, "posix");
		const workspaceStorageKey = `ws-${"c".repeat(64)}`;
		const base = {
			layout,
			workspaceStorageKey,
			authorityId: createRuntimeId("authority", "model-context-plan-startup-test"),
			tenantId: createRuntimeId("tenant", "model-context-plan-startup-test"),
			workspaceId: createRuntimeId("workspace", "model-context-plan-startup-test"),
			policyCeilingDigest: runtimeDigest("plan-startup-policy-ceiling"),
			clock: () => new Date(timestamp),
		};
		const sessionId = createRuntimeId("session", "model-context-test");
		try {
			const existingStateDomain = createHostModelContextDomainPort({
				...base,
				runtimeSettings: new SettingsResolver({ user: { plan: { defaultOnStartup: false } } }).effectiveRuntimeSnapshot(),
			});
			expect(await existingStateDomain.execute(context("plan.enter", { requestedBy: "user", expectedRevision: 0 }, 0))).toMatchObject({ ok: true });
			expect(await existingStateDomain.execute(context("plan.activate", { expectedRevision: 1, content: "# Existing plan" }, 1))).toMatchObject({
				ok: true,
				body: { state: { status: "active", revision: 2 } },
			});

			const startupDefaultDomain = createHostModelContextDomainPort({
				...base,
				runtimeSettings: new SettingsResolver({ user: { plan: { defaultOnStartup: true } } }).effectiveRuntimeSnapshot(),
			});
			const existing = await startupDefaultDomain.execute(context("plan.inspect", {}, 0, false));
			expect(value<{ state: { status: string; revision: number } }>(existing).state).toMatchObject({ status: "active", revision: 2 });

			const newSession = createRuntimeId("session", "model-context-new-session");
			const fresh = await startupDefaultDomain.internal.query(newSession, "plan.inspect");
			expect(fresh).toMatchObject({ ok: true, body: { state: { status: "pending", revision: 0 } } });
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
