/** 用户、项目与 plugin Skill 的只读、有界发现。 */

import { canonicalDigest } from "../../runtime/protocol/canonical-json.ts";
import { createRuntimeId } from "../../runtime/protocol/ids.ts";
import type { ResourceIdentity, ResourceSource } from "../../runtime/resources/types.ts";
import { DEFAULT_EXTENSION_LIMITS, extensionDiagnostic, sortExtensionDiagnostics } from "../diagnostics.ts";
import type { ExtensionScanLimits, ExtensionDiagnostic } from "../diagnostics.ts";
import { qualifiedResourceId, createExtensionResourceIdentity, createExtensionResourceProvenance } from "../identity.ts";
import { resolveContainedPath } from "../paths.ts";
import type { ExtensionStoragePort } from "../storage-port.ts";
import type { ExtensionRuntimeScope, ExtensionSourceRoot, ExtensionStateDocument } from "../types.ts";
import { buildResourceManifestDigest, digestDirectory, digestFile } from "../trust/digest.ts";
import type { TrustStore } from "../trust/trust-store.ts";
import { parseSkillDocument } from "./frontmatter.ts";
import type { SkillDescriptor, SkillDiscoveryResult, SkillResourceFacet, SkillResourceFacetRole, SkillResourceSet } from "./types.ts";

function facetIdentity(base: ResourceIdentity, role: SkillResourceFacetRole, digest: string): ResourceIdentity {
	return {
		...base,
		resourceId: createRuntimeId("resource", canonicalDigest({ qualifiedId: base.qualifiedId, role }).slice(0, 32)),
		qualifiedId: `${base.qualifiedId}:${role}`,
		digest: { algorithm: "sha256", digest: digest as ResourceIdentity["digest"]["digest"] },
	};
}

function facet(
	base: ResourceIdentity,
	role: SkillResourceFacetRole,
	digest: string,
	bytes: number,
	entries: number,
	capabilities: readonly string[],
): SkillResourceFacet {
	return { role, identity: facetIdentity(base, role, digest), contentDigest: digest, byteLength: bytes, entryCount: entries, capabilities };
}

async function optionalDirectory(storage: ExtensionStoragePort, root: string, name: string): Promise<string | undefined> {
	const resolved = await resolveContainedPath(storage, root, name);
	if (!resolved.ok) return undefined;
	const info = await storage.stat(resolved.path);
	return info.ok && info.value.kind === "directory" ? resolved.path : undefined;
}

function extensionIdentityDigest(value: string): string {
	return value;
}

