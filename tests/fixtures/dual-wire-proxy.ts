import { createServer, type IncomingHttpHeaders, type Server, type ServerResponse } from "node:http";
import type { ProxyWire } from "../../src/providers/proxy-discovery.ts";

export interface DualWireProxyObservation {
	readonly method: string;
	readonly url: string;
	readonly wire: ProxyWire | "models" | "unknown";
	readonly headers: IncomingHttpHeaders;
	readonly body: string;
}
export interface DualWireProxy {
	readonly baseUrl: string;
	readonly observations: DualWireProxyObservation[];
	close(): Promise<void>;
}

export interface DualWireProxyOptions {
	readonly acceptedWire: ProxyWire;
	readonly modelId?: string;
}

function wireForPath(pathname: string): DualWireProxyObservation["wire"] {
	if (pathname === "/v1/messages") return "anthropic-messages";
	if (pathname === "/v1/chat/completions") return "openai-completions";
	if (pathname === "/v1/models") return "models";
	return "unknown";
}

function requestIsStreaming(body: string): boolean {
	try {
		const parsed = JSON.parse(body) as { stream?: unknown };
		return parsed.stream === true;
	} catch {
		return false;
	}
}

function openAiStream(): string {
	return [
		`data: ${JSON.stringify({
			id: "chatcmpl-fixture",
			object: "chat.completion.chunk",
			created: 1,
			model: "fixture-model",
			choices: [{ index: 0, delta: { role: "assistant", content: "fixture-openai" }, finish_reason: null }],
		})}`,
		`data: ${JSON.stringify({
			id: "chatcmpl-fixture",
			object: "chat.completion.chunk",
			created: 1,
			model: "fixture-model",
			choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
		})}`,
		"data: [DONE]",
	].join("\n\n") + "\n\n";
}

function anthropicStream(): string {
	const events = [
		[
			"event: message_start",
			`data: ${JSON.stringify({
				type: "message_start",
				message: {
					id: "msg_fixture",
					type: "message",
					role: "assistant",
					model: "fixture-model",
					content: [],
					stop_reason: null,
					stop_sequence: null,
					usage: { input_tokens: 0, output_tokens: 0 },
				},
			})}`,
		],
		[
			"event: content_block_start",
			`data: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}`,
		],
		[
			"event: content_block_delta",
			`data: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "fixture-anthropic" } })}`,
		],
		["event: content_block_stop", `data: ${JSON.stringify({ type: "content_block_stop", index: 0 })}`],
		[
			"event: message_delta",
			`data: ${JSON.stringify({
				type: "message_delta",
				delta: { stop_reason: "end_turn", stop_sequence: null },
				usage: { output_tokens: 1 },
			})}`,
		],
		["event: message_stop", `data: ${JSON.stringify({ type: "message_stop" })}`],
	];
	return events.map((lines) => lines.join("\n")).join("\n\n") + "\n\n";
}

function respond(
	response: ServerResponse,
	status: number,
	body: string,
	contentType: "application/json" | "text/event-stream",
): void {
	response.writeHead(status, {
		"content-type": contentType,
		connection: "close",
	});
	response.end(body);
}

export async function startDualWireProxy(options: DualWireProxyOptions): Promise<DualWireProxy> {
	const observations: DualWireProxyObservation[] = [];
	const modelId = options.modelId ?? "fixture-model";
	const server: Server = createServer((request, response) => {
		const chunks: Buffer[] = [];
		request.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
		request.on("end", () => {
			const pathname = new URL(request.url ?? "/", "http://runledger-fixture").pathname;
			const wire = wireForPath(pathname);
			const body = Buffer.concat(chunks).toString("utf8");
			observations.push({
				method: request.method ?? "",
				url: pathname,
				wire,
				headers: request.headers,
				body,
			});

			if (wire === "models" && request.method === "GET") {
				respond(response, 200, JSON.stringify({ data: [{ id: modelId, name: "Fixture Model" }] }), "application/json");
				return;
			}
			if (wire !== "anthropic-messages" && wire !== "openai-completions") {
				respond(response, 404, JSON.stringify({ error: { message: "fixture route not found" } }), "application/json");
				return;
			}
			if (wire !== options.acceptedWire) {
				respond(response, 401, JSON.stringify({ error: { message: "fixture wire not accepted" } }), "application/json");
				return;
			}
			if (!requestIsStreaming(body)) {
				respond(response, 200, JSON.stringify({ ok: true }), "application/json");
				return;
			}
			respond(response, 200, wire === "anthropic-messages" ? anthropicStream() : openAiStream(), "text/event-stream");
		});
	});

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	if (!address || typeof address === "string") {
		await new Promise<void>((resolve) => server.close(() => resolve()));
		throw new Error("Dual-wire proxy fixture did not bind to an ephemeral port");
	}

	return {
		baseUrl: `http://127.0.0.1:${address.port}`,
		observations,
		close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
	};
}
