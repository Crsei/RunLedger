import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createRuntimeId } from "../../../src/runtime/protocol/v3/ids.ts";
import {
	WORKSPACE_SERVICE_SCHEMA_VERSION,
	createWorktreeId,
	isWorkspaceBindingRef,
	isWorkspaceCheckpointDescriptor,
	isWorkspaceExecutionEnvelope,
	isWorkspaceLeaseRef,
	isWorkspaceServiceRequest,
	isWorkspaceServiceResult,
	isWorkspaceValidationReceiptForEnvelope,
	isWorkspaceValidationReceiptRef,
	parseWorktreeId,
	workspaceExecutionEnvelopeDigest,
	type WorkspaceExecutionEnvelope,
	type WorkspaceServicePort,
	type WorkspaceServiceRequest,
	type WorkspaceServiceResult,
} from "../../../src/runtime/protocol/v3/workspace.ts";

interface GoldenFixture {
	envelope: unknown;
	binding: unknown;
	lease: unknown;
	validation: unknown;
	checkpoint: unknown;
}

function loadFixture(): GoldenFixture {
	const path = fileURLToPath(new URL("./fixtures/workspace-contract-v1.json", import.meta.url));
	return JSON.parse(readFileSync(path, "utf8")) as GoldenFixture;
}

function fixtureEnvelope(): WorkspaceExecutionEnvelope {
	const value = loadFixture().envelope;
	expect(isWorkspaceExecutionEnvelope(value)).toBe(true);
	if (!isWorkspaceExecutionEnvelope(value)) throw new Error("invalid golden envelope");
	return value;
}

class FakeWorkspaceAdapter implements WorkspaceServicePort {
	public request(request: WorkspaceServiceRequest): Promise<WorkspaceServiceResult> {
		if (request.kind !== "validate") {
			return Promise.resolve({
				schemaVersion: WORKSPACE_SERVICE_SCHEMA_VERSION,
				requestId: request.requestId,
				kind: "rejected",
				code: "unsupported_fixture_operation",
				messageDigest: "f".repeat(64),
				retryable: false,
			});
		}
		return Promise.resolve({
			schemaVersion: WORKSPACE_SERVICE_SCHEMA_VERSION,
			requestId: request.requestId,
			kind: "validated",
			validation: {
				authorityId: request.authorityId,
				tenantId: request.tenantId,
				principalId: request.principalId,
				receiptId: createRuntimeId("receipt", "fake-validation"),
				workspaceId: request.envelope.workspaceId,
				envelopeDigest: request.envelopeDigest,
				validatorId: createRuntimeId("principal", "fake-validator"),
				validatedAt: "2026-07-22T00:00:01.000Z",
				outcome: "valid",
			},
		});
	}
}

