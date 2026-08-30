/**
 * S3 拆分:process domain query handler(list/output/wait)。
 *
 * 只读操作不产生 mutation;validation 先于 executionId lookup
 * (output cursor / wait 参数边界),observer wait 到达 terminal 时结算
 * authorization 但不触碰 process attempt。
 */

import { SESSION_PROTOCOL_BOUNDS } from "../../session-server/protocol.ts";
import type { ProcessManager } from "../../process/manager.ts";
import type { ManagedProcessSummary } from "../../process/types.ts";
import type { ManagedProcessBackendPort, ManagedProcessControlPlane } from "../../../storage/process/control-plane.ts";
import type { ProcessOutputReadResult } from "../../../storage/process/output-store.ts";
import type { SessionDomainResult } from "../domain-router.ts";
import type { ExecutionHandleRef } from "../../process/types.ts";

/** domain 结果/载荷整形的纯 helper 集合(composition 提供实现)。 */
export interface ProcessResultShaping {
	domainSuccess(operation: string, domainRevision: number, value: Record<string, unknown>): SessionDomainResult;
	domainFailure(operation: string, status: "unavailable" | "denied" | "stale" | "failed" | "recovery_required", code: string): Extract<SessionDomainResult, { readonly ok: false }>;
	stringValue(value: unknown): string | undefined;
	integerValue(value: unknown): number | undefined;
	outputCursor(value: unknown): { readonly sequence: number; readonly byteOffset: number } | undefined;
	safeSummary(summary: ManagedProcessSummary): Record<string, unknown>;
}

export interface ProcessQueryPort extends ProcessResultShaping {
	readonly manager: ProcessManager;
	readonly plane: ManagedProcessControlPlane;
	readonly backend: ManagedProcessBackendPort;
	readonly revision: () => number;
	readonly completeAuthorization: (executionId: string) => Promise<void>;
	readonly readRecoveredOutput: (
		handle: ExecutionHandleRef,
		cursor: { readonly sequence: number; readonly byteOffset: number },
		maxBytes: number,
	) => Promise<ProcessOutputReadResult>;
}

export class ProcessQueryHandler {
	private readonly port: ProcessQueryPort;

	public constructor(port: ProcessQueryPort) {
		this.port = port;
	}

	public async query(
		operation: string,
		payload: Record<string, unknown>,
		_context: { readonly correlationId: string; readonly effectId: string },
	): Promise<SessionDomainResult> {
		if (operation === "session.process.list") {
			const items = this.port.manager.handles().flatMap((handle) => {
				const result = this.port.manager.query(handle);
				return result.ok ? [this.port.safeSummary(result.summary)] : [];
			});
			return this.port.domainSuccess(operation, this.port.revision(), { items });
		}
		if (operation === "session.process.output") {
			const executionId = this.port.stringValue(payload.executionId);
			const cursor = this.port.outputCursor(payload.cursor);
			const maxBytes = this.port.integerValue(payload.maxBytes);
			if (executionId === undefined || cursor === undefined || maxBytes === undefined || maxBytes < 0 || maxBytes > SESSION_PROTOCOL_BOUNDS.maxOutputPageBytes) {
				return this.port.domainFailure(operation, "failed", "invalid_process_output_request");
			}
			const handle = this.findHandle(executionId);
			if (handle === undefined) return this.port.domainFailure(operation, "unavailable", "process_not_found");
			const result = this.port.backend.control(handle) === undefined
				? await this.port.readRecoveredOutput(handle, cursor, maxBytes)
				: await this.port.plane.processOutput(handle, cursor, maxBytes);
			if (!result.ok) return this.port.domainFailure(operation, "failed", result.code);
			return this.port.domainSuccess(operation, this.port.revision(), {
				executionId,
				text: result.page.text,
				startCursor: result.page.startCursor,
				endCursor: result.page.endCursor,
				nextCursor: result.page.nextCursor,
				truncated: result.page.truncated,
				head: result.head,
			});
		}
		if (operation === "session.process.wait") {
			const executionId = this.port.stringValue(payload.executionId);
			const timeoutMs = this.port.integerValue(payload.timeoutMs);
			if (executionId === undefined || timeoutMs === undefined || timeoutMs < 1 || timeoutMs > SESSION_PROTOCOL_BOUNDS.maxWaitMs) {
				return this.port.domainFailure(operation, "failed", "invalid_process_wait_request");
			}
			const handle = this.findHandle(executionId);
			if (handle === undefined) return this.port.domainFailure(operation, "unavailable", "process_not_found");
			const waited = await this.port.plane.processWait(handle, timeoutMs, "observer");
			if (!waited.ok) return this.port.domainFailure(operation, "failed", waited.code);
			if (waited.outcome === "terminal") await this.port.completeAuthorization(executionId);
			return this.port.domainSuccess(operation, this.port.revision(), {
				outcome: waited.outcome,
				summary: this.port.safeSummary(waited.summary),
				nextCursor: waited.nextCursor,
				...(waited.preview === undefined ? {} : { preview: waited.preview }),
			});
		}
		return this.port.domainFailure(operation, "unavailable", "operation_unavailable");
	}

	private findHandle(executionId: string): ExecutionHandleRef | undefined {
		return this.port.manager.handles().find((handle) => handle.executionId === executionId);
	}
}
