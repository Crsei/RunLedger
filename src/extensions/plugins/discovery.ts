/** 用户/项目 plugin 发现；untrusted plugin 只暴露 manifest metadata。 */

import { join } from "node:path";
import { canonicalDigest } from "../../runtime/protocol/v3/canonical-json.ts";
import { extensionDiagnostic } from "../diagnostics.ts";
import type { ExtensionDiagnostic } from "../diagnostics.ts";
import { createExtensionResourceIdentity, qualifiedResourceId } from "../identity.ts";
import { resolveDeclaredPath, resolveContainedPath } from "../paths.ts";
import type { ExtensionStoragePort } from "../storage-port.ts";
import { buildResourceManifestDigest, digestDirectory, digestFile } from "../trust/digest.ts";
import type { TrustStore } from "../trust/trust-store.ts";
import type { ExtensionRuntimeScope, ExtensionSourceRoot, ExtensionStateDocument } from "../types.ts";
import { parsePluginManifest } from "./manifest.ts";
import type { PluginDescriptor, PluginDiscoveryResult } from "./types.ts";

export async function discoverPlugins(options: {
	roots: readonly ExtensionSourceRoot[];
	scope: ExtensionRuntimeScope;
	trustStore: TrustStore;
	storage: ExtensionStoragePort;
	state?: ExtensionStateDocument;
	pluginDataRoot: string;
}): Promise<PluginDiscoveryResult> {
	const plugins: PluginDescriptor[] = [];
	const diagnostics: ExtensionDiagnostic[] = [];
	for (const root of options.roots) {
		const pluginsRoot = join(root.rootPath, "plugins");
		const listed = await options.storage.readDirectory(pluginsRoot);
		if (!listed.ok) continue;
		for (const entry of [...listed.value].sort((left, right) => left.name.localeCompare(right.name))) {
			if (entry.kind !== "directory") continue;
			const contained = await resolveContainedPath(options.storage, pluginsRoot, entry.name);
			if (!contained.ok) {
				diagnostics.push(extensionDiagnostic("plugin.path_escape", "error", contained.message, "plugin", join(pluginsRoot, entry.name)));
				continue;
			}
			const manifestPath = join(contained.path, ".runledger-plugin", "plugin.json");
			const read = await options.storage.readFile(manifestPath, 1024 * 1024);
			if (!read.ok) continue;
			const parsed = parsePluginManifest(read.value, manifestPath);
			diagnostics.push(...parsed.diagnostics);
			if (!parsed.ok) continue;
			const rootDigest = await digestDirectory(options.storage, contained.path);
			const manifestDigest = await digestFile(options.storage, manifestPath, 1024 * 1024);
			if (!rootDigest.ok || !manifestDigest.ok) {
				diagnostics.push(extensionDiagnostic("plugin.digest_failed", "error", !rootDigest.ok ? rootDigest.message : "plugin manifest digest failed", "plugin", manifestPath));
				continue;
			}
			const skillRoots: string[] = [];
			const hookConfigs: string[] = [];
			let invalidIdentityPath = false;
			for (const declaration of parsed.manifest.skills) {
				const resolved = await resolveDeclaredPath(options.storage, contained.path, declaration);
				if (!resolved.ok) {
					diagnostics.push(extensionDiagnostic("plugin.component_escape", "error", resolved.message, "plugin", manifestPath));
					invalidIdentityPath = true;
					break;
				}
				skillRoots.push(resolved.path);
			}
			for (const declaration of parsed.manifest.hooks) {
				const resolved = await resolveDeclaredPath(options.storage, contained.path, declaration);
				if (!resolved.ok) {
					diagnostics.push(extensionDiagnostic("plugin.component_escape", "error", resolved.message, "plugin", manifestPath));
					invalidIdentityPath = true;
					break;
				}
				hookConfigs.push(resolved.path);
			}
			let mcpConfig: string | undefined;
			if (parsed.manifest.mcpServers) {
				const resolved = await resolveDeclaredPath(options.storage, contained.path, parsed.manifest.mcpServers);
				if (!resolved.ok) {
					diagnostics.push(extensionDiagnostic("plugin.component_escape", "error", resolved.message, "plugin", manifestPath));
					invalidIdentityPath = true;
				} else mcpConfig = resolved.path;
			}
			if (invalidIdentityPath) continue;
			const capabilityDigest = canonicalDigest({ skills: skillRoots.length > 0 ? ["metadata", "body", "assets", "script-separate"] : [], hooks: hookConfigs.length > 0 ? ["process"] : [], mcp: mcpConfig ? ["process", "network", "credential"] : [] });
			const binding = buildResourceManifestDigest({ rootDigest: rootDigest.digest, manifestDigest: manifestDigest.digest, configDigest: canonicalDigest({ skills: parsed.manifest.skills, hooks: parsed.manifest.hooks, mcpServers: parsed.manifest.mcpServers }), assetsDigest: rootDigest.digest, capabilityDigest });
			const qualifiedId = qualifiedResourceId({ kind: "plugin", sourceKey: root.sourceKey, name: parsed.manifest.name });
			const identity = createExtensionResourceIdentity({ scope: options.scope, kind: "plugin", qualifiedId, version: parsed.manifest.version, source: root.source, digest: binding.combinedDigest });
			const trust = await options.trustStore.evaluate({ identity, canonicalPath: contained.path, binding, principalId: options.scope.principalId });
			const enabled = options.state?.resources[qualifiedId]?.enabled ?? false;
			const activation = !enabled ? "disabled" : trust.state === "trusted" ? "ready" : "blocked";
			plugins.push({
				descriptor: {
					schemaVersion: 1,
					kind: "plugin",
					identity,
					provenance: { schemaVersion: 1, authorityId: options.scope.authorityId, tenantId: options.scope.tenantId, source: root.source, canonicalLocator: manifestPath },
					manifest: binding,
					displayName: parsed.manifest.name,
					description: parsed.manifest.description,
					sourcePath: manifestPath,
					enabled,
					trust: trust.state,
					activation,
					...(trust.state === "trusted" ? { approvalReceiptId: trust.receipt.receiptId } : {}),
					capabilities: [],
					risk: { level: "moderate", sideEffect: "none", rationaleDigest: capabilityDigest },
					exposure: "hidden",
					diagnostics: trust.state === "trusted" ? [] : [extensionDiagnostic(`plugin.${trust.state}`, "warning", trust.reason, "plugin", manifestPath)],
				},
				manifest: parsed.manifest,
				rootPath: contained.path,
				manifestPath,
				dataRoot: join(options.pluginDataRoot, canonicalDigest(qualifiedId).slice(0, 32)),
				skillRoots,
				hookConfigs,
				...(mcpConfig ? { mcpConfig } : {}),
				blockedComponentCount: trust.state === "trusted" && enabled ? 0 : skillRoots.length + hookConfigs.length + (mcpConfig ? 1 : 0),
			});
		}
	}
	return { plugins: plugins.sort((left, right) => left.descriptor.identity.qualifiedId.localeCompare(right.descriptor.identity.qualifiedId)), diagnostics };
}
