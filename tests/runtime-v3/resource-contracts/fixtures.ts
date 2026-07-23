import { canonicalDigest, canonicalJson } from "../../../src/runtime/protocol/v3/canonical-json.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/v3/ids.ts";
import {
	createResourceApprovalReceipt,
	createResourceCacheTicket,
	createResourceClaimDerivationReceipt,
	createResourceManifestDigest,
	createResourceLocatorReceipt,
	createResourceProvenance,
	createResourceProtocolHandshake,
	createRuntimeResourceSnapshot,
	createRuntimeToolDescriptor,
} from "../../../src/runtime/resources/schemas.ts";
import type {
	ResourceApprovalReceipt,
	ResourceAuthorizationContext,
	ResourceCacheTicket,
	ResourceCapabilityDeclaration,
	ResourceIdentity,
	ResourceKind,
	ResourceManifestDigest,
	RuntimeResourceSnapshot,
	RuntimeToolDescriptor,
	RuntimeToolInvocation,
	RuntimeToolInvocationRequest,
} from "../../../src/runtime/resources/types.ts";

export const AUTHORITY_ID = createRuntimeId("authority", "resource-fixture");
export const TENANT_ID = createRuntimeId("tenant", "resource-fixture");
export const PRINCIPAL_ID = createRuntimeId("principal", "resource-fixture");
export const SNAPSHOT_ID = createRuntimeId("snapshot", "resource-fixture");
export const ADAPTER_ID = createRuntimeId("resource", "adapter-fixture");
export const SESSION_ID = createRuntimeId("session", "resource-fixture");
export const TRACE_ID = createRuntimeId("trace", "resource-fixture");
export const NOW = new Date("2026-07-22T00:00:00.000Z");

export function digest(seed: string): string {
	return canonicalDigest({ seed });
}

export function authorizationContext(): ResourceAuthorizationContext {
	return { authorityId: AUTHORITY_ID, tenantId: TENANT_ID, principalId: PRINCIPAL_ID };
}

export function manifest(seed = "fixture"): ResourceManifestDigest {
	return createResourceManifestDigest({
		rootDigest: digest(`${seed}:root`),
		manifestDigest: digest(`${seed}:manifest`),
		configDigest: digest(`${seed}:config`),
		commandDigest: digest(`${seed}:command`),
		assetsDigest: digest(`${seed}:assets`),
		capabilityDigest: digest(`${seed}:capabilities`),
	});
}

export function identity(
	kind: ResourceKind = "mcp-tool",
	qualifiedId = "fixture.server/read",
	seed = "fixture-tool",
	binding = manifest(seed),
): ResourceIdentity {
	return {
		schemaVersion: 2,
		authorityId: AUTHORITY_ID,
		tenantId: TENANT_ID,
		resourceId: createRuntimeId("resource", seed),
		kind,
		qualifiedId,
		version: "1.0.0",
		source: "project",
		digest: binding.combinedDigest,
	};
}

export function filesystemCapability(
	seed = "read-capability",
	resourceDigest = manifest().combinedDigest,
): ResourceCapabilityDeclaration {
	return {
		authorityId: AUTHORITY_ID,
		tenantId: TENANT_ID,
		capabilityId: createRuntimeId("resource", seed),
		claim: {
			authorityId: AUTHORITY_ID,
			tenantId: TENANT_ID,
			name: "repository_read",
			resourceKind: "filesystem",
			resourceDigest,
			constraintsDigest: digest(`${seed}:constraints`),
		},
		boundary: { kind: "filesystem", access: "read", pathScopeDigest: digest(`${seed}:paths`) },
		required: true,
	};
}

export function processCapability(seed = "process-capability"): ResourceCapabilityDeclaration {
	return {
		authorityId: AUTHORITY_ID,
		tenantId: TENANT_ID,
		capabilityId: createRuntimeId("resource", seed),
		claim: {
			authorityId: AUTHORITY_ID,
			tenantId: TENANT_ID,
			name: "dependency_install",
			resourceKind: "process",
			resourceDigest: digest(`${seed}:resource`),
			constraintsDigest: digest(`${seed}:constraints`),
		},
		boundary: { kind: "process", access: "spawn", commandScopeDigest: digest(`${seed}:commands`) },
		required: true,
	};
}

