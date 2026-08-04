/**
 * Runtime-owned execution decision barrier。
 *
 * 该模块只冻结 spawn 前的五维决策与 receipt，不执行进程。真实 backend
 * 必须消费通过本 barrier 校验的 immutable snapshot；缺 provider、receipt
 * 或 digest 不匹配都不能被解释成 `none`。
 */

import { canonicalDigest } from "../protocol/canonical-json.ts";
import type { RuntimeDigest } from "../protocol/foundation.ts";
import type {
	AttemptId,
	AuthorityId,
	CommandId,
	ExecutionId,
	PrincipalId,
	TenantId,
	WorkspaceId,
} from "../protocol/ids.ts";

export type PermissionExecutionMode = "none" | "policy";
export type ApprovalExecutionMode = "none" | "required";
export type SandboxExecutionMode = "none" | "profile";
export type GatewayExecutionMode = "none" | "mediated";
export type ContainmentExecutionMode = "none" | "process_group" | "supervisor";

export interface ExecutionConstraintModes {
	readonly permission: PermissionExecutionMode;
	readonly approval: ApprovalExecutionMode;
	readonly sandbox: SandboxExecutionMode;
	readonly gateway: GatewayExecutionMode;
	readonly containment: ContainmentExecutionMode;
}

export interface ExecutionConstraintInput {
	readonly authorityId: AuthorityId;
	readonly tenantId: TenantId;
	readonly workspaceId: WorkspaceId;
	readonly principalId: PrincipalId;
	readonly executionId: ExecutionId;
	readonly attemptId: AttemptId;
	readonly commandId: CommandId;
	readonly requestDigest: RuntimeDigest;
	readonly policyDigest: RuntimeDigest;
	readonly modes: ExecutionConstraintModes;
}

export type ExecutionConstraintDimension = keyof ExecutionConstraintModes;
export type ExecutionConstraintDecision = "allow" | "ask" | "deny" | "not_required" | "unsupported";

export interface ExecutionConstraintReceipt {
	readonly dimension: ExecutionConstraintDimension;
	readonly mode: ExecutionConstraintModes[ExecutionConstraintDimension];
	readonly decision: ExecutionConstraintDecision;
	readonly providerId: string;
	readonly providerRevision: number;
	readonly policyDigest: RuntimeDigest;
	readonly invocationDigest: RuntimeDigest;
	readonly enforcement?: "off" | "enforced" | "degraded" | "unavailable";
	readonly route?: "direct_local" | "mediated";
	readonly settlement?: "not_requested" | "zero_members" | "unknown";
	readonly receiptDigest?: RuntimeDigest;
}

export interface ExecutionConstraintProvider<D extends ExecutionConstraintDimension = ExecutionConstraintDimension> {
	readonly decide: (
		input: ExecutionConstraintInput,
	) => ExecutionConstraintReceipt | undefined | Promise<ExecutionConstraintReceipt | undefined>;
}

export type ExecutionConstraintProviders = {
	readonly [D in ExecutionConstraintDimension]?: ExecutionConstraintProvider<D>;
};

export interface ExecutionConstraintSnapshot {
	readonly authorityId: AuthorityId;
	readonly tenantId: TenantId;
	readonly workspaceId: WorkspaceId;
	readonly principalId: PrincipalId;
	readonly executionId: ExecutionId;
	readonly attemptId: AttemptId;
	readonly commandId: CommandId;
	readonly requestDigest: RuntimeDigest;
	readonly policyDigest: RuntimeDigest;
	readonly modes: ExecutionConstraintModes;
	readonly permission: ExecutionConstraintReceipt & { readonly dimension: "permission" };
	readonly approval: ExecutionConstraintReceipt & { readonly dimension: "approval" };
	readonly sandbox: ExecutionConstraintReceipt & { readonly dimension: "sandbox" };
	readonly gateway: ExecutionConstraintReceipt & { readonly dimension: "gateway" };
	readonly containment: ExecutionConstraintReceipt & { readonly dimension: "containment" };
	readonly snapshotDigest: RuntimeDigest;
}

export type ExecutionConstraintErrorCode =
	| "constraint_provider_unavailable"
	| "constraint_receipt_invalid"
	| "constraint_denied";

export type ExecutionConstraintResult =
	| { readonly ok: true; readonly snapshot: ExecutionConstraintSnapshot }
	| {
			readonly ok: false;
			readonly code: ExecutionConstraintErrorCode;
			readonly dimension: ExecutionConstraintDimension;
	  };

