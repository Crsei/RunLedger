/** Runtime Host admission/drain/seal/release lifecycle。
 *
 * Host shutdown 是独立于 client detach 的 lifecycle。所有 process 操作都
 * 通过注入的 Host-owned ports 执行；本模块不读取 PID、路径或 backend handle，
 * recovery marker 只保存 phase、safe process id 和失败数量。
 */

import { runtimeDigest, type RuntimeContentRef, type RuntimeDigest } from "../protocol/foundation.ts";
import type { ProcessManager } from "../process/manager.ts";

export type RuntimeHostLifecycleState = "ready" | "draining" | "closed";
export type RuntimeHostLifecyclePhase =
	| "shutdown_started"
	| "admission_closed"
	| "turns_drained"
	| "processes_drained"
	| "outputs_sealed"
	| "artifacts_materialized"
	| "writer_flushed"
	| "resources_released"
	| "shutdown_completed"
	| "shutdown_incomplete"
	| "recovery_started"
	| "recovery_completed"
	| "recovery_incomplete";

export type RuntimeHostLifecycleFailure = {
	readonly target: "host" | "process" | "writer" | "resources";
	readonly phase: RuntimeHostLifecyclePhase;
	readonly processId?: string;
};

export interface RuntimeHostRecoveryMarker {
	readonly hostGeneration: number;
	readonly phase: RuntimeHostLifecyclePhase;
	readonly artifactMode: "off" | "events" | "events_and_artifacts";
	readonly processIds: readonly string[];
	readonly processEvidence: readonly RuntimeHostProcessEvidence[];
	readonly failures: readonly RuntimeHostLifecycleFailure[];
	readonly markerDigest: RuntimeDigest;
}

export interface RuntimeHostProcessEvidence {
	readonly id: string;
	readonly outputCheckpoint: {
		readonly cursor: {
			readonly sequence: number;
			readonly byteOffset: number;
		};
		readonly size: number;
	};
	readonly outputSealDigest?: RuntimeDigest;
	readonly settlementEvidenceRef?: RuntimeContentRef;
}

export interface RuntimeHostLifecycleProcess {
	readonly id: string;
	drain(): Promise<void>;
	checkpoint(): Promise<void>;
	seal(): Promise<void>;
	settle(): Promise<void>;
	materializeArtifacts?(): Promise<void>;
	evidence?(): Promise<RuntimeHostProcessEvidence>;
}

export interface RuntimeHostRecoveredProcess {
	readonly id: string;
	readonly state: "lost" | "uncertain";
	readonly evidence?: RuntimeHostProcessEvidence;
}

export interface RuntimeHostLifecyclePorts {
	recoverUnattached?(): Promise<readonly RuntimeHostRecoveredProcess[]>;
	closeAdmission(): Promise<void>;
	drainTurns(): Promise<void>;
	listProcesses(): Promise<readonly RuntimeHostLifecycleProcess[]>;
	flushWriter(): Promise<void>;
	release(): Promise<void>;
	writeRecoveryMarker(marker: RuntimeHostRecoveryMarker): Promise<void>;
}

export type RuntimeHostRecoveryResult =
	| {
			readonly ok: true;
			readonly processes: readonly RuntimeHostRecoveredProcess[];
			readonly marker: RuntimeHostRecoveryMarker;
			readonly failures: readonly [];
	  }
	| {
			readonly ok: false;
			readonly code: "recovery_incomplete";
			readonly processes: readonly RuntimeHostRecoveredProcess[];
			readonly marker: RuntimeHostRecoveryMarker;
			readonly failures: readonly RuntimeHostLifecycleFailure[];
	  };

export interface RuntimeHostLifecycleOptions {
	readonly hostGeneration: number;
	readonly artifactMode: "off" | "events" | "events_and_artifacts";
	readonly shutdownDeadlineMs?: number;
	readonly ports: RuntimeHostLifecyclePorts;
}

/** 把 durable ProcessManager recovery 投影为 Host lifecycle 的 safe recovery port。 */
export function createManagedProcessRecoveryPort(
	manager: Pick<ProcessManager, "recoverUnattached">,
): () => Promise<readonly RuntimeHostRecoveredProcess[]> {
	return async () => {
		const results = await manager.recoverUnattached();
		const recovered: RuntimeHostRecoveredProcess[] = [];
		for (const result of results) {
			if (!result.ok) throw new Error("managed process recovery is unavailable");
			if (result.summary.state === "lost" || result.summary.state === "uncertain") {
				recovered.push({ id: result.handle.executionId, state: result.summary.state });
			}
		}
		return recovered;
	};
}

