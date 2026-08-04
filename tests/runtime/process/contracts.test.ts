import { describe, expect, it } from "vitest";
import { Value } from "typebox/value";
import { createRuntimeId } from "../../../src/runtime/protocol/ids.ts";
import type { RuntimeDigest, RuntimeContentRef } from "../../../src/runtime/protocol/foundation.ts";
import {
	ExecutionHandleRefSchema,
	ManagedProcessRequestSchema,
	validateManagedProcessRequest,
	type ExecutionHandleRef,
	type ManagedProcessRequest,
} from "../../../src/runtime/process/schemas.ts";
import {
	createInitialProcessProjection,
	projectProcessEvents,
	transitionProcess,
	type ProcessProjection,
} from "../../../src/runtime/process/state-machine.ts";
import {
	createProcessEvent,
	processEventDigest,
	ProcessEventSchema,
	type ProcessEvent,
} from "../../../src/runtime/process/events.ts";
import { PROCESS_OUTPUT_BOUNDS, clipUtf8Output, isOutputCursorValid } from "../../../src/runtime/process/output.ts";

const digest = (seed: string): RuntimeDigest => ({
	algorithm: "sha256",
	digest: seed.repeat(64).slice(0, 64) as RuntimeDigest["digest"],
});

const ref = (subjectKind: RuntimeContentRef["subjectKind"], seed: string): RuntimeContentRef => ({
	subjectKind,
	digest: digest(seed),
	mediaType: "application/json",
	size: 10,
});

const requestedFields = {
	commandId: createRuntimeId("command", "projection-request"),
	managedRequestDigest: digest("e"),
	backend: "pipe" as const,
	executionMode: "foreground" as const,
};

function handle(): ExecutionHandleRef {
	return {
		authorityId: createRuntimeId("authority", "process"),
		tenantId: createRuntimeId("tenant", "process"),
		workspaceId: createRuntimeId("workspace", "process"),
		sessionId: createRuntimeId("session", "process"),
		hostGeneration: 3,
		sessionGeneration: 5,
		executionId: createRuntimeId("execution", "process"),
		attemptId: createRuntimeId("attempt", "process"),
		revision: 0,
		requestDigest: digest("a"),
	};
}

function request(): ManagedProcessRequest {
	return {
		authorityId: createRuntimeId("authority", "process-request"),
		tenantId: createRuntimeId("tenant", "process-request"),
		workspaceId: createRuntimeId("workspace", "process-request"),
		sessionId: createRuntimeId("session", "process-request"),
		hostGeneration: 3,
		sessionGeneration: 5,
		requestDigest: digest("b"),
		commandRef: ref("content", "c"),
		cwdRef: ref("content", "d"),
		backend: "pipe",
		executionMode: "background",
		timeoutMs: 1_000,
		correlationId: createRuntimeId("command", "process"),
	};
}

describe("R1 managed process public contracts", () => {
	it("accepts current-format safe DTOs and rejects PID/path/raw command leakage", () => {
		expect(Value.Check(ExecutionHandleRefSchema, handle())).toBe(true);
		expect(Value.Check(ExecutionHandleRefSchema, {
		...handle(),
		workspaceId: createRuntimeId("session", "wrong-scope"),
	})).toBe(false);
		expect(Value.Check(ExecutionHandleRefSchema, { ...handle(), pid: 42 })).toBe(false);
		expect(Value.Check(ExecutionHandleRefSchema, { ...handle(), outputPath: "/tmp/out" })).toBe(false);
		expect(Value.Check(ManagedProcessRequestSchema, request())).toBe(true);
		expect(Value.Check(ManagedProcessRequestSchema, { ...request(), command: "echo secret" })).toBe(false);
		expect(Value.Check(ManagedProcessRequestSchema, { ...request(), cwd: "/private" })).toBe(false);
	});

	it("rejects a request whose canonical frame exceeds the frozen bound", () => {
		const oversized = { ...request(), extra: "x".repeat(300_000) };
		const result = validateManagedProcessRequest(oversized);
		expect(result).toMatchObject({ ok: false, code: "oversized_payload" });
	});
});

