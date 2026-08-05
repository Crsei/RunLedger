import type { CorrelatedRequestRef, TuiError } from "./common.ts";

export type TuiResultStatus = "completed" | "failed" | "stale" | "aborted" | "uncertain";

export type TuiResult =
	| { readonly status: "completed"; readonly ref: CorrelatedRequestRef; readonly value: unknown }
	| { readonly status: "failed"; readonly ref: CorrelatedRequestRef; readonly error: TuiError }
	| { readonly status: "stale"; readonly ref: CorrelatedRequestRef; readonly currentGeneration: number }
	| { readonly status: "aborted"; readonly ref: CorrelatedRequestRef; readonly reason: string }
	| { readonly status: "uncertain"; readonly ref: CorrelatedRequestRef; readonly error: TuiError & { readonly recoveryRequired: true }; readonly recoveryRequired: true };
