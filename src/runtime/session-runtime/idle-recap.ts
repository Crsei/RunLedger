import type { EffectiveRecapSettings } from "../../storage/settings-manager.ts";
import stringWidth from "string-width";
import { newId } from "../ledger/types.ts";

export type IdleRecapMaintenance = "idle" | "busy" | "unknown";
export type IdleRecapRecoveryBarrier = "closed" | "open";

export type IdleRecapState = "disabled" | "disarmed" | "armed" | "running" | "settled" | "cancelled";

export const IDLE_RECAP_PROMPT =
	"User stepped away; returning. Recap: fewer than 40 words, 1–2 plain sentences, no markdown. " +
	"Lead with the overall goal, current task, and one next action. Skip root-cause narrative, " +
	"implementation details, and secondary to-dos.";

export interface IdleRecapActivity {
	readonly sessionId: string;
	readonly ownerGeneration: number;
	readonly driverRevision: number;
	readonly driverAttached: boolean;
	readonly editorEmpty: boolean;
	readonly streaming: boolean;
	readonly maintenance: IdleRecapMaintenance;
	readonly recoveryBarrier: IdleRecapRecoveryBarrier;
	readonly hasModel: boolean;
	readonly hasHistory: boolean;
	readonly selectionDigest: string;
}

export interface IdleRecapRequest {
	readonly requestId: string;
	readonly kind: "idle-recap";
	readonly sessionId: string;
	readonly ownerGeneration: number;
	readonly activityGeneration: number;
	readonly driverRevision: number;
	readonly expectedSelectionDigest: string;
	readonly signal: AbortSignal;
}

export interface IdleRecapCoordinatorOptions {
	readonly settings: EffectiveRecapSettings;
	readonly onFire: (request: IdleRecapRequest) => Promise<string | undefined> | string | undefined;
	readonly onStatus: (replyText: string, request: IdleRecapRequest) => void;
	readonly requestIdFactory?: (activity: IdleRecapActivity, activityGeneration: number) => string;
}

/**
 * Session Owner 内的 idle epoch/timer 协调器。
 *
 * 它只保存内存状态，不写 ledger/session store；provider 结果必须经过
 * 当前 request、activity generation 与完整 idle gate 检查后才能投影 status。
 */
export class IdleRecapCoordinator {
	private settings: EffectiveRecapSettings;
	private readonly onFire: IdleRecapCoordinatorOptions["onFire"];
	private readonly onStatus: IdleRecapCoordinatorOptions["onStatus"];
	private readonly requestIdFactory: (activity: IdleRecapActivity, activityGeneration: number) => string;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private activity: IdleRecapActivity | undefined;
	private activityGeneration = 0;
	private currentState: IdleRecapState = "disarmed";
	private inFlight: { readonly request: IdleRecapRequest; readonly abort: AbortController } | undefined;
	private disposed = false;
	private requestSequence = 0;

	public constructor(options: IdleRecapCoordinatorOptions) {
		this.settings = options.settings;
		this.onFire = options.onFire;
		this.onStatus = options.onStatus;
		this.requestIdFactory = options.requestIdFactory ?? ((activity, activityGeneration) =>
			`idle-recap-owner-${activity.ownerGeneration}-activity-${activityGeneration}-${++this.requestSequence}-${newId()}`);
		if (!this.settings.enabled) this.currentState = "disabled";
	}

	public get state(): IdleRecapState {
		return this.currentState;
	}

	public updateSettings(settings: EffectiveRecapSettings): void {
		this.settings = settings;
		this.cancelPending();
		this.currentState = settings.enabled ? "disarmed" : "disabled";
	}

	/** 在一个新的正常 turn/空闲 epoch 上 arm。 */
	public arm(activity: IdleRecapActivity): void {
		if (this.disposed) return;
		this.cancelPending();
		this.activity = activity;
		this.activityGeneration += 1;
		if (!this.settings.enabled) {
			this.currentState = "disabled";
			return;
		}
		if (!isIdleRecapEligible(activity)) {
			this.currentState = "disarmed";
			return;
		}
		const generation = this.activityGeneration;
		this.currentState = "armed";
		this.timer = setTimeout(() => {
			this.timer = undefined;
			void this.fire(activity, generation);
		}, Math.max(1, Math.trunc(this.settings.idleSeconds)) * 1000);
		this.timer.unref?.();
	}

