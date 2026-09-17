/**
 * `plugin doctor` 的检查项（P5）。
 *
 * doctor 只**报告**，不自动修复：任何“顺手修好”都会让用户看不到真实状态。
 * 每个发现项都带 severity、稳定 code 与 bounded 定位符（不打印 native path
 * 之外的 secret；这里的路径本身就是 canonical home 下的位置）。
 */

import { extensionDiagnostic, type ExtensionDiagnostic } from "../diagnostics.ts";
import { digestDirectory } from "../trust/digest.ts";
import { DEFAULT_EXTENSION_LIMITS } from "../diagnostics.ts";
import type { ExtensionDistributionPort } from "./distribution-port.ts";
import type { ExtensionDistributionRegistry } from "./marketplace/registry.ts";
import { extractRunledgerManifest } from "./installer.ts";
import { resolveExtensionHostActivation } from "./activation.ts";

export type DoctorSeverity = "ok" | "warning" | "error";

export interface DoctorFinding {
	readonly code: string;
	readonly severity: DoctorSeverity;
	readonly message: string;
	readonly subject?: string;
}

export interface DoctorReport {
	readonly findings: readonly DoctorFinding[];
	readonly counts: { readonly ok: number; readonly warning: number; readonly error: number };
	readonly diagnostics: readonly ExtensionDiagnostic[];
}

export interface DoctorOptions {
	readonly storage: ExtensionDistributionPort;
	readonly registry: ExtensionDistributionRegistry;
	/** 包当前是否被信任；缺省视为未信任（doctor 不读 trust 文件，由调用方注入）。 */
	readonly trustDigest: (packageId: string) => string | undefined;
	/** 每个 scope 的包根；用于反向发现“磁盘上有、账本里没有”的目录。 */
	readonly scopeRoot: (scope: "user" | "project") => string;
}

const MAX_DOCTOR_FINDINGS = 256;

/**
 * 检查分发账本与磁盘的一致性。顺序固定，便于 CLI `--json` 与快照测试。
 */
