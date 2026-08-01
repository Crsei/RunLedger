/**
 * ExtensionSnapshot 的 last-known-good 数据骨架。
 *
 * TODO(extension-M1): 增加原子交换、generation/CAS、trust/activation 分离、
 * bounded descriptor 和 Runtime ResourceSnapshot adapter；不得把可执行对象放进快照。
 */

import { canonicalDigest } from "../runtime/protocol/canonical-json.ts";
import type { ExtensionDiagnostic } from "./diagnostics.ts";
import { sortExtensionDiagnostics } from "./diagnostics.ts";
import type { ExtensionComponentCounts, ExtensionResourceDescriptor } from "./types.ts";

export interface ExtensionSnapshot {
	snapshotId: string;
	generation: number;
	createdAt: string;
	descriptors: readonly ExtensionResourceDescriptor[];
	diagnostics: readonly ExtensionDiagnostic[];
	counts: ExtensionComponentCounts;
	digest: string;
}

function countComponents(descriptors: readonly ExtensionResourceDescriptor[]): ExtensionComponentCounts {
	const counts: ExtensionComponentCounts = {
		plugins: 0,
		skills: 0,
		hooks: 0,
		mcpServers: 0,
		ready: 0,
		blocked: 0,
		error: 0,
	};
	for (const descriptor of descriptors) {
		if (descriptor.identity.kind === "plugin") counts.plugins += 1;
		if (descriptor.identity.kind === "skill") counts.skills += 1;
		if (descriptor.identity.kind === "hook") counts.hooks += 1;
		if (descriptor.identity.kind === "mcp") counts.mcpServers += 1;
		if (descriptor.ready) counts.ready += 1;
		if (!descriptor.enabled || !descriptor.trusted) counts.blocked += 1;
	}
	return counts;
}

export function buildExtensionSnapshot(args: {
	snapshotId: string;
	generation: number;
	createdAt: string;
	descriptors: readonly ExtensionResourceDescriptor[];
	diagnostics: readonly ExtensionDiagnostic[];
}): ExtensionSnapshot {
	const descriptors = [...args.descriptors].sort((left, right) =>
		`${left.identity.kind}:${left.identity.qualifiedId}:${left.identity.version}`.localeCompare(
			`${right.identity.kind}:${right.identity.qualifiedId}:${right.identity.version}`,
		),
	);
	const diagnostics = sortExtensionDiagnostics(args.diagnostics);
	const counts = countComponents(descriptors);
	const digest = canonicalDigest({
		snapshotId: args.snapshotId,
		generation: args.generation,
		descriptors,
		diagnostics,
		counts,
	});
	return {
		snapshotId: args.snapshotId,
		generation: args.generation,
		createdAt: args.createdAt,
		descriptors,
		diagnostics,
		counts,
		digest,
	};
}
