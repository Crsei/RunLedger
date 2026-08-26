import { canonicalJson } from "../../protocol/canonical-json.ts";
import { createRuntimeId, type EventId, type ExecutionId } from "../../protocol/ids.ts";
import type { LocalTelemetryResult } from "./port.ts";
import type {
	ObservedQuantity,
	TelemetryCorrelationContext,
	TelemetryObservation,
} from "./types.ts";

export interface MemorySchedulerHandle {
	unref?(): void;
	clear(): void;
}

export interface MemoryScheduler {
	setInterval(callback: () => void, milliseconds: number): MemorySchedulerHandle;
}

export interface RuntimeMemoryUsage {
	readonly rss: number;
	readonly heapTotal: number;
	readonly heapUsed: number;
	readonly external: number;
	readonly arrayBuffers: number;
}

export interface RuntimeMemorySamplerOptions {
	readonly correlation: TelemetryCorrelationContext | (() => TelemetryCorrelationContext | undefined);
	readonly observe: (observation: Extract<TelemetryObservation, { kind: "runtime_memory" }>) => Promise<LocalTelemetryResult> | LocalTelemetryResult;
	readonly scheduler?: MemoryScheduler;
	readonly memoryUsage?: () => RuntimeMemoryUsage;
	readonly now?: () => number;
	readonly date?: () => Date;
	readonly createObservationId?: () => EventId;
}

const LIGHT_SAMPLE_INTERVAL_MS = 2_000;
const FULL_SAMPLE_INTERVAL_MS = 10_000;

const defaultScheduler: MemoryScheduler = {
	setInterval(callback, milliseconds) {
		const handle = setInterval(callback, milliseconds);
		return {
			unref: () => { handle.unref(); },
			clear: () => { clearInterval(handle); },
		};
	},
};

function availableBytes(value: number, accuracy: "sampled" | "exact" = "sampled"): ObservedQuantity<"bytes"> {
	return Number.isSafeInteger(value) && value >= 0
		? { availability: "available", unit: "bytes", value, accuracy, source: "runtime_meter" }
		: { availability: "unavailable", unit: "bytes", reason: "sample_failed" };
}

function unavailableBytes(): ObservedQuantity<"bytes"> {
	return { availability: "unavailable", unit: "bytes", reason: "not_applicable" };
}

function correlationOf(value: RuntimeMemorySamplerOptions["correlation"]): TelemetryCorrelationContext | undefined {
	return typeof value === "function" ? value() : value;
}

export class RuntimeMemorySampler {
	readonly #options: RuntimeMemorySamplerOptions;
	readonly #scheduler: MemoryScheduler;
	readonly #memoryUsage: () => RuntimeMemoryUsage;
	readonly #now: () => number;
	readonly #date: () => Date;
	readonly #createObservationId: () => EventId;
	readonly #handles: MemorySchedulerHandle[] = [];
	#started = false;
	#closed = false;
	#startedAt = 0;
	#pendingFailure: unknown;

	public constructor(options: RuntimeMemorySamplerOptions) {
		this.#options = options;
		this.#scheduler = options.scheduler ?? defaultScheduler;
		this.#memoryUsage = options.memoryUsage ?? (() => process.memoryUsage());
		this.#now = options.now ?? (() => performance.now());
		this.#date = options.date ?? (() => new Date());
		this.#createObservationId = options.createObservationId ?? (() => createRuntimeId("event") as EventId);
	}

