import { canonicalDigest, canonicalJson } from "../../../src/runtime/protocol/v3/canonical-json.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/v3/ids.ts";
import { describe, expect, it } from "vitest";
import type {
	RuntimeResourceCatalogPort,
	RuntimeResourceClaimDerivationPort,
	RuntimeResourceEventSink,
	RuntimeResourceFacetReadPort,
	RuntimeResourceHookTransformPort,
	RuntimeResourceInvocationPort,
	RuntimeResourceSnapshotProvider,
} from "../../../src/runtime/resources/ports.ts";
import {
	createResourceCacheTicket,
	createResourceClaimDerivationReceipt,
	createResourceHookTransformReceipt,
	isResourceCancellationResult,
	isResourceClaimDerivationResult,
	isResourceEventEmissionRequest,
	isResourceEventEmissionResult,
	isResourceFacetReadResult,
	isResourceHookTransformResult,
	isResourceResolveRequest,
	isResourceResolveResult,
	isResourceSearchRequest,
	isResourceSearchResult,
	isResourceSnapshotAcquireRequest,
	isResourceSnapshotAcquireResult,
	isResourceSnapshotReleaseRequest,
	isResourceSnapshotReleaseResult,
	isRuntimeToolInvocation,
	isRuntimeToolInvocationRequest,
	isRuntimeToolResult,
	resourceIdentityDigest,
	resourceIdentityKey,
} from "../../../src/runtime/resources/schemas.ts";
import type {
	ResourceCancellationRequest,
	ResourceCancellationResult,
	ResourceClaimDerivationResult,
	ResourceEventEmissionRequest,
	ResourceEventEmissionResult,
	ResourceFacetReadRequest,
	ResourceFacetReadResult,
	ResourceHookTransformRequest,
	ResourceHookTransformResult,
	ResourceResolveRequest,
	ResourceResolveResult,
	ResourceSearchRequest,
	ResourceSearchResult,
	ResourceSnapshotAcquireRequest,
	ResourceSnapshotAcquireResult,
	ResourceSnapshotReleaseRequest,
	ResourceSnapshotReleaseResult,
	RuntimeResourceInvocationFrame,
	RuntimeResourceSnapshot,
	RuntimeToolDescriptor,
	RuntimeToolInvocation,
	RuntimeToolInvocationRequest,
	RuntimeToolResult,
} from "../../../src/runtime/resources/types.ts";
import { createResourceLifecycleEvent } from "../../../src/runtime/resources/events.ts";
import { consumeResourceInvocation } from "../../../src/runtime/resources/invocation-stream.ts";
import {
	AUTHORITY_ID,
	NOW,
	PRINCIPAL_ID,
	SNAPSHOT_ID,
	TENANT_ID,
	TRACE_ID,
	authorizationContext,
	descriptor,
	digest,
	invocation,
	invocationRequest,
	snapshot,
} from "./fixtures.ts";

