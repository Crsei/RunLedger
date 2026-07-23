/** 先关闭 mutation gate，再有限等待 writer/handler/tool/child 排空。 */

import type { ControlPlaneResult } from "./errors.ts";
import { controlPlaneFailure } from "./errors.ts";

export type DrainParticipantKind = "writer" | "handler" | "tool" | "child";

export interface DrainParticipant {
	id: string;
	kind: DrainParticipantKind;
	drain(signal: AbortSignal): Promise<void>;
}

export interface DrainOutcome {
	id: string;
	kind: DrainParticipantKind;
	status: "drained" | "timed_out" | "failed";
	errorName?: string;
}

export interface ShutdownReport {
	startedAt: string;
	deadline: string;
	finishedAt: string;
	outcomes: readonly DrainOutcome[];
	recoveryRequired: boolean;
}

export interface ShutdownFinalizer {
	id: string;
	finalize(report: ShutdownReport, signal: AbortSignal): Promise<void>;
}

export class ShutdownCoordinator {
	readonly #participants = new Map<string, DrainParticipant>();
	readonly #finalizers = new Map<string, ShutdownFinalizer>();
	readonly #clock: () => Date;
	#state: "open" | "draining" | "closed" = "open";
	#shutdown: Promise<ShutdownReport> | undefined;

	public constructor(clock: () => Date = () => new Date()) {
		this.#clock = clock;
	}

	public register(participant: DrainParticipant): ControlPlaneResult<() => void> {
		if (this.#state !== "open") return controlPlaneFailure("daemon_shutting_down", "drain registry is closed", true);
		if (!participant.id || this.#participants.has(participant.id) || this.#finalizers.has(participant.id)) {
			return controlPlaneFailure("invalid_request", "drain participant id is empty or duplicated");
		}
		this.#participants.set(participant.id, participant);
		return {
			ok: true,
			value: () => {
				if (this.#state === "open") this.#participants.delete(participant.id);
			},
		};
	}

	/**
	 * Finalizer 在普通 handler/tool/child/writer 都已排空后串行执行。canonical
	 * authority writer 用它先落 terminal receipt，再关闭自身。
	 */
	public registerFinalizer(finalizer: ShutdownFinalizer): ControlPlaneResult<() => void> {
		if (this.#state !== "open") return controlPlaneFailure("daemon_shutting_down", "shutdown finalizer registry is closed", true);
		if (!finalizer.id || this.#finalizers.has(finalizer.id) || this.#participants.has(finalizer.id)) {
			return controlPlaneFailure("invalid_request", "shutdown finalizer id is empty or duplicated");
		}
		this.#finalizers.set(finalizer.id, finalizer);
		return {
			ok: true,
			value: () => {
				if (this.#state === "open") this.#finalizers.delete(finalizer.id);
			},
		};
	}

	public acceptsMutations(): boolean {
		return this.#state === "open";
	}

	public state(): "open" | "draining" | "closed" {
		return this.#state;
	}

	public assertMutationOpen(): ControlPlaneResult<void> {
		return this.acceptsMutations()
			? { ok: true, value: undefined }
			: controlPlaneFailure("daemon_shutting_down", "daemon mutation gate is closed", true);
	}

	/** 关闭 mutation gate，但把实际 drain 延迟到 command terminal 已 durable 之后。 */
	public prepare(): ControlPlaneResult<void> {
		if (this.#state === "closed") return controlPlaneFailure("daemon_shutting_down", "daemon is already closed", false);
		this.#state = "draining";
		return { ok: true, value: undefined };
	}

	public begin(timeoutMs: number): Promise<ShutdownReport> {
		if (this.#shutdown) return this.#shutdown;
		this.#state = "draining";
		const startedAt = this.#clock();
		const boundedTimeout = Math.max(1, Math.min(300_000, Math.trunc(timeoutMs)));
		const deadlineMs = startedAt.getTime() + boundedTimeout;
		this.#shutdown = this.#drain(startedAt.toISOString(), new Date(deadlineMs).toISOString(), boundedTimeout);
		return this.#shutdown;
	}

	async #drain(startedAt: string, deadline: string, timeoutMs: number): Promise<ShutdownReport> {
		const controller = new AbortController();
		let expired = false;
		const timeout = setTimeout(() => {
			expired = true;
			controller.abort(new Error("shutdown drain deadline exceeded"));
		}, timeoutMs);
		timeout.unref?.();
		try {
			const outcomes = await Promise.all(
				[...this.#participants.values()].map(async (participant): Promise<DrainOutcome> => {
					try {
						await Promise.race([
							participant.drain(controller.signal),
							new Promise<never>((_resolve, reject) => {
								controller.signal.addEventListener(
									"abort",
									() => reject(controller.signal.reason instanceof Error ? controller.signal.reason : new Error("drain aborted")),
									{ once: true },
								);
							}),
						]);
						return { id: participant.id, kind: participant.kind, status: "drained" };
					} catch (error) {
						return {
							id: participant.id,
							kind: participant.kind,
							status: expired ? "timed_out" : "failed",
							errorName: error instanceof Error ? error.name : "UnknownError",
						};
					}
				}),
			);
			const baseReport: ShutdownReport = {
				startedAt,
				deadline,
				finishedAt: this.#clock().toISOString(),
				outcomes,
				recoveryRequired: outcomes.some((outcome) => outcome.status !== "drained"),
			};
			for (const finalizer of this.#finalizers.values()) {
				try {
					await Promise.race([
						finalizer.finalize(baseReport, controller.signal),
						new Promise<never>((_resolve, reject) => {
							controller.signal.addEventListener(
								"abort",
								() => reject(controller.signal.reason instanceof Error
									? controller.signal.reason
									: new Error("shutdown finalizer aborted")),
								{ once: true },
							);
						}),
					]);
				} catch (error) {
					outcomes.push({
						id: finalizer.id,
						kind: "writer",
						status: expired ? "timed_out" : "failed",
						errorName: error instanceof Error ? error.name : "UnknownError",
					});
				}
			}
			this.#state = "closed";
			return {
				...baseReport,
				finishedAt: this.#clock().toISOString(),
				outcomes,
				recoveryRequired: outcomes.some((outcome) => outcome.status !== "drained"),
			};
		} finally {
			clearTimeout(timeout);
		}
	}
}