describe("R1 deterministic process state and event projection", () => {
	it("accepts only legal transitions and makes terminal states immutable", () => {
		const initial = createInitialProcessProjection(handle());
		const starting = transitionProcess(initial, {
			type: "process.execution_starting",
			nextState: "starting",
			expectedRevision: 0,
		});
		expect(starting).toMatchObject({ ok: true, state: { state: "starting", revision: 1 } });
		if (!starting.ok) return;
		const running = transitionProcess(starting.state, {
			type: "process.execution_started",
			nextState: "running",
			expectedRevision: 1,
			spawnReceiptDigest: digest("s"),
		});
		expect(running).toMatchObject({ ok: true, state: { state: "running", revision: 2 } });
		if (!running.ok) return;
		const terminal = transitionProcess(running.state, {
			type: "process.execution_terminal",
			nextState: "completed",
			expectedRevision: 2,
			terminal: { state: "completed", evidenceRef: ref("receipt", "t") },
		});
		expect(terminal).toMatchObject({ ok: true, state: { state: "completed", revision: 3 } });
		if (!terminal.ok) return;
		expect(transitionProcess(terminal.state, {
			type: "process.execution_terminal",
			nextState: "completed",
			expectedRevision: 3,
			terminal: { state: "completed", evidenceRef: ref("receipt", "t") },
		})).toMatchObject({ ok: false, code: "terminal_state_immutable" });
		expect(transitionProcess(terminal.state, {
			type: "process.execution_started",
			nextState: "running",
			expectedRevision: 3,
		})).toMatchObject({ ok: false, code: "terminal_state_immutable" });
		expect(transitionProcess(running.state, {
			type: "process.execution_started",
			nextState: "queued",
			expectedRevision: 2,
		})).toMatchObject({ ok: false, code: "illegal_process_transition" });
	});

	it("rejects event types that do not match their state transition", () => {
		const initial = createInitialProcessProjection(handle());
		expect(transitionProcess(initial, {
			type: "process.output_checkpointed",
			nextState: "starting",
			expectedRevision: 0,
		})).toMatchObject({ ok: false, code: "illegal_process_transition" });
	});

	it("rebuilds the same projection from valid events and rejects digest tampering", () => {
		const processHandle = handle();
		const requested = createProcessEvent({
			...requestedFields,
			handle: processHandle,
			sequence: 0,
			revision: 0,
			type: "process.execution_requested",
			previousState: null,
			nextState: "queued",
			previousEventHash: null,
		});
		const starting = createProcessEvent({
			handle: processHandle,
			sequence: 1,
			revision: 1,
			type: "process.execution_starting",
			previousState: "queued",
			nextState: "starting",
			previousEventHash: requested.eventHash,
		});
		expect(Value.Check(ProcessEventSchema, requested)).toBe(true);
		expect(Value.Check(ProcessEventSchema, { ...requested, privatePath: "/tmp/out" })).toBe(false);
		const projected = projectProcessEvents([requested, starting]);
		expect(projected).toMatchObject({ ok: true, state: { state: "starting", revision: 1 } });
		if (!projected.ok) return;
		const rebuilt = projectProcessEvents([requested, starting]);
		expect(rebuilt).toEqual(projected);

		const tampered = { ...starting, nextState: "running" as const };
		expect(projectProcessEvents([requested, tampered])).toMatchObject({ ok: false, code: "event_digest_mismatch" });
	});

	it("rejects replay when an event lies about its previous state", () => {
		const processHandle = handle();
		const requested = createProcessEvent({
			...requestedFields,
			handle: processHandle,
			sequence: 0,
			revision: 0,
			type: "process.execution_requested",
			previousState: null,
			nextState: "queued",
			previousEventHash: null,
		});
		const starting = createProcessEvent({
			handle: processHandle,
			sequence: 1,
			revision: 1,
			type: "process.execution_starting",
			previousState: "running",
			nextState: "starting",
			previousEventHash: requested.eventHash,
		});
		expect(projectProcessEvents([requested, starting])).toMatchObject({
			ok: false,
			code: "event_previous_state_mismatch",
		});
	});

	it("rejects event-specific payload fields on the wrong event type", () => {
		const processHandle = handle();
		const requested = createProcessEvent({
			...requestedFields,
			handle: processHandle,
			sequence: 0,
			revision: 0,
			type: "process.execution_requested",
			previousState: null,
			nextState: "queued",
			previousEventHash: null,
		});
		const starting = createProcessEvent({
			handle: processHandle,
			sequence: 1,
			revision: 1,
			type: "process.execution_starting",
			previousState: "queued",
			nextState: "starting",
			previousEventHash: requested.eventHash,
		});
		const startedWithCheckpointPayload = createProcessEvent({
			handle: processHandle,
			sequence: 2,
			revision: 2,
			type: "process.execution_started",
			previousState: "starting",
			nextState: "running",
			previousEventHash: starting.eventHash,
			spawnReceiptDigest: digest("f"),
			outputCursor: 4,
			outputSize: 4,
		});
		expect(projectProcessEvents([requested, starting, startedWithCheckpointPayload])).toMatchObject({
			ok: false,
			code: "event_payload_invalid",
		});
	});

	it("replays a structured UTF-8 output cursor through the durable process event", () => {
		const processHandle = handle();
		const requested = createProcessEvent({
			...requestedFields,
			handle: processHandle,
			sequence: 0,
			revision: 0,
			type: "process.execution_requested",
			previousState: null,
			nextState: "queued",
			previousEventHash: null,
		});
		const starting = createProcessEvent({
			handle: processHandle,
			sequence: 1,
			revision: 1,
			type: "process.execution_starting",
			previousState: "queued",
			nextState: "starting",
			previousEventHash: requested.eventHash,
		});
		const started = createProcessEvent({
			handle: processHandle,
			sequence: 2,
			revision: 2,
			type: "process.execution_started",
			previousState: "starting",
			nextState: "running",
			previousEventHash: starting.eventHash,
			spawnReceiptDigest: digest("f"),
		});
		const checkpoint = createProcessEvent({
			handle: processHandle,
			sequence: 3,
			revision: 3,
			type: "process.output_checkpointed",
			previousState: "running",
			nextState: "running",
			previousEventHash: started.eventHash,
			outputCursor: { sequence: 7, byteOffset: 4 },
			outputSize: 4,
		});

		expect(projectProcessEvents([requested, starting, started, checkpoint])).toMatchObject({
			ok: true,
			state: { outputCursor: { sequence: 7, byteOffset: 4 }, outputSize: 4 },
		});
	});

	it("rejects a valid-hash terminal event whose evidence is missing", () => {
		const processHandle = handle();
		const requested = createProcessEvent({
			...requestedFields,
			handle: processHandle,
			sequence: 0,
			revision: 0,
			type: "process.execution_requested",
			previousState: null,
			nextState: "queued",
			previousEventHash: null,
		});
		const starting = createProcessEvent({
			handle: processHandle,
			sequence: 1,
			revision: 1,
			type: "process.execution_starting",
			previousState: "queued",
			nextState: "starting",
			previousEventHash: requested.eventHash,
		});
		const started = createProcessEvent({
			handle: processHandle,
			sequence: 2,
			revision: 2,
			type: "process.execution_started",
			previousState: "starting",
			nextState: "running",
			previousEventHash: starting.eventHash,
			spawnReceiptDigest: digest("f"),
		});
		const validTerminal = createProcessEvent({
			handle: processHandle,
			sequence: 3,
			revision: 3,
			type: "process.execution_terminal",
			previousState: "running",
			nextState: "completed",
			previousEventHash: started.eventHash,
			terminal: { state: "completed", evidenceRef: ref("receipt", "a") },
		});
		const { eventHash: _eventHash, ...validBody } = validTerminal;
		void _eventHash;
		const malformedBody = {
			...validBody,
			terminal: { state: "completed" },
		} as unknown as Omit<ProcessEvent, "eventHash">;
		const malformed = {
			...malformedBody,
			eventHash: processEventDigest(malformedBody),
		};
		expect(projectProcessEvents([requested, starting, started, malformed])).toMatchObject({
			ok: false,
			code: "event_payload_invalid",
		});
	});
});

describe("R1 bounded process output", () => {
	it("clips at a UTF-8 code-point boundary and rejects cursor overflow", () => {
		const clipped = clipUtf8Output("a🪐b", 5);
		expect(clipped.text).toBe("a🪐");
		expect(clipped.truncated).toBe(true);
		expect(clipped.byteLength).toBe(5);
		expect(PROCESS_OUTPUT_BOUNDS.maxPageBytes).toBeGreaterThan(0);
		expect(isOutputCursorValid({ sequence: 2, byteOffset: 5 }, { sequence: 2, byteOffset: 5 })).toBe(true);
		expect(isOutputCursorValid({ sequence: 3, byteOffset: 6 }, { sequence: 2, byteOffset: 5 })).toBe(false);
	});
});

void ({} as ProcessProjection);