	/** 新输入、driver 变化、session transition 等 activity 统一从这里失效。 */
	public notifyActivity(activity: IdleRecapActivity): void {
		if (this.disposed) return;
		this.cancelPending();
		this.activity = activity;
		this.activityGeneration += 1;
		this.currentState = this.settings.enabled ? "cancelled" : "disabled";
	}

	public dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.cancelPending();
		this.activity = undefined;
		this.currentState = "cancelled";
	}

	private async fire(activity: IdleRecapActivity, generation: number): Promise<void> {
		if (this.disposed || generation !== this.activityGeneration || this.activity !== activity) return;
		if (!this.settings.enabled || !isIdleRecapEligible(activity)) {
			this.currentState = "disarmed";
			return;
		}
		const abort = new AbortController();
		const request: IdleRecapRequest = Object.freeze({
			requestId: this.requestIdFactory(activity, generation),
			kind: "idle-recap",
			sessionId: activity.sessionId,
			ownerGeneration: activity.ownerGeneration,
			activityGeneration: generation,
			driverRevision: activity.driverRevision,
			expectedSelectionDigest: activity.selectionDigest,
			signal: abort.signal,
		});
		this.inFlight = { request, abort };
		this.currentState = "running";
		let replyText: string | undefined;
		try {
			replyText = await this.onFire(request);
		} catch {
			// recap provider failure is intentionally silent and cannot affect prompt lifecycle.
		}
		if (this.inFlight?.request !== request) return;
		this.inFlight = undefined;
		const normalizedReply = replyText === undefined ? undefined : normalizeIdleRecapText(replyText);
		if (
			!this.disposed &&
			!abort.signal.aborted &&
			this.activityGeneration === generation &&
			this.activity === activity &&
			isIdleRecapEligible(activity) &&
			normalizedReply !== undefined
		) {
			this.onStatus(normalizedReply, request);
		}
		this.currentState = "settled";
	}

	private cancelPending(): void {
		if (this.timer !== undefined) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}
		this.inFlight?.abort.abort();
		this.inFlight = undefined;
	}
}

export function isIdleRecapEligible(activity: IdleRecapActivity): boolean {
	return (
		activity.sessionId.length > 0 &&
		activity.ownerGeneration > 0 &&
		activity.driverRevision >= 0 &&
		activity.driverAttached &&
		activity.editorEmpty &&
		!activity.streaming &&
		activity.maintenance === "idle" &&
		activity.recoveryBarrier === "closed" &&
		activity.hasModel &&
		activity.hasHistory &&
		activity.selectionDigest.length > 0
	);
}

const ANSI_ESCAPE_PATTERN = /\u001b(?:\][^\u0007]*(?:\u0007|\u001b\\)|\[[0-?]*[ -/]*[@-~])/gu;
const CONTROL_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu;
const MAX_RECAP_REPLY_BYTES = 4 * 1024;
const MAX_RECAP_DISPLAY_CELLS = 280;

/** 将 side-channel 回复规整为一行、脱 ANSI、受 byte/display-cell 双重预算约束。 */
export function normalizeIdleRecapText(replyText: string): string | undefined {
	const clean = replyText.replace(ANSI_ESCAPE_PATTERN, "").replace(CONTROL_PATTERN, "");
	if (Buffer.byteLength(clean, "utf8") > MAX_RECAP_REPLY_BYTES) return undefined;
	const first = clean
		.split(/\r?\n/u)
		.map((line) => line.trim())
		.find((line) => line.length > 0 && !/^```(?:[A-Za-z0-9_-]+)?$/u.test(line));
	if (first === undefined) return undefined;
	const withoutFence = first.replace(/^```(?:[A-Za-z0-9_-]+)?\s*/u, "").replace(/\s*```$/u, "").trim();
	if (withoutFence.length === 0) return undefined;
	return truncateDisplayWidth(withoutFence, MAX_RECAP_DISPLAY_CELLS);
}

function truncateDisplayWidth(value: string, width: number): string {
	if (stringWidth(value) <= width) return value;
	let result = "";
	let used = 0;
	for (const character of Array.from(value)) {
		const next = stringWidth(character);
		if (used + next > width - 1) break;
		result += character;
		used += next;
	}
	return `${result}…`;
}
