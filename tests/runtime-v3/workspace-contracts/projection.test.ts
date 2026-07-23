import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createSessionEventStreamRef } from "../../../src/runtime/protocol/v3/events.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/v3/ids.ts";
import {
	WORKSPACE_SERVICE_SCHEMA_VERSION,
	createWorktreeId,
	isWorkspaceBindingRef,
	isWorkspaceCheckpointDescriptor,
	isWorkspaceExecutionEnvelope,
	isWorkspaceLeaseRef,
	isWorkspaceValidationReceiptRef,
	workspaceBindingDigest,
	workspaceExecutionEnvelopeDigest,
	type WorkspaceBindingRef,
	type WorkspaceCheckpointDescriptor,
	type WorkspaceExecutionEnvelope,
	type WorkspaceLeaseRef,
	type WorkspaceServicePort,
	type WorkspaceServiceRequest,
	type WorkspaceServiceResult,
	type WorkspaceValidationReceiptRef,
} from "../../../src/runtime/protocol/v3/workspace.ts";
import { EventWriter } from "../../../src/runtime/session/event-writer.ts";
import { MemoryEventStore } from "../../../src/runtime/session/memory-event-store.ts";
import { reduceSessionWorkspaceEvents } from "../../../src/runtime/session/workspace-reducer.ts";
import type { WriterFence } from "../../../src/runtime/session/types.ts";

const DIGEST = "a".repeat(64);
const AUTHORITY_ID = createRuntimeId("authority", "fixture");
const TENANT_ID = createRuntimeId("tenant", "fixture");
const PRINCIPAL_ID = createRuntimeId("principal", "fixture");
const SESSION_ID = createRuntimeId("session", "fixture");
const RUNTIME_ID = createRuntimeId("runtime", "fixture");
const STREAM = createSessionEventStreamRef({ authorityId: AUTHORITY_ID, tenantId: TENANT_ID }, SESSION_ID);

interface RawFixture {
	envelope: unknown;
	binding: unknown;
	lease: unknown;
	validation: unknown;
	checkpoint: unknown;
}

function fixture(): {
	envelope: WorkspaceExecutionEnvelope;
	binding: WorkspaceBindingRef;
	lease: WorkspaceLeaseRef;
	validation: WorkspaceValidationReceiptRef;
	checkpoint: WorkspaceCheckpointDescriptor;
} {
	const path = fileURLToPath(new URL("./fixtures/workspace-contract-v1.json", import.meta.url));
	const parsed = JSON.parse(readFileSync(path, "utf8")) as RawFixture;
	if (
		!isWorkspaceExecutionEnvelope(parsed.envelope) ||
		!isWorkspaceBindingRef(parsed.binding) ||
		!isWorkspaceLeaseRef(parsed.lease) ||
		!isWorkspaceValidationReceiptRef(parsed.validation) ||
		!isWorkspaceCheckpointDescriptor(parsed.checkpoint)
	) {
		throw new Error("invalid workspace fixture");
	}
	return {
		envelope: parsed.envelope,
		binding: parsed.binding,
		lease: parsed.lease,
		validation: parsed.validation,
		checkpoint: parsed.checkpoint,
	};
}

function setup() {
	const fence: WriterFence = {
		authorityId: AUTHORITY_ID,
		tenantId: TENANT_ID,
		stream: STREAM,
		leaseId: createRuntimeId("lease", "event-writer"),
		ownerRuntimeId: RUNTIME_ID,
		writerEpoch: 1,
		fencingToken: "event-writer-fence",
	};
	const store = new MemoryEventStore({
		authorityId: AUTHORITY_ID,
		tenantId: TENANT_ID,
		stream: STREAM,
		validateFence: () => true,
	});
	const writer = new EventWriter({
		authorityId: AUTHORITY_ID,
		tenantId: TENANT_ID,
		stream: STREAM,
		store,
		fence,
		clock: () => new Date("2026-07-22T00:00:02.000Z"),
	});
	return { store, writer };
}

