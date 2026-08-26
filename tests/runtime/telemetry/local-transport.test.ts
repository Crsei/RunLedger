import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { createRuntimeId } from "../../../src/runtime/protocol/ids.ts";
import { createMcpExecutionEnvFetch } from "../../../src/extensions/mcp/sdk-factory.ts";
import type { Network, NetworkRequest, NetworkResponse } from "../../../src/runtime/execution-env.ts";
import { createWebFetchTool } from "../../../src/runtime/tools/web-fetch.ts";
import { stream as streamCodex } from "../../../src/api/openai-codex-responses.ts";
import type { Model } from "../../../src/types.ts";
import {
	assertDeclaredLocalTelemetryTransport,
	createLocalTelemetryContext,
	runWithLocalTelemetry,
	withMeteredNetworkRequest,
} from "../../../src/runtime/telemetry/local/provider.ts";
import { runWithProviderTelemetry } from "../../../src/utils/provider-fetch-context.ts";
import type { TelemetryObservation } from "../../../src/runtime/telemetry/local/types.ts";
import { createProductionTransportCoverageRegistry } from "../../../src/runtime/telemetry/local/coverage.ts";
import { findTelemetryInstrumentationViolations } from "../../../scripts/check-telemetry-transport-boundaries.ts";

function fixture() {
	const observations: TelemetryObservation[] = [];
	const correlation = {
		sessionId: createRuntimeId("session", "transport-test"),
		traceId: createRuntimeId("trace", "transport-test"),
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
			bind: async <T>(_correlation: typeof correlation, operation: () => Promise<T>) => operation(),
			currentCorrelation: () => correlation,
			forceSample: async () => undefined,
			close: async () => undefined,
		},
	};
}

