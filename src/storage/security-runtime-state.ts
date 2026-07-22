/** Tool attempt 与 approval terminal receipt 的私有、原子、跨进程文件存储。 */

import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import lockfile from "proper-lockfile";
import {
	isApprovalReceiptRef,
	isSandboxExecutionReceiptRef,
	type ApprovalReceiptRef,
} from "../runtime/protocol/v3/capability.ts";
import { canonicalDigest } from "../runtime/protocol/v3/canonical-json.ts";
import {
	validateApprovalStateCommit,
	type ApprovalStateStorePort,
} from "../security/permission/approval-coordinator.ts";
import type { SecurityResult } from "../security/types.ts";
import type {
	ToolExecutionAttemptRecord,
	ToolExecutionAttemptStorePort,
} from "../security/integration/tool-execution-gateway.ts";

const DIGEST = /^[a-f0-9]{64}$/u;
const SECRET_KEY = /(authorization|cookie|token|secret|password|api[_-]?key|credential|fencing)/iu;
const MAX_DEPTH = 32;
const MAX_RECORD_BYTES = 8 * 1024 * 1024;

interface StoredAttemptBody {
	schemaVersion: 1;
	kind: "tool_execution_attempt";
	grantDigest: string;
	record: ToolExecutionAttemptRecord;
}

interface StoredAttempt extends StoredAttemptBody {
	recordDigest: string;
}

interface StoredApprovalBody {
	schemaVersion: 1;
	kind: "approval_terminal";
	receipt: ApprovalReceiptRef;
}

interface StoredApproval extends StoredApprovalBody {
	recordDigest: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
	const allowed = new Set([...required, ...optional]);
	return required.every((key) => Object.hasOwn(value, key)) && Object.keys(value).every((key) => allowed.has(key));
}

