/** MCP OAuth：只持久化 opaque credential handle，不把 token 写入扩展配置。 */

import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { auth } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { canonicalDigest } from "../../runtime/protocol/v3/canonical-json.ts";
import type { ExtensionStoragePort } from "../storage-port.ts";

export interface McpOAuthCredentialHandle {
	handleId: string;
	audienceDigest: string;
	issuedAt: string;
	expiresAt?: string;
}

export interface McpOAuthSecretStorePort {
	store(input: { serverId: string; audience: string; credentialMaterial: string }, signal?: AbortSignal): Promise<McpOAuthCredentialHandle>;
	revoke(handleId: string, signal?: AbortSignal): Promise<boolean>;
}

export interface McpOAuthProviderPort {
	begin(input: { serverId: string; serverUrl?: string; authorizationServer: string; redirectUri: string; scopes?: readonly string[] }, signal?: AbortSignal): Promise<{ authorizationUrl: string; state: string; verifierHandle: string }>;
	complete(input: { state: string; verifierHandle: string; code: string }, signal?: AbortSignal): Promise<{ audience: string; credentialMaterial: string }>;
}

export interface McpOAuthCodeResult {
	code: string;
	state: string;
	channel: "loopback" | "manual";
}

export interface McpOAuthCodeChannelPort {
	receive(input: { authorizationUrl: string; expectedState: string }, signal?: AbortSignal): Promise<McpOAuthCodeResult>;
}

export class ManualMcpOAuthCodeChannel implements McpOAuthCodeChannelPort {
	readonly #prompt: (authorizationUrl: string, signal?: AbortSignal) => Promise<string>;

	public constructor(prompt: (authorizationUrl: string, signal?: AbortSignal) => Promise<string>) {
		this.#prompt = prompt;
	}

	public async receive(
		input: { authorizationUrl: string; expectedState: string },
		signal?: AbortSignal,
	): Promise<McpOAuthCodeResult> {
		const code = (await this.#prompt(input.authorizationUrl, signal)).trim();
		return { code, state: input.expectedState, channel: "manual" };
	}
}

/**
 * 只绑定 127.0.0.1 随机端口；callback 不写日志、不回显 code，并在成功、
 * abort、超时或 close 后释放监听端口。
 */
export class NodeLoopbackMcpOAuthCodeChannel implements McpOAuthCodeChannelPort {
	readonly #server: Server;
	readonly #redirectUri: string;
	readonly #result: Promise<McpOAuthCodeResult>;
	#closed = false;

	private constructor(
		server: Server,
		redirectUri: string,
		result: Promise<McpOAuthCodeResult>,
	) {
		this.#server = server;
		this.#redirectUri = redirectUri;
		this.#result = result;
	}

	public static async listen(options: {
		path?: string;
		timeoutMs?: number;
	} = {}): Promise<NodeLoopbackMcpOAuthCodeChannel> {
		const path = options.path ?? "/oauth/callback";
		if (!path.startsWith("/") || path.includes("?") || path.includes("#")) {
			throw new TypeError("OAuth callback path must be an absolute path without query/fragment");
		}
		let resolveResult: (value: McpOAuthCodeResult) => void = () => undefined;
		let rejectResult: (reason: Error) => void = () => undefined;
		const result = new Promise<McpOAuthCodeResult>((resolveValue, rejectValue) => {
			resolveResult = resolveValue;
			rejectResult = rejectValue;
		});
		const server = createServer((request, response) => {
			try {
				const host = request.headers.host ?? "127.0.0.1";
				const url = new URL(request.url ?? "/", `http://${host}`);
				if (request.method !== "GET" || url.pathname !== path) {
					response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
					response.end("Not found");
					return;
				}
				const code = url.searchParams.get("code") ?? "";
				const state = url.searchParams.get("state") ?? "";
				if (!code || !state) {
					response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
					response.end("Authorization response is missing code or state.");
					return;
				}
				response.writeHead(200, {
					"content-type": "text/plain; charset=utf-8",
					"cache-control": "no-store",
				});
				response.end("Authorization received. You may close this window.");
				resolveResult({ code, state, channel: "loopback" });
			} catch {
				response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
				response.end("Invalid authorization response.");
			}
		});
		server.once("error", (error) => rejectResult(error));
		await new Promise<void>((resolveListening, rejectListening) => {
			server.once("error", rejectListening);
			server.listen(0, "127.0.0.1", () => {
				server.off("error", rejectListening);
				resolveListening();
			});
		});
		const address = server.address();
		if (!address || typeof address === "string") {
			await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
			throw new Error("OAuth callback server did not expose a loopback port");
		}
		const redirectUri = `http://127.0.0.1/${path.slice(1)}`.replace(
			"127.0.0.1/",
			`127.0.0.1:${(address as AddressInfo).port}/`,
		);
		const instance = new NodeLoopbackMcpOAuthCodeChannel(server, redirectUri, result);
		const timeoutMs = Math.max(1_000, Math.min(options.timeoutMs ?? 300_000, 600_000));
		const timeout = setTimeout(() => {
			rejectResult(new Error("OAuth loopback callback timed out"));
			void instance.close();
		}, timeoutMs);
		timeout.unref();
		result.finally(() => clearTimeout(timeout)).catch(() => undefined);
		return instance;
	}

