import { mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { canonicalDigest } from "../runtime/protocol/v3/canonical-json.ts";
import { createRuntimeId, type AuthorityId, type PlanId, type PrincipalId, type SessionId, type TenantId, type WorkspaceId } from "../runtime/protocol/v3/ids.ts";
import type { PlanArtifactRef } from "../runtime/modes/plan/types.ts";
import { isPlanArtifactRef } from "../runtime/modes/plan/schema.ts";
import { planDirectory, planRevisionMetadataPath, planRevisionPath, planWorkingPath } from "./context-paths.ts";

const MAX_PLAN_CHARS = 1_048_576;

export type PlanStoreErrorCode = "revision_conflict" | "not_found" | "digest_drift" | "invalid_body" | "io_error";

export class PlanStoreError extends Error {
	public readonly code: PlanStoreErrorCode;
	public constructor(code: PlanStoreErrorCode, message: string) {
		super(message);
		this.name = "PlanStoreError";
		this.code = code;
	}
}

export interface PlanStoreIdentity {
	authorityId: AuthorityId;
	tenantId: TenantId;
	sessionId: SessionId;
	workspaceId: WorkspaceId;
	principalId: PrincipalId;
}

async function atomicWrite(path: string, body: string): Promise<void> {
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	const temp = join(dirname(path), `.${createRuntimeId("command")}.tmp`);
	const handle = await open(temp, "wx", 0o600);
	try {
		await handle.writeFile(body, "utf8");
		await handle.sync();
	} finally {
		await handle.close();
	}
	try {
		await rename(temp, path);
	} catch (error) {
		await unlink(temp).catch(() => undefined);
		throw error;
	}
}

async function immutableWrite(path: string, body: string): Promise<void> {
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	const handle = await open(path, "wx", 0o600);
	try {
		await handle.writeFile(body, "utf8");
		await handle.sync();
	} finally {
		await handle.close();
	}
}

function assertBody(body: string): void {
	if (body.length > MAX_PLAN_CHARS || body.includes("\u0000")) {
		throw new PlanStoreError("invalid_body", `plan body exceeds ${MAX_PLAN_CHARS} characters or contains NUL`);
	}
}

export class PlanArtifactStore {
	readonly #root: string;
	readonly #identity: PlanStoreIdentity;

	public constructor(root: string, identity: PlanStoreIdentity) {
		this.#root = root;
		this.#identity = identity;
	}

	public async create(body = ""): Promise<PlanArtifactRef> {
		return this.write(createRuntimeId("plan"), -1, body);
	}

	public async write(planId: PlanId, expectedRevision: number, body: string): Promise<PlanArtifactRef> {
		assertBody(body);
		const revision = expectedRevision + 1;
		if (!Number.isSafeInteger(revision) || revision < 0) throw new PlanStoreError("revision_conflict", "invalid expected revision");
		const contentDigest = canonicalDigest(body);
		const now = new Date().toISOString();
		const byteLength = Buffer.byteLength(body, "utf8");
		const ref: PlanArtifactRef = {
			schemaVersion: 1,
			authorityId: this.#identity.authorityId,
			tenantId: this.#identity.tenantId,
			planId,
			workspaceId: this.#identity.workspaceId,
			revision,
			contentDigest,
			artifact: {
				authorityId: this.#identity.authorityId,
				tenantId: this.#identity.tenantId,
				artifactId: createRuntimeId("artifact", `plan-${contentDigest.slice(0, 48)}`),
				storedDigest: contentDigest,
				kind: "change_proposal",
				originalSize: byteLength,
				storedSize: byteLength,
				mediaType: "text/markdown",
				redaction: "metadata_only",
				transformReceipt: createRuntimeId("receipt", `plan-${contentDigest.slice(0, 48)}`),
				workspaceId: this.#identity.workspaceId,
			},
			createdByPrincipalId: this.#identity.principalId,
			createdAt: now,
		};
		if (!isPlanArtifactRef(ref)) throw new PlanStoreError("invalid_body", "generated plan artifact ref failed contract validation");
		try {
			await immutableWrite(planRevisionPath(this.#root, this.#identity.sessionId, planId, revision), body);
			try {
				await immutableWrite(
					planRevisionMetadataPath(this.#root, this.#identity.sessionId, planId, revision),
					`${JSON.stringify(ref)}\n`,
				);
			} catch (error) {
				await unlink(planRevisionPath(this.#root, this.#identity.sessionId, planId, revision)).catch(() => undefined);
				throw error;
			}
			await atomicWrite(planWorkingPath(this.#root, this.#identity.sessionId, planId), body);
			return ref;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code === "EEXIST" ? "revision_conflict" : "io_error";
			throw new PlanStoreError(code, `plan revision ${revision} could not be committed`);
		}
	}

	public async read(planId: PlanId, revision: number): Promise<{ ref: PlanArtifactRef; body: string }> {
		try {
			const [body, metadata] = await Promise.all([
				readFile(planRevisionPath(this.#root, this.#identity.sessionId, planId, revision), "utf8"),
				readFile(planRevisionMetadataPath(this.#root, this.#identity.sessionId, planId, revision), "utf8"),
			]);
			const ref = JSON.parse(metadata) as unknown;
			if (!isPlanArtifactRef(ref) || ref.planId !== planId || ref.revision !== revision || ref.contentDigest !== canonicalDigest(body)) {
				throw new PlanStoreError("digest_drift", "immutable plan revision metadata or body drifted");
			}
			return { ref, body };
		} catch (error) {
			if (error instanceof PlanStoreError) throw error;
			throw new PlanStoreError((error as NodeJS.ErrnoException).code === "ENOENT" ? "not_found" : "io_error", "plan revision could not be read");
		}
	}

	public async inspectWorkingCopy(ref: PlanArtifactRef): Promise<"current" | "changed_unreviewed" | "missing"> {
		try {
			const body = await readFile(planWorkingPath(this.#root, this.#identity.sessionId, ref.planId), "utf8");
			return canonicalDigest(body) === ref.contentDigest ? "current" : "changed_unreviewed";
		} catch (error) {
			return (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "changed_unreviewed";
		}
	}

	public async recoverWorkingCopy(ref: PlanArtifactRef): Promise<void> {
		const { body } = await this.read(ref.planId, ref.revision);
		await atomicWrite(planWorkingPath(this.#root, this.#identity.sessionId, ref.planId), body);
	}

	public async permissions(planId: PlanId): Promise<{ directory: number; working: number }> {
		const [directory, working] = await Promise.all([
			stat(planDirectory(this.#root, this.#identity.sessionId, planId)),
			stat(planWorkingPath(this.#root, this.#identity.sessionId, planId)),
		]);
		return { directory: directory.mode & 0o777, working: working.mode & 0o777 };
	}
}
