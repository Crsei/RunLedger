/** 纯 WorkspacePathAdapter：path 解析/编码/比较/containment（ADR 02 D1–D4）。 */

/**
 * 本模块是纯函数层：不读写文件系统、不 spawn、不读取运行时平台分支。
 * existing/candidate 的真实身份解析由 native adapter（`src/workspace/native/**`）
 * 注入 syscall port 完成；这里只做结构化身份与 locator 语义。
 */

import { posix as posixPath, win32 as win32Path } from "node:path";
import { PRIVATE_LOCATOR_VERSION, type PathIdentity, type PrivateLocatorV1, type RootIdentity, type WorkspacePathErrorCode, type WorkspacePathResult, type WorkspacePlatform, isWorkspacePlatform } from "./types.ts";

function failure<T>(code: WorkspacePathErrorCode, message: string, retryable = false): WorkspacePathResult<T> {
	return { ok: false, error: { code, message, retryable } };
}

function win32(input: string): string {
	return input.replaceAll("/", "\\");
}

function normalizeFor(platform: WorkspacePlatform, input: string): string {
	return platform === "windows" ? win32Path.normalize(win32(input)) : posixPath.normalize(input);
}

function segmentsOf(platform: WorkspacePlatform, path: string): readonly string[] {
	return path.split(platform === "windows" ? "\\" : "/").filter((segment) => segment.length > 0);
}

function fold(platform: WorkspacePlatform, segment: string): string {
	return platform === "windows" ? segment.toLowerCase() : segment;
}

export interface ParsedRoot {
	readonly kind: "posix" | "drive" | "unc";
	readonly display: string;
	readonly key: string;
	/** root 之后的剩余路径（不含分隔符前缀），用于 segment 比较。 */
	readonly remainder: string;
}

export function parseRoot(input: string, platform: WorkspacePlatform): WorkspacePathResult<ParsedRoot> {
	if (platform === "windows") {
		const normalized = win32(input);
		if (normalized.startsWith("\\\\?\\") || normalized.startsWith("\\\\.\\")) {
			return failure("unsupported_root", `device/long-path namespace is unsupported for containment: ${normalized.slice(0, 64)}`);
		}
		const unc = /^\\\\[^\\]+\\[^\\]+(?:\\|$)/u.exec(normalized);
		if (unc !== null) {
			const rootText = unc[0].endsWith("\\") ? unc[0].slice(0, -1) : unc[0];
			const key = rootText.toLowerCase();
			return { ok: true, value: { kind: "unc", display: rootText, key, remainder: normalized.slice(rootText.length + 1) } };
		}
		const drive = /^[A-Za-z]:\\/u.exec(normalized);
		if (drive !== null) {
			const rootText = drive[0].slice(0, 2);
			return { ok: true, value: { kind: "drive", display: rootText, key: rootText.toLowerCase(), remainder: normalized.slice(2).replace(/^\\/u, "") } };
		}
		if (/^\\[^\\]/u.test(normalized)) {
			return failure("invalid_path", "root-relative Windows path without a drive identity is unsupported");
		}
		return failure("invalid_path", "not an absolute Windows drive/UNC path");
	}
	if (input.startsWith("/")) {
		const normalized = posixPath.normalize(input);
		return { ok: true, value: { kind: "posix", display: "/", key: "/", remainder: normalized.replace(/^\/+/u, "") } };
	}
	return failure("invalid_path", "not an absolute POSIX path");
}

export function parsePath(input: string, platform: WorkspacePlatform): WorkspacePathResult<PathIdentity> {
	const absolute = platform === "windows" ? win32Path.isAbsolute(win32(input)) : posixPath.isAbsolute(input);
	if (!absolute) return failure("invalid_path", "workspace paths must be absolute");
	const root = parseRoot(input, platform);
	if (!root.ok) return root;
	const segments = segmentsOf(platform, root.value.remainder);
	const displayPath = platform === "windows" ? win32Path.normalize(win32(root.value.display) + (root.value.remainder.length > 0 ? "\\" + root.value.remainder : "\\")) : posixPath.normalize(`/${root.value.remainder}`);
	const compareKey = platform === "windows"
		? win32Path.normalize(win32(root.value.key) + "\\" + segments.map((segment) => fold(platform, segment)).join("\\"))
		: posixPath.normalize(`/${segments.join("/")}`);
	const rootIdentity: RootIdentity = { kind: root.value.kind, display: root.value.display, key: root.value.key };
	return { ok: true, value: { root: rootIdentity, displayPath, compareKey, absolute: true } };
}