async function discoverOne(options: {
	readonly root: ExtensionSourceRoot;
	readonly skillRoot: string;
	readonly scope: ExtensionRuntimeScope;
	readonly trustStore: TrustStore;
	readonly state?: ExtensionStateDocument;
	readonly storage: ExtensionStoragePort;
	readonly limits: ExtensionScanLimits;
}): Promise<{ readonly skill?: SkillDescriptor; readonly diagnostics: readonly ExtensionDiagnostic[] }> {
	const { root, skillRoot, scope, trustStore, state, storage, limits } = options;
	const diagnostics: ExtensionDiagnostic[] = [];
	const skillFile = `${skillRoot}/SKILL.md`;
	const fileDigest = await digestFile(storage, skillFile, limits.maxSkillBodyBytes);
	if (!fileDigest.ok) return { diagnostics: [extensionDiagnostic("skill.digest_failed", "error", fileDigest.message, "skill", skillFile)] };
	const rootDigest = await digestDirectory(storage, skillRoot, limits);
	if (!rootDigest.ok) return { diagnostics: [extensionDiagnostic("skill.digest_failed", "error", rootDigest.message, "skill", skillRoot)] };
	const read = await storage.readFile(skillFile, limits.maxSkillBodyBytes);
	if (!read.ok) return { diagnostics: [extensionDiagnostic("skill.read_failed", "error", read.message, "skill", skillFile)] };
	const parsed = parseSkillDocument(Buffer.from(read.value).toString("utf8"), skillFile);
	diagnostics.push(...parsed.diagnostics);
	if (!parsed.ok) return { diagnostics };
	const qualifiedId = qualifiedResourceId({ kind: "skill", sourceKey: root.sourceKey, name: parsed.frontmatter.name, ...(root.pluginId ? { pluginId: root.pluginId } : {}) });
	const metadataDigest = canonicalDigest(parsed.frontmatter);
	const binding = buildResourceManifestDigest({
		rootDigest: rootDigest.digest,
		manifestDigest: fileDigest.digest,
		configDigest: metadataDigest,
		assetsDigest: rootDigest.digest,
		capabilityDigest: canonicalDigest({ body: "filesystem:read", assets: "filesystem:read", script: "process:spawn-separate" }),
	});
	const source: ResourceSource = root.pluginId ? "plugin" : root.source;
	const resourceIdentity = createExtensionResourceIdentity({ kind: "skill", qualifiedId, version: "1", source, digest: binding.combinedDigest });
	const trustScope = root.source === "user" ? "user" : root.source === "session" ? "session" : "project";
	const trust = await trustStore.evaluate({ identity: resourceIdentity, canonicalPath: skillRoot, binding, principalId: scope.principalId, scope: trustScope });
	const enabled = state?.resources[qualifiedId]?.enabled ?? true;
	const trusted = trust.state === "trusted";
	const activation: "disabled" | "ready" | "blocked" = !enabled ? "disabled" : trusted ? "ready" : "blocked";
	const referencesPath = await optionalDirectory(storage, skillRoot, "references");
	const assetsPath = await optionalDirectory(storage, skillRoot, "assets");
	const scriptsPath = await optionalDirectory(storage, skillRoot, "scripts");
	const referencesDigest = referencesPath ? await digestDirectory(storage, referencesPath, limits) : undefined;
	const assetsDigest = assetsPath ? await digestDirectory(storage, assetsPath, limits) : undefined;
	const scriptsDigest = scriptsPath ? await digestDirectory(storage, scriptsPath, limits) : undefined;
	const resourceSet: SkillResourceSet = {
		qualifiedId,
		metadata: facet(resourceIdentity, "metadata", metadataDigest, Buffer.byteLength(JSON.stringify(parsed.frontmatter), "utf8"), 1, []),
		body: facet(resourceIdentity, "body", fileDigest.digest, fileDigest.bytes, 1, ["filesystem:read"]),
		...(referencesPath && referencesDigest?.ok ? { references: facet(resourceIdentity, "references", referencesDigest.digest, referencesDigest.bytes, referencesDigest.files, ["filesystem:read"]) } : {}),
		...(assetsPath && assetsDigest?.ok ? { assets: facet(resourceIdentity, "assets", assetsDigest.digest, assetsDigest.bytes, assetsDigest.files, ["filesystem:read"]) } : {}),
		...(scriptsPath && scriptsDigest?.ok ? { script: facet(resourceIdentity, "script", scriptsDigest.digest, scriptsDigest.bytes, scriptsDigest.files, ["process:spawn"]) } : {}),
		budget: { maxBytes: limits.maxDirectoryBytes, maxEntries: limits.maxEntries },
	};
	if (!trusted) diagnostics.push(extensionDiagnostic(`skill.${trust.state}`, "warning", trust.reason, "skill", skillFile));
	const descriptor: SkillDescriptor["descriptor"] = {
		kind: "skill",
		identity: { kind: "skill", qualifiedId, version: "1", source, digest: extensionIdentityDigest(binding.combinedDigest) },
		resource: resourceIdentity,
		provenance: createExtensionResourceProvenance({ source, canonicalLocator: skillFile, sourceRoot: root.rootPath }),
		displayName: parsed.frontmatter.name,
		description: parsed.frontmatter.description,
		sourcePath: skillFile,
		...(root.pluginId ? { pluginId: root.pluginId } : {}),
		priority: root.priority,
		enabled,
		trusted,
		ready: activation === "ready",
		trust: trust.state,
		activation,
		...(trusted ? { approvalReceiptId: trust.receipt.receiptId } : {}),
		diagnostics,
		capabilities: [],
	};
	return {
		skill: {
			descriptor,
			frontmatter: parsed.frontmatter,
			rootPath: skillRoot,
			skillFile,
			bodyDigest: fileDigest.digest,
			resourceSet,
			...(referencesPath ? { referencesPath } : {}),
			...(assetsPath ? { assetsPath } : {}),
			...(scriptsPath ? { scriptsPath } : {}),
			sourceRoot: root,
			priority: root.priority,
			trustBinding: { identity: resourceIdentity, canonicalPath: skillRoot, binding, principalId: scope.principalId, ...(trusted ? { receiptId: trust.receipt.receiptId } : {}) },
		},
		diagnostics,
	};
}

