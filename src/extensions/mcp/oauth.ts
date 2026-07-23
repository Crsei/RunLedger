/** MCP OAuth：只持久化 opaque credential handle，不把 token 写入扩展配置。 */

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
	begin(input: { serverId: string; authorizationServer: string; redirectUri: string }, signal?: AbortSignal): Promise<{ authorizationUrl: string; state: string; verifierHandle: string }>;
	complete(input: { state: string; verifierHandle: string; code: string }, signal?: AbortSignal): Promise<{ audience: string; credentialMaterial: string }>;
}

interface OAuthMetadataDocument {
	schemaVersion: 1;
	revision: number;
	servers: Readonly<Record<string, McpOAuthCredentialHandle>>;
}

function parse(value: unknown): OAuthMetadataDocument | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const raw = value as Record<string, unknown>;
	if (raw.schemaVersion !== 1 || !Number.isSafeInteger(raw.revision) || typeof raw.servers !== "object" || raw.servers === null || Array.isArray(raw.servers)) return undefined;
	return raw as unknown as OAuthMetadataDocument;
}

export class McpOAuthCredentialStore {
	readonly #metadataPath: string;
	readonly #storage: ExtensionStoragePort;
	readonly #secrets: McpOAuthSecretStorePort;

	public constructor(metadataPath: string, storage: ExtensionStoragePort, secrets: McpOAuthSecretStorePort) {
		this.#metadataPath = metadataPath;
		this.#storage = storage;
		this.#secrets = secrets;
	}

	public async load(): Promise<OAuthMetadataDocument> {
		const read = await this.#storage.readFile(this.#metadataPath, 1024 * 1024);
		if (!read.ok) return { schemaVersion: 1, revision: 0, servers: {} };
		try {
			return parse(JSON.parse(Buffer.from(read.value).toString("utf8"))) ?? { schemaVersion: 1, revision: 0, servers: {} };
		} catch {
			return { schemaVersion: 1, revision: 0, servers: {} };
		}
	}

	async #save(document: OAuthMetadataDocument): Promise<void> {
		const saved = await this.#storage.writeFileAtomic(this.#metadataPath, Buffer.from(`${JSON.stringify(document, null, 2)}\n`), { fileMode: 0o600, directoryMode: 0o700 });
		if (!saved.ok) throw new Error(saved.message);
	}

	public async login(input: { serverId: string; provider: McpOAuthProviderPort; authorizationServer: string; redirectUri: string; receiveCode: (authorizationUrl: string, state: string, signal?: AbortSignal) => Promise<string>; signal?: AbortSignal }): Promise<McpOAuthCredentialHandle> {
		const begun = await input.provider.begin({ serverId: input.serverId, authorizationServer: input.authorizationServer, redirectUri: input.redirectUri }, input.signal);
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
