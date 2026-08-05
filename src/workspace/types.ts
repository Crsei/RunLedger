/** 多平台 workspace/path 适配层类型与错误 taxonomy（ADR 02 D3/D5 的唯一实现者）。 */

export type WorkspacePlatform = "linux" | "macos" | "windows";

export type PathRootKind = "posix" | "drive" | "unc";

export interface RootIdentity {
	readonly kind: PathRootKind;
	/** 展示值：posix="/"，drive="C:"，unc="\\server\share"（大小写保留）。 */
	readonly display: string;
	/** 比较键：平台规范化（windows/UNC 大小写折叠），仅用于同一性/containment。 */
	readonly key: string;
}

export interface PathIdentity {
	readonly root: RootIdentity;
	/** canonical display 值（existing 来自 realpath；candidate 来自最近存在祖先 + lexical 剩余段）。 */
	readonly displayPath: string;
	/** 平台规范化的比较键（不用于展示）。 */
	readonly compareKey: string;
	readonly absolute: boolean;
}

export type WorkspacePathErrorCode =
	| "invalid_path"
	| "unsupported_root"
	| "cross_root_containment"
	| "platform_mismatch"
	| "migration_required"
	| "unverified_platform"
	| "stale_registration"
	| "git_failed"
	| "invalid_state"
	| "base_drift";

export interface WorkspacePathError {
	readonly code: WorkspacePathErrorCode;
	readonly message: string;
	readonly retryable: boolean;
}

export type WorkspacePathResult<T> =
	| { readonly ok: true; readonly value: T }
	| { readonly ok: false; readonly error: WorkspacePathError };

export type ContainmentKind = "inside" | "outside" | "cross_root";

/** versioned private locator（ADR D4）；storage 格式不是 process API 输入。 */
export interface PrivateLocatorV1 {
	readonly version: 1;
	readonly platform: WorkspacePlatform;
	readonly kind: PathRootKind;
	readonly path: string;
}

export const PRIVATE_LOCATOR_VERSION = 1 as const;

export const WORKSPACE_PLATFORMS: readonly WorkspacePlatform[] = ["linux", "macos", "windows"];

export function isWorkspacePlatform(value: string): value is WorkspacePlatform {
	return (WORKSPACE_PLATFORMS as readonly string[]).includes(value);
}
