import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { canonicalDigest, canonicalJson } from "../../../src/runtime/protocol/v3/canonical-json.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/v3/ids.ts";
import {
	importLegacyResourceApprovalV1,
	parseLegacyResourceIdentityV1,
	parseLegacyResourceManifestDigestV1,
} from "../../../src/runtime/resources/legacy-v1.ts";
import {
	createResourceClaimDerivationReceipt,
	createResourceHookTransformReceipt,
	createResourceLocatorReceipt,
	createResourceProvenance,
	isResourceFacetReadRequest,
	isResourceFacetReadResult,
	isResourceHookTransformReceipt,
	isResourceLocatorReceipt,
	isResourceMcpAnnotation,
	isResourceProvenance,
	isRuntimeToolInvocation,
	resourceIdentityDigest,
} from "../../../src/runtime/resources/schemas.ts";
import type {
	ResourceFacetReadRequest,
	ResourceFacetReadResult,
	ResourceMcpAnnotation,
	RuntimeToolInvocation,
} from "../../../src/runtime/resources/types.ts";
import {
	ADAPTER_ID,
	AUTHORITY_ID,
	PRINCIPAL_ID,
	SNAPSHOT_ID,
	TENANT_ID,
	authorizationContext,
	descriptor,
	digest,
	identity,
	invocation,
	invocationRequest,
	manifest,
} from "./fixtures.ts";

function jsonFixture(name: string): unknown {
	return JSON.parse(
		readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"),
	) as unknown;
}

