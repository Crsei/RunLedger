/**
 * Extension 到 Runtime Resource contract 的单向、无副作用门面。
 *
 * 这里的 port 只做 Host-owned contract gate；真实 manager/pipeline 仍由各
 * 专项注入。该文件不创建进程、不访问网络，也不保存 durable truth。
 */

import { canonicalJson } from "../../runtime/protocol/canonical-json.ts";
import { isAdapterPortResult } from "../../runtime/contracts/port-schemas.ts";
import type {
	AdapterPortRequest,
	AdapterPortResult,
	RuntimeResourceCatalogPort,
	RuntimeResourceInvocationPort,
	RuntimeResourceSnapshotPort,
} from "../../runtime/contracts/ports.ts";
import type { IdentityContext } from "../../runtime/identity/types.ts";
import type { RuntimeContentRef, RuntimeDigest } from "../../runtime/protocol/foundation.ts";
import { runtimeDigest } from "../../runtime/protocol/foundation.ts";
import type { CommandId, ResourceId, SnapshotId, TraceId } from "../../runtime/protocol/ids.ts";
import type { ResourceIdentity, RuntimeToolInvocation } from "../../runtime/resources/types.ts";

export const DEFAULT_EXTENSION_ADAPTER_INPUT_BYTES = 64 * 1024;

export interface RuntimeExtensionResourcePorts {
	readonly catalog?: RuntimeResourceCatalogPort;
	readonly snapshot?: RuntimeResourceSnapshotPort;
	readonly invocation?: RuntimeResourceInvocationPort;
}

export type ExtensionAdapterErrorCode =
	| "invalid_input"
	| "invalid_request"
	| "unavailable"
	| "unknown_effect"
	| "authorization_denied"
	| "not_found"
	| "ambiguous"
	| "blocked"
	| "stale"
	| "cancelled"
	| "unsupported"
	| "execution_failed"
	| "oversized";

export interface ExtensionAdapterError {
	readonly code: ExtensionAdapterErrorCode;
	readonly message: string;
	readonly retryable: boolean;
	readonly candidates?: readonly string[];
}

export interface ExtensionAdapterRequestBase {
	readonly identity: IdentityContext;
	readonly deadline: string;
	readonly invocation: RuntimeToolInvocation;
	readonly signal?: AbortSignal;
}

export interface BoundedCanonicalInput {
	readonly value: unknown;
	readonly digest: RuntimeDigest;
	readonly bytes: number;
}

export type BoundedCanonicalInputResult =
	| { readonly ok: true; readonly value: BoundedCanonicalInput }
	| { readonly ok: false; readonly error: ExtensionAdapterError; readonly digest: RuntimeDigest; readonly bytes: number };

export type ResourcePortGateResult =
	| { readonly ok: true; readonly outputDigest: RuntimeDigest; readonly receiptRef?: RuntimeContentRef }
	| { readonly ok: false; readonly error: ExtensionAdapterError; readonly outputDigest: RuntimeDigest };

export interface ExtensionAdapterSuccess<T> {
	readonly ok: true;
	readonly value: T;
	readonly audit: import("./runtime-audit-adapter.ts").ExtensionInvocationAudit;
	readonly auditDigest: RuntimeDigest;
}

export interface ExtensionAdapterFailure {
	readonly ok: false;
	readonly error: ExtensionAdapterError;
	readonly audit: import("./runtime-audit-adapter.ts").ExtensionInvocationAudit;
	readonly auditDigest: RuntimeDigest;
}

export type ExtensionAdapterResult<T> = ExtensionAdapterSuccess<T> | ExtensionAdapterFailure;

export function boundedCanonicalInput(input: unknown, maxBytes = DEFAULT_EXTENSION_ADAPTER_INPUT_BYTES): BoundedCanonicalInputResult {
	const digest = digestOrFallback(input);
	let encoded: string;
	try {
		encoded = canonicalJson(input);
	} catch {
		return {
			ok: false,
			error: { code: "invalid_input", message: "extension input is not canonical JSON", retryable: false },
			digest,
			bytes: 0,
		};
	}
	const bytes = Buffer.byteLength(encoded, "utf8");
	if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || bytes > maxBytes) {
		return {
			ok: false,
			error: { code: "oversized", message: "extension input exceeds the adapter byte bound", retryable: false },
			digest,
			bytes,
		};
	}
	return { ok: true, value: { value: input, digest, bytes } };
}

export function digestOrFallback(value: unknown): RuntimeDigest {
	try {
		return runtimeDigest(value);
	} catch {
		return runtimeDigest({ unavailable: "non-canonical-input" });
	}
}

export function sameResourceIdentity(left: ResourceIdentity, right: ResourceIdentity): boolean {
	return (
		left.resourceId === right.resourceId &&
		left.kind === right.kind &&
		left.qualifiedId === right.qualifiedId &&
		left.version === right.version &&
		left.source === right.source &&
		left.digest.digest === right.digest.digest
	);
}

function portError(code: ExtensionAdapterErrorCode, message: string, retryable: boolean): ExtensionAdapterError {
	return { code, message, retryable };
}

