import { afterEach, describe, expect, test } from "vitest";
import {
	AUTH_GATEWAY_DEFAULT_IDLE_TIMEOUT_MS,
	AUTH_GATEWAY_DEFAULT_PORT,
	startAuthGatewayServer,
	type AuthGatewayServerHandle,
} from "../../src/auth-gateway/server.ts";

const openServers: AuthGatewayServerHandle[] = [];

afterEach(async () => {
	await Promise.all(openServers.splice(0).map((server) => server.close()));
});

async function open(options: Parameters<typeof startAuthGatewayServer>[0] = {}) {
	const server = await startAuthGatewayServer({ bindHost: "127.0.0.1", port: 0, token: "gateway-secret", ...options });
	openServers.push(server);
	return server;
}

function url(server: AuthGatewayServerHandle, path: string): string {
	return `http://127.0.0.1:${server.port}${path}`;
}

describe("auth-gateway HTTP shell", () => {
	test("serves an unauthenticated health check and applies the idle timeout", async () => {
		const server = await open();
		const response = await fetch(url(server, "/healthz"));

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ ok: true });
		expect(server.server.timeout).toBe(AUTH_GATEWAY_DEFAULT_IDLE_TIMEOUT_MS);
	});

	test("requires a case-insensitive Bearer scheme for protected routes", async () => {
		const server = await open();

		expect((await fetch(url(server, "/v1/models"))).status).toBe(401);
		expect((await fetch(url(server, "/v1/models"), { headers: { authorization: "Basic gateway-secret" } })).status).toBe(401);
		expect((await fetch(url(server, "/v1/models"), { headers: { authorization: "bearer wrong" } })).status).toBe(401);
		expect((await fetch(url(server, "/v1/models"), { headers: { authorization: "bearer gateway-secret" } })).status).toBe(501);
	});

	test("returns 404 for an authenticated unknown route", async () => {
		const server = await open();
		const response = await fetch(url(server, "/not-found"), { headers: { authorization: "Bearer gateway-secret" } });

		expect(response.status).toBe(404);
		expect(await response.json()).toMatchObject({ error: { type: "not_found" } });
	});

	test("allows no-auth only on loopback and does not require a header there", async () => {
		const server = await open({ noAuth: true });
		const response = await fetch(url(server, "/not-found"));

		expect(response.status).toBe(404);
		await expect(startAuthGatewayServer({ bindHost: "0.0.0.0", port: 0, noAuth: true })).rejects.toThrow(/loopback/i);
	});

	test("exposes the frozen default bind values", () => {
		expect(AUTH_GATEWAY_DEFAULT_PORT).toBe(4000);
		expect(AUTH_GATEWAY_DEFAULT_IDLE_TIMEOUT_MS).toBe(255_000);
	});
});
