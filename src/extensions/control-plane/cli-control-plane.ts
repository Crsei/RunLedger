/** 普通 CLI 的 discovery-only Extension 控制面装配。 */

import { resolve } from "node:path";
import { createLocalIdentityContext } from "../../runtime/identity/local-principal.ts";
import {
	getAgentDir,
	getExtensionsStatePath,
	getPluginDataRoot,
	getProjectExtensionRoot,
	getTrustStorePath,
	getUserExtensionRoot,
	getPluginStoreRoot,
	getPluginStagingRoot,
	getPluginCacheRoot,
	getInstalledPluginIndexPath,
	getPublisherTrustPath,
} from "../../storage/paths.ts";
import { NodeReadOnlyExtensionStorage } from "../../storage/extension-readonly-storage.ts";
import { ExtensionManager } from "../extension-manager.ts";
import { compatibilitySkillRoots } from "../compatibility-importer.ts";
import { sourceKey } from "../paths.ts";
import { ExtensionStateStore } from "../state-store.ts";
import { TrustStore } from "../trust/trust-store.ts";
import type { ExtensionSource, ExtensionSourceRoot } from "../types.ts";
import { ExtensionControlPlane } from "./control-plane.ts";
import { loadMergedSettings } from "../../storage/settings-manager.ts";
import {
	Ed25519MarketplaceSignatureVerifier,
	NodePluginVersionStore,
	NodePublisherTrustStore,
} from "../marketplace/node-marketplace.ts";

async function optionalRoot(
	storage: NodeReadOnlyExtensionStorage,
	source: ExtensionSource,
	path: string,
	priority: number,
): Promise<ExtensionSourceRoot | undefined> {
	const canonical = await storage.realpath(path);
	if (!canonical.ok) return undefined;
	const info = await storage.stat(canonical.value);
	if (!info.ok || info.value.kind !== "directory") return undefined;
	return {
		source,
		sourceKey: sourceKey(source, canonical.value),
		rootPath: canonical.value,
		priority,
	};
}

/**
 * 默认 CLI 只获得 root-contained read 权限；即使调用者选择了 mutation
 * subcommand，控制面也会因缺少 Gateway/approval/audit/write ports 而 fail closed。
 */
export async function createCliExtensionControlPlane(
	cwd: string,
): Promise<ExtensionControlPlane> {
	const projectRoot = resolve(cwd);
	const agentRoot = resolve(getAgentDir());
	const storage = new NodeReadOnlyExtensionStorage([projectRoot, agentRoot]);
	const settings = await loadMergedSettings(projectRoot);
	const standardRoots = (
		await Promise.all([
			optionalRoot(storage, "user", getUserExtensionRoot(), 100),
			optionalRoot(storage, "project", getProjectExtensionRoot(projectRoot), 200),
		])
	).filter((root): root is ExtensionSourceRoot => root !== undefined);
	const compatibility = await compatibilitySkillRoots({
		projectRoot,
		storage,
		enabledSources: settings.extensions?.compatibilitySkillSources,
	});
	const publishers = new NodePublisherTrustStore(getPublisherTrustPath());
	const signatureVerifier = new Ed25519MarketplaceSignatureVerifier(publishers);
	const installed = new NodePluginVersionStore({
		storeRoot: getPluginStoreRoot(),
		stagingRoot: getPluginStagingRoot(),
		cacheRoot: getPluginCacheRoot(),
		indexPath: getInstalledPluginIndexPath(),
	});
	const installedRoots = (await installed.activeRoots(signatureVerifier)).map((plugin, index) => ({
		source: "user" as const,
		sourceKey: `marketplace:${plugin.packageName}:${plugin.version}:${plugin.digest}`,
		rootPath: plugin.rootPath,
		priority: 150 + index,
		layout: "plugin-root" as const,
	}));
	const roots = [...standardRoots, ...installedRoots, ...compatibility.roots];
	const identity = createLocalIdentityContext();
	const scope = {
		authorityId: identity.authorityId,
		tenantId: identity.tenantId,
		principalId: identity.principalId,
	};
	const state = new ExtensionStateStore(getExtensionsStatePath(), storage);
	const trust = new TrustStore(getTrustStorePath(), storage);
	const manager = new ExtensionManager({
		scope,
		roots,
		storage,
		trustStore: trust,
		stateStore: state,
		pluginDataRoot: getPluginDataRoot(),
		// inspection 不能解析 credential templates，也不能持有 process/network ports。
		environment: {},
	});
	return new ExtensionControlPlane({ discovery: manager, trust });
}
