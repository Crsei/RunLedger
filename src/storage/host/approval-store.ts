/** Canonical user-home approval receipt store owned by the resident Host. */

import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { canonicalJson } from "../../runtime/protocol/canonical-json.ts";
import {
	isApprovalReceiptRef,
	isContainedRuntimePath,
	RUNLEDGER_DIRECTORY_MODE,
	RUNLEDGER_FILE_MODE,
	type ApprovalId,
	type ApprovalReceiptRef,
	type RunledgerLayout,
	type RuntimeDigest,
	type SessionId,
} from "../../runtime/contracts/public.ts";
import type {
	ApprovalAmendmentStateStorePort,
	ExecPrefixApproval,
	NetworkApprovalRule,
	NetworkRuleApproval,
} from "../../security/permission/approval-coordinator.ts";
import { execPrefixRuleMatches, type ExecPrefixRule } from "../../security/permission/exec-prefix-rule.ts";
import type { NetworkApprovalKey } from "../../security/network/network-approval.ts";
import type { SecurityResult } from "../../security/types.ts";

export interface JsonApprovalStateStoreOptions {
	readonly layout: RunledgerLayout;
	readonly workspaceStorageKey: string;
}

function failure(message: string): SecurityResult<never> {
	return { ok: false, error: { code: "approval_stale", message, retryable: false } };
}

interface StoredApprovalRecord {
	readonly version: 1;
	readonly receipt: ApprovalReceiptRef;
	readonly execPrefixRule?: ExecPrefixRule;
	readonly networkRule?: NetworkApprovalRule;
}

export class JsonApprovalStateStore implements ApprovalAmendmentStateStorePort {
	readonly #root: string;
	readonly #tails = new Map<string, Promise<void>>();

	public constructor(options: JsonApprovalStateStoreOptions) {
		if (!/^ws-[a-f0-9]{64}$/u.test(options.workspaceStorageKey)) throw new Error("invalid approval workspace storage key");
		const home = resolve(options.layout.home);
		const root = resolve(join(options.layout.state, "hosts", options.workspaceStorageKey, "approvals"));
		if (!isContainedRuntimePath(home, root, "posix")) throw new Error("approval store must remain under the injected runledgerHome");
		this.#root = root;
	}

	public read(approvalId: ApprovalId): Promise<ApprovalReceiptRef | undefined> {
		return this.#serial(approvalId, async () => {
			try {
				return structuredClone((await this.#readRecord(approvalId)).receipt);
			} catch (error) {
				if (isNotFound(error)) return undefined;
				throw error;
			}
		});
	}

