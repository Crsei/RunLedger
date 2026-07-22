/** Production startup 外部 receipt auditor 的 durable state-root 组合。 */

import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import type { AuthorityId, TenantId } from "../runtime/protocol/v3/ids.ts";
import { FileApprovalStateStore } from "./security-runtime-state.ts";
import { DurableStartupExternalReceiptAuditor } from "./startup-receipt-auditor.ts";
import {
	FileWorkspaceLeaseMutationPort,
	type DurableWorktreeScope,
} from "./worktree-state-adapter.ts";

export interface ProductionStartupExternalReceiptStatePaths {
	readonly stateRoot: string;
	readonly workspaceLeaseFile: string;
	readonly approvalsRoot: string;
}

interface ValidatedProductionStartupExternalReceiptStatePaths
	extends ProductionStartupExternalReceiptStatePaths {
	readonly rootDevice: number;
	readonly rootInode: number;
}

export interface ProductionStartupExternalReceiptAuditorOptions {
	readonly stateRoot: string;
	readonly authorityId: AuthorityId;
	readonly tenantId: TenantId;
	readonly clock?: () => Date;
}

function exactAbsoluteRoot(path: string): string {
	if (!isAbsolute(path) || resolve(path) !== path || path.includes("\0")) {
		throw new TypeError("production startup external receipt stateRoot must be an exact absolute path");
	}
	return path;
}

async function durableStatePaths(
	stateRoot: string,
): Promise<ValidatedProductionStartupExternalReceiptStatePaths> {
	const requested = exactAbsoluteRoot(stateRoot);
	const before = await lstat(requested);
	if (!before.isDirectory() || before.isSymbolicLink()) {
		throw new Error("production startup external receipt stateRoot must be a canonical non-symlink directory");
	}
	if ((before.mode & 0o077) !== 0) {
		throw new Error("production startup external receipt stateRoot must be a private directory");
	}
	const canonical = resolve(await realpath(requested));
	const after = await lstat(requested);
	if (
		canonical !== requested ||
		!after.isDirectory() ||
		after.isSymbolicLink() ||
		(after.mode & 0o077) !== 0 ||
		after.dev !== before.dev ||
		after.ino !== before.ino
	) {
		throw new Error("production startup external receipt stateRoot identity changed during validation");
	}
	return {
		stateRoot: canonical,
		workspaceLeaseFile: join(canonical, "workspace-leases.json"),
		approvalsRoot: join(canonical, "tool-gateway", "approvals"),
		rootDevice: after.dev,
		rootInode: after.ino,
	};
}

/**
 * 与 production workspace/tool-gateway 复用同一 durable 布局；这里只注入 read port，
 * 不创建第二份内存状态，也不持有 lease secret 的明文副本。
 */
export async function createProductionStartupExternalReceiptAuditor(
	options: ProductionStartupExternalReceiptAuditorOptions,
): Promise<DurableStartupExternalReceiptAuditor> {
	const paths = await durableStatePaths(options.stateRoot);
	const scope: DurableWorktreeScope = {
		authorityId: options.authorityId,
		tenantId: options.tenantId,
	};
	const workspaceLeaseStore = new FileWorkspaceLeaseMutationPort(paths.workspaceLeaseFile, scope);
	const approvalStore = new FileApprovalStateStore(paths.approvalsRoot);
	await Promise.all([
		workspaceLeaseStore.verify(),
		approvalStore.verify(),
	]);
	const stable = await durableStatePaths(paths.stateRoot);
	if (
		stable.workspaceLeaseFile !== paths.workspaceLeaseFile ||
		stable.approvalsRoot !== paths.approvalsRoot ||
		stable.rootDevice !== paths.rootDevice ||
		stable.rootInode !== paths.rootInode
	) {
		throw new Error("production startup external receipt stateRoot identity changed during store creation");
	}
	return new DurableStartupExternalReceiptAuditor({
		workspaceLeaseStore,
		approvalStore,
		...(options.clock === undefined ? {} : { clock: options.clock }),
	});
}
