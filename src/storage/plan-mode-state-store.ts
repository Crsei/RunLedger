/** PlanModeState 的 durable projection；v3 mode/plan events 仍是 canonical audit。 */

import { mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import type { ExpectedRevision } from "../runtime/protocol/v3/events.ts";
import { createSessionEventStreamRef, sameRuntimeEventStream } from "../runtime/protocol/v3/events.ts";
import { isExpectedRevision as isRuntimeExpectedRevision } from "../runtime/protocol/v3/schemas.ts";
import { canonicalDigest } from "../runtime/protocol/v3/canonical-json.ts";
import {
	isRuntimeId,
	type AuthorityId,
	type SessionId,
	type TenantId,
	type WorkspaceId,
} from "../runtime/protocol/v3/ids.ts";
import { isPlanModeState } from "../runtime/modes/plan/schema.ts";
import type { PlanModeProjectionPort } from "../runtime/modes/plan/service.ts";
import type { PlanModeState } from "../runtime/modes/plan/types.ts";

const MAX_PLAN_STATE_BYTES = 4 * 1024 * 1024;

interface StoredPlanModeStateBody {
	schemaVersion: 1;
	authorityId: AuthorityId;
	tenantId: TenantId;
	sessionId: SessionId;
	workspaceId: WorkspaceId;
	eventRevision: ExpectedRevision;
	state: PlanModeState;
}

interface StoredPlanModeState extends StoredPlanModeStateBody {
	storedDigest: string;
}

export interface FilePlanModeStateStoreOptions {
	path: string;
	authorityId: AuthorityId;
	tenantId: TenantId;
	sessionId: SessionId;
	workspaceId: WorkspaceId;
	currentRevision(): ExpectedRevision | undefined;
}

export interface LoadedPlanModeState {
	state: PlanModeState;
	eventRevision: ExpectedRevision;
	workspaceId: WorkspaceId;
}

function isExpectedRevision(
	value: unknown,
	scope: Pick<FilePlanModeStateStoreOptions, "authorityId" | "tenantId" | "sessionId">,
): value is ExpectedRevision {
	return isRuntimeExpectedRevision(value) && sameRuntimeEventStream(
		value.stream,
		createSessionEventStreamRef(scope, scope.sessionId),
	);
}

function bodyDigest(body: StoredPlanModeStateBody): string {
	return canonicalDigest(body);
}

function isStoredState(
	value: unknown,
	scope: Pick<FilePlanModeStateStoreOptions, "authorityId" | "tenantId" | "sessionId" | "workspaceId">,
): value is StoredPlanModeState {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	if (record.schemaVersion !== 1 || record.authorityId !== scope.authorityId || record.tenantId !== scope.tenantId ||
		record.sessionId !== scope.sessionId || record.workspaceId !== scope.workspaceId ||
		typeof record.storedDigest !== "string" || !isExpectedRevision(record.eventRevision, scope) ||
		!isPlanModeState(record.state)) return false;
	if (record.state.authorityId !== scope.authorityId || record.state.tenantId !== scope.tenantId ||
		record.state.sessionId !== scope.sessionId) return false;
	if ("plan" in record.state && record.state.plan.workspaceId !== scope.workspaceId) return false;
	const body: StoredPlanModeStateBody = {
		schemaVersion: 1,
		...scope,
		eventRevision: record.eventRevision,
		state: record.state,
	};
	return record.storedDigest === bodyDigest(body);
}

async function ensurePrivateParent(path: string): Promise<void> {
	const parent = dirname(path);
	await mkdir(parent, { recursive: true, mode: 0o700 });
	const metadata = await stat(parent);
	if (!metadata.isDirectory() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0) {
		throw new Error("plan mode state parent must be a private non-symlink directory");
	}
}

export class FilePlanModeStateStore implements PlanModeProjectionPort {
	readonly #path: string;
	readonly #scope: Pick<FilePlanModeStateStoreOptions, "authorityId" | "tenantId" | "sessionId" | "workspaceId">;
	readonly #currentRevision: FilePlanModeStateStoreOptions["currentRevision"];

	public constructor(options: FilePlanModeStateStoreOptions) {
		if (!isAbsolute(options.path) || resolve(options.path) !== options.path ||
			!isRuntimeId(options.authorityId, "authority") || !isRuntimeId(options.tenantId, "tenant") ||
			!isRuntimeId(options.sessionId, "session") || !isRuntimeId(options.workspaceId, "workspace")) {
			throw new TypeError("plan mode state store options are invalid");
		}
		this.#path = options.path;
		this.#scope = {
			authorityId: options.authorityId,
			tenantId: options.tenantId,
			sessionId: options.sessionId,
			workspaceId: options.workspaceId,
		};
		this.#currentRevision = options.currentRevision;
	}

	public async load(): Promise<LoadedPlanModeState | undefined> {
		let metadata;
		try {
			metadata = await stat(this.#path);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw error;
		}
		if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_PLAN_STATE_BYTES ||
			(metadata.mode & 0o077) !== 0) throw new Error("plan mode state file is unsafe");
		const source = await readFile(this.#path, "utf8");
		if (Buffer.byteLength(source, "utf8") > MAX_PLAN_STATE_BYTES) throw new Error("plan mode state is oversized");
		let parsed: unknown;
		try {
			parsed = JSON.parse(source) as unknown;
		} catch {
			throw new Error("plan mode state is malformed");
		}
		if (!isStoredState(parsed, this.#scope)) throw new Error("plan mode state failed scope or digest validation");
		return {
			state: structuredClone(parsed.state),
			eventRevision: { ...parsed.eventRevision },
			workspaceId: parsed.workspaceId,
		};
	}

	public async commit(state: PlanModeState): Promise<void> {
		if (!isPlanModeState(state) || state.authorityId !== this.#scope.authorityId ||
			state.tenantId !== this.#scope.tenantId || state.sessionId !== this.#scope.sessionId ||
			("plan" in state && state.plan.workspaceId !== this.#scope.workspaceId)) {
			throw new Error("plan mode state does not match the projection scope");
		}
		const eventRevision = this.#currentRevision();
		if (!eventRevision || !isExpectedRevision(eventRevision, this.#scope)) {
			throw new Error("plan mode state cannot commit without a durable v3 event revision");
		}
		await ensurePrivateParent(this.#path);
		const body: StoredPlanModeStateBody = {
			schemaVersion: 1,
			...this.#scope,
			eventRevision: { ...eventRevision },
			state: structuredClone(state),
		};
		const stored: StoredPlanModeState = { ...body, storedDigest: bodyDigest(body) };
		const content = `${JSON.stringify(stored)}\n`;
		if (Buffer.byteLength(content, "utf8") > MAX_PLAN_STATE_BYTES) throw new Error("plan mode state is oversized");
		const temporary = `${this.#path}.${stored.storedDigest.slice(0, 16)}.tmp`;
		const handle = await open(temporary, "wx", 0o600);
		try {
			await handle.writeFile(content, "utf8");
			await handle.sync();
		} finally {
			await handle.close();
		}
		try {
			await rename(temporary, this.#path);
			const parent = await open(dirname(this.#path), "r");
			try {
				await parent.sync();
			} finally {
				await parent.close();
			}
		} catch (error) {
			await unlink(temporary).catch(() => undefined);
			throw error;
		}
	}
}
