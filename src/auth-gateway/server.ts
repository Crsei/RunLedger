import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { ModelsError, type Models } from "../models.ts";
import type { AuthResult } from "../auth/types.ts";
import type { Api, AssistantMessageEvent, Model, SimpleStreamOptions } from "../types.ts";
import { GatewayCodecError, type GatewayEventSource, type GatewayRequest } from "./codecs/shared.ts";
import { decodeRequest as decodeChatRequest, encodeStream as encodeChatStream } from "./codecs/chat-completions.ts";
import { decodeRequest as decodeMessagesRequest, encodeStream as encodeMessagesStream } from "./codecs/messages.ts";
import { decodeRequest as decodeResponsesRequest, encodeStream as encodeResponsesStream } from "./codecs/responses.ts";
import { decodeRequest as decodePiRequest, encodeStream as encodePiStream } from "./codecs/pi-messages.ts";
import { parseBearerToken, timingSafeTokenEqual } from "./token.ts";

export const AUTH_GATEWAY_DEFAULT_BIND_HOST = "127.0.0.1";
export const AUTH_GATEWAY_DEFAULT_PORT = 4000;
export const AUTH_GATEWAY_DEFAULT_IDLE_TIMEOUT_MS = 255_000;
export const AUTH_GATEWAY_MAX_REQUEST_BODY_BYTES = 4 * 1024 * 1024;

const SUPPORTED_PATHS = new Set([
	"/v1/models",
	"/v1/chat/completions",
	"/v1/messages",
	"/v1/responses",
	"/messages",
	"/v1/pi/stream",
]);

export interface AuthGatewayServerOptions {
	readonly bindHost?: string;
	readonly port?: number;
	readonly token?: string;
	readonly noAuth?: boolean;
	readonly idleTimeoutMs?: number;
	readonly models?: Models;
}

export interface AuthGatewayServerHandle {
	readonly server: Server;
	readonly bindHost: string;
	readonly port: number;
	close(): Promise<void>;
}

type GatewayWire = "chat-completions" | "messages" | "responses" | "pi-messages";

interface GatewayCodec {
	decodeRequest(body: unknown): GatewayRequest;
	encodeStream(source: GatewayEventSource): AsyncIterable<string>;
}

const CODECS: Record<GatewayWire, GatewayCodec> = {
	"chat-completions": { decodeRequest: decodeChatRequest, encodeStream: encodeChatStream },
	messages: { decodeRequest: decodeMessagesRequest, encodeStream: encodeMessagesStream },
	responses: { decodeRequest: decodeResponsesRequest, encodeStream: encodeResponsesStream },
	"pi-messages": { decodeRequest: decodePiRequest, encodeStream: encodePiStream },
};

class GatewayModelNotFoundError extends Error {
	readonly code = "model_not_found";

	constructor(model: string) {
		super(`Model not found: ${model}`);
		this.name = "GatewayModelNotFoundError";
	}
}

class GatewayAmbiguousModelError extends Error {
	readonly code = "ambiguous_model";

	constructor(model: string) {
		super(`Model id is ambiguous; use provider/model: ${model}`);
		this.name = "GatewayAmbiguousModelError";
	}
}

function wireForPath(path: string): GatewayWire | undefined {
	if (path === "/v1/chat/completions") return "chat-completions";
	if (path === "/v1/messages") return "messages";
	if (path === "/v1/responses") return "responses";
	if (path === "/messages" || path === "/v1/pi/stream") return "pi-messages";
	return undefined;
}

async function providerModel(models: Models, requested: string): Promise<Model<Api> | undefined> {
	const separator = requested.indexOf("/");
	if (separator > 0) {
		const providerId = requested.slice(0, separator);
		if (models.getProvider(providerId) !== undefined) {
			return models.getModel(providerId, requested.slice(separator + 1));
		}
	}
	const matches = models.getModels().filter((model) => model.id === requested);
	if (matches.length > 1) {
		const available = (await models.getAvailable()).filter((model) => model.id === requested);
		if (available.length === 1) return available[0];
		throw new GatewayAmbiguousModelError(requested);
	}
	return matches[0];
}

export function isLoopbackBindHost(host: string): boolean {
	const normalized = host.trim().toLowerCase();
	return normalized === "127.0.0.1" || normalized === "::1" || normalized === "[::1]" || normalized === "localhost";
}