	public get redirectUri(): string {
		return this.#redirectUri;
	}

	public async receive(
		input: { authorizationUrl: string; expectedState: string },
		signal?: AbortSignal,
	): Promise<McpOAuthCodeResult> {
		void input.authorizationUrl;
		const aborted = new Promise<never>((_resolve, reject) => {
			if (signal?.aborted) reject(signal.reason);
			else signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
		});
		try {
			const result = await Promise.race([this.#result, aborted]);
			if (result.state !== input.expectedState) throw new Error("OAuth callback state mismatch");
			return result;
		} finally {
			await this.close();
		}
	}

	public async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		await new Promise<void>((resolveClose) => this.#server.close(() => resolveClose()));
	}
}

/** loopback callback 与手动授权码竞速；赢家产生结果后立即取消另一通道。 */
export async function raceMcpOAuthCode(options: {
	authorizationUrl: string;
	expectedState: string;
	loopback: McpOAuthCodeChannelPort;
	manual: McpOAuthCodeChannelPort;
	signal?: AbortSignal;
}): Promise<string> {
	const loopbackAbort = new AbortController();
	const manualAbort = new AbortController();
	const forwardAbort = () => {
		loopbackAbort.abort(options.signal?.reason);
		manualAbort.abort(options.signal?.reason);
	};
	if (options.signal?.aborted) forwardAbort();
	else options.signal?.addEventListener("abort", forwardAbort, { once: true });
	const validate = async (
		channel: McpOAuthCodeChannelPort,
		controller: AbortController,
	): Promise<McpOAuthCodeResult> => {
		const result = await channel.receive({
			authorizationUrl: options.authorizationUrl,
			expectedState: options.expectedState,
		}, controller.signal);
		if (result.state !== options.expectedState || result.code.length === 0) {
			throw new Error("OAuth authorization response state/code is invalid");
		}
		return result;
	};
	try {
		const result = await Promise.any([
			validate(options.loopback, loopbackAbort),
			validate(options.manual, manualAbort),
		]);
		if (result.channel === "loopback") manualAbort.abort("loopback OAuth callback completed");
		else loopbackAbort.abort("manual OAuth code completed");
		return result.code;
	} finally {
		options.signal?.removeEventListener("abort", forwardAbort);
	}
}

export interface McpSdkOAuthClientProviderFactoryPort {
	create(input: {
		serverId: string;
		redirectUri: string;
		expectedState: string;
		onAuthorizationUrl(url: URL): void;
	}): OAuthClientProvider;
}

interface PendingOfficialOAuth {
	provider: OAuthClientProvider;
	serverUrl: string;
	scope?: string;
	state: string;
}

/**
 * 官方 MCP SDK auth() 的最小 adapter。所有 HTTP 必须使用调用方注入的
 * policy-aware fetch；provider/token/verifier 仅在内存中停留到 complete。
 */
export class OfficialSdkMcpOAuthProvider implements McpOAuthProviderPort {
	readonly #factory: McpSdkOAuthClientProviderFactoryPort;
	readonly #fetch: FetchLike;
	readonly #pending = new Map<string, PendingOfficialOAuth>();

	public constructor(factory: McpSdkOAuthClientProviderFactoryPort, fetch: FetchLike) {
		this.#factory = factory;
		this.#fetch = fetch;
	}

	public async begin(input: {
		serverId: string;
		serverUrl?: string;
		authorizationServer: string;
		redirectUri: string;
		scopes?: readonly string[];
	}, signal?: AbortSignal): Promise<{ authorizationUrl: string; state: string; verifierHandle: string }> {
		if (signal?.aborted) throw signal.reason;
		const state = randomUUID();
		let authorizationUrl: URL | undefined;
		const provider = this.#factory.create({
			serverId: input.serverId,
			redirectUri: input.redirectUri,
			expectedState: state,
			onAuthorizationUrl: (url) => { authorizationUrl = url; },
		});
		const providerState = await provider.state?.();
		if (providerState !== state) throw new Error("official MCP OAuth provider does not preserve the expected state");
		const serverUrl = input.serverUrl ?? input.authorizationServer;
		const scope = input.scopes?.length ? [...input.scopes].sort().join(" ") : undefined;
		const result = await auth(provider, {
			serverUrl,
			...(scope ? { scope } : {}),
			fetchFn: this.#fetch,
		});
		if (result !== "REDIRECT" || !authorizationUrl) throw new Error("official MCP OAuth did not produce an authorization redirect");
		const verifierHandle = randomUUID();
		this.#pending.set(verifierHandle, { provider, serverUrl, ...(scope ? { scope } : {}), state });
		return { authorizationUrl: authorizationUrl.href, state, verifierHandle };
	}

