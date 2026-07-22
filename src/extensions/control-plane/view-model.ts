/** TUI modal/resource bar 可直接消费的纯数据投影。 */

import type { ExtensionManagerSnapshot } from "../extension-manager.ts";

export interface ExtensionResourceViewModel {
	id: string;
	kind: string;
	name: string;
	source: string;
	enabled: boolean;
	trust: string;
	status: string;
	componentCount: number;
	diagnostic?: string;
}

export function extensionViewModels(current: ExtensionManagerSnapshot): readonly ExtensionResourceViewModel[] {
	return current.snapshot.descriptors.map((descriptor) => ({
		id: descriptor.identity.qualifiedId,
		kind: descriptor.kind,
		name: descriptor.displayName,
		source: descriptor.identity.source,
		enabled: descriptor.enabled,
		trust: descriptor.trust,
		status: descriptor.activation,
		componentCount: descriptor.kind === "plugin" ? current.plugins.find((plugin) => plugin.descriptor.identity.qualifiedId === descriptor.identity.qualifiedId)?.blockedComponentCount ?? 0 : 0,
		...(descriptor.diagnostics[0] ? { diagnostic: descriptor.diagnostics[0].message } : {}),
	}));
}