export type RuntimeHostShutdownResult =
	| {
			readonly ok: true;
			readonly state: "closed";
			readonly phase: "shutdown_completed";
			readonly marker: RuntimeHostRecoveryMarker;
			readonly failures: readonly [];
	  }
	| {
			readonly ok: false;
			readonly code: "shutdown_incomplete";
			readonly state: "closed";
			readonly phase: "shutdown_incomplete";
			readonly marker: RuntimeHostRecoveryMarker;
			readonly failures: readonly RuntimeHostLifecycleFailure[];
	  };

export class RuntimeHostLifecycle {
	private readonly hostGeneration: number;
	private readonly artifactMode: RuntimeHostLifecycleOptions["artifactMode"];
	private readonly ports: RuntimeHostLifecyclePorts;
	private readonly shutdownDeadlineMs: number;
	private currentState: RuntimeHostLifecycleState = "ready";
	private shutdownPromise: Promise<RuntimeHostShutdownResult> | undefined;

	public constructor(options: RuntimeHostLifecycleOptions) {
		if (!Number.isSafeInteger(options.hostGeneration) || options.hostGeneration < 0) {
			throw new Error("hostGeneration must be a non-negative safe integer");
		}
		this.hostGeneration = options.hostGeneration;
		this.artifactMode = options.artifactMode;
		this.ports = options.ports;
		this.shutdownDeadlineMs = options.shutdownDeadlineMs ?? 60_000;
		if (!Number.isSafeInteger(this.shutdownDeadlineMs) || this.shutdownDeadlineMs < 1 || this.shutdownDeadlineMs > 300_000) {
			throw new Error("shutdownDeadlineMs is outside the bounded range");
		}
	}

	public state(): RuntimeHostLifecycleState {
		return this.currentState;
	}

	public admissionClosed(): boolean {
		return this.currentState !== "ready";
	}

	public shutdown(): Promise<RuntimeHostShutdownResult> {
		this.shutdownPromise ??= this.performShutdown();
		return this.shutdownPromise;
	}

	/** Host restart recovery only projects durable attempts; it never looks up a PID. */
	public async recoverAfterRestart(): Promise<RuntimeHostRecoveryResult> {
		const failures: RuntimeHostLifecycleFailure[] = [];
		await this.writeMarker("recovery_started", [], failures);
		let processes: readonly RuntimeHostRecoveredProcess[] = [];
		try {
			processes = this.ports.recoverUnattached ? await this.ports.recoverUnattached() : [];
		} catch {
			failures.push({ target: "host", phase: "recovery_incomplete" });
		}
		const processIds = processes.map((process) => process.id);
		const processEvidence = processes.flatMap((process) => process.evidence === undefined ? [] : [process.evidence]);
		if (failures.length > 0) {
			const marker = await this.writeMarker("recovery_incomplete", processIds, failures, processEvidence);
			return { ok: false, code: "recovery_incomplete", processes, marker, failures: marker.failures };
		}
		const marker = await this.writeMarker("recovery_completed", processIds, failures, processEvidence);
		if (failures.length > 0) {
			return { ok: false, code: "recovery_incomplete", processes, marker, failures: marker.failures };
		}
		return { ok: true, processes, marker, failures: [] };
	}

	private async performShutdown(): Promise<RuntimeHostShutdownResult> {
		const deadline = Date.now() + this.shutdownDeadlineMs;
		this.currentState = "draining";
		const failures: RuntimeHostLifecycleFailure[] = [];
		let processes: readonly RuntimeHostLifecycleProcess[] = [];
		await this.writeMarker("shutdown_started", [], failures, [], deadline);

		await this.runHostPhase("admission_closed", "host", failures, () => this.ports.closeAdmission(), deadline);
		await this.runHostPhase("turns_drained", "host", failures, () => this.ports.drainTurns(), deadline);

		const listed = await runBeforeDeadline(deadline, () => this.ports.listProcesses());
		if (listed.ok) {
			processes = listed.value;
		} else {
			failures.push({ target: "host", phase: "processes_drained" });
		}

		for (const process of processes) {
			await this.runProcessPhase(process, "drain", "processes_drained", failures, deadline);
			await this.runProcessPhase(process, "checkpoint", "outputs_sealed", failures, deadline);
			await this.runProcessPhase(process, "seal", "outputs_sealed", failures, deadline);
			await this.runProcessPhase(process, "settle", "processes_drained", failures, deadline);
			if (this.artifactMode === "events_and_artifacts" && process.materializeArtifacts) {
				await this.runProcessPhase(process, "materializeArtifacts", "artifacts_materialized", failures, deadline);
			}
		}
		const processEvidence = await this.collectProcessEvidence(processes, failures, deadline);

		await this.runHostPhase("writer_flushed", "writer", failures, () => this.ports.flushWriter(), deadline);
		await this.runHostPhase("resources_released", "resources", failures, () => this.ports.release(), deadline);
		this.currentState = "closed";

		if (failures.length > 0) {
			const marker = await this.writeMarker("shutdown_incomplete", processes.map((process) => process.id), failures, processEvidence, deadline);
			return { ok: false, code: "shutdown_incomplete", state: "closed", phase: "shutdown_incomplete", marker, failures: marker.failures };
		}
		const marker = await this.writeMarker("shutdown_completed", processes.map((process) => process.id), failures, processEvidence, deadline);
		if (failures.length > 0) {
			return { ok: false, code: "shutdown_incomplete", state: "closed", phase: "shutdown_incomplete", marker, failures: marker.failures };
		}
		return { ok: true, state: "closed", phase: "shutdown_completed", marker, failures: [] };
	}

