/**
 * S3 拆分:process domain mutation handler(spawn/stdin/eof/resize/stop)。
 *
 * spawn 顺序固定:输入校验 → security.prepare → attempt begin → commands
 * 登记 → plane.create(含 beforeSpawn final-leaf 校验)→ 失败 settle/reject
 * 或成功登记 authorization/attempt 结算 → commitMutation。revision 冲突
 * 在任何 effect 前拒绝(stale 不生效)。
 */

import { isAbsolute } from "node:path";
import { createRuntimeId } from "../../protocol/ids.ts";
import { runtimeDigest } from "../../protocol/foundation.ts";
import type { CommandId } from "../../protocol/ids.ts";
import type { SessionDomainResult } from "../domain-router.ts";
import type { SessionProcessJournal } from "../process-journal.ts";
import type { ManagedProcessControlPlane } from "../../../storage/process/control-plane.ts";
import type { AttemptPort } from "../attempt-gateway.ts";
import type { ExecutionHandleRef, ManagedProcessRequest } from "../../process/types.ts";
import type { ProcessManager } from "../../process/manager.ts";
import type { ProcessCompletionSettlement } from "./completion-settlement.ts";
import type { ProcessResultShaping } from "./query-handler.ts";
import type { SessionProcessCompositionOptions, CommandDescriptor } from "./composition.ts";

export interface ProcessMutationPort extends ProcessResultShaping {
	readonly options: SessionProcessCompositionOptions;
	readonly manager: ProcessManager;
	readonly commands: Map<CommandId, CommandDescriptor>;
	readonly plane: ManagedProcessControlPlane;
	readonly journal: SessionProcessJournal;
	readonly revision: () => number;
	readonly settlement: ProcessCompletionSettlement;
	readonly attemptPort: () => AttemptPort | undefined;
}

export class ProcessMutationHandler {
	private readonly port: ProcessMutationPort;

	public constructor(port: ProcessMutationPort) {
		this.port = port;
	}