	public async complete(input: {
		state: string;
		verifierHandle: string;
		code: string;
	}, signal?: AbortSignal): Promise<{ audience: string; credentialMaterial: string }> {
		if (signal?.aborted) throw signal.reason;
		const pending = this.#pending.get(input.verifierHandle);
		this.#pending.delete(input.verifierHandle);
		if (!pending || pending.state !== input.state) throw new Error("OAuth state or verifier handle is stale");
		const result = await auth(pending.provider, {
			serverUrl: pending.serverUrl,
			authorizationCode: input.code,
			...(pending.scope ? { scope: pending.scope } : {}),
			fetchFn: this.#fetch,
		});
		if (result !== "AUTHORIZED") throw new Error("official MCP OAuth token exchange did not complete");
		const tokens = await pending.provider.tokens();
		if (!tokens?.access_token) throw new Error("official MCP OAuth provider returned no access token");
		return {
			audience: pending.serverUrl,
			credentialMaterial: JSON.stringify(tokens),
		};
	}
}

interface OAuthMetadataDocument {
	schemaVersion: 1;
	revision: number;
	servers: Readonly<Record<string, McpOAuthCredentialHandle>>;
}

interface LoadedOAuthMetadata {
	document: OAuthMetadataDocument;
	unknown: Readonly<Record<string, unknown>>;
}

function parse(value: unknown): LoadedOAuthMetadata | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const raw = value as Record<string, unknown>;
	if (raw.schemaVersion !== 1 || !Number.isSafeInteger(raw.revision) || typeof raw.servers !== "object" || raw.servers === null || Array.isArray(raw.servers)) return undefined;
	const servers: Record<string, McpOAuthCredentialHandle> = {};
	for (const [serverId, valueHandle] of Object.entries(raw.servers as Record<string, unknown>)) {
		if (typeof valueHandle !== "object" || valueHandle === null || Array.isArray(valueHandle)) return undefined;
		const handle = valueHandle as Record<string, unknown>;
		if (
			Object.keys(handle).some((key) =>
				key !== "handleId" &&
				key !== "audienceDigest" &&
				key !== "issuedAt" &&
				key !== "expiresAt"
			) ||
			typeof handle.handleId !== "string" ||
			!/^[A-Za-z0-9:._~-]{1,256}$/u.test(handle.handleId) ||
			typeof handle.audienceDigest !== "string" ||
			!/^[a-f0-9]{64}$/u.test(handle.audienceDigest) ||
			typeof handle.issuedAt !== "string" ||
			(handle.expiresAt !== undefined && typeof handle.expiresAt !== "string")
		) return undefined;
		servers[serverId] = {
			handleId: handle.handleId,
			audienceDigest: handle.audienceDigest,
			issuedAt: handle.issuedAt,
			...(typeof handle.expiresAt === "string" ? { expiresAt: handle.expiresAt } : {}),
		};
	}
	const { schemaVersion: _schemaVersion, revision: _revision, servers: _servers, ...unknown } = raw;
	return {
		document: {
			schemaVersion: 1,
			revision: raw.revision as number,
			servers,
		},
		unknown,
	};
}

