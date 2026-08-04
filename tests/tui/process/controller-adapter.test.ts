import { describe, expect, it } from "vitest";
import { createRuntimeId } from "../../../src/runtime/protocol/ids.ts";
import { createProcessOverlayController } from "../../../src/tui/process/controller-adapter.ts";
import type { ProcessOverlayItem } from "../../../src/tui/process/types.ts";

const executionId = createRuntimeId("execution", "controller");
const item: ProcessOverlayItem = {
	executionId,
	attemptId: createRuntimeId("attempt", "controller_1"),
	state: "running",
	outputCursor: { sequence: 0, byteOffset: 0 },
	outputSize: 0,
	canWrite: true,
	canResize: true,
	canStop: true,
};

describe("R9 process overlay Host facade adapter", () => {
	it("refreshes safe list and reads output lazily by cursor", async () => {
		const calls: string[] = [];
		const controller = createProcessOverlayController({
			listProcesses: async () => [item],
			processOutput: async (id, cursor) => {
				calls.push(`${id}:${JSON.stringify(cursor)}`);
				return { ok: true as const, text: "lazy output", startCursor: cursor, endCursor: { sequence: 1, byteOffset: 9 }, nextCursor: { sequence: 1, byteOffset: 9 }, truncated: false, head: { sequence: 1, byteOffset: 9 } };
			},
		}, { driver: true });
		await controller.refresh();
		await controller.openDetail(executionId);
		await controller.loadOutput();
		expect(controller.snapshot().output).toBe("lazy output");
		expect(calls).toEqual([`${executionId}:{"sequence":0,"byteOffset":0}`]);
	});

	it("routes terminal mutations through the Host facade and never gives them to observers", async () => {
		const calls: string[] = [];
		const client = {
			listProcesses: async () => [item],
			processOutput: async (_id, cursor) => ({ ok: true as const, text: "", startCursor: cursor, endCursor: cursor, nextCursor: cursor, truncated: false, head: cursor }),
			writeStdin: async (_id: typeof executionId, input: string) => {
				calls.push(`write:${input}`);
				return { ok: true as const };
			},
			resizeProcess: async (_id: typeof executionId, columns: number, rows: number) => {
				calls.push(`resize:${columns}x${rows}`);
				return { ok: true as const };
			},
			stopProcess: async () => {
				calls.push("stop");
				return { ok: true as const };
			},
		};
		const driver = createProcessOverlayController(client, { driver: true });
		await driver.refresh();
		await driver.openTerminal(executionId);
		await expect(driver.write("x")).resolves.toEqual({ ok: true });
		await expect(driver.resize(80, 24)).resolves.toEqual({ ok: true });
		await expect(driver.stop()).resolves.toEqual({ ok: true });
		expect(calls).toEqual(["write:x", "resize:80x24", "stop"]);

		const observer = createProcessOverlayController(client, { driver: false });
		await observer.refresh();
		await observer.openTerminal(executionId);
		await expect(observer.write("blocked")).resolves.toEqual({ ok: false, code: "observer_mutation_forbidden" });
		await expect(observer.resize(80, 24)).resolves.toEqual({ ok: false, code: "observer_mutation_forbidden" });
		await expect(observer.stop()).resolves.toEqual({ ok: false, code: "observer_mutation_forbidden" });
		expect(calls).toEqual(["write:x", "resize:80x24", "stop"]);
	});

	it("moves the overlay cursor to the typed earliest cursor after retention resync", async () => {
		const calls: string[] = [];
		let first = true;
		const earliestCursor = { sequence: 4, byteOffset: 16 };
		const controller = createProcessOverlayController({
			listProcesses: async () => [item],
			processOutput: async (_id, cursor) => {
				calls.push(JSON.stringify(cursor));
				if (first) {
					first = false;
					return { ok: false as const, code: "output_cursor_resync_required", earliestCursor };
				}
				return { ok: true as const, text: "retained", startCursor: cursor, endCursor: { sequence: 5, byteOffset: 24 }, nextCursor: { sequence: 5, byteOffset: 24 }, truncated: false, head: { sequence: 5, byteOffset: 24 } };
			},
		}, { driver: false });
		await controller.refresh();
		await controller.openDetail(executionId);
		await controller.loadOutput();
		expect(controller.snapshot().cursor).toEqual(earliestCursor);
		await controller.loadOutput();
		expect(controller.snapshot().output).toBe("retained");
		expect(calls).toEqual([
			JSON.stringify({ sequence: 0, byteOffset: 0 }),
			JSON.stringify(earliestCursor),
		]);
	});
});
