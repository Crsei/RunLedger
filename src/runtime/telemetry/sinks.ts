/** 可丢弃、可重建且不会阻塞 canonical append 的 bounded exporter fanout。 */

import { canonicalDigest } from "../protocol/v3/canonical-json.ts";
import { sanitizeTelemetryObservation } from "./redaction.ts";
import {
	projectTelemetrySampleForSink,
	validateTelemetryManifest,
	type TelemetryManifest,
	type TelemetryManifestExpectation,
	type TelemetryManifestSink,
} from "./manifest.ts";
import {
	TELEMETRY_SCHEMA_VERSION,
	type ExporterHealthSignal,
	type TelemetryChannel,
	type TelemetryObservation,
	type TelemetryPublishReceipt,
	type TelemetrySample,
} from "./types.ts";

export type TelemetryExporterResult =
	| { ok: true; accepted: number }
	| { ok: false; retryable: boolean; reasonDigest: string };

export interface TelemetryExporterPort {
	readonly id: string;
	readonly channel: TelemetryChannel;
	readonly identityDigest: string;
	export(samples: readonly TelemetrySample[], signal: AbortSignal): Promise<TelemetryExporterResult>;
}

export interface BoundedTelemetryFanoutOptions {
	exporters: readonly TelemetryExporterPort[];
	manifest: TelemetryManifest;
	manifestExpectation: TelemetryManifestExpectation;
	maxQueue?: number;
	batchSize?: number;
	exporterTimeoutMs?: number;
	healthCapacity?: number;
	clock?: () => Date;
}

interface ExporterCounters {
	failureCount: number;
	droppedCount: number;
}

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
	return Math.max(minimum, Math.min(maximum, Math.trunc(value ?? fallback)));
}

function abortPromise(signal: AbortSignal): Promise<never> {
	return new Promise((_resolve, reject) => {
		if (signal.aborted) {
			reject(signal.reason instanceof Error ? signal.reason : new Error("telemetry export aborted"));
			return;
		}
		signal.addEventListener("abort", () => reject(signal.reason instanceof Error ? signal.reason : new Error("telemetry export aborted")), { once: true });
	});
}

export class BoundedTelemetryFanout {
	readonly #exporters: readonly TelemetryExporterPort[];
	readonly #maxQueue: number;
	readonly #batchSize: number;
	readonly #exporterTimeoutMs: number;
	readonly #healthCapacity: number;
	readonly #clock: () => Date;
	readonly #manifest: TelemetryManifest | undefined;
	readonly #queue: TelemetrySample[] = [];
	readonly #health: ExporterHealthSignal[] = [];
	readonly #counters = new Map<string, ExporterCounters>();
	#pump: Promise<void> | undefined;
	#closed = false;

	public constructor(options: BoundedTelemetryFanoutOptions) {
		this.#clock = options.clock ?? (() => new Date());
		const ids = new Set<string>();
		for (const exporter of options.exporters) {
			if (!/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(exporter.id) || ids.has(exporter.id)) {
				throw new TypeError("telemetry exporter ids must be valid and unique");
			}
			ids.add(exporter.id);
		}
		this.#exporters = [...options.exporters];
		this.#maxQueue = boundedInteger(options.maxQueue, 1_024, 1, 100_000);
		this.#batchSize = boundedInteger(options.batchSize, 32, 1, 1_000);
		this.#exporterTimeoutMs = boundedInteger(options.exporterTimeoutMs, 5_000, 1, 60_000);
		this.#healthCapacity = boundedInteger(options.healthCapacity, 128, 1, 4_096);
		const validatedManifest = validateTelemetryManifest(
			options.manifest,
			options.manifestExpectation,
			this.#clock(),
		);
		this.#manifest = validatedManifest.ok ? validatedManifest.value : undefined;
	}