export class McpOAuthCredentialStore {
	readonly #metadataPath: string;
	readonly #storage: ExtensionStoragePort;
	readonly #secrets: McpOAuthSecretStorePort;
	#unknown: Readonly<Record<string, unknown>> = {};

	public constructor(metadataPath: string, storage: ExtensionStoragePort, secrets: McpOAuthSecretStorePort) {
		this.#metadataPath = metadataPath;
		this.#storage = storage;
		this.#secrets = secrets;
	}

	public async load(): Promise<OAuthMetadataDocument> {
		const read = await this.#storage.readFile(this.#metadataPath, 1024 * 1024);
		if (!read.ok) return { schemaVersion: 1, revision: 0, servers: {} };
		try {
			const parsed = parse(JSON.parse(Buffer.from(read.value).toString("utf8")));
			if (!parsed) return { schemaVersion: 1, revision: 0, servers: {} };
			this.#unknown = parsed.unknown;
			return parsed.document;
		} catch {
			return { schemaVersion: 1, revision: 0, servers: {} };
		}
	}

	async #save(document: OAuthMetadataDocument): Promise<void> {
		const saved = await this.#storage.writeFileAtomic(
			this.#metadataPath,
			Buffer.from(`${JSON.stringify({ ...this.#unknown, ...document }, null, 2)}\n`),
			{ fileMode: 0o600, directoryMode: 0o700 },
		);
		if (!saved.ok) throw new Error(saved.message);
	}

	public async login(input: { serverId: string; provider: McpOAuthProviderPort; serverUrl?: string; authorizationServer: string; redirectUri: string; scopes?: readonly string[]; receiveCode: (authorizationUrl: string, state: string, signal?: AbortSignal) => Promise<string>; signal?: AbortSignal }): Promise<McpOAuthCredentialHandle> {
		const begun = await input.provider.begin({ serverId: input.serverId, ...(input.serverUrl ? { serverUrl: input.serverUrl } : {}), authorizationServer: input.authorizationServer, redirectUri: input.redirectUri, ...(input.scopes ? { scopes: input.scopes } : {}) }, input.signal);
		const code = await input.receiveCode(begun.authorizationUrl, begun.state, input.signal);
		const completed = await input.provider.complete({ state: begun.state, verifierHandle: begun.verifierHandle, code }, input.signal);
		const handle = await this.#secrets.store({ serverId: input.serverId, audience: completed.audience, credentialMaterial: completed.credentialMaterial }, input.signal);
		if (handle.audienceDigest !== canonicalDigest(completed.audience)) {
			await this.#secrets.revoke(handle.handleId, input.signal);
			throw new Error("OAuth credential audience binding mismatch");
		}
		const current = await this.load();
		await this.#save({ schemaVersion: 1, revision: current.revision + 1, servers: { ...current.servers, [input.serverId]: handle } });
		return handle;
	}

	public async logout(serverId: string, signal?: AbortSignal): Promise<boolean> {
		const current = await this.load();
		const handle = current.servers[serverId];
		if (!handle) return false;
		const revoked = await this.#secrets.revoke(handle.handleId, signal);
		if (!revoked) return false;
		const servers = { ...current.servers };
		delete servers[serverId];
		await this.#save({ schemaVersion: 1, revision: current.revision + 1, servers });
		return true;
	}
}

export interface McpOAuthConnectionControlPort {
	closeServer(serverId: string): Promise<boolean>;
	requestReload(): void;
}

/** login/logout 的生产顺序：credential mutation -> client close -> idle reload。 */
export class McpOAuthLifecycle {
	readonly #credentials: McpOAuthCredentialStore;
	readonly #connections: McpOAuthConnectionControlPort;

	public constructor(credentials: McpOAuthCredentialStore, connections: McpOAuthConnectionControlPort) {
		this.#credentials = credentials;
		this.#connections = connections;
	}

	public async login(input: Parameters<McpOAuthCredentialStore["login"]>[0]): Promise<McpOAuthCredentialHandle> {
		const handle = await this.#credentials.login(input);
		this.#connections.requestReload();
		return handle;
	}

	public async logout(serverId: string, signal?: AbortSignal): Promise<boolean> {
		const revoked = await this.#credentials.logout(serverId, signal);
		if (!revoked) return false;
		await this.#connections.closeServer(serverId);
		this.#connections.requestReload();
		return true;
	}
}
