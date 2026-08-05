/** Windows native workspace adapters（P4：实现就绪；真实 runner E2E 通过前保持 typed unsupported）。 */

import { createNativeWorkspaceAdapters } from "./adapters.ts";
import type { NativeAdapterDeps, WorkspaceAdapters } from "./types.ts";

/**
 * 构造 Windows 适配器：drive/UNC 路径身份、junction/reparse containment、
 * Git for Windows porcelain、Git Bash/PowerShell/cmd 与 process-tree 终止
 * 尚无真实 runner 证据（evidence-verification-gaps.md §2），生产组合必须经
 * factory 的 `unverified_platform` 拒绝，不得直接使用。
 */
export function createWindowsWorkspaceAdapters(deps: NativeAdapterDeps): WorkspaceAdapters {
	return createNativeWorkspaceAdapters("windows", deps);
}
