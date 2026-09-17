/**
 * Extension host 的候选选择与激活判定（P5 → supervisor 装配的桥）。
 *
 * 回答两个问题，且只回答这两个：
 *   1. 哪些**已安装**的包声明了可执行 entrypoint（`package.json#runledger.extensions[]`）？
 *   2. 这些包里哪些真的可以启动 host（enabled + 当前内容的 trust receipt + 有 entrypoint）？
 *
 * 判定复用 P5 的 `resolveExtensionHostActivation` 与既有 TrustStore：这里**不**
 * 重新定义信任，也不把“查不到 receipt”当成“未信任”——receipt 缺失、stale 与
 * revoked 各自给出可解释的 code，供 CLI/TUI 告诉用户到底缺什么。
 *
 * 本模块不启动任何进程、不写状态；它只产出候选与 gate 结果。
 */

import { canonicalDigest } from "../../runtime/protocol/canonical-json.ts";
import { runtimeDigest } from "../../runtime/protocol/foundation.ts";
import type { PrincipalId } from "../../runtime/protocol/ids.ts";
import type { ResourceIdentity } from "../../runtime/resources/types.ts";
import { createExtensionResourceIdentity } from "../identity.ts";
import { buildResourceManifestDigest } from "../trust/digest.ts";
import type { TrustStore } from "../trust/trust-store.ts";
import type { ExtensionTrustScope } from "../trust/types.ts";
import type { ExtensionActivationCode } from "./activation.ts";
import { resolveExtensionHostActivation } from "./activation.ts";
import { extractRunledgerManifest } from "./installer.ts";
import type { ExtensionDistributionPort } from "./distribution-port.ts";
import type { ExtensionDistributionRegistry } from "./marketplace/registry.ts";
import type { RunledgerPluginRecord } from "../../contracts/extensions/marketplace.ts";

export interface DistributionHostCandidate {
	readonly packageId: string;
	readonly name: string;
	readonly version: string;
	readonly digest: string;
	readonly installPath: string;
	readonly scope: "user" | "project";
	readonly enabled: boolean;
	/** manifest `runledger.extensions[]`；空数组表示纯声明式包。 */
	readonly entrypoints: readonly string[];
	/** manifest `runledger.capabilities.tools`；准入时用它判断工具是否已声明。 */
	readonly declaredTools: readonly string[];
}

export type DistributionHostGate =
	| { readonly ok: true; readonly candidate: DistributionHostCandidate; readonly identity: ResourceIdentity; readonly receiptId: string }
	| { readonly ok: false; readonly candidate: DistributionHostCandidate; readonly code: ExtensionActivationCode | "manifest_unavailable" | "trust_stale" | "trust_revoked"; readonly message: string };

export interface DistributionHostSelection {
	readonly candidates: readonly DistributionHostCandidate[];
	readonly ready: readonly DistributionHostGate[];
	readonly gates: readonly DistributionHostGate[];
	/** 声明了 entrypoint 但正文读不出来/不合法：诊断用。 */
	readonly diagnostics: readonly { readonly packageId: string; readonly message: string }[];
}

export interface DistributionHostSelectionInput {
	readonly registry: ExtensionDistributionRegistry;
	readonly storage: ExtensionDistributionPort;
	readonly trustStore: TrustStore;
	readonly principalId: PrincipalId;
}

/**
 * 分发包的 trust 目标 identity。`qualifiedId` 含 packageId 与版本，digest 绑定
 * 安装内容，因此内容变化会让既有 receipt stale（D8）。`canonicalPath` 用安装
 * 目录，scope 取记录里的 user/project。
 */
export function distributionHostIdentity(candidate: DistributionHostCandidate): ResourceIdentity {
	return createExtensionResourceIdentity({
		kind: "plugin",
		qualifiedId: `plugin:distribution:${candidate.packageId}:${candidate.version}`,
		version: candidate.version,
		source: candidate.scope === "user" ? "user" : "project",
		digest: candidate.digest,
	});
}

function trustScopeOf(candidate: DistributionHostCandidate): ExtensionTrustScope {
	return candidate.scope === "user" ? "user" : "project";
}

/** 与 PluginManager 相同的 binding 形状；只取分发关心的几段。 */
function bindingFor(candidate: DistributionHostCandidate, manifestDigest: string): ReturnType<typeof buildResourceManifestDigest> {
	return buildResourceManifestDigest({
		rootDigest: candidate.digest,
		manifestDigest,
		configDigest: canonicalDigest({ packageId: candidate.packageId, version: candidate.version }),
		assetsDigest: candidate.digest,
		capabilityDigest: canonicalDigest({ entrypoints: candidate.entrypoints }),
	});
}

/**
 * 读出候选并逐个评估 gate。注册表不可读时返回空选择 + diagnostic，而不是
 * 让调用方误以为“没有可执行扩展”。
 */
