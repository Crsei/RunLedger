/**
 * Session 的 source-workspace identity 与 admission。
 *
 * CLI 初始 open、TUI catalog/resume 与最终 view composition 必须使用同一
 * binding comparison；缺失、损坏或不一致的 binding 一律不进入 normal path。
 */

import { realpathSync } from "node:fs";
import { canonicalDigest } from "../runtime/protocol/canonical-json.ts";
import { createRuntimeId } from "../runtime/protocol/ids.ts";
import { encodePrivateLocator, identityFromLocator, parsePath, validateLocatorForPlatform } from "./path-adapter.ts";
import { runtimeWorkspacePlatform } from "./runtime-platform.ts";
import type { PrivateLocatorV1, WorkspacePlatform } from "./types.ts";
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

/** Catalog row 与 identity resolution 共同需要的最小 private binding 形状。 */
export interface SessionWorkspaceBindingRecord {
	readonly workspaceId: string;
	readonly repositoryId: string;
	readonly sourceWorkspaceLocator?: string;
}

export interface SessionWorkspaceIdentity extends SessionWorkspaceBindingRecord {
	readonly sourceWorkspaceLocator: string;
	readonly workspaceKey: string;
	readonly repositoryKey: string;
}

export type SessionWorkspaceAdmissionStatus = "accepted" | "binding_missing" | "binding_invalid" | "binding_mismatch";

/**
 * 共享 workspace admission service。authority 可来自当前 CLI cwd，也可来自
 * 已打开 source Session；两种入口最终比较相同的 canonical binding。
 */
export class SessionWorkspaceAdmission {
	private readonly identity: SessionWorkspaceIdentity;

	private constructor(identity: SessionWorkspaceIdentity) {
		this.identity = identity;
	}

	public static fromIdentity(identity: SessionWorkspaceIdentity): SessionWorkspaceAdmission {
		return new SessionWorkspaceAdmission(identity);
	}

	public static fromRecord(record: SessionWorkspaceBindingRecord): SessionWorkspaceAdmission | undefined {
		const identity = identityFromRecord(record);
		return identity === undefined ? undefined : new SessionWorkspaceAdmission(identity);
	}

	public status(record: SessionWorkspaceBindingRecord): SessionWorkspaceAdmissionStatus {
		if (record.sourceWorkspaceLocator === undefined) return "binding_missing";
		const target = identityFromRecord(record);
		if (target === undefined) return "binding_invalid";
		return target.workspaceKey === this.identity.workspaceKey
			&& target.repositoryKey === this.identity.repositoryKey
			&& target.workspaceId === this.identity.workspaceId
			&& target.repositoryId === this.identity.repositoryId
			? "accepted"
			: "binding_mismatch";
	}

	public admits(record: SessionWorkspaceBindingRecord): boolean {
		return this.status(record) === "accepted";
	}
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
		repositoryKey,
	};
}

/** 缺失/损坏/不匹配一律拒绝；rebind/migrate 必须是显式流程。 */
export function sessionWorkspaceMatches(record: SessionWorkspaceBindingRecord, current: SessionWorkspaceIdentity): boolean {
	return SessionWorkspaceAdmission.fromIdentity(current).admits(record);
}

export function assertSessionWorkspaceMatches(record: SessionWorkspaceBindingRecord, current: SessionWorkspaceIdentity): void {
	const status = SessionWorkspaceAdmission.fromIdentity(current).status(record);
	if (status === "accepted") return;
	if (status === "binding_missing") {
		throw new Error("session workspace binding is missing; explicit rebind/migrate is required before open or resume");
	}
	if (status === "binding_invalid") {
		throw new Error("session workspace binding is invalid; explicit rebind/migrate is required before open or resume");
	}
	throw new Error("session workspace binding does not match the current workspace; use an explicit rebind/migrate flow");
}

function identityFromRecord(record: SessionWorkspaceBindingRecord): SessionWorkspaceIdentity | undefined {
	const stored = parseStoredWorkspaceLocator(record.sourceWorkspaceLocator);
	if (stored === undefined) return undefined;
	const workspaceId = createRuntimeId("workspace", stored.workspaceKey.slice(0, 48));
	const repositoryId = createRuntimeId("repository", stored.repositoryKey.slice(0, 48));
	if (record.workspaceId !== workspaceId || record.repositoryId !== repositoryId || record.sourceWorkspaceLocator === undefined) return undefined;
	return {
		workspaceId,
		repositoryId,
		sourceWorkspaceLocator: record.sourceWorkspaceLocator,
		workspaceKey: stored.workspaceKey,
		repositoryKey: stored.repositoryKey,
	};
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