export async function runExtensionDoctor(options: DoctorOptions): Promise<DoctorReport> {
	const findings: DoctorFinding[] = [];
	const add = (code: string, severity: DoctorSeverity, message: string, subject?: string): void => {
		if (findings.length >= MAX_DOCTOR_FINDINGS) return;
		findings.push({ code, severity, message, ...(subject === undefined ? {} : { subject }) });
	};

	const runledger = await options.registry.loadRunledgerRegistry();
	if (!runledger.ok) {
		add("registry.runledger_invalid", "error", runledger.message, "plugins/registry.json");
		return finish(findings);
	}
	const marketplaces = await options.registry.loadMarketplaces();
	if (!marketplaces.ok) add("registry.marketplaces_invalid", "error", marketplaces.message, "marketplaces.json");
	const installed = await options.registry.loadInstalledPlugins();
	if (!installed.ok) add("registry.installed_invalid", "error", installed.message, "installed_plugins.json");
	if (findings.every((finding) => finding.severity !== "error")) add("registry.readable", "ok", "distribution registries parse");

	const knownPaths = new Set<string>();

	// 逐个安装记录核对目录、digest、manifest 与 trust 状态。
	for (const [packageId, record] of Object.entries(runledger.document.plugins)) {
		const entry = installed.ok ? (installed.document.plugins[packageId] ?? []).find((item) => item.scope === record.scope) : undefined;
		if (entry === undefined) {
			add("install.record_missing", "error", "install ledger has no matching installed_plugins entry", packageId);
			continue;
		}
		knownPaths.add(entry.installPath);
		const stat = await options.storage.stat(entry.installPath, { followSymlinks: false });
		if (!stat.ok) {
			add("install.path_missing", "error", "installed package directory is missing", packageId);
			continue;
		}
		if (stat.value.kind !== "directory") {
			add("install.path_not_directory", "error", "installed package path is not a directory", packageId);
			continue;
		}
		const manifestRead = await options.storage.readFile(`${entry.installPath}/package.json`, 256 * 1024);
		if (!manifestRead.ok) {
			add("install.manifest_missing", "error", "installed package has no readable package.json", packageId);
			continue;
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(new TextDecoder().decode(manifestRead.value)) as unknown;
		} catch {
			add("install.manifest_invalid", "error", "installed package.json is not valid JSON", packageId);
			continue;
		}
		const manifest = extractRunledgerManifest(parsed);
		if (!manifest.ok) {
			add("install.manifest_invalid", "error", manifest.message, packageId);
			continue;
		}
		// 已安装内容不得再出现 lifecycle script：安装时拒绝过，doctor 复核。
		const lifecycle = manifest.scripts.filter((script) => ["preinstall", "install", "postinstall", "prepare", "prepublish"].includes(script));
		if (lifecycle.length > 0) add("install.lifecycle_script", "error", `installed package declares lifecycle scripts: ${lifecycle.sort().join(",")}`, packageId);

		const digests = await digestDirectory(options.storage, entry.installPath, DEFAULT_EXTENSION_LIMITS);
		if (!digests.ok) {
			add("install.digest_unavailable", "warning", "installed package content could not be digested", packageId);
		} else if (record.digest !== digests.digest) {
			add("install.digest_mismatch", "error", "installed content no longer matches the recorded digest", packageId);
		}

		const trusted = options.trustDigest(packageId);
		if (record.enabled) {
			const gate = resolveExtensionHostActivation({
				enabled: true,
				digest: digests.ok ? digests.digest : record.digest,
				...(trusted === undefined ? {} : { trustedDigest: trusted }),
				entrypoints: readEntrypoints(manifest.manifest),
			});
			if (!gate.ok && gate.code !== "no_entrypoints") {
				add(`activation.${gate.code}`, "error", gate.message, packageId);
			}
		}
		if (trusted !== undefined && trusted !== record.digest) {
			add("trust.stale", "warning", "trust receipt binds a different digest than the installed content", packageId);
		}
		if (trusted === undefined) add("trust.missing", "warning", "no trust receipt for the installed package; it cannot be activated", packageId);
	}

	// 反向检查：磁盘上存在但账本里没有的版本目录。只报告，不自动删除。
	for (const scope of ["user", "project"] as const) {
		const packagesRoot = `${options.scopeRoot(scope)}/packages`;
		const packages = await options.storage.readDirectory(packagesRoot);
		if (!packages.ok) continue;
		for (const packageEntry of packages.value) {
			if (packageEntry.kind !== "directory") continue;
			const packageRoot = `${packagesRoot}/${packageEntry.name}`;
			const versions = await options.storage.readDirectory(packageRoot);
			if (!versions.ok) continue;
			for (const versionEntry of versions.value) {
				if (versionEntry.kind !== "directory") continue;
				const installPath = `${packageRoot}/${versionEntry.name}`;
				if (!knownPaths.has(installPath)) add("install.orphan_directory", "warning", "package directory is not referenced by any ledger entry", installPath);
			}
		}
	}

	if (findings.every((finding) => finding.severity !== "error")) add("doctor.completed", "ok", "extension distribution state is consistent");
	return finish(findings);
}

function readEntrypoints(manifest: unknown): readonly string[] {
	if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) return [];
	const extensions = (manifest as Record<string, unknown>).extensions;
	return Array.isArray(extensions) ? extensions.filter((item): item is string => typeof item === "string") : [];
}

function finish(findings: readonly DoctorFinding[]): DoctorReport {
	const counts = { ok: 0, warning: 0, error: 0 };
	for (const finding of findings) counts[finding.severity] += 1;
	return {
		findings: Object.freeze([...findings]),
		counts,
		diagnostics: Object.freeze(findings
			.filter((finding) => finding.severity !== "ok")
			.map((finding) => extensionDiagnostic({
				code: `plugin.doctor.${finding.code}`,
				severity: finding.severity === "error" ? "error" : "warning",
				message: finding.message,
				source: "plugin",
				...(finding.subject === undefined ? {} : { path: finding.subject }),
			}))),
	};
}
