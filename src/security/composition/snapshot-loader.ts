/**
 * S2 拆分:Security 配置快照加载(composition 的 config source 翻译)。
 *
 * managed/project/user 三个 JSON source 的读取与 section 抽取保持拆分前
 * 语义;loader/resolver 仍由 `../config/` 领域模块拥有,此处只做组合装配。
 */

import { join, resolve } from "node:path";
import { loadSecurityConfigLayers } from "../config/loader.ts";
import { resolveSecuritySnapshot } from "../config/resolver.ts";
import { readLocalUtf8File } from "../integration/session-local-leaves.ts";
import type { SecuritySnapshot } from "../types.ts";
import type { SessionSecurityCompositionOptions, SessionSecurityConfigSource } from "./session-security.ts";

export async function loadSnapshot(
	options: SessionSecurityCompositionOptions,
	storageKey: string,
	cwd: string,
): Promise<SecuritySnapshot> {
	const loaded = await loadSecurityConfigLayers([
		...(options.securitySources ?? []),
		jsonFileSource("managed", "/etc/runledger/security.json", false),
		jsonFileSource("project", join(options.layout.projects, storageKey, "settings.json"), true),
		jsonFileSource("user", options.layout.settings, true),
	]);
	if (!loaded.ok) throw new Error(loaded.error.message);
	const resolved = resolveSecuritySnapshot({
		layers: loaded.value,
		workspaceRoot: cwd,
		tempRoot: resolve(options.layout.tmp, options.fence.sessionId),
		createdAt: (options.now ?? (() => new Date()))().toISOString(),
	});
	if (!resolved.ok) throw new Error(resolved.error.message);
	return resolved.value;
}

function jsonFileSource(
	source: SessionSecurityConfigSource["source"],
	path: string,
	section: boolean,
): SessionSecurityConfigSource {
	return {
		source,
		read: async () => {
			let text: string;
			try {
				text = await readLocalUtf8File(path);
			} catch (error) {
				if (isMissing(error)) return { status: "missing" };
				throw error;
			}
			if (!section) return { status: "available", text };
			let parsed: unknown;
			try {
				parsed = JSON.parse(text) as unknown;
			} catch {
				return { status: "available", text: "{" };
			}
			if (!isRecord(parsed) || !Object.prototype.hasOwnProperty.call(parsed, "security")) return { status: "missing" };
			return { status: "available", text: JSON.stringify(parsed.security) };
		},
	};
}

function isMissing(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
