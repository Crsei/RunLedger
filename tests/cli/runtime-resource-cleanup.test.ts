import { describe, expect, it, vi } from "vitest";
import { closeCliRuntimeResources } from "../../src/cli/runtime-resource-cleanup.ts";

describe("CLI runtime resource cleanup", () => {
	it("waits for every close operation and flattens all cleanup failures", async () => {
		const first = new Error("first cleanup failure");
		const second = new Error("second cleanup failure");
		const third = new Error("third cleanup failure");
		const calls: string[] = [];
		const closeOne = vi.fn(async () => {
			calls.push("one");
			throw new AggregateError([first, second], "nested cleanup failures");
		});
		const closeTwo = vi.fn(async () => {
			calls.push("two");
			throw third;
		});

		let error: Error | undefined;
		try {
			await closeCliRuntimeResources([closeOne, closeTwo]);
		} catch (cause) {
			if (cause instanceof Error) error = cause;
		}

		expect(calls.sort()).toEqual(["one", "two"]);
		expect(error).toBeInstanceOf(AggregateError);
		expect((error as AggregateError).errors).toEqual([first, second, third]);
	});

	it("preserves a single cleanup failure without wrapping it", async () => {
		const failure = new Error("single cleanup failure");
		await expect(closeCliRuntimeResources([
			async () => { throw failure; },
		])).rejects.toBe(failure);
	});
});