export function browserCapability(
	access: "navigate" | "dom_read" | "script" | "download" | "upload" | "cookie",
	seed = `browser-${access}`,
	resourceDigest = manifest().combinedDigest,
): ResourceCapabilityDeclaration {
	return {
		authorityId: AUTHORITY_ID,
		tenantId: TENANT_ID,
		capabilityId: createRuntimeId("resource", seed),
		claim: {
			authorityId: AUTHORITY_ID,
			tenantId: TENANT_ID,
			name: "browser",
			resourceKind: "browser_tool",
			resourceDigest,
			constraintsDigest: digest(`${seed}:constraints`),
			browserConstraints: {
				navigateOriginDigest: digest(`${seed}:navigate`),
				domReadScopeDigest: digest(`${seed}:dom`),
				scriptPolicyDigest: digest(`${seed}:script`),
				downloadScopeDigest: digest(`${seed}:download`),
				uploadScopeDigest: digest(`${seed}:upload`),
				cookieCredentialScopeDigest: digest(`${seed}:cookie`),
				networkEgressScopeDigest: digest(`${seed}:egress`),
			},
		},
		boundary: { kind: "browser", access, originScopeDigest: digest(`${seed}:origins`) },
		required: true,
	};
}

export function approvalReceipt(
	toolIdentity: ResourceIdentity = identity(),
	binding: ResourceManifestDigest = manifest(),
): ResourceApprovalReceipt {
	return createResourceApprovalReceipt({
		...authorizationContext(),
		receiptId: createRuntimeId("receipt", "resource-approval"),
		identity: toolIdentity,
		binding,
		scope: "project",
		scopeBindingDigest: digest("project-scope"),
		issuedAt: "2026-07-22T00:00:00.000Z",
		expiresAt: "2030-01-01T00:00:00.000Z",
		revocationRevision: 3,
		locatorDigest: digest("resource-locator"),
		publisherDigest: digest("publisher"),
		policyRevision: 5,
		hookRevision: 7,
		adapterGeneration: 7,
		adapterGenerationDigest: digest("adapter-generation-7"),
		approvalState: "approved",
	});
}

export function descriptor(): RuntimeToolDescriptor {
	const binding = manifest();
	const toolIdentity = identity("mcp-tool", "fixture.server/read", "fixture-tool", binding);
	const schemaValue = {
		additionalProperties: false,
		properties: { path: { type: "string" } },
		required: ["path"],
		type: "object",
	};
	return createRuntimeToolDescriptor({
		schemaVersion: 2,
		authorityId: AUTHORITY_ID,
		tenantId: TENANT_ID,
		identity: toolIdentity,
		provenance: createResourceProvenance({
			authorityId: AUTHORITY_ID,
			tenantId: TENANT_ID,
			source: "project",
			canonicalLocator: "/repo/.runledger/mcp.json#fixture/read",
			locatorReceipt: createResourceLocatorReceipt({
				authorityId: AUTHORITY_ID,
				tenantId: TENANT_ID,
				canonicalLocator: "/repo/.runledger/mcp.json#fixture/read",
				sourceRoot: "/repo",
			}),
			publisher: {
				authorityId: AUTHORITY_ID,
				tenantId: TENANT_ID,
				publisherId: "fixture.publisher",
				identityDigest: digest("publisher"),
				signatureDigest: digest("publisher-signature"),
			},
			signatureReceiptId: createRuntimeId("receipt", "signature"),
		}),
		manifest: binding,
		descriptorType: "tool",
		displayName: "Fixture read",
		description: "Read one path through an in-memory contract fixture",
		capabilities: [filesystemCapability("read-capability", binding.combinedDigest)],
		risk: { level: "low", sideEffect: "read", rationaleDigest: digest("risk") },
		exposure: "deferred",
		trust: "trusted",
		activation: "ready",
		approvalReceiptId: createRuntimeId("receipt", "resource-approval"),
		runtimeName: "mcp__fixture__read",
		inputSchema: {
			schemaVersion: 2,
			mediaType: "application/schema+json",
			schemaJson: canonicalJson(schemaValue),
			schemaDigest: canonicalDigest(schemaValue),
			maxInputBytes: 4_096,
		},
		resultContentKinds: ["text", "json"],
		execution: { readOnly: true, destructive: false, concurrencySafe: true },
	});
}

