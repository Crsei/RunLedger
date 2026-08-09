/** Session Domain Router -> TUI session workflow 的唯一 typed adapter。 */

import type { SessionDomainMutationContext, SessionDomainRequestContext, SessionDomainResult } from "../../runtime/session-runtime/domain-router.ts";
import type { TuiPortRequest, TuiResultEnvelope } from "../application/common.ts";
import type {
	SessionCatalogItem,
	SessionCatalogResult,
	SessionTransitionResult,
} from "../sessions/types.ts";
import type { SessionCreateRequest, SessionForkRequest, SessionResumeRequest, SessionWorkflowPort } from "../sessions/port.ts";

export interface SessionDomainPortInput {
	readonly query: (operation: string, payload: Record<string, unknown>, context: SessionDomainRequestContext) => Promise<SessionDomainResult>;
	readonly command: (operation: string, payload: Record<string, unknown>, context: SessionDomainMutationContext) => Promise<SessionDomainResult>;
	readonly supports: (operation: string) => boolean;
}

export interface SessionDomainControllerInput {
	readonly supports?: (operation: string) => boolean;
	readonly authorityGeneration?: number;
	readonly querySessionDomain?: SessionDomainPortInput["query"];
	readonly commandSessionDomain?: SessionDomainPortInput["command"];
}

export function sessionAuthorityGeneration(controller: SessionDomainControllerInput | undefined): number {
	const generation = controller?.authorityGeneration;
	return typeof generation === "number" && Number.isSafeInteger(generation) && generation > 0 ? generation : 1;
}

/** controller 方法读取收敛在 adapter；InteractiveMode 不直接调用 authority。 */
export function createSessionDomainPortFromController(controller: SessionDomainControllerInput | undefined): SessionWorkflowPort | undefined {
	if (controller?.querySessionDomain === undefined || controller.commandSessionDomain === undefined || controller.supports === undefined) return undefined;
	return createSessionDomainPort({
		query: (operation, payload, requestContext) => controller.querySessionDomain!(operation, payload, requestContext),
		command: (operation, payload, requestContext) => controller.commandSessionDomain!(operation, payload, requestContext),
		supports: (operation) => controller.supports!(operation),
	});
}

export async function querySessionController(
	controller: SessionDomainControllerInput | undefined,
	operation: string,
	payload: Record<string, unknown>,
	requestContext: SessionDomainRequestContext,
): Promise<SessionDomainResult> {
	if (controller?.supports?.(operation) !== true || controller.querySessionDomain === undefined) {
		return { ok: false, status: "unavailable", code: "operation_unavailable", operation };
	}
	return controller.querySessionDomain(operation, payload, requestContext);
}

export async function commandSessionController(
	controller: SessionDomainControllerInput | undefined,
	operation: string,
	payload: Record<string, unknown>,
	requestContext: SessionDomainMutationContext,
): Promise<SessionDomainResult> {
	if (controller?.supports?.(operation) !== true || controller.commandSessionDomain === undefined) {
		return { ok: false, status: "unavailable", code: "operation_unavailable", operation };
	}
	return controller.commandSessionDomain(operation, payload, requestContext);
}

export function createSessionDomainPort(domain: SessionDomainPortInput): SessionWorkflowPort {
	return {
		list: async (request) => {
			if (!domain.supports("session.catalog.list")) return unavailable(request, "session.catalog.list");
			const result = await invoke(request, () => domain.query("session.catalog.list", {}, context(request)));
			if (!result.ok) return result;
			const items = catalogItems(result.value.items);
			if (items === undefined) return malformed(request, "session.catalog.list");
			return { ok: true, ref: request, value: { kind: "catalog", revision: result.domainRevision, items } };
		},
		create: async (request) => transition(domain, request, "session.create", "create", {}),
		resume: async (request) => transition(domain, request, "session.resume", "resume", { targetSessionId: request.targetSessionId }),
		fork: async (request) => transition(domain, request, "session.fork", "fork", {
			sourceSessionId: request.sourceSessionId,
			expectedSourceHeadSequence: request.expectedSourceHeadSequence,
		}),
	};
}

async function transition(
	domain: SessionDomainPortInput,
	request: SessionCreateRequest | SessionResumeRequest | SessionForkRequest,
	operation: "session.create" | "session.resume" | "session.fork",
	transitionOperation: SessionTransitionResult["operation"],
	payload: Record<string, unknown>,
): Promise<TuiResultEnvelope<SessionTransitionResult>> {
	if (!domain.supports(operation)) return unavailable(request, operation);
	const result = await invoke(request, () => domain.command(operation, payload, { ...context(request), expectedRevision: request.expectedRevision }));
	if (!result.ok) return result;
	const targetSessionId = stringValue(result.value.targetSessionId);
	if (targetSessionId === undefined) return malformed(request, operation);
	return {
		ok: true,
		ref: request,
		value: {
			kind: "transition",
			operation: transitionOperation,
			targetSessionId,
			catalogRevision: result.domainRevision,
			...(result.receipt === undefined ? {} : { attemptId: result.receipt.attemptId }),
		},
	};
}

async function invoke(
	request: TuiPortRequest,
	call: () => Promise<SessionDomainResult>,
): Promise<Extract<SessionDomainResult, { readonly ok: true }> | Extract<TuiResultEnvelope<never>, { readonly ok: false }>> {
	try {
		const result = await call();
		if (result.ok) return result;
		return {
			ok: false,
			ref: request,
			error: {
				code: result.code,
				message: result.code,
				retryable: result.status === "stale" || result.status === "failed",
				...(result.status === "recovery_required" ? { recoveryRequired: true } : {}),
			},
		};
	} catch (error) {
		return { ok: false, ref: request, error: { code: "session_domain_error", message: String(error), retryable: true } };
	}
}

function context(request: TuiPortRequest): SessionDomainRequestContext {
	return { correlationId: request.correlationId, effectId: request.effectId };
}

function catalogItems(value: unknown): readonly SessionCatalogItem[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const items: SessionCatalogItem[] = [];
	for (const candidate of value) {
		if (!isRecord(candidate)) return undefined;
		const sessionId = stringValue(candidate.sessionId);
		const workspaceId = stringValue(candidate.workspaceId);
		const repositoryId = stringValue(candidate.repositoryId);
		const status = stringValue(candidate.status);
		const createdAtMs = integerValue(candidate.createdAtMs);
		const updatedAtMs = integerValue(candidate.updatedAtMs);
		const headSequence = integerValue(candidate.headSequence);
		const driverRevision = integerValue(candidate.driverRevision);
		if (sessionId === undefined || workspaceId === undefined || repositoryId === undefined || status === undefined
			|| createdAtMs === undefined || updatedAtMs === undefined || headSequence === undefined || driverRevision === undefined
			|| typeof candidate.current !== "boolean") return undefined;
		items.push({ sessionId, workspaceId, repositoryId, status, createdAtMs, updatedAtMs, headSequence, driverRevision, current: candidate.current });
	}
	return items;
}

function unavailable(request: TuiPortRequest, operation: string): TuiResultEnvelope<never> {
	return { ok: false, ref: request, error: { code: "capability_unavailable", message: `${operation} is unavailable`, retryable: false } };
}

function malformed(request: TuiPortRequest, operation: string): TuiResultEnvelope<never> {
	return { ok: false, ref: request, error: { code: "session_domain_malformed", message: `${operation} returned a malformed result`, retryable: false } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function integerValue(value: unknown): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}
