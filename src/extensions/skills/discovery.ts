/** 用户、项目与 plugin Skill 的有界发现。 */

import { join } from "node:path";
import { canonicalDigest } from "../../runtime/protocol/v3/canonical-json.ts";
import { createRuntimeId } from "../../runtime/protocol/v3/ids.ts";
import type { ResourceCapabilityDeclaration, ResourceIdentity, SkillResourceFacet, SkillResourceSet } from "../../runtime/resources/types.ts";
import { DEFAULT_EXTENSION_LIMITS, extensionDiagnostic, sortExtensionDiagnostics } from "../diagnostics.ts";
import type { ExtensionDiagnostic } from "../diagnostics.ts";
import { createExtensionResourceIdentity, qualifiedResourceId } from "../identity.ts";
import { resolveContainedPath } from "../paths.ts";
import { buildResourceManifestDigest, digestDirectory, digestFile, sha256 } from "../trust/digest.ts";
import type { TrustStore } from "../trust/trust-store.ts";
import type { ExtensionRuntimeScope, ExtensionStateDocument } from "../types.ts";
import type { ExtensionStoragePort } from "../storage-port.ts";
import { parseSkillDocument } from "./frontmatter.ts";
import type { SkillDescriptor, SkillDiscoveryResult, SkillDiscoveryRoot } from "./types.ts";

function facetIdentity(base: ResourceIdentity, role: "metadata" | "body" | "assets" | "script", digest: string): ResourceIdentity {
	const kind = role === "metadata" ? "skill" : role === "body" ? "skill-body" : role === "assets" ? "skill-assets" : "skill-script";
	return { ...base, resourceId: createRuntimeId("resource", canonicalDigest({ base: base.qualifiedId, role }).slice(0, 32)), kind, qualifiedId: `${base.qualifiedId}:${role}`, digest };
}

function readCapability(scope: ExtensionRuntimeScope, identity: ResourceIdentity, pathDigest: string): ResourceCapabilityDeclaration {
	return {
		authorityId: scope.authorityId,
		tenantId: scope.tenantId,
		capabilityId: createRuntimeId("resource", canonicalDigest({ identity: identity.qualifiedId, access: "read" }).slice(0, 32)),
		claim: { authorityId: scope.authorityId, tenantId: scope.tenantId, name: "repository_read", resourceKind: "filesystem", resourceDigest: identity.digest, constraintsDigest: pathDigest },
		boundary: { kind: "filesystem", access: "read", pathScopeDigest: pathDigest },
		required: true,
	};
}

async function optionalDirectory(storage: ExtensionStoragePort, root: string, name: string): Promise<string | undefined> {
	const resolved = await resolveContainedPath(storage, root, name);
	if (!resolved.ok) return undefined;
	const info = await storage.stat(resolved.path);
	return info.ok && info.value.kind === "directory" ? resolved.path : undefined;
}

