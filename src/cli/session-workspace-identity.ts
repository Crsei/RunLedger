/**
 * 标准 CLI 的 normal-source workspace identity。
 *
 * worktree binding 只覆盖显式 worktree；这里冻结直接在 source workspace
 * 创建的 Session 所属根与 repository identity，恢复时不允许用新的 cwd 替换。
 */

import { realpathSync } from "node:fs";
import { canonicalDigest } from "../runtime/protocol/canonical-json.ts";
import { createRuntimeId } from "../runtime/protocol/ids.ts";
import { encodePrivateLocator, identityFromLocator, parsePath, validateLocatorForPlatform } from "../workspace/path-adapter.ts";
import { runtimeWorkspacePlatform } from "../workspace/runtime-platform.ts";
import type { PrivateLocatorV1, WorkspacePlatform } from "../workspace/types.ts";
import type { SessionCatalogRecord } from "../storage/session-store/session-store.ts";
import type { GitCommandPort } from "../worktree/ports.ts";

const SESSION_WORKSPACE_LOCATOR_VERSION = 1 as const;

interface SessionWorkspaceLocatorV1 {
	readonly version: typeof SESSION_WORKSPACE_LOCATOR_VERSION;
	readonly platform: WorkspacePlatform;
	readonly workspaceKey: string;
	readonly repositoryKey: string;
	readonly rootLocator: PrivateLocatorV1;
	readonly repositoryLocator: PrivateLocatorV1;
}

export interface SessionWorkspaceIdentity {
	readonly workspaceId: string;
	readonly repositoryId: string;
	readonly sourceWorkspaceLocator: string;
	readonly workspaceKey: string;
}

export async function resolveSessionWorkspaceIdentity(cwd: string, git?: GitCommandPort): Promise<SessionWorkspaceIdentity> {
	const platform = runtimeWorkspacePlatform();
	const rootPath = canonicalPath(cwd, "workspace root");
	const repositoryPath = await resolveRepositoryRoot(rootPath, git);
	const root = parseCanonicalPath(rootPath, platform, "workspace root");
	const repository = parseCanonicalPath(repositoryPath, platform, "repository root");
	const workspaceKey = canonicalDigest({
		version: SESSION_WORKSPACE_LOCATOR_VERSION,
		platform,
		rootCompareKey: root.compareKey,
		repositoryCompareKey: repository.compareKey,
	});
	const repositoryKey = canonicalDigest({
		version: SESSION_WORKSPACE_LOCATOR_VERSION,
		platform,
		repositoryCompareKey: repository.compareKey,
	});
	const serialized: SessionWorkspaceLocatorV1 = {
		version: SESSION_WORKSPACE_LOCATOR_VERSION,
		platform,
		workspaceKey,
		repositoryKey,
		rootLocator: encodePrivateLocator(root, platform),
		repositoryLocator: encodePrivateLocator(repository, platform),
	};
	return {
		workspaceId: createRuntimeId("workspace", workspaceKey.slice(0, 48)),
		repositoryId: createRuntimeId("repository", repositoryKey.slice(0, 48)),
		sourceWorkspaceLocator: JSON.stringify(serialized),
		workspaceKey,
	};
}

/** 缺失/损坏/不匹配一律拒绝；rebind/migrate 必须是显式流程，不能在 open 时猜测。 */
export function sessionWorkspaceMatches(record: SessionCatalogRecord, current: SessionWorkspaceIdentity): boolean {
	const stored = parseStoredWorkspaceLocator(record.sourceWorkspaceLocator);
	return stored !== undefined
		&& stored.workspaceKey === current.workspaceKey
		&& record.workspaceId === current.workspaceId
		&& record.repositoryId === current.repositoryId;
}

