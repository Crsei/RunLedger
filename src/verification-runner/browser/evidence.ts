/** Browser backend request/result 的 exact schema 与 receipt correlation。 */

import { Type, type TSchema } from "typebox";
import { Check } from "typebox/value";
import {
	SandboxExecutionReceiptRefSchema,
	isSandboxExecutionReceiptRef,
	type SandboxExecutionReceiptRef,
} from "../../runtime/protocol/v3/capability.ts";
import { canonicalDigest } from "../../runtime/protocol/v3/canonical-json.ts";
import type {
	AuthorityId,
	CommandId,
	ReceiptId,
	TenantId,
	VerificationId,
} from "../../runtime/protocol/v3/ids.ts";
import { parseRuntimeId } from "../../runtime/protocol/v3/ids.ts";
import {
	BROWSER_BACKEND_SCHEMA_VERSION,
	BrowserBackendOperationSchema,
	RestrictedBrowserProfileSchema,
	browserOperationDigest,
	isBrowserBackendOperation,
	isRestrictedBrowserProfile,
	type BrowserBackendOperation,
	type RestrictedBrowserProfile,
} from "./profile.ts";

const digest = Type.String({ pattern: "^[a-f0-9]{64}$", maxLength: 64 });
const timestamp = Type.String({
	pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{3})?Z$",
	maxLength: 24,
});
const runtimeId = (kind: string) =>
	Type.String({ pattern: `^${kind}_[A-Za-z0-9][A-Za-z0-9._~-]*$`, maxLength: 128 });
const token = Type.String({ minLength: 1, maxLength: 512 });
const exact = <T extends Record<string, TSchema>>(properties: T) =>
	Type.Object(properties, { additionalProperties: false });

export type BrowserEvidenceKind = "screenshot" | "dom_snapshot" | "console_log" | "network_trace";

export interface BrowserEvidenceHandle {
	outputName: string;
	kind: BrowserEvidenceKind;
	mediaType: string;
	contentHandleDigest: string;
	originalBytes: number;
}

export interface BrowserBackendRequest {
	schemaVersion: typeof BROWSER_BACKEND_SCHEMA_VERSION;
	authorityId: AuthorityId;
	tenantId: TenantId;
	verificationRequestId: CommandId;
	operationId: CommandId;
	verificationId: VerificationId;
	gateDigest: string;
	candidateCommit: string;
	candidateIdentityDigest: string;
	bindingDigest: string;
	profile: RestrictedBrowserProfile;
	operation: BrowserBackendOperation;
	operationDigest: string;
	workspaceValidationReceiptId: ReceiptId;
	workspaceValidationReceiptDigest: string;
	capabilityRequestDigest: string;
	capabilityDecisionDigest: string;
	sandboxReceipt: SandboxExecutionReceiptRef;
	sandboxReceiptDigest: string;
	requestDigest: string;
}

interface BrowserBackendResultBase {
	schemaVersion: typeof BROWSER_BACKEND_SCHEMA_VERSION;
	authorityId: AuthorityId;
	tenantId: TenantId;
	verificationRequestId: CommandId;
	operationId: CommandId;
	verificationId: VerificationId;
	requestDigest: string;
	operationDigest: string;
	bindingDigest: string;
	capabilityDecisionDigest: string;
	sandboxReceiptId: ReceiptId;
	sandboxReceiptDigest: string;
	backendId: string;
	backendIdentityDigest: string;
	receiptId: ReceiptId;
	completedAt: string;
	receiptDigest: string;
}

export type BrowserBackendResult =
	| (BrowserBackendResultBase & {
			status: "completed";
			output?: BrowserEvidenceHandle;
	  })
	| (BrowserBackendResultBase & {
			status: "denied";
			reasonCode: string;
			reasonDigest: string;
	  })
	| (BrowserBackendResultBase & {
			status: "unsupported";
			reasonCode: string;
			reasonDigest: string;
	  });

const BrowserEvidenceHandleSchema = exact({
	outputName: token,
	kind: Type.Union([
		Type.Literal("screenshot"),
		Type.Literal("dom_snapshot"),
		Type.Literal("console_log"),
		Type.Literal("network_trace"),
	]),
	mediaType: Type.String({ minLength: 1, maxLength: 256 }),
	contentHandleDigest: digest,
	originalBytes: Type.Integer({ minimum: 0, maximum: 128 * 1024 * 1024 }),
});

