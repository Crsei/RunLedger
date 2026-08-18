import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { createModels } from "../../src/models.ts";
import {
	loadConfiguredProxyProviders,
	registerConfiguredProxyProviders,
	registerConfiguredProxyProvidersFromHome,
} from "../../src/providers/configured-proxy.ts";

const temporaryRoots: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function writeConfig(value: unknown): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "runledger-proxy-config-"));
	temporaryRoots.push(root);
	const path = join(root, "models.json");
	await writeFile(path, JSON.stringify(value), { mode: 0o600 });
	return path;
}

describe("canonical models.json proxy loader", () => {
	test("loads only proxy discovery providers from an explicit file", async () => {
		const path = await writeConfig({
			providers: {
				"team-proxy": {
					name: "Team Proxy",
					baseUrl: "https://models.example.test/v1",
					apiKey: "TEAM_PROXY_API_KEY",
					authHeader: true,
					disableStrictTools: true,
					discovery: { type: "proxy" },
				},
			},
		});

		const providers = await loadConfiguredProxyProviders({ path });

		expect(providers).toHaveLength(1);
		expect(providers[0]).toMatchObject({ id: "team-proxy", name: "Team Proxy", baseUrl: "https://models.example.test/v1" });
	});

	test("missing canonical config is an empty optional provider set", async () => {
		const providers = await loadConfiguredProxyProviders({ path: "/tmp/runledger-no-such-models-json" });
		expect(providers).toEqual([]);
	});

	test("fails closed on malformed, unsupported, and colliding provider entries", async () => {
		const malformed = await writeConfig({ providers: [] });
		await expect(loadConfiguredProxyProviders({ path: malformed })).rejects.toThrow(/providers/i);

		const unsupported = await writeConfig({ providers: { other: { baseUrl: "https://example.test", api: "openai-completions" } } });
		await expect(loadConfiguredProxyProviders({ path: unsupported })).rejects.toThrow(/discovery|proxy/i);

		const colliding = await writeConfig({
			providers: { anthropic: { baseUrl: "https://example.test", discovery: { type: "proxy" } } },
		});
		const providers = await loadConfiguredProxyProviders({ path: colliding });
		const models = createModels();
		models.setProvider({ id: "anthropic", name: "built-in", auth: {}, getModels: () => [], stream: () => { throw new Error("unused"); }, streamSimple: () => { throw new Error("unused"); } });
		// The test uses the real built-in conflict guard; no configured provider replaces an existing id.
		await expect(Promise.resolve().then(() => registerConfiguredProxyProviders(models, providers))).rejects.toThrow(/conflict/i);
	});

	test("registers the canonical user-home models.json path", async () => {
		const path = await writeConfig({
			providers: {
				"team-proxy": {
					name: "Team Proxy",
					baseUrl: "https://models.example.test/v1",
					apiKey: "TEAM_PROXY_API_KEY",
					discovery: { type: "proxy" },
				},
			},
		});
		const models = createModels();

		await registerConfiguredProxyProvidersFromHome(models, dirname(path));

		expect(models.getProvider("team-proxy")).toMatchObject({ id: "team-proxy", name: "Team Proxy" });
	});
});