function redactText(value: string): string {
	return value
		.replace(/\b(authorization\s*:\s*)(?:bearer|basic)\s+[^\s\r\n]+/giu, "$1[REDACTED_CREDENTIAL]")
		.replace(/\b(password|passwd|secret|token|api[_-]?key|client[_-]?secret)\s*[:=]\s*(["']?)[^\s,;"']+\2/giu, "$1=[REDACTED_CREDENTIAL]")
		.replace(/\b(?:sk|rk|pk|ghp|github_pat|xox[abprs])[-_][A-Za-z0-9_-]{12,}\b/gu, "[REDACTED_SECRET]")
		.replace(/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/gu, "[REDACTED_PRIVATE_KEY]");
}

function redactUnknown(value: unknown, depth = 0, key = ""): unknown {
	if (depth > MAX_DEPTH) return "[REDACTED_DEPTH_LIMIT]";
	if (SECRET_KEY.test(key)) return "[REDACTED]";
	if (typeof value === "string") return redactText(value);
	if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
	if (Array.isArray(value)) return value.map((entry) => redactUnknown(entry, depth + 1));
	if (isObject(value)) {
		return Object.fromEntries(Object.entries(value).flatMap(([entryKey, entry]) =>
			entry === undefined ? [] : [[entryKey, redactUnknown(entry, depth + 1, entryKey)]],
		));
	}
	return String(value);
}

function sanitizeAttempt(record: ToolExecutionAttemptRecord): ToolExecutionAttemptRecord {
	return redactUnknown(record) as ToolExecutionAttemptRecord;
}

function isToolResult(value: unknown): boolean {
	return isObject(value) && exactKeys(value, ["content", "details"], ["isError", "addedToolNames", "terminate"]) &&
		Array.isArray(value.content) && value.content.every((entry) => isObject(entry) && typeof entry.type === "string");
}

function isExecuteResult(value: unknown, grantDigest: string): boolean {
	if (!isObject(value) || value.grantDigest !== grantDigest || typeof value.status !== "string") return false;
	if (value.status === "completed") {
		return exactKeys(value, ["status", "grantDigest", "result"], ["sandboxReceipt"]) && isToolResult(value.result) &&
			(value.sandboxReceipt === undefined || isSandboxExecutionReceiptRef(value.sandboxReceipt));
	}
	if (value.status === "aborted") {
		return exactKeys(value, ["status", "grantDigest", "reason", "outcomeCertain"]) &&
			typeof value.reason === "string" && typeof value.outcomeCertain === "boolean";
	}
	if (value.status === "unavailable") {
		return exactKeys(value, ["status", "grantDigest", "reason", "outcomeCertain"]) &&
			typeof value.reason === "string" && value.outcomeCertain === true;
	}
	return false;
}

function isAttemptRecord(value: unknown, grantDigest: string): value is ToolExecutionAttemptRecord {
	if (!isObject(value) || typeof value.status !== "string" || !DIGEST.test(String(value.invocationDigest))) return false;
	if (value.status === "started") return exactKeys(value, ["status", "invocationDigest"]);
	if (value.status === "uncertain") {
		return exactKeys(value, ["status", "invocationDigest", "reason"]) && typeof value.reason === "string";
	}
	return value.status === "completed" && exactKeys(value, ["status", "invocationDigest", "result"]) &&
		isExecuteResult(value.result, grantDigest);
}

function storedAttempt(grantDigest: string, record: ToolExecutionAttemptRecord): StoredAttempt {
	const body: StoredAttemptBody = { schemaVersion: 1, kind: "tool_execution_attempt", grantDigest, record };
	return { ...body, recordDigest: canonicalDigest(body) };
}

function parseAttempt(raw: string, grantDigest: string): StoredAttempt {
	let value: unknown;
	try {
		value = JSON.parse(raw) as unknown;
	} catch {
		throw new Error("tool attempt state is corrupted");
	}
	if (
		!isObject(value) || !exactKeys(value, ["schemaVersion", "kind", "grantDigest", "record", "recordDigest"]) ||
		value.schemaVersion !== 1 || value.kind !== "tool_execution_attempt" || value.grantDigest !== grantDigest ||
		!DIGEST.test(String(value.recordDigest)) || !isAttemptRecord(value.record, grantDigest)
	) throw new Error("tool attempt schema, identity, or digest is corrupted");
	const parsed = storedAttempt(grantDigest, value.record);
	if (parsed.recordDigest !== value.recordDigest) throw new Error("tool attempt record digest is corrupted");
	return parsed;
}

function storedApproval(receipt: ApprovalReceiptRef): StoredApproval {
	const body: StoredApprovalBody = { schemaVersion: 1, kind: "approval_terminal", receipt };
	return { ...body, recordDigest: canonicalDigest(body) };
}

function parseApproval(raw: string, approvalId: ApprovalReceiptRef["approvalId"]): StoredApproval {
	let value: unknown;
	try {
		value = JSON.parse(raw) as unknown;
	} catch {
		throw new Error("approval terminal state is corrupted");
	}
	if (
		!isObject(value) || !exactKeys(value, ["schemaVersion", "kind", "receipt", "recordDigest"]) ||
		value.schemaVersion !== 1 || value.kind !== "approval_terminal" || !isApprovalReceiptRef(value.receipt) ||
		value.receipt.approvalId !== approvalId || !DIGEST.test(String(value.recordDigest))
	) throw new Error("approval terminal schema, identity, or digest is corrupted");
	const parsed = storedApproval(value.receipt);
	if (parsed.recordDigest !== value.recordDigest) throw new Error("approval terminal record digest is corrupted");
	return parsed;
}

function errno(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error ? String(error.code) : undefined;
}

async function syncDirectory(path: string): Promise<void> {
	const handle = await open(path, constants.O_RDONLY);
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}

class PrivateRecordDirectory {
	readonly #root: string;

	public constructor(root: string) {
		if (!isAbsolute(root) || resolve(root) !== root || root.includes("\0")) {
			throw new TypeError("private record directory must be an exact absolute path");
		}
		this.#root = root;
	}

	public get root(): string {
		return this.#root;
	}

	public async verify(): Promise<void> {
		await mkdir(this.#root, { recursive: true, mode: 0o700 });
		const stats = await lstat(this.#root);
		if (!stats.isDirectory() || stats.isSymbolicLink() || resolve(await realpath(this.#root)) !== this.#root) {
			throw new Error("private record root is not a canonical directory");
		}
		if ((stats.mode & 0o077) !== 0) {
			await chmod(this.#root, 0o700);
			const corrected = await lstat(this.#root);
			if ((corrected.mode & 0o077) !== 0) throw new Error("private record root permissions are too broad");
		}
	}

	public path(identity: string): string {
		return join(this.#root, `${canonicalDigest(identity)}.json`);
	}

	public async read(path: string): Promise<string | undefined> {
		let stats;
		try {
			stats = await lstat(path);
		} catch (error) {
			if (errno(error) === "ENOENT") return undefined;
			throw error;
		}
		if (!stats.isFile() || stats.isSymbolicLink() || (stats.mode & 0o077) !== 0 || resolve(await realpath(path)) !== path) {
			throw new Error("private record file identity or permissions changed");
		}
		const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
		try {
			const raw = await handle.readFile("utf8");
			if (Buffer.byteLength(raw, "utf8") > MAX_RECORD_BYTES) throw new Error("private record exceeds its byte bound");
			return raw;
		} finally {
			await handle.close();
		}
	}

	public async create(path: string, content: string): Promise<"created" | "exists"> {
		if (Buffer.byteLength(content, "utf8") > MAX_RECORD_BYTES) throw new Error("private record exceeds its byte bound");
		let handle;
		try {
			handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
		} catch (error) {
			if (errno(error) === "EEXIST") return "exists";
			throw error;
		}
		try {
			await handle.writeFile(content, "utf8");
			await handle.sync();
		} finally {
			await handle.close();
		}
		await syncDirectory(this.#root);
		return "created";
	}

	public async replace(path: string, content: string): Promise<void> {
		if (Buffer.byteLength(content, "utf8") > MAX_RECORD_BYTES) throw new Error("private record exceeds its byte bound");
		const temporary = join(this.#root, `.${randomUUID()}.tmp`);
		let handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
		try {
			await handle.writeFile(content, "utf8");
			await handle.sync();
		} finally {
			await handle.close();
		}
		try {
			await rename(temporary, path);
			await syncDirectory(this.#root);
		} catch (error) {
			await unlink(temporary).catch(() => undefined);
			throw error;
		}
	}

	public async lock<T>(path: string, operation: () => Promise<T>): Promise<T> {
		const release = await lockfile.lock(path, {
			realpath: true,
			stale: 30_000,
			retries: { retries: 50, minTimeout: 10, maxTimeout: 50, factor: 1 },
		});
		try {
			return await operation();
		} finally {
			await release();
		}
	}

	/** 尚未 materialize 的 identity 也必须先锁定，避免并发首写和 final-path torn create。 */
	public async lockIdentity<T>(path: string, operation: () => Promise<T>): Promise<T> {
		const release = await lockfile.lock(path, {
			realpath: false,
			stale: 30_000,
			retries: { retries: 50, minTimeout: 10, maxTimeout: 50, factor: 1 },
		});
		try {
			return await operation();
		} finally {
			await release();
		}
	}
}

export class FileToolExecutionAttemptStore implements ToolExecutionAttemptStorePort {
	readonly #records: PrivateRecordDirectory;

	public constructor(root: string) {
		this.#records = new PrivateRecordDirectory(root);
	}

	public verify(): Promise<void> {
		return this.#records.verify();
	}

	public async read(grantDigest: string): Promise<ToolExecutionAttemptRecord | undefined> {
		if (!DIGEST.test(grantDigest)) throw new Error("tool attempt grant digest is invalid");
		await this.#records.verify();
		const raw = await this.#records.read(this.#records.path(grantDigest));
		return raw === undefined ? undefined : structuredClone(parseAttempt(raw, grantDigest).record);
	}

	public async claim(grantDigest: string, invocationDigest: string): Promise<"claimed" | ToolExecutionAttemptRecord> {
		if (!DIGEST.test(grantDigest) || !DIGEST.test(invocationDigest)) throw new Error("tool attempt claim digest is invalid");
		await this.#records.verify();
		const path = this.#records.path(grantDigest);
		const record: ToolExecutionAttemptRecord = { status: "started", invocationDigest };
		if (await this.#records.create(path, JSON.stringify(storedAttempt(grantDigest, record))) === "created") return "claimed";
		const raw = await this.#records.read(path);
		if (raw === undefined) throw new Error("tool attempt claim disappeared after collision");
		return structuredClone(parseAttempt(raw, grantDigest).record);
	}

	public async complete(
		grantDigest: string,
		expectedInvocationDigest: string,
		record: ToolExecutionAttemptRecord,
	): Promise<boolean> {
		if (!DIGEST.test(grantDigest) || !DIGEST.test(expectedInvocationDigest)) return false;
		await this.#records.verify();
		const path = this.#records.path(grantDigest);
		return this.#records.lock(path, async () => {
			const raw = await this.#records.read(path);
			if (raw === undefined) return false;
			const current = parseAttempt(raw, grantDigest).record;
			if (current.status !== "started" || current.invocationDigest !== expectedInvocationDigest) return false;
			const sanitized = sanitizeAttempt(record);
			if (!isAttemptRecord(sanitized, grantDigest) || sanitized.invocationDigest !== expectedInvocationDigest) return false;
			await this.#records.replace(path, JSON.stringify(storedAttempt(grantDigest, sanitized)));
			return true;
		});
	}
}

export class FileApprovalStateStore implements ApprovalStateStorePort {
	readonly #records: PrivateRecordDirectory;

	public constructor(root: string) {
		this.#records = new PrivateRecordDirectory(root);
	}

	public verify(): Promise<void> {
		return this.#records.verify();
	}

	public async read(approvalId: ApprovalReceiptRef["approvalId"]): Promise<ApprovalReceiptRef | undefined> {
		await this.#records.verify();
		const raw = await this.#records.read(this.#records.path(approvalId));
		return raw === undefined ? undefined : structuredClone(parseApproval(raw, approvalId).receipt);
	}

	public async commit(
		receipt: ApprovalReceiptRef,
		expectedRevision: number,
	): Promise<SecurityResult<ApprovalReceiptRef>> {
		if (!isApprovalReceiptRef(receipt) || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
			return { ok: false, error: { code: "approval_stale", message: "approval decision or expected revision is invalid", retryable: false } };
		}
		await this.#records.verify();
		const path = this.#records.path(receipt.approvalId);
		return this.#records.lockIdentity(path, async () => {
			const raw = await this.#records.read(path);
			const current = raw === undefined ? undefined : parseApproval(raw, receipt.approvalId).receipt;
			const validation = validateApprovalStateCommit(current, receipt, expectedRevision);
			if (!validation.ok) return validation;
			if (validation.value === "idempotent" && current) return { ok: true, value: structuredClone(current) };
			const stored = structuredClone(receipt);
			await this.#records.replace(path, JSON.stringify(storedApproval(stored)));
			return { ok: true, value: structuredClone(stored) };
		});
	}

	public async withCurrentApproval<T>(
		receipt: ApprovalReceiptRef,
		operation: () => Promise<T>,
	): Promise<SecurityResult<T>> {
		if (!isApprovalReceiptRef(receipt) || receipt.decision !== "allowed") {
			return { ok: false, error: { code: "approval_stale", message: "approval receipt is invalid or not allowed", retryable: false } };
		}
		await this.#records.verify();
		const path = this.#records.path(receipt.approvalId);
		return this.#records.lockIdentity(path, async () => {
			const raw = await this.#records.read(path);
			const current = raw === undefined ? undefined : parseApproval(raw, receipt.approvalId).receipt;
			if (
				current === undefined || current.decision !== "allowed" ||
				current.receiptId !== receipt.receiptId ||
				current.decisionRevision !== receipt.decisionRevision ||
				current.receiptDigest !== receipt.receiptDigest
			) {
				return { ok: false, error: { code: "approval_stale", message: "approval receipt is no longer the exact current allowed revision", retryable: false } };
			}
			return { ok: true, value: await operation() };
		});
	}
}
