import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { parseBearerToken, timingSafeTokenEqual } from "./token.ts";

export const AUTH_GATEWAY_DEFAULT_BIND_HOST = "127.0.0.1";
export const AUTH_GATEWAY_DEFAULT_PORT = 4000;
export const AUTH_GATEWAY_DEFAULT_IDLE_TIMEOUT_MS = 255_000;

const NOT_IMPLEMENTED_PATHS = new Set([
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
}

export interface AuthGatewayServerHandle {
	readonly server: Server;
	readonly bindHost: string;
	readonly port: number;
	close(): Promise<void>;
}

export function isLoopbackBindHost(host: string): boolean {
	const normalized = host.trim().toLowerCase();
	return normalized === "127.0.0.1" || normalized === "::1" || normalized === "[::1]" || normalized === "localhost";
}

export function validateAuthGatewayServerOptions(options: AuthGatewayServerOptions): Required<Pick<AuthGatewayServerOptions, "bindHost" | "port" | "noAuth" | "idleTimeoutMs">> & Pick<AuthGatewayServerOptions, "token"> {
	const bindHost = options.bindHost ?? AUTH_GATEWAY_DEFAULT_BIND_HOST;
	const port = options.port ?? AUTH_GATEWAY_DEFAULT_PORT;
	const noAuth = options.noAuth ?? false;
	const idleTimeoutMs = options.idleTimeoutMs ?? AUTH_GATEWAY_DEFAULT_IDLE_TIMEOUT_MS;
	if (bindHost.trim().length === 0) throw new Error("Auth gateway bind host must not be empty");
	if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error("Auth gateway bind port must be an integer from 0 to 65535");
	if (!Number.isInteger(idleTimeoutMs) || idleTimeoutMs <= 0) throw new Error("Auth gateway idle timeout must be a positive integer");
	if (noAuth && !isLoopbackBindHost(bindHost)) throw new Error("--no-auth requires a loopback bind host");
	if (!noAuth && (!options.token || options.token.length === 0)) throw new Error("Auth gateway bearer token is required unless --no-auth is enabled");
	return { bindHost, port, noAuth, idleTimeoutMs, ...(options.token === undefined ? {} : { token: options.token }) };
}

function writeJson(res: ServerResponse, status: number, body: Record<string, unknown>, headers: Record<string, string> = {}): void {
	const serialized = JSON.stringify(body);
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store",
		...headers,
	});
	res.end(serialized);
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

function createRequestHandler(options: Required<Pick<AuthGatewayServerOptions, "noAuth">> & Pick<AuthGatewayServerOptions, "token">): (req: IncomingMessage, res: ServerResponse) => void {
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

		if (NOT_IMPLEMENTED_PATHS.has(path)) {
			writeNotImplemented(res);
			return;
		}
		writeNotFound(res);
	};
}

/** Start the authenticated HTTP shell; domain dispatch is added by later gateway phases. */
export async function startAuthGatewayServer(options: AuthGatewayServerOptions = {}): Promise<AuthGatewayServerHandle> {
	const resolved = validateAuthGatewayServerOptions(options);
	const server = createServer(createRequestHandler(resolved));
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
		await closeServer(server);
		throw new Error("Auth gateway did not expose a TCP address");
	}

	return {
		server,
		bindHost: resolved.bindHost,
		port: address.port,
		close: () => closeServer(server),
	};
}

function closeServer(server: Server): Promise<void> {
	if (!server.listening) return Promise.resolve();
	return new Promise<void>((resolve, reject) => {
		server.close((error) => (error ? reject(error) : resolve()));
	});
}
