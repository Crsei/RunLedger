/** ExtensionSnapshot 到 Runtime Phase 5 resource ports 的 public adapter。 */

import { canonicalDigest, canonicalJson } from "../../runtime/protocol/v3/canonical-json.ts";
import { createRuntimeId } from "../../runtime/protocol/v3/ids.ts";
import type { CapabilityClaim } from "../../runtime/protocol/v3/capability.ts";
import type {
	RuntimeResourceCatalogPort,
	RuntimeResourceClaimDerivationPort,
	RuntimeResourceInvocationPort,
	RuntimeResourceSnapshotProvider,
} from "../../runtime/resources/ports.ts";
import type {
	ResourceCancellationRequest,
	ResourceCancellationResult,
	ResourceClaimDerivationResult,
	ResourceContent,
	ResourceResolveRequest,
	ResourceResolveResult,
	ResourceSearchRequest,
	ResourceSearchResult,
	ResourceSnapshotAcquireRequest,
	ResourceSnapshotAcquireResult,
	ResourceSnapshotReleaseRequest,
	ResourceSnapshotReleaseResult,
	RuntimeMetadataDescriptor,
	RuntimeMetadataDescriptorBody,
	RuntimeResourceDescriptor,
	RuntimeResourceSnapshot,
	RuntimeResourceSnapshotBody,
	RuntimeResourceInvocationFrame,
	RuntimeToolDescriptor,
	RuntimeToolDescriptorBody,
	RuntimeToolInvocation,
	RuntimeToolInvocationRequest,
	RuntimeToolResult,
} from "../../runtime/resources/types.ts";
import { isResourceProtocolHandshake } from "../../runtime/resources/schemas.ts";
import type { ExtensionSnapshot } from "../snapshot.ts";
import type { ExtensionResourceDescriptor, ExtensionRuntimeScope } from "../types.ts";
import { redactDiagnosticText } from "../diagnostics.ts";

function toRuntimeDescriptor(descriptor: ExtensionResourceDescriptor): RuntimeResourceDescriptor {
	const common = {
		schemaVersion: 1 as const,
		authorityId: descriptor.identity.authorityId,
		tenantId: descriptor.identity.tenantId,
		identity: descriptor.identity,
		provenance: descriptor.provenance,
		manifest: descriptor.manifest,
		displayName: descriptor.displayName.slice(0, 256),
		description: descriptor.description.slice(0, 2_048),
		capabilities: descriptor.capabilities,
		risk: descriptor.risk,
		exposure: descriptor.exposure,
		trust: descriptor.trust,
		activation: descriptor.activation,
		...(descriptor.approvalReceiptId ? { approvalReceiptId: descriptor.approvalReceiptId } : {}),
	};
	if (descriptor.runtimeName && descriptor.tool) {
		const schemaJson = canonicalJson(JSON.parse(descriptor.tool.inputSchemaJson));
		const body: RuntimeToolDescriptorBody = {
			...common,
			descriptorType: "tool",
			runtimeName: descriptor.runtimeName,
			inputSchema: {
				schemaVersion: 1,
				mediaType: "application/schema+json",
				schemaJson,
				schemaDigest: canonicalDigest(JSON.parse(schemaJson)),
				maxInputBytes: descriptor.tool.maxInputBytes,
			},
			resultContentKinds: descriptor.tool.resultContentKinds,
			execution: descriptor.tool.execution,
		};
		return { ...body, descriptorDigest: canonicalDigest(body) } satisfies RuntimeToolDescriptor;
	}
	const body: RuntimeMetadataDescriptorBody = { ...common, descriptorType: "metadata" };
	return { ...body, descriptorDigest: canonicalDigest(body) } satisfies RuntimeMetadataDescriptor;
}

