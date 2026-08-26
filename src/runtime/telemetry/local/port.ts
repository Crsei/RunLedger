import type { TelemetryCorrelationContext, TelemetryObservation } from "./types.ts";

export type LocalTelemetryResult =
	| { readonly ok: true }
	| { readonly ok: false; readonly code: string };

export interface LocalTelemetryPort {
	observe(observation: TelemetryObservation): Promise<LocalTelemetryResult>;
	bind<T>(correlation: TelemetryCorrelationContext, operation: () => Promise<T>): Promise<T>;
	currentCorrelation(): TelemetryCorrelationContext | undefined;
	forceSample(reason: "run" | "turn" | "process" | "checkpoint" | "progress"): Promise<void>;
	close(): Promise<void>;
}
