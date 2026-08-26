import { describe, expect, test } from "vitest";
import { createRuntimeId } from "../../../src/runtime/protocol/ids.ts";
import {
	createMeteredWebSocket,
	meteredFetch,
	meteredFetchWithRetry,
	recordProcessIo,
	type MeteredWebSocketLike,
} from "../../../src/runtime/telemetry/local/meter.ts";
import type { TelemetryObservation } from "../../../src/runtime/telemetry/local/types.ts";

function fixtureSink() {
	const observations: TelemetryObservation[] = [];
	const correlation = {
		sessionId: createRuntimeId("session", "meter-test"),
		traceId: createRuntimeId("trace", "meter-test"),
		ownerGeneration: 1,
	};
	return {
		observations,
		correlation,
		port: {
			observe: async (observation: TelemetryObservation) => {
				observations.push(observation);
				return { ok: true as const };
			},
			currentCorrelation: () => correlation,
		},
	};
}

function byteTotal(observations: readonly TelemetryObservation[], direction: "tx" | "rx"): number {
	return observations
		.filter((observation): observation is Extract<TelemetryObservation, { kind: "traffic" }> => observation.kind === "traffic" && observation.direction === direction)
		.reduce((total, observation) => total + (observation.bytes.availability === "available" ? observation.bytes.value : 0), 0);
}