export function projectRuntimeSnapshot(snapshot: ExtensionSnapshot, scope: ExtensionRuntimeScope): RuntimeResourceSnapshot {
	const resources = snapshot.descriptors.map(toRuntimeDescriptor);
	const body: RuntimeResourceSnapshotBody = {
		schemaVersion: 1,
		authorityId: scope.authorityId,
		tenantId: scope.tenantId,
		principalId: scope.principalId,
		snapshotId: snapshot.snapshotId,
		adapterId: createRuntimeId("resource", "extension-adapter-v1"),
		adapterGeneration: snapshot.generation,
		adapterGenerationDigest: canonicalDigest({ generation: snapshot.generation, digest: snapshot.digest }),
		createdAt: snapshot.createdAt,
		resources,
		diagnostics: snapshot.diagnostics.map((diagnostic) => ({
			authorityId: scope.authorityId,
			tenantId: scope.tenantId,
			code: diagnostic.code.slice(0, 512),
			severity: diagnostic.severity,
			message: redactDiagnosticText(diagnostic.message).slice(0, 512),
			...(diagnostic.resourceId ? { resourceId: diagnostic.resourceId } : {}),
			...(diagnostic.cause ? { detailDigest: canonicalDigest(diagnostic.cause) } : {}),
		})),
	};
	return { ...body, digest: canonicalDigest(body) };
}

function sameIdentity(left: RuntimeResourceDescriptor["identity"], right: RuntimeResourceDescriptor["identity"]): boolean {
	return left.qualifiedId === right.qualifiedId && canonicalDigest(left) === canonicalDigest(right);
}

export class ExtensionRuntimeCatalogAdapter implements RuntimeResourceCatalogPort, RuntimeResourceSnapshotProvider {
	readonly #scope: ExtensionRuntimeScope;
	readonly #snapshot: RuntimeResourceSnapshot;
	readonly #acquired = new Map<string, number>();

	public constructor(snapshot: ExtensionSnapshot, scope: ExtensionRuntimeScope) {
		this.#scope = scope;
		this.#snapshot = projectRuntimeSnapshot(snapshot, scope);
	}