export const BrowserBackendRequestSchema = exact({
	schemaVersion: Type.Literal(BROWSER_BACKEND_SCHEMA_VERSION),
	authorityId: runtimeId("authority"),
	tenantId: runtimeId("tenant"),
	verificationRequestId: runtimeId("command"),
	operationId: runtimeId("command"),
	verificationId: runtimeId("verification"),
	gateDigest: digest,
	candidateCommit: token,
	candidateIdentityDigest: digest,
	bindingDigest: digest,
	profile: RestrictedBrowserProfileSchema,
	operation: BrowserBackendOperationSchema,
	operationDigest: digest,
	workspaceValidationReceiptId: runtimeId("receipt"),
	workspaceValidationReceiptDigest: digest,
	capabilityRequestDigest: digest,
	capabilityDecisionDigest: digest,
	sandboxReceipt: SandboxExecutionReceiptRefSchema,
	sandboxReceiptDigest: digest,
	requestDigest: digest,
});

const backendResultBase = {
	schemaVersion: Type.Literal(BROWSER_BACKEND_SCHEMA_VERSION),
	authorityId: runtimeId("authority"),
	tenantId: runtimeId("tenant"),
	verificationRequestId: runtimeId("command"),
	operationId: runtimeId("command"),
	verificationId: runtimeId("verification"),
	requestDigest: digest,
	operationDigest: digest,
	bindingDigest: digest,
	capabilityDecisionDigest: digest,
	sandboxReceiptId: runtimeId("receipt"),
	sandboxReceiptDigest: digest,
	backendId: token,
	backendIdentityDigest: digest,
	receiptId: runtimeId("receipt"),
	completedAt: timestamp,
	receiptDigest: digest,
} as const;

export const BrowserBackendResultSchema = Type.Union([
	exact({
		...backendResultBase,
		status: Type.Literal("completed"),
		output: Type.Optional(BrowserEvidenceHandleSchema),
	}),
	exact({
		...backendResultBase,
		status: Type.Literal("denied"),
		reasonCode: token,
		reasonDigest: digest,
	}),
	exact({
		...backendResultBase,
		status: Type.Literal("unsupported"),
		reasonCode: token,
		reasonDigest: digest,
	}),
]);

export function browserBackendRequestDigest(request: Omit<BrowserBackendRequest, "requestDigest">): string {
	return canonicalDigest(request);
}

export function browserBackendReceiptDigest(result: Omit<BrowserBackendResult, "receiptDigest">): string {
	return canonicalDigest(result);
}

export function isBrowserBackendRequest(value: unknown): value is BrowserBackendRequest {
	if (!Check(BrowserBackendRequestSchema, value)) return false;
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const request = value as Record<string, unknown>;
	const operation = request.operation;
	const profile = request.profile;
	const sandboxReceipt = request.sandboxReceipt;
	if (
		typeof request.authorityId !== "string" ||
		typeof request.tenantId !== "string" ||
		typeof request.verificationRequestId !== "string" ||
		typeof request.operationId !== "string" ||
		typeof request.verificationId !== "string" ||
		typeof request.workspaceValidationReceiptId !== "string" ||
		!parseRuntimeId("authority", request.authorityId) ||
		!parseRuntimeId("tenant", request.tenantId) ||
		!parseRuntimeId("command", request.verificationRequestId) ||
		!parseRuntimeId("command", request.operationId) ||
		!parseRuntimeId("verification", request.verificationId) ||
		!parseRuntimeId("receipt", request.workspaceValidationReceiptId) ||
		!isRestrictedBrowserProfile(profile) ||
		!isBrowserBackendOperation(operation) ||
		!isSandboxExecutionReceiptRef(sandboxReceipt)
	) return false;
	const { requestDigest, ...body } = request;
	return (
		request.operationDigest === browserOperationDigest(operation) &&
		sandboxReceipt.requestId === request.operationId &&
		sandboxReceipt.authorityId === request.authorityId &&
		sandboxReceipt.tenantId === request.tenantId &&
		request.sandboxReceiptDigest === canonicalDigest(sandboxReceipt) &&
		typeof requestDigest === "string" &&
		requestDigest === canonicalDigest(body)
	);
}

export function isBrowserBackendResult(value: unknown): value is BrowserBackendResult {
	if (!Check(BrowserBackendResultSchema, value)) return false;
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const result = value as Record<string, unknown>;
	if (
		typeof result.authorityId !== "string" ||
		typeof result.tenantId !== "string" ||
		typeof result.verificationRequestId !== "string" ||
		typeof result.operationId !== "string" ||
		typeof result.verificationId !== "string" ||
		typeof result.sandboxReceiptId !== "string" ||
		typeof result.receiptId !== "string" ||
		!parseRuntimeId("authority", result.authorityId) ||
		!parseRuntimeId("tenant", result.tenantId) ||
		!parseRuntimeId("command", result.verificationRequestId) ||
		!parseRuntimeId("command", result.operationId) ||
		!parseRuntimeId("verification", result.verificationId) ||
		!parseRuntimeId("receipt", result.sandboxReceiptId) ||
		!parseRuntimeId("receipt", result.receiptId)
	) return false;
	const { receiptDigest, ...body } = result;
	return typeof receiptDigest === "string" && receiptDigest === canonicalDigest(body);
}

