import { mkdir, stat } from "node:fs/promises";
import { resolveRunledgerHome, type ResolvedRunledgerHome } from "../storage/runledger-home.ts";
import { AuthStorage } from "../storage/auth-storage.ts";
import { builtinModels } from "../providers/all.ts";
import { registerConfiguredProxyProvidersFromHome } from "../providers/configured-proxy.ts";
import type { Models } from "../models.ts";
import {
	authGatewayTokenPath,
	ensureAuthGatewayToken,
	readAuthGatewayToken,
	regenerateAuthGatewayToken,
} from "../auth-gateway/token.ts";
import {
	AUTH_GATEWAY_DEFAULT_BIND_HOST,
	AUTH_GATEWAY_DEFAULT_PORT,
	startAuthGatewayServer,
	type AuthGatewayServerHandle,
} from "../auth-gateway/server.ts";

export const AUTH_GATEWAY_USAGE = `Usage: runledger auth-gateway <serve|token|status|check> [options]

  serve [--bind <host:port>] [--no-auth]
  token [--regenerate] [--json]
  status [--json]
  check [--strict] [--json]
`;

export type AuthGatewayCommand =
	| { readonly action: "serve"; readonly bindHost: string; readonly port: number; readonly noAuth: boolean }
	| { readonly action: "token"; readonly regenerate: boolean; readonly json: boolean }
	| { readonly action: "status"; readonly json: boolean }
	| { readonly action: "check"; readonly strict: boolean; readonly json: boolean };

export type AuthGatewayArgsResult =
	| { readonly ok: true; readonly command: AuthGatewayCommand }
	| { readonly ok: false; readonly error: string };

function parsePort(value: string): number | undefined {
	if (!/^\d+$/u.test(value)) return undefined;
	const port = Number(value);
	return Number.isInteger(port) && port >= 0 && port <= 65_535 ? port : undefined;
}

function parseBind(value: string): { bindHost: string; port: number } | undefined {
	const trimmed = value.trim();
	let host: string;
	let portText: string;
	if (trimmed.startsWith("[")) {
		const close = trimmed.indexOf("]");
		if (close < 0 || trimmed[close + 1] !== ":") return undefined;
		host = trimmed.slice(1, close);
		portText = trimmed.slice(close + 2);
	} else {
		const separator = trimmed.lastIndexOf(":");
		if (separator <= 0) return undefined;
		host = trimmed.slice(0, separator);
		portText = trimmed.slice(separator + 1);
	}
	const port = parsePort(portText);
	return host.length > 0 && port !== undefined ? { bindHost: host, port } : undefined;
}

function takeValue(argv: readonly string[], index: number, flag: string): { value?: string; nextIndex: number; error?: string } {
	const value = argv[index + 1];
	if (value === undefined || value.startsWith("-")) return { nextIndex: index, error: `${flag} 缺少值` };
	return { value, nextIndex: index + 1 };
}

/** Pure parser for the auth-gateway command family. */
export function parseAuthGatewayArgs(argv: readonly string[]): AuthGatewayArgsResult {
	const action = argv[0];
	if (action === undefined || action === "--help" || action === "-h") return { ok: false, error: AUTH_GATEWAY_USAGE };
	if (action === "serve") {
		let bindHost = AUTH_GATEWAY_DEFAULT_BIND_HOST;
		let port = AUTH_GATEWAY_DEFAULT_PORT;
		let noAuth = false;
		for (let index = 1; index < argv.length; index += 1) {
			const flag = argv[index]!;
			if (flag === "--no-auth") {
				noAuth = true;
				continue;
			}
			if (flag === "--bind" || flag.startsWith("--bind=")) {
				const supplied = flag.startsWith("--bind=")
					? { value: flag.slice("--bind=".length), nextIndex: index }
					: takeValue(argv, index, "--bind");
				if (supplied.error || supplied.value === undefined) return { ok: false, error: supplied.error ?? "--bind 缺少值" };
				const parsed = parseBind(supplied.value);
				if (parsed === undefined) return { ok: false, error: "--bind 必须是 host:port" };
				bindHost = parsed.bindHost;
				port = parsed.port;
				index = supplied.nextIndex;
				continue;
			}
			return { ok: false, error: `auth-gateway serve 不支持参数: ${flag}` };
		}
		return { ok: true, command: { action, bindHost, port, noAuth } };
	}

	if (action === "token") {
		let regenerate = false;
		let json = false;
		for (const flag of argv.slice(1)) {
			if (flag === "--regenerate") regenerate = true;
			else if (flag === "--json") json = true;
			else return { ok: false, error: `auth-gateway token 不支持参数: ${flag}` };
		}
		return { ok: true, command: { action, regenerate, json } };
	}

	if (action === "status" || action === "check") {
		let json = false;
		let strict = false;
		for (const flag of argv.slice(1)) {
			if (flag === "--json") json = true;
			else if (action === "check" && flag === "--strict") strict = true;
			else return { ok: false, error: `auth-gateway ${action} 不支持参数: ${flag}` };
		}
		return action === "status"
			? { ok: true, command: { action, json } }
			: { ok: true, command: { action, strict, json } };
	}

	return { ok: false, error: `unknown auth-gateway command: ${action}\n\n${AUTH_GATEWAY_USAGE}` };
}

