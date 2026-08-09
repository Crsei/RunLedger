import { describe, expect, it } from "vitest";
import { createRuntimeId } from "../../../src/runtime/protocol/ids.ts";
import * as processAdapters from "../../../src/tui/process/controller-adapter.ts";
import { createProcessOverlayController } from "../../../src/tui/process/controller-adapter.ts";
import type { ProcessOverlayHostClient } from "../../../src/tui/process/controller-adapter.ts";
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
	it("builds a process overlay client only from negotiated Session operations", async () => {
		const factory = (processAdapters as typeof processAdapters & {
			createSessionProcessOverlayClient?: (controller: Record<string, unknown>) => ProcessOverlayHostClient | undefined;
		}).createSessionProcessOverlayClient;
		expect(factory).toBeTypeOf("function");
		if (factory === undefined) return;
		const calls: string[] = [];
		const controller = {
			supports: (operation: string) => new Set([
				"session.process.list",
				"session.process.output",
				"session.process.stdin",
				"session.process.resize",
				"session.process.stop",
			]).has(operation),
			querySessionDomain: async (operation: string) => {
				calls.push(operation);
				if (operation === "session.process.list") return { ok: true, status: "ok", operation, domainRevision: 4, value: { items: [item] } };
				return {
					ok: true, status: "ok", operation, domainRevision: 4,
					value: { text: "session output", startCursor: { sequence: 0, byteOffset: 0 }, endCursor: { sequence: 1, byteOffset: 14 }, nextCursor: { sequence: 1, byteOffset: 14 }, truncated: false, head: { sequence: 1, byteOffset: 14 } },
				};
			},
			commandSessionDomain: async (operation: string) => {
				calls.push(operation);
				return { ok: true, status: "ok", operation, domainRevision: 4, value: { receiptDigest: { algorithm: "sha256", digest: "a".repeat(64) } } };
			},
		};
		const client = factory(controller);
		expect(client).toBeDefined();
		if (client === undefined) return;
		await expect(client.listProcesses()).resolves.toEqual([item]);
		await expect(client.processOutput(executionId, { sequence: 0, byteOffset: 0 }, 1_024)).resolves.toMatchObject({ ok: true, text: "session output" });
		await expect(client.writeStdin?.(executionId, "input")).resolves.toMatchObject({ ok: true });
		expect(calls).toEqual(["session.process.list", "session.process.output", "session.process.stdin"]);

		expect(factory({ ...controller, supports: () => false })).toBeUndefined();
	});
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
