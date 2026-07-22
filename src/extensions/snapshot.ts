/** 不可变 ExtensionSnapshot 与 last-known-good 原子交换。 */

import { canonicalDigest } from "../runtime/protocol/v3/canonical-json.ts";
import type { SnapshotId } from "../runtime/protocol/v3/ids.ts";
import { createRuntimeId } from "../runtime/protocol/v3/ids.ts";
import { boundDiagnostics } from "./diagnostics.ts";
import type { ExtensionDiagnostic } from "./diagnostics.ts";
import type { ExtensionComponentCounts, ExtensionResourceDescriptor } from "./types.ts";

export interface ExtensionSnapshot {
	schemaVersion: 1;
	snapshotId: SnapshotId;
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
		mcpTools: 0,
		ready: 0,
		blocked: 0,
		disabled: 0,
		error: 0,
	};
	for (const descriptor of descriptors) {
		if (descriptor.kind === "plugin") counts.plugins += 1;
		if (descriptor.kind === "skill") counts.skills += 1;
		if (descriptor.kind === "hook") counts.hooks += 1;
		if (descriptor.kind === "mcp-server") counts.mcpServers += 1;
		if (descriptor.kind === "mcp-tool") counts.mcpTools += 1;
		if (descriptor.activation === "ready") counts.ready += 1;
		if (descriptor.activation === "blocked") counts.blocked += 1;
		if (descriptor.activation === "disabled") counts.disabled += 1;
		if (descriptor.activation === "failed") counts.error += 1;
	}
	return counts;
}

function stableDescriptors(descriptors: readonly ExtensionResourceDescriptor[]): ExtensionResourceDescriptor[] {
	return [...descriptors]
		.map((descriptor) => ({
			...descriptor,
			capabilities: Object.freeze([...descriptor.capabilities]),
			diagnostics: Object.freeze(boundDiagnostics(descriptor.diagnostics)),
		}))
		.sort((left, right) => left.identity.qualifiedId.localeCompare(right.identity.qualifiedId));
}

export function buildExtensionSnapshot(args: {
	snapshotId?: SnapshotId | string;
	generation: number;
	createdAt: string;
	descriptors: readonly ExtensionResourceDescriptor[];
	diagnostics: readonly ExtensionDiagnostic[];
}): ExtensionSnapshot {
	if (!Number.isSafeInteger(args.generation) || args.generation < 0) throw new Error("invalid snapshot generation");
	const descriptors = stableDescriptors(args.descriptors);
	const duplicateIdentity = descriptors.find(
		(descriptor, index) => index > 0 && descriptor.identity.qualifiedId === descriptors[index - 1]?.identity.qualifiedId,
	);
	if (duplicateIdentity) throw new Error(`duplicate extension identity: ${duplicateIdentity.identity.qualifiedId}`);
	const runtimeNames = new Map<string, string>();
	for (const descriptor of descriptors) {
		if (!descriptor.runtimeName) continue;
		const owner = runtimeNames.get(descriptor.runtimeName);
		if (owner) throw new Error(`runtime name conflict: ${descriptor.runtimeName} (${owner}, ${descriptor.identity.qualifiedId})`);
		runtimeNames.set(descriptor.runtimeName, descriptor.identity.qualifiedId);
	}
	const diagnostics = boundDiagnostics(args.diagnostics);
	const counts = countComponents(descriptors);
	const body = { schemaVersion: 1 as const, generation: args.generation, createdAt: args.createdAt, descriptors, diagnostics, counts };
	const digest = canonicalDigest(body);
	const supplied = args.snapshotId;
	const snapshotId = typeof supplied === "string" && supplied.startsWith("snapshot_")
		? supplied as SnapshotId
		: createRuntimeId("snapshot", digest.slice(0, 32));
	return Object.freeze({ ...body, snapshotId, descriptors: Object.freeze(descriptors), diagnostics: Object.freeze(diagnostics), digest });
}

export type ExtensionSnapshotBuildResult =
	| { ok: true; snapshot: ExtensionSnapshot }
	| { ok: false; error: string; retained?: ExtensionSnapshot };

export class ExtensionSnapshotStore {
	#current?: ExtensionSnapshot;
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
