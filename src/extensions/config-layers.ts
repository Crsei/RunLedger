/**
 * Extension 配置层的纯数据合并骨架。
 *
 * TODO(extension-M1): 实现 managed/user/project/session 的真实路径读取、schema
 * 验证、未知字段处理和安全策略收紧；本文件不读取 settings.json。
 */

export type ExtensionConfigSource = "managed" | "user" | "project" | "session" | "cli";

export interface ExtensionConfigLayer {
	source: ExtensionConfigSource;
	config: Readonly<Record<string, unknown>>;
	digest: string;
}

export interface MergedExtensionConfig {
	config: Readonly<Record<string, unknown>>;
	sources: readonly ExtensionConfigSource[];
	digests: readonly string[];
}

/** 仅提供顶层确定性合并；嵌套策略和 managed deny 由后续安全合同决定。 */
export function mergeExtensionConfigLayers(layers: readonly ExtensionConfigLayer[]): MergedExtensionConfig {
	const config: Record<string, unknown> = {};
	for (const layer of layers) {
		for (const [key, value] of Object.entries(layer.config)) {
			config[key] = value;
		}
	}
	return {
		config,
		sources: layers.map((layer) => layer.source),
		digests: layers.map((layer) => layer.digest),
	};
}
