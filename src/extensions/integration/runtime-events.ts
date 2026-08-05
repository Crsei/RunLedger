/** Projects bounded extension invocation audits into the shared Runtime event catalog. */

import { runtimeDigest, type RuntimeContentRef } from "../../runtime/protocol/foundation.ts";
import { createRuntimeId, type AuthorityId, type PrincipalId, type SessionId, type TenantId } from "../../runtime/protocol/ids.ts";
import type { RuntimeEventPayloadFor } from "../../runtime/protocol/events.ts";
import type { RuntimeEventAppendInput } from "../../storage/host/runtime-event-store.ts";
import type { ExtensionInvocationAudit } from "./runtime-audit-adapter.ts";

export interface ExtensionInvocationEventInput {
	readonly authorityId: AuthorityId;
	readonly tenantId: TenantId;
	readonly principalId: PrincipalId;
	readonly sessionId: SessionId;
	readonly audit: ExtensionInvocationAudit;
	readonly auditDigest: ReturnType<typeof runtimeDigest>;
}

/**
 * One invocation produces one canonical tool result event. The event keeps
 * only refs, digests and bounded metadata; extension bodies never enter the
 * Runtime event stream.
 */
export function createExtensionInvocationEvent(input: ExtensionInvocationEventInput): RuntimeEventAppendInput {
	const toolCallId = createRuntimeId("toolCall", runtimeDigest({ requestId: input.audit.requestId, auditDigest: input.auditDigest }).digest.slice(0, 48));
	const refs = invocationRefs(input.audit, input.auditDigest);
	const metadataDigest = runtimeDigest({
		kind: input.audit.kind,
		resource: input.audit.resource,
		requestId: input.audit.requestId,
		correlationId: input.audit.correlationId,
		snapshotId: input.audit.snapshotId,
		outcome: input.audit.outcome,
		originalBytes: input.audit.originalBytes,
		resultBytes: input.audit.resultBytes,
		truncated: input.audit.truncated,
		durationMs: input.audit.durationMs,
		auditDigest: input.auditDigest,
	});
	const idempotencyKey = `extension:${input.audit.kind}:${input.audit.requestId}:${input.auditDigest.digest}`;
	const base = {
		subject: { kind: "toolCall" as const, id: toolCallId },
		correlationId: input.audit.correlationId,
		idempotencyKey,
		transition: { revision: 1, previousStatus: null, nextStatus: input.audit.outcome === "ok" ? "finished" : input.audit.outcome },
		expectedRevision: 0,
		refs,
		metadataDigest,
	};
	if (input.audit.outcome === "ok") {
		const payload: RuntimeEventPayloadFor<"tool.finished"> = { ...base, effect: "committed" };
		return appendInput(input, "tool.finished", payload);
	}
	const payload: RuntimeEventPayloadFor<"tool.failed"> = {
		...base,
		effect: "none",
		reasonCode: input.audit.errorCode ?? input.audit.outcome,
	};
	return appendInput(input, "tool.failed", payload);
}

function invocationRefs(audit: ExtensionInvocationAudit, auditDigest: ReturnType<typeof runtimeDigest>): readonly RuntimeContentRef[] {
	return [
		{ subjectKind: "receipt", digest: auditDigest, mediaType: "application/vnd.runledger.extension-audit+json", size: 0 },
		{ subjectKind: "content", digest: audit.inputDigest, mediaType: "application/json", size: audit.originalBytes },
		{ subjectKind: "content", digest: audit.outputDigest, mediaType: "application/json", size: audit.resultBytes },
	];
}

function appendInput<TType extends "tool.finished" | "tool.failed">(
	input: ExtensionInvocationEventInput,
	type: TType,
	payload: RuntimeEventPayloadFor<TType>,
): RuntimeEventAppendInput {
	return {
		authorityId: input.authorityId,
		tenantId: input.tenantId,
		principalId: input.principalId,
		sessionId: input.sessionId,
		traceId: input.audit.correlationId,
		type,
		payload,
	};
}
