import { describe, expect, it } from "vitest";
import { evaluateLoopCondition, type LoopConditionExecution } from "../../../src/runtime/loop/condition.ts";
import type { LoopConditionConfig } from "../../../src/runtime/loop/limit.ts";

const whileCondition: LoopConditionConfig = { command: "bun test", until: false };
const untilCondition: LoopConditionConfig = { command: "bun test", until: true };

function run(
	condition: LoopConditionConfig,
	execution: LoopConditionExecution | Error,
): ReturnType<typeof evaluateLoopCondition> {
	return evaluateLoopCondition(condition, {
		timeoutMs: 30_000,
		signal: new AbortController().signal,
		execute: async () => {
			if (execution instanceof Error) throw execution;
			return execution;
		},
	});
}

describe("evaluateLoopCondition", () => {
	it("maps exit 0 to continue for --while and halt for --until", async () => {
		await expect(run(whileCondition, { exitCode: 0, timedOut: false, cancelled: false })).resolves.toEqual({ kind: "continue" });
		const halted = await run(untilCondition, { exitCode: 0, timedOut: false, cancelled: false });
		expect(halted.kind).toBe("halt");
	});

	it("maps exit 1 to halt for --while and continue for --until", async () => {
		const halted = await run(whileCondition, { exitCode: 1, timedOut: false, cancelled: false });
		expect(halted).toMatchObject({ kind: "halt" });
		await expect(run(untilCondition, { exitCode: 1, timedOut: false, cancelled: false })).resolves.toEqual({ kind: "continue" });
	});

	it("treats exit codes above 1 as a broken condition instead of false", async () => {
		// 127/126/2 说明条件命令自身坏了；当作 false 会让 loop 无限重试坏命令。
		for (const exitCode of [2, 126, 127, 130]) {
			for (const condition of [whileCondition, untilCondition]) {
				const verdict = await run(condition, { exitCode, timedOut: false, cancelled: false, output: "command not found\n" });
				expect(verdict).toMatchObject({ kind: "error" });
				if (verdict.kind !== "error") return;
				expect(verdict.message).toContain(`exit ${exitCode}`);
				expect(verdict.message).toContain("command not found");
			}
		}
	});

	it("distinguishes a timeout (broken condition) from cancellation (user abort)", async () => {
		// 超时同样可能报告 cancelled；deadline 是坏条件，Esc 不是。
		const timedOut = await run(whileCondition, { exitCode: undefined, timedOut: true, cancelled: true });
		expect(timedOut).toMatchObject({ kind: "error" });
		if (timedOut.kind === "error") expect(timedOut.message).toContain("timed out after 30s");

		await expect(run(whileCondition, { exitCode: undefined, timedOut: false, cancelled: true })).resolves.toEqual({ kind: "aborted" });
	});

	it("never throws when the condition cannot start", async () => {
		const verdict = await run(whileCondition, new Error("spawn failed"));
		expect(verdict).toMatchObject({ kind: "error" });
		if (verdict.kind === "error") expect(verdict.message).toContain("could not run");
	});

	it("reports a missing exit status as a broken condition", async () => {
		const verdict = await run(whileCondition, { exitCode: undefined, timedOut: false, cancelled: false });
		expect(verdict).toMatchObject({ kind: "error" });
		if (verdict.kind === "error") expect(verdict.message).toContain("no exit status");
	});
});
