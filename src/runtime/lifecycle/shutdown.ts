/** mutation gate 先关闭，再在全局 deadline 内排空 tool/child、writer、exporter。 */

import { canonicalDigest } from "../protocol/v3/canonical-json.ts";
import { createRuntimeId, type AuthorityId, type ReceiptId, type RuntimeInstanceId, type TenantId } from "../protocol/v3/ids.ts";
import type { LifecycleResult } from "./recovery.ts";

export type RuntimeShutdownTrigger =
	| { kind: "signal"; signal: "SIGINT" | "SIGTERM" | "SIGHUP" }
	| { kind: "stdin_eof" }
	| { kind: "terminal_error"; source: "terminal" | "input" | "output"; detailDigest: string }
	| { kind: "uncaught_exception"; detailDigest: string }
	| { kind: "unhandled_rejection"; detailDigest: string }
	| { kind: "daemon_upgrade"; targetVersionDigest: string };

export type RuntimeDrainParticipantKind = "writer" | "tool" | "child" | "exporter";

export interface RuntimeDrainParticipant {
	id: string;
	kind: RuntimeDrainParticipantKind;
	drain(signal: AbortSignal): Promise<void>;
}

export interface RuntimeDrainOutcome {
	id: string;
	kind: RuntimeDrainParticipantKind;
	status: "drained" | "timed_out" | "failed";
	reasonDigest?: string;
}

export interface RuntimeShutdownReceiptBody {
	authorityId: AuthorityId;
	tenantId: TenantId;
	runtimeId: RuntimeInstanceId;
	trigger: RuntimeShutdownTrigger;
	startedAt: string;
	deadline: string;
	finishedAt: string;
	outcomes: readonly RuntimeDrainOutcome[];
	recoveryRequired: boolean;
}

export interface RuntimeShutdownReceipt extends RuntimeShutdownReceiptBody {
	receiptId: ReceiptId;
	receiptDigest: string;
}

function waitForAbort(signal: AbortSignal): Promise<never> {
	return new Promise((_resolve, reject) => {
		if (signal.aborted) { reject(signal.reason instanceof Error ? signal.reason : new Error("shutdown deadline exceeded")); return; }
		signal.addEventListener("abort", () => reject(signal.reason instanceof Error ? signal.reason : new Error("shutdown deadline exceeded")), { once: true });
	});
}

function isDigest(value: string): boolean { return /^[a-f0-9]{64}$/.test(value); }

export function isRuntimeShutdownTrigger(trigger: unknown): trigger is RuntimeShutdownTrigger {
	if (typeof trigger !== "object" || trigger === null || !("kind" in trigger)) return false;
	const candidate = trigger as Readonly<Record<string, unknown>>;
	if (candidate.kind === "signal") {
		return Object.keys(candidate).sort().join(",") === "kind,signal" &&
			typeof candidate.signal === "string" && ["SIGINT", "SIGTERM", "SIGHUP"].includes(candidate.signal);
	}
	if (candidate.kind === "stdin_eof") return Object.keys(candidate).join(",") === "kind";
	if (candidate.kind === "daemon_upgrade") {
		return Object.keys(candidate).sort().join(",") === "kind,targetVersionDigest" &&
			typeof candidate.targetVersionDigest === "string" && isDigest(candidate.targetVersionDigest);
	}
	if (candidate.kind === "terminal_error") {
		return Object.keys(candidate).sort().join(",") === "detailDigest,kind,source" &&
			typeof candidate.source === "string" && ["terminal", "input", "output"].includes(candidate.source) &&
			typeof candidate.detailDigest === "string" && isDigest(candidate.detailDigest);
	}
	if (candidate.kind === "uncaught_exception" || candidate.kind === "unhandled_rejection") {
		return Object.keys(candidate).sort().join(",") === "detailDigest,kind" &&
			typeof candidate.detailDigest === "string" && isDigest(candidate.detailDigest);
	}
	return false;
}

function errorDetailDigest(error: unknown): string {
	return canonicalDigest(error instanceof Error
		? { name: error.name, message: error.message }
		: { name: "UnknownError", valueType: typeof error });
}

export function createRuntimeTerminalErrorTrigger(
	error: unknown,
	source: Extract<RuntimeShutdownTrigger, { kind: "terminal_error" }>["source"] = "terminal",
): Extract<RuntimeShutdownTrigger, { kind: "terminal_error" }> {
	return { kind: "terminal_error", source, detailDigest: errorDetailDigest(error) };
}

export function createRuntimeUnhandledErrorTrigger(
	kind: "uncaught_exception" | "unhandled_rejection",
	error: unknown,
): Extract<RuntimeShutdownTrigger, { kind: typeof kind }> {
	return { kind, detailDigest: errorDetailDigest(error) };
}

export class RuntimeShutdownCoordinator {
	readonly #authorityId: AuthorityId;
	readonly #tenantId: TenantId;
	readonly #runtimeId: RuntimeInstanceId;
	readonly #clock: () => Date;
	readonly #participants = new Map<string, RuntimeDrainParticipant>();
	#state: "open" | "draining" | "closed" = "open";
	#receipt: Promise<LifecycleResult<RuntimeShutdownReceipt>> | undefined;

	public constructor(scope: { authorityId: AuthorityId; tenantId: TenantId; runtimeId: RuntimeInstanceId }, clock: () => Date = () => new Date()) {
		this.#authorityId = scope.authorityId; this.#tenantId = scope.tenantId; this.#runtimeId = scope.runtimeId; this.#clock = clock;
	}