describe("production local telemetry transport propagation", () => {
	test("meters a lazy provider fetch inside the provider scope", async () => {
		const sink = fixture();
		const fetchImpl: typeof fetch = async (_input, init) => new Response(
			new Uint8Array([1, 2, 3, 4]),
			{ headers: { "content-type": "text/event-stream" }, status: 200 },
		);
		const context = createLocalTelemetryContext(sink.port, sink.correlation, "llm_sse");

		vi.stubGlobal("fetch", fetchImpl);
		try {
			await runWithProviderTelemetry(context, async () => {
				const response = await fetch("https://provider.invalid/v1/stream", { method: "POST", body: "payload" });
				await response.arrayBuffer();
			});
		} finally {
			vi.unstubAllGlobals();
		}

		const traffic = sink.observations.filter((observation) => observation.kind === "traffic");
		expect(traffic.map((observation) => [observation.channel, observation.direction, observation.bytes])).toEqual([
			["llm_sse", "tx", expect.objectContaining({ availability: "available", value: 7 })],
			["llm_sse", "rx", expect.objectContaining({ availability: "available", value: 4 })],
		]);
	});

	test("classifies provider HTTP and SSE traffic from the actual response transport", async () => {
		const sink = fixture();
		let calls = 0;
		vi.stubGlobal("fetch", async () => {
			calls += 1;
			return calls === 1
				? new Response("json", { headers: { "content-type": "application/json" } })
				: new Response("data: done\n\n", { headers: { "content-type": "text/event-stream; charset=utf-8" } });
		});
		try {
			await runWithProviderTelemetry(createLocalTelemetryContext(sink.port, sink.correlation), async () => {
				await (await fetch("https://provider.invalid/v1/complete", { method: "POST", body: "one" })).arrayBuffer();
				await (await fetch("https://provider.invalid/v1/stream", { method: "POST", body: "two" })).arrayBuffer();
			});
		} finally {
			vi.unstubAllGlobals();
		}

		const traffic = sink.observations.filter((observation) => observation.kind === "traffic");
		expect(traffic.map((observation) => observation.channel)).toEqual([
			"llm_http", "llm_http", "llm_sse", "llm_sse",
		]);
	});

	test("meters governed Network bodies without persisting request metadata", async () => {
		const sink = fixture();
		const request: NetworkRequest = {
			url: "https://secret.invalid/path?token=do-not-store",
			method: "POST",
			headers: { authorization: "Bearer do-not-store" },
			body: "network-body",
			maxBytes: 1024,
		};
		const response: NetworkResponse = {
			status: 200,
			headers: {},
			body: Buffer.from("network-response"),
			finalUrl: request.url,
		};

		await withMeteredNetworkRequest(
			request,
			undefined,
			async () => response,
			sink.port,
		);

		const traffic = sink.observations.filter((observation) => observation.kind === "traffic");
		expect(traffic.map((observation) => [observation.channel, observation.direction])).toEqual([
			["governed_http", "tx"],
			["governed_http", "rx"],
		]);
		expect(traffic.map((observation) => observation.bytes)).toEqual([
			expect.objectContaining({ availability: "available", value: Buffer.byteLength("network-body") }),
			expect.objectContaining({ availability: "available", value: Buffer.byteLength("network-response") }),
		]);
		expect(JSON.stringify(sink.observations)).not.toContain("secret.invalid");
		expect(JSON.stringify(sink.observations)).not.toContain("do-not-store");
	});

	test("MCP execution-env fetch is classified as MCP HTTP and does not duplicate governed HTTP", async () => {
		const sink = fixture();
		const network: Network = {
			request: async (request) => ({
				status: 200,
				headers: { "content-type": "application/json" },
				body: Buffer.from("mcp-response"),
				finalUrl: request.url,
			}),
		};
		const fetch = createMcpExecutionEnvFetch(network);
		await runWithProviderTelemetry(createLocalTelemetryContext(sink.port, sink.correlation, "governed_http"), async () => {
			const response = await fetch("https://mcp.invalid", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0" }) });
			await response.arrayBuffer();
		});

		const traffic = sink.observations.filter((observation) => observation.kind === "traffic");
		expect(traffic.every((observation) => observation.channel === "mcp_http")).toBe(true);
		expect(traffic).toHaveLength(2);
	});

	test("governed WebFetch records response bytes only after the authorized Network returns", async () => {
		const sink = fixture();
		const tool = createWebFetchTool({
			network: {
				request: async () => ({ status: 200, headers: { "content-type": "text/plain" }, body: Buffer.from("web-response"), finalUrl: "https://web.invalid" }),
			},
		});
		await runWithLocalTelemetry(createLocalTelemetryContext(sink.port, sink.correlation, "llm_sse", "tool"), async () => {
			await tool.execute("tool_web", { url: "https://web.invalid", prompt: "summarize" }, new AbortController().signal);
		});

		const traffic = sink.observations.filter((observation) => observation.kind === "traffic");
		expect(traffic.map((observation) => [observation.channel, observation.direction])).toEqual([["governed_http", "tx"], ["governed_http", "rx"]]);
	});

	test("surfaces fail-closed telemetry when an authorized Network request also fails", async () => {
		const sink = fixture();
		const observationFailure = new Error("telemetry sink unavailable");
		sink.port.observe = async () => { throw observationFailure; };
		const originalFailure = new Error("authorized network failed");
		const request: NetworkRequest = {
			url: "https://network.invalid/failure",
			method: "GET",
			headers: {},
			maxBytes: 1024,
		};

		await expect(withMeteredNetworkRequest(
			request,
			undefined,
			async () => { throw originalFailure; },
			sink.port,
		)).rejects.toBe(observationFailure);
	});

	test("surfaces fail-closed telemetry after a successful governed Network response", async () => {
		const sink = fixture();
		const failure = new Error("telemetry sink unavailable");
		sink.port.observe = async () => { throw failure; };
		await expect(withMeteredNetworkRequest(
			{
				url: "https://network.invalid/success",
				method: "POST",
				headers: {},
				body: "request",
				maxBytes: 1024,
			},
			undefined,
			async () => ({ status: 200, headers: {}, body: Buffer.from("response"), finalUrl: "https://network.invalid/success" }),
			sink.port,
		)).rejects.toBe(failure);
	});

	test("Codex WebSocket production stream meters send and message payloads", async () => {
		const sink = fixture();
		const sent: string[] = [];
		class FakeWebSocket {
			public readonly readyState = 1;
			readonly #listeners = new Map<string, Set<(event: unknown) => void>>();
			public constructor(_url: string, _options?: unknown) {
				queueMicrotask(() => this.emit("open", {}));
			}
			public addEventListener(type: string, listener: (event: unknown) => void): void {
				const listeners = this.#listeners.get(type) ?? new Set();
				listeners.add(listener);
				this.#listeners.set(type, listeners);
			}
			public removeEventListener(type: string, listener: (event: unknown) => void): void {
				this.#listeners.get(type)?.delete(listener);
			}
			public send(data: string): void {
				sent.push(data);
				const message = JSON.stringify({
					type: "response.completed",
					response: { id: "response-telemetry", status: "completed", output: [], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } },
				});
				queueMicrotask(() => this.emit("message", { data: message }));
			}
			public close(): void { this.emit("close", { code: 1000, wasClean: true }); }
			private emit(type: string, event: unknown): void {
				for (const listener of this.#listeners.get(type) ?? []) listener(event);
			}
		}
		vi.stubGlobal("WebSocket", FakeWebSocket);
		const model = {
			id: "codex-telemetry",
			name: "Codex telemetry",
			api: "openai-codex-responses",
			provider: "openai-codex-telemetry",
			baseUrl: "https://codex.invalid/backend-api",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 4096,
			maxTokens: 128,
		} as Model<"openai-codex-responses">;
		const tokenPayload = Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "account-telemetry" } })).toString("base64");

		try {
			await runWithProviderTelemetry(createLocalTelemetryContext(sink.port, sink.correlation, "llm_sse"), async () => {
				const result = await streamCodex(model, { messages: [] }, {
					apiKey: `header.${tokenPayload}.signature`,
					transport: "websocket",
				}).result();
				expect(result.stopReason).toBe("stop");
			});
		} finally {
			vi.unstubAllGlobals();
		}

		const traffic = sink.observations.filter((observation) => observation.kind === "traffic" && observation.channel === "llm_websocket");
		expect(sent).toHaveLength(1);
		expect(traffic.map((observation) => observation.direction)).toEqual(["tx", "rx"]);
		expect(traffic[0]?.bytes).toMatchObject({ availability: "available", value: Buffer.byteLength(sent[0]!, "utf8") });
	});

	test("coverage inventory rejects a production transport that has no declaration", () => {
		expect(() => assertDeclaredLocalTelemetryTransport("llm_sse")).not.toThrow();
		expect(() => assertDeclaredLocalTelemetryTransport("new_provider_transport")).toThrow(/not declared/u);
	});

	test("production coverage is complete and does not claim an uninstrumented gateway as measured", () => {
		const registry = createProductionTransportCoverageRegistry();
		expect(() => registry.assertComplete()).not.toThrow();
		expect(registry.get("gateway")).toEqual({ transport: "gateway", state: "unavailable", reason: "transport_not_instrumented" });
		expect(registry.get("llm_sse")).toEqual({ transport: "llm_sse", state: "measured" });
	});

	test("static evidence gate detects a declared measured transport with no production meter", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-telemetry-boundary-"));
		try {
			await writeFile(join(root, "transport.ts"), "export const request = () => fetch('https://provider.invalid');\n", "utf8");
			const evidence = [{ transport: "llm_http" as const, file: "transport.ts", marker: "meteredProviderFetch(" }];
			expect(findTelemetryInstrumentationViolations(root, evidence)).toEqual([
				"transport.ts: llm_http is declared measured but marker meteredProviderFetch( is missing",
			]);
			await writeFile(join(root, "transport.ts"), "export const request = () => meteredProviderFetch(fetch, 'https://provider.invalid');\n", "utf8");
			expect(findTelemetryInstrumentationViolations(root, evidence)).toEqual([]);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
