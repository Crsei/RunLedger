/** Model-facing managed-process tool contracts. */

import { Type } from "typebox";
import type { Static } from "typebox";
import type { RuntimeContentRef, RuntimeDigest } from "../protocol/foundation.ts";
import type { ExecutionHandleRef } from "../process/types.ts";
import { ExecutionHandleRefSchema } from "../process/schemas.ts";
import type { ControlPlaneActor, ControlPlaneOutputResult, ControlPlaneWaitResult, ControlPlaneMutationResult } from "../../storage/process/control-plane.ts";
import { RUNTIME_HOST_BOUNDS } from "../host/types.ts";

export const processHandleSchema = ExecutionHandleRefSchema;
export type ProcessToolHandle = Static<typeof processHandleSchema>;

export const outputCursorSchema = Type.Object({
	sequence: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
	byteOffset: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
}, { additionalProperties: false });
export type ProcessToolCursor = Static<typeof outputCursorSchema>;

export interface ProcessToolClient {
	processOutput(handle: ExecutionHandleRef, cursor: ProcessToolCursor, maxBytes: number): Promise<ControlPlaneOutputResult>;
	processWait(handle: ExecutionHandleRef, timeoutMs: number, actor: ControlPlaneActor): Promise<ControlPlaneWaitResult>;
	write(handle: ExecutionHandleRef, actor: ControlPlaneActor, input: string): Promise<ControlPlaneMutationResult>;
	stop(handle: ExecutionHandleRef, actor: ControlPlaneActor, signal?: NodeJS.Signals): Promise<ControlPlaneMutationResult>;
	resize(handle: ExecutionHandleRef, actor: ControlPlaneActor, columns: number, rows: number): Promise<ControlPlaneMutationResult>;
}

export function toProcessHandle(value: ProcessToolHandle): ExecutionHandleRef {
	return value as unknown as ExecutionHandleRef;
}

export interface SafeProcessSummary {
	readonly state: string;
	readonly outputCursor?: ProcessToolCursor;
	readonly outputSize?: number;
	readonly capabilities?: {
		readonly canWrite: boolean;
		readonly canEof: boolean;
		readonly canResize: boolean;
		readonly canStop: boolean;
		readonly canReadOutput: boolean;
	};
	readonly terminal?: {
		readonly state: string;
		readonly exitCode?: number;
		readonly signal?: string;
		readonly durationMs?: number;
		readonly evidenceRef?: RuntimeContentRef;
	};
}

export function safeSummary(value: unknown): SafeProcessSummary {
	if (!isRecord(value) || typeof value.state !== "string") return { state: "uncertain" };
	const capabilities = isRecord(value.capabilities) &&
		typeof value.capabilities.canWrite === "boolean" &&
		typeof value.capabilities.canEof === "boolean" &&
		typeof value.capabilities.canResize === "boolean" &&
		typeof value.capabilities.canStop === "boolean" &&
		typeof value.capabilities.canReadOutput === "boolean"
		? {
				canWrite: value.capabilities.canWrite,
				canEof: value.capabilities.canEof,
				canResize: value.capabilities.canResize,
				canStop: value.capabilities.canStop,
				canReadOutput: value.capabilities.canReadOutput,
		  }
		: undefined;
	const terminal = isRecord(value.terminal) && typeof value.terminal.state === "string"
		? {
				state: value.terminal.state,
				...(typeof value.terminal.exitCode === "number" ? { exitCode: value.terminal.exitCode } : {}),
				...(typeof value.terminal.signal === "string" ? { signal: value.terminal.signal } : {}),
				...(typeof value.terminal.durationMs === "number" ? { durationMs: value.terminal.durationMs } : {}),
				...(isRuntimeContentRef(value.terminal.evidenceRef) ? { evidenceRef: value.terminal.evidenceRef } : {}),
		  }
		: undefined;
	return {
		state: value.state,
		...(isProcessToolCursor(value.outputCursor) ? { outputCursor: value.outputCursor } : {}),
		...(typeof value.outputSize === "number" ? { outputSize: value.outputSize } : {}),
		...(capabilities === undefined ? {} : { capabilities }),
		...(terminal === undefined ? {} : { terminal }),
	};
}

function isProcessToolCursor(value: unknown): value is ProcessToolCursor {
	return isRecord(value) && isSafeNonNegativeInteger(value.sequence) && isSafeNonNegativeInteger(value.byteOffset);
}

function isSafeNonNegativeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function errorToolResult(code: string, message = `managed process request failed: ${code}`): {
	content: [{ readonly type: "text"; readonly text: string }];
	details: { readonly code: string };
	isError: true;
	terminate: false;
} {
	return {
		content: [{ type: "text", text: message }],
		details: { code },
		isError: true,
		terminate: false,
	};
}

export function isBoundedPageSize(value: number): boolean {
	return Number.isSafeInteger(value) && value >= 0 && value <= RUNTIME_HOST_BOUNDS.maxOutputPageBytes;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isRuntimeContentRef(value: unknown): value is RuntimeContentRef {
	return isRecord(value) && value.subjectKind !== undefined && isRuntimeDigest(value.digest);
}

function isRuntimeDigest(value: unknown): value is RuntimeDigest {
	return isRecord(value) && value.algorithm === "sha256" && typeof value.digest === "string";
}
