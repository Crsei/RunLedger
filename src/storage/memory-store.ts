import { mkdir, open, readFile, readdir, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { canonicalDigest } from "../runtime/protocol/v3/canonical-json.ts";
import { createRuntimeId, parseRuntimeId, type AuthorityId, type PrincipalId, type SessionId, type TenantId, type WorkspaceId } from "../runtime/protocol/v3/ids.ts";
import type { ApprovalReceiptRef, ArtifactRef } from "../runtime/protocol/v3/capability.ts";
import { isMemoryProposal, isMemoryRecord } from "../runtime/context/memory/schema.ts";
import type { MemoryProposal, MemoryRecord, MemoryScopeRef } from "../runtime/context/memory/types.ts";
import {
	memoryDriftDiagnosticPath,
	memoryProposalPath,
	memoryRecordPath,
	memoryScopeDirectory,
	type CanonicalMemoryScopePath,
} from "./context-paths.ts";

interface StoredMemoryProposal {
	proposal: MemoryProposal;
	draft: MemoryRecord;
	storedDigest: string;
}

export type MemoryDriftReason =
	| "malformed_json"
	| "invalid_record"
	| "identity_drift"
	| "envelope_digest_mismatch"
	| "content_digest_mismatch";

export interface MemoryDriftDiagnostic {
	schemaVersion: 1;
	authorityId: AuthorityId;
	tenantId: TenantId;
	memoryId: MemoryRecord["memoryId"];
	scope: MemoryScopeRef;
	projectedStatus: "changed_unreviewed";
	reason: MemoryDriftReason;
	observedFileDigest: string;
	expectedStoredDigest?: string;
	detectedAt: string;
	diagnosticDigest: string;
}

export type MemoryRecordInspection =
	| { state: "canonical"; record: MemoryRecord }
	| { state: "changed_unreviewed"; diagnostic: MemoryDriftDiagnostic }
	| { state: "missing" };

export class MemoryStoreError extends Error {
	public readonly code: "not_found" | "scope_denied" | "revision_conflict" | "digest_drift" | "approval_required" | "invalid_record" | "io_error";
	public constructor(code: MemoryStoreError["code"], message: string) {
		super(message);
		this.name = "MemoryStoreError";
		this.code = code;
	}
}

export interface MemoryStoreRoots {
	userRoot: string;
	projectRoot: string;
	authorityId: AuthorityId;
	tenantId: TenantId;
	principalId: PrincipalId;
	workspaceId: WorkspaceId;
	sessionId: SessionId;
}

async function atomicWrite(path: string, content: string): Promise<void> {
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	const temporary = join(dirname(path), `.${createRuntimeId("command")}.tmp`);
	const handle = await open(temporary, "wx", 0o600);
	try {
		await handle.writeFile(content, "utf8");
		await handle.sync();
	} finally {
		await handle.close();
	}
	try {
		await rename(temporary, path);
	} catch (error) {
		await unlink(temporary).catch(() => undefined);
		throw error;
	}
}

function memoryRef(record: MemoryRecord) {
	return {
		schemaVersion: 1 as const,
		authorityId: record.authorityId,
		tenantId: record.tenantId,
		memoryId: record.memoryId,
		scope: record.scope,
		revision: record.revision,
		contentDigest: record.contentDigest,
		status: record.status,
	};
}

function sameScope(left: MemoryScopeRef, right: MemoryScopeRef): boolean {
	return canonicalDigest(left) === canonicalDigest(right);
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? value as Record<string, unknown>
		: undefined;
}

export class MemoryStore {
	readonly #roots: MemoryStoreRoots;

	public constructor(roots: MemoryStoreRoots) {
		this.#roots = roots;
	}

	public scopePath(scope: MemoryScopeRef): CanonicalMemoryScopePath {
		if (scope.scope === "user") {
			if (scope.ownerPrincipalId !== this.#roots.principalId) throw new MemoryStoreError("scope_denied", "user memory scope belongs to another principal");
			return { kind: "user", root: this.#roots.userRoot };
		}
		if (scope.scope === "workspace") {
			if (scope.workspaceId !== this.#roots.workspaceId) throw new MemoryStoreError("scope_denied", "workspace memory scope is not bound to this runtime");
			return { kind: "workspace", root: this.#roots.projectRoot, workspaceKey: scope.workspaceId };
		}
		if (scope.sessionId !== this.#roots.sessionId) throw new MemoryStoreError("scope_denied", "session memory scope is not current");
		return { kind: "session", root: this.#roots.projectRoot, sessionId: scope.sessionId };
	}

	async #writeRecord(record: MemoryRecord): Promise<void> {
		const body = { record };
		await atomicWrite(
			memoryRecordPath(this.scopePath(record.scope), record.memoryId),
			`${JSON.stringify({ ...body, storedDigest: canonicalDigest(body) })}\n`,
		);
		await unlink(memoryDriftDiagnosticPath(this.scopePath(record.scope), record.memoryId)).catch(() => undefined);
	}

	async #resolveProposal(stored: StoredMemoryProposal, proposal: MemoryProposal): Promise<void> {
		const body = { proposal, draft: stored.draft };
		await atomicWrite(
			memoryProposalPath(this.scopePath(stored.draft.scope), stored.proposal.proposalId),
			`${JSON.stringify({ ...body, storedDigest: canonicalDigest(body) })}\n`,
		);
	}

	async #recordDrift(
		scope: MemoryScopeRef,
		memoryId: MemoryRecord["memoryId"],
		reason: MemoryDriftReason,
		raw: string,
		expectedStoredDigest: string | undefined,
		detectedAt: string,
	): Promise<MemoryDriftDiagnostic> {
		const body = {
			schemaVersion: 1 as const,
			authorityId: this.#roots.authorityId,
			tenantId: this.#roots.tenantId,
			memoryId,
			scope,
			projectedStatus: "changed_unreviewed" as const,
			reason,
			observedFileDigest: canonicalDigest(raw),
			...(expectedStoredDigest === undefined ? {} : { expectedStoredDigest }),
			detectedAt,
		};
		const diagnostic: MemoryDriftDiagnostic = { ...body, diagnosticDigest: canonicalDigest(body) };
		await atomicWrite(
			memoryDriftDiagnosticPath(this.scopePath(scope), memoryId),
			`${JSON.stringify(diagnostic)}\n`,
		);
		return diagnostic;
	}

	public createDiffArtifact(diffBody: string, scope: MemoryScopeRef): ArtifactRef {
		const storedDigest = canonicalDigest(diffBody);
		return {
			authorityId: this.#roots.authorityId,
			tenantId: this.#roots.tenantId,
			artifactId: createRuntimeId("artifact", `memory-diff-${storedDigest.slice(0, 40)}`),
			storedDigest,
			kind: "diff",
			originalSize: Buffer.byteLength(diffBody),
			storedSize: Buffer.byteLength(diffBody),
			mediaType: "application/json",
			redaction: "metadata_only",
			transformReceipt: createRuntimeId("receipt", `memory-diff-${storedDigest.slice(0, 40)}`),
			...(scope.scope === "workspace" ? { workspaceId: scope.workspaceId } : {}),
		};
	}

	public async saveProposal(proposal: MemoryProposal, draft: MemoryRecord): Promise<void> {
		if (!isMemoryProposal(proposal) || !isMemoryRecord(draft) || proposal.status !== "pending" || draft.status !== "proposed") {
			throw new MemoryStoreError("invalid_record", "memory proposal or draft failed contract validation");
		}
		if (proposal.memory.memoryId !== draft.memoryId || proposal.memory.contentDigest !== draft.contentDigest) {
			throw new MemoryStoreError("invalid_record", "proposal does not bind its draft record");
		}
		const path = memoryProposalPath(this.scopePath(draft.scope), proposal.proposalId);
		const body = { proposal, draft };
		const envelope: StoredMemoryProposal = { ...body, storedDigest: canonicalDigest(body) };
		try {
			const handle = await open(path, "wx", 0o600).catch(async (error: unknown) => {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				await mkdir(dirname(path), { recursive: true, mode: 0o700 });
				return open(path, "wx", 0o600);
			});
			try { await handle.writeFile(`${JSON.stringify(envelope)}\n`, "utf8"); await handle.sync(); } finally { await handle.close(); }
		} catch (error) {
			throw new MemoryStoreError((error as NodeJS.ErrnoException).code === "EEXIST" ? "revision_conflict" : "io_error", "memory proposal could not be stored");
		}
	}

	public async loadProposal(scope: MemoryScopeRef, proposalId: MemoryProposal["proposalId"]): Promise<StoredMemoryProposal> {
		try {
			const parsed = JSON.parse(await readFile(memoryProposalPath(this.scopePath(scope), proposalId), "utf8")) as StoredMemoryProposal;
			if (
				!isMemoryProposal(parsed.proposal) || !isMemoryRecord(parsed.draft) ||
				parsed.proposal.proposalId !== proposalId ||
				parsed.proposal.authorityId !== this.#roots.authorityId || parsed.proposal.tenantId !== this.#roots.tenantId ||
				parsed.draft.authorityId !== this.#roots.authorityId || parsed.draft.tenantId !== this.#roots.tenantId ||
				parsed.proposal.memory.memoryId !== parsed.draft.memoryId ||
				parsed.proposal.memory.contentDigest !== parsed.draft.contentDigest ||
				!sameScope(parsed.draft.scope, scope) || !sameScope(parsed.proposal.memory.scope, scope) ||
				canonicalDigest({ proposal: parsed.proposal, draft: parsed.draft }) !== parsed.storedDigest
			) throw new MemoryStoreError("digest_drift", "stored proposal digest drifted");
			return parsed;
		} catch (error) {
			if (error instanceof MemoryStoreError) throw error;
			throw new MemoryStoreError((error as NodeJS.ErrnoException).code === "ENOENT" ? "not_found" : "io_error", "memory proposal could not be loaded");
		}
	}

	public async publish(scope: MemoryScopeRef, proposalId: MemoryProposal["proposalId"], receipt: ApprovalReceiptRef, now: string): Promise<MemoryRecord> {
		const stored = await this.loadProposal(scope, proposalId);
		if (stored.proposal.status === "approved" && stored.proposal.approvalReceipt?.receiptId === receipt.receiptId) {
			return this.readRecord(scope, stored.proposal.memory.memoryId);
		}
		if (stored.proposal.status !== "pending" || receipt.approvalId !== stored.proposal.approvalId || receipt.decision !== "allowed") {
			throw new MemoryStoreError("approval_required", "memory publication requires the matching allowed approval receipt");
		}
		if (
			stored.proposal.diff.kind !== "create" &&
			stored.proposal.diff.kind !== "update"
		) {
			throw new MemoryStoreError("invalid_record", "memory publication only accepts create or update proposals");
		}
		if (stored.proposal.expiresAt !== undefined && Date.parse(stored.proposal.expiresAt) <= Date.parse(now)) {
			throw new MemoryStoreError("approval_required", "expired memory proposal cannot be published");
		}
		if (stored.proposal.diff.kind === "update") {
			const before = stored.proposal.diff.before;
			if (before === undefined) {
				throw new MemoryStoreError(
					"invalid_record",
					"update proposal is missing its canonical before reference",
				);
			}
			const record = await this.readRecord(before.scope, before.memoryId);
			if (
				record.status !== "approved" ||
				record.revision !== before.revision ||
				record.contentDigest !== before.contentDigest ||
				!sameScope(record.scope, stored.draft.scope)
			) {
				throw new MemoryStoreError(
					"revision_conflict",
					"canonical memory changed after update was proposed",
				);
			}
		}
		const baseRevision = stored.proposal.diff.kind === "update"
			? stored.proposal.diff.before?.revision
			: stored.draft.revision;
		if (baseRevision === undefined) {
			throw new MemoryStoreError("invalid_record", "memory proposal has no base revision");
		}
		const published: MemoryRecord = {
			...stored.draft,
			status: "approved",
			revision: baseRevision + 1,
			approvalReceipt: receipt,
			updatedAt: now,
		};
		if (!isMemoryRecord(published)) {
			throw new MemoryStoreError("approval_required", "untrusted or invalid memory sources cannot be published");
		}
		await this.#writeRecord(published);
		const resolvedProposal: MemoryProposal = { ...stored.proposal, status: "approved", approvalReceipt: receipt };
		await this.#resolveProposal(stored, resolvedProposal);
		await this.rebuildHumanProjection(scope);
		return published;
	}

	public async reject(scope: MemoryScopeRef, proposalId: MemoryProposal["proposalId"], receipt: ApprovalReceiptRef): Promise<MemoryProposal> {
		const stored = await this.loadProposal(scope, proposalId);
		if (stored.proposal.status === "rejected" && stored.proposal.approvalReceipt?.receiptId === receipt.receiptId) {
			return stored.proposal;
		}
		if (stored.proposal.status !== "pending") {
			throw new MemoryStoreError("revision_conflict", "resolved memory proposal cannot be rejected again");
		}
		if (receipt.approvalId !== stored.proposal.approvalId || receipt.decision !== "denied") {
			throw new MemoryStoreError("approval_required", "memory rejection requires the matching denied receipt");
		}
		const proposal: MemoryProposal = { ...stored.proposal, status: "rejected", approvalReceipt: receipt };
		await this.#resolveProposal(stored, proposal);
		return proposal;
	}

	public async publishRevocation(
		scope: MemoryScopeRef,
		proposalId: MemoryProposal["proposalId"],
		receipt: ApprovalReceiptRef,
		now: string,
	): Promise<MemoryRecord> {
		const stored = await this.loadProposal(scope, proposalId);
		if (stored.proposal.status === "approved" && stored.proposal.approvalReceipt?.receiptId === receipt.receiptId) {
			const existing = await this.readRecord(scope, stored.proposal.memory.memoryId);
			if (existing.status === "revoked") return existing;
		}
		if (
			stored.proposal.status !== "pending" ||
			stored.proposal.diff.kind !== "delete" ||
			receipt.approvalId !== stored.proposal.approvalId ||
			receipt.decision !== "allowed"
		) {
			throw new MemoryStoreError("approval_required", "memory revocation requires a pending delete proposal and matching allowed receipt");
		}
		const before = stored.proposal.diff.before;
		if (before === undefined) throw new MemoryStoreError("invalid_record", "revoke proposal is missing its canonical before reference");
		const record = await this.readRecord(before.scope, before.memoryId);
		if (
			record.status !== "approved" ||
			record.revision !== before.revision ||
			record.contentDigest !== before.contentDigest
		) throw new MemoryStoreError("revision_conflict", "canonical memory changed after revocation was proposed");
		const revoked: MemoryRecord = {
			...record,
			status: "revoked",
			revision: record.revision + 1,
			updatedAt: now,
			revokedAt: now,
			revokedByPrincipalId: receipt.principalId,
			revocationRevision: record.revocationRevision + 1,
		};
		if (!isMemoryRecord(revoked)) throw new MemoryStoreError("invalid_record", "revoked memory failed contract validation");
		await this.#writeRecord(revoked);
		await this.#resolveProposal(stored, { ...stored.proposal, status: "approved", approvalReceipt: receipt });
		await this.rebuildHumanProjection(record.scope);
		return revoked;
	}

	public async expire(record: MemoryRecord, now: string): Promise<MemoryRecord> {
		if (record.status === "expired") return record;
		if (record.status !== "approved" || record.expiresAt === undefined || Date.parse(record.expiresAt) > Date.parse(now)) {
			throw new MemoryStoreError("revision_conflict", "memory is not eligible for expiration");
		}
		const canonical = await this.readRecord(record.scope, record.memoryId);
		if (canonical.revision !== record.revision || canonical.contentDigest !== record.contentDigest || canonical.status !== "approved") {
			throw new MemoryStoreError("revision_conflict", "canonical memory changed before expiration");
		}
		const expired: MemoryRecord = {
			...canonical,
			status: "expired",
			revision: canonical.revision + 1,
			updatedAt: now,
		};
		if (!isMemoryRecord(expired)) throw new MemoryStoreError("invalid_record", "expired memory failed contract validation");
		await this.#writeRecord(expired);
		await this.rebuildHumanProjection(expired.scope);
		return expired;
	}

	public async inspectRecord(
		scope: MemoryScopeRef,
		memoryId: MemoryRecord["memoryId"],
		detectedAt = new Date().toISOString(),
	): Promise<MemoryRecordInspection> {
		let raw: string;
		try {
			raw = await readFile(memoryRecordPath(this.scopePath(scope), memoryId), "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return { state: "missing" };
			throw new MemoryStoreError("io_error", "memory record could not be inspected");
		}

		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			return { state: "changed_unreviewed", diagnostic: await this.#recordDrift(scope, memoryId, "malformed_json", raw, undefined, detectedAt) };
		}
		const envelope = objectValue(parsed);
		const expectedStoredDigest = typeof envelope?.storedDigest === "string" ? envelope.storedDigest : undefined;
		const candidate = envelope?.record;
		if (!isMemoryRecord(candidate)) {
			return { state: "changed_unreviewed", diagnostic: await this.#recordDrift(scope, memoryId, "invalid_record", raw, expectedStoredDigest, detectedAt) };
		}
		if (
			candidate.authorityId !== this.#roots.authorityId ||
			candidate.tenantId !== this.#roots.tenantId ||
			candidate.memoryId !== memoryId ||
			!sameScope(candidate.scope, scope)
		) {
			return { state: "changed_unreviewed", diagnostic: await this.#recordDrift(scope, memoryId, "identity_drift", raw, expectedStoredDigest, detectedAt) };
		}
		if (expectedStoredDigest !== canonicalDigest({ record: candidate })) {
			return { state: "changed_unreviewed", diagnostic: await this.#recordDrift(scope, memoryId, "envelope_digest_mismatch", raw, expectedStoredDigest, detectedAt) };
		}
		if (canonicalDigest(candidate.content) !== candidate.contentDigest) {
			return { state: "changed_unreviewed", diagnostic: await this.#recordDrift(scope, memoryId, "content_digest_mismatch", raw, expectedStoredDigest, detectedAt) };
		}
		await unlink(memoryDriftDiagnosticPath(this.scopePath(scope), memoryId)).catch(() => undefined);
		return { state: "canonical", record: candidate };
	}

	public async readDriftDiagnostic(scope: MemoryScopeRef, memoryId: MemoryRecord["memoryId"]): Promise<MemoryDriftDiagnostic | undefined> {
		try {
			const parsed = JSON.parse(await readFile(memoryDriftDiagnosticPath(this.scopePath(scope), memoryId), "utf8")) as MemoryDriftDiagnostic;
			const { diagnosticDigest, ...body } = parsed;
			if (
				parsed.schemaVersion !== 1 || parsed.authorityId !== this.#roots.authorityId || parsed.tenantId !== this.#roots.tenantId ||
				parsed.memoryId !== memoryId || !sameScope(parsed.scope, scope) || parsed.projectedStatus !== "changed_unreviewed" ||
				diagnosticDigest !== canonicalDigest(body)
			) throw new MemoryStoreError("digest_drift", "memory drift diagnostic is invalid");
			return parsed;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			if (error instanceof MemoryStoreError) throw error;
			throw new MemoryStoreError("io_error", "memory drift diagnostic could not be read");
		}
	}

	public async readRecord(scope: MemoryScopeRef, memoryId: MemoryRecord["memoryId"]): Promise<MemoryRecord> {
		const inspection = await this.inspectRecord(scope, memoryId);
		if (inspection.state === "canonical") return inspection.record;
		if (inspection.state === "missing") throw new MemoryStoreError("not_found", "memory record could not be read");
		throw new MemoryStoreError("digest_drift", "canonical memory record changed outside approved publication");
	}

	public async listRecords(scopes: readonly MemoryScopeRef[]): Promise<readonly MemoryRecord[]> {
		const records: MemoryRecord[] = [];
		for (const scope of scopes) {
			const directory = join(memoryScopeDirectory(this.scopePath(scope)), "records");
			const files = await readdir(directory).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? [] : Promise.reject(error));
			for (const file of files.filter((name) => name.endsWith(".json")).sort()) {
				const memoryId = parseRuntimeId("memory", file.slice(0, -5));
				if (memoryId === undefined) continue;
				try { records.push(await this.readRecord(scope, memoryId)); } catch (error) {
					if (!(error instanceof MemoryStoreError) || error.code !== "digest_drift") throw error;
				}
			}
		}
		return records.sort((left, right) => left.memoryId.localeCompare(right.memoryId));
	}

	public async rebuildHumanProjection(scope: MemoryScopeRef): Promise<void> {
		const records = (await this.listRecords([scope])).filter((record) => record.status === "approved");
		const content = records.map((record) => `## ${record.title}\n\n${record.content}\n\n<!-- ${record.memoryId} r${record.revision} ${record.contentDigest} -->`).join("\n\n");
		await atomicWrite(join(memoryScopeDirectory(this.scopePath(scope)), "MEMORY.md"), content.length === 0 ? "" : `${content}\n`);
	}
}
