/** Host final-leaf model route gate and canonical route receipt adapter. */

import { runtimeDigest, type RuntimeContentRef } from "../runtime/protocol/foundation.ts";
import { createRuntimeId } from "../runtime/protocol/ids.ts";
import type { RuntimeEventPayloadFor } from "../runtime/protocol/events.ts";
import type { RuntimeEventAppendInput, RuntimeEventWriter } from "../storage/host/runtime-event-store.ts";
import type { ModelRequestRouter } from "../runtime/interactive-session-controller.ts";
import type { ModelRouteDecision, ModelRouteRequest } from "../runtime/model-routing/types.ts";
import type { AuthorityId, PrincipalId, SessionId, TenantId, TraceId, TurnId } from "../runtime/contracts/public.ts";

export interface HostModelRequestRouterOptions {
	readonly authorityId: AuthorityId;
	readonly tenantId: TenantId;
	readonly principalId: PrincipalId;
	readonly sessionId: SessionId;
	readonly writer: RuntimeEventWriter;
	readonly router?: ModelRequestRouter;
	readonly unavailableCode?: string;
}

export function createHostModelRequestRouter(options: HostModelRequestRouterOptions): ModelRequestRouter {
	const durableDecisions = new Map<string, ModelRouteDecision>();
	return {
		route: async (request) => {
			const prior = durableDecisions.get(request.requestId);
			if (prior !== undefined) return prior;
			const decision = options.router === undefined
				? unavailableDecision(request, options.unavailableCode ?? "model_router_unavailable")
				: await options.router.route(request);
			const event = modelRoutedEvent(options, request, decision);
			try {
				await options.writer.append(event);
			} catch {
				const failed = routeFailure(request, decision, "model_route_receipt_failed");
				durableDecisions.set(request.requestId, failed);
				return failed;
			}
			durableDecisions.set(request.requestId, decision);
			return decision;
		},
	};
}

function unavailableDecision(request: ModelRouteRequest, reasonCode: string): ModelRouteDecision {
	const base: Omit<ModelRouteDecision, "decisionDigest"> = {
		requestId: request.requestId,
		outcome: "deny",
		targetProviderId: "unknown",
		targetModelId: "unknown",
		targetProfileId: request.targetProfileId,
		manifestDigest: runtimeDigest("model-compatibility-manifest-unavailable"),
		reasonCode,
		diagnostics: [{ code: reasonCode, severity: "error", message: "model compatibility route is unavailable" }],
	};
	return { ...base, decisionDigest: runtimeDigest(base) };
}

function routeFailure(request: ModelRouteRequest, decision: ModelRouteDecision, reasonCode: string): ModelRouteDecision {
	const base: Omit<ModelRouteDecision, "decisionDigest"> = {
		...decision,
		outcome: "deny",
		reasonCode,
		diagnostics: [...decision.diagnostics, { code: reasonCode, severity: "error", message: "canonical model route receipt could not be written" }],
	};
	return { ...base, decisionDigest: runtimeDigest(base) };
}

function modelRoutedEvent(options: HostModelRequestRouterOptions, request: ModelRouteRequest, decision: ModelRouteDecision): RuntimeEventAppendInput {
	const subjectId = createRuntimeId("turn", runtimeDigest({ sessionId: options.sessionId, requestId: request.requestId }).digest.slice(0, 48)) as TurnId;
	const ref: RuntimeContentRef = {
		subjectKind: "details",
		digest: decision.decisionDigest,
		mediaType: "application/vnd.runledger.model-route-decision+json",
		size: 0,
	};
	const payload: RuntimeEventPayloadFor<"model.routed"> = {
		subject: { kind: "turn", id: subjectId },
		correlationId: request.traceId,
		effect: decision.outcome === "deny" ? "none" : "committed",
		idempotencyKey: `model-route:${request.requestId}`,
		expectedRevision: 0,
		transition: { revision: 1, previousStatus: null, nextStatus: decision.outcome },
		refs: [ref],
		metadataDigest: decision.decisionDigest,
	};
	return {
		authorityId: options.authorityId,
		tenantId: options.tenantId,
		principalId: options.principalId,
		sessionId: options.sessionId,
		traceId: request.traceId,
		type: "model.routed",
		payload,
	};
}