export function assertSessionWorkspaceMatches(record: SessionCatalogRecord, current: SessionWorkspaceIdentity): void {
	if (sessionWorkspaceMatches(record, current)) return;
	if (record.sourceWorkspaceLocator === undefined) {
		throw new Error("session workspace binding is missing; explicit rebind/migrate is required before open or resume");
	}
	throw new Error("session workspace binding does not match the current workspace; use an explicit rebind/migrate flow");
}

function canonicalPath(path: string, label: string): string {
	try {
		return realpathSync(path);
	} catch (error) {
		throw new Error(label + " cannot be resolved: " + (error instanceof Error ? error.message : String(error)));
	}
}

async function resolveRepositoryRoot(rootPath: string, git: GitCommandPort | undefined): Promise<string> {
	if (git === undefined) return rootPath;
	try {
		const result = await git.run({
			cwd: rootPath,
			arguments: ["rev-parse", "--show-toplevel"],
			timeoutMs: 10_000,
		});
		if (result.exitCode !== 0 || result.signaled) return rootPath;
		const output = result.stdout.trim();
		return output.length === 0 ? rootPath : canonicalPath(output, "repository root");
	} catch {
		// 非 Git workspace 的 repository identity 等于其 canonical root。
		return rootPath;
	}
}

function parseCanonicalPath(path: string, platform: WorkspacePlatform, label: string) {
	const parsed = parsePath(path, platform);
	if (!parsed.ok) throw new Error(label + " is invalid: " + parsed.error.message);
	return parsed.value;
}

function parseStoredWorkspaceLocator(serialized: string | undefined): SessionWorkspaceLocatorV1 | undefined {
	if (serialized === undefined) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(serialized) as unknown;
	} catch {
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
	const value = parsed as Record<string, unknown>;
	if (
		value.version !== SESSION_WORKSPACE_LOCATOR_VERSION
		|| typeof value.platform !== "string"
		|| typeof value.workspaceKey !== "string"
		|| typeof value.repositoryKey !== "string"
		|| !/^[a-f0-9]{64}$/u.test(value.workspaceKey)
		|| !/^[a-f0-9]{64}$/u.test(value.repositoryKey)
	) {
		return undefined;
	}
	const platform = value.platform;
	if (platform !== "linux" && platform !== "macos" && platform !== "windows") return undefined;
	const rootLocator = parsePrivateLocator(value.rootLocator, platform);
	const repositoryLocator = parsePrivateLocator(value.repositoryLocator, platform);
	if (rootLocator === undefined || repositoryLocator === undefined) return undefined;
	const root = identityFromLocator(rootLocator);
	const repository = identityFromLocator(repositoryLocator);
	if (!root.ok || !repository.ok) return undefined;
	const expectedWorkspaceKey = canonicalDigest({
		version: SESSION_WORKSPACE_LOCATOR_VERSION,
		platform,
		rootCompareKey: root.value.compareKey,
		repositoryCompareKey: repository.value.compareKey,
	});
	const expectedRepositoryKey = canonicalDigest({
		version: SESSION_WORKSPACE_LOCATOR_VERSION,
		platform,
		repositoryCompareKey: repository.value.compareKey,
	});
	if (value.workspaceKey !== expectedWorkspaceKey || value.repositoryKey !== expectedRepositoryKey) return undefined;
	return {
		version: SESSION_WORKSPACE_LOCATOR_VERSION,
		platform,
		workspaceKey: value.workspaceKey,
		repositoryKey: value.repositoryKey,
		rootLocator,
		repositoryLocator,
	};
}

function parsePrivateLocator(value: unknown, platform: WorkspacePlatform): PrivateLocatorV1 | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	if (
		record.version !== 1
		|| record.platform !== platform
		|| (record.kind !== "posix" && record.kind !== "drive" && record.kind !== "unc")
		|| typeof record.path !== "string"
	) {
		return undefined;
	}
	const locator: PrivateLocatorV1 = {
		version: 1,
		platform,
		kind: record.kind,
		path: record.path,
	};
	return validateLocatorForPlatform(locator, platform).ok ? locator : undefined;
}