export interface AuthGatewayCliDependencies {
	readonly resolveHome?: () => Promise<ResolvedRunledgerHome>;
	readonly startServer?: (options: Parameters<typeof startAuthGatewayServer>[0]) => Promise<AuthGatewayServerHandle>;
	readonly models?: Models;
	readonly writeStdout?: (text: string) => void;
}

export interface AuthGatewayProviderCheck {
	readonly providerId: string;
	readonly modelId?: string;
	readonly ok: boolean;
	readonly error?: string;
}

/** Probe one inexpensive text completion for every configured provider without exposing credentials. */
export async function checkConfiguredGatewayProviders(models: Models): Promise<readonly AuthGatewayProviderCheck[]> {
	const results = await Promise.all(models.getProviders().map(async (provider): Promise<AuthGatewayProviderCheck | undefined> => {
		let configured: Awaited<ReturnType<Models["checkAuth"]>>;
		try {
			configured = await models.checkAuth(provider.id);
		} catch {
			return { providerId: provider.id, ok: false, error: "credential check failed" };
		}
		if (configured === undefined) return undefined;

		try {
			const model = (await models.getAvailable(provider.id))[0];
			if (model === undefined) return { providerId: provider.id, ok: false, error: "no available model" };
			const message = await models.completeSimple(model, {
				messages: [{ role: "user", content: "Reply with OK.", timestamp: Date.now() }],
			});
			return {
				providerId: provider.id,
				modelId: model.id,
				ok: message.stopReason !== "error" && message.stopReason !== "aborted",
			};
		} catch {
			return { providerId: provider.id, ok: false, error: "upstream check failed" };
		}
	}));
	return results.filter((result): result is AuthGatewayProviderCheck => result !== undefined);
}

function output(value: unknown, json: boolean, writeStdout: (text: string) => void): void {
	writeStdout(json ? `${JSON.stringify(value)}\n` : `${typeof value === "string" ? value : JSON.stringify(value, null, 2)}\n`);
}

async function resolvedHome(dependencies: AuthGatewayCliDependencies): Promise<ResolvedRunledgerHome> {
	const home = await (dependencies.resolveHome ?? resolveRunledgerHome)();
	if (home.resolution.createDefault) await mkdir(home.layout.home, { recursive: true, mode: 0o700 });
	return home;
}

async function createGatewayModels(home: ResolvedRunledgerHome): Promise<Models> {
	const models = builtinModels({ credentials: AuthStorage.create(home.layout) });
	await registerConfiguredProxyProvidersFromHome(models, home.layout.home);
	await models.refresh({ allowNetwork: false });
	return models;
}

async function tokenFileStatus(path: string): Promise<{ configured: boolean; mode?: number }> {
	const token = await readAuthGatewayToken(path);
	if (token === undefined) return { configured: false };
	const file = await stat(path);
	return { configured: true, mode: file.mode & 0o777 };
}

/** Execute one auth-gateway command; the serve action remains alive until a signal closes it. */
export async function runAuthGatewayCommand(argv: readonly string[], dependencies: AuthGatewayCliDependencies = {}): Promise<void> {
	if (argv[0] === "--help" || argv[0] === "-h") {
		(dependencies.writeStdout ?? ((text: string) => process.stdout.write(text)))(AUTH_GATEWAY_USAGE);
		return;
	}
	const parsed = parseAuthGatewayArgs(argv);
	if (!parsed.ok) throw new Error(parsed.error);
	const writeStdout = dependencies.writeStdout ?? ((text: string) => process.stdout.write(text));
	const home = await resolvedHome(dependencies);
	const tokenPath = authGatewayTokenPath(home.layout.home);

	if (parsed.command.action === "token") {
		const token = parsed.command.regenerate ? await regenerateAuthGatewayToken(tokenPath) : await ensureAuthGatewayToken(tokenPath);
		output(parsed.command.json ? { token, path: tokenPath } : token, parsed.command.json, writeStdout);
		return;
	}

	if (parsed.command.action === "status" || parsed.command.action === "check") {
		const token = await tokenFileStatus(tokenPath);
		if (parsed.command.action === "check" && parsed.command.strict) {
			const models = dependencies.models ?? await createGatewayModels(home);
			const providers = await checkConfiguredGatewayProviders(models);
			output({ ok: token.configured && providers.length > 0 && providers.every((provider) => provider.ok), strict: true, token, providers }, parsed.command.json, writeStdout);
			return;
		}
		const result = parsed.command.action === "check"
			? { ok: token.configured, strict: false, token }
			: { ok: true, token };
		output(result, parsed.command.json, writeStdout);
		return;
	}

	const token = await ensureAuthGatewayToken(tokenPath);
	const models = dependencies.models ?? await createGatewayModels(home);
	const server = await (dependencies.startServer ?? startAuthGatewayServer)({
		bindHost: parsed.command.bindHost,
		port: parsed.command.port,
		noAuth: parsed.command.noAuth,
		token,
		models,
	});
	writeStdout(`runledger auth-gateway listening on ${server.bindHost}:${server.port}\n`);
	await waitForShutdown(server);
}

async function waitForShutdown(server: AuthGatewayServerHandle): Promise<void> {
	await new Promise<void>((resolve) => {
		let stopped = false;
		const stop = () => {
			if (stopped) return;
			stopped = true;
			process.removeListener("SIGINT", stop);
			process.removeListener("SIGTERM", stop);
			void server.close().finally(resolve);
		};
		process.once("SIGINT", stop);
		process.once("SIGTERM", stop);
	});
}
