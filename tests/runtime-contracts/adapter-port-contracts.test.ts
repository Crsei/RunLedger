import { describe, expect, it } from "vitest";
import {
	RUNTIME_ADAPTER_PORT_ACTIONS,
	RUNTIME_ADAPTER_PORT_NAMES,
	type AdapterPortRequest,
	type AdapterPortResult,
	type RuntimeAdapterPort,
	type RuntimeAdapterPortName,
} from "../../src/runtime/contracts/ports.ts";
import {
	isAdapterPortRequest,
	isAdapterPortResult,
	isAdapterProgressAnnotation,
} from "../../src/runtime/contracts/port-schemas.ts";
import { createRuntimeId } from "../../src/runtime/protocol/ids.ts";
import * as resourcePorts from "../../src/runtime/resources/ports.ts";

const digest = { algorithm: "sha256", digest: "a".repeat(64) } as const;
const receiptRef = { subjectKind: "receipt", digest } as const;
const identity = {
	authorityId: createRuntimeId("authority", "ports"),
	tenantId: createRuntimeId("tenant", "ports"),
	principalId: createRuntimeId("principal", "ports"),
	principalKind: "local",
	issuedAt: "2026-08-02T00:00:00.000Z",
} as const;

function requestFor<P extends RuntimeAdapterPortName>(port: P, action: string): AdapterPortRequest<P> {
	return {
		port,
		action,
		requestId: createRuntimeId("command", `${port}-request`),
		identity,
		traceId: createRuntimeId("trace", `${port}-request`),
		idempotencyKey: `${port}-fixture`,
		expectedRevision: 3,
		deadline: "2026-08-02T00:05:00.000Z",
		inputDigest: digest,
		inputRef: { subjectKind: "content", digest },
	};
}

function resultFor(request: AdapterPortRequest): AdapterPortResult {
	return {
		port: request.port,
		action: request.action,
		requestId: request.requestId,
		outcome: "ok",
		effect: "terminal",
		adapter: {
			adapterId: `${request.port}-fake`,
			generation: 1,
			configDigest: digest,
			trustRef: receiptRef,
			healthRef: receiptRef,
		},
		outputDigest: digest,
		outputRef: { subjectKind: "content", digest },
		receiptRef,
		completedAt: "2026-08-02T00:00:01.000Z",
	};
}

function fakePort<P extends RuntimeAdapterPortName>(_port: P): RuntimeAdapterPort<P> {
	return {
		async execute(request) {
			return resultFor(request);
		},
	};
}

describe("Runtime adapter port exact contract", () => {
	it("freezes every port and its supported action catalog", () => {
		expect(RUNTIME_ADAPTER_PORT_NAMES).toEqual([
			"runtime_event_store",
			"runtime_event_subscription",
			"workspace_service",
			"capability_gateway",
			"approval_coordinator",
			"sandbox_execution",
			"artifact_store",
			"resource_catalog",
			"resource_snapshot",
			"resource_invocation",
			"model_stream",
			"verification_runner",
			"managed_policy",
			"credential_broker",
			"forge_provider",
			"human_gate",
			"remote_executor",
			"telemetry_exporter",
		]);
		for (const port of RUNTIME_ADAPTER_PORT_NAMES) {
			expect(RUNTIME_ADAPTER_PORT_ACTIONS[port].length).toBeGreaterThan(0);
			expect(new Set(RUNTIME_ADAPTER_PORT_ACTIONS[port]).size).toBe(RUNTIME_ADAPTER_PORT_ACTIONS[port].length);
		}
	});

	it("routes resource adapters through the same three public port names", () => {
		expect(resourcePorts.RUNTIME_RESOURCE_PORT_NAMES).toEqual([
			"resource_catalog",
			"resource_snapshot",
			"resource_invocation",
		]);
		expect(resourcePorts).not.toHaveProperty("RuntimeResourceSnapshotProvider");
		expect(resourcePorts).not.toHaveProperty("RuntimeResourceEventSink");
	});

	it("validates one minimal fake consumer for every port", async () => {
		for (const port of RUNTIME_ADAPTER_PORT_NAMES) {
			const action = RUNTIME_ADAPTER_PORT_ACTIONS[port][0];
			if (!action) throw new Error(`missing fixture action for ${port}`);
			const request = requestFor(port, action);
			const fake = fakePort(port);
			const result = await fake.execute(request);

			expect(isAdapterPortRequest(request), `${port} request`).toBe(true);
			expect(isAdapterPortResult(result), `${port} result`).toBe(true);
			expect(result.requestId).toBe(request.requestId);
		}
	});

	it("rejects unknown actions, backend state, credential material, and unbounded progress", () => {
		const request = requestFor("workspace_service", "bind");
		expect(isAdapterPortRequest({ ...request, action: "backend_private_action" })).toBe(false);
		expect(isAdapterPortRequest({ ...request, credential: "raw-secret" })).toBe(false);

		const result = resultFor(request);
		expect(isAdapterPortResult({ ...result, manager: { connection: {} } })).toBe(false);
		expect(isAdapterPortResult({ ...result, adapter: { ...result.adapter, generation: -1 } })).toBe(false);

		const progress = {
			port: request.port,
			action: request.action,
			requestId: request.requestId,
			sequence: 1,
			message: "bounded progress",
			annotationDigest: digest,
			observedAt: "2026-08-02T00:00:00.000Z",
		};
		expect(isAdapterProgressAnnotation(progress)).toBe(true);
		expect(isAdapterProgressAnnotation({ ...progress, message: "x".repeat(2049) })).toBe(false);
	});

	it("uses a complete failure union and requires a terminal receipt for completed cancellation", () => {
		const baseRequest = requestFor("remote_executor", "cancel");
		const cancelRequest = {
			...baseRequest,
			cancellationOf: createRuntimeId("command", "remote-execution"),
		};
		expect(isAdapterPortRequest(baseRequest)).toBe(false);
		expect(isAdapterPortRequest(cancelRequest)).toBe(true);

		for (const outcome of ["unsupported", "denied", "conflict", "unavailable", "uncertain"] as const) {
			const result = {
				...resultFor(cancelRequest),
				outcome,
				effect: outcome === "uncertain" ? "uncertain" : "none",
				receiptRef: undefined,
				outputRef: undefined,
				error: {
					code: outcome === "conflict" ? "expected_revision_conflict" : "adapter_unavailable",
					message: `${outcome} fixture`,
					retryable: outcome === "unavailable" || outcome === "uncertain",
					correlationId: cancelRequest.traceId,
				},
			};
			expect(isAdapterPortResult(result), outcome).toBe(true);
		}

		const cancelled = {
			...resultFor(cancelRequest),
			outcome: "cancelled",
			effect: "terminal",
			outputRef: undefined,
			error: {
				code: "operation_cancelled",
				message: "cancelled fixture",
				retryable: false,
				correlationId: cancelRequest.traceId,
			},
		};
		expect(isAdapterPortResult(cancelled)).toBe(true);
		expect(isAdapterPortResult({ ...cancelled, receiptRef: undefined })).toBe(false);
	});
});
