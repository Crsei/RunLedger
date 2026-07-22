import { describe, expect, it } from "vitest";
import { canonicalDigest } from "../../../src/runtime/protocol/v3/canonical-json.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/v3/ids.ts";
import {
	browserEvidenceArtifactsDigest,
	browserExecutionBindingDigest,
	browserOperationReceiptsDigest,
	createVerificationResult,
	isBrowserExecutionReceipt,
} from "../../../src/runtime/verification/evidence.ts";
import type {
	BrowserExecutionReceipt,
	BrowserOperationReceipt,
	GateManifest,
	GateManifestBody,
} from "../../../src/runtime/verification/types.ts";
import {
	AUTHORITY_ID,
	CANDIDATE_COMMIT,
	REQUEST_ID,
	TENANT_ID,
	VERIFICATION_ID,
	artifactReceipt,
	admissionBundle,
	baselineReceipt,
	candidate,
	digest,
	executionEvidence,
	gateManifest,
	invocation,
	policy,
} from "./helpers.ts";

const NETWORK: GateManifestBody["network"] = { mode: "allowlist", hosts: ["app.example.test"] };

function browserManifest(): GateManifest {
	return gateManifest({
		kind: "browser",
		network: NETWORK,
		browser: {
			runtime: {
				resourceId: createRuntimeId("resource", "browser-runtime"),
				version: "chromium-128.0.0",
				identityDigest: digest("browser-runtime"),
			},
			profile: {
				resourceId: createRuntimeId("resource", "browser-profile"),
				identityDigest: digest("browser-profile"),
				policyDigest: digest("browser-profile-policy"),
			},
			entryUrl: "https://app.example.test/verification",
			origin: "https://app.example.test",
			stepSchemaDigest: digest("browser-step-schema"),
			stepsDigest: digest("browser-steps"),
			assertionSchemaDigest: digest("browser-assertion-schema"),
			trustedAssertionsDigest: digest("browser-assertions"),
			networkPolicyDigest: canonicalDigest(NETWORK),
			networkEvidence: {
				maxEntries: 1_000,
				maxBodyBytes: 64 * 1024,
				redactionPolicyDigest: digest("browser-network-redaction"),
			},
		},
		expectedArtifacts: [
			{ name: "screenshot", kind: "screenshot", mediaType: "image/png", schemaDigest: digest("screenshot-schema"), required: true, maxBytes: 5_000_000 },
			{ name: "dom", kind: "dom_snapshot", mediaType: "application/json", schemaDigest: digest("dom-schema"), required: true, maxBytes: 2_000_000 },
			{ name: "console", kind: "console_log", mediaType: "application/json", schemaDigest: digest("console-schema"), required: true, maxBytes: 1_000_000 },
			{ name: "network", kind: "network_trace", mediaType: "application/json", schemaDigest: digest("network-schema"), required: true, maxBytes: 2_000_000 },
		],
	});
}

function artifactsFor(manifest: GateManifest) {
	return manifest.expectedArtifacts.map((entry) => artifactReceipt({
		outputName: entry.name,
		kind: entry.kind,
		mediaType: entry.mediaType,
		schemaDigest: entry.schemaDigest,
		artifactSeed: `browser-${entry.name}`,
	}));
}

