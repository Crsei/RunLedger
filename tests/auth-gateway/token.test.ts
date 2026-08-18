import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
	authGatewayTokenPath,
	ensureAuthGatewayToken,
	regenerateAuthGatewayToken,
	timingSafeTokenEqual,
} from "../../src/auth-gateway/token.ts";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("auth-gateway token storage", () => {
	test("creates a random token with private file permissions and preserves it on ensure", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-auth-gateway-token-"));
		roots.push(root);
		const path = authGatewayTokenPath(root);

		const first = await ensureAuthGatewayToken(path);
		const second = await ensureAuthGatewayToken(path);
		const file = await stat(path);

		expect(first).toMatch(/^[A-Za-z0-9_-]{40,}$/u);
		expect(second).toBe(first);
		expect(await readFile(path, "utf8")).toBe(first + "\n");
		expect(file.mode & 0o777).toBe(0o600);
	});

	test("regenerates a token without weakening file permissions", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-auth-gateway-token-"));
		roots.push(root);
		const path = authGatewayTokenPath(root);

		const first = await ensureAuthGatewayToken(path);
		const second = await regenerateAuthGatewayToken(path);
		const file = await stat(path);

		expect(second).not.toBe(first);
		expect(await readFile(path, "utf8")).toBe(second + "\n");
		expect(file.mode & 0o777).toBe(0o600);
	});

	test("compares bearer secrets in constant time without accepting different lengths", () => {
		expect(timingSafeTokenEqual("secret", "secret")).toBe(true);
		expect(timingSafeTokenEqual("secret", "Secret")).toBe(false);
		expect(timingSafeTokenEqual("secret", "secret-extra")).toBe(false);
	});
});
