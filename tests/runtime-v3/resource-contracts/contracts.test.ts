import { Check } from "typebox/value";
import { describe, expect, it } from "vitest";
import { createRuntimeId } from "../../../src/runtime/protocol/v3/ids.ts";
import {
	ResourceApprovalReceiptSchema,
	ResourceIdentitySchema,
	ResourceManifestDigestSchema,
	ResourceProvenanceSchema,
	createResourceManifestDigest,
	createResourceLocatorReceipt,
	createResourceProvenance,
	isResourceApprovalReceipt,
	isResourceIdentity,
	isResourceManifestDigest,
	isResourceProvenance,
	resourceApprovalReceiptMatches,
	resourceIdentityDigest,
	resourceIdentityKey,
} from "../../../src/runtime/resources/schemas.ts";
import {
	AUTHORITY_ID,
	NOW,
	PRINCIPAL_ID,
	TENANT_ID,
	approvalReceipt,
	digest,
	identity,
	manifest,
} from "./fixtures.ts";

describe("resource identity, provenance, and approval contracts", () => {
	it("round-trips exact qualified identity and includes every routing field", () => {
		const resource = identity();
		expect(Check(ResourceIdentitySchema, resource)).toBe(true);
		expect(isResourceIdentity(resource)).toBe(true);
		expect(resourceIdentityKey(resource)).toBe(
			`${AUTHORITY_ID}/${TENANT_ID}/${resource.resourceId}/mcp-tool:fixture.server/read@1.0.0:project:${resource.digest}`,
		);
		expect(resourceIdentityDigest(resource)).toHaveLength(64);
		expect(resourceIdentityKey({ ...resource, source: "user" })).not.toBe(resourceIdentityKey(resource));
		expect(resourceIdentityKey({ ...resource, version: "1.0.1" })).not.toBe(resourceIdentityKey(resource));
		expect(resourceIdentityKey({ ...resource, digest: digest("changed") })).not.toBe(resourceIdentityKey(resource));
	});

	it("rejects unknown versions, unknown fields, missing digest, and ambiguous IDs", () => {
		const resource = identity();
		expect(isResourceIdentity({ ...resource, schemaVersion: 3 })).toBe(false);
		expect(isResourceIdentity({ ...resource, digest: undefined })).toBe(false);
		expect(isResourceIdentity({ ...resource, qualifiedId: "read" })).toBe(false);
		expect(isResourceIdentity({ ...resource, kind: "mcp" })).toBe(false);
		expect(isResourceIdentity({ ...resource, displayName: "not part of identity" })).toBe(false);
	});

	it("represents source, publisher/signature, and parent plugin without parsing configuration", () => {
		const parent = identity("plugin", "fixture.plugin/root", "fixture-plugin", manifest("fixture-plugin"));
		const provenance = createResourceProvenance({
			authorityId: AUTHORITY_ID,
			tenantId: TENANT_ID,
			source: "plugin" as const,
			canonicalLocator: "/repo/.runledger/plugins/fixture",
			locatorReceipt: createResourceLocatorReceipt({
				authorityId: AUTHORITY_ID,
				tenantId: TENANT_ID,
				canonicalLocator: "/repo/.runledger/plugins/fixture",
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
			parentPlugin: parent,
		});

		expect(Check(ResourceProvenanceSchema, provenance)).toBe(true);
		expect(isResourceProvenance(provenance)).toBe(true);
		expect(isResourceProvenance({ ...provenance, source: "filesystem" })).toBe(false);
		expect(
			isResourceProvenance({
				...provenance,
				parentPlugin: { ...parent, kind: "skill" },
			}),
		).toBe(false);
	});

	it("binds every manifest component into one content identity", () => {
		const binding = manifest();
		expect(Check(ResourceManifestDigestSchema, binding)).toBe(true);
		expect(isResourceManifestDigest(binding)).toBe(true);

		for (const field of [
			"rootDigest",
			"manifestDigest",
			"configDigest",
			"commandDigest",
			"assetsDigest",
			"capabilityDigest",
		] as const) {
			const changed = createResourceManifestDigest({
				rootDigest: binding.rootDigest,
				manifestDigest: binding.manifestDigest,
				configDigest: binding.configDigest,
				commandDigest: binding.commandDigest,
				assetsDigest: binding.assetsDigest,
				capabilityDigest: binding.capabilityDigest,
				[field]: digest(`changed:${field}`),
			});
			expect(changed.combinedDigest, field).not.toBe(binding.combinedDigest);
		}
		expect(isResourceManifestDigest({ ...binding, configDigest: digest("tampered") })).toBe(false);
	});

	it("validates approval identity, all digests, principal, scope, expiry, and revision", () => {
		const binding = manifest();
		const resource = identity("mcp-tool", "fixture.server/read", "fixture-tool", binding);
		const receipt = approvalReceipt(resource, binding);
		const expected = {
			identity: resource,
			binding,
			principalId: PRINCIPAL_ID,
			scope: "project" as const,
			scopeBindingDigest: digest("project-scope"),
			revocationRevision: 3,
			locatorDigest: digest("resource-locator"),
			publisherDigest: digest("publisher"),
			policyRevision: 5,
			hookRevision: 7,
			adapterGeneration: 7,
			adapterGenerationDigest: digest("adapter-generation-7"),
			at: NOW,
		};

		expect(Check(ResourceApprovalReceiptSchema, receipt)).toBe(true);
		expect(isResourceApprovalReceipt(receipt, NOW)).toBe(true);
		expect(resourceApprovalReceiptMatches(receipt, expected)).toBe(true);
		expect(resourceApprovalReceiptMatches(receipt, { ...expected, principalId: "principal_other" })).toBe(false);
		expect(resourceApprovalReceiptMatches(receipt, { ...expected, scope: "user" })).toBe(false);
		expect(
			resourceApprovalReceiptMatches(receipt, { ...expected, scopeBindingDigest: digest("other-scope") }),
		).toBe(false);
		expect(resourceApprovalReceiptMatches(receipt, { ...expected, revocationRevision: 4 })).toBe(false);

		const changedBinding = createResourceManifestDigest({
			rootDigest: binding.rootDigest,
			manifestDigest: binding.manifestDigest,
			configDigest: digest("changed-config"),
			commandDigest: binding.commandDigest,
			assetsDigest: binding.assetsDigest,
			capabilityDigest: binding.capabilityDigest,
		});
		expect(resourceApprovalReceiptMatches(receipt, { ...expected, binding: changedBinding })).toBe(false);
		expect(
			resourceApprovalReceiptMatches(receipt, {
				...expected,
				identity: { ...resource, digest: changedBinding.combinedDigest },
			}),
		).toBe(false);
		expect(isResourceApprovalReceipt(receipt, new Date("2030-01-01T00:00:00.000Z"))).toBe(false);
		expect(isResourceApprovalReceipt({ ...receipt, expiresAt: "2099-01-01T00:00:00.000Z" }, NOW)).toBe(false);
		expect(isResourceApprovalReceipt({ ...receipt, extra: true }, NOW)).toBe(false);
	});
});
