/**
 * web 检索凭据的 composition 适配器。
 *
 * `src/websource/**` 是库层,只依赖注入的窄 port（见 `websource/credentials.ts`）。
 * 本模块是唯一的装配点:把用户级 `auth.json`（`AuthStorage`，与模型凭据同一份
 * 存储、按 provider id 分条）与白名单环境变量合成一个 port。
 *
 * 两条来源的优先级与上游一致:环境变量优先于存储值（上游 `getEnvApiKey` 在
 * `AuthStorage.getApiKey` 之前生效）。环境变量只按 `WEB_SEARCH_ENV_KEYS` 白名单
 * 读取,不做通配扫描。
 */

import { AuthStorage } from "./auth-storage.ts";
import type { RunledgerLayout } from "../runtime/contracts/storage-layout.ts";
import {
	FIRECRAWL_BASE_URL_ENV_KEYS,
	SEARXNG_ENV_KEYS,
	WEB_SEARCH_ENV_KEYS,
	type WebSearchCredentialId,
	type WebSearchCredentialPort,
} from "../websource/credentials.ts";

/** 部署配置的 config id；值为环境变量名列表。 */
const WEB_SEARCH_CONFIG_ENV_KEYS: Readonly<Record<string, readonly string[]>> = {
	"firecrawl.baseUrl": FIRECRAWL_BASE_URL_ENV_KEYS,
	"searxng.endpoint": SEARXNG_ENV_KEYS.endpoint,
	"searxng.token": SEARXNG_ENV_KEYS.token,
	"searxng.basicUsername": SEARXNG_ENV_KEYS.basicUsername,
	"searxng.basicPassword": SEARXNG_ENV_KEYS.basicPassword,
};

export interface WebSearchCredentialsOptions {
	readonly layout: RunledgerLayout;
	/** 进程环境快照;缺省读 `process.env`。注入以便测试与可审计。 */
	readonly env?: Readonly<Record<string, string | undefined>>;
}

/**
 * 构造生产凭据 port。
 *
 * `AuthStorage` 在构造时同步读完 `auth.json`（与模型路径同一实现、同一文件锁），
 * 因此凭据写入后需要新建 port 才会生效;这与设置快照的语义一致（会话级冻结）。
 */
export function createWebSearchCredentials(options: WebSearchCredentialsOptions): WebSearchCredentialPort {
	const storage = AuthStorage.create(options.layout);
	const env = options.env ?? process.env;
	return {
		has: async (id) => (await resolveKey(storage, env, id)) !== undefined,
		getApiKey: (id) => resolveKey(storage, env, id),
		getConfig: async (id) => firstEnv(env, WEB_SEARCH_CONFIG_ENV_KEYS[id] ?? []),
	};
}

async function resolveKey(
	storage: AuthStorage,
	env: Readonly<Record<string, string | undefined>>,
	id: WebSearchCredentialId,
): Promise<string | undefined> {
	const fromEnv = firstEnv(env, WEB_SEARCH_ENV_KEYS[id]);
	if (fromEnv !== undefined) return fromEnv;
	try {
		const credential = await storage.read(id);
		if (credential === undefined) return undefined;
		if (credential.type === "api_key") {
			const key = credential.key?.trim();
			return key === undefined || key.length === 0 ? undefined : key;
		}
		const access = credential.access.trim();
		return access.length === 0 ? undefined : access;
	} catch {
		// 凭据文件不可读时按「未配置」处理:检索会自动跳过该 provider,而不是
		// 让整个工具调用因存储故障失败。
		return undefined;
	}
}

function firstEnv(
	env: Readonly<Record<string, string | undefined>>,
	names: readonly string[],
): string | undefined {
	for (const name of names) {
		const value = env[name]?.trim();
		if (value !== undefined && value.length > 0) return value;
	}
	return undefined;
}