function browserReceipt(
	manifest: GateManifest,
	patch: Partial<Omit<BrowserExecutionReceipt, "receiptDigest">> = {},
	evidenceArtifacts = artifactsFor(manifest),
): BrowserExecutionReceipt {
	if (!manifest.browser) throw new Error("browser manifest is missing its browser contract");
	const bindingFields = {
		gateDigest: patch.gateDigest ?? manifest.manifestDigest,
		runtimeResourceId: patch.runtimeResourceId ?? manifest.browser.runtime.resourceId,
		runtimeIdentityDigest: patch.runtimeIdentityDigest ?? manifest.browser.runtime.identityDigest,
		profileResourceId: patch.profileResourceId ?? manifest.browser.profile.resourceId,
		profileIdentityDigest: patch.profileIdentityDigest ?? manifest.browser.profile.identityDigest,
		profilePolicyDigest: patch.profilePolicyDigest ?? manifest.browser.profile.policyDigest,
		entryUrl: patch.entryUrl ?? manifest.browser.entryUrl,
		origin: patch.origin ?? manifest.browser.origin,
		networkPolicyDigest: patch.networkPolicyDigest ?? manifest.browser.networkPolicyDigest,
		candidateCommit: patch.candidateCommit ?? CANDIDATE_COMMIT,
		candidateIdentityDigest: patch.candidateIdentityDigest ?? canonicalDigest(candidate()),
	};
	const bindingDigest = browserExecutionBindingDigest(bindingFields);
	type OperationBody = BrowserOperationReceipt extends infer T
		? T extends BrowserOperationReceipt
			? Omit<T, "receiptDigest">
			: never
		: never;
	const seal = (operation: OperationBody): BrowserOperationReceipt => ({
		...operation,
		receiptDigest: canonicalDigest(operation),
	} as BrowserOperationReceipt);
	const common = (sequence: number, kind: string) => ({
		sequence,
		operationId: createRuntimeId("command", `browser-${kind}`),
		operationDigest: digest(`operation-${kind}`),
		capability: kind === "network" ? "network" as const : "browser" as const,
		capabilityRequestDigest: digest(`capability-request-${kind}`),
		capabilityDecisionDigest: digest(`capability-decision-${kind}`),
		sandboxReceiptId: createRuntimeId("receipt", `sandbox-${kind}`),
		sandboxInvocationDigest: digest(`sandbox-invocation-${kind}`),
		sandboxReceiptDigest: digest(`sandbox-receipt-${kind}`),
		backendReceiptId: createRuntimeId("receipt", `backend-${kind}`),
		backendReceiptDigest: digest(`backend-receipt-${kind}`),
		bindingDigest,
	});
	const operationReceipts: BrowserOperationReceipt[] = [
		seal({ ...common(0, "launch"), kind: "launch" }),
		seal({ ...common(1, "network"), kind: "network", originDigest: canonicalDigest(bindingFields.origin), networkPolicyDigest: bindingFields.networkPolicyDigest }),
		seal({ ...common(2, "navigate"), kind: "navigate", urlDigest: canonicalDigest(bindingFields.entryUrl), originDigest: canonicalDigest(bindingFields.origin) }),
		seal({ ...common(3, "screenshot"), kind: "screenshot", outputName: "screenshot" }),
		seal({ ...common(4, "dom"), kind: "dom_read", outputName: "dom", domScopeDigest: manifest.browser.stepSchemaDigest }),
		seal({ ...common(5, "console"), kind: "console_read", outputName: "console" }),
		seal({ ...common(6, "network-evidence"), kind: "network_evidence", outputName: "network", boundsDigest: digest("network-bounds") }),
		seal({ ...common(7, "evidence-seal"), kind: "evidence_seal", outputNamesDigest: canonicalDigest(["console", "dom", "network", "screenshot"]) }),
	];
	const body: Omit<BrowserExecutionReceipt, "receiptDigest"> = {
		authorityId: AUTHORITY_ID,
		tenantId: TENANT_ID,
		receiptId: createRuntimeId("receipt", "browser-execution"),
		requestId: REQUEST_ID,
		verificationId: VERIFICATION_ID,
		...bindingFields,
		stepSchemaDigest: manifest.browser.stepSchemaDigest,
		stepsDigest: manifest.browser.stepsDigest,
		assertionSchemaDigest: manifest.browser.assertionSchemaDigest,
		trustedAssertionsDigest: manifest.browser.trustedAssertionsDigest,
		workspaceValidationReceiptId: createRuntimeId("receipt", "browser-workspace-validation"),
		workspaceValidationReceiptDigest: digest("browser-workspace-validation"),
		bindingDigest,
		operationReceipts,
		operationReceiptsDigest: browserOperationReceiptsDigest(operationReceipts),
		evidenceArtifactsDigest: browserEvidenceArtifactsDigest(evidenceArtifacts),
		executedAt: "2026-07-22T08:00:01.000Z",
		...patch,
	};
	return { ...body, receiptDigest: canonicalDigest(body) };
}

function resultFor(input: {
	artifacts?: ReturnType<typeof artifactsFor>;
	browser?: BrowserExecutionReceipt;
} = {}) {
	const manifest = browserManifest();
	const baseline = baselineReceipt(policy(manifest));
	const command = invocation({ manifest, baseline });
	const artifacts = input.artifacts ?? artifactsFor(manifest);
	return createVerificationResult(
		baseline,
		command,
		executionEvidence({
			invocationDigest: command.invocationDigest,
			artifacts,
			browserExecution: input.browser ?? browserReceipt(manifest, {}, artifacts),
		}),
		admissionBundle(command),
	);
}

describe("trusted browser verification evidence", () => {
	it("accepts exactly the four required Artifact receipts bound to the browser runtime and candidate", () => {
		const result = resultFor();
		expect(result.ok && result.value.outcome).toBe("passed");
		if (result.ok) expect(result.value.artifacts.map((entry) => entry.artifact.kind).sort()).toEqual([
			"console_log",
			"dom_snapshot",
			"network_trace",
			"screenshot",
		]);
	});

	it.each(["screenshot", "dom", "console", "network"])("rejects missing %s evidence", (missing) => {
		const manifest = browserManifest();
		const result = resultFor({ artifacts: artifactsFor(manifest).filter((entry) => entry.outputName !== missing) });
		expect(result).toMatchObject({ ok: false, error: { code: "artifact_invalid" } });
	});

	it("rejects stale candidate evidence and forged stdout in place of Artifact receipts", () => {
		const manifest = browserManifest();
		const stale = artifactsFor(manifest);
		stale[0] = artifactReceipt({
			outputName: manifest.expectedArtifacts[0]!.name,
			kind: manifest.expectedArtifacts[0]!.kind,
			mediaType: manifest.expectedArtifacts[0]!.mediaType,
			schemaDigest: manifest.expectedArtifacts[0]!.schemaDigest,
			artifactSeed: "stale-browser",
			candidateCommit: "0".repeat(40),
		});
		expect(resultFor({ artifacts: stale })).toMatchObject({ ok: false, error: { code: "cross_commit_evidence" } });
		expect(resultFor({
			artifacts: [artifactReceipt({
				outputName: "stdout",
				kind: "log",
				mediaType: "text/plain",
				schemaDigest: digest("forged-success"),
				artifactSeed: "forged-browser-stdout",
			})],
		})).toMatchObject({ ok: false, error: { code: "artifact_invalid" } });
	});

	it.each([
		["runtime", { runtimeIdentityDigest: digest("wrong-runtime") }],
		["profile", { profileIdentityDigest: digest("wrong-profile") }],
		["origin", { origin: "https://evil.example.test" }],
		["network", { networkPolicyDigest: digest("wrong-network") }],
	] as const)("rejects a recomputed browser receipt with mismatched %s identity", (_name, patch) => {
		const manifest = browserManifest();
		const receipt = browserReceipt(manifest, patch);
		expect(isBrowserExecutionReceipt(receipt)).toBe(true);
		expect(resultFor({ browser: receipt })).toMatchObject({ ok: false, error: { code: "cross_commit_evidence" } });
	});
});