describe("Workspace contract schemas", () => {
	it("round-trips the golden envelope, binding, lease, validation, and checkpoint", () => {
		const fixture = loadFixture();
		const roundTrip = JSON.parse(JSON.stringify(fixture)) as GoldenFixture;

		expect(isWorkspaceExecutionEnvelope(roundTrip.envelope)).toBe(true);
		expect(isWorkspaceBindingRef(roundTrip.binding)).toBe(true);
		expect(isWorkspaceLeaseRef(roundTrip.lease)).toBe(true);
		expect(isWorkspaceValidationReceiptRef(roundTrip.validation)).toBe(true);
		expect(isWorkspaceCheckpointDescriptor(roundTrip.checkpoint)).toBe(true);
	});

	it("rejects missing and unknown envelope fields", () => {
		const envelope = fixtureEnvelope();
		const { toolCallId: _toolCallId, ...missingToolCall } = envelope;

		expect(isWorkspaceExecutionEnvelope(missingToolCall)).toBe(false);
		expect(isWorkspaceExecutionEnvelope({ ...envelope, future: true })).toBe(false);
		expect(isWorkspaceExecutionEnvelope({ ...envelope, leaseRevision: -1 })).toBe(false);
	});

	it("fixes canonical/effective cwd, branch/base/head, and Worktree ID shape", () => {
		const binding = loadFixture().binding;
		expect(isWorkspaceBindingRef(binding)).toBe(true);
		if (!isWorkspaceBindingRef(binding)) throw new Error("invalid fixture binding");

		expect(binding.canonicalCwd).not.toBe(binding.effectiveCwd);
		expect(binding.branch).toBe("runledger/fixture");
		expect(binding.baseCommit).not.toBe(binding.headCommit);
		expect(parseWorktreeId(binding.worktreeId ?? "")).toBe(binding.worktreeId);
		expect(createWorktreeId("another")).toBe("worktree_another");
		expect(() => createWorktreeId("bad/path")).toThrow("invalid worktree id seed");
		expect(isWorkspaceBindingRef({ ...binding, bindingKind: "source", worktreeId: binding.worktreeId })).toBe(false);
		const { worktreeId: _worktreeId, ...missingWorktree } = binding;
		expect(isWorkspaceBindingRef(missingWorktree)).toBe(false);
	});

	it("models all validation outcomes without claiming TOCTOU enforcement", () => {
		const validation = loadFixture().validation;
		expect(isWorkspaceValidationReceiptRef(validation)).toBe(true);
		if (!isWorkspaceValidationReceiptRef(validation)) throw new Error("invalid fixture validation");

		for (const outcome of ["valid", "invalid", "unavailable"] as const) {
			expect(isWorkspaceValidationReceiptRef({ ...validation, outcome })).toBe(true);
		}
		expect(isWorkspaceValidationReceiptRef({ ...validation, outcome: "blocked" })).toBe(false);
		expect(validation).not.toHaveProperty("toctouPrevented");
	});

	it("binds the validation receipt to the exact envelope digest", () => {
		const fixture = loadFixture();
		const envelope = fixtureEnvelope();
		expect(isWorkspaceValidationReceiptRef(fixture.validation)).toBe(true);
		if (!isWorkspaceValidationReceiptRef(fixture.validation)) throw new Error("invalid fixture validation");

		expect(workspaceExecutionEnvelopeDigest(envelope)).toBe(fixture.validation.envelopeDigest);
		expect(isWorkspaceValidationReceiptForEnvelope(fixture.validation, envelope)).toBe(true);
		expect(
			isWorkspaceValidationReceiptForEnvelope(fixture.validation, {
				...envelope,
				cwd: `${envelope.cwd}/other`,
			}),
		).toBe(false);
		expect(
			isWorkspaceValidationReceiptForEnvelope(
				{ ...fixture.validation, envelopeDigest: "0".repeat(64) },
				envelope,
			),
		).toBe(false);
	});

	it("keeps checkpoint completeness and Artifact reference exact", () => {
		const checkpoint = loadFixture().checkpoint;
		expect(isWorkspaceCheckpointDescriptor(checkpoint)).toBe(true);
		if (!isWorkspaceCheckpointDescriptor(checkpoint)) throw new Error("invalid fixture checkpoint");
		const { snapshotArtifactId: _artifact, ...withoutArtifact } = checkpoint;

		expect(isWorkspaceCheckpointDescriptor(withoutArtifact)).toBe(false);
		expect(isWorkspaceCheckpointDescriptor({ ...withoutArtifact, completeness: "metadata_only" })).toBe(true);
		expect(isWorkspaceCheckpointDescriptor({ ...checkpoint, completeness: "metadata_only" })).toBe(false);
		expect(isWorkspaceCheckpointDescriptor({ ...withoutArtifact, completeness: "partial" })).toBe(true);
	});

	it("exposes an opaque exact request/result adapter port", async () => {
		const envelope = fixtureEnvelope();
		const request: WorkspaceServiceRequest = {
			schemaVersion: WORKSPACE_SERVICE_SCHEMA_VERSION,
			kind: "validate",
			requestId: createRuntimeId("command", "validate-fixture"),
			authorityId: envelope.authorityId,
			tenantId: envelope.tenantId,
			principalId: envelope.principalId,
			sessionId: envelope.sessionId,
			agentId: envelope.agentId,
			traceId: envelope.traceId,
			envelope,
			envelopeDigest: workspaceExecutionEnvelopeDigest(envelope),
		};

		expect(isWorkspaceServiceRequest(request)).toBe(true);
		expect(isWorkspaceServiceRequest({ ...request, schemaVersion: 2 })).toBe(false);
		expect(isWorkspaceServiceRequest({ ...request, manager: {} })).toBe(false);
		const result = await new FakeWorkspaceAdapter().request(request);
		expect(isWorkspaceServiceResult(result)).toBe(true);
		expect(result.kind).toBe("validated");
		if (result.kind === "validated") {
			expect(isWorkspaceValidationReceiptForEnvelope(result.validation, envelope)).toBe(true);
		}
	});
});