const DIMENSIONS: readonly ExecutionConstraintDimension[] = [
	"permission",
	"approval",
	"sandbox",
	"gateway",
	"containment",
];

export function createBuiltinNoneExecutionDecisionProviders(): ExecutionConstraintProviders {
	return {
		permission: noneProvider("permission"),
		approval: noneProvider("approval"),
		sandbox: noneProvider("sandbox"),
		gateway: noneProvider("gateway"),
		containment: noneProvider("containment"),
	};
}

/**
 * Production local provider set. Restrictive containment is capability-gated
 * by the POSIX backend; it is never silently reinterpreted as builtin-none.
 */
export function createProductionExecutionDecisionProviders(platform: "posix" | "win32"): ExecutionConstraintProviders {
	const builtin = createBuiltinNoneExecutionDecisionProviders();
	return {
		...builtin,
		containment: {
			decide: async (input) => {
				if (input.modes.containment === "none") return builtin.containment?.decide(input);
				if (platform === "win32") return undefined;
				return createExecutionConstraintReceipt({
					dimension: "containment",
					mode: input.modes.containment,
					decision: "allow",
					providerId: `builtin-posix.${input.modes.containment}`,
					providerRevision: 1,
					policyDigest: input.policyDigest,
					invocationDigest: input.requestDigest,
					settlement: "unknown",
				});
			},
		},
	};
}

export async function evaluateExecutionConstraints(
	input: ExecutionConstraintInput,
	providers: ExecutionConstraintProviders = createBuiltinNoneExecutionDecisionProviders(),
): Promise<ExecutionConstraintResult> {
	const receipts: Partial<Record<ExecutionConstraintDimension, ExecutionConstraintReceipt>> = {};
	for (const dimension of DIMENSIONS) {
		const mode = input.modes[dimension];
		const provider = providers[dimension];
		if (!provider) return { ok: false, code: "constraint_provider_unavailable", dimension };
		let receipt: ExecutionConstraintReceipt | undefined;
		try {
			receipt = await provider.decide(input);
		} catch {
			return { ok: false, code: "constraint_provider_unavailable", dimension };
		}
		if (!receipt) return { ok: false, code: "constraint_provider_unavailable", dimension };
		if (!isReceiptBoundToInput(receipt, input, dimension, mode, false)) {
			return { ok: false, code: "constraint_receipt_invalid", dimension };
		}
		if (receipt.decision === "deny") return { ok: false, code: "constraint_denied", dimension };
		if (receipt.decision === "ask" || receipt.decision === "unsupported") {
			return { ok: false, code: "constraint_provider_unavailable", dimension };
		}
		if (!isReceiptSemanticallyValid(receipt, dimension, mode)) {
			return { ok: false, code: "constraint_receipt_invalid", dimension };
		}
		receipts[dimension] = receipt;
	}

	const snapshotBody = {
		authorityId: input.authorityId,
		tenantId: input.tenantId,
		workspaceId: input.workspaceId,
		principalId: input.principalId,
		executionId: input.executionId,
		attemptId: input.attemptId,
		commandId: input.commandId,
		requestDigest: input.requestDigest,
		policyDigest: input.policyDigest,
		modes: input.modes,
		permission: receipts.permission,
		approval: receipts.approval,
		sandbox: receipts.sandbox,
		gateway: receipts.gateway,
		containment: receipts.containment,
	};
	if (!snapshotBody.permission || !snapshotBody.approval || !snapshotBody.sandbox || !snapshotBody.gateway || !snapshotBody.containment) {
		return { ok: false, code: "constraint_receipt_invalid", dimension: "permission" };
	}
	return {
		ok: true,
		snapshot: {
			...snapshotBody,
			permission: snapshotBody.permission as ExecutionConstraintSnapshot["permission"],
			approval: snapshotBody.approval as ExecutionConstraintSnapshot["approval"],
			sandbox: snapshotBody.sandbox as ExecutionConstraintSnapshot["sandbox"],
			gateway: snapshotBody.gateway as ExecutionConstraintSnapshot["gateway"],
			containment: snapshotBody.containment as ExecutionConstraintSnapshot["containment"],
			snapshotDigest: digestOf(snapshotBody),
		},
	};
}