function inspectPortResult(
	response: unknown,
	expected: { readonly port: "resource_catalog" | "resource_invocation"; readonly action: "resolve" | "invoke"; readonly requestId: CommandId },
): ResourcePortGateResult {
	if (!isAdapterPortResult(response)) {
		return { ok: false, error: portError("unknown_effect", "resource port returned an unknown result effect", false), outputDigest: runtimeDigest("unknown-resource-port-result") };
	}
	if (response.port !== expected.port || response.action !== expected.action || response.requestId !== expected.requestId) {
		return { ok: false, error: portError("unknown_effect", "resource port result did not bind to the request", false), outputDigest: response.outputDigest };
	}
	switch (response.outcome) {
		case "ok":
			if (response.effect !== "accepted" && response.effect !== "terminal") {
				return { ok: false, error: portError("unknown_effect", "resource port returned an unsupported effect", false), outputDigest: response.outputDigest };
			}
			return { ok: true, outputDigest: response.outputDigest, ...(response.receiptRef ? { receiptRef: response.receiptRef } : {}) };
		case "denied":
			return { ok: false, error: portError("authorization_denied", "resource invocation was denied", false), outputDigest: response.outputDigest };
		case "cancelled":
			return { ok: false, error: portError("cancelled", "resource invocation was cancelled", false), outputDigest: response.outputDigest };
		case "unsupported":
			return { ok: false, error: portError("unsupported", "resource port does not support this operation", false), outputDigest: response.outputDigest };
		case "unavailable":
		case "uncertain":
			return { ok: false, error: portError("unavailable", "resource port is unavailable", true), outputDigest: response.outputDigest };
		case "conflict":
			return { ok: false, error: portError("unavailable", "resource port rejected the current resource revision", false), outputDigest: response.outputDigest };
	}
}

function adapterRequestBase(args: {
	readonly port: "resource_catalog" | "resource_invocation";
	readonly action: "resolve" | "invoke";
	readonly identity: IdentityContext;
	readonly requestId: CommandId;
	readonly traceId: TraceId;
	readonly deadline: string;
	readonly inputDigest: RuntimeDigest;
	readonly inputRef?: RuntimeContentRef;
	readonly idempotencyKey: string;
}): AdapterPortRequest<"resource_catalog"> | AdapterPortRequest<"resource_invocation"> {
	return {
		port: args.port,
		action: args.action,
		requestId: args.requestId,
		identity: args.identity,
		traceId: args.traceId,
		idempotencyKey: args.idempotencyKey.slice(0, 128),
		deadline: args.deadline,
		inputDigest: args.inputDigest,
		...(args.inputRef ? { inputRef: args.inputRef } : {}),
	} as AdapterPortRequest<"resource_catalog"> | AdapterPortRequest<"resource_invocation">;
}

export async function checkResourceCatalogPort(args: {
	readonly port: RuntimeResourceCatalogPort | undefined;
	readonly identity: IdentityContext;
	readonly requestId: CommandId;
	readonly traceId: TraceId;
	readonly deadline: string;
	readonly snapshotId: SnapshotId;
	readonly resource: ResourceIdentity;
	readonly signal?: AbortSignal;
}): Promise<ResourcePortGateResult> {
	if (!args.port) return { ok: false, error: portError("unavailable", "resource catalog port is unavailable", true), outputDigest: runtimeDigest("resource-catalog-unavailable") };
	if (args.signal?.aborted) return { ok: false, error: portError("cancelled", "resource catalog resolution was cancelled", false), outputDigest: runtimeDigest("resource-catalog-cancelled") };
	const request = adapterRequestBase({
		port: "resource_catalog",
		action: "resolve",
		identity: args.identity,
		requestId: args.requestId,
		traceId: args.traceId,
		deadline: args.deadline,
		inputDigest: runtimeDigest({ resource: args.resource, snapshotId: args.snapshotId }),
		idempotencyKey: `extension:catalog:${args.requestId}`,
	});
	try {
		return inspectPortResult(await args.port.execute(request as AdapterPortRequest<"resource_catalog">), { port: "resource_catalog", action: "resolve", requestId: args.requestId });
	} catch {
		return { ok: false, error: portError("unavailable", "resource catalog port is unavailable", true), outputDigest: runtimeDigest("resource-catalog-unavailable") };
	}
}

export async function checkResourceInvocationPort(args: {
	readonly port: RuntimeResourceInvocationPort | undefined;
	readonly identity: IdentityContext;
	readonly requestId: CommandId;
	readonly traceId: TraceId;
	readonly deadline: string;
	readonly inputDigest: RuntimeDigest;
	readonly inputRef?: RuntimeContentRef;
	readonly signal?: AbortSignal;
}): Promise<ResourcePortGateResult> {
	if (!args.port) return { ok: false, error: portError("unavailable", "resource invocation port is unavailable", true), outputDigest: runtimeDigest("resource-invocation-unavailable") };
	if (args.signal?.aborted) return { ok: false, error: portError("cancelled", "resource invocation was cancelled", false), outputDigest: runtimeDigest("resource-invocation-cancelled") };
	const request = adapterRequestBase({
		port: "resource_invocation",
		action: "invoke",
		identity: args.identity,
		requestId: args.requestId,
		traceId: args.traceId,
		deadline: args.deadline,
		inputDigest: args.inputDigest,
		...(args.inputRef ? { inputRef: args.inputRef } : {}),
		idempotencyKey: `extension:invoke:${args.requestId}`,
	});
	try {
		return inspectPortResult(await args.port.execute(request as AdapterPortRequest<"resource_invocation">), { port: "resource_invocation", action: "invoke", requestId: args.requestId });
	} catch {
		return { ok: false, error: portError("unavailable", "resource invocation port is unavailable", true), outputDigest: runtimeDigest("resource-invocation-unavailable") };
	}
}

export function resourcePortRequestDigest(result: ResourcePortGateResult): RuntimeDigest {
	return result.ok ? result.outputDigest : result.outputDigest;
}

export type { RuntimeDigest, RuntimeContentRef, ResourceId, SnapshotId, TraceId };
