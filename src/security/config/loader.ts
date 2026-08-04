/** 分层配置 loader；存在但损坏的配置必须阻止启动。 */

import type { SecurityConfigLayer, SecurityPolicySource, SecurityResult } from "../types.ts";
import { parseSecurityConfigLayer } from "./schema.ts";

export interface SecurityConfigSourcePort {
	readonly source: SecurityPolicySource;
	read(): Promise<{ readonly status: "missing" } | { readonly status: "available"; readonly text: string }>;
}

function failure(message: string, retryable = false): SecurityResult<never> {
	return { ok: false, error: { code: "invalid_config", message, retryable } };
}

export async function loadSecurityConfigLayers(
	sources: readonly SecurityConfigSourcePort[],
): Promise<SecurityResult<readonly SecurityConfigLayer[]>> {
	const seen = new Set<SecurityPolicySource>();
	const layers: SecurityConfigLayer[] = [];
	for (const source of sources) {
		if (seen.has(source.source)) return failure(`duplicate security config source: ${source.source}`);
		seen.add(source.source);
		let loaded: Awaited<ReturnType<SecurityConfigSourcePort["read"]>>;
		try {
			loaded = await source.read();
		} catch {
			return failure(`${source.source} security config source is unavailable`, true);
		}
		if (loaded.status === "missing") continue;
		const parsed = parseSecurityConfigLayer(source.source, loaded.text);
		if (!parsed.ok) return parsed;
		layers.push(parsed.value);
	}
	return { ok: true, value: layers };
}