	public commit(receipt: ApprovalReceiptRef, expectedRevision: number): Promise<SecurityResult<ApprovalReceiptRef>> {
		return this.#serial(receipt.approvalId, async () => {
			if (!isApprovalReceiptRef(receipt) || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
				return failure("approval receipt failed current-format validation");
			}
			let current: ApprovalReceiptRef | undefined;
			try {
				current = (await this.#readRecord(receipt.approvalId)).receipt;
			} catch (error) {
				if (!isNotFound(error)) return failure("stored approval receipt is unavailable");
			}
			const currentRevision = current?.decisionRevision ?? 0;
			if (currentRevision !== expectedRevision || receipt.decisionRevision !== expectedRevision + 1) return failure("approval receipt CAS conflict");
			if (current && (
				current.requestDigest.digest !== receipt.requestDigest.digest ||
				current.scope !== receipt.scope ||
				current.principalId !== receipt.principalId
			)) return failure("approval receipt binding changed");
			try {
				const existing = await this.#readRecord(receipt.approvalId).catch((error: unknown) => isNotFound(error) ? undefined : Promise.reject(error));
				await this.#write({
					version: 1,
					receipt,
					...(existing?.execPrefixRule === undefined ? {} : { execPrefixRule: existing.execPrefixRule }),
					...(existing?.networkRule === undefined ? {} : { networkRule: existing.networkRule }),
				});
				return { ok: true, value: structuredClone(receipt) };
			} catch {
				return failure("approval receipt could not be made durable");
			}
		});
	}

	public async findExecPrefixApproval(input: { readonly sessionId: SessionId; readonly policyDigest: RuntimeDigest; readonly command: string }): Promise<ExecPrefixApproval | undefined> {
		let names: string[];
		try {
			names = await readdir(this.#root);
		} catch (error) {
			if (isNotFound(error)) return undefined;
			throw error;
		}
		for (const name of names.sort()) {
			if (!name.startsWith("approval_") || !name.endsWith(".json")) continue;
			const approvalId = name.slice(0, -5) as ApprovalId;
			const record = await this.#readRecord(approvalId);
			if (record.execPrefixRule !== undefined && record.receipt.decision === "allowed" &&
				execPrefixRuleMatches(record.execPrefixRule, input.command, input.sessionId, input.policyDigest)) {
				return structuredClone({ receipt: record.receipt, rule: record.execPrefixRule });
			}
		}
		return undefined;
	}

	public commitWithExecPrefixRule(receipt: ApprovalReceiptRef, expectedRevision: number, rule: ExecPrefixRule): Promise<SecurityResult<ExecPrefixApproval>> {
		return this.#serial(receipt.approvalId, async () => {
			if (!isApprovalReceiptRef(receipt) || !validExecPrefixRule(rule) || receipt.scope !== "session" || receipt.decision !== "allowed") {
				return failure("approval amendment failed current-format validation");
			}
			let current: ApprovalReceiptRef | undefined;
			try {
				current = (await this.#readRecord(receipt.approvalId)).receipt;
			} catch (error) {
				if (!isNotFound(error)) return failure("stored approval receipt is unavailable");
			}
			if ((current?.decisionRevision ?? 0) !== expectedRevision || receipt.decisionRevision !== expectedRevision + 1) return failure("approval receipt CAS conflict");
			try {
				const record: StoredApprovalRecord = { version: 1, receipt, execPrefixRule: rule };
				await this.#write(record);
				return { ok: true, value: structuredClone({ receipt, rule }) };
			} catch {
				return failure("approval amendment could not be made durable");
			}
		});
	}

	public async findNetworkApproval(input: { readonly sessionId: SessionId; readonly policyDigest: RuntimeDigest; readonly key: NetworkApprovalKey }): Promise<NetworkRuleApproval | undefined> {
		let names: string[];
		try { names = await readdir(this.#root); } catch (error) { if (isNotFound(error)) return undefined; throw error; }
		for (const name of names.sort()) {
			if (!name.startsWith("approval_") || !name.endsWith(".json")) continue;
			const record = await this.#readRecord(name.slice(0, -5) as ApprovalId);
			const rule = record.networkRule;
			if (rule !== undefined && record.receipt.decision === "allowed" && rule.sessionId === input.sessionId &&
				rule.policyDigest.digest === input.policyDigest.digest && sameNetworkKey(rule.key, input.key)) {
				return structuredClone({ receipt: record.receipt, rule });
			}
		}
		return undefined;
	}

	public commitWithNetworkRule(receipt: ApprovalReceiptRef, expectedRevision: number, rule: NetworkApprovalRule): Promise<SecurityResult<NetworkRuleApproval>> {
		return this.#serial(receipt.approvalId, async () => {
			if (!isApprovalReceiptRef(receipt) || !validNetworkRule(rule) || receipt.scope !== "session" || receipt.decision !== "allowed") return failure("network amendment failed current-format validation");
			let current: ApprovalReceiptRef | undefined;
			try { current = (await this.#readRecord(receipt.approvalId)).receipt; } catch (error) { if (!isNotFound(error)) return failure("stored approval receipt is unavailable"); }
			if ((current?.decisionRevision ?? 0) !== expectedRevision || receipt.decisionRevision !== expectedRevision + 1) return failure("approval receipt CAS conflict");
			try {
				await this.#write({ version: 1, receipt, networkRule: rule });
				return { ok: true, value: structuredClone({ receipt, rule }) };
			} catch {
				return failure("network amendment could not be made durable");
			}
		});
	}

	#path(approvalId: ApprovalId): string {
		if (!/^approval_[A-Za-z0-9._~-]{1,128}$/u.test(approvalId)) throw new Error("approval id is invalid");
		return join(this.#root, `${approvalId}.json`);
	}

	async #readRecord(approvalId: ApprovalId): Promise<StoredApprovalRecord> {
		const value: unknown = JSON.parse(await readFile(this.#path(approvalId), "utf8"));
		if (isApprovalReceiptRef(value)) return { version: 1, receipt: value };
		if (!isStoredApprovalRecord(value)) throw new Error("approval record failed current-format validation");
		return value;
	}

	async #write(record: StoredApprovalRecord): Promise<void> {
		await mkdir(this.#root, { recursive: true, mode: RUNLEDGER_DIRECTORY_MODE });
		const target = this.#path(record.receipt.approvalId);
		const temporary = join(this.#root, `.receipt-${randomUUID()}.tmp`);
		const encoded = `${canonicalJson(record)}\n`;
		try {
			await writeFile(temporary, encoded, { encoding: "utf8", mode: RUNLEDGER_FILE_MODE });
			const handle = await open(temporary, "r+");
			try {
				await handle.sync();
			} finally {
				await handle.close();
			}
			await rename(temporary, target);
			await chmod(target, RUNLEDGER_FILE_MODE);
		} finally {
			await unlink(temporary).catch(() => undefined);
		}
	}

	async #serial<T>(key: string, operation: () => Promise<T>): Promise<T> {
		const previous = this.#tails.get(key) ?? Promise.resolve();
		let release!: () => void;
		const next = new Promise<void>((resolveNext) => { release = resolveNext; });
		this.#tails.set(key, previous.then(() => next));
		await previous;
		try {
			return await operation();
		} finally {
			release();
		}
	}
}

function isStoredApprovalRecord(value: unknown): value is StoredApprovalRecord {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const record = value as Readonly<Record<string, unknown>>;
	return record.version === 1 && isApprovalReceiptRef(record.receipt) &&
		(record.execPrefixRule === undefined || validExecPrefixRule(record.execPrefixRule)) &&
		(record.networkRule === undefined || validNetworkRule(record.networkRule));
}

function validExecPrefixRule(value: unknown): value is ExecPrefixRule {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const rule = value as Readonly<Record<string, unknown>>;
	return typeof rule.sessionId === "string" && /^session_[A-Za-z0-9._~-]{1,128}$/u.test(rule.sessionId) &&
		typeof rule.policyDigest === "object" && rule.policyDigest !== null &&
		(rule.policyDigest as Readonly<Record<string, unknown>>).algorithm === "sha256" &&
		typeof (rule.policyDigest as Readonly<Record<string, unknown>>).digest === "string" &&
		/^[a-f0-9]{64}$/u.test((rule.policyDigest as Readonly<Record<string, unknown>>).digest as string) &&
		Array.isArray(rule.prefix) && rule.prefix.length > 0 && rule.prefix.length <= 64 &&
		rule.prefix.every((token) => typeof token === "string" && /^[A-Za-z0-9_./:@%+=,-]+$/u.test(token));
}

function validNetworkRule(value: unknown): value is NetworkApprovalRule {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const rule = value as Readonly<Record<string, unknown>>;
	if (typeof rule.sessionId !== "string" || !/^session_[A-Za-z0-9._~-]{1,128}$/u.test(rule.sessionId)) return false;
	if (typeof rule.policyDigest !== "object" || rule.policyDigest === null || (rule.policyDigest as Readonly<Record<string, unknown>>).algorithm !== "sha256" ||
		typeof (rule.policyDigest as Readonly<Record<string, unknown>>).digest !== "string" || !/^[a-f0-9]{64}$/u.test((rule.policyDigest as Readonly<Record<string, unknown>>).digest as string)) return false;
	if (typeof rule.key !== "object" || rule.key === null || Array.isArray(rule.key)) return false;
	const key = rule.key as Readonly<Record<string, unknown>>;
	return typeof key.host === "string" && (key.protocol === "http" || key.protocol === "https" || key.protocol === "socks5-tcp" || key.protocol === "socks5-udp") &&
		Number.isSafeInteger(key.port) && (key.port as number) >= 1 && (key.port as number) <= 65_535;
}

function sameNetworkKey(left: NetworkApprovalKey, right: NetworkApprovalKey): boolean {
	return left.host === right.host && left.protocol === right.protocol && left.port === right.port;
}

function isNotFound(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