async function appendGenesis(context: ReturnType<typeof setup>): Promise<void> {
	const result = await context.writer.append({
		type: "session.created",
		principalId: PRINCIPAL_ID,
		traceId: createRuntimeId("trace", "workspace-genesis"),
		payload: {
			origin: "test",
			runtimeId: RUNTIME_ID,
			featureDigest: DIGEST,
			initialGoalId: createRuntimeId("goal", "workspace-genesis"),
			rootAgentId: createRuntimeId("agent", "workspace-genesis"),
		},
	});
	if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}: ${JSON.stringify(result.error.details)}`);
}

async function readAll(context: ReturnType<typeof setup>) {
	const page = await context.store.readPage(STREAM, { limit: 100 });
	if (!page.ok) throw new Error(page.error.message);
	return page.value.events;
}

class ProjectionFakeWorkspaceAdapter implements WorkspaceServicePort {
	public request(request: WorkspaceServiceRequest): Promise<WorkspaceServiceResult> {
		if (request.kind !== "validate") {
			return Promise.resolve({
				schemaVersion: WORKSPACE_SERVICE_SCHEMA_VERSION,
				requestId: request.requestId,
				kind: "rejected",
				code: "fixture_only_validates",
				messageDigest: DIGEST,
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
				receiptId: createRuntimeId("receipt", "projection-fake"),
				workspaceId: request.envelope.workspaceId,
				envelopeDigest: request.envelopeDigest,
				validatorId: createRuntimeId("principal", "projection-validator"),
				validatedAt: "2026-07-22T00:00:03.000Z",
				outcome: "valid",
			},
		});
	}
}

describe("Session workspace projection", () => {
	it("replays fake adapter refs from the Phase 1 MemoryEventStore", async () => {
		const context = setup();
		const data = fixture();
		await appendGenesis(context);
		const bound = await context.writer.append({
			type: "workspace.bound",
			principalId: PRINCIPAL_ID,
			traceId: createRuntimeId("trace", "workspace-bound"),
			payload: {
				binding: data.binding,
				bindingDigest: workspaceBindingDigest(data.binding),
				lease: data.lease,
			},
		});
		expect(bound.ok).toBe(true);

		const request: WorkspaceServiceRequest = {
			schemaVersion: WORKSPACE_SERVICE_SCHEMA_VERSION,
			kind: "validate",
			requestId: createRuntimeId("command", "projection-validate"),
			authorityId: AUTHORITY_ID,
			tenantId: TENANT_ID,
			principalId: PRINCIPAL_ID,
			sessionId: SESSION_ID,
			agentId: data.envelope.agentId,
			traceId: data.envelope.traceId,
			envelope: data.envelope,
			envelopeDigest: workspaceExecutionEnvelopeDigest(data.envelope),
		};
		const adapterResult = await new ProjectionFakeWorkspaceAdapter().request(request);
		expect(adapterResult.kind).toBe("validated");
		if (adapterResult.kind !== "validated") throw new Error("fake adapter rejected validation");
		const recorded = await context.writer.append({
			type: "workspace.validation_recorded",
			principalId: PRINCIPAL_ID,
			traceId: createRuntimeId("trace", "workspace-validation"),
			payload: {
				validation: adapterResult.validation,
				expectedEnvelopeDigest: request.envelopeDigest,
			},
		});
		expect(recorded.ok).toBe(true);

		const projection = reduceSessionWorkspaceEvents(await readAll(context));
		expect(projection).toEqual({
			binding: data.binding,
			lease: data.lease,
			validation: adapterResult.validation,
			checkpoint: null,
			unavailableReasons: [],
		});
	});

	it("fails closed for stale and revoked lease events", async () => {
		const staleContext = setup();
		const data = fixture();
		await appendGenesis(staleContext);
		expect(
			(
				await staleContext.writer.append({
					type: "workspace.bound",
					principalId: PRINCIPAL_ID,
					traceId: createRuntimeId("trace", "stale-bound"),
					payload: {
						binding: data.binding,
						bindingDigest: workspaceBindingDigest(data.binding),
						lease: data.lease,
					},
				})
			).ok,
		).toBe(true);
		expect(
			(
				await staleContext.writer.append({
					type: "lease.acquired",
					principalId: PRINCIPAL_ID,
					traceId: createRuntimeId("trace", "stale-lease"),
					payload: {
						lease: { ...data.lease, leaseRevision: data.lease.leaseRevision - 1 },
						receiptId: createRuntimeId("receipt", "stale-lease"),
					},
				})
			).ok,
		).toBe(true);
		const staleProjection = reduceSessionWorkspaceEvents(await readAll(staleContext));
		expect(staleProjection.lease).toEqual(data.lease);
		expect(staleProjection.unavailableReasons.map((reason) => reason.code)).toContain("stale_lease_event");

		const revokedContext = setup();
		await appendGenesis(revokedContext);
		expect(
			(
				await revokedContext.writer.append({
					type: "workspace.bound",
					principalId: PRINCIPAL_ID,
					traceId: createRuntimeId("trace", "revoked-bound"),
					payload: {
						binding: data.binding,
						bindingDigest: workspaceBindingDigest(data.binding),
						lease: data.lease,
					},
				})
			).ok,
		).toBe(true);
		expect(
			(
				await revokedContext.writer.append({
					type: "lease.released",
					principalId: PRINCIPAL_ID,
					traceId: createRuntimeId("trace", "revoked-lease"),
					payload: {
						lease: { ...data.lease, state: "revoked" },
						receiptId: createRuntimeId("receipt", "revoked-lease"),
						reasonDigest: DIGEST,
					},
				})
			).ok,
		).toBe(true);
		const revokedProjection = reduceSessionWorkspaceEvents(await readAll(revokedContext));
		expect(revokedProjection.lease?.state).toBe("revoked");
		expect(revokedProjection.unavailableReasons.map((reason) => reason.code)).toContain("lease_revoked");
	});

	it("replaces a binding deterministically and invalidates its previous validation", async () => {
		const context = setup();
		const data = fixture();
		await appendGenesis(context);
		expect(
			(
				await context.writer.append({
					type: "workspace.bound",
					principalId: PRINCIPAL_ID,
					traceId: createRuntimeId("trace", "replace-first"),
					payload: {
						binding: data.binding,
						bindingDigest: workspaceBindingDigest(data.binding),
						lease: data.lease,
					},
				})
			).ok,
		).toBe(true);
		expect(
			(
				await context.writer.append({
					type: "workspace.validation_recorded",
					principalId: PRINCIPAL_ID,
					traceId: createRuntimeId("trace", "replace-validation"),
					payload: {
						validation: data.validation,
						expectedEnvelopeDigest: data.validation.envelopeDigest,
					},
				})
			).ok,
		).toBe(true);

		const nextBinding: WorkspaceBindingRef = {
			...data.binding,
			workspaceId: createRuntimeId("workspace", "replacement"),
			worktreeId: createWorktreeId("replacement"),
			canonicalCwd: "/srv/runledger/worktrees/replacement",
			effectiveCwd: "/srv/runledger/worktrees/replacement",
		};
		const nextLease: WorkspaceLeaseRef = {
			...data.lease,
			workspaceId: nextBinding.workspaceId,
			leaseId: createRuntimeId("lease", "replacement"),
			leaseRevision: data.lease.leaseRevision + 1,
		};
		expect(
			(
				await context.writer.append({
					type: "workspace.bound",
					principalId: PRINCIPAL_ID,
					traceId: createRuntimeId("trace", "replace-second"),
					payload: {
						binding: nextBinding,
						bindingDigest: workspaceBindingDigest(nextBinding),
						lease: nextLease,
					},
				})
			).ok,
		).toBe(true);

		const events = await readAll(context);
		const first = reduceSessionWorkspaceEvents(events);
		const second = reduceSessionWorkspaceEvents(events);
		expect(first).toEqual(second);
		expect(first.binding).toEqual(nextBinding);
		expect(first.lease).toEqual(nextLease);
		expect(first.validation).toBeNull();
		expect(first.unavailableReasons.map((reason) => reason.code)).toEqual(["validation_missing"]);
	});

	it("records invalid validation digest/outcome and unknown event versions deterministically", async () => {
		const context = setup();
		const data = fixture();
		await appendGenesis(context);
		expect(
			(
				await context.writer.append({
					type: "workspace.bound",
					principalId: PRINCIPAL_ID,
					traceId: createRuntimeId("trace", "invalid-validation-bound"),
					payload: {
						binding: data.binding,
						bindingDigest: workspaceBindingDigest(data.binding),
						lease: data.lease,
					},
				})
			).ok,
		).toBe(true);
		expect(
			(
				await context.writer.append({
					type: "workspace.validation_recorded",
					principalId: PRINCIPAL_ID,
					traceId: createRuntimeId("trace", "invalid-validation"),
					payload: {
						validation: { ...data.validation, outcome: "invalid" },
						expectedEnvelopeDigest: "0".repeat(64),
					},
				})
			).ok,
		).toBe(true);
		const invalidProjection = reduceSessionWorkspaceEvents(await readAll(context));
		expect(invalidProjection.unavailableReasons.map((reason) => reason.code)).toEqual([
			"validation_digest_mismatch",
			"validation_invalid",
		]);

		const future = { schemaVersion: 4, type: "workspace.bound", sequence: 99, payload: {} };
		const futureProjection = reduceSessionWorkspaceEvents([future]);
		expect(futureProjection.unavailableReasons).toEqual([
			{ code: "unknown_event_version", sequence: 99, eventType: "workspace.bound" },
		]);
		expect(reduceSessionWorkspaceEvents([future])).toEqual(futureProjection);
	});

	it("projects a release checkpoint without performing Git or cleanup", async () => {
		const context = setup();
		const data = fixture();
		await appendGenesis(context);
		const bound = await context.writer.append({
			type: "workspace.bound",
			principalId: PRINCIPAL_ID,
			traceId: createRuntimeId("trace", "release-bound"),
			payload: {
				binding: data.binding,
				bindingDigest: workspaceBindingDigest(data.binding),
				lease: data.lease,
			},
		});
		if (!bound.ok) throw new Error(bound.error.message);
		const checkpoint: WorkspaceCheckpointDescriptor = {
			...data.checkpoint,
			eventCursor: {
				stream: bound.value.cursor.stream,
				sequence: bound.value.cursor.sequence,
				eventId: bound.value.cursor.eventId,
				eventHash: bound.value.cursor.eventHash,
			},
		};
		const released = await context.writer.append({
			type: "workspace.released",
			principalId: PRINCIPAL_ID,
			traceId: createRuntimeId("trace", "workspace-release"),
			payload: {
				workspaceId: data.binding.workspaceId,
				leaseId: data.lease.leaseId,
				leaseRevision: data.lease.leaseRevision,
				bindingDigest: workspaceBindingDigest(data.binding),
				receiptId: createRuntimeId("receipt", "workspace-release"),
				checkpoint,
			},
		});
		if (!released.ok) throw new Error(`${released.error.code}: ${released.error.message}`);

		const projection = reduceSessionWorkspaceEvents(await readAll(context));
		expect(projection.checkpoint).toEqual(checkpoint);
		expect(projection.lease?.state).toBe("released");
		expect(projection.unavailableReasons.map((reason) => reason.code)).toEqual([
			"lease_released",
			"validation_missing",
			"workspace_released",
		]);
	});
});