export async function selectDistributionHostCandidates(input: DistributionHostSelectionInput): Promise<DistributionHostSelection> {
	const loaded = await input.registry.loadRunledgerRegistry();
	if (!loaded.ok) {
		return { candidates: [], ready: [], gates: [], diagnostics: [{ packageId: "-", message: loaded.message }] };
	}
	const installed = await input.registry.loadInstalledPlugins();
	const installedEntries = installed.ok ? installed.document.plugins : {};
	const candidates: DistributionHostCandidate[] = [];
	const diagnostics: Array<{ readonly packageId: string; readonly message: string }> = [];

	for (const [packageId, record] of Object.entries(loaded.document.plugins)) {
		const linkPath = linkedPathOf(record);
		const installEntry = (installedEntries[packageId] ?? []).find((item) => item.scope === record.scope && item.version === record.version);
		const installPath = linkPath ?? installEntry?.installPath;
		if (installPath === undefined) {
			diagnostics.push({ packageId, message: "installed content path is unavailable; the ledger is inconsistent" });
			continue;
		}
		const manifestRead = await input.storage.readFile(`${installPath}/package.json`, 256 * 1024);
		if (!manifestRead.ok) {
			diagnostics.push({ packageId, message: "installed package.json could not be read" });
			continue;
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(new TextDecoder().decode(manifestRead.value)) as unknown;
		} catch {
			diagnostics.push({ packageId, message: "installed package.json is not valid JSON" });
			continue;
		}
		const manifest = extractRunledgerManifest(parsed);
		if (!manifest.ok) {
			diagnostics.push({ packageId, message: manifest.message });
			continue;
		}
		const entrypoints = readEntrypoints(manifest.manifest);
		// 只把**声明了 entrypoint** 的包作为 host 候选；纯声明式包走既有四层。
		if (entrypoints.length === 0) continue;
		candidates.push({
			packageId,
			name: record.name,
			version: record.version,
			digest: record.digest,
			installPath,
			scope: record.scope,
			enabled: record.enabled,
			entrypoints,
			declaredTools: readDeclaredTools(manifest.manifest),
		});
	}

	const gates: DistributionHostGate[] = [];
	for (const candidate of candidates) {
		const identity = distributionHostIdentity(candidate);
		const binding = bindingFor(candidate, runtimeDigest({ entrypoints: candidate.entrypoints }).digest);
		const evaluation = await input.trustStore.evaluate({
			identity,
			canonicalPath: candidate.installPath,
			binding,
			principalId: input.principalId,
			scope: trustScopeOf(candidate),
		});
		const trustedDigest = evaluation.state === "trusted" ? candidate.digest : undefined;
		const gate = resolveExtensionHostActivation({
			enabled: candidate.enabled,
			digest: candidate.digest,
			...(trustedDigest === undefined ? {} : { trustedDigest }),
			entrypoints: candidate.entrypoints,
		});
		if (gate.ok) {
			gates.push({ ok: true, candidate, identity, receiptId: evaluation.state === "trusted" ? evaluation.receipt.receiptId : "" });
			continue;
		}
		// 把 trust 的具体状态翻译成可解释的 code：缺失 / stale / revoked 不能混为一谈。
		const code: ExtensionActivationCode | "trust_stale" | "trust_revoked" = evaluation.state === "stale"
			? "trust_stale"
			: evaluation.state === "revoked"
				? "trust_revoked"
				: gate.code;
		gates.push({ ok: false, candidate, code, message: evaluation.state === "trusted" ? gate.message : evaluation.reason });
	}

	return {
		candidates: Object.freeze(candidates),
		ready: Object.freeze(gates.filter((gate): gate is Extract<DistributionHostGate, { ok: true }> => gate.ok)),
		gates: Object.freeze(gates),
		diagnostics: Object.freeze(diagnostics),
	};
}

function linkedPathOf(record: RunledgerPluginRecord): string | undefined {
	const value = (record as RunledgerPluginRecord & { readonly runledgerLinkedPath?: unknown }).runledgerLinkedPath;
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readDeclaredTools(manifest: unknown): readonly string[] {
	if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) return [];
	const capabilities = (manifest as Record<string, unknown>).capabilities;
	if (typeof capabilities !== "object" || capabilities === null || Array.isArray(capabilities)) return [];
	const tools = (capabilities as Record<string, unknown>).tools;
	return Array.isArray(tools) ? tools.filter((item): item is string => typeof item === "string") : [];
}

function readEntrypoints(manifest: unknown): readonly string[] {
	if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) return [];
	const extensions = (manifest as Record<string, unknown>).extensions;
	return Array.isArray(extensions) ? extensions.filter((item): item is string => typeof item === "string") : [];
}

/** 供 CLI/TUI 展示的一行解释；不泄漏 secret，只说明缺什么。 */
export function describeHostGate(gate: DistributionHostGate): string {
	if (gate.ok) return `${gate.candidate.packageId}@${gate.candidate.version}: host-ready`;
	return `${gate.candidate.packageId}@${gate.candidate.version}: ${gate.code}`;
}