export async function discoverSkills(options: {
	roots: readonly SkillDiscoveryRoot[];
	scope: ExtensionRuntimeScope;
	trustStore: TrustStore;
	state?: ExtensionStateDocument;
	storage: ExtensionStoragePort;
}): Promise<SkillDiscoveryResult> {
	const diagnostics: ExtensionDiagnostic[] = [];
	const skills: SkillDescriptor[] = [];
	let scanned = 0;
	for (const root of [...options.roots].sort((left, right) => left.priority - right.priority || left.rootPath.localeCompare(right.rootPath))) {
		const skillsRoot = root.skillsPath ?? join(root.rootPath, "skills");
		const listed = await options.storage.readDirectory(skillsRoot);
		if (!listed.ok) continue;
		const entries = [...listed.value].sort((left, right) => left.name.localeCompare(right.name));
		for (const entry of entries) {
			if (entry.kind !== "directory") continue;
			scanned += 1;
			if (scanned > DEFAULT_EXTENSION_LIMITS.maxFiles) {
				diagnostics.push(extensionDiagnostic("skill.scan_bound", "error", "skill scan file bound reached", "skill", skillsRoot));
				break;
			}
			const skillRoot = join(skillsRoot, entry.name);
			const contained = await resolveContainedPath(options.storage, skillsRoot, entry.name);
			if (!contained.ok) {
				diagnostics.push(extensionDiagnostic("skill.path_escape", "error", contained.message, "skill", skillRoot));
				continue;
			}
			const skillFile = join(contained.path, "SKILL.md");
			const fileDigest = await digestFile(options.storage, skillFile, DEFAULT_EXTENSION_LIMITS.maxSkillBodyBytes);
			const rootDigest = await digestDirectory(options.storage, contained.path);
			if (!fileDigest.ok) {
				diagnostics.push(extensionDiagnostic("skill.digest_failed", "error", fileDigest.message, "skill", skillFile));
				continue;
			}
			if (!rootDigest.ok) {
				diagnostics.push(extensionDiagnostic("skill.digest_failed", "error", rootDigest.message, "skill", skillFile));
				continue;
			}
			let parsed;
			const read = await options.storage.readFile(skillFile, DEFAULT_EXTENSION_LIMITS.maxSkillBodyBytes);
			if (!read.ok) {
				diagnostics.push(extensionDiagnostic("skill.read_failed", "error", "SKILL.md cannot be read", "skill", skillFile));
				continue;
			}
			parsed = parseSkillDocument(Buffer.from(read.value).toString("utf8"), skillFile);
			diagnostics.push(...parsed.diagnostics);
			if (!parsed.ok) continue;
			const qualifiedId = qualifiedResourceId({ kind: "skill", sourceKey: root.sourceKey, name: parsed.frontmatter.name, ...(root.pluginId ? { pluginId: root.pluginId } : {}) });
			const binding = buildResourceManifestDigest({ rootDigest: rootDigest.digest, manifestDigest: fileDigest.digest, assetsDigest: rootDigest.digest, capabilityDigest: canonicalDigest({ body: "repository_read", assets: "repository_read", script: "process-separate" }) });
			const identity = createExtensionResourceIdentity({ scope: options.scope, kind: "skill", qualifiedId, version: "1", source: root.pluginId ? "plugin" : root.source, digest: binding.combinedDigest });
			const trust = await options.trustStore.evaluate({ identity, canonicalPath: contained.path, binding, principalId: options.scope.principalId });
			const enabled = options.state?.resources[qualifiedId]?.enabled ?? true;
			const trustState = trust.state;
			const activation = !enabled ? "disabled" : trustState === "trusted" ? "ready" : "blocked";
			const referencesPath = await optionalDirectory(options.storage, contained.path, "references");
			const assetsPath = await optionalDirectory(options.storage, contained.path, "assets");
			const scriptsPath = await optionalDirectory(options.storage, contained.path, "scripts");
			const metadataFacet: SkillResourceFacet = { role: "metadata", identity: facetIdentity(identity, "metadata", canonicalDigest(parsed.frontmatter)), capabilities: [] };
			const bodyIdentity = facetIdentity(identity, "body", fileDigest.digest);
			const bodyFacet: SkillResourceFacet = { role: "body", identity: bodyIdentity, capabilities: [readCapability(options.scope, bodyIdentity, sha256(skillFile))] };
			const resourceSet: SkillResourceSet = {
				schemaVersion: 1,
				authorityId: options.scope.authorityId,
				tenantId: options.scope.tenantId,
				qualifiedId,
				metadata: metadataFacet,
				body: bodyFacet,
				...(assetsPath ? { assets: { role: "assets" as const, identity: facetIdentity(identity, "assets", rootDigest.digest), capabilities: [readCapability(options.scope, facetIdentity(identity, "assets", rootDigest.digest), sha256(assetsPath))] } } : {}),
				...(scriptsPath ? { script: { role: "script" as const, identity: facetIdentity(identity, "script", rootDigest.digest), capabilities: [] } } : {}),
			};
			const localDiagnostics = trustState === "trusted" ? [] : [extensionDiagnostic(`skill.${trustState}`, "warning", trust.state === "untrusted" ? trust.reason : trust.reason, "skill", skillFile)];
			skills.push({
				descriptor: {
					schemaVersion: 1,
					kind: "skill",
					identity,
					provenance: { schemaVersion: 1, authorityId: options.scope.authorityId, tenantId: options.scope.tenantId, source: root.pluginId ? "plugin" : root.source, canonicalLocator: skillFile },
					manifest: binding,
					displayName: parsed.frontmatter.name,
					description: parsed.frontmatter.description,
					sourcePath: skillFile,
					...(root.pluginId ? { pluginId: root.pluginId } : {}),
					enabled,
					trust: trustState,
					activation,
					...(trust.state === "trusted" ? { approvalReceiptId: trust.receipt.receiptId } : {}),
					capabilities: [],
					risk: { level: "low", sideEffect: "none", rationaleDigest: canonicalDigest("skill metadata only") },
					exposure: parsed.frontmatter.disableModelInvocation ? "direct-model-only" : "deferred",
					diagnostics: localDiagnostics,
				},
				frontmatter: parsed.frontmatter,
				rootPath: contained.path,
				skillFile,
				bodyDigest: fileDigest.digest,
				resourceSet,
				...(referencesPath ? { referencesPath } : {}),
				...(assetsPath ? { assetsPath } : {}),
				...(scriptsPath ? { scriptsPath } : {}),
				trustBinding: { identity, canonicalPath: contained.path, binding, ...(trust.state === "trusted" ? { receiptId: trust.receipt.receiptId } : {}) },
			});
		}
	}
	return { skills: skills.sort((left, right) => left.descriptor.identity.qualifiedId.localeCompare(right.descriptor.identity.qualifiedId)), diagnostics: sortExtensionDiagnostics(diagnostics) };
}