describe("resource contract v2 closure", () => {
	it("binds canonical locator containment and rejects source-root escape", () => {
		const locator = createResourceLocatorReceipt({
			authorityId: AUTHORITY_ID,
			tenantId: TENANT_ID,
			canonicalLocator: "/repo/.runledger/skills/review/SKILL.md",
			sourceRoot: "/repo",
		});
		expect(isResourceLocatorReceipt(locator)).toBe(true);
		expect(isResourceLocatorReceipt({
			...locator,
			canonicalLocator: "/other/SKILL.md",
		})).toBe(false);

		const provenance = createResourceProvenance({
			authorityId: AUTHORITY_ID,
			tenantId: TENANT_ID,
			source: "project",
			canonicalLocator: locator.canonicalLocator,
			locatorReceipt: locator,
		});
		expect(isResourceProvenance(provenance)).toBe(true);
		expect(isResourceProvenance({
			...provenance,
			canonicalLocator: "/repo/changed",
		})).toBe(false);
	});

	it("keeps v1 identity/manifest read-only and imports v1 approval as reapproval_required", () => {
		const golden = jsonFixture("resource-contract-v1.json") as {
			identity: unknown;
			manifest: unknown;
		};
		expect(parseLegacyResourceIdentityV1(golden.identity)).toBeDefined();
		expect(parseLegacyResourceManifestDigestV1(golden.manifest)).toBeDefined();
		expect(importLegacyResourceApprovalV1(
			jsonFixture("resource-approval-legacy-v1.json"),
		)).toMatchObject({
			legacySchemaVersion: 1,
			state: "reapproval_required",
		});
	});

	it("binds Skill body reads to one snapshot generation and unified budget", () => {
		const body = identity(
			"skill-body",
			"project:review/body",
			"skill-body-v2",
			manifest("skill-body-v2"),
		);
		const request: ResourceFacetReadRequest = {
			schemaVersion: 2,
			...authorizationContext(),
			requestId: createRuntimeId("command", "facet-read"),
			snapshotId: SNAPSHOT_ID,
			adapterGeneration: 7,
			adapterGenerationDigest: digest("adapter-generation-7"),
			resource: body,
			facet: "body",
			budget: { maxBytes: 1024, maxEntries: 4 },
		};
		const content = [{ type: "text" as const, text: "snapshot-bound body" }];
		const result: ResourceFacetReadResult = {
			schemaVersion: 2,
			...authorizationContext(),
			requestId: request.requestId,
			status: "read",
			snapshotId: request.snapshotId,
			adapterGeneration: request.adapterGeneration,
			adapterGenerationDigest: request.adapterGenerationDigest,
			resource: body,
			facet: "body",
			content,
			contentDigest: canonicalDigest(content),
			byteLength: 19,
			entryCount: 1,
		};
		expect(isResourceFacetReadRequest(request)).toBe(true);
		expect(isResourceFacetReadResult(result, request)).toBe(true);
		expect(isResourceFacetReadResult({
			...result,
			adapterGeneration: 8,
		}, request)).toBe(false);
		expect(result).not.toHaveProperty("capabilities");
	});

	it("invalidates pre-transform claims and binds ordered Hook patches plus reauthorization", () => {
		const raw = invocationRequest();
		const original = invocation();
		const updatedInput = { path: "docs/README.md" };
		const updatedInputJson = canonicalJson(updatedInput);
		const hook = identity("hook", "project.hooks/pre-tool", "hook-v2", manifest("hook-v2"));
		const patch = {
			sourceOrder: 0,
			hook,
			beforeInputDigest: original.derivationReceipt.canonicalInputDigest,
			afterInputDigest: canonicalDigest(updatedInput),
			patchDigest: digest("hook-patch"),
			handled: false,
			shortCircuit: false,
		};
		const transform = createResourceHookTransformReceipt({
			...authorizationContext(),
			receiptId: createRuntimeId("receipt", "hook-transform"),
			requestId: raw.requestId,
			handshakeDigest: raw.handshake.handshakeDigest,
			snapshotId: raw.snapshotId,
			inputRevision: 0,
			outputRevision: 1,
			originalInputDigest: original.derivationReceipt.canonicalInputDigest,
			updatedInputJson,
			updatedInputDigest: canonicalDigest(updatedInput),
			patches: [patch],
			handled: false,
			shortCircuit: false,
			systemPromptChainDigest: digest("system-prompt-chain"),
			hookIdentityDigest: resourceIdentityDigest(hook),
			hookGeneration: 7,
			hookGenerationDigest: digest("hook-generation-7"),
			claimsDigest: canonicalDigest(descriptor().capabilities.map((item) => item.claim)),
			authorizationDecisionDigest: digest("post-transform-allow"),
			issuedAt: "2026-07-22T00:00:00.000Z",
		});
		expect(isResourceHookTransformReceipt(transform)).toBe(true);
		expect(isRuntimeToolInvocation({
			...original,
			inputRevision: 1,
			hookTransformReceiptId: transform.receiptId,
		})).toBe(false);

		const claims = descriptor().capabilities.map((item) => item.claim);
		const derived = createResourceClaimDerivationReceipt({
			...authorizationContext(),
			receiptId: createRuntimeId("receipt", "post-transform-claims"),
			requestId: raw.requestId,
			handshakeDigest: raw.handshake.handshakeDigest,
			snapshotId: raw.snapshotId,
			toolIdentityDigest: resourceIdentityDigest(raw.tool),
			descriptorDigest: descriptor().descriptorDigest,
			canonicalInputJson: updatedInputJson,
			canonicalInputDigest: canonicalDigest(updatedInput),
			inputRevision: 1,
			claims,
			claimsDigest: canonicalDigest(claims),
			issuedAt: "2026-07-22T00:00:00.000Z",
		});
		const prepared: RuntimeToolInvocation = {
			...original,
			derivationReceipt: derived,
			inputRevision: 1,
			hookTransformReceiptId: transform.receiptId,
			authorizationDecisionDigest: transform.authorizationDecisionDigest,
		};
		expect(isRuntimeToolInvocation(prepared)).toBe(true);
	});

	it("keeps MCP annotation bounded, canonical, and capability-free", () => {
		const metadata = { readOnlyHint: true, title: "Read file" };
		const metadataJson = canonicalJson(metadata);
		const annotation: ResourceMcpAnnotation = {
			schemaVersion: 2,
			server: identity("mcp-server", "fixture.server/root", "mcp-server-v2"),
			tool: identity("mcp-tool", "fixture.server/read", "mcp-tool-v2"),
			adapterGeneration: 7,
			adapterGenerationDigest: digest("adapter-generation-7"),
			metadataJson,
			metadataDigest: canonicalDigest(metadata),
			byteLength: Buffer.byteLength(metadataJson, "utf8"),
			trust: "untrusted_metadata",
		};
		expect(isResourceMcpAnnotation(annotation)).toBe(true);
		expect(annotation).not.toHaveProperty("capabilities");
		expect(annotation).not.toHaveProperty("decision");
		expect(ADAPTER_ID).toMatch(/^resource_/u);
		expect(PRINCIPAL_ID).toMatch(/^principal_/u);
		expect(TENANT_ID).toMatch(/^tenant_/u);
	});
});
