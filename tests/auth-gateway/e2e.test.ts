import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { AuthStorage } from "../../src/storage/auth-storage.ts";
import { resolveRunledgerHome } from "../../src/storage/runledger-home.ts";
import { startDualWireProxy, type DualWireProxy } from "../fixtures/dual-wire-proxy.ts";

const CLI_PATH = resolve(process.cwd(), "src", "cli", "cli.ts");

interface RunningGateway {
	readonly child: ChildProcessWithoutNullStreams;
	readonly token: string;
	readonly port: number;
	stop(): Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

function waitForExit(child: ChildProcessWithoutNullStreams): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
	return new Promise((resolveExit) => {
		child.once("exit", (code, signal) => resolveExit({ code, signal }));
	});
}

async function waitForListening(child: ChildProcessWithoutNullStreams): Promise<number> {
	return new Promise((resolvePort, reject) => {
		let output = "";
		const timer = setTimeout(() => reject(new Error("auth gateway did not become ready")), 10_000);
		const onData = (chunk: Buffer | string): void => {
			output += chunk.toString();
			const match = /listening on 127\.0\.0\.1:(\d+)/u.exec(output);
			if (!match) return;
			clearTimeout(timer);
			child.stdout.removeListener("data", onData);
			resolvePort(Number(match[1]));
		};
		child.stdout.on("data", onData);
		child.once("exit", (code) => {
			clearTimeout(timer);
			child.stdout.removeListener("data", onData);
			reject(new Error(`auth gateway exited before becoming ready (${code ?? "signal"})`));
		});
	});
}

async function launchGateway(home: string, upstream: DualWireProxy, noAuth = false): Promise<RunningGateway> {
	const command = ["--import", "tsx", CLI_PATH, "auth-gateway", "serve", "--bind", "127.0.0.1:0"];
	if (noAuth) command.push("--no-auth");
	const child = spawn(
		process.execPath,
		command,
		{
			cwd: process.cwd(),
			env: {
				...process.env,
				RUNLEDGER_DIR: home,
				LM_STUDIO_BASE_URL: `${upstream.baseUrl}/v1`,
			},
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	const port = await waitForListening(child);
	const token = (await readFile(join(home, "auth-gateway.token"), "utf8")).trim();
	return {
		child,
		token,
		port,
		stop: async () => {
			const exit = waitForExit(child);
			child.kill("SIGINT");
			return exit;
		},
	};
}

async function request(
	gateway: RunningGateway,
	path: string,
	body?: unknown,
	withAuth = true,
): Promise<Response> {
	return fetch(`http://127.0.0.1:${gateway.port}${path}`, {
		method: body === undefined ? "GET" : "POST",
		headers: {
			...(body === undefined ? {} : { "content-type": "application/json" }),
			...(withAuth ? { authorization: `Bearer ${gateway.token}` } : {}),
		},
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});
}

describe("auth-gateway real HTTP smoke", () => {
	let upstream: DualWireProxy | undefined;
	let gateway: RunningGateway | undefined;
	let home: string | undefined;

	afterEach(async () => {
		if (gateway) {
			if (gateway.child.exitCode === null && gateway.child.signalCode === null) await gateway.stop();
			gateway = undefined;
		}
		if (upstream) {
			await upstream.close();
			upstream = undefined;
		}
		if (home) {
			await rm(home, { recursive: true, force: true });
			home = undefined;
		}
	});

	test("serves four wires through a real CLI process while credentials are updated and exits cleanly", async () => {
		upstream = await startDualWireProxy({ acceptedWire: "openai-completions" });
		home = await mkdtemp(join(tmpdir(), "runledger-auth-gateway-e2e-"));
		await writeFile(
			join(home, "auth.json"),
			JSON.stringify({ "lm-studio": { type: "api_key", key: "gateway-fixture-key" } }),
			{ encoding: "utf8", mode: 0o600 },
		);
		gateway = await launchGateway(home, upstream);

		expect((await request(gateway, "/healthz", undefined, false)).status).toBe(200);
		expect((await request(gateway, "/v1/models", undefined, false)).status).toBe(401);

		const models = await request(gateway, "/v1/models");
		expect(models.status).toBe(200);
		const catalog = (await models.json()) as { data?: Array<{ id?: string }> };
		expect(catalog.data).toEqual(expect.arrayContaining([expect.objectContaining({ id: "llama-3-8b" })]));

		const requests: readonly [string, unknown, string][] = [
			[
				"/v1/chat/completions",
				{ model: "lm-studio/llama-3-8b", messages: [{ role: "user", content: "ping" }], stream: true },
				"data: [DONE]",
			],
			[
				"/v1/messages",
				{ model: "llama-3-8b", max_tokens: 32, messages: [{ role: "user", content: "ping" }], stream: true },
				"event: message_stop",
			],
			[
				"/v1/responses",
				{ model: "llama-3-8b", input: "ping", stream: true },
				'"type":"response.completed"',
			],
			[
				"/messages",
				{ model: "llama-3-8b", context: { messages: [{ role: "user", content: "ping", timestamp: 1 }] }, options: {}, stream: true },
				'"type":"done"',
			],
		];

		const { layout } = await resolveRunledgerHome({ env: { RUNLEDGER_DIR: home } });
		const sessionCredentials = AuthStorage.create(layout);
		const concurrentCredentialWrite = sessionCredentials.modify("lm-studio", async (current) => {
			if (current === undefined) throw new Error("fixture credential disappeared");
			await new Promise<void>((resolveWrite) => setTimeout(resolveWrite, 25));
			return current;
		});
		const responses = await Promise.all(requests.map(([path, body]) => request(gateway, path, body)));
		await concurrentCredentialWrite;
		for (const [index, [path, _body, terminalMarker]] of requests.entries()) {
			const response = responses[index];
			if (!response) throw new Error(`gateway response missing for ${path}`);
			expect(response.status, path).toBe(200);
			expect(response.headers.get("content-type"), path).toMatch(/text\/event-stream/iu);
			const text = await response.text();
			expect(text, path).toContain("fixture-openai");
			expect(text, path).toContain(terminalMarker);
		}
		const persistedCredentials = JSON.parse(await readFile(join(home, "auth.json"))) as Record<string, { type?: string }>;
		expect(persistedCredentials["lm-studio"]?.type).toBe("api_key");

		const upstreamRequests = upstream.observations.filter((entry) => entry.url === "/v1/chat/completions");
		expect(upstreamRequests).toHaveLength(4);
		expect(upstreamRequests.every((entry) => entry.headers.authorization?.startsWith("Bearer "))).toBe(true);

		const unknown = await request(gateway, "/v1/chat/completions", { model: "lm-studio/does-not-exist", messages: [{ role: "user", content: "ping" }] });
		expect(unknown.status).toBe(404);
		expect(await unknown.json()).toMatchObject({ error: { code: "model_not_found" } });

		const exit = await gateway.stop();
		expect(exit).toEqual({ code: 0, signal: null });
		gateway = undefined;
	});

	test("allows real no-auth serving only on loopback", async () => {
		upstream = await startDualWireProxy({ acceptedWire: "openai-completions" });
		home = await mkdtemp(join(tmpdir(), "runledger-auth-gateway-no-auth-"));
		gateway = await launchGateway(home, upstream, true);

		const response = await request(gateway, "/v1/models", undefined, false);
		expect(response.status).toBe(200);
		const catalog = (await response.json()) as { data?: unknown[] };
		expect(catalog.data?.length).toBeGreaterThan(0);

		const exit = await gateway.stop();
		expect(exit).toEqual({ code: 0, signal: null });
		gateway = undefined;
	});
});
