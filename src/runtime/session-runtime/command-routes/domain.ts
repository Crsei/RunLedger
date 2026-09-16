import type { SessionDomainResult } from "../domain-router.ts";
import { objectValue, safeJson } from "../command-values.ts";
import type { SessionCommandPort, SessionCommandRouteTable } from "../command-routes.ts";

export function createDomainCommandRoutes(port: SessionCommandPort): Pick<SessionCommandRouteTable, "domain_query" | "domain_command"> {
	return {
		domain_query: async (request) => {
			const multiAgent = port.domain?.multiAgent;
			const operation = typeof request.body.operation === "string" ? request.body.operation : "unknown";
			const loop = port.loop;
			if (loop !== undefined && loop.operationManifest.some((entry) => entry.operation === operation && entry.access === "read")) {
				return { ok: true, kind: "domain_query", result: await loop.query(operation, objectValue(request.body.payload) ?? {}, context(request.body)) };
			}
			if (multiAgent !== undefined && multiAgent.operationManifest.some((entry) => entry.operation === operation)) {
				const validated = port.domainRouter.query(request.body);
				if (validated.status !== "unavailable" || validated.code !== "operation_unavailable") {
					return { ok: true, kind: "domain_query", result: validated };
				}
				return { ok: true, kind: "domain_query", result: await multiAgent.query(operation, objectValue(request.body.payload) ?? {}, context(request.body)) };
			}
			return { ok: true, kind: "domain_query", result: port.domainRouter.query(request.body) };
		},
		domain_command: async (request, meta) => {
			const operation = typeof request.body.operation === "string" ? request.body.operation : "unknown";
			const loop = port.loop;
			if (loop !== undefined && loop.operationManifest.some((entry) => entry.operation === operation && entry.access === "mutate")) {
				if (port.state() === "recovery_required") return recoveryBlocked(operation);
				const validated = port.domainRouter.mutate(request.body, meta.isDriver);
				if (validated.status !== "unavailable" || validated.code !== "operation_unavailable") return success(validated);
				return success(await loop.mutate(operation, objectValue(request.body.payload) ?? {}, mutationContext(request.body)));
			}
			const multiAgent = port.domain?.multiAgent;
			if (multiAgent !== undefined && multiAgent.operationManifest.some((entry) => entry.operation === operation)) {
				const validated = port.domainRouter.mutate(request.body, meta.isDriver);
				if (validated.status !== "unavailable" || validated.code !== "operation_unavailable") return success(validated);
				if (port.state() === "recovery_required" && operation === "agent.spawn") return recoveryBlocked(operation);
				return success(await multiAgent.mutate(operation, objectValue(request.body.payload) ?? {}, mutationContext(request.body)));
			}
			const process = port.domain?.process;
			if (process !== undefined && process.operationManifest.some((entry) => entry.operation === operation)) {
				if (port.state() === "recovery_required") return recoveryBlocked(operation);
				const validated = port.domainRouter.mutate(request.body, meta.isDriver);
				if (validated.status !== "unavailable" || validated.code !== "operation_unavailable") return success(validated);
				return success(await process.mutate(operation, objectValue(request.body.payload) ?? {}, mutationContext(request.body)));
			}
			const resources = port.domain?.resources;
			if (resources?.mutate !== undefined && resources.operationManifest.some((entry) => entry.operation === operation && entry.access === "mutate")) {
				if (port.state() === "recovery_required") return recoveryBlocked(operation);
				const validated = port.domainRouter.mutate(request.body, meta.isDriver);
				if (validated.status !== "unavailable" || validated.code !== "operation_unavailable") return success(validated);
				const result = await resources.mutate(operation, objectValue(request.body.payload) ?? {}, mutationContext(request.body));
				if (operation === "session.security.apply" && result.ok) {
					const event = [...port.store.replaySessionEvents(port.sessionId)].reverse().find((entry) => {
						if (entry.eventType !== "session.security.update") return false;
						const record = safeJson(entry.payloadJson);
						return record.stage === "applied" && record.toRevision === result.value.appliedRevision;
					});
					if (event !== undefined) port.emit({ eventType: event.eventType, payload: safeJson(event.payloadJson), sequence: event.sequence });
				}
				return success(result);
			}
			const result = port.domainRouter.mutate(request.body, meta.isDriver);
			emitCommittedTitleMutation(port, request.body, result);
			return success(result);
		},
	};
}

function context(body: Record<string, unknown>) {
	return { correlationId: String(body.correlationId), effectId: String(body.effectId) };
}

function mutationContext(body: Record<string, unknown>) {
	return { ...context(body), expectedRevision: Number(body.expectedRevision) };
}

function success(result: SessionDomainResult) {
	return { ok: true as const, kind: "domain_command", result };
}

function recoveryBlocked(operation: string) {
	return success({ ok: false, status: "recovery_required", code: "recovery_barrier_active", operation });
}

function emitCommittedTitleMutation(port: SessionCommandPort, input: Record<string, unknown>, result: SessionDomainResult): void {
	if (input.operation !== "session.title.set" || !result.ok) return;
	try {
		const event = port.store.replaySessionEvents(port.sessionId).at(-1);
		if (event?.eventType !== "session.title_changed") return;
		port.emit({ eventType: event.eventType, payload: safeJson(event.payloadJson), sequence: event.sequence });
	} catch {
		// observer publication 失败不得重试已提交的 title mutation。
	}
}
