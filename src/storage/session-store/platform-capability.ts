/**
 * R1:Session Store 数据库文件保护的平台能力声明(06 §4.1)。
 *
 * POSIX 上 state.db* 要求 0600;Windows/macOS 在获得真实 ACL runner 证据前
 * 只允许 typed `unverified_platform`,不得伪造等价 ACL 或把 POSIX mode 当作
 * 跨平台保证。平台来源由 workspace 适配层注入,本模块不做运行时平台分支
 * (静态边界见 scripts/check-platform-boundaries.ts,分支点收敛在 workspace 适配层)。
 */

import type { WorkspacePlatform } from "../../workspace/types.ts";

export const DATABASE_PLATFORM_EVIDENCE = {
	linux: "verified",
	macos: "unverified_platform",
	windows: "unverified_platform",
} as const satisfies Record<WorkspacePlatform, DatabasePlatformEvidenceKind>;

export type DatabasePlatformEvidenceKind = "verified" | "unverified_platform";

export interface DatabasePlatformCapability {
	readonly platform: WorkspacePlatform;
	/** verified 表示有真实 runner 证据;unverified_platform 表示只有源码推断,不得声明等价保护。 */
	readonly evidence: DatabasePlatformEvidenceKind;
	/** POSIX 上数据库文件权限下限;非 POSIX 无证据时为 null,不伪造 ACL 声明。 */
	readonly fileModeFloor: number | null;
}

/** 生产组合入口:把 workspace 适配层的运行时平台注入 DB 能力声明。 */
export function databasePlatformCapability(platform: WorkspacePlatform): DatabasePlatformCapability {
	const evidence = DATABASE_PLATFORM_EVIDENCE[platform];
	return {
		platform,
		evidence,
		fileModeFloor: evidence === "verified" && platform === "linux" ? 0o600 : null,
	};
}
