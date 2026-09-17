import { describe, expect, it } from "vitest";
import { createLoopTestHarness } from "./loop-test-harness.ts";
import { isLoopResetHandoff } from "../../../src/runtime/loop/handoff.ts";
import { parseLoopArgs } from "../../../src/runtime/loop/limit.ts";

const context = { correlationId: "reset", effectId: "reset", expectedRevision: 0 };

describe("client-owned loop reset handoff", () => {
	it("does not emit a reset without durable audit and expires it on driver loss", async () => {
		for (const failAudit of ["loop.reset_requested", undefined]) {
			const h = createLoopTestHarness({ failAudit });
			await h.controller.start({ prompt: "work", action: "reset", clientReset: true, limit: { kind: "iterations", iterations: 1 } });
			h.emitAgentEnd(); await h.settle();
			if (failAudit !== undefined) {
				expect(h.events).toHaveLength(1); // 首轮的 turn.started；没有 reset 信号。
				expect(h.stopReasons).toContain("audit_failed");
			} else {
				const handoffId = h.events.find(event => event.eventType === "session.loop_reset")?.payload.handoffId;
				h.detachDriver();
				expect((await h.controller.mutate("loop.claim_reset", { handoffId }, context)).ok).toBe(false);
				expect(h.stopReasons).toContain("driver_detached");
			}
		}
	});

	it("waits for idle and does not submit a late iteration after stop", async () => {
		let release!: () => void;
		let waits = 0;
		const h = createLoopTestHarness({ waitForIdle: async () => { if (++waits > 1) await new Promise<void>(resolve => { release = resolve; }); } });
		await h.controller.start({ prompt: "work", action: "prompt", limit: { kind: "iterations", iterations: 1 } });
		h.emitAgentEnd(); await h.settle();
		expect(h.submissions).toHaveLength(1);
		h.controller.stop("user_requested"); release(); await h.settle();
		expect(h.submissions).toHaveLength(1);
	});

	it("does not count a failed compact as a submitted iteration", async () => {
		const h = createLoopTestHarness({ compact: async () => { throw new Error("compact unavailable"); } });
		await h.controller.start({ prompt: "work", action: "compact", limit: { kind: "iterations", iterations: 1 } });
		h.emitAgentEnd(); await h.settle();
		expect(h.submissions).toHaveLength(1);
		expect(h.audits.filter(event => event.eventType === "loop.iteration_submitted")).toHaveLength(1);
		expect(h.stopReasons).toContain("compact_failed");
	});
	it("parses an explicit action without treating unknown flags as prompt text", () => {
		expect(parseLoopArgs("2 --reset --until 'test -f done' work")).toMatchObject({ action: "reset", limit: { kind: "iterations", iterations: 2 }, prompt: "work" });
		expect(parseLoopArgs("2 --compact work")).toMatchObject({ action: "compact" });
		expect(typeof parseLoopArgs("2 --reset --compact work")).toBe("string");
	});

	it("claims each handoff once and keeps the total iteration budget across Owners", async () => {
		let current = createLoopTestHarness();
		await current.controller.start({ prompt: "work", action: "reset", clientReset: true, limit: { kind: "iterations", iterations: 2 } });
		let submissions = current.submissions.length;
		for (let remaining = 1; remaining >= 0; remaining -= 1) {
			current.emitAgentEnd(); await current.settle();
			const handoffId = current.events.find(event => event.eventType === "session.loop_reset")?.payload.handoffId;
			const claimed = await current.controller.mutate("loop.claim_reset", { handoffId }, context);
			expect(claimed.ok).toBe(true);
			if (!claimed.ok || !isLoopResetHandoff(claimed.value.handoff)) throw new Error("missing handoff");
			const handoff = claimed.value.handoff;
			expect(handoff.limit).toMatchObject({ remaining });
			expect((await current.controller.mutate("loop.claim_reset", { handoffId }, context)).ok).toBe(false);
			current.emitAgentEnd(); await current.settle();
			expect(current.events.filter(event => event.eventType === "session.loop_reset")).toHaveLength(1);
			await current.controller.mutate("loop.finish_reset", { handoffId, targetSessionId: `next-${remaining}` }, context);
			expect(current.controller.inspect().running).toBe(false);
			const next = createLoopTestHarness();
			await next.controller.start({ prompt: handoff.prompt, action: "reset", clientReset: true, handoff });
			submissions += next.submissions.length;
			current = next;
		}
		current.emitAgentEnd(); await current.settle();
		expect(current.controller.inspect().running).toBe(false);
		expect(current.events.filter(event => event.eventType === "session.loop_reset")).toHaveLength(0);
		expect(submissions).toBe(3);
	});

	it("cancels pending handoffs on stop, preserves deadlines and rejects expired resumes", async () => {
		const h = createLoopTestHarness();
		await h.controller.start({ prompt: "work", action: "reset", clientReset: true, limit: { kind: "duration", durationMs: 60_000 } });
		h.emitAgentEnd(); await h.settle();
		const handoffId = h.events.find(event => event.eventType === "session.loop_reset")?.payload.handoffId;
		const claimed = await h.controller.mutate("loop.claim_reset", { handoffId }, context);
		if (!claimed.ok || !isLoopResetHandoff(claimed.value.handoff)) throw new Error("missing handoff");
		const handoff = claimed.value.handoff;
		h.controller.stop("user_requested");
		expect((await h.controller.mutate("loop.finish_reset", { handoffId }, context)).ok).toBe(false);
		const next = createLoopTestHarness();
		expect(await next.controller.start({ prompt: "work", action: "reset", clientReset: true, handoff: { ...handoff, limit: { kind: "duration", durationMs: 60_000, deadlineMs: Date.now() - 1 } } })).toMatchObject({ ok: false });
		expect(next.submissions).toHaveLength(0);
	});
});
