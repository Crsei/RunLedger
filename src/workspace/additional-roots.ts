/** Workspace settings 的 additionalDirectories canonical resolver。 */

import { posix as posixPath, win32 as win32Path } from "node:path";
import type { WorkspacePathAdapter } from "./native/types.ts";
import type { PathIdentity, WorkspacePathErrorCode, WorkspacePathResult, WorkspacePlatform } from "./types.ts";

export interface ResolvedAdditionalWorkspaceRoot {
	readonly requestedPath: string;
	readonly canonicalPath: string;
	readonly identity: PathIdentity;
}

export interface ResolveAdditionalWorkspaceRootsInput {
	readonly adapter: Pick<WorkspacePathAdapter, "platform" | "parse" | "realIdentity" | "isWithin">;
	readonly workspaceRoot: string;
	readonly paths: readonly string[];
}

function failure<T>(code: WorkspacePathErrorCode, message: string): WorkspacePathResult<T> {
	return { ok: false, error: { code, message, retryable: false } };
}

function pathApi(platform: WorkspacePlatform): typeof posixPath | typeof win32Path {
	return platform === "windows" ? win32Path : posixPath;
}

function requestedAbsolutePath(
	adapter: ResolveAdditionalWorkspaceRootsInput["adapter"],
	workspaceRoot: string,
	requestedPath: string,
): WorkspacePathResult<string> {
	if (requestedPath.length === 0 || requestedPath.includes("\0")) return failure("invalid_path", "additional workspace root is empty or contains NUL");
	const parsed = adapter.parse(requestedPath);
	if (parsed.ok) return { ok: true, value: parsed.value.displayPath };
	const api = pathApi(adapter.platform);
	if (api.isAbsolute(requestedPath)) return parsed;
	return { ok: true, value: api.resolve(workspaceRoot, requestedPath) };
}

/**
 * additionalDirectories 只允许成为主 workspace 的 canonical 子目录。
 * 先 realpath 再 containment，故 lexical `..` 和 symlink 跳出都 fail closed。
 */
export async function resolveAdditionalWorkspaceRoots(
	input: ResolveAdditionalWorkspaceRootsInput,
): Promise<WorkspacePathResult<readonly ResolvedAdditionalWorkspaceRoot[]>> {
	const workspace = await input.adapter.realIdentity(input.workspaceRoot);
	if (!workspace.ok) return workspace;
	const resolved: ResolvedAdditionalWorkspaceRoot[] = [];
	const seen = new Set<string>();
	for (const requestedPath of input.paths) {
		const absolute = requestedAbsolutePath(input.adapter, workspace.value.displayPath, requestedPath);
		if (!absolute.ok) return absolute;
		const identity = await input.adapter.realIdentity(absolute.value);
		if (!identity.ok) return identity;
		const containment = input.adapter.isWithin(workspace.value, identity.value);
		if (!containment.ok) return containment;
		if (containment.value === "cross_root" || containment.value === "outside") {
			return failure("cross_root_containment", `additional workspace root escapes the workspace: ${requestedPath}`);
		}
		if (seen.has(identity.value.compareKey)) continue;
		seen.add(identity.value.compareKey);
		resolved.push({ requestedPath, canonicalPath: identity.value.displayPath, identity: identity.value });
	}
	return { ok: true, value: Object.freeze(resolved) };
}
