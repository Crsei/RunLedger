/** 只包含 bounded descriptor 的不可变快照与 last-known-good 交换器。 */

import { canonicalDigest } from "../runtime/protocol/canonical-json.ts";
import { boundDiagnostics, sortExtensionDiagnostics } from "./diagnostics.ts";
import type { ExtensionDiagnostic } from "./diagnostics.ts";
import type { ExtensionComponentCounts, ExtensionResourceDescriptor } from "./types.ts";

export interface ExtensionSnapshot {
	readonly snapshotId: string;
	readonly generation: number;
	readonly createdAt: string;
	readonly descriptors: readonly ExtensionResourceDescriptor[];
	readonly diagnostics: readonly ExtensionDiagnostic[];
	readonly counts: ExtensionComponentCounts;
	readonly skillProviders: readonly ExtensionSkillProviderProjection[];
	readonly digest: string;
}

/** provider status/counts 的中立 public 投影（不含 provider 实现或 handle）。 */
export interface ExtensionSkillProviderProjection {
	readonly providerId: string;
	readonly displayName: string;
	readonly rank: number;
	readonly effectiveEnabled: boolean;
	readonly state: "disabled" | "unavailable" | "loaded" | "failed" | "aborted";
	readonly candidateCount: number;
	readonly activeCount: number;
	readonly failedCount: number;
	readonly lastError?: string;
}

function countComponents(descriptors: readonly ExtensionResourceDescriptor[]): ExtensionComponentCounts {
	const counts = {
		plugins: 0,
		skills: 0,
		hooks: 0,
		mcpServers: 0,
		mcpTools: 0,
		ready: 0,
		blocked: 0,
		disabled: 0,
		error: 0,
	};
	for (const descriptor of descriptors) {
		const kind = descriptor.kind ?? descriptor.identity.kind;
		if (kind === "plugin") counts.plugins += 1;
		if (kind === "skill") counts.skills += 1;
		if (kind === "hook") counts.hooks += 1;
		if (kind === "mcp" || kind === "mcp-server") counts.mcpServers += 1;
		if (kind === "mcp-tool") counts.mcpTools += 1;
		if (!descriptor.enabled || descriptor.activation === "disabled") counts.disabled += 1;
		else if (descriptor.activation === "failed") counts.error += 1;
		else if (descriptor.ready || descriptor.activation === "ready") counts.ready += 1;
		else if (!descriptor.trusted || descriptor.activation === "blocked") counts.blocked += 1;
		else counts.error += 1;
	}
	return counts;
}

function stableDescriptors(descriptors: readonly ExtensionResourceDescriptor[]): ExtensionResourceDescriptor[] {
	return [...descriptors].sort((left, right) => {
		const leftKey = `${left.identity.kind}:${left.identity.qualifiedId}:${left.identity.version}`;
		const rightKey = `${right.identity.kind}:${right.identity.qualifiedId}:${right.identity.version}`;
		return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
	});
}

export function buildExtensionSnapshot(args: {
	readonly snapshotId: string;
	readonly generation: number;
	readonly createdAt: string;
	readonly descriptors: readonly ExtensionResourceDescriptor[];
	readonly diagnostics: readonly ExtensionDiagnostic[];
	readonly skillProviders?: readonly ExtensionSkillProviderProjection[];
}): ExtensionSnapshot {
	if (!Number.isSafeInteger(args.generation) || args.generation < 0) throw new Error("invalid snapshot generation");
	const descriptors = stableDescriptors(args.descriptors);
	const identityKeys = new Set<string>();
	for (const descriptor of descriptors) {
		const identityKey = `${descriptor.identity.kind}:${descriptor.identity.qualifiedId}`;
		if (identityKeys.has(identityKey)) throw new Error(`duplicate extension identity: ${identityKey}`);
		identityKeys.add(identityKey);
	}
	const runtimeNames = new Map<string, string>();
	for (const descriptor of descriptors) {
		if (!descriptor.runtimeName) continue;
		const owner = runtimeNames.get(descriptor.runtimeName);
		if (owner) throw new Error(`runtime name conflict: ${descriptor.runtimeName} (${owner}, ${descriptor.identity.qualifiedId})`);
		runtimeNames.set(descriptor.runtimeName, descriptor.identity.qualifiedId);
	}
	const diagnostics = boundDiagnostics(sortExtensionDiagnostics(args.diagnostics));
	const counts = countComponents(descriptors);
	const skillProviders = Object.freeze([...(args.skillProviders ?? [])].sort((left, right) => left.rank - right.rank || (left.providerId < right.providerId ? -1 : left.providerId > right.providerId ? 1 : 0)));
	const body = {
		snapshotId: args.snapshotId,
		generation: args.generation,
		createdAt: args.createdAt,
		descriptors,
		diagnostics,
		counts,
		skillProviders,
	};
	const digest = canonicalDigest(body);
	return Object.freeze({
		...body,
		digest,
		descriptors: Object.freeze(descriptors.map((descriptor) => Object.freeze({
			...descriptor,
			...(descriptor.diagnostics ? { diagnostics: Object.freeze([...descriptor.diagnostics]) } : {}),
			...(descriptor.capabilities ? { capabilities: Object.freeze([...descriptor.capabilities]) } : {}),
		}))),
		diagnostics: Object.freeze([...diagnostics]),
	});
}

export type ExtensionSnapshotBuildResult =
	| { readonly ok: true; readonly snapshot: ExtensionSnapshot }
	| { readonly ok: false; readonly error: string; readonly retained?: ExtensionSnapshot };

export class ExtensionSnapshotStore {
	#current: ExtensionSnapshot | undefined;
	#pending = false;
	#activeTurns = 0;

	public current(): ExtensionSnapshot | undefined {
		return this.#current;
	}

	public beginTurn(): ExtensionSnapshot {
		if (!this.#current) throw new Error("extension snapshot is unavailable");
		this.#activeTurns += 1;
		return this.#current;
	}

	public endTurn(): boolean {
		this.#activeTurns = Math.max(0, this.#activeTurns - 1);
		return this.#activeTurns === 0 && this.#pending;
	}

	public requestReload(): "ready" | "pending" {
		if (this.#activeTurns > 0) {
			this.#pending = true;
			return "pending";
		}
		return "ready";
	}

	public swap(candidate: ExtensionSnapshot): ExtensionSnapshotBuildResult {
		if (this.#activeTurns > 0) {
			this.#pending = true;
			return { ok: false, error: "reload requires an idle boundary", ...(this.#current ? { retained: this.#current } : {}) };
		}
		if (this.#current && candidate.generation <= this.#current.generation) {
			return { ok: false, error: "snapshot generation must increase", retained: this.#current };
		}
		this.#current = candidate;
		this.#pending = false;
		return { ok: true, snapshot: candidate };
	}

	public pending(): boolean {
		return this.#pending;
	}
}