	public async mutate(
		operation: string,
		payload: Record<string, unknown>,
		context: { readonly correlationId: string; readonly effectId: string; readonly expectedRevision: number },
	): Promise<SessionDomainResult> {
		if (operation !== "session.process.start") {
			const executionId = this.port.stringValue(payload.executionId);
			if (executionId === undefined) return this.port.domainFailure(operation, "failed", "execution_id_required");
			const handle = this.findHandle(executionId);
			if (handle === undefined) return this.port.domainFailure(operation, "unavailable", "process_not_found");
			const current = this.port.manager.query(handle);
			if (!current.ok) return this.port.domainFailure(operation, "failed", current.code);
			if (context.expectedRevision !== this.port.revision()) {
				return { ...this.port.domainFailure(operation, "stale", "domain_revision_conflict"), currentRevision: this.port.revision() };
			}
			if (operation === "session.process.stdin") {
				const input = typeof payload.input === "string" ? payload.input : undefined;
				if (input === undefined) return this.port.domainFailure(operation, "failed", "process_input_required");
				const result = await this.port.plane.write(handle, "driver", input);
				return result.ok ? this.commitMutation(operation, context.effectId, { executionId, receiptDigest: result.receiptDigest }) : this.port.domainFailure(operation, "failed", result.code);
			}
			if (operation === "session.process.eof") {
				const result = await this.port.plane.eof(handle, "driver");
				return result.ok ? this.commitMutation(operation, context.effectId, { executionId, receiptDigest: result.receiptDigest }) : this.port.domainFailure(operation, "failed", result.code);
			}
			if (operation === "session.process.resize") {
				const columns = this.port.integerValue(payload.columns);
				const rows = this.port.integerValue(payload.rows);
				if (columns === undefined || rows === undefined) return this.port.domainFailure(operation, "failed", "process_resize_required");
				const result = await this.port.plane.resize(handle, "driver", columns, rows);
				return result.ok ? this.commitMutation(operation, context.effectId, { executionId, receiptDigest: result.receiptDigest }) : this.port.domainFailure(operation, "failed", result.code);
			}
			if (operation === "session.process.stop") {
				const result = await this.port.plane.stop(handle, "driver");
				return result.ok ? this.commitMutation(operation, context.effectId, { executionId, receiptDigest: result.receiptDigest }) : this.port.domainFailure(operation, "failed", result.code);
			}
			return this.port.domainFailure(operation, "unavailable", "operation_unavailable");
		}
		if (context.expectedRevision !== this.port.revision()) {
			return { ...this.port.domainFailure(operation, "stale", "domain_revision_conflict"), currentRevision: this.port.revision() };
		}
		const command = this.port.stringValue(payload.command);
		const cwd = this.port.stringValue(payload.cwd) ?? this.port.options.cwd;
		const timeoutMs = this.port.integerValue(payload.timeoutMs);
		const backend = payload.backend;
		const executionMode = payload.executionMode;
		if (command === undefined || !isAbsolute(cwd) || timeoutMs === undefined || timeoutMs < 1 || (backend !== "pipe" && backend !== "pty") || (executionMode !== "foreground" && executionMode !== "background")) {
			return this.port.domainFailure(operation, "failed", "invalid_process_start_request");
		}
		const correlationId = createRuntimeId("command", runtimeDigest({
			sessionId: this.port.options.fence.sessionId,
			generation: this.port.options.fence.generation,
			correlationId: context.correlationId,
			effectId: context.effectId,
		}).digest.slice(0, 64));
		const requestDigest = runtimeDigest({ command, cwd, timeoutMs, backend, executionMode });
		const prepared = await this.port.options.security.prepare({
			commandId: correlationId,
			command,
			cwd,
			timeoutMs,
			backend,
			executionMode,
			requestDigest,
		});
		if (!prepared.ok) return this.port.domainFailure(operation, "denied", prepared.error.code);
		const attemptPort = this.port.attemptPort();
		const begun = attemptPort?.beginAttempt("process_spawn", requestDigest);
		if (begun !== undefined && "error" in begun) {
			return this.port.domainFailure(operation, "recovery_required", begun.error);
		}
		this.port.commands.set(correlationId, { command, cwd });
		const request: ManagedProcessRequest = {
			authorityId: createRuntimeId("authority", "session-owner-runtime"),
			tenantId: createRuntimeId("tenant", "local-user"),
			workspaceId: this.port.options.workspaceId,
			sessionId: this.port.options.fence.sessionId,
			hostGeneration: this.port.options.fence.generation,
			sessionGeneration: this.port.options.fence.generation,
			requestDigest: prepared.value.requestDigest,
			commandRef: { subjectKind: "content", digest: runtimeDigest(command), mediaType: "text/plain", size: Buffer.byteLength(command) },
			cwdRef: { subjectKind: "content", digest: runtimeDigest(cwd), mediaType: "text/plain", size: Buffer.byteLength(cwd) },
			backend,
			executionMode,
			timeoutMs,
			correlationId,
		};
		const launchPlan = prepared.value.launchPlan === undefined
			? undefined
			: {
				program: prepared.value.launchPlan.program,
				arguments: prepared.value.launchPlan.arguments,
				cwd: prepared.value.launchPlan.cwd,
				environment: prepared.value.launchPlan.environment,
			};
		const created = await this.port.plane.create(request, prepared.value.constraintInput, {
			constraintSnapshot: prepared.value.constraintSnapshot,
			commandDisplayReceipt: prepared.value.commandDisplayReceipt,
			...(launchPlan === undefined ? {} : { launchPlan }),
			beforeSpawn: async () => {
				const finalLeaf = await prepared.value.validateFinalLeaf();
				if (!finalLeaf.ok) throw new Error(`${finalLeaf.error.code}: ${finalLeaf.error.message}`);
			},
		});
		if (!created.ok) {
			if (begun !== undefined && created.code !== "uncertain_outcome") {
				const settled = attemptPort?.settleAttempt(begun.attemptId, "rejected", runtimeDigest({ code: created.code }));
				if (settled !== undefined && !settled.ok) return this.port.domainFailure(operation, "failed", settled.code);
			}
			return this.port.domainFailure(operation, created.code.includes("denied") ? "denied" : "failed", created.code);
		}
		if (begun !== undefined) this.port.settlement.registerAttempt(created.handle.executionId, begun.attemptId);
		this.port.settlement.registerAuthorization(created.handle.executionId, prepared.value.complete);
		return this.commitMutation(operation, context.effectId, this.port.safeSummary(created.summary));
	}

	private findHandle(executionId: string): ExecutionHandleRef | undefined {
		return this.port.manager.handles().find((handle) => handle.executionId === executionId);
	}

	private commitMutation(operation: string, effectId: string, value: Record<string, unknown>): SessionDomainResult {
		try {
			return this.port.domainSuccess(operation, this.port.journal.commitDomainRevision(operation, effectId), value);
		} catch {
			return this.port.domainFailure(operation, "recovery_required", "process_domain_revision_commit_uncertain");
		}
	}
}
