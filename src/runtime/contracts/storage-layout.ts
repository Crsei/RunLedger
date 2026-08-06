/** RunLedger 单一用户级 home、固定布局与 durable locator contract。 */

import { posix, win32 } from "node:path";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { canonicalDigest } from "../protocol/canonical-json.ts";
import { RuntimeDigestSchema, RuntimeIdSchema, isCanonicalUtcTimestamp } from "../protocol/foundation-schemas.ts";
import type { RuntimeDigest } from "../protocol/foundation.ts";
import {
	isRuntimeId,
	type AuthorityId,
	type AttemptId,
	type ExecutionId,
	type RepositoryId,
	type RuntimeId,
	type SessionId,
	type TenantId,
	type TraceId,
	type WorkspaceId,
} from "../protocol/ids.ts";

export const RUNLEDGER_DIRECTORY_MODE = 0o700;
export const RUNLEDGER_FILE_MODE = 0o600;

export type RuntimePathFlavor = "posix" | "win32";

export interface RunledgerHomeOverrideProbe {
	readonly rawValue: string;
	readonly state: "directory" | "missing" | "not_directory" | "unavailable";
	readonly canonicalPath?: string;
}

export interface RunledgerHomeResolutionInput {
	readonly override?: RunledgerHomeOverrideProbe;
	readonly userHome?: string;
	readonly pathFlavor: RuntimePathFlavor;
}

export type RunledgerHomeResolution =
	| {
			readonly ok: true;
			readonly runledgerHome: string;
			readonly source: "override" | "default";
			readonly createDefault: boolean;
	  }
	| {
			readonly ok: false;
			readonly code:
				| "override_empty"
				| "override_not_absolute"
				| "override_missing"
				| "override_not_directory"
				| "override_unavailable"
				| "override_not_canonical"
				| "user_home_unavailable"
				| "user_home_not_absolute";
	  };

export interface RunledgerLayout {
	readonly home: string;
	readonly settings: string;
	readonly auth: string;
	readonly agents: string;
	readonly sessions: string;
	readonly archivedSessions: string;
	readonly events: string;
	readonly sessionIndex: string;
	readonly projects: string;
	readonly artifacts: string;
	readonly artifactMetadata: string;
	readonly snapshots: string;
	readonly projections: string;
	readonly state: string;
	readonly log: string;
	readonly cache: string;
	readonly ipc: string;
	readonly tmp: string;
	/** 06 §4.1:Session Owner durable state 的 SQLite 数据库文件(<home>/state.db)。 */
	readonly database: string;
	/** 06 §7.5:worktree canonical locator 根(<home>/worktrees/<sessionId>)。 */
	readonly worktrees: string;
	/** 06 §12.2:JSONL/SQLite 显式迁移的 verified archive 根(<home>/migration-backup)。 */
	readonly migrationBackups: string;
}

export interface WorkspaceStorageIdentity {
	readonly authorityId: AuthorityId;
	readonly tenantId: TenantId;
	readonly workspaceId: WorkspaceId;
	readonly repositoryId: RepositoryId;
}

export type RuntimeLocatorObjectKind =
	| "session"
	| "archived_session"
	| "trace"
	| "artifact"
	| "snapshot"
	| "projection"
	| "project"
	| "receipt";

export interface RuntimeLocator {
	readonly objectKind: RuntimeLocatorObjectKind;
	readonly objectId: RuntimeId;
	readonly relativeLocator: string;
	readonly utcShard?: string;
	readonly digest?: RuntimeDigest;
}

function pathApi(flavor: RuntimePathFlavor): typeof posix | typeof win32 {
	return flavor === "win32" ? win32 : posix;
}

export function resolveRunledgerHomeContract(input: RunledgerHomeResolutionInput): RunledgerHomeResolution {
	const paths = pathApi(input.pathFlavor);
	if (input.override) {
		if (input.override.rawValue.length === 0) return { ok: false, code: "override_empty" };
		if (!paths.isAbsolute(input.override.rawValue)) return { ok: false, code: "override_not_absolute" };
		switch (input.override.state) {
			case "missing": return { ok: false, code: "override_missing" };
			case "not_directory": return { ok: false, code: "override_not_directory" };
			case "unavailable": return { ok: false, code: "override_unavailable" };
			case "directory": {
				const canonicalPath = input.override.canonicalPath;
				if (!canonicalPath || !paths.isAbsolute(canonicalPath)) return { ok: false, code: "override_not_canonical" };
				return {
					ok: true,
					runledgerHome: paths.normalize(canonicalPath),
					source: "override",
					createDefault: false,
				};
			}
		}
	}
	if (!input.userHome) return { ok: false, code: "user_home_unavailable" };
	if (!paths.isAbsolute(input.userHome)) return { ok: false, code: "user_home_not_absolute" };
	return {
		ok: true,
		runledgerHome: paths.join(paths.normalize(input.userHome), ".runledger"),
		source: "default",
		createDefault: true,
	};
}

