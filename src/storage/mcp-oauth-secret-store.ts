/** MCP OAuth token 到受锁 AuthStorage 专用项的 adapter。 */

import { createHash } from "node:crypto";
import type { CredentialStore, OAuthCredential } from "../auth/types.ts";
import type {
	McpOAuthCredentialHandle,
	McpOAuthSecretStorePort,
} from "../extensions/mcp/oauth.ts";
import { canonicalDigest } from "../runtime/protocol/v3/canonical-json.ts";

function storageKey(serverId: string, audience: string): string {
	const digest = createHash("sha256")
		.update(JSON.stringify({ serverId, audience }), "utf8")
		.digest("hex");
	return `mcp:${digest}`;
}

function credential(material: string): OAuthCredential {
	try {
		const value = JSON.parse(material) as Record<string, unknown>;
		const access = typeof value.access_token === "string" ? value.access_token : "";
		if (!access) throw new Error("missing access token");
		const refresh = typeof value.refresh_token === "string" ? value.refresh_token : "";
		const expiresIn = typeof value.expires_in === "number" && Number.isFinite(value.expires_in)
			? Math.max(0, value.expires_in)
			: 0;
		return {
			type: "oauth",
			access,
			refresh,
			expires: expiresIn > 0 ? Date.now() + expiresIn * 1_000 : Number.MAX_SAFE_INTEGER,
			tokenType: typeof value.token_type === "string" ? value.token_type : "Bearer",
			scope: typeof value.scope === "string" ? value.scope : undefined,
		};
	} catch {
		// 兼容已有自定义 provider 只返回 opaque access token 的端口。
		return {
			type: "oauth",
			access: material,
			refresh: "",
			expires: Number.MAX_SAFE_INTEGER,
		};
	}
}

export class AuthStorageMcpOAuthSecretStore implements McpOAuthSecretStorePort {
	readonly #credentials: CredentialStore;

	public constructor(credentials: CredentialStore) {
		this.#credentials = credentials;
	}

	public async store(input: {
		serverId: string;
		audience: string;
		credentialMaterial: string;
	}): Promise<McpOAuthCredentialHandle> {
		const handleId = storageKey(input.serverId, input.audience);
		await this.#credentials.modify(handleId, async () => credential(input.credentialMaterial));
		return {
			handleId,
			audienceDigest: canonicalDigest(input.audience),
			issuedAt: new Date().toISOString(),
		};
	}

	public async revoke(handleId: string): Promise<boolean> {
		if (!/^mcp:[a-f0-9]{64}$/u.test(handleId)) return false;
		const existing = await this.#credentials.read(handleId);
		if (!existing) return false;
		await this.#credentials.delete(handleId);
		return true;
	}
}
