/** Canonical user-home approval receipt store owned by the resident Host. */

import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
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
} from "../../runtime/contracts/public.ts";
import type { ApprovalStateStorePort } from "../../security/permission/approval-coordinator.ts";
import type { SecurityResult } from "../../security/types.ts";

export interface JsonApprovalStateStoreOptions {
	readonly layout: RunledgerLayout;
	readonly workspaceStorageKey: string;
}

function failure(message: string): SecurityResult<never> {
	return { ok: false, error: { code: "approval_stale", message, retryable: false } };
}

export class JsonApprovalStateStore implements ApprovalStateStorePort {
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
				const value: unknown = JSON.parse(await readFile(this.#path(approvalId), "utf8"));
				if (!isApprovalReceiptRef(value)) throw new Error("approval receipt failed current-format validation");
				return structuredClone(value);
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
				const value: unknown = JSON.parse(await readFile(this.#path(receipt.approvalId), "utf8"));
				if (!isApprovalReceiptRef(value)) return failure("stored approval receipt failed current-format validation");
				current = value;
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
				await this.#write(receipt);
				return { ok: true, value: structuredClone(receipt) };
			} catch {
				return failure("approval receipt could not be made durable");
			}
		});
	}

	#path(approvalId: ApprovalId): string {
		if (!/^approval_[A-Za-z0-9._~-]{1,128}$/u.test(approvalId)) throw new Error("approval id is invalid");
		return join(this.#root, `${approvalId}.json`);
	}

	async #write(receipt: ApprovalReceiptRef): Promise<void> {
		await mkdir(this.#root, { recursive: true, mode: RUNLEDGER_DIRECTORY_MODE });
		const target = this.#path(receipt.approvalId);
		const temporary = join(this.#root, `.receipt-${randomUUID()}.tmp`);
		const encoded = `${canonicalJson(receipt)}\n`;
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

function isNotFound(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