export function buildRunledgerLayout(home: string, flavor: RuntimePathFlavor): RunledgerLayout {
	const paths = pathApi(flavor);
	if (!paths.isAbsolute(home)) throw new Error("runledgerHome must be absolute");
	const normalizedHome = paths.normalize(home);
	return {
		home: normalizedHome,
		settings: paths.join(normalizedHome, "settings.json"),
		auth: paths.join(normalizedHome, "auth.json"),
		agents: paths.join(normalizedHome, "AGENTS.md"),
		sessions: paths.join(normalizedHome, "sessions"),
		archivedSessions: paths.join(normalizedHome, "archived_sessions"),
		events: paths.join(normalizedHome, "events"),
		sessionIndex: paths.join(normalizedHome, "session_index.jsonl"),
		projects: paths.join(normalizedHome, "projects"),
		artifacts: paths.join(normalizedHome, "artifacts"),
		artifactMetadata: paths.join(normalizedHome, "artifact-metadata"),
		snapshots: paths.join(normalizedHome, "snapshots"),
		projections: paths.join(normalizedHome, "projections"),
		state: paths.join(normalizedHome, "state"),
		log: paths.join(normalizedHome, "log"),
		cache: paths.join(normalizedHome, "cache"),
		ipc: paths.join(normalizedHome, "ipc"),
		tmp: paths.join(normalizedHome, "tmp"),
		database: paths.join(normalizedHome, "state.db"),
		worktrees: paths.join(normalizedHome, "worktrees"),
		migrationBackups: paths.join(normalizedHome, "migration-backup"),
	};
}

export function workspaceStorageKey(workspace: WorkspaceStorageIdentity): string {
	return `ws-${canonicalDigest({
		authorityId: workspace.authorityId,
		tenantId: workspace.tenantId,
		workspaceId: workspace.workspaceId,
		repositoryId: workspace.repositoryId,
	})}`;
}

const WORKSPACE_STORAGE_KEY_PATTERN = /^ws-[a-f0-9]{64}$/u;

function assertWorkspaceStorageKey(value: string): void {
	if (!WORKSPACE_STORAGE_KEY_PATTERN.test(value)) throw new Error("invalid workspace storage key");
}

export function hostEndpointRelativeLocator(storageKey: string): string {
	assertWorkspaceStorageKey(storageKey);
	return `ipc/hosts/${storageKey}/endpoint.json`;
}

export function hostSocketRelativeLocator(storageKey: string): string {
	assertWorkspaceStorageKey(storageKey);
	return `ipc/hosts/${storageKey}/host.sock`;
}

export function hostStartupElectionRelativeLocator(storageKey: string): string {
	assertWorkspaceStorageKey(storageKey);
	return `ipc/hosts/${storageKey}/startup-election`;
}

export function hostStateRelativeLocator(storageKey: string): string {
	assertWorkspaceStorageKey(storageKey);
	return `state/hosts/${storageKey}`;
}

export function processStateRelativeLocator(
	storageKey: string,
	executionId: ExecutionId,
	attemptId: AttemptId,
): string {
	assertWorkspaceStorageKey(storageKey);
	if (!isRuntimeId(executionId, "execution") || !isRuntimeId(attemptId, "attempt")) {
		throw new Error("process locator requires execution and attempt IDs");
	}
	return `state/processes/${storageKey}/${executionId}/${attemptId}.json`;
}

export function sessionRelativeLocator(sessionId: SessionId, createdAt: string, archived: boolean): string {
	if (!isRuntimeId(sessionId, "session") || !isCanonicalUtcTimestamp(createdAt)) {
		throw new Error("session locator requires a valid session ID and canonical UTC timestamp");
	}
	const shard = `${createdAt.slice(0, 4)}/${createdAt.slice(5, 7)}/${createdAt.slice(8, 10)}`;
	return `${archived ? "archived_sessions" : "sessions"}/${shard}/${sessionId}.jsonl`;
}

export function artifactRelativeLocator(digest: string): string {
	if (!/^[a-f0-9]{64}$/u.test(digest)) throw new Error("artifact locator requires a sha256 digest");
	return `artifacts/sha256/${digest.slice(0, 2)}/${digest}`;
}

export function traceEventRelativeLocator(traceId: TraceId, createdAt: string): string {
	if (!isRuntimeId(traceId, "trace") || !isCanonicalUtcTimestamp(createdAt)) {
		throw new Error("trace event locator requires a valid trace ID and canonical UTC timestamp");
	}
	const shard = `${createdAt.slice(0, 4)}/${createdAt.slice(5, 7)}/${createdAt.slice(8, 10)}`;
	return `events/${shard}/${traceId}.jsonl`;
}

export function isContainedRuntimePath(home: string, target: string, flavor: RuntimePathFlavor): boolean {
	const paths = pathApi(flavor);
	if (!paths.isAbsolute(home) || !paths.isAbsolute(target)) return false;
	const normalizedHome = paths.resolve(home);
	const normalizedTarget = paths.resolve(target);
	const relativeTarget = paths.relative(normalizedHome, normalizedTarget);
	return relativeTarget === "" || (!relativeTarget.startsWith(`..${paths.sep}`) && relativeTarget !== ".." && !paths.isAbsolute(relativeTarget));
}

const RuntimeLocatorObjectKindSchema = Type.Unsafe<RuntimeLocatorObjectKind>({
	type: "string",
	enum: ["session", "archived_session", "trace", "artifact", "snapshot", "projection", "project", "receipt"],
});

export const RuntimeLocatorSchema = Type.Object(
	{
		objectKind: RuntimeLocatorObjectKindSchema,
		objectId: RuntimeIdSchema,
		relativeLocator: Type.String({ minLength: 1, maxLength: 512 }),
		utcShard: Type.Optional(Type.String({ pattern: "^[0-9]{4}/[0-9]{2}/[0-9]{2}$", minLength: 10, maxLength: 10 })),
		digest: Type.Optional(RuntimeDigestSchema),
	},
	{ additionalProperties: false },
);

export function isRuntimeLocator(value: unknown): value is RuntimeLocator {
	if (!Value.Check(RuntimeLocatorSchema, value)) return false;
	const locator = value.relativeLocator;
	if (locator.includes("\\") || posix.isAbsolute(locator) || win32.isAbsolute(locator)) return false;
	const segments = locator.split("/");
	return segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}
