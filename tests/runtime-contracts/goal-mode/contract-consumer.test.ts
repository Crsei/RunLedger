import { describe, expect, it } from "vitest";
import { GOAL_EVENT_TYPES, goalModeContractFixture, goalModeStateIsValid, goalProjectionIsValid } from "./contract-consumer.ts";
import { canonicalDigest } from "../../../src/runtime/protocol/canonical-json.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/ids.ts";
import { RUNTIME_EVENT_PAYLOAD_REQUIREMENTS } from "../../../src/runtime/protocol/schemas.ts";
import type { RuntimeEvent, RuntimeEventType } from "../../../src/runtime/protocol/events.ts";
import { validateRuntimeEvent } from "../../../src/runtime/protocol/schemas.ts";

function sha256(value: unknown) {
	return { algorithm: "sha256", digest: canonicalDigest(value) } as const;
}

/** 按 event-contracts.test.ts 的既有构造方式生成一个可校验的精确事件。 */
function goalEvent(type: RuntimeEventType, subjectKind: "goal" | "session"): RuntimeEvent {
	const payload = {
		subject: { kind: subjectKind, id: createRuntimeId(subjectKind === "goal" ? "goal" : "session", "goal-contract") },
		correlationId: createRuntimeId("trace", "goal-contract"),
		effect: "committed",
		// 逐类型要求由事件名后缀推导；这里一次给全可选证据字段，覆盖所有 goal/loop 事件。
		transition: { revision: 1, previousStatus: "active", nextStatus: "complete" },
		expectedRevision: 0,
		idempotencyKey: "goal-contract-idempotency",
		refs: [{ subjectKind: "content", digest: sha256("goal-contract-iteration"), mediaType: "text/plain", size: 1 }],
		metadataDigest: sha256("goal-contract-metadata"),
		reasonCode: "budget_exhausted",
	};
	const body = {
		authorityId: createRuntimeId("authority", "goal-contract"),
		tenantId: createRuntimeId("tenant", "goal-contract"),
		principalId: createRuntimeId("principal", "goal-contract"),
		eventId: createRuntimeId("event", `goal-${type.replaceAll(".", "-")}`),
		stream: { scope: "session" as const, streamId: createRuntimeId("session", "goal-contract"), sessionId: createRuntimeId("session", "goal-contract") },
		sequence: 0,
		timestamp: "2026-09-17T00:00:00.000Z",
		type,
		previousEventHash: null,
		payloadDigest: sha256(payload),
		traceId: createRuntimeId("trace", "goal-contract"),
		payload,
	};
	return {
		...body,
		currentEventHash: sha256({
			authorityId: body.authorityId, tenantId: body.tenantId, principalId: body.principalId, eventId: body.eventId,
			stream: body.stream, sequence: body.sequence, timestamp: body.timestamp, type: body.type,
			previousEventHash: body.previousEventHash, payloadDigest: body.payloadDigest, traceId: body.traceId,
		}),
	} as unknown as RuntimeEvent;
}

describe("Goal mode public contract", () => {
	it("registers every goal and loop audit event in the closed catalog", () => {
		expect(goalModeContractFixture().registered).toEqual([...GOAL_EVENT_TYPES]);
		// goal.transitioned 的 action 满足 transition 推导，自动要求 transition + expectedRevision。
		expect(RUNTIME_EVENT_PAYLOAD_REQUIREMENTS["goal.transitioned"]).toEqual(
			expect.arrayContaining(["transition", "expectedRevision"]),
		);
	});

	it("binds goal events to goal subjects and loop events to the session subject", () => {
		expect(validateRuntimeEvent(goalEvent("goal.transitioned", "goal")).ok).toBe(true);
		expect(validateRuntimeEvent(goalEvent("goal.transitioned", "session")).ok).toBe(false);
		expect(validateRuntimeEvent(goalEvent("goal.continuation_requested", "goal")).ok).toBe(true);
		expect(validateRuntimeEvent(goalEvent("loop.started", "session")).ok).toBe(true);
		expect(validateRuntimeEvent(goalEvent("loop.stopped", "session")).ok).toBe(true);
		expect(validateRuntimeEvent(goalEvent("loop.started", "goal")).ok).toBe(false);
	});

	it("accepts the goal mode state and rejects drifted fields", () => {
		const state = goalModeContractFixture().state;
		expect(goalModeStateIsValid(state)).toBe(true);
		// 类型外的漂移字段同样必须被拒绝（通过 unknown 绕过编译期检查，验证运行时 guard）。
		const drifted: unknown = { ...state, status: "running" };
		expect(goalModeStateIsValid(drifted)).toBe(false);
		expect(goalModeStateIsValid({ ...state, completion: { requestedAt: state.updatedAt, requestedBy: "agent" } })).toBe(true);
		// tokensUsed 必须等于可见分项之和；partial 必须由未计量轮次解释。
		expect(goalModeStateIsValid({ ...state, usage: { ...state.usage, tokensUsed: 999 } })).toBe(false);
		expect(goalModeStateIsValid({ ...state, usage: { ...state.usage, accountingCompleteness: "partial" } })).toBe(false);
		expect(goalModeStateIsValid({ ...state, usage: { ...state.usage, accountingCompleteness: "partial", unaccountedTurns: 1 } })).toBe(true);
	});

	it("projects goal mode state without inventing a second goal concept", () => {
		const projection = goalModeContractFixture().projection;
		expect(goalProjectionIsValid(projection)).toBe(true);
		// GoalProjection 与 GoalModeState 共享状态集：旧的任务树取值不再是合法投影。
		expect(goalProjectionIsValid({ ...projection, status: "completed" })).toBe(false);
		expect(goalProjectionIsValid({ ...projection, status: "budget_limited" })).toBe(true);
		expect(goalProjectionIsValid({ ...projection, extra: 1 })).toBe(false);
	});
});