export function validateAuthGatewayServerOptions(options: AuthGatewayServerOptions): Required<Pick<AuthGatewayServerOptions, "bindHost" | "port" | "noAuth" | "idleTimeoutMs">> & Pick<AuthGatewayServerOptions, "token" | "models"> {
	const bindHost = options.bindHost ?? AUTH_GATEWAY_DEFAULT_BIND_HOST;
	const port = options.port ?? AUTH_GATEWAY_DEFAULT_PORT;
	const noAuth = options.noAuth ?? false;
	const idleTimeoutMs = options.idleTimeoutMs ?? AUTH_GATEWAY_DEFAULT_IDLE_TIMEOUT_MS;
	if (bindHost.trim().length === 0) throw new Error("Auth gateway bind host must not be empty");
	if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error("Auth gateway bind port must be an integer from 0 to 65535");
	if (!Number.isInteger(idleTimeoutMs) || idleTimeoutMs <= 0) throw new Error("Auth gateway idle timeout must be a positive integer");
	if (noAuth && !isLoopbackBindHost(bindHost)) throw new Error("--no-auth requires a loopback bind host");
	if (!noAuth && (!options.token || options.token.length === 0)) throw new Error("Auth gateway bearer token is required unless --no-auth is enabled");
	return {
		bindHost,
		port,
		noAuth,
		idleTimeoutMs,
		...(options.token === undefined ? {} : { token: options.token }),
		...(options.models === undefined ? {} : { models: options.models }),
	};
}

function writeJson(res: ServerResponse, status: number, body: Record<string, unknown>, headers: Record<string, string> = {}): void {
	if (res.destroyed || res.writableEnded) return;
	const serialized = JSON.stringify(body);
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store",
		...headers,
	});
	res.end(serialized);
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
	const contentLength = req.headers["content-length"];
	if (contentLength !== undefined && Number.isFinite(Number(contentLength)) && Number(contentLength) > AUTH_GATEWAY_MAX_REQUEST_BODY_BYTES) {
		throw new GatewayCodecError("request body is too large");
	}

	return new Promise<unknown>((resolve, reject) => {
		const chunks: Buffer[] = [];
		let size = 0;
		let settled = false;
		const finish = (callback: () => void): void => {
			if (settled) return;
			settled = true;
			req.removeListener("data", onData);
			req.removeListener("end", onEnd);
			req.removeListener("error", onError);
			req.removeListener("aborted", onAborted);
			callback();
		};
		const onData = (chunk: Buffer | string): void => {
			const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
			size += buffer.byteLength;
			if (size > AUTH_GATEWAY_MAX_REQUEST_BODY_BYTES) {
				finish(() => reject(new GatewayCodecError("request body is too large")));
			}
			else chunks.push(buffer);
		};
		const onEnd = (): void => {
			finish(() => {
				try {
					resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown);
				} catch {
					reject(new GatewayCodecError("request body must contain valid JSON"));
				}
			});
		};
		const onError = (): void => finish(() => reject(new GatewayCodecError("request body could not be read")));
		const onAborted = (): void => finish(() => reject(new GatewayCodecError("request was aborted")));
		req.on("data", onData);
		req.on("end", onEnd);
		req.on("error", onError);
		req.on("aborted", onAborted);
	});
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function authSecretValues(auth: AuthResult): string[] {
	return [
		auth.auth.apiKey,
		...Object.values(auth.auth.headers ?? {}).filter((value): value is string => value !== null),
		...Object.values(auth.env ?? {}),
	].filter((value): value is string => value !== undefined && value.length > 0);
}

function redactSecrets(message: string, secrets: readonly string[]): string {
	return secrets.reduce((current, secret) => {
		const encoded = JSON.stringify(secret).slice(1, -1);
		return current.replaceAll(encoded, "[redacted]").replaceAll(secret, "[redacted]");
	}, message);
}

function errorCode(error: unknown): string {
	if (error instanceof GatewayModelNotFoundError) return error.code;
	if (error instanceof GatewayAmbiguousModelError) return error.code;
	if (error instanceof GatewayCodecError) return "invalid_request";
	if (error instanceof ModelsError) return error.code;
	return "upstream_error";
}

function errorStatus(error: unknown): number {
	if (error instanceof GatewayModelNotFoundError) return 404;
	if (error instanceof GatewayAmbiguousModelError) return 400;
	if (error instanceof GatewayCodecError) return 400;
	if (error instanceof ModelsError) {
		if (error.code === "auth") return 401;
		if (error.code === "model_source" || error.code === "model_validation") return 400;
	}
	return 502;
}