	public acceptsMutations(): boolean { return this.#state === "open"; }
	public state(): "open" | "draining" | "closed" { return this.#state; }

	public register(participant: RuntimeDrainParticipant): LifecycleResult<() => void> {
		if (this.#state !== "open" || !/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(participant.id) || this.#participants.has(participant.id)) {
			return { ok: false, error: { code: "invalid_request", message: "shutdown participant cannot be registered", retryable: false } };
		}
		this.#participants.set(participant.id, participant);
		return { ok: true, value: () => { if (this.#state === "open") this.#participants.delete(participant.id); } };
	}

	public shutdown(trigger: RuntimeShutdownTrigger, timeoutMs: number): Promise<LifecycleResult<RuntimeShutdownReceipt>> {
		if (this.#receipt) return this.#receipt;
		if (!isRuntimeShutdownTrigger(trigger) || !Number.isFinite(timeoutMs)) {
			return Promise.resolve({ ok: false, error: { code: "invalid_request", message: "shutdown trigger or timeout is invalid", retryable: false } });
		}
		this.#state = "draining";
		// gate 必须在本调用内同步关闭；participant drain 延后一 microtask，允许 host
		// 先中断 active tool、停止 terminal surface，再进入可能长时间运行的清理。
		this.#receipt = Promise.resolve().then(() =>
			this.#drain(trigger, Math.max(1, Math.min(300_000, Math.trunc(timeoutMs)))),
		);
		return this.#receipt;
	}

	async #drain(trigger: RuntimeShutdownTrigger, timeoutMs: number): Promise<LifecycleResult<RuntimeShutdownReceipt>> {
		const started = this.#clock();
		const deadlineMs = started.getTime() + timeoutMs;
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(new Error("shutdown deadline exceeded")), timeoutMs);
		timer.unref?.();
		const outcomes: RuntimeDrainOutcome[] = [];
		try {
			for (const kinds of [["tool", "child"], ["writer"], ["exporter"]] as const) {
				const phase = [...this.#participants.values()].filter((participant) =>
					kinds.some((kind) => kind === participant.kind),
				);
				outcomes.push(...await Promise.all(phase.map(async (participant): Promise<RuntimeDrainOutcome> => {
					try {
						await Promise.race([participant.drain(controller.signal), waitForAbort(controller.signal)]);
						return { id: participant.id, kind: participant.kind, status: "drained" };
					} catch (error) {
						return { id: participant.id, kind: participant.kind, status: controller.signal.aborted ? "timed_out" : "failed", reasonDigest: canonicalDigest(error instanceof Error ? error.name : "UnknownError") };
					}
				})));
			}
		} finally { clearTimeout(timer); this.#state = "closed"; }
		const body: RuntimeShutdownReceiptBody = {
			authorityId: this.#authorityId, tenantId: this.#tenantId, runtimeId: this.#runtimeId, trigger,
			startedAt: started.toISOString(), deadline: new Date(deadlineMs).toISOString(), finishedAt: this.#clock().toISOString(),
			outcomes, recoveryRequired: outcomes.some((outcome) => outcome.status !== "drained"),
		};
		const receiptDigest = canonicalDigest(body);
		return { ok: true, value: { ...body, receiptId: createRuntimeId("receipt", `shutdown-${receiptDigest.slice(0, 32)}`), receiptDigest } };
	}
}

/** Host adapter 可把所有 shutdown source 收敛为同一 coordinator，不在此注册全局监听器。 */
export class RuntimeShutdownTriggerAdapter {
	readonly #coordinator: RuntimeShutdownCoordinator;
	readonly #timeoutMs: number;
	public constructor(coordinator: RuntimeShutdownCoordinator, timeoutMs: number) { this.#coordinator = coordinator; this.#timeoutMs = timeoutMs; }
	public signal(signal: "SIGINT" | "SIGTERM" | "SIGHUP"): Promise<LifecycleResult<RuntimeShutdownReceipt>> { return this.#coordinator.shutdown({ kind: "signal", signal }, this.#timeoutMs); }
	public stdinEof(): Promise<LifecycleResult<RuntimeShutdownReceipt>> { return this.#coordinator.shutdown({ kind: "stdin_eof" }, this.#timeoutMs); }
	public terminalError(error: unknown): Promise<LifecycleResult<RuntimeShutdownReceipt>> { return this.#coordinator.shutdown(createRuntimeTerminalErrorTrigger(error), this.#timeoutMs); }
	public inputError(error: unknown): Promise<LifecycleResult<RuntimeShutdownReceipt>> { return this.#coordinator.shutdown(createRuntimeTerminalErrorTrigger(error, "input"), this.#timeoutMs); }
	public outputError(error: unknown): Promise<LifecycleResult<RuntimeShutdownReceipt>> { return this.#coordinator.shutdown(createRuntimeTerminalErrorTrigger(error, "output"), this.#timeoutMs); }
	public uncaughtException(error: unknown): Promise<LifecycleResult<RuntimeShutdownReceipt>> { return this.#coordinator.shutdown(createRuntimeUnhandledErrorTrigger("uncaught_exception", error), this.#timeoutMs); }
	public unhandledRejection(error: unknown): Promise<LifecycleResult<RuntimeShutdownReceipt>> { return this.#coordinator.shutdown(createRuntimeUnhandledErrorTrigger("unhandled_rejection", error), this.#timeoutMs); }
	public daemonUpgrade(targetVersion: string): Promise<LifecycleResult<RuntimeShutdownReceipt>> { return this.#coordinator.shutdown({ kind: "daemon_upgrade", targetVersionDigest: canonicalDigest(targetVersion) }, this.#timeoutMs); }
}