export function validateExecutionConstraintSnapshot(
	input: ExecutionConstraintInput,
	snapshot: ExecutionConstraintSnapshot,
): boolean {
	if (
		snapshot.authorityId !== input.authorityId ||
		snapshot.tenantId !== input.tenantId ||
		snapshot.workspaceId !== input.workspaceId ||
		snapshot.principalId !== input.principalId ||
		snapshot.executionId !== input.executionId ||
		snapshot.attemptId !== input.attemptId ||
		snapshot.commandId !== input.commandId ||
		snapshot.requestDigest.digest !== input.requestDigest.digest ||
		snapshot.policyDigest.digest !== input.policyDigest.digest ||
		canonicalDigest(snapshot.modes) !== canonicalDigest(input.modes)
	) return false;
	for (const dimension of DIMENSIONS) {
		const receipt = snapshot[dimension];
		if (!isReceiptBoundToInput(receipt, input, dimension, input.modes[dimension], true)) return false;
	}
	const { snapshotDigest: _snapshotDigest, ...body } = snapshot;
	return snapshot.snapshotDigest.digest === digestOf(body).digest;
}

function noneProvider(dimension: ExecutionConstraintDimension): ExecutionConstraintProvider {
	return {
		decide: async (input) => {
			if (input.modes[dimension] !== "none") return undefined;
			const common = {
				dimension,
				mode: input.modes[dimension],
				providerId: `builtin-none.${dimension}`,
				providerRevision: 1,
				policyDigest: input.policyDigest,
				invocationDigest: input.requestDigest,
			};
			switch (dimension) {
				case "permission":
					return withReceipt({ ...common, decision: "allow" });
				case "approval":
					return withReceipt({ ...common, decision: "not_required" });
				case "sandbox":
					return withReceipt({ ...common, decision: "not_required", enforcement: "off" });
				case "gateway":
					return withReceipt({ ...common, decision: "allow", route: "direct_local" });
				case "containment":
					return withReceipt({ ...common, decision: "not_required", settlement: "not_requested" });
			}
		},
	};
}

export function createExecutionConstraintReceipt(
	receipt: Omit<ExecutionConstraintReceipt, "receiptDigest">,
): ExecutionConstraintReceipt {
	return { ...receipt, receiptDigest: digestOf(receipt) };
}

const withReceipt = createExecutionConstraintReceipt;

function isReceiptBoundToInput(
	receipt: ExecutionConstraintReceipt,
	input: ExecutionConstraintInput,
	dimension: ExecutionConstraintDimension,
	mode: ExecutionConstraintModes[ExecutionConstraintDimension],
	includeSemantics: boolean,
): boolean {
	if (
		receipt.dimension !== dimension ||
		receipt.mode !== mode ||
		receipt.providerId.length === 0 ||
		!Number.isSafeInteger(receipt.providerRevision) ||
		receipt.providerRevision < 0 ||
		receipt.policyDigest.digest !== input.policyDigest.digest ||
		receipt.invocationDigest.digest !== input.requestDigest.digest ||
		receipt.receiptDigest === undefined
	) return false;
	const { receiptDigest: _receiptDigest, ...body } = receipt;
	return receipt.receiptDigest.digest === digestOf(body).digest && (!includeSemantics || isReceiptSemanticallyValid(receipt, dimension, mode));
}

function isReceiptSemanticallyValid(
	receipt: ExecutionConstraintReceipt,
	dimension: ExecutionConstraintDimension,
	mode: ExecutionConstraintModes[ExecutionConstraintDimension],
): boolean {
	switch (dimension) {
		case "permission":
			return receipt.decision === "allow";
		case "approval":
			return mode === "none" ? receipt.decision === "not_required" : receipt.decision === "allow";
		case "sandbox":
			return mode === "none"
				? receipt.decision === "not_required" && receipt.enforcement === "off"
				: receipt.decision === "allow" && receipt.enforcement === "enforced";
		case "gateway":
			return mode === "none"
				? receipt.decision === "allow" && receipt.route === "direct_local"
				: receipt.decision === "allow" && receipt.route === "mediated";
		case "containment":
			return mode === "none"
				? receipt.decision === "not_required" && receipt.settlement === "not_requested"
				: receipt.decision === "allow" && receipt.settlement !== undefined && receipt.settlement !== "not_requested";
	}
}

function digestOf(value: unknown): RuntimeDigest {
	return { algorithm: "sha256", digest: canonicalDigest(value) as RuntimeDigest["digest"] };
}