/**
 * 结构化 containment（ADR D3）：root 身份必须相同，再逐 segment 前缀比较。
 * 不使用字符串 startsWith；`/repo` 与 `/repo-other` 天然拒绝。
 */
export function containmentCheck(parent: PathIdentity, child: PathIdentity, platform: WorkspacePlatform): WorkspacePathResult<"inside" | "outside" | "cross_root"> {
	if (parent.root.key !== child.root.key) return { ok: true, value: "cross_root" };
	if (parent.compareKey === child.compareKey) return { ok: true, value: "inside" };
	const parentSegments = parent.compareKey.split(platform === "windows" ? "\\" : "/").filter((s) => s.length > 0);
	const childSegments = child.compareKey.split(platform === "windows" ? "\\" : "/").filter((s) => s.length > 0);
	if (parentSegments.length > childSegments.length) return { ok: true, value: "outside" };
	for (let i = 0; i < parentSegments.length; i++) {
		if (parentSegments[i] !== childSegments[i]) return { ok: true, value: "outside" };
	}
	return { ok: true, value: "inside" };
}

/** 从最近到最远列出候选祖先（用于 candidate path 的 nearest-existing-ancestor 解析）。 */
export function ancestorCandidates(identity: PathIdentity, platform: WorkspacePlatform): readonly string[] {
	const allSegments = identity.displayPath.split(platform === "windows" ? "\\" : "/").filter((s) => s.length > 0);
	const rootSegmentCount = identity.root.kind === "posix" ? 0 : identity.root.kind === "drive" ? 1 : 2;
	const relative = allSegments.slice(rootSegmentCount);
	const candidates: string[] = [];
	for (let k = relative.length - 1; k >= 1; k--) {
		candidates.push(platform === "windows"
			? win32Path.normalize(win32(identity.root.display) + "\\" + relative.slice(0, k).join("\\"))
			: posixPath.normalize(`/${relative.slice(0, k).join("/")}`));
	}
	candidates.push(identity.root.display);
	return candidates;
}

/** ADR D4：identity → versioned private locator。 */
export function encodePrivateLocator(identity: PathIdentity, platform: WorkspacePlatform): PrivateLocatorV1 {
	return { version: PRIVATE_LOCATOR_VERSION, platform, kind: identity.root.kind, path: identity.displayPath };
}

/** ADR D4：结构化解码（平台无关）；语义校验见 validateLocatorForPlatform。 */
export function decodePrivateLocator(serialized: string): WorkspacePathResult<PrivateLocatorV1> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(serialized) as unknown;
	} catch {
		return failure("migration_required", "workspace locator is not valid JSON; treat as unversioned legacy record");
	}
	if (typeof parsed !== "object" || parsed === null) return failure("migration_required", "workspace locator is not an object");
	const record = parsed as Record<string, unknown>;
	if (record["version"] !== PRIVATE_LOCATOR_VERSION) return failure("migration_required", `workspace locator version ${String(record["version"])} is unsupported; migration required before use`);
	if (typeof record["platform"] !== "string" || !isWorkspacePlatform(record["platform"])) return failure("migration_required", "workspace locator platform is missing or unknown");
	if (record["kind"] !== "posix" && record["kind"] !== "drive" && record["kind"] !== "unc") return failure("migration_required", "workspace locator kind is missing or unknown");
	if (typeof record["path"] !== "string" || record["path"].length === 0) return failure("migration_required", "workspace locator path is missing");
	return {
		ok: true,
		value: { version: PRIVATE_LOCATOR_VERSION, platform: record["platform"] as PrivateLocatorV1["platform"], kind: record["kind"] as PrivateLocatorV1["kind"], path: record["path"] },
	};
}

/** ADR D4：恢复前校验 platform 匹配与 kind/platform 一致性；不猜测跨平台转换。 */
export function validateLocatorForPlatform(locator: PrivateLocatorV1, currentPlatform: WorkspacePlatform): WorkspacePathResult<PrivateLocatorV1> {
	if (locator.platform !== currentPlatform) {
		return failure("platform_mismatch", `locator platform ${locator.platform} does not match current platform ${currentPlatform}; no cross-platform path conversion is performed`);
	}
	if (currentPlatform === "windows" ? locator.kind === "posix" : locator.kind !== "posix") {
		return failure("invalid_path", `locator kind ${locator.kind} is inconsistent with platform ${currentPlatform}`);
	}
	return { ok: true, value: locator };
}

/** 纯函数辅助：把 locator 重新解析为 identity（恢复路径的显示值与比较键）。 */
export function identityFromLocator(locator: PrivateLocatorV1): WorkspacePathResult<PathIdentity> {
	return parsePath(locator.path, locator.platform);
}
