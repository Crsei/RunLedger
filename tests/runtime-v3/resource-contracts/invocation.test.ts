import { canonicalDigest, canonicalJson } from "../../../src/runtime/protocol/v3/canonical-json.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/v3/ids.ts";
import { describe, expect, it } from "vitest";
import {
	createResourceClaimDerivationReceipt,
	createRuntimeInstructionDescriptor,
	createRuntimeToolDescriptor,
	isResourceClaimDerivationReceipt,
	isRuntimeToolDescriptor,
	isRuntimeInstructionDescriptor,
	isRuntimeToolInvocation,
	isRuntimeToolInvocationRequest,
	isRuntimeToolResult,
	isSkillResourceSet,
	resourceExposureAllows,
} from "../../../src/runtime/resources/schemas.ts";
import type { ResourceContent, SkillResourceSet } from "../../../src/runtime/resources/types.ts";
import {
	AUTHORITY_ID,
	PRINCIPAL_ID,
	SNAPSHOT_ID,
	TENANT_ID,
	TRACE_ID,
	authorizationContext,
	browserCapability,
	descriptor,
	digest,
	filesystemCapability,
	identity,
	invocation,
	invocationRequest,
	manifest,
	processCapability,
} from "./fixtures.ts";

describe("resource descriptor and invocation contracts", () => {
	it("keeps trust and activation separate and rejects executable handles", () => {
		const tool = descriptor();
		expect(isRuntimeToolDescriptor(tool)).toBe(true);
		expect(tool.trust).toBe("trusted");
		expect(tool.activation).toBe("ready");
		expect(tool).not.toHaveProperty("enabled");
		expect(tool).not.toHaveProperty("handler");
		expect(tool).not.toHaveProperty("client");
		expect(tool.inputSchema.schemaJson).toBe(canonicalJson(JSON.parse(tool.inputSchema.schemaJson)));

		const { descriptorDigest: _descriptorDigest, ...body } = tool;
		const { approvalReceiptId: _approvalReceiptId, ...unapprovedBody } = body;
		expect(
			isRuntimeToolDescriptor(
				createRuntimeToolDescriptor({ ...body, trust: "untrusted", activation: "ready" }),
			),
		).toBe(false);
		expect(
			isRuntimeToolDescriptor(
				createRuntimeToolDescriptor(unapprovedBody),
			),
		).toBe(false);
		expect(isRuntimeToolDescriptor({ ...tool, handler: () => "forbidden" })).toBe(false);
		expect(
			isRuntimeToolDescriptor({
				...tool,
				inputSchema: { ...tool.inputSchema, schemaJson: '{"type":"array"}' },
			}),
		).toBe(false);
	});

	it("requires structured capability boundaries and risk/exposure", () => {
		const tool = descriptor();
		const capability = tool.capabilities[0];
		expect(capability?.boundary).toEqual({
			kind: "filesystem",
			access: "read",
			pathScopeDigest: digest("read-capability:paths"),
		});
		expect(tool.risk).toEqual({ level: "low", sideEffect: "read", rationaleDigest: digest("risk") });
		expect(tool.exposure).toBe("deferred");

		const { descriptorDigest: _descriptorDigest, ...body } = tool;
		const mismatched = createRuntimeToolDescriptor({
			...body,
			capabilities: [
				{
					...tool.capabilities[0]!,
					boundary: { kind: "network", access: "connect", hostScopeDigest: digest("hosts") },
				},
			],
		});
		expect(isRuntimeToolDescriptor(mismatched)).toBe(false);
	});

	it("preserves direct-model-only and hides it from nested models", () => {
		const tool = descriptor();
		const { descriptorDigest: _descriptorDigest, ...body } = tool;
		const directModelOnly = createRuntimeToolDescriptor({ ...body, exposure: "direct-model-only" });
		expect(isRuntimeToolDescriptor(directModelOnly)).toBe(true);
		expect(resourceExposureAllows(directModelOnly.exposure, "root_model")).toBe(true);
		expect(resourceExposureAllows(directModelOnly.exposure, "nested_model")).toBe(false);
		expect(resourceExposureAllows(directModelOnly.exposure, "deferred_executor")).toBe(false);
		expect(resourceExposureAllows("direct", "nested_model")).toBe(true);
	});

	it("models browser tools with separate navigation, DOM, script, transfer, and cookie capabilities", () => {
		const base = descriptor();
		const binding = manifest("browser-tool");
		const { descriptorDigest: _descriptorDigest, ...body } = base;
		const accesses = ["navigate", "dom_read", "script", "download", "upload", "cookie"] as const;
		const browser = createRuntimeToolDescriptor({
			...body,
			identity: identity("browser-tool", "browser.fixture/verify", "browser-tool", binding),
			manifest: binding,
			capabilities: accesses.map((access) => browserCapability(access, `browser-${access}`, binding.combinedDigest)),
			runtimeName: "browser_verify",
		});
		expect(isRuntimeToolDescriptor(browser)).toBe(true);
		expect(browser.capabilities.map((entry) => entry.boundary)).toEqual(
			accesses.map((access) => ({
				kind: "browser",
				access,
				originScopeDigest: digest(`browser-${access}:origins`),
			})),
		);
	});

	it("keeps instructions tainted and requires an independent separation-of-duty receipt", () => {
		const binding = manifest("repository-instruction");
		const instructionDigest = canonicalDigest("Never publish candidate output without verification");
		const instruction = createRuntimeInstructionDescriptor({
			schemaVersion: 1,
			authorityId: AUTHORITY_ID,
			tenantId: TENANT_ID,
			identity: identity("instruction", "repository.instructions/agents", "repository-instruction", binding),
			provenance: {
				schemaVersion: 1,
				authorityId: AUTHORITY_ID,
				tenantId: TENANT_ID,
				source: "project",
				canonicalLocator: "/repo/AGENTS.md",
			},
			manifest: binding,
			descriptorType: "instruction",
			displayName: "Repository instructions",
			description: "Repository-controlled instruction resource",
			capabilities: [],
			risk: { level: "high", sideEffect: "privileged", rationaleDigest: digest("instruction-risk") },
			exposure: "direct",
			trust: "trusted",
			activation: "ready",
			approvalReceiptId: createRuntimeId("receipt", "instruction-approval"),
			inputSource: {
				schemaVersion: 1,
				authorityId: AUTHORITY_ID,
				tenantId: TENANT_ID,
				sourceId: createRuntimeId("inputSource", "repository-instruction"),
				kind: "instruction",
				sourceDigest: instructionDigest,
				trust: "tainted",
				taintLabels: ["executable_instruction", "repository_controlled"],
				observedAt: "2026-07-22T00:00:00.000Z",
			},
			instructionDigest,
			priority: "repository",
			separationOfDutyReceiptId: createRuntimeId("receipt", "instruction-separation"),
		});
		expect(isRuntimeInstructionDescriptor(instruction)).toBe(true);
		expect(
			isRuntimeInstructionDescriptor({
				...instruction,
				separationOfDutyReceiptId: instruction.approvalReceiptId,
			}),
		).toBe(false);
		expect(
			isRuntimeInstructionDescriptor({
				...instruction,
				inputSource: { ...instruction.inputSource, taintLabels: [] },
			}),
		).toBe(false);
	});

	it("separates Skill metadata, body, assets, and script identities/capabilities", () => {
		const base = "project:release-review";
		const metadataBinding = manifest("skill-metadata");
		const bodyBinding = manifest("skill-body");
		const assetsBinding = manifest("skill-assets");
		const scriptBinding = manifest("skill-script");
		const skill: SkillResourceSet = {
			schemaVersion: 1,
			authorityId: AUTHORITY_ID,
			tenantId: TENANT_ID,
			qualifiedId: base,
			metadata: {
				role: "metadata",
				identity: identity("skill", `${base}/metadata`, "skill-metadata", metadataBinding),
				capabilities: [filesystemCapability("skill-metadata-read", metadataBinding.combinedDigest)],
			},
			body: {
				role: "body",
				identity: identity("skill-body", `${base}/body`, "skill-body", bodyBinding),
				capabilities: [filesystemCapability("skill-body-read", bodyBinding.combinedDigest)],
			},
			assets: {
				role: "assets",
				identity: identity("skill-assets", `${base}/assets`, "skill-assets", assetsBinding),
				capabilities: [filesystemCapability("skill-assets-read", assetsBinding.combinedDigest)],
			},
			script: {
				role: "script",
				identity: identity("skill-script", `${base}/script`, "skill-script", scriptBinding),
				capabilities: [processCapability("skill-script-process")],
			},
		};

		expect(isSkillResourceSet(skill)).toBe(true);
		expect(new Set([skill.metadata.identity.resourceId, skill.body.identity.resourceId, skill.assets?.identity.resourceId, skill.script?.identity.resourceId]).size).toBe(4);
		expect(skill.body.capabilities.some((item) => item.boundary.kind === "process")).toBe(false);
		expect(skill.script?.capabilities.some((item) => item.boundary.kind === "process")).toBe(true);
		expect(
			isSkillResourceSet({
				...skill,
				body: { ...skill.body, capabilities: [processCapability("body-process")] },
			}),
		).toBe(false);
		expect(
			isSkillResourceSet({
				...skill,
				script: { ...skill.script!, capabilities: [] },
			}),
		).toBe(false);
	});

	it("accepts raw caller claims only as a request and invokes from a trusted derivation receipt", () => {
		const tool = descriptor();
		const request = invocationRequest(tool);
		const callerClaim = {
			authorityId: AUTHORITY_ID,
			tenantId: TENANT_ID,
			name: "network" as const,
			resourceKind: "network" as const,
			resourceDigest: digest("caller-network"),
			constraintsDigest: digest("caller-network-constraints"),
		};
		const untrustedRequest = { ...request, requestedClaims: [callerClaim] };
		expect(isRuntimeToolInvocationRequest(untrustedRequest)).toBe(true);

		const prepared = invocation(tool, untrustedRequest);
		expect(isResourceClaimDerivationReceipt(prepared.derivationReceipt)).toBe(true);
		expect(prepared.derivationReceipt.claims).toEqual(tool.capabilities.map((item) => item.claim));
		expect(prepared.derivationReceipt.claims).not.toEqual(untrustedRequest.requestedClaims);
		expect(prepared).not.toHaveProperty("requestedClaims");
		expect(prepared).not.toHaveProperty("rawInput");
		expect(isRuntimeToolInvocation(prepared)).toBe(true);
		expect(isRuntimeToolInvocation({ ...prepared, requestedClaims: untrustedRequest.requestedClaims })).toBe(false);
	});

	it("binds canonical input, descriptor, claims, scope, and snapshot in the derivation receipt", () => {
		const tool = descriptor();
		const request = invocationRequest(tool);
		const prepared = invocation(tool, request);
		const receipt = prepared.derivationReceipt;
		expect(receipt.canonicalInputJson).toBe(canonicalJson(request.rawInput));
		expect(receipt.canonicalInputDigest).toBe(canonicalDigest(request.rawInput));
		expect(receipt.descriptorDigest).toBe(tool.descriptorDigest);

		const tampered = createResourceClaimDerivationReceipt({
			...authorizationContext(),
			receiptId: createRuntimeId("receipt", "tampered-derivation"),
			requestId: request.requestId,
			snapshotId: SNAPSHOT_ID,
			toolIdentityDigest: canonicalDigest(tool.identity),
			descriptorDigest: tool.descriptorDigest,
			canonicalInputJson: canonicalJson({ path: "OTHER.md" }),
			canonicalInputDigest: canonicalDigest(request.rawInput),
			claims: tool.capabilities.map((item) => item.claim),
			claimsDigest: canonicalDigest(tool.capabilities.map((item) => item.claim)),
			issuedAt: "2026-07-22T00:00:00.000Z",
		});
		expect(isResourceClaimDerivationReceipt(tampered)).toBe(false);
		expect(isRuntimeToolInvocation({ ...prepared, tenantId: createRuntimeId("tenant", "other") })).toBe(false);
		expect(isRuntimeToolInvocation({ ...prepared, snapshotId: createRuntimeId("snapshot", "other") })).toBe(false);
	});

	it("validates bounded result content and optional ArtifactRef", () => {
		const prepared = invocation();
		const content: readonly ResourceContent[] = [{ type: "text", text: "fixture result" }];
		const result = {
			schemaVersion: 1 as const,
			...authorizationContext(),
			receiptId: createRuntimeId("receipt", "tool-result"),
			requestId: prepared.requestId,
			handshakeDigest: prepared.handshake.handshakeDigest,
			invocationSequence: prepared.invocationSequence,
			terminalSequence: prepared.invocationSequence,
			terminal: "completed" as const,
			tool: prepared.tool,
			snapshotId: prepared.snapshotId,
			correlationId: TRACE_ID,
			content,
			artifact: {
				authorityId: AUTHORITY_ID,
				tenantId: TENANT_ID,
				artifactId: createRuntimeId("artifact", "tool-result"),
				storedDigest: digest("artifact"),
				kind: "tool_output" as const,
				originalSize: 14,
				storedSize: 14,
				mediaType: "text/plain",
				redaction: "redacted" as const,
				transformReceipt: createRuntimeId("receipt", "artifact-transform"),
			},
			isError: false,
			originalBytes: 14,
			truncated: false,
			contentDigest: canonicalDigest(content),
		};

		expect(isRuntimeToolResult(result)).toBe(true);
		expect(isRuntimeToolResult({ ...result, contentDigest: digest("wrong") })).toBe(false);
		expect(
			isRuntimeToolResult({
				...result,
				artifact: { ...result.artifact, tenantId: createRuntimeId("tenant", "other") },
			}),
		).toBe(false);
		expect(isRuntimeToolResult({ ...result, client: {} })).toBe(false);
		expect(PRINCIPAL_ID).toBe(prepared.principalId);
		expect(TENANT_ID).toBe(prepared.tenantId);
	});
});
