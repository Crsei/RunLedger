/** Workspace adapter 平台装配与可用性声明（唯一允许读取运行时平台分支的新代码点）。 */

import { createNativeWorkspaceAdapters } from "./native/adapters.ts";
import type { NativeAdapterDeps, WorkspaceAdapters } from "./native/types.ts";
import type { WorkspacePlatform } from "./types.ts";

export type WorkspaceAdapterAvailability =
	| { readonly ok: true; readonly value: WorkspaceAdapters }
	| { readonly ok: false; readonly error: { readonly code: "unsupported_platform" | "unverified_platform"; readonly message: string; readonly retryable: false } };

/** P4 退出条件：真实 runner E2E 未通过的平台保持 typed unsupported，不按 Linux 行为类推。 */
const VERIFIED_PLATFORMS: readonly WorkspacePlatform[] = ["linux"];

export function createWorkspaceAdapters(platform: WorkspacePlatform, deps: NativeAdapterDeps): WorkspaceAdapterAvailability {
	if (!VERIFIED_PLATFORMS.includes(platform)) {
		return {
			ok: false,
			error: {
				code: "unverified_platform",
				message: `${platform} workspace adapters require real-runner E2E evidence before use; see development-doc/worktree-sandbox-permisson/evidence-verification-gaps.md`,
				retryable: false,
			},
		};
	}
	return { ok: true, value: createNativeWorkspaceAdapters(platform, deps) };
}

/** 生产入口：运行时平台只在这里检测一次并映射。 */
export function createWorkspaceAdaptersForCurrentPlatform(deps: NativeAdapterDeps): WorkspaceAdapterAvailability {
	const runtime = process.platform;
	if (runtime === "linux") return createWorkspaceAdapters("linux", deps);
	if (runtime === "darwin") return createWorkspaceAdapters("macos", deps);
	if (runtime === "win32") return createWorkspaceAdapters("windows", deps);
	return { ok: false, error: { code: "unsupported_platform", message: `no workspace adapters for platform ${runtime}`, retryable: false } };
}
