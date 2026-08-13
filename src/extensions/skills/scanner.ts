/**
 * 统一 Skill 扫描与归一化：非递归 immediate-child 扫描、frontmatter 校验、
 * 目录/文件 digest、resource facet 与 trust evaluation。
 *
 * 从原 discovery.ts 拆出，供 discoverSkills facade（迁移期）与 SkillRegistry
 * 的 canonical/plugin providers 共用；frontmatter/digest/facet/containment
 * 输出必须与原 discoverOne 等价（P0 characterization 守护）。
 */

import { canonicalDigest } from "../../runtime/protocol/canonical-json.ts";
import { createRuntimeId } from "../../runtime/protocol/ids.ts";
import type { ResourceIdentity, ResourceSource } from "../../runtime/resources/types.ts";
import { DEFAULT_EXTENSION_LIMITS, extensionDiagnostic, type ExtensionDiagnostic } from "../diagnostics.ts";
import type { ExtensionScanLimits } from "../diagnostics.ts";
import { qualifiedResourceId, createExtensionResourceIdentity, createExtensionResourceProvenance } from "../identity.ts";
import { resolveContainedPath } from "../paths.ts";
import type { ExtensionStoragePort } from "../storage-port.ts";
import type { ExtensionRuntimeScope, ExtensionSourceRoot, ExtensionStateDocument } from "../types.ts";
import { buildResourceManifestDigest, digestDirectory, digestFile } from "../trust/digest.ts";
import type { TrustStore } from "../trust/trust-store.ts";
import { parseSkillDocument } from "./frontmatter.ts";
import type { SkillDescriptor, SkillDiscoveryResult, SkillResourceFacet, SkillResourceFacetRole, SkillResourceSet, SkillTrustBinding } from "./types.ts";

export interface SkillScanOptions {
	readonly root: ExtensionSourceRoot;
	readonly scope: ExtensionRuntimeScope;
	readonly trustStore: TrustStore;
	readonly state?: ExtensionStateDocument;
	readonly limits: ExtensionScanLimits;
	/** 产生该 observation 的 provider（P2 provider status 归属）。 */
	readonly providerId?: string;
}

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

/**
 * 扫描单个 Skill 目录（等价原 discoverOne）：digest SKILL.md 与整目录、
 * 校验 frontmatter、构建 resource facets 与 trust binding，不做激活决策。
 */
export async function scanSkill(
	storage: ExtensionStoragePort,
	options: SkillScanOptions & { readonly skillRoot: string; readonly inheritedTrustBinding?: SkillTrustBinding },
): Promise<{ readonly skill?: SkillDescriptor; readonly diagnostics: readonly ExtensionDiagnostic[] }> {
	const { root, skillRoot, scope, trustStore, state, limits, inheritedTrustBinding } = options;
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
	const trustInput = inheritedTrustBinding ?? { identity: resourceIdentity, canonicalPath: skillRoot, binding, principalId: scope.principalId };
	const trust = await trustStore.evaluate({
		identity: trustInput.identity,
		canonicalPath: trustInput.canonicalPath,
		binding: trustInput.binding,
		principalId: trustInput.principalId,
		...(inheritedTrustBinding === undefined ? { scope: trustScope } : {}),
	});
	const enabled = state?.resources[qualifiedId]?.enabled ?? true;
	const trusted = trust.state === "trusted" && (inheritedTrustBinding === undefined || inheritedTrustBinding.receiptId === trust.receipt.receiptId);
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
	if (!trusted) {
		const reason = trust.state === "trusted" ? "inherited trust receipt is missing or stale" : trust.reason;
		diagnostics.push(extensionDiagnostic(`skill.${trust.state}`, "warning", reason, "skill", skillFile));
	}
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
			trustBinding: {
				...trustInput,
				...(trusted ? { receiptId: trust.receipt.receiptId } : {}),
			},
			...(options.providerId === undefined ? {} : { providerIds: [options.providerId] }),
		},
		diagnostics,
	};
}

export interface SkillEntryList {
	readonly entries: readonly string[];
	readonly diagnostics: readonly ExtensionDiagnostic[];
}

/**
 * 非递归列出一个 skills root 的 immediate-child 目录：排序、bounded、
 * containment 校验。symlink/device 条目按原行为静默跳过（不产生 descriptor）。
 */
export async function listSkillEntries(storage: ExtensionStoragePort, skillsRoot: string, limits: ExtensionScanLimits): Promise<SkillEntryList> {
	const diagnostics: ExtensionDiagnostic[] = [];
	const listed = await storage.readDirectory(skillsRoot);
	if (!listed.ok) return { entries: [], diagnostics };
	const entries = [...listed.value].sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
	const work = entries.filter((entry) => entry.kind === "directory");
	const roots: string[] = [];
	let scanned = 0;
	for (const entry of work) {
		if (!entry) continue;
		scanned += 1;
		if (scanned > Math.min(limits.maxFiles, limits.maxEntries)) {
			diagnostics.push(extensionDiagnostic("skill.scan_bound", "error", "skill scan entry bound reached", "skill", skillsRoot));
			break;
		}
		const contained = await resolveContainedPath(storage, skillsRoot, entry.name);
		if (!contained.ok) {
			diagnostics.push(extensionDiagnostic("skill.path_escape", "error", contained.message, "skill", `${skillsRoot}/${entry.name}`));
			continue;
		}
		roots.push(contained.path);
	}
	return { entries: roots, diagnostics };
}

/**
 * 扫描一个 skills root 下全部 immediate-child skill 目录（等价原 discoverSkills
 * 的单 root 内部循环，含并发上限）。
 */
export async function scanSkillsDirectory(
	storage: ExtensionStoragePort,
	options: SkillScanOptions & { readonly skillsRoot: string },
): Promise<{ readonly skills: readonly SkillDescriptor[]; readonly diagnostics: readonly ExtensionDiagnostic[] }> {
	const { skillsRoot, limits } = options;
	const listed = await listSkillEntries(storage, skillsRoot, limits);
	const diagnostics = [...listed.diagnostics];
	const skills: SkillDescriptor[] = [];
	let cursor = 0;
	const worker = async (): Promise<void> => {
		while (cursor < listed.entries.length) {
			const entry = listed.entries[cursor];
			cursor += 1;
			if (!entry) continue;
			const result = await scanSkill(storage, { ...options, skillRoot: entry });
			diagnostics.push(...result.diagnostics);
			if (result.skill) skills.push(result.skill);
		}
	};
	const workers = Math.min(Math.max(1, limits.maxConcurrentScans), Math.max(1, listed.entries.length));
	await Promise.all(Array.from({ length: workers }, () => worker()));
	return { skills, diagnostics };
}

export type { SkillDiscoveryResult };
