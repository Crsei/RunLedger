/** readonly worktree registry-backed Gate source；永不从 candidate workspace 读取 Gate/config。 */

import { lstat, readFile, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { canonicalDigest } from "../../protocol/v3/canonical-json.ts";
import {
	workspaceBindingDigest,
	type WorkspaceBindingRef,
} from "../../protocol/v3/workspace.ts";
import { isSafeGateRelativePath } from "../gate-loader.ts";
import type {
	TrustedGateDocument,
	TrustedGateSourcePort,
	TrustedGateSourceRequest,
	VerificationCoreResult,
} from "../types.ts";
import { pathWithin } from "../../../worktree/paths.ts";
import type { WorktreeRegistry } from "../../../worktree/registry.ts";
import type { WorktreeRecord } from "../../../worktree/types.ts";

const DEFAULT_MAX_GATE_BYTES = 1024 * 1024;

function failure<T>(
	code: "invalid_schema" | "invalid_digest" | "scope_mismatch" | "baseline_unavailable",
	message: string,
	retryable = false,
): VerificationCoreResult<T> {
	return { ok: false, error: { code, message, retryable } };
}

function runtimeBinding(record: WorktreeRecord): WorkspaceBindingRef {
	const body = {
		authorityId: record.authorityId,
		tenantId: record.tenantId,
		workspaceId: record.workspaceId,
		repositoryId: record.repositoryId,
		bindingKind: record.bindingKind,
		canonicalCwd: record.worktreePath,
		effectiveCwd: record.effectiveCwd,
		branch: record.branch,
		baseCommit: record.baseCommit,
		headCommit: record.headCommit,
	};
	return record.worktreeId ? { ...body, worktreeId: record.worktreeId } : body;
}

function recordMatchesRequest(record: WorktreeRecord, request: TrustedGateSourceRequest): boolean {
	const { baseline, policy } = request;
	return (
		record.state === "active" &&
		record.bindingKind === "readonly_checkout" &&
		record.authorityId === baseline.authorityId &&
		record.tenantId === baseline.tenantId &&
		record.workspaceId === baseline.workspaceId &&
		record.repositoryId === baseline.repositoryId &&
		record.repositoryId === policy.repositoryId &&
		record.sourceCwd === policy.protectedRoot &&
		record.baseCommit === policy.baseCommit &&
		record.headCommit === policy.baseCommit &&
		record.leaseRevision === baseline.leaseRevision &&
		record.lease?.state === "active" &&
		record.lease.workspaceId === record.workspaceId &&
		record.lease.leaseRevision === record.leaseRevision &&
		workspaceBindingDigest(runtimeBinding(record)) === baseline.bindingDigest
	);
}

async function canonicalDirectory(path: string): Promise<string | undefined> {
	try {
		const [canonical, stats] = await Promise.all([realpath(path), lstat(path)]);
		return !stats.isSymbolicLink() && stats.isDirectory() && resolve(canonical) === resolve(path)
			? resolve(canonical)
			: undefined;
	} catch {
		return undefined;
	}
}

export interface WorktreeTrustedGateSourceOptions {
	registry: WorktreeRegistry;
	maxGateBytes?: number;
}

export class WorktreeTrustedGateSource implements TrustedGateSourcePort {
	readonly #registry: WorktreeRegistry;
	readonly #maxGateBytes: number;

	public constructor(options: WorktreeTrustedGateSourceOptions) {
		if (
			options.maxGateBytes !== undefined &&
			(!Number.isSafeInteger(options.maxGateBytes) || options.maxGateBytes < 1 || options.maxGateBytes > 16 * 1024 * 1024)
		) throw new TypeError("trusted Gate max bytes is invalid");
		this.#registry = options.registry;
		this.#maxGateBytes = options.maxGateBytes ?? DEFAULT_MAX_GATE_BYTES;
	}

	public async read(request: TrustedGateSourceRequest): Promise<VerificationCoreResult<TrustedGateDocument>> {
		if (!isSafeGateRelativePath(request.protectedPath)) {
			return failure("invalid_schema", "trusted Gate path is not a safe relative path");
		}
		let loaded: Awaited<ReturnType<WorktreeRegistry["get"]>>;
		try {
			loaded = await this.#registry.get(request.baseline.workspaceId);
		} catch {
			return failure("baseline_unavailable", "trusted baseline registry is unavailable", true);
		}
		if (!loaded.ok) return failure("baseline_unavailable", "trusted baseline registry could not be verified", loaded.error.retryable);
		const record = loaded.value;
		if (!record || !recordMatchesRequest(record, request)) {
			return failure("scope_mismatch", "trusted baseline registry record does not match its materialization receipt");
		}
		const root = await canonicalDirectory(record.worktreePath);
		const effectiveRoot = await canonicalDirectory(record.effectiveCwd);
		if (!root || !effectiveRoot || !pathWithin(root, effectiveRoot)) {
			return failure("baseline_unavailable", "trusted baseline filesystem root is unavailable");
		}
		const requestedPath = resolve(join(effectiveRoot, request.protectedPath));
		if (!pathWithin(effectiveRoot, requestedPath)) {
			return failure("invalid_schema", "trusted Gate path escapes the materialized baseline");
		}
		let canonicalPath: string;
		let stats: Awaited<ReturnType<typeof lstat>>;
		try {
			[canonicalPath, stats] = await Promise.all([realpath(requestedPath), lstat(requestedPath)]);
		} catch {
			return failure("baseline_unavailable", "trusted Gate document is unavailable", true);
		}
		canonicalPath = resolve(canonicalPath);
		if (
			canonicalPath !== requestedPath ||
			!pathWithin(effectiveRoot, canonicalPath) ||
			stats.isSymbolicLink() ||
			!stats.isFile() ||
			stats.size < 1 ||
			stats.size > this.#maxGateBytes
		) return failure("baseline_unavailable", "trusted Gate document is not a bounded regular file");
		let bytes: Buffer;
		let document: unknown;
		try {
			bytes = await readFile(canonicalPath);
			if (bytes.byteLength !== stats.size || bytes.byteLength > this.#maxGateBytes) {
				return failure("baseline_unavailable", "trusted Gate document changed while reading");
			}
			document = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
		} catch {
			return failure("invalid_schema", "trusted Gate document is not valid UTF-8 JSON");
		}
		return {
			ok: true,
			value: {
				baselineReceiptDigest: request.baseline.receiptDigest,
				sourceCommit: record.headCommit,
				protectedPath: request.protectedPath,
				document,
				documentDigest: canonicalDigest(document),
			},
		};
	}
}