export async function discoverSkills(options: {
	readonly roots: readonly ExtensionSourceRoot[];
	readonly scope: ExtensionRuntimeScope;
	readonly trustStore: TrustStore;
	readonly state?: ExtensionStateDocument;
	readonly storage: ExtensionStoragePort;
	readonly limits?: ExtensionScanLimits;
}): Promise<SkillDiscoveryResult> {
	const limits = options.limits ?? DEFAULT_EXTENSION_LIMITS;
	const diagnostics: ExtensionDiagnostic[] = [];
	const skills: SkillDescriptor[] = [];
	let scannedEntries = 0;
	const roots = [...options.roots].sort((left, right) => left.priority - right.priority || (left.rootPath < right.rootPath ? -1 : 1));
	for (const root of roots) {
		const rootResult = await options.storage.realpath(root.rootPath);
		if (!rootResult.ok) continue;
		const skillsPath = root.skillsPath ?? `${rootResult.value}/skills`;
		const skillsResult = await resolveContainedPath(options.storage, rootResult.value, root.skillsPath ? root.skillsPath : "./skills");
		if (!skillsResult.ok) continue;
		const listed = await options.storage.readDirectory(skillsResult.path);
		if (!listed.ok) continue;
		const entries = [...listed.value].sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
		const work = entries.filter((entry) => entry.kind === "directory");
		let cursor = 0;
		const worker = async (): Promise<void> => {
			while (cursor < work.length) {
				const entry = work[cursor];
				cursor += 1;
				if (!entry) return;
				scannedEntries += 1;
				if (scannedEntries > Math.min(limits.maxFiles, limits.maxEntries)) {
					diagnostics.push(extensionDiagnostic("skill.scan_bound", "error", "skill scan entry bound reached", "skill", skillsPath));
					return;
				}
				const contained = await resolveContainedPath(options.storage, skillsResult.path, entry.name);
				if (!contained.ok) {
					diagnostics.push(extensionDiagnostic("skill.path_escape", "error", contained.message, "skill", `${skillsPath}/${entry.name}`));
					continue;
				}
				const result = await discoverOne({ root, skillRoot: contained.path, scope: options.scope, trustStore: options.trustStore, ...(options.state ? { state: options.state } : {}), storage: options.storage, limits });
				diagnostics.push(...result.diagnostics);
				if (result.skill) skills.push(result.skill);
			}
		};
		const workers = Math.min(Math.max(1, limits.maxConcurrentScans), Math.max(1, work.length));
		await Promise.all(Array.from({ length: workers }, () => worker()));
	}
	return { skills: skills.sort((left, right) => left.descriptor.identity.qualifiedId < right.descriptor.identity.qualifiedId ? -1 : left.descriptor.identity.qualifiedId > right.descriptor.identity.qualifiedId ? 1 : 0), diagnostics: sortExtensionDiagnostics(diagnostics) };
}