	/** 同步入队；canonical writer 不 await exporter。 */
	public publish(observation: TelemetryObservation): TelemetryPublishReceipt {
		const sanitized = sanitizeTelemetryObservation(observation);
		if (!sanitized.ok || this.#closed) return { accepted: false, reason: "invalid_observation" };
		if (!this.#manifest) return { accepted: false, reason: "manifest_denied", sampleDigest: sanitized.value.sampleDigest };
		if (this.#queue.length >= this.#maxQueue) {
			for (const exporter of this.#exporters) this.#recordHealth(exporter, "dropping", "telemetry queue is full");
			return { accepted: false, reason: "queue_full", sampleDigest: sanitized.value.sampleDigest };
		}
		this.#queue.push(sanitized.value);
		this.#ensurePump();
		return { accepted: true, sampleDigest: sanitized.value.sampleDigest };
	}

	public healthSignals(): readonly ExporterHealthSignal[] {
		return [...this.#health];
	}

	public queueDepth(): number {
		return this.#queue.length;
	}

	public async drain(signal?: AbortSignal): Promise<void> {
		while (this.#pump || this.#queue.length > 0) {
			this.#ensurePump();
			const current = this.#pump;
			if (!current) break;
			if (signal) await Promise.race([current, abortPromise(signal)]);
			else await current;
		}
	}

	public close(): void {
		this.#closed = true;
	}

	#ensurePump(): void {
		if (this.#pump || this.#queue.length === 0) return;
		this.#pump = this.#runPump().finally(() => {
			this.#pump = undefined;
			if (this.#queue.length > 0) this.#ensurePump();
		});
	}

	async #runPump(): Promise<void> {
		while (this.#queue.length > 0) {
			const batch = this.#queue.splice(0, this.#batchSize);
			await Promise.all(this.#exporters.map((exporter) => this.#exportOne(exporter, batch)));
		}
	}

	async #exportOne(exporter: TelemetryExporterPort, samples: readonly TelemetrySample[]): Promise<void> {
		const manifest = this.#manifest;
		const sink = manifest?.sinks.find((candidate) => candidate.sinkId === exporter.id);
		if (!manifest || !sink || sink.channel !== exporter.channel || sink.exporterIdentityDigest !== exporter.identityDigest) {
			this.#recordHealth(exporter, "dropping", "telemetry exporter is outside the validated manifest");
			return;
		}
		const projected: TelemetrySample[] = [];
		for (const sample of samples) {
			if (!sampleSelected(sink, sample)) continue;
			const permitted = projectTelemetrySampleForSink(manifest, exporter.id, sample);
			if (!permitted.ok) {
				this.#recordHealth(exporter, "dropping", permitted.error.message);
				return;
			}
			projected.push(permitted.value);
		}
		if (projected.length === 0) {
			this.#recordHealth(exporter, "healthy");
			return;
		}
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(new Error("telemetry exporter deadline exceeded")), this.#exporterTimeoutMs);
		timeout.unref?.();
		try {
			const result = await Promise.race([exporter.export(projected, controller.signal), abortPromise(controller.signal)]);
			if (!result.ok) this.#recordHealth(exporter, "degraded", result.reasonDigest);
			else this.#recordHealth(exporter, "healthy");
		} catch (error) {
			this.#recordHealth(exporter, "degraded", error instanceof Error ? error.name : "UnknownError");
		} finally {
			clearTimeout(timeout);
		}
	}

	#recordHealth(exporter: TelemetryExporterPort, state: ExporterHealthSignal["state"], reason?: string): void {
		const counters = this.#counters.get(exporter.id) ?? { failureCount: 0, droppedCount: 0 };
		if (state === "degraded") counters.failureCount += 1;
		if (state === "dropping") counters.droppedCount += 1;
		this.#counters.set(exporter.id, counters);
		const signal: ExporterHealthSignal = {
			schemaVersion: TELEMETRY_SCHEMA_VERSION,
			exporterId: exporter.id,
			channel: exporter.channel,
			state,
			failureCount: counters.failureCount,
			droppedCount: counters.droppedCount,
			queueDepth: this.#queue.length,
			observedAt: this.#clock().toISOString(),
			...(reason ? { reasonDigest: /^[a-f0-9]{64}$/.test(reason) ? reason : canonicalDigest(reason) } : {}),
		};
		this.#health.push(signal);
		if (this.#health.length > this.#healthCapacity) this.#health.splice(0, this.#health.length - this.#healthCapacity);
	}
}

function sampleSelected(sink: TelemetryManifestSink, sample: TelemetrySample): boolean {
	if (sink.sampling.kind === "always") return true;
	const bucket = Number.parseInt(sample.sampleDigest.slice(0, 12), 16) % sink.sampling.denominator;
	return bucket < sink.sampling.numerator;
}
