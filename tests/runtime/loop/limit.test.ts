import { describe, expect, it } from "vitest";
import {
	consumeLoopLimitIteration,
	createLoopLimitRuntime,
	describeLoopLimitRuntime,
	isLoopLimitExhausted,
	parseLoopArgs,
	readShellWord,
} from "../../../src/runtime/loop/limit.ts";

describe("parseLoopArgs", () => {
	it("parses a bare count and keeps the rest as prompt", () => {
		expect(parseLoopArgs("3 fix the failing tests")).toEqual({
			limit: { kind: "iterations", iterations: 3 },
			prompt: "fix the failing tests",
		});
		expect(parseLoopArgs("10")).toEqual({ limit: { kind: "iterations", iterations: 10 } });
	});

	it("parses compact and compound durations", () => {
		expect(parseLoopArgs("10m")).toEqual({ limit: { kind: "duration", durationMs: 600_000 } });
		expect(parseLoopArgs("1h30m")).toEqual({ limit: { kind: "duration", durationMs: 5_400_000 } });
		expect(parseLoopArgs("90s keep going")).toEqual({
			limit: { kind: "duration", durationMs: 90_000 },
			prompt: "keep going",
		});
	});

	it("parses a spaced duration before treating the number as a count", () => {
		expect(parseLoopArgs("10 minutes")).toEqual({ limit: { kind: "duration", durationMs: 600_000 } });
		expect(parseLoopArgs("2 hours polish it")).toEqual({
			limit: { kind: "duration", durationMs: 7_200_000 },
			prompt: "polish it",
		});
	});

	it("parses a quoted condition flag and reads the remaining prompt", () => {
		expect(parseLoopArgs("20 --until 'bun test' fix them")).toEqual({
			limit: { kind: "iterations", iterations: 20 },
			condition: { command: "bun test", until: true },
			prompt: "fix them",
		});
		expect(parseLoopArgs("--while \"git status --porcelain\"")).toEqual({
			condition: { command: "git status --porcelain", until: false },
		});
	});

	it("hard-errors on limit-shaped or flag-shaped input that does not parse", () => {
		// 形状像 limit 但不可解析：必须报错，不能静默变成 prompt 文本。
		expect(parseLoopArgs("-1")).toContain("Usage: /loop");
		expect(parseLoopArgs("1.5h")).toContain("Usage: /loop");
		expect(parseLoopArgs("10x10")).toContain("Usage: /loop");
		expect(parseLoopArgs("0")).toContain("positive integer");
		expect(parseLoopArgs("10x")).toContain("seconds, minutes, or hours");
		// flag 形状但未知/缺值。
		expect(parseLoopArgs("--when 'x'")).toContain("Unknown /loop flag --when");
		expect(parseLoopArgs("--until")).toContain("needs a shell command");
		expect(parseLoopArgs("--until 'unterminated")).toContain("unterminated quote");
		expect(parseLoopArgs("--while a --until b")).toContain("only one of");
	});

	it("treats plain prose as an unbounded prompt", () => {
		expect(parseLoopArgs("keep going and never stop")).toEqual({ prompt: "keep going and never stop" });
		expect(parseLoopArgs("   ")).toEqual({});
	});
});

describe("readShellWord", () => {
	it("handles quotes, escapes and unterminated input", () => {
		expect(readShellWord("'a b' c")).toEqual({ value: "a b", rest: "c" });
		expect(readShellWord('"a\\"b" c')).toEqual({ value: 'a"b', rest: "c" });
		expect(readShellWord("a\\ b c")).toEqual({ value: "a b", rest: "c" });
		expect(readShellWord("'unterminated")).toBe("unterminated");
		expect(readShellWord("   ")).toBeUndefined();
	});
});

describe("loop limit runtime", () => {
	it("falls back to the configured hard cap when no explicit limit is given", () => {
		// 无显式 limit 也不能无限迭代（D8）。
		expect(createLoopLimitRuntime(undefined, 50)).toEqual({ kind: "iterations", initial: 50, remaining: 50 });
		expect(createLoopLimitRuntime({ kind: "iterations", iterations: 3 }, 50)).toEqual({ kind: "iterations", initial: 3, remaining: 3 });
	});

	it("consumes iterations immutably and reports exhaustion", () => {
		const initial = createLoopLimitRuntime({ kind: "iterations", iterations: 2 }, 50);
		const once = consumeLoopLimitIteration(initial);
		expect(once).toEqual({ kind: "iterations", initial: 2, remaining: 1 });
		// 原值不变：调用方必须写回，避免忘记写回导致无限循环。
		expect(initial).toEqual({ kind: "iterations", initial: 2, remaining: 2 });
		const twice = consumeLoopLimitIteration(once!);
		expect(consumeLoopLimitIteration(twice!)).toBeUndefined();
		// 两次消耗后 remaining 归零；exhausted 不消耗迭代，供预检使用。
		expect(twice).toEqual({ kind: "iterations", initial: 2, remaining: 0 });
		expect(isLoopLimitExhausted(twice!)).toBe(true);
		expect(isLoopLimitExhausted(once!)).toBe(false);
		expect(isLoopLimitExhausted({ kind: "iterations", initial: 2, remaining: 0 })).toBe(true);
	});

	it("expires a duration limit at its deadline", () => {
		const limit = createLoopLimitRuntime({ kind: "duration", durationMs: 1_000 }, 50, 5_000);
		expect(limit).toEqual({ kind: "duration", durationMs: 1_000, deadlineMs: 6_000 });
		expect(isLoopLimitExhausted(limit, 5_999)).toBe(false);
		expect(isLoopLimitExhausted(limit, 6_000)).toBe(true);
		expect(consumeLoopLimitIteration(limit, 6_000)).toBeUndefined();
	});

	it("describes the remaining budget for status output", () => {
		expect(describeLoopLimitRuntime({ kind: "iterations", initial: 4, remaining: 3 })).toBe("3 of 4 iterations remaining");
		expect(describeLoopLimitRuntime({ kind: "duration", durationMs: 3_600_000, deadlineMs: 0 })).toBe("1 hour limit");
	});
});
