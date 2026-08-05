/** 运行时平台检测的唯一分支点（P6：替换散落 process.platform 分支）。 */

import type { RuntimePathFlavor } from "../runtime/contracts/storage-layout.ts";
import type { WorkspacePlatform } from "./types.ts";

/**
 * 业务模块禁止直接读 process.platform（check-platform-boundaries 强制）；
 * 平台语义只从 WorkspacePlatform 派生。本模块与 `factory.ts` 是仅有的两个
 * 允许出现 `process.platform` 的 workspace 文件。未知运行时平台 fail closed
 * （抛错），不静默映射为 Linux 语义。
 */
export function runtimeWorkspacePlatform(): WorkspacePlatform {
	const runtime = process.platform;
	if (runtime === "linux") return "linux";
	if (runtime === "darwin") return "macos";
	if (runtime === "win32") return "windows";
	throw new Error(`unsupported runtime platform: ${runtime}`);
}

export function runtimePathFlavor(): RuntimePathFlavor {
	return runtimeWorkspacePlatform() === "windows" ? "win32" : "posix";
}