	public async start(): Promise<void> {
		if (this.#started || this.#closed) return;
		this.#started = true;
		this.#startedAt = this.#now();
		this.#handles.push(this.#scheduler.setInterval(() => { void this.#sample(false).catch((error: unknown) => { this.#pendingFailure ??= error; }); }, LIGHT_SAMPLE_INTERVAL_MS));
		this.#handles.push(this.#scheduler.setInterval(() => { void this.#sample(true).catch((error: unknown) => { this.#pendingFailure ??= error; }); }, FULL_SAMPLE_INTERVAL_MS));
		for (const handle of this.#handles) handle.unref?.();
	}

	public async forceSample(_reason: "run" | "turn" | "process" | "checkpoint" | "progress"): Promise<void> {
		if (this.#closed) return;
		if (this.#pendingFailure !== undefined) throw this.#pendingFailure;
		if (!this.#started) await this.start();
		await this.#sample(true);
	}

	public async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		for (const handle of this.#handles) handle.clear();
		this.#handles.length = 0;
	}

	async #sample(full: boolean): Promise<void> {
		if (this.#closed) return;
		const correlation = correlationOf(this.#options.correlation);
		if (correlation === undefined) return;
		let usage: RuntimeMemoryUsage;
		try {
			usage = this.#memoryUsage();
		} catch {
			return;
		}
		const base = {
			format: "runledger.telemetry.observation" as const,
			observationId: this.#createObservationId(),
			observedAt: this.#date().toISOString(),
			monotonicOffsetMs: Math.max(0, Math.floor(this.#now() - this.#startedAt)),
			correlation,
		};
		const observation: Extract<TelemetryObservation, { kind: "runtime_memory" }> = {
			...base,
			kind: "runtime_memory",
			rssBytes: availableBytes(usage.rss),
			heapTotalBytes: full ? availableBytes(usage.heapTotal) : unavailableBytes(),
			heapUsedBytes: full ? availableBytes(usage.heapUsed) : unavailableBytes(),
			externalBytes: full ? availableBytes(usage.external) : unavailableBytes(),
			arrayBuffersBytes: full ? availableBytes(usage.arrayBuffers) : unavailableBytes(),
		};
		await this.#options.observe(observation);
	}
}

export interface LogicalSessionStateInput {
	readonly messages: unknown;
	readonly toolResults: unknown;
	readonly planTask: unknown;
	readonly checkpointDescriptor: unknown;
	readonly contextCurrentTokens?: number;
	readonly contextCurrentTokensAccuracy?: "exact" | "estimated";
}

export interface LogicalSessionStateSize {
	readonly ok: true;
	readonly totalBytes: number;
	readonly components: {
		readonly messagesBytes: number;
		readonly toolResultsBytes: number;
		readonly planTaskBytes: number;
		readonly checkpointDescriptorBytes: number;
	};
	readonly contextCurrentTokens?: number;
}

export type LogicalSessionStateSizeResult =
	| LogicalSessionStateSize
	| { readonly ok: false; readonly code: "serialization_failed" | "size_overflow" };

/** 对当前格式 DTO 的各组件做 canonical JSON UTF-8 计数，不保存组件正文。 */
export function sizeLogicalSessionState(input: LogicalSessionStateInput): LogicalSessionStateSizeResult {
	try {
		const sizes = {
			messagesBytes: Buffer.byteLength(canonicalJson(input.messages), "utf8"),
			toolResultsBytes: Buffer.byteLength(canonicalJson(input.toolResults), "utf8"),
			planTaskBytes: Buffer.byteLength(canonicalJson(input.planTask), "utf8"),
			checkpointDescriptorBytes: Buffer.byteLength(canonicalJson(input.checkpointDescriptor), "utf8"),
		};
		const totalBytes = Object.values(sizes).reduce((total, value) => total + value, 0);
		if (!Number.isSafeInteger(totalBytes)) return { ok: false, code: "size_overflow" };
		if (input.contextCurrentTokens !== undefined && (!Number.isSafeInteger(input.contextCurrentTokens) || input.contextCurrentTokens < 0)) return { ok: false, code: "serialization_failed" };
		return {
			ok: true,
			totalBytes,
			components: sizes,
			...(input.contextCurrentTokens === undefined ? {} : { contextCurrentTokens: input.contextCurrentTokens }),
		};
	} catch {
		return { ok: false, code: "serialization_failed" };
	}
}

export interface LinuxProcessIdentity {
	readonly pid: number;
	readonly startTime: number;
}

export interface LinuxProcessTreeSamplerOptions {
	readonly root: LinuxProcessIdentity;
	readonly listDirectory: () => Promise<readonly string[]>;
	readonly readFile: (path: string) => Promise<string>;
}

export type LinuxProcessTreeSample =
	| { readonly ok: true; readonly rssBytes: number; readonly pssBytes: number; readonly ussBytes: number; readonly processCount: number }
	| { readonly ok: false; readonly reason: "platform_unsupported" | "permission_denied" | "sample_failed" };

interface ProcEntry extends LinuxProcessIdentity {
	readonly parentPid: number;
}

/** Linux-only private adapter. PID/starttime are input identity, never public observation fields. */
export class LinuxProcessTreeSampler {
	readonly #options: LinuxProcessTreeSamplerOptions;

	public constructor(options: LinuxProcessTreeSamplerOptions) {
		this.#options = options;
	}

	public async sample(): Promise<LinuxProcessTreeSample> {
		try {
			const names = (await this.#options.listDirectory()).filter((name) => /^\d+$/u.test(name));
			const entries: ProcEntry[] = [];
			for (const name of names) {
				let entry: ProcEntry | undefined;
				try {
					entry = parseProcStat(await this.#options.readFile(`/proc/${name}/stat`));
				} catch (error) {
					if (isProcessGone(error)) {
						if (Number(name) === this.#options.root.pid) return { ok: false, reason: "sample_failed" };
						continue;
					}
					throw error;
				}
				if (entry === undefined) {
					if (Number(name) === this.#options.root.pid) return { ok: false, reason: "sample_failed" };
					continue;
				}
				entries.push(entry);
			}
			const root = entries.find((entry) => entry.pid === this.#options.root.pid);
			if (root === undefined || root.startTime !== this.#options.root.startTime) return { ok: false, reason: "sample_failed" };
			const selected = new Set<number>([root.pid]);
			let changed = true;
			while (changed) {
				changed = false;
				for (const entry of entries) {
					if (selected.has(entry.pid) || !selected.has(entry.parentPid)) continue;
					selected.add(entry.pid);
					changed = true;
				}
			}
			let rssBytes = 0;
			let pssBytes = 0;
			let ussBytes = 0;
			for (const pid of selected) {
				const identity = entries.find((entry) => entry.pid === pid);
				if (identity === undefined) return { ok: false, reason: "sample_failed" };
				const status = await this.#options.readFile(`/proc/${pid}/status`);
				const smaps = await this.#options.readFile(`/proc/${pid}/smaps_rollup`);
				const after = parseProcStat(await this.#options.readFile(`/proc/${pid}/stat`));
				if (after === undefined || after.startTime !== identity.startTime || after.parentPid !== identity.parentPid) {
					return { ok: false, reason: "sample_failed" };
				}
				rssBytes += parseKib(status, "VmRSS");
				pssBytes += parseKib(smaps, "Pss");
				ussBytes += parseKib(smaps, "Private_Clean") + parseKib(smaps, "Private_Dirty");
			}
			if (![rssBytes, pssBytes, ussBytes].every((value) => Number.isSafeInteger(value) && value >= 0)) return { ok: false, reason: "sample_failed" };
			return { ok: true, rssBytes, pssBytes, ussBytes, processCount: selected.size };
		} catch (error) {
			return { ok: false, reason: processMemoryFailureReason(error) };
		}
	}
}

function processMemoryFailureReason(error: unknown): "permission_denied" | "sample_failed" {
		if (typeof error !== "object" || error === null) return "sample_failed";
		const value = error as { readonly code?: unknown; readonly message?: unknown };
		if (value.code === "EACCES" || value.code === "EPERM") return "permission_denied";
		return typeof value.message === "string" && /permission denied|operation not permitted/iu.test(value.message)
			? "permission_denied"
			: "sample_failed";
}

function isProcessGone(error: unknown): boolean {
		if (typeof error !== "object" || error === null) return false;
		const value = error as { readonly code?: unknown; readonly message?: unknown };
		return value.code === "ENOENT" || (typeof value.message === "string" && /no such file|not found/iu.test(value.message));
}

export function parseProcStat(line: string): ProcEntry | undefined {
	const close = line.lastIndexOf(")");
	if (close < 0) return undefined;
	const pid = Number(line.slice(0, line.indexOf(" ")));
	const fields = line.slice(close + 1).trim().split(/\s+/u);
	const parentPid = Number(fields[1]);
	const startTime = Number(fields[19]);
	if (![pid, parentPid, startTime].every((value) => Number.isSafeInteger(value) && value >= 0)) return undefined;
	return { pid, parentPid, startTime };
}

function parseKib(text: string, field: string): number {
	const match = new RegExp(`^${field}:\\s+(\\d+)\\s+kB$`, "mu").exec(text);
	if (match === null) throw new Error(`missing ${field}`);
	const kib = Number(match[1]);
	if (!Number.isSafeInteger(kib)) throw new Error(`invalid ${field}`);
	return kib * 1024;
}

export function unsupportedManagedProcessMemory(): LinuxProcessTreeSample {
	return { ok: false, reason: "platform_unsupported" };
}

export function processMemoryCorrelation(
	correlation: TelemetryCorrelationContext,
	executionId: ExecutionId,
): TelemetryCorrelationContext {
	return { ...correlation, executionId };
}

export interface MemoryObservationPort {
	observe(observation: TelemetryObservation): Promise<LocalTelemetryResult>;
}

function observationQuantity(value: number, source: "canonical_serialization" | "linux_proc", accuracy: "exact" | "sampled"): ObservedQuantity<"bytes"> {
	return Number.isSafeInteger(value) && value >= 0
		? { availability: "available", unit: "bytes", value, accuracy, source }
		: { availability: "unavailable", unit: "bytes", reason: "sample_failed" };
}

function unavailableQuantity<TUnit extends "bytes" | "tokens" | "count">(unit: TUnit, reason: "sample_failed" | "provider_usage_missing" | "platform_unsupported" | "permission_denied"): ObservedQuantity<TUnit> {
	return { availability: "unavailable", unit, reason };
}

export async function recordLogicalSessionState(
	port: MemoryObservationPort,
	input: {
		readonly correlation: TelemetryCorrelationContext;
		readonly state: LogicalSessionStateInput;
		readonly observedAt?: Date;
		readonly monotonicOffsetMs?: number;
	},
): Promise<LocalTelemetryResult> {
	const sized = sizeLogicalSessionState(input.state);
	const unavailable = sized.ok ? undefined : sized.code === "size_overflow" ? "sample_failed" as const : "sample_failed" as const;
	const observation: Extract<TelemetryObservation, { kind: "logical_session_state" }> = {
		format: "runledger.telemetry.observation",
		observationId: createRuntimeId("event") as EventId,
		observedAt: (input.observedAt ?? new Date()).toISOString(),
		monotonicOffsetMs: Math.max(0, Math.floor(input.monotonicOffsetMs ?? 0)),
		correlation: input.correlation,
		kind: "logical_session_state",
		totalBytes: sized.ok ? observationQuantity(sized.totalBytes, "canonical_serialization", "exact") : unavailableQuantity("bytes", unavailable ?? "sample_failed"),
		messagesBytes: sized.ok ? observationQuantity(sized.components.messagesBytes, "canonical_serialization", "exact") : unavailableQuantity("bytes", unavailable ?? "sample_failed"),
		toolResultsBytes: sized.ok ? observationQuantity(sized.components.toolResultsBytes, "canonical_serialization", "exact") : unavailableQuantity("bytes", unavailable ?? "sample_failed"),
		planTaskBytes: sized.ok ? observationQuantity(sized.components.planTaskBytes, "canonical_serialization", "exact") : unavailableQuantity("bytes", unavailable ?? "sample_failed"),
		checkpointDescriptorBytes: sized.ok ? observationQuantity(sized.components.checkpointDescriptorBytes, "canonical_serialization", "exact") : unavailableQuantity("bytes", unavailable ?? "sample_failed"),
		contextCurrentTokens: sized.ok && sized.contextCurrentTokens !== undefined
			? {
				availability: "available",
				unit: "tokens",
				value: sized.contextCurrentTokens,
				accuracy: input.state.contextCurrentTokensAccuracy ?? "exact",
				source: input.state.contextCurrentTokensAccuracy === "estimated" ? "derived" : "provider_reported",
			}
			: unavailableQuantity("tokens", "provider_usage_missing"),
	};
	return port.observe(observation);
}

export async function recordManagedProcessMemory(
	port: MemoryObservationPort,
	input: {
		readonly correlation: TelemetryCorrelationContext;
		readonly sample: LinuxProcessTreeSample;
		readonly observedAt?: Date;
		readonly monotonicOffsetMs?: number;
	},
): Promise<LocalTelemetryResult> {
	const unavailableReason = input.sample.ok ? undefined : input.sample.reason;
	const reason = unavailableReason ?? "sample_failed";
	const observation: Extract<TelemetryObservation, { kind: "managed_process_memory" }> = {
		format: "runledger.telemetry.observation",
		observationId: createRuntimeId("event") as EventId,
		observedAt: (input.observedAt ?? new Date()).toISOString(),
		monotonicOffsetMs: Math.max(0, Math.floor(input.monotonicOffsetMs ?? 0)),
		correlation: input.correlation,
		kind: "managed_process_memory",
		rssBytes: input.sample.ok ? observationQuantity(input.sample.rssBytes, "linux_proc", "sampled") : unavailableQuantity("bytes", reason),
		pssBytes: input.sample.ok ? observationQuantity(input.sample.pssBytes, "linux_proc", "sampled") : unavailableQuantity("bytes", reason),
		ussBytes: input.sample.ok ? observationQuantity(input.sample.ussBytes, "linux_proc", "sampled") : unavailableQuantity("bytes", reason),
		observedProcessCount: input.sample.ok
			? { availability: "available", unit: "count", value: input.sample.processCount, accuracy: "sampled", source: "linux_proc" }
			: unavailableQuantity("count", reason),
	};
	return port.observe(observation);
}

export interface ManagedProcessMemorySamplerOptions {
	readonly root: LinuxProcessIdentity;
	readonly correlation: TelemetryCorrelationContext;
	readonly observe: MemoryObservationPort;
	readonly listDirectory?: () => Promise<readonly string[]>;
	readonly readFile?: (path: string) => Promise<string>;
	readonly scheduler?: MemoryScheduler;
	readonly date?: () => Date;
	readonly now?: () => number;
}

/** Managed execution 的 Linux 2s sampler；结束时由 Host 显式 force/close。 */
export class ManagedProcessMemorySampler {
	readonly #options: ManagedProcessMemorySamplerOptions;
	readonly #scheduler: MemoryScheduler;
	readonly #date: () => Date;
	readonly #now: () => number;
	readonly #handles: MemorySchedulerHandle[] = [];
	#started = false;
	#closed = false;
	#startedAt = 0;
	#pendingFailure: unknown;

	public constructor(options: ManagedProcessMemorySamplerOptions) {
		this.#options = options;
		this.#scheduler = options.scheduler ?? defaultScheduler;
		this.#date = options.date ?? (() => new Date());
		this.#now = options.now ?? (() => performance.now());
	}

	public async start(): Promise<void> {
		if (this.#started || this.#closed) return;
		this.#started = true;
		this.#startedAt = this.#now();
		this.#handles.push(this.#scheduler.setInterval(() => { void this.sample().catch((error: unknown) => { this.#pendingFailure ??= error; }); }, LIGHT_SAMPLE_INTERVAL_MS));
		for (const handle of this.#handles) handle.unref?.();
	}

	public async sample(): Promise<void> {
		if (this.#closed) return;
		const tree = new LinuxProcessTreeSampler({
			root: this.#options.root,
			listDirectory: this.#options.listDirectory ?? (async () => []),
			readFile: this.#options.readFile ?? (async () => { throw new Error("Linux process reader is unavailable"); }),
		});
		const result = await tree.sample();
		await recordManagedProcessMemory(this.#options.observe, {
			correlation: this.#options.correlation,
			sample: result,
			observedAt: this.#date(),
			monotonicOffsetMs: Math.max(0, Math.floor(this.#now() - this.#startedAt)),
		});
	}

	public async forceSample(): Promise<void> {
		if (this.#closed) return;
		if (this.#pendingFailure !== undefined) throw this.#pendingFailure;
		if (!this.#started) {
			this.#started = true;
			this.#startedAt = this.#now();
		}
		await this.sample();
	}

	public async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		for (const handle of this.#handles) handle.clear();
		this.#handles.length = 0;
	}
}
