/** macOS native workspace adapters（P4：实现就绪；真实 runner E2E 通过前保持 typed unsupported）。 */

import { createNativeWorkspaceAdapters } from "./adapters.ts";
import type { NativeAdapterDeps, WorkspaceAdapters } from "./types.ts";

/**
 * 构造 macOS 适配器。APFS case policy、firmlink realpath、zsh/bash/sh 启动与
 * process-group 终止尚无真实 runner 证据（evidence-verification-gaps.md §1），
 * 生产组合必须经 factory 的 `unverified_platform` 拒绝，不得直接使用。
 */
export function createMacosWorkspaceAdapters(deps: NativeAdapterDeps): WorkspaceAdapters {
	return createNativeWorkspaceAdapters("macos", deps);
}
