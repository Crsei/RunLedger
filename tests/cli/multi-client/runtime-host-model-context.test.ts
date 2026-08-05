import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildRunledgerLayout } from "../../../src/runtime/contracts/storage-layout.ts";
import { runtimeDigest } from "../../../src/runtime/protocol/foundation.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/ids.ts";
import type { HostRuntimeDomainContext, HostRuntimeDomainPort } from "../../../src/cli/runtime-host-service.ts";
import { createHostModelContextDomainPort } from "../../../src/cli/runtime-host-model-context.ts";

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
			const planState = value<{ state: { revision: number; plan: { revision: number; digest: { digest: string } } } }>(written).state;
			const requested = await domain.execute(context("plan.request_approval", {
				expectedRevision: 3,
				expectedPlanRevision: 1,
				expectedPlanDigest: planState.plan.digest,
			}, 3));
			const awaiting = value<{ state: { revision: number; approval: { approvalId: string } } }>(requested).state;
			expect(awaiting.approval.approvalId).toMatch(/^approval_/u);
			const resolved = await domain.execute(context("plan.resolve_approval", {
				expectedRevision: 4,
				decision: "approved",
				approvalId: awaiting.approval.approvalId,
			}, 4));
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
			expect(value<{ state: { status: string; revision: number } }>(inspected).state).toMatchObject({ status: "exit_pending", revision: 5 });
			expect((entered.events ?? []).map((event) => event.type)).toEqual(["plan.enter_requested"]);
			expect((activated.events ?? []).map((event) => event.type)).toEqual(["plan.entered"]);
			expect((written.events ?? []).map((event) => event.type)).toEqual(["artifact.created"]);
			expect((requested.events ?? []).map((event) => event.type)).toEqual(["plan.approval_requested"]);
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

			const sessionId = createRuntimeId("session", "model-context-test");
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
});
