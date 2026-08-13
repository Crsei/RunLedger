/**
 * RunLedger canonical discovery providers：固定 root 注入（composition root
 * 解析一次），provider 只 stat/realpath 候选 root 并产出带来源的 observation；
 * 不扫描、不授 trust、不持久化。缺目录 → unavailable（不产生资源，不自动创建）。
 */

import type { DiscoveryProvider } from "../../capabilities/types.ts";
import type { SkillDiscoveryLevel, SkillDiscoveryObservation } from "../registry.ts";
import type { ExtensionSource } from "../../types.ts";
import { createFixedRootsProvider } from "./shared.ts";

export interface RunledgerRootProviderOptions {
	readonly providerId: string;
	readonly displayName: string;
	readonly rank: number;
	readonly defaultEnabled: boolean;
	readonly source: ExtensionSource;
	readonly level: SkillDiscoveryLevel;
	readonly priority: number;
	readonly root: string;
	readonly scanKind: "skills-directory" | "single-skill-directory";
}

/**
 * 固定 root provider：enabled 时 stat root（零 I/O 由 registry dispatch 保证），
 * 缺失/非目录 → unavailable；仅返回一个 observation。
 */
export function createRunledgerRootProvider(options: RunledgerRootProviderOptions): DiscoveryProvider<SkillDiscoveryObservation> {
	return createFixedRootsProvider({ ...options, roots: [options.root] });
}

/** builtin：composition root 注入的 builtin skill roots（不从 npm package 猜路径）。 */
export function createRunledgerBuiltinProvider(root: string): DiscoveryProvider<SkillDiscoveryObservation> {
	return createRunledgerRootProvider({
		providerId: "runledger-builtin",
		displayName: "RunLedger builtin skills",
		rank: 0,
		defaultEnabled: true,
		source: "builtin",
		level: "builtin",
		priority: 0,
		root,
		scanKind: "skills-directory",
	});
}

/** user：`<home>/state/extensions/user/skills/`（缺目录视为空，不自动创建）。 */
export function createRunledgerUserProvider(root: string): DiscoveryProvider<SkillDiscoveryObservation> {
	return createRunledgerRootProvider({
		providerId: "runledger-user",
		displayName: "RunLedger user skills",
		rank: 100,
		defaultEnabled: true,
		source: "user",
		level: "user",
		priority: 100,
		root,
		scanKind: "skills-directory",
	});
}

/** workspace：`<home>/state/extensions/workspaces/<storage-key>/skills/`（project-scoped receipt）。 */
export function createRunledgerWorkspaceProvider(root: string): DiscoveryProvider<SkillDiscoveryObservation> {
	return createRunledgerRootProvider({
		providerId: "runledger-workspace",
		displayName: "RunLedger workspace skills",
		rank: 200,
		defaultEnabled: true,
		source: "project",
		level: "workspace",
		priority: 200,
		root,
		scanKind: "skills-directory",
	});
}

/** repo：受信 settings 显式开启后扫描 repo/ancestor `.runledger/skills/`（默认 off）。 */
export function createRunledgerRepoProvider(root: string): DiscoveryProvider<SkillDiscoveryObservation> {
	return createRunledgerRootProvider({
		providerId: "runledger-repo",
		displayName: "RunLedger repo skills",
		rank: 300,
		defaultEnabled: false,
		source: "project",
		level: "project",
		priority: 300,
		root,
		scanKind: "skills-directory",
	});
}

/** session：authenticated Session command 注入的临时 root（默认 off/empty，不持久化）。 */
export function createRunledgerSessionProvider(root: string): DiscoveryProvider<SkillDiscoveryObservation> {
	return createRunledgerRootProvider({
		providerId: "runledger-session",
		displayName: "RunLedger session skills",
		rank: 1000,
		defaultEnabled: false,
		source: "session",
		level: "session",
		priority: 1000,
		root,
		scanKind: "skills-directory",
	});
}