function writeWireError(res: ServerResponse, wire: GatewayWire, status: number, message: string, code: string): void {
	if (wire === "messages") {
		writeJson(res, status, { type: "error", error: { type: status === 400 ? "invalid_request_error" : status === 401 ? "authentication_error" : "api_error", message, code } });
		return;
	}
	if (wire === "pi-messages") {
		writeJson(res, status, { error: { message, code } });
		return;
	}
	writeJson(res, status, { error: { message, type: status === 400 ? "invalid_request_error" : status === 401 ? "authentication_error" : "upstream_error", code } });
}

function writeGatewayFailure(res: ServerResponse, wire: GatewayWire, error: unknown): void {
	writeWireError(res, wire, errorStatus(error), errorMessage(error), errorCode(error));
}

function writeUpstreamFailure(res: ServerResponse, wire: GatewayWire, message: string, secrets: readonly string[] = []): void {
	writeWireError(res, wire, 502, redactSecrets(message, secrets), "upstream_error");
}

function writeModels(res: ServerResponse, models: readonly Model<Api>[]): void {
	const modelIdCounts = new Map<string, number>();
	for (const model of models) modelIdCounts.set(model.id, (modelIdCounts.get(model.id) ?? 0) + 1);
	writeJson(res, 200, {
		object: "list",
		data: models.map((model) => ({
			id: (modelIdCounts.get(model.id) ?? 0) > 1 ? `${model.provider}/${model.id}` : model.id,
			object: "model",
			owned_by: model.provider,
		})),
	});
}

function writeHealth(res: ServerResponse): void {
	writeJson(res, 200, { ok: true });
}

function writeUnauthorized(res: ServerResponse): void {
	writeJson(
		res,
		401,
		{ error: { type: "authentication_error", message: "Invalid or missing bearer token", code: "invalid_api_key" } },
		{ "www-authenticate": "Bearer" },
	);
}

function writeNotFound(res: ServerResponse): void {
	writeJson(res, 404, { error: { type: "not_found", message: "Route not found" } });
}

function writeNotImplemented(res: ServerResponse): void {
	writeJson(res, 501, { error: { type: "not_implemented", message: "Auth gateway route is not implemented yet" } });
}

function requestPath(req: IncomingMessage): string {
	try {
		return new URL(req.url ?? "/", "http://runledger.invalid").pathname;
	} catch {
		return "/";
	}
}

async function* prependEvent(first: AssistantMessageEvent, iterator: AsyncIterator<AssistantMessageEvent>): AsyncGenerator<AssistantMessageEvent> {
	yield first;
	while (true) {
		const next = await iterator.next();
		if (next.done) return;
		yield next.value;
	}
}

function attachAbortSignal(req: IncomingMessage, res: ServerResponse, controller: AbortController): () => void {
	const abort = () => controller.abort();
	const abortOnClose = () => {
		if (!res.writableEnded) controller.abort();
	};
	req.once("aborted", abort);
	res.once("close", abortOnClose);
	return () => {
		req.removeListener("aborted", abort);
		res.removeListener("close", abortOnClose);
	};
}

async function dispatchGatewayRequest(
	req: IncomingMessage,
	res: ServerResponse,
	models: Models,
	wire: GatewayWire,
	activeRequests: Set<AbortController>,
): Promise<void> {
	const codec = CODECS[wire];
	let decoded: GatewayRequest;
	try {
		decoded = codec.decodeRequest(await readJsonBody(req));
	} catch (error) {
		writeGatewayFailure(res, wire, error);
		return;
	}

	const model = await providerModel(models, decoded.model);
	if (model === undefined) {
		writeGatewayFailure(res, wire, new GatewayModelNotFoundError(decoded.model));
		return;
	}

	let secrets: readonly string[] = [];
	try {
		const auth = await models.getAuth(model);
		if (auth === undefined) {
			writeGatewayFailure(res, wire, new ModelsError("auth", `Provider is not configured: ${model.provider}`));
			return;
		}
		secrets = authSecretValues(auth);
	} catch (error) {
		writeGatewayFailure(res, wire, error);
		return;
	}

	const controller = new AbortController();
	activeRequests.add(controller);
	const detachAbort = attachAbortSignal(req, res, controller);
	let stream: AsyncIterable<AssistantMessageEvent>;
	try {
		stream = models.streamSimple(
			model,
			decoded.context,
			{ ...decoded.options, signal: controller.signal } as SimpleStreamOptions,
		);
	} catch (error) {
		detachAbort();
		activeRequests.delete(controller);
		writeWireError(res, wire, errorStatus(error), redactSecrets(errorMessage(error), secrets), errorCode(error));
		return;
	}

	try {
		const iterator = stream[Symbol.asyncIterator]();
		const first = await iterator.next();
		if (first.done || first.value === undefined) {
			writeUpstreamFailure(res, wire, "Provider stream ended without a response", secrets);
			return;
		}
		if (first.value.type === "error") {
			writeUpstreamFailure(res, wire, first.value.error.errorMessage ?? "Provider request failed", secrets);
			return;
		}

		res.writeHead(200, {
			"content-type": "text/event-stream; charset=utf-8",
			"cache-control": "no-cache, no-transform",
			connection: "keep-alive",
		});
		for await (const line of codec.encodeStream(prependEvent(first.value, iterator))) {
			if (res.destroyed) break;
			res.write(redactSecrets(line, secrets));
		}
		if (!res.writableEnded && !res.destroyed) res.end();
	} catch (error) {
		if (!res.headersSent) writeWireError(res, wire, errorStatus(error), redactSecrets(errorMessage(error), secrets), errorCode(error));
		else if (!res.writableEnded && !res.destroyed) res.end();
	} finally {
		detachAbort();
		activeRequests.delete(controller);
	}
}

