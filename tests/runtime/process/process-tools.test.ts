import { describe, expect, it } from "vitest";
import { createRuntimeId } from "../../../src/runtime/protocol/ids.ts";
import { runtimeDigest, type RuntimeDigest } from "../../../src/runtime/protocol/foundation.ts";
import type { ExecutionHandleRef } from "../../../src/runtime/process/types.ts";
import { createProcessOutputTool } from "../../../src/runtime/tools/process-output.ts";
import { createProcessWaitTool } from "../../../src/runtime/tools/process-wait.ts";
import { createWriteStdinTool } from "../../../src/runtime/tools/write-stdin.ts";
import { createProcessStopTool } from "../../../src/runtime/tools/process-stop.ts";
import { createProcessResizeTool } from "../../../src/runtime/tools/process-resize.ts";

const digest = (seed: string): RuntimeDigest => runtimeDigest(seed);

function handle(): ExecutionHandleRef {
	return {
		authorityId: createRuntimeId("authority", "tools"),
		tenantId: createRuntimeId("tenant", "tools"),
		workspaceId: createRuntimeId("workspace", "tools"),
		sessionId: createRuntimeId("session", "tools"),
		hostGeneration: 1,
		sessionGeneration: 1,
		executionId: createRuntimeId("execution", "tools"),
		attemptId: createRuntimeId("attempt", "tools_1"),
		revision: 2,
		requestDigest: digest("request"),
	};
}

describe("R8 managed process tools", () => {
	it("returns only bounded output and safe cursors", async () => {
		let requestedBytes = 0;
		const tool = createProcessOutputTool({
			processOutput: async (_handle, _cursor, maxBytes) => {
				requestedBytes = maxBytes;
				return {
					ok: true as const,
					page: { handle: handle(), startCursor: { sequence: 0, byteOffset: 0 }, endCursor: { sequence: 1, byteOffset: 5 }, text: "hello", nextCursor: { sequence: 1, byteOffset: 5 }, truncated: false },
					head: { sequence: 1, byteOffset: 5 },
				};
			},
		});
		const result = await tool.execute("toolCall_output", { handle: handle(), cursor: { sequence: 0, byteOffset: 0 }, max_bytes: 5 });
		expect(requestedBytes).toBe(5);
		expect(result.content[0]).toEqual({ type: "text", text: "hello" });
		expect(result.details).toMatchObject({ nextCursor: { sequence: 1, byteOffset: 5 }, truncated: false });
		expect(JSON.stringify(result)).not.toMatch(/(?:pid|outputPath|cwd|command)/iu);
	});

	it("returns the typed earliest cursor when retention requires resync", async () => {
		const earliestCursor = { sequence: 4, byteOffset: 12 };
		const tool = createProcessOutputTool({
			processOutput: async () => ({ ok: false as const, code: "output_cursor_resync_required" as const, earliestCursor }),
		});
		const result = await tool.execute("toolCall_output_resync", {
			handle: handle(),
			cursor: { sequence: 0, byteOffset: 0 },
			max_bytes: 64,
		});
		expect(result.isError).toBe(true);
		expect(result.details).toEqual({ code: "output_cursor_resync_required", earliestCursor });
	});

	it("uses a positive bounded wait and reports terminal once", async () => {
		let timeout = 0;
		const tool = createProcessWaitTool({
			processWait: async (_handle, timeoutMs) => {
				timeout = timeoutMs;
				return { ok: true as const, outcome: "terminal" as const, summary: { state: "completed" }, nextCursor: { sequence: 2, byteOffset: 7 } };
			},
		});
		const result = await tool.execute("toolCall_wait", { handle: handle(), timeout_ms: 25 });
		expect(timeout).toBe(25);
		expect(result.content[0]).toMatchObject({ type: "text" });
		expect(result.details).toMatchObject({ outcome: "terminal", nextCursor: { sequence: 2, byteOffset: 7 } });
	});

	it("does not let an observer write or stop a process", async () => {
		let writes = 0;
		const client = {
			write: async () => { writes += 1; return { ok: true as const, operation: "write" as const, receiptDigest: digest("write"), summary: { state: "running" } }; },
			stop: async () => { writes += 1; return { ok: true as const, operation: "stop" as const, receiptDigest: digest("stop"), summary: { state: "running" } }; },
		};
		const write = createWriteStdinTool(client, { actor: "observer" });
		const stop = createProcessStopTool(client, { actor: "observer" });
		expect((await write.execute("toolCall_write", { handle: handle(), input: "x" })).isError).toBe(true);
		expect((await stop.execute("toolCall_stop", { handle: handle() })).isError).toBe(true);
		expect(writes).toBe(0);
	});

	it("routes driver stdin, stop, and PTY resize through the injected facade", async () => {
		const calls: string[] = [];
		const client = {
			write: async () => { calls.push("write"); return { ok: true as const, operation: "write" as const, receiptDigest: digest("write"), summary: { state: "running" } }; },
			stop: async () => { calls.push("stop"); return { ok: true as const, operation: "stop" as const, receiptDigest: digest("stop"), summary: { state: "running" } }; },
			resize: async () => { calls.push("resize"); return { ok: true as const, operation: "resize" as const, receiptDigest: digest("resize"), summary: { state: "running" } }; },
		};
		const driver = { actor: "driver" as const };
		expect((await createWriteStdinTool(client, driver).execute("w", { handle: handle(), input: "x" })).isError).not.toBe(true);
		expect((await createProcessStopTool(client, driver).execute("s", { handle: handle() })).isError).not.toBe(true);
		expect((await createProcessResizeTool(client, driver).execute("r", { handle: handle(), columns: 80, rows: 24 })).isError).not.toBe(true);
		expect(calls).toEqual(["write", "stop", "resize"]);
	});
});
