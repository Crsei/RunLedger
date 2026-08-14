/** Linter 客户端工厂与缓存 —— 每个 server/cwd 复用一个客户端实例。 */
import type { LinterClient, ServerConfig } from "../types.ts";
import { LspLinterClient } from "./lsp-linter-client.ts";

export { BiomeClient } from "./biome-client.ts";
export { LspLinterClient } from "./lsp-linter-client.ts";
export { SwiftLintClient } from "./swiftlint-client.ts";

const clientCache = new Map<string, LinterClient>();

export function getLinterClient(serverName: string, config: ServerConfig, cwd: string, scope = "standalone"): LinterClient {
	const key = `${scope}:${serverName}:${cwd}`;
	const existing = clientCache.get(key);
	if (existing !== undefined) return existing;
	const client = config.createClient === undefined ? LspLinterClient.create(config, cwd) : config.createClient(config, cwd);
	clientCache.set(key, client);
	return client;
}

export function clearLinterClientCache(scope?: string): void {
	for (const [key, client] of clientCache) {
		if (scope !== undefined && !key.startsWith(`${scope}:`)) continue;
		client.dispose?.();
		clientCache.delete(key);
	}
}
