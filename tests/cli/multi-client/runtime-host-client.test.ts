import { describe, expect, it } from "vitest";
import { createRuntimeId } from "../../../src/runtime/protocol/ids.ts";
import { createProductionProcessOverlayClient } from "../../../src/cli/runtime-host-client.ts";
import type { HostFrameEnvelope } from "../../../src/runtime/host/types.ts";
import type { OutputCursor } from "../../../src/runtime/process/output.ts";

class FakeTransport {
	readonly operations: string[] = [];
	private readonly responses: Record<string, Record<string, unknown>>;

	public constructor(responses: Record<string, Record<string, unknown>>) {
		this.responses = responses;
	}

	public async request(frame: HostFrameEnvelope): Promise<HostFrameEnvelope> {
		const operation = String(frame.body.operation);
		this.operations.push(operation);
		return {
			frameId: `response_${frame.frameId}`,
			kind: "command_result",
			protocolVersion: 1,
			body: { requestFrameId: frame.frameId, ...(this.responses[operation] ?? { ok: true }) },
		};
	}

	public onEvent(): () => void {
		return () => {};
	}
}

describe("production Host process overlay client", () => {
	it("maps safe summaries and routes bounded output and driver mutations through Host", async () => {
		const executionId = createRuntimeId("execution", "overlay");
		const attemptId = createRuntimeId("attempt", "overlay_1");
		const transport = new FakeTransport({
			"process.list": {
				ok: true,
				processes: [{
					executionId,
					attemptId,
					state: "running",
					outputCursor: { sequence: 3, byteOffset: 12 },
					outputSize: 12,
					capabilities: { canWrite: true, canResize: true, canStop: true },
				}],
			},
			"process.output": {
				ok: true,
				page: "hello",
				startCursor: { sequence: 0, byteOffset: 0 },
				endCursor: { sequence: 1, byteOffset: 5 },
				nextCursor: { sequence: 1, byteOffset: 5 },
				head: { sequence: 1, byteOffset: 5 },
				truncated: false,
			},
			"process.write": { ok: true, receiptDigest: { algorithm: "sha256", digest: "a".repeat(64) } },
			"process.resize": { ok: true },
			"process.stop": { ok: true },
		});
		const client = createProductionProcessOverlayClient(transport, "session_overlay", { isDriver: () => true });

		expect(await client.listProcesses()).toEqual([{
			executionId,
			attemptId,
			state: "running",
			outputCursor: { sequence: 3, byteOffset: 12 },
			outputSize: 12,
			canWrite: true,
			canResize: true,
			canStop: true,
		}]);
		expect(await client.processOutput(executionId, { sequence: 0, byteOffset: 0 }, 64)).toEqual({
			ok: true,
			text: "hello",
			startCursor: { sequence: 0, byteOffset: 0 },
			endCursor: { sequence: 1, byteOffset: 5 },
			nextCursor: { sequence: 1, byteOffset: 5 },
			truncated: false,
			head: { sequence: 1, byteOffset: 5 },
		});
		expect(await client.writeStdin?.(executionId, "x")).toMatchObject({ ok: true });
		expect(await client.resizeProcess?.(executionId, 80, 24)).toMatchObject({ ok: true });
		expect(await client.stopProcess?.(executionId)).toMatchObject({ ok: true });
		expect(transport.operations).toEqual(["process.list", "process.output", "process.write", "process.resize", "process.stop"]);
	});

	it("does not expose mutation calls to an observer", async () => {
		const transport = new FakeTransport({});
		const client = createProductionProcessOverlayClient(transport, "session_overlay", { isDriver: () => false });
		const executionId = createRuntimeId("execution", "observer");

		expect(await client.writeStdin?.(executionId, "blocked")).toEqual({ ok: false, code: "observer_mutation_forbidden" });
		expect(await client.resizeProcess?.(executionId, 80, 24)).toEqual({ ok: false, code: "observer_mutation_forbidden" });
		expect(await client.stopProcess?.(executionId)).toEqual({ ok: false, code: "observer_mutation_forbidden" });
		expect(transport.operations).toEqual([]);
	});

	it("preserves the structured output cursor across the Host wire", async () => {
		const executionId = createRuntimeId("execution", "structured-cursor");
		const cursor: OutputCursor = { sequence: 3, byteOffset: 12 };
		const transport = new FakeTransport({
			"process.output": {
				ok: true,
				page: "tail",
				startCursor: cursor,
				endCursor: { sequence: 4, byteOffset: 16 },
				nextCursor: { sequence: 4, byteOffset: 16 },
				truncated: false,
				head: { sequence: 4, byteOffset: 16 },
			},
		});
		const client = createProductionProcessOverlayClient(transport, "session_structured_cursor", { isDriver: () => false });

		expect(await client.processOutput(executionId, cursor, 64)).toEqual({
			ok: true,
			text: "tail",
			startCursor: cursor,
			endCursor: { sequence: 4, byteOffset: 16 },
			nextCursor: { sequence: 4, byteOffset: 16 },
			truncated: false,
			head: { sequence: 4, byteOffset: 16 },
		});
	});

	it("preserves the typed earliest cursor when retention requires resync", async () => {
		const executionId = createRuntimeId("execution", "wire-resync");
		const earliestCursor: OutputCursor = { sequence: 8, byteOffset: 32 };
		const transport = new FakeTransport({
			"process.output": { ok: false, code: "output_cursor_resync_required", earliestCursor },
		});
		const client = createProductionProcessOverlayClient(transport, "session_wire_resync", { isDriver: () => false });

		expect(await client.processOutput(executionId, { sequence: 0, byteOffset: 0 }, 64)).toEqual({
			ok: false,
			code: "output_cursor_resync_required",
			earliestCursor,
		});
	});
});