	private async runProcessPhase(
		process: RuntimeHostLifecycleProcess,
		method: "drain" | "checkpoint" | "seal" | "settle" | "materializeArtifacts",
		phase: RuntimeHostLifecyclePhase,
		failures: RuntimeHostLifecycleFailure[],
		deadline: number,
	): Promise<void> {
		const operation = process[method];
		if (typeof operation !== "function") return;
		const result = await runBeforeDeadline(deadline, () => operation.call(process));
		if (!result.ok) {
			failures.push({ target: "process", phase, processId: process.id });
		}
	}

	private async runHostPhase(
		phase: RuntimeHostLifecyclePhase,
		target: RuntimeHostLifecycleFailure["target"],
		failures: RuntimeHostLifecycleFailure[],
		operation: () => Promise<void>,
		deadline: number,
	): Promise<void> {
		const result = await runBeforeDeadline(deadline, operation);
		if (!result.ok) {
			failures.push({ target, phase });
		}
	}

	private async collectProcessEvidence(
		processes: readonly RuntimeHostLifecycleProcess[],
		failures: RuntimeHostLifecycleFailure[],
		deadline: number,
	): Promise<readonly RuntimeHostProcessEvidence[]> {
		const evidence: RuntimeHostProcessEvidence[] = [];
		for (const process of processes) {
			if (process.evidence === undefined) continue;
			const result = await runBeforeDeadline(deadline, () => process.evidence!());
			if (result.ok) {
				evidence.push(result.value);
			} else {
				failures.push({ target: "process", phase: "outputs_sealed", processId: process.id });
			}
		}
		return evidence;
	}

	private async writeMarker(
		phase: RuntimeHostLifecyclePhase,
		processIds: readonly string[],
		failures: RuntimeHostLifecycleFailure[],
		processEvidence: readonly RuntimeHostProcessEvidence[] = [],
		deadline?: number,
	): Promise<RuntimeHostRecoveryMarker> {
		const body = {
			hostGeneration: this.hostGeneration,
			phase,
			artifactMode: this.artifactMode,
			processIds: processIds.slice(),
			processEvidence: processEvidence.slice(),
			failures: failures.slice(),
		};
		const marker: RuntimeHostRecoveryMarker = { ...body, markerDigest: runtimeDigest(body) };
		const result = deadline === undefined
			? await runOperation(() => this.ports.writeRecoveryMarker(marker))
			: await runBeforeDeadline(deadline, () => this.ports.writeRecoveryMarker(marker));
		if (!result.ok) {
			if (phase !== "shutdown_incomplete") failures.push({ target: "host", phase });
		}
		return marker;
	}
}

type BoundedOperationResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false };

async function runOperation<T>(operation: () => Promise<T>): Promise<BoundedOperationResult<T>> {
	try {
		return { ok: true, value: await operation() };
	} catch {
		return { ok: false };
	}
}

async function runBeforeDeadline<T>(deadline: number, operation: () => Promise<T>): Promise<BoundedOperationResult<T>> {
	const remaining = deadline - Date.now();
	if (remaining <= 0) return { ok: false };
	const task = Promise.resolve().then(operation);
	// Promise.race 返回后仍吸收迟到 rejection，避免 shutdown timeout 制造 unhandled rejection。
	void task.catch(() => undefined);
	let timer: NodeJS.Timeout | undefined;
	const timeout = new Promise<BoundedOperationResult<T>>((resolve) => {
		timer = setTimeout(() => resolve({ ok: false }), remaining);
	});
	const result = await Promise.race([
		task.then(
			(value): BoundedOperationResult<T> => ({ ok: true, value }),
			(): BoundedOperationResult<T> => ({ ok: false }),
		),
		timeout,
	]);
	if (timer) clearTimeout(timer);
	return result;
}