function createRequestHandler(
	options: Required<Pick<AuthGatewayServerOptions, "noAuth">> & Pick<AuthGatewayServerOptions, "token" | "models">,
	activeRequests: Set<AbortController>,
): (req: IncomingMessage, res: ServerResponse) => void {
	return (req, res) => {
		const path = requestPath(req);
		if (path === "/healthz") {
			if (req.method !== "GET") {
				writeJson(res, 405, { error: { type: "method_not_allowed", message: "Only GET is supported" } }, { allow: "GET" });
				return;
			}
			writeHealth(res);
			return;
		}

		if (!options.noAuth) {
			const presented = parseBearerToken(req.headers.authorization);
			if (presented === undefined || options.token === undefined || !timingSafeTokenEqual(options.token, presented)) {
				writeUnauthorized(res);
				return;
			}
		}

		if (path === "/v1/models") {
			if (req.method !== "GET") {
				writeJson(res, 405, { error: { type: "method_not_allowed", message: "Only GET is supported" } }, { allow: "GET" });
				return;
			}
			if (options.models === undefined) {
				writeNotImplemented(res);
				return;
			}
			void options.models.getAvailable().then((models) => writeModels(res, models)).catch((error: unknown) => writeGatewayFailure(res, "chat-completions", error));
			return;
		}

		const wire = wireForPath(path);
		if (wire !== undefined) {
			if (req.method !== "POST") {
				writeJson(res, 405, { error: { type: "method_not_allowed", message: "Only POST is supported" } }, { allow: "POST" });
				return;
			}
			if (options.models === undefined) {
				writeNotImplemented(res);
				return;
			}
			void dispatchGatewayRequest(req, res, options.models, wire, activeRequests).catch((error: unknown) => {
				if (!res.headersSent) writeGatewayFailure(res, wire, error);
				else if (!res.writableEnded && !res.destroyed) res.end();
			});
			return;
		}

		if (SUPPORTED_PATHS.has(path)) {
			writeNotImplemented(res);
			return;
		}
		writeNotFound(res);
	};
}

/** Start the authenticated HTTP gateway and its model/provider dispatch. */
export async function startAuthGatewayServer(options: AuthGatewayServerOptions = {}): Promise<AuthGatewayServerHandle> {
	const resolved = validateAuthGatewayServerOptions(options);
	const activeRequests = new Set<AbortController>();
	const server = createServer(createRequestHandler(resolved, activeRequests));
	server.timeout = resolved.idleTimeoutMs;
	server.requestTimeout = 0;
	server.headersTimeout = Math.max(resolved.idleTimeoutMs + 5_000, 60_000);

	await new Promise<void>((resolve, reject) => {
		const onError = (error: Error) => {
			server.removeListener("listening", onListening);
			reject(error);
		};
		const onListening = () => {
			server.removeListener("error", onError);
			resolve();
		};
		server.once("error", onError);
		server.once("listening", onListening);
		server.listen(resolved.port, resolved.bindHost);
	});

	const address = server.address();
	if (address === null || typeof address === "string") {
		await closeServer(server, activeRequests);
		throw new Error("Auth gateway did not expose a TCP address");
	}

	return {
		server,
		bindHost: resolved.bindHost,
		port: address.port,
		close: () => closeServer(server, activeRequests),
	};
}

function closeServer(server: Server, activeRequests: Set<AbortController>): Promise<void> {
	for (const controller of activeRequests) controller.abort(new Error("Auth gateway is shutting down"));
	if (!server.listening) return Promise.resolve();
	return new Promise<void>((resolve, reject) => {
		server.close((error) => (error ? reject(error) : resolve()));
	});
}
