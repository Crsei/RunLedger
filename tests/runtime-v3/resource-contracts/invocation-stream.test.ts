import { describe, expect, it } from "vitest";
import { canonicalDigest } from "../../../src/runtime/protocol/v3/canonical-json.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/v3/ids.ts";
import { consumeResourceInvocation } from "../../../src/runtime/resources/invocation-stream.ts";
import type {
	RuntimeResourceInvocationFrame,
	RuntimeToolInvocation,
	RuntimeToolResult,
} from "../../../src/runtime/resources/types.ts";
import { authorizationContext, invocation } from "./fixtures.ts";

function result(request: RuntimeToolInvocation, terminalSequence: number): RuntimeToolResult {
	const content = [{ type: "text" as const, text: "done" }];
	return {
		schemaVersion: 1,
		...authorizationContext(),
		receiptId: createRuntimeId("receipt", `stream-${terminalSequence}`),
		requestId: request.requestId,
		handshakeDigest: request.handshake.handshakeDigest,
		invocationSequence: request.invocationSequence,
		terminalSequence,
		terminal: "completed",
		tool: request.tool,
		snapshotId: request.snapshotId,
		correlationId: request.correlationId,
		content,
		isError: false,
		originalBytes: 4,
		truncated: false,
		contentDigest: canonicalDigest(content),
	};
}

function terminal(request: RuntimeToolInvocation, sequence: number): RuntimeResourceInvocationFrame {
	return {
		schemaVersion: 1,
		...authorizationContext(),
		kind: "terminal",
		requestId: request.requestId,
		handshakeDigest: request.handshake.handshakeDigest,
		invocationSequence: request.invocationSequence,
		sequence,
		result: result(request, sequence),
	};
}

async function* frames(values: readonly RuntimeResourceInvocationFrame[]): AsyncIterable<RuntimeResourceInvocationFrame> {
	for (const value of values) yield value;
}

describe("resource invocation stream", () => {
	it("accepts bounded ordered progress followed by exactly one terminal", async () => {
		const request = invocation();
		const progress: RuntimeResourceInvocationFrame = {
			schemaVersion: 1,
			...authorizationContext(),
			kind: "progress",
			requestId: request.requestId,
			handshakeDigest: request.handshake.handshakeDigest,
			invocationSequence: 0,
			sequence: 0,
			messageDigest: canonicalDigest("working"),
			observedAt: "2026-07-22T00:00:00.000Z",
		};
		await expect(consumeResourceInvocation(request, frames([progress, terminal(request, 1)]))).resolves.toMatchObject({
			ok: true,
			result: { terminal: "completed", terminalSequence: 1 },
		});
	});

	it("fails closed on missing, duplicate, post-terminal, sequence-gap and stale-generation frames", async () => {
		const request = invocation();
		await expect(consumeResourceInvocation(request, frames([]))).resolves.toMatchObject({ ok: false });
		await expect(
			consumeResourceInvocation(request, frames([terminal(request, 0), terminal(request, 1)])),
		).resolves.toMatchObject({ ok: false });
		const postTerminal = terminal(request, 0);
		const progressAfter: RuntimeResourceInvocationFrame = {
			schemaVersion: 1,
			...authorizationContext(),
			kind: "progress",
			requestId: request.requestId,
			handshakeDigest: request.handshake.handshakeDigest,
			invocationSequence: 0,
			sequence: 1,
			messageDigest: canonicalDigest("late"),
			observedAt: "2026-07-22T00:00:00.000Z",
		};
		await expect(consumeResourceInvocation(request, frames([postTerminal, progressAfter]))).resolves.toMatchObject({ ok: false });
		await expect(consumeResourceInvocation(request, frames([terminal(request, 2)]))).resolves.toMatchObject({ ok: false });
		const stale = terminal(request, 0);
		if (stale.kind !== "terminal") throw new Error("fixture terminal missing");
		await expect(
			consumeResourceInvocation(request, frames([{ ...stale, handshakeDigest: canonicalDigest("stale") }])),
		).resolves.toMatchObject({ ok: false });
	});
});