function expectedEvidenceKind(operation: BrowserBackendOperation): BrowserEvidenceKind | undefined {
	switch (operation.kind) {
		case "screenshot":
			return "screenshot";
		case "dom_read":
			return "dom_snapshot";
		case "console_read":
			return "console_log";
		case "network_evidence":
			return "network_trace";
		default:
			return undefined;
	}
}

export function browserBackendResultMatchesRequest(
	result: BrowserBackendResult,
	request: BrowserBackendRequest,
): boolean {
	if (!isBrowserBackendRequest(request) || !isBrowserBackendResult(result)) return false;
	if (
		result.authorityId !== request.authorityId ||
		result.tenantId !== request.tenantId ||
		result.verificationRequestId !== request.verificationRequestId ||
		result.operationId !== request.operationId ||
		result.verificationId !== request.verificationId ||
		result.requestDigest !== request.requestDigest ||
		result.operationDigest !== request.operationDigest ||
		result.bindingDigest !== request.bindingDigest ||
		result.capabilityDecisionDigest !== request.capabilityDecisionDigest ||
		result.sandboxReceiptId !== request.sandboxReceipt.receiptId ||
		result.sandboxReceiptDigest !== request.sandboxReceiptDigest
	) return false;
	if (result.status !== "completed") return true;
	const expectedKind = expectedEvidenceKind(request.operation);
	if (expectedKind === undefined) return result.output === undefined;
	return (
		result.output !== undefined &&
		result.output.kind === expectedKind &&
		"outputName" in request.operation &&
		result.output.outputName === request.operation.outputName &&
		result.output.originalBytes <= request.operation.maxBytes
	);
}

/** Browser backend 只能接受已带 Workspace、Gateway 与 Sandbox correlation 的请求。 */
export interface BrowserBackendPort {
	execute(request: BrowserBackendRequest, signal?: AbortSignal): Promise<BrowserBackendResult>;
}

export interface ProductionBrowserBackendDescriptorBody {
	contractId: "runledger.production-browser-backend";
	schemaVersion: typeof BROWSER_BACKEND_SCHEMA_VERSION;
	environment: "production";
	backendId: string;
	runtimeId: string;
	runtimeVersion: string;
	adapterIdentityDigest: string;
	generation: number;
	generationDigest: string;
}

export interface ProductionBrowserBackendDescriptor
	extends ProductionBrowserBackendDescriptorBody {
	descriptorDigest: string;
}

export type ProductionBrowserBackendPreflight =
	| {
			status: "ready";
			descriptorDigest: string;
			recoveryEvidenceDigest: string;
	  }
	| {
			status: "unsupported" | "external_gap";
			reasonDigest: string;
	  };

export interface ProductionBrowserBackendPort extends BrowserBackendPort {
	readonly environment: "production";
	readonly descriptor: ProductionBrowserBackendDescriptor;
	preflight(): Promise<ProductionBrowserBackendPreflight>;
}

export function productionBrowserBackendDescriptorDigest(
	body: ProductionBrowserBackendDescriptorBody,
): string {
	return canonicalDigest(body);
}

export function isProductionBrowserBackendDescriptor(
	value: ProductionBrowserBackendDescriptor,
): boolean {
	const { descriptorDigest, ...body } = value;
	return (
		value.contractId === "runledger.production-browser-backend" &&
		value.schemaVersion === BROWSER_BACKEND_SCHEMA_VERSION &&
		value.environment === "production" &&
		value.backendId.length > 0 &&
		value.backendId.length <= 512 &&
		value.runtimeId.length > 0 &&
		value.runtimeId.length <= 512 &&
		value.runtimeVersion.length > 0 &&
		value.runtimeVersion.length <= 128 &&
		/^[a-f0-9]{64}$/u.test(value.adapterIdentityDigest) &&
		Number.isSafeInteger(value.generation) &&
		value.generation >= 1 &&
		/^[a-f0-9]{64}$/u.test(value.generationDigest) &&
		descriptorDigest === productionBrowserBackendDescriptorDigest(body)
	);
}