	public async resolveExact(request: ResourceResolveRequest): Promise<ResourceResolveResult> {
		const descriptor = request.snapshotId === this.#snapshot.snapshotId
			? this.#snapshot.resources.find((item) => sameIdentity(item.identity, request.identity))
			: undefined;
		if (!descriptor) return { schemaVersion: 1, status: "not_found", ...this.#scope, requestId: request.requestId, snapshotId: request.snapshotId, identity: request.identity };
		const issuedAt = new Date().toISOString();
		const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
		const ticketBody = {
			schemaVersion: 1 as const,
			...this.#scope,
			ticketId: createRuntimeId("receipt", canonicalDigest({ requestId: request.requestId, descriptor: descriptor.descriptorDigest }).slice(0, 32)),
			snapshotId: this.#snapshot.snapshotId,
			adapterId: this.#snapshot.adapterId,
			adapterGeneration: this.#snapshot.adapterGeneration,
			adapterGenerationDigest: this.#snapshot.adapterGenerationDigest,
			resourceIdentityDigest: canonicalDigest(descriptor.identity),
			resourceDigest: descriptor.descriptorDigest,
			verification: "content_identity_only" as const,
			issuedAt,
			expiresAt,
		};
		return { schemaVersion: 1, status: "found", ...this.#scope, requestId: request.requestId, snapshotId: request.snapshotId, descriptor, cacheTicket: { ...ticketBody, ticketDigest: canonicalDigest(ticketBody) } };
	}

	public async search(request: ResourceSearchRequest): Promise<ResourceSearchResult> {
		const query = request.query.toLocaleLowerCase();
		const all = request.snapshotId === this.#snapshot.snapshotId
			? this.#snapshot.resources.filter((item) => `${item.identity.qualifiedId}\n${item.displayName}\n${item.description}`.toLocaleLowerCase().includes(query))
			: [];
		const selected = all.slice(0, request.limit);
		return {
			schemaVersion: 1,
			...this.#scope,
			requestId: request.requestId,
			snapshotId: request.snapshotId,
			queryDigest: canonicalDigest(request.query),
			items: selected.map((item) => ({ identity: item.identity, descriptorDigest: item.descriptorDigest, displayName: item.displayName, description: item.description, source: item.identity.source, trust: item.trust, activation: item.activation, risk: item.risk.level, exposure: item.exposure })),
			truncated: all.length > selected.length,
		};
	}

	public async acquire(request: ResourceSnapshotAcquireRequest): Promise<ResourceSnapshotAcquireResult> {
		if (request.minimumGeneration !== undefined && request.minimumGeneration > this.#snapshot.adapterGeneration) {
			throw new Error("requested extension generation is unavailable");
		}
		this.#acquired.set(this.#snapshot.snapshotId, (this.#acquired.get(this.#snapshot.snapshotId) ?? 0) + 1);
		return { schemaVersion: 1, ...this.#scope, requestId: request.requestId, snapshot: this.#snapshot, acquisitionReceiptId: createRuntimeId("receipt", canonicalDigest({ requestId: request.requestId, snapshotId: this.#snapshot.snapshotId }).slice(0, 32)), acquiredAt: new Date().toISOString() };
	}

	public async release(request: ResourceSnapshotReleaseRequest): Promise<ResourceSnapshotReleaseResult> {
		const count = this.#acquired.get(request.snapshotId) ?? 0;
		if (request.snapshotId !== this.#snapshot.snapshotId) {
			return { schemaVersion: 1, ...this.#scope, requestId: request.requestId, snapshotId: request.snapshotId, status: "not_found" };
		}
		if (request.expectedGeneration !== this.#snapshot.adapterGeneration) {
			return { schemaVersion: 1, ...this.#scope, requestId: request.requestId, snapshotId: request.snapshotId, status: "generation_conflict" };
		}
		if (count === 0) {
			return { schemaVersion: 1, ...this.#scope, requestId: request.requestId, snapshotId: request.snapshotId, status: "already_released" };
		}
		this.#acquired.set(request.snapshotId, count - 1);
		return {
			schemaVersion: 1,
			...this.#scope,
			requestId: request.requestId,
			snapshotId: request.snapshotId,
			status: "released",
			receiptId: createRuntimeId("receipt", canonicalDigest({ requestId: request.requestId, snapshotId: request.snapshotId }).slice(0, 32)),
		};
	}
}

export interface ExtensionClaimDeriverPort {
	derive(descriptor: RuntimeToolDescriptor, canonicalInput: unknown): Promise<readonly CapabilityClaim[]>;
}

export interface ExtensionInvocationOutcome {
	content: readonly ResourceContent[];
	isError: boolean;
	originalBytes: number;
	truncated: boolean;
}

export type ExtensionInvocationHandler = (canonicalInput: unknown, signal?: AbortSignal) => Promise<ExtensionInvocationOutcome>;

export class ExtensionRuntimeInvocationAdapter implements RuntimeResourceClaimDerivationPort, RuntimeResourceInvocationPort {
	readonly #scope: ExtensionRuntimeScope;
	readonly #snapshot: RuntimeResourceSnapshot;
	readonly #deriver: ExtensionClaimDeriverPort;
	readonly #handlers: ReadonlyMap<string, ExtensionInvocationHandler>;
	readonly #terminal = new Map<string, RuntimeToolResult>();
	readonly #inflight = new Map<string, AbortController>();

	public constructor(options: { snapshot: ExtensionSnapshot; scope: ExtensionRuntimeScope; deriver: ExtensionClaimDeriverPort; handlers: ReadonlyMap<string, ExtensionInvocationHandler> }) {
		this.#scope = options.scope;
		this.#snapshot = projectRuntimeSnapshot(options.snapshot, options.scope);
		this.#deriver = options.deriver;
		this.#handlers = options.handlers;
	}

	public async canonicalizeAndDerive(request: RuntimeToolInvocationRequest, signal?: AbortSignal): Promise<ResourceClaimDerivationResult> {
		if (
			!isResourceProtocolHandshake(request.handshake) ||
			request.handshake.authorityId !== this.#scope.authorityId ||
			request.handshake.tenantId !== this.#scope.tenantId ||
			request.handshake.principalId !== this.#scope.principalId ||
			request.handshake.adapterId !== this.#snapshot.adapterId ||
			request.handshake.adapterGeneration !== this.#snapshot.adapterGeneration ||
			request.handshake.snapshotId !== this.#snapshot.snapshotId ||
			request.handshake.catalogDigest !== this.#snapshot.digest
		) {
			return { schemaVersion: 1, status: "rejected", ...this.#scope, requestId: request.requestId, error: { code: "conflict", messageDigest: canonicalDigest("resource handshake is stale or uncorrelated"), retryable: false } };
		}
		const descriptor = this.#snapshot.resources.find((item): item is RuntimeToolDescriptor => item.descriptorType === "tool" && sameIdentity(item.identity, request.tool));
		if (!descriptor || descriptor.activation !== "ready" || descriptor.trust !== "trusted") {
			return { schemaVersion: 1, status: "rejected", ...this.#scope, requestId: request.requestId, error: { code: "not_ready", messageDigest: canonicalDigest("extension tool is not ready"), retryable: false } };
		}
		if (signal?.aborted) return { schemaVersion: 1, status: "rejected", ...this.#scope, requestId: request.requestId, error: { code: "unavailable", messageDigest: canonicalDigest("request aborted"), retryable: false } };
		let canonicalInputJson: string;
		try {
			canonicalInputJson = canonicalJson(request.rawInput);
		} catch {
			return { schemaVersion: 1, status: "rejected", ...this.#scope, requestId: request.requestId, error: { code: "invalid_request", messageDigest: canonicalDigest("input is not canonical JSON"), retryable: false } };
		}
		if (Buffer.byteLength(canonicalInputJson) > descriptor.inputSchema.maxInputBytes) {
			return { schemaVersion: 1, status: "rejected", ...this.#scope, requestId: request.requestId, error: { code: "invalid_request", messageDigest: canonicalDigest("input exceeds descriptor bound"), retryable: false } };
		}
		const canonicalInput = JSON.parse(canonicalInputJson) as unknown;
		const claims = await this.#deriver.derive(descriptor, canonicalInput);
		const issuedAt = new Date().toISOString();
		const body = {
			schemaVersion: 1 as const,
			...this.#scope,
			receiptId: createRuntimeId("receipt", canonicalDigest({ requestId: request.requestId, descriptor: descriptor.descriptorDigest, canonicalInputJson }).slice(0, 32)),
			requestId: request.requestId,
			handshakeDigest: request.handshake.handshakeDigest,
			snapshotId: request.snapshotId,
			toolIdentityDigest: canonicalDigest(descriptor.identity),
			descriptorDigest: descriptor.descriptorDigest,
			canonicalInputJson,
			canonicalInputDigest: canonicalDigest(canonicalInput),
			claims,
			claimsDigest: canonicalDigest(claims),
			issuedAt,
		};
		return { schemaVersion: 1, status: "derived", receipt: { ...body, receiptDigest: canonicalDigest(body) } };
	}

	public async *invoke(
		invocation: RuntimeToolInvocation,
		signal?: AbortSignal,
	): AsyncIterable<RuntimeResourceInvocationFrame> {
		if (
			!isResourceProtocolHandshake(invocation.handshake) ||
			invocation.handshake.adapterId !== this.#snapshot.adapterId ||
			invocation.handshake.adapterGeneration !== this.#snapshot.adapterGeneration ||
			invocation.handshake.snapshotId !== this.#snapshot.snapshotId ||
			invocation.handshake.catalogDigest !== this.#snapshot.digest
		) {
			const result = this.#result(invocation, [{ type: "text", text: "extension invocation rejected stale handshake" }], true, 45, false);
			yield this.#terminalFrame(invocation, result);
			return;
		}
		const cached = this.#terminal.get(invocation.requestId);
		if (cached) {
			yield this.#terminalFrame(invocation, cached);
			return;
		}
		const descriptor = this.#snapshot.resources.find((item): item is RuntimeToolDescriptor => item.descriptorType === "tool" && sameIdentity(item.identity, invocation.tool));
		const handler = descriptor ? this.#handlers.get(descriptor.identity.qualifiedId) : undefined;
		if (!descriptor || !handler || invocation.decision !== "allow" || invocation.derivationReceipt.descriptorDigest !== descriptor.descriptorDigest) {
			const result = this.#result(invocation, [{ type: "text", text: "extension invocation denied" }], true, 27, false);
			this.#terminal.set(invocation.requestId, result);
			yield this.#terminalFrame(invocation, result);
			return;
		}
		const controller = new AbortController();
		const abort = () => controller.abort(signal?.reason);
		signal?.addEventListener("abort", abort, { once: true });
		this.#inflight.set(invocation.requestId, controller);
		try {
			const input = JSON.parse(invocation.derivationReceipt.canonicalInputJson) as unknown;
			const outcome = await handler(input, controller.signal);
			const result = this.#result(invocation, outcome.content, outcome.isError, outcome.originalBytes, outcome.truncated);
			this.#terminal.set(invocation.requestId, result);
			yield this.#terminalFrame(invocation, result);
		} catch {
			const result = this.#result(
				invocation,
				[{ type: "text", text: controller.signal.aborted ? "extension invocation cancelled" : "extension invocation failed" }],
				true,
				27,
				false,
				controller.signal.aborted ? "cancelled" : "failed",
			);
			this.#terminal.set(invocation.requestId, result);
			yield this.#terminalFrame(invocation, result);
		} finally {
			signal?.removeEventListener("abort", abort);
			this.#inflight.delete(invocation.requestId);
		}
	}

	#result(
		invocation: RuntimeToolInvocation,
		content: readonly ResourceContent[],
		isError: boolean,
		originalBytes: number,
		truncated: boolean,
		terminal: RuntimeToolResult["terminal"] = isError ? "failed" : "completed",
	): RuntimeToolResult {
		const contentDigest = canonicalDigest(content);
		return {
			schemaVersion: 1,
			...this.#scope,
			receiptId: createRuntimeId("receipt", canonicalDigest({ requestId: invocation.requestId, contentDigest, isError }).slice(0, 32)),
			requestId: invocation.requestId,
			handshakeDigest: invocation.handshake.handshakeDigest,
			invocationSequence: invocation.invocationSequence,
			terminalSequence: invocation.invocationSequence,
			terminal,
			tool: invocation.tool,
			snapshotId: invocation.snapshotId,
			correlationId: invocation.correlationId,
			content,
			isError,
			originalBytes,
			truncated,
			contentDigest,
		};
	}

	#terminalFrame(
		invocation: RuntimeToolInvocation,
		result: RuntimeToolResult,
	): RuntimeResourceInvocationFrame {
		return {
			schemaVersion: 1,
			...this.#scope,
			kind: "terminal",
			requestId: invocation.requestId,
			handshakeDigest: invocation.handshake.handshakeDigest,
			invocationSequence: invocation.invocationSequence,
			sequence: result.terminalSequence,
			result,
		};
	}

	public async cancel(request: ResourceCancellationRequest): Promise<ResourceCancellationResult> {
		if (this.#terminal.has(request.requestId)) return { schemaVersion: 1, ...this.#scope, requestId: request.requestId, status: "already_terminal", receiptId: this.#terminal.get(request.requestId)?.receiptId };
		const controller = this.#inflight.get(request.requestId);
		if (!controller) return { schemaVersion: 1, ...this.#scope, requestId: request.requestId, status: "not_found" };
		controller.abort("runtime cancellation");
		return { schemaVersion: 1, ...this.#scope, requestId: request.requestId, status: "accepted", receiptId: createRuntimeId("receipt", canonicalDigest(request).slice(0, 32)) };
	}
}