describe("local telemetry application meters", () => {
	test("counts serialized request bytes and consumed decompressed response chunks exactly", async () => {
		const sink = fixtureSink();
		const requestBody = "请求😀";
		const responseBody = [new Uint8Array([0, 1, 2]), new TextEncoder().encode("响应😀")];
		const fetchImpl: typeof fetch = async (_input, init) => {
			expect(init?.body).toBe(requestBody);
			return new Response(new ReadableStream<Uint8Array>({
				start(controller) {
					for (const chunk of responseBody) controller.enqueue(chunk);
					controller.close();
				},
			}));
		};

		const response = await meteredFetch(fetchImpl, "https://example.invalid/secret", {
			method: "POST",
			body: requestBody,
		}, {
			port: sink.port,
			channel: "llm_sse",
		});
		expect((await response.arrayBuffer()).byteLength).toBe(3 + Buffer.byteLength("响应😀", "utf8"));

		expect(byteTotal(sink.observations, "tx")).toBe(Buffer.byteLength(requestBody, "utf8"));
		expect(byteTotal(sink.observations, "rx")).toBe(3 + Buffer.byteLength("响应😀", "utf8"));
		expect(JSON.stringify(sink.observations)).not.toContain("secret");
		expect(sink.observations.filter((observation) => observation.kind === "traffic").every((observation) => observation.transportAttempt === 1)).toBe(true);
	});

	test("surfaces a fail-closed recorder failure at an awaited fetch boundary", async () => {
		const failure = new Error("fail-closed telemetry write failed");
		const correlation = fixtureSink().correlation;
		const port = {
			observe: async (): Promise<never> => { throw failure; },
			currentCorrelation: () => correlation,
		};

		await expect(meteredFetch(
			async () => new Response("ok"),
			"https://example.invalid/fail-closed",
			{ method: "POST", body: "request" },
			{ port, channel: "llm_http" },
		)).rejects.toBe(failure);
	});

	test("fails the consumed response stream when the terminal RX observation is fail-closed", async () => {
		const failure = new Error("fail-closed response observation failed");
		const correlation = fixtureSink().correlation;
		let observations = 0;
		const response = await meteredFetch(
			async () => new Response("response"),
			"https://example.invalid/fail-closed-response",
			undefined,
			{
				channel: "llm_http",
				port: {
					currentCorrelation: () => correlation,
					observe: async () => {
						observations += 1;
						if (observations > 1) throw failure;
						return { ok: true as const };
					},
				},
			},
		);

		await expect(response.text()).rejects.toBe(failure);
	});

	test("counts the body of a Request instance without pre-reading it", async () => {
		const sink = fixtureSink();
		const requestBody = "Request body 请求😀";
		const request = new Request("https://example.invalid/request", {
			method: "POST",
			body: requestBody,
		});
		let observedInput: Request | undefined;
		const fetchImpl: typeof fetch = async (input, init) => {
			observedInput = input as Request;
			const body = init?.body ?? (input as Request).body;
			if (body instanceof ReadableStream) {
				await new Response(body).arrayBuffer();
			} else {
				await (input as Request).arrayBuffer();
			}
			return new Response(new Uint8Array());
		};

		await meteredFetch(fetchImpl, request, undefined, {
			port: sink.port,
			channel: "llm_http",
		});

		expect(observedInput).toBe(request);
		expect(byteTotal(sink.observations, "tx")).toBe(Buffer.byteLength(requestBody, "utf8"));
	});

	test("classifies a streamed provider request from the actual response transport", async () => {
		const sink = fixtureSink();
		const requestBody = new TextEncoder().encode("streamed provider request");
		const response = await meteredFetch(
			async (_input, init) => {
				await new Response(init?.body).arrayBuffer();
				return new Response("json", { headers: { "content-type": "application/json" } });
			},
			"https://example.invalid/provider-streamed-request",
			{
				method: "POST",
				body: new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(requestBody);
						controller.close();
					},
				}),
			},
			{
				port: sink.port,
				channel: "llm_sse",
				classifyProviderTransport: true,
			},
		);
		await response.arrayBuffer();

		const traffic = sink.observations.filter((observation) => observation.kind === "traffic");
		expect(traffic.map((observation) => [observation.channel, observation.direction])).toEqual([
			["llm_http", "tx"],
			["llm_http", "rx"],
		]);
		expect(byteTotal(sink.observations, "tx")).toBe(requestBody.byteLength);
	});

	test("retains bytes consumed before an aborted response and does not pre-read the stream", async () => {
		const sink = fixtureSink();
		let pullCount = 0;
		const fetchImpl: typeof fetch = async () => new Response(new ReadableStream<Uint8Array>({
			pull(controller) {
				pullCount += 1;
				controller.enqueue(new Uint8Array([1, 2, 3]));
				if (pullCount > 1) controller.enqueue(new Uint8Array([4, 5, 6]));
			},
		}));

		const response = await meteredFetch(fetchImpl, "https://example.invalid/stream", undefined, {
			port: sink.port,
			channel: "llm_sse",
		});
		const reader = response.body!.getReader();
		await reader.read();
		await reader.cancel("test abort");

		const rx = sink.observations.filter((observation) => observation.kind === "traffic" && observation.direction === "rx");
		expect(rx).toHaveLength(1);
		expect(rx[0]!.terminal).toBe("aborted");
		expect(rx[0]!.bytes).toMatchObject({ availability: "available", value: 3 });
		expect(pullCount).toBeLessThan(3);
	});

	test("records every retry as an independent transport attempt", async () => {
		const sink = fixtureSink();
		let calls = 0;
		const fetchImpl: typeof fetch = async () => {
			calls += 1;
			if (calls === 1) throw new Error("temporary network failure");
			return new Response(new Uint8Array([7, 8]));
		};

		const response = await meteredFetchWithRetry(fetchImpl, "https://example.invalid/retry", {
			method: "POST",
			body: "retry-body",
		}, {
			port: sink.port,
			channel: "llm_http",
			maxAttempts: 2,
		});
		expect((await response.arrayBuffer()).byteLength).toBe(2);
		const traffic = sink.observations.filter((observation) => observation.kind === "traffic");
		expect(traffic.map((observation) => observation.transportAttempt)).toEqual([1, 2, 2]);
		expect(traffic.filter((observation) => observation.direction === "tx")).toHaveLength(2);
	});

	test("counts WebSocket send and message payloads without frame or URL data", () => {
		const sink = fixtureSink();
		const listeners = new Map<string, Set<(event: unknown) => void>>();
		const raw: MeteredWebSocketLike = {
			send() {},
			close() {},
			addEventListener(type, listener) {
				const set = listeners.get(type) ?? new Set();
				set.add(listener);
				listeners.set(type, set);
			},
			removeEventListener(type, listener) { listeners.get(type)?.delete(listener); },
		};
		const sent: unknown[] = [];
		raw.send = (data) => sent.push(data);
		const socket = createMeteredWebSocket(raw, { port: sink.port, channel: "llm_websocket" });
		socket.send("😀");
		for (const listener of listeners.get("message") ?? []) listener({ data: new Uint8Array([1, 2, 3, 4]) });

		expect(sent).toEqual(["😀"]);
		expect(byteTotal(sink.observations, "tx")).toBe(Buffer.byteLength("😀", "utf8"));
		expect(byteTotal(sink.observations, "rx")).toBe(4);
		expect(JSON.stringify(sink.observations)).not.toContain("example.invalid");
	});

	test("replaces the telemetry listener when a cached WebSocket is metered for a later request", async () => {
		const first = fixtureSink();
		const second = fixtureSink();
		const listeners = new Map<string, Set<(event: unknown) => void>>();
		const raw: MeteredWebSocketLike = {
			send() {},
			close() {},
			addEventListener(type, listener) {
				const set = listeners.get(type) ?? new Set();
				set.add(listener);
				listeners.set(type, set);
			},
			removeEventListener(type, listener) { listeners.get(type)?.delete(listener); },
		};

		createMeteredWebSocket(raw, { port: first.port, correlation: first.correlation, channel: "llm_websocket" });
		createMeteredWebSocket(raw, { port: second.port, correlation: second.correlation, channel: "llm_websocket" });
		for (const listener of listeners.get("message") ?? []) listener({ data: "one response" });
		await new Promise<void>((resolve) => queueMicrotask(resolve));

		expect(first.observations.filter((value) => value.kind === "traffic" && value.direction === "rx")).toHaveLength(0);
		expect(second.observations.filter((value) => value.kind === "traffic" && value.direction === "rx")).toHaveLength(1);
	});

	test("separates observed process bytes from retained output bytes", async () => {
		const sink = fixtureSink();
		await recordProcessIo(sink.port, {
			stream: "stdout",
			observedBytes: 17,
			retainedBytes: 5,
			executionId: createRuntimeId("execution", "meter-test"),
		});
		const observation = sink.observations[0];
		expect(observation?.kind).toBe("process_io");
		if (observation?.kind !== "process_io") return;
		expect(observation.observedBytes).toMatchObject({ availability: "available", value: 17 });
		expect(observation.retainedBytes).toMatchObject({ availability: "available", value: 5 });
	});
});