class InMemoryResourceAdapter
	implements
		RuntimeResourceCatalogPort,
		RuntimeResourceClaimDerivationPort,
		RuntimeResourceInvocationPort,
		RuntimeResourceEventSink,
		RuntimeResourceFacetReadPort,
		RuntimeResourceHookTransformPort,
		RuntimeResourceSnapshotProvider
{
	public readonly effects = { fileReads: 0, processStarts: 0, networkRequests: 0 };
	public readonly emitted: ResourceEventEmissionRequest[] = [];
	readonly #descriptor: RuntimeToolDescriptor;
	readonly #snapshot: RuntimeResourceSnapshot;

	public constructor(tool: RuntimeToolDescriptor, current: RuntimeResourceSnapshot) {
		this.#descriptor = tool;
		this.#snapshot = current;
	}

	public async validateLocator(request: {
		canonicalLocator: string;
		sourceRoot: string;
	}): Promise<
		| { status: "valid"; canonicalLocator: string; containmentDigest: string }
		| { status: "rejected"; reasonDigest: string }
	> {
		return request.canonicalLocator.startsWith(`${request.sourceRoot}/`)
			? {
					status: "valid",
					canonicalLocator: request.canonicalLocator,
					containmentDigest: canonicalDigest({ ...request, contained: true }),
				}
			: { status: "rejected", reasonDigest: digest("locator escape") };
	}

	public async resolveExact(request: ResourceResolveRequest): Promise<ResourceResolveResult> {
		if (resourceIdentityKey(request.identity) !== resourceIdentityKey(this.#descriptor.identity)) {
			return { ...request, status: "not_found" };
		}
		const cacheTicket = createResourceCacheTicket({
			schemaVersion: 2,
			...authorizationContext(),
			ticketId: createRuntimeId("receipt", "fake-cache-ticket"),
			snapshotId: this.#snapshot.snapshotId,
			adapterId: this.#snapshot.adapterId,
			adapterGeneration: this.#snapshot.adapterGeneration,
			adapterGenerationDigest: this.#snapshot.adapterGenerationDigest,
			resourceIdentityDigest: resourceIdentityDigest(this.#descriptor.identity),
			resourceDigest: this.#descriptor.identity.digest,
			verification: "content_identity_only",
			issuedAt: "2026-07-22T00:00:00.000Z",
			expiresAt: "2030-01-01T00:00:00.000Z",
		});
		return {
			schemaVersion: 2,
			...authorizationContext(),
			requestId: request.requestId,
			snapshotId: request.snapshotId,
			status: "found",
			descriptor: this.#descriptor,
			cacheTicket,
		};
	}

	public async search(request: ResourceSearchRequest): Promise<ResourceSearchResult> {
		const matches = `${this.#descriptor.displayName} ${this.#descriptor.description}`
			.toLocaleLowerCase()
			.includes(request.query.toLocaleLowerCase());
		const items = matches
			? [
					{
						identity: this.#descriptor.identity,
						descriptorDigest: this.#descriptor.descriptorDigest,
						displayName: this.#descriptor.displayName,
						description: this.#descriptor.description,
						source: this.#descriptor.identity.source,
						trust: this.#descriptor.trust,
						activation: this.#descriptor.activation,
						risk: this.#descriptor.risk.level,
						exposure: this.#descriptor.exposure,
					},
				].slice(0, request.limit)
			: [];
		return {
			schemaVersion: 2,
			...authorizationContext(),
			requestId: request.requestId,
			snapshotId: request.snapshotId,
			queryDigest: canonicalDigest(request.query),
			items,
			truncated: false,
		};
	}

	public async canonicalizeAndDerive(
		request: RuntimeToolInvocationRequest,
	): Promise<ResourceClaimDerivationResult> {
		if (resourceIdentityKey(request.tool) !== resourceIdentityKey(this.#descriptor.identity)) {
			return {
				schemaVersion: 2,
				...authorizationContext(),
				requestId: request.requestId,
				status: "rejected",
				error: { code: "not_found", messageDigest: digest("not found"), retryable: false },
			};
		}
		const canonicalInputJson = canonicalJson(request.rawInput);
		const claims = this.#descriptor.capabilities.map((item) => item.claim);
		return {
			schemaVersion: 2,
			status: "derived",
			receipt: createResourceClaimDerivationReceipt({
				...authorizationContext(),
				receiptId: createRuntimeId("receipt", "fake-derivation"),
				requestId: request.requestId,
				handshakeDigest: request.handshake.handshakeDigest,
				snapshotId: request.snapshotId,
				toolIdentityDigest: resourceIdentityDigest(request.tool),
				descriptorDigest: this.#descriptor.descriptorDigest,
				canonicalInputJson,
				canonicalInputDigest: canonicalDigest(request.rawInput),
				inputRevision: 0,
				claims,
				claimsDigest: canonicalDigest(claims),
				issuedAt: "2026-07-22T00:00:00.000Z",
			}),
		};
	}

	public async readFacet(request: ResourceFacetReadRequest): Promise<ResourceFacetReadResult> {
		const content = [{ type: "text" as const, text: "snapshot facet" }];
		return {
			schemaVersion: 2,
			...authorizationContext(),
			requestId: request.requestId,
			status: "read",
			snapshotId: request.snapshotId,
			adapterGeneration: request.adapterGeneration,
			adapterGenerationDigest: request.adapterGenerationDigest,
			resource: request.resource,
			facet: request.facet,
			content,
			contentDigest: canonicalDigest(content),
			byteLength: 14,
			entryCount: 1,
		};
	}

	public async transform(request: ResourceHookTransformRequest): Promise<ResourceHookTransformResult> {
		return {
			schemaVersion: 2,
			status: "transformed",
			receipt: createResourceHookTransformReceipt({
				...authorizationContext(),
				receiptId: createRuntimeId("receipt", "fake-hook-transform"),
				requestId: request.requestId,
				handshakeDigest: request.handshake.handshakeDigest,
				snapshotId: request.snapshotId,
				inputRevision: request.inputRevision,
				outputRevision: request.inputRevision + 1,
				originalInputDigest: request.canonicalInputDigest,
				updatedInputJson: request.canonicalInputJson,
				updatedInputDigest: request.canonicalInputDigest,
				patches: [],
				handled: false,
				shortCircuit: false,
				systemPromptChainDigest: request.systemPromptChainDigest,
				hookIdentityDigest: digest("no-hooks"),
				hookGeneration: request.handshake.adapterGeneration,
				hookGenerationDigest: request.handshake.adapterGenerationDigest,
				claimsDigest: canonicalDigest([]),
				authorizationDecisionDigest: digest("fake-transform-allow"),
				issuedAt: "2026-07-22T00:00:00.000Z",
			}),
		};
	}

	public async *invoke(request: RuntimeToolInvocation): AsyncIterable<RuntimeResourceInvocationFrame> {
		const content = [{ type: "text" as const, text: "fake result" }];
		const result: RuntimeToolResult = {
			schemaVersion: 2,
			...authorizationContext(),
			receiptId: createRuntimeId("receipt", "fake-result"),
			requestId: request.requestId,
			handshakeDigest: request.handshake.handshakeDigest,
			invocationSequence: request.invocationSequence,
			terminalSequence: request.invocationSequence,
			terminal: "completed",
			tool: request.tool,
			snapshotId: request.snapshotId,
			correlationId: request.correlationId,
			content,
			isError: false,
			originalBytes: 11,
			truncated: false,
			contentDigest: canonicalDigest(content),
		};
		yield {
			schemaVersion: 2,
			...authorizationContext(),
			kind: "terminal",
			requestId: request.requestId,
			handshakeDigest: request.handshake.handshakeDigest,
			invocationSequence: request.invocationSequence,
			sequence: request.invocationSequence,
			result,
		};
	}

	public async cancel(request: ResourceCancellationRequest): Promise<ResourceCancellationResult> {
		return {
			schemaVersion: 2,
			authorityId: request.authorityId,
			tenantId: request.tenantId,
			principalId: request.principalId,
			requestId: request.requestId,
			status: "accepted",
			receiptId: createRuntimeId("receipt", "fake-cancel"),
		};
	}

	public async emit(request: ResourceEventEmissionRequest): Promise<ResourceEventEmissionResult> {
		this.emitted.push(request);
		return {
			schemaVersion: 2,
			...authorizationContext(),
			idempotencyKey: request.idempotencyKey,
			status: "emitted",
			receiptId: createRuntimeId("receipt", "fake-event"),
			eventDigest: canonicalDigest(request.event),
		};
	}

	public async acquire(request: ResourceSnapshotAcquireRequest): Promise<ResourceSnapshotAcquireResult> {
		return {
			schemaVersion: 2,
			authorityId: request.authorityId,
			tenantId: request.tenantId,
			principalId: request.principalId,
			requestId: request.requestId,
			snapshot: this.#snapshot,
			acquisitionReceiptId: createRuntimeId("receipt", "fake-acquire"),
			acquiredAt: "2026-07-22T00:00:00.000Z",
		};
	}

	public async release(request: ResourceSnapshotReleaseRequest): Promise<ResourceSnapshotReleaseResult> {
		const context = {
			schemaVersion: 2 as const,
			authorityId: request.authorityId,
			tenantId: request.tenantId,
			principalId: request.principalId,
			requestId: request.requestId,
			snapshotId: request.snapshotId,
		};
		return request.expectedGeneration === this.#snapshot.adapterGeneration
			? { ...context, status: "released", receiptId: createRuntimeId("receipt", "fake-release") }
			: { ...context, status: "generation_conflict" };
	}
}

describe("resource adapter ports", () => {
	it("runs exact resolve, bounded search, snapshot, derive, invoke, cancel, and event emission in memory", async () => {
		const tool = descriptor();
		const current = snapshot(tool);
		const adapter = new InMemoryResourceAdapter(tool, current);
		const acquireRequest: ResourceSnapshotAcquireRequest = {
			schemaVersion: 2,
			...authorizationContext(),
			requestId: createRuntimeId("command", "acquire"),
			minimumGeneration: 7,
		};
		expect(isResourceSnapshotAcquireRequest(acquireRequest)).toBe(true);
		const acquired = await adapter.acquire(acquireRequest);
		expect(isResourceSnapshotAcquireResult(acquired)).toBe(true);
		expect(await adapter.validateLocator({
			canonicalLocator: "/repo/fixture",
			sourceRoot: "/repo",
		})).toMatchObject({ status: "valid" });

		const resolveRequest: ResourceResolveRequest = {
			schemaVersion: 2,
			...authorizationContext(),
			requestId: createRuntimeId("command", "resolve"),
			snapshotId: current.snapshotId,
			identity: tool.identity,
		};
		expect(isResourceResolveRequest(resolveRequest)).toBe(true);
		const resolved = await adapter.resolveExact(resolveRequest);
		expect(isResourceResolveResult(resolved)).toBe(true);
		expect(resolved.status).toBe("found");

		const missing = await adapter.resolveExact({
			...resolveRequest,
			identity: { ...tool.identity, resourceId: createRuntimeId("resource", "missing") },
		});
		expect(isResourceResolveResult(missing)).toBe(true);
		expect(missing.status).toBe("not_found");

		const searchRequest: ResourceSearchRequest = {
			schemaVersion: 2,
			...authorizationContext(),
			requestId: createRuntimeId("command", "search"),
			snapshotId: current.snapshotId,
			query: "fixture",
			limit: 1,
		};
		expect(isResourceSearchRequest(searchRequest)).toBe(true);
		const search = await adapter.search(searchRequest);
		expect(isResourceSearchResult(search, searchRequest)).toBe(true);
		expect(search.items).toHaveLength(1);
		expect(isResourceSearchRequest({ ...searchRequest, limit: 101 })).toBe(false);

		const raw = invocationRequest(tool);
		expect(isRuntimeToolInvocationRequest(raw)).toBe(true);
		const transformed = await adapter.transform({
			schemaVersion: 2,
			...authorizationContext(),
			requestId: raw.requestId,
			handshake: raw.handshake,
			snapshotId: raw.snapshotId,
			tool: raw.tool,
			inputRevision: 0,
			canonicalInputJson: canonicalJson(raw.rawInput),
			canonicalInputDigest: canonicalDigest(raw.rawInput),
			systemPromptChainDigest: digest("system-prompt"),
		});
		expect(isResourceHookTransformResult(transformed)).toBe(true);
		const derived = await adapter.canonicalizeAndDerive(raw);
		expect(isResourceClaimDerivationResult(derived)).toBe(true);
		expect(derived.status).toBe("derived");
		if (derived.status !== "derived") throw new Error("fixture derivation failed");
		const prepared: RuntimeToolInvocation = {
			schemaVersion: 2,
			...authorizationContext(),
			requestId: raw.requestId,
			handshake: raw.handshake,
			invocationSequence: 0,
			tool: raw.tool,
			snapshotId: raw.snapshotId,
			correlationId: raw.correlationId,
			derivationReceipt: derived.receipt,
			decision: "allow",
			authorizationReceiptId: createRuntimeId("receipt", "fake-authorization"),
			authorizationDecisionDigest: digest("fake-authorization"),
			inputRevision: 0,
		};
		expect(isRuntimeToolInvocation(prepared)).toBe(true);
		const streamed = await consumeResourceInvocation(prepared, adapter.invoke(prepared));
		expect(streamed.ok).toBe(true);
		if (!streamed.ok) throw new Error("fixture invocation failed");
		expect(isRuntimeToolResult(streamed.result)).toBe(true);
		const body = { ...tool.identity, kind: "skill-body" as const };
		const facetRequest: ResourceFacetReadRequest = {
			schemaVersion: 2,
			...authorizationContext(),
			requestId: createRuntimeId("command", "facet-read"),
			snapshotId: current.snapshotId,
			adapterGeneration: current.adapterGeneration,
			adapterGenerationDigest: current.adapterGenerationDigest,
			resource: body,
			facet: "body",
			budget: { maxBytes: 1024, maxEntries: 4 },
		};
		expect(isResourceFacetReadResult(
			await adapter.readFacet(facetRequest),
			facetRequest,
		)).toBe(true);

		const cancellation: ResourceCancellationRequest = {
			schemaVersion: 2,
			...authorizationContext(),
			requestId: prepared.requestId,
			reasonDigest: digest("cancel"),
		};
		const cancelled = await adapter.cancel(cancellation);
		expect(isResourceCancellationResult(cancelled)).toBe(true);

		const lifecycle = createResourceLifecycleEvent({
			...authorizationContext(),
			identity: tool.identity,
			state: "activated",
			receiptId: createRuntimeId("receipt", "resource-approval"),
			snapshotId: SNAPSHOT_ID,
			adapterGeneration: 7,
			correlationId: TRACE_ID,
			occurredAt: "2026-07-22T00:00:00.000Z",
		});
		const eventRequest: ResourceEventEmissionRequest = {
			schemaVersion: 2,
			...authorizationContext(),
			idempotencyKey: createRuntimeId("command", "emit-resource-event"),
			event: lifecycle,
		};
		expect(isResourceEventEmissionRequest(eventRequest)).toBe(true);
		expect(isResourceEventEmissionResult(await adapter.emit(eventRequest))).toBe(true);
		expect(adapter.emitted).toHaveLength(1);

		const releaseRequest: ResourceSnapshotReleaseRequest = {
			schemaVersion: 2,
			...authorizationContext(),
			requestId: createRuntimeId("command", "release"),
			snapshotId: SNAPSHOT_ID,
			expectedGeneration: 7,
		};
		expect(isResourceSnapshotReleaseRequest(releaseRequest)).toBe(true);
		expect(isResourceSnapshotReleaseResult(await adapter.release(releaseRequest))).toBe(true);
		expect(adapter.effects).toEqual({ fileReads: 0, processStarts: 0, networkRequests: 0 });
		expect(NOW.getUTCFullYear()).toBe(2026);
		expect(AUTHORITY_ID).toBe(current.authorityId);
		expect(TENANT_ID).toBe(current.tenantId);
		expect(PRINCIPAL_ID).toBe(current.principalId);
	});

	it("does not let display-name or search results become an invocation route", async () => {
		const tool = descriptor();
		const adapter = new InMemoryResourceAdapter(tool, snapshot(tool));
		const exact = invocation(tool);
		expect(isRuntimeToolInvocation(exact)).toBe(true);
		expect(
			isRuntimeToolInvocation({
				...exact,
				tool: { ...exact.tool, qualifiedId: tool.displayName },
			}),
		).toBe(false);
		expect(adapter.effects.processStarts).toBe(0);
	});
});
