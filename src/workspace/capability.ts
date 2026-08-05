/** P6 workspace/path 能力矩阵：按真实 runner 证据声明，不显示虚假的 sandbox enforced。 */

/**
 * 单一事实来源：P1 证据 fixtures（tests/fixtures/platform-evidence/）与
 * evidence-verification-gaps.md。`verified` 只表示有真实 runner 证据；
 * macOS/Windows 未采集/未通过 E2E 一律 `unverified`，与 factory 的
 * typed unsupported 保持一致。本矩阵不构成 OS sandbox 或 containment 承诺。
 */

import type { WorkspacePlatform } from "./types.ts";

export type CapabilityEvidence = "verified" | "unverified";

export interface PlatformCapabilityRow {
	readonly platform: WorkspacePlatform;
	/** native path 身份语义（realpath/candidate/containment）证据。 */
	readonly path: CapabilityEvidence;
	/** Git porcelain create/list/remove 证据。 */
	readonly git: CapabilityEvidence;
	/** Shell 启动/进程树终止语义证据。 */
	readonly process: CapabilityEvidence;
	/** occupied-file cleanup 语义证据。 */
	readonly cleanup: CapabilityEvidence;
	/** factory 是否可装配（= 通过真实 runner E2E 的平台）。 */
	readonly adapterAvailable: boolean;
	readonly note: string;
}

export function workspaceCapabilityMatrix(): readonly PlatformCapabilityRow[] {
	return [
		{
			platform: "linux",
			path: "verified",
			git: "verified",
			process: "verified",
			cleanup: "verified",
			adapterAvailable: true,
			note: "real-runner evidence 2026-08-06 (tests/fixtures/platform-evidence/linux)",
		},
		{
			platform: "macos",
			path: "unverified",
			git: "unverified",
			process: "unverified",
			cleanup: "unverified",
			adapterAvailable: false,
			note: "no real runner evidence; APFS case/firmlink/process-group pending (evidence-verification-gaps.md)",
		},
		{
			platform: "windows",
			path: "unverified",
			git: "unverified",
			process: "unverified",
			cleanup: "unverified",
			adapterAvailable: false,
			note: "no real runner evidence; drive/UNC/junction/Git Bash/PowerShell/process-tree pending (evidence-verification-gaps.md)",
		},
	];
}

export function capabilityRowFor(platform: WorkspacePlatform): PlatformCapabilityRow {
	const row = workspaceCapabilityMatrix().find((entry) => entry.platform === platform);
	if (row === undefined) throw new Error(`unknown workspace platform: ${platform}`);
	return row;
}
