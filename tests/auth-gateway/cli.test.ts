import { describe, expect, test } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AuthStorage } from "../../src/storage/auth-storage.ts";
import { createModels } from "../../src/models.ts";
import { createAssistantMessageEventStream } from "../../src/utils/event-stream.ts";
import type { AssistantMessage, Api, Model, Provider } from "../../src/types.ts";
import { checkConfiguredGatewayProviders, parseAuthGatewayArgs } from "../../src/cli/auth-gateway-cli.ts";

const CLI_PATH = resolve(process.cwd(), "src", "cli", "cli.ts");

function fixtureModel(): Model<Api> {
	return {
		id: "fixture-model",
		name: "Fixture Model",
		api: "openai-completions",
		provider: "fixture",
		baseUrl: "https://fixture.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 4096,
		maxTokens: 128,
	};
}

function fixtureStream(model: Model<Api>): ReturnType<typeof createAssistantMessageEventStream> {
	const message: AssistantMessage = {
		role: "assistant",
		content: [{ type: "text", text: "ok" }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "stop",
		timestamp: 1,
	};
	const stream = createAssistantMessageEventStream();
	stream.push({ type: "start", partial: message });
	stream.push({ type: "done", reason: "stop", message });
	return stream;
}

describe("auth-gateway CLI arguments", () => {
	test("parses serve bind and no-auth options", () => {
		expect(parseAuthGatewayArgs(["serve", "--bind", "127.0.0.1:4545", "--no-auth"])).toEqual({
			ok: true,
			command: { action: "serve", bindHost: "127.0.0.1", port: 4545, noAuth: true },
		});
	});

	test("uses the default bind when serve has no flags", () => {
		expect(parseAuthGatewayArgs(["serve"])).toEqual({
			ok: true,
			command: { action: "serve", bindHost: "127.0.0.1", port: 4000, noAuth: false },
		});
	});

	test("parses token management actions and rejects malformed bind values", () => {
		expect(parseAuthGatewayArgs(["token", "--regenerate", "--json"])).toEqual({
			ok: true,
			command: { action: "token", regenerate: true, json: true },
		});
		expect(parseAuthGatewayArgs(["status"])).toEqual({ ok: true, command: { action: "status", json: false } });
		expect(parseAuthGatewayArgs(["check", "--strict", "--json"])).toEqual({
			ok: true,
			command: { action: "check", strict: true, json: true },
		});
		expect(parseAuthGatewayArgs(["serve", "--bind", "0.0.0.0"])).toMatchObject({ ok: false, error: expect.stringMatching(/host:port|bind/i) });
	});

	test("strict check probes each configured provider without returning its credential", async () => {
		const model = fixtureModel();
		const models = createModels({ credentials: AuthStorage.inMemory({ fixture: { type: "api_key", key: "secret-fixture-key" } }) });
		const provider: Provider = {
			id: "fixture",
			name: "Fixture",
			auth: { apiKey: { name: "Fixture key", resolve: async ({ credential }) => credential?.key === undefined ? undefined : { auth: { apiKey: credential.key }, source: "fixture" } } },
			getModels: () => [model],
			stream: (requestModel) => fixtureStream(requestModel),
			streamSimple: (requestModel) => fixtureStream(requestModel),
		};
		models.setProvider(provider);

		await expect(checkConfiguredGatewayProviders(models)).resolves.toEqual([{ providerId: "fixture", modelId: "fixture-model", ok: true }]);
	});

	test("registers token management through the real CLI with an isolated RunLedger home", () => {
		const home = mkdtempSync(join(tmpdir(), "runledger-auth-gateway-cli-"));
		try {
			const result = spawnSync(process.execPath, ["--import", "tsx", CLI_PATH, "auth-gateway", "token", "--json"], {
				encoding: "utf8",
				env: { ...process.env, RUNLEDGER_DIR: home },
			});
			expect(result.status, result.stderr).toBe(0);
			const body = JSON.parse(result.stdout) as { token?: string; path?: string };
			expect(body.token).toMatch(/^[A-Za-z0-9_-]{40,}$/u);
			expect(body.path).toBe(join(home, "auth-gateway.token"));
			expect(statSync(body.path!).mode & 0o777).toBe(0o600);
			expect(readFileSync(body.path!, "utf8")).toBe(`${body.token}\n`);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});
});
