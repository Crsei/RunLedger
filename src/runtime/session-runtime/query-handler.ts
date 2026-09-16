/**
 * S5 拆分:Session query router。
 *
 * 只读查询:domain/process/resources 经 domainRouter 校验后转发,recovery
 * 状态只投影 barrier;timeline 从权威 event 流截取。
 */

import type { SessionStore } from "../../storage/session-store/session-store.ts";
import type { SessionQueryRequest } from "../session-server/runtime-server.ts";
import type { RecoveryBarrier } from "./recovery-barrier.ts";
import type { SessionDomainRouter } from "./domain-router.ts";
import type { SessionId } from "../protocol/ids.ts";
import { safeJson, objectValue } from "./command-values.ts";
import type { SessionDomainPort, SessionRuntimeState } from "./session-runtime.ts";
import type { SessionLoopOperationsPort } from "./command-routes.ts";

export interface SessionQueryPort {
	readonly store: SessionStore;
	readonly sessionId: SessionId;
	readonly domain: SessionDomainPort | undefined;
	readonly domainRouter: SessionDomainRouter;
	readonly barrier: RecoveryBarrier;
	readonly state: () => SessionRuntimeState;
	readonly unresolvedAttemptsCount: () => number;
	readonly domainSnapshot: () => Record<string, unknown>;
	/** owner 侧 loop 驱动；缺省表示本 session 未启用 loop。 */
	readonly loop?: SessionLoopOperationsPort;
}

export class SessionQueryHandler {
	private readonly port: SessionQueryPort;

	public constructor(port: SessionQueryPort) {
		this.port = port;
	}

	public async handleQuery(request: SessionQueryRequest): Promise<Record<string, unknown>> {
		switch (request.kind) {
			case "domain_query": {
					const operation = typeof request.body.operation === "string" ? request.body.operation : "unknown";
					const loop = this.port.loop;
					if (loop !== undefined && loop.operationManifest.some((entry) => entry.operation === operation && entry.access === "read")) {
						return loop.query(operation, objectValue(request.body.payload) ?? {}, {
							correlationId: String(request.body.correlationId),
							effectId: String(request.body.effectId),
						});
					}
					const trajectory = this.port.domain?.trajectory;
					if (trajectory?.operationManifest.some((entry) => entry.operation === operation)) {
						const validated = this.port.domainRouter.query(request.body);
						if (validated.status !== "unavailable" || validated.code !== "operation_unavailable") return validated;
						return trajectory.query(operation, objectValue(request.body.payload) ?? {});
					}
					const multiAgent = this.port.domain?.multiAgent;
					if (multiAgent !== undefined && multiAgent.operationManifest.some((entry) => entry.operation === operation)) {
						const validated = this.port.domainRouter.query(request.body);
						if (validated.status !== "unavailable" || validated.code !== "operation_unavailable") return validated;
						return multiAgent.query(
							operation,
							objectValue(request.body.payload) ?? {},
							{ correlationId: String(request.body.correlationId), effectId: String(request.body.effectId) },
						);
					}
					const process = this.port.domain?.process;
				if (process !== undefined && process.operationManifest.some((entry) => entry.operation === operation)) {
					const validated = this.port.domainRouter.query(request.body);
					if (validated.status !== "unavailable" || validated.code !== "operation_unavailable") return validated;
					return process.query(
						operation,
						objectValue(request.body.payload) ?? {},
						{
							correlationId: String(request.body.correlationId),
							effectId: String(request.body.effectId),
						},
						);
					}
					const resources = this.port.domain?.resources;
					if (resources !== undefined && resources.operationManifest.some((entry) => entry.operation === operation && entry.access === "read")) {
						const validated = this.port.domainRouter.query(request.body);
						if (validated.status !== "unavailable" || validated.code !== "operation_unavailable") return validated;
						return resources.query(
							operation,
							objectValue(request.body.payload) ?? {},
							{
								correlationId: String(request.body.correlationId),
								effectId: String(request.body.effectId),
							},
						);
					}
					return this.port.domainRouter.query(request.body);
			}
			case "snapshot":
				return this.port.domainSnapshot();
			case "timeline":
				{
					const requestedLimit = Number(request.body.limit ?? 100);
					const limit = Number.isSafeInteger(requestedLimit) ? Math.min(1_000, Math.max(1, requestedLimit)) : 100;
					const events = this.port.store.replaySessionEvents(this.port.sessionId);
				return {
					ok: true,
					kind: "timeline",
					events: events.slice(-limit).map((event) => ({
						sequence: event.sequence,
						eventId: event.eventId,
						eventType: event.eventType,
						payload: safeJson(event.payloadJson),
					})),
				};
				}
			case "receipts":
				return {
					ok: true,
					kind: "receipts",
					receipts: this.port.store.listAllAttemptReceipts(this.port.sessionId).map((receipt) => ({
						attemptId: receipt.attemptId,
						commandId: receipt.commandId,
						outcome: receipt.outcome,
						effectClass: receipt.effectClass,
						originGeneration: receipt.originGeneration,
						settledGeneration: receipt.settledGeneration,
					})),
				};
			case "recovery_status":
				return {
					ok: true,
					kind: "recovery_status",
					state: this.port.state(),
					barrierState: this.port.barrier.currentState,
					unresolvedAttempts: this.port.unresolvedAttemptsCount(),
					sideEffectSpawnCount: this.port.barrier.sideEffectSpawnCount,
				};
			default:
				return { ok: false, kind: request.kind, code: "unknown_query" };
		}
	}
}