export function snapshot(tool = descriptor()): RuntimeResourceSnapshot {
	return createRuntimeResourceSnapshot({
		schemaVersion: 2,
		...authorizationContext(),
		snapshotId: SNAPSHOT_ID,
		adapterId: ADAPTER_ID,
		adapterGeneration: 7,
		adapterGenerationDigest: digest("adapter-generation-7"),
		createdAt: "2026-07-22T00:00:00.000Z",
		resources: [tool],
		diagnostics: [],
	});
}

export function cacheTicket(tool = descriptor(), current = snapshot(tool)): ResourceCacheTicket {
	return createResourceCacheTicket({
		schemaVersion: 2,
		...authorizationContext(),
		ticketId: createRuntimeId("receipt", "resource-cache"),
		snapshotId: current.snapshotId,
		adapterId: current.adapterId,
		adapterGeneration: current.adapterGeneration,
		adapterGenerationDigest: current.adapterGenerationDigest,
		resourceIdentityDigest: canonicalDigest(tool.identity),
		resourceDigest: tool.identity.digest,
		verification: "content_identity_only",
		issuedAt: "2026-07-22T00:00:00.000Z",
		expiresAt: "2030-01-01T00:00:00.000Z",
	});
}

export function invocationRequest(tool = descriptor()): RuntimeToolInvocationRequest {
	const handshake = createResourceProtocolHandshake({
		schemaVersion: 2,
		...authorizationContext(),
		protocol: "runledger.resource",
		protocolVersion: 2,
		sessionId: SESSION_ID,
		adapterId: ADAPTER_ID,
		adapterGeneration: 7,
		adapterGenerationDigest: digest("adapter-generation-7"),
		snapshotId: SNAPSHOT_ID,
		snapshotSequence: 0,
		catalogDigest: digest("resource-catalog"),
		peerFeatures: [],
	});
	return {
		schemaVersion: 2,
		...authorizationContext(),
		requestId: createRuntimeId("command", "resource-invoke"),
		handshake,
		tool: tool.identity,
		snapshotId: SNAPSHOT_ID,
		rawInput: { path: "README.md" },
		requestedClaims: [tool.capabilities[0]?.claim].filter(
			(claim): claim is ResourceCapabilityDeclaration["claim"] => claim !== undefined,
		),
		correlationId: TRACE_ID,
	};
}

export function invocation(tool = descriptor(), request = invocationRequest(tool)): RuntimeToolInvocation {
	const canonicalInputJson = canonicalJson(request.rawInput);
	const claims = tool.capabilities.map((capability) => capability.claim);
	const derivationReceipt = createResourceClaimDerivationReceipt({
		...authorizationContext(),
		receiptId: createRuntimeId("receipt", "claim-derivation"),
		requestId: request.requestId,
		handshakeDigest: request.handshake.handshakeDigest,
		snapshotId: request.snapshotId,
		toolIdentityDigest: canonicalDigest(tool.identity),
		descriptorDigest: tool.descriptorDigest,
		canonicalInputJson,
		canonicalInputDigest: canonicalDigest(request.rawInput),
		inputRevision: 0,
		claims,
		claimsDigest: canonicalDigest(claims),
		issuedAt: "2026-07-22T00:00:00.000Z",
	});
	return {
		schemaVersion: 2,
		...authorizationContext(),
		requestId: request.requestId,
		handshake: request.handshake,
		invocationSequence: 0,
		tool: tool.identity,
		snapshotId: request.snapshotId,
		correlationId: request.correlationId,
		derivationReceipt,
		decision: "allow",
		authorizationReceiptId: createRuntimeId("receipt", "gateway-allow"),
		authorizationDecisionDigest: digest("gateway-decision"),
		inputRevision: 0,
	};
}
