/** Browser verification 的固定受限 profile 与封闭 operation 协议。 */

import { Type, type TSchema } from "typebox";
import { Check } from "typebox/value";
import { canonicalDigest } from "../../runtime/protocol/v3/canonical-json.ts";
import type {
	BrowserVerificationGate,
	GateExpectedArtifact,
	GateManifest,
	VerificationCoreResult,
} from "../../runtime/verification/types.ts";

const digest = Type.String({ pattern: "^[a-f0-9]{64}$", maxLength: 64 });
const token = Type.String({ minLength: 1, maxLength: 512 });
const url = Type.String({ minLength: 1, maxLength: 4096 });
const exact = <T extends Record<string, TSchema>>(properties: T) =>
	Type.Object(properties, { additionalProperties: false });

export const BROWSER_BACKEND_SCHEMA_VERSION = 1 as const;

export interface RestrictedBrowserProfile {
	schemaVersion: typeof BROWSER_BACKEND_SCHEMA_VERSION;
	runtimeResourceId: string;
	runtimeIdentityDigest: string;
	profileResourceId: string;
	profileIdentityDigest: string;
	profilePolicyDigest: string;
	entryUrl: string;
	origin: string;
	networkPolicyDigest: string;
	networkMode: "allowlist";
	allowedHosts: readonly string[];
	headless: true;
	script: "deny";
	upload: "deny";
	download: "deny";
	cookie: "deny";
	credential: "deny";
	profileDigest: string;
}

export type BrowserBackendOperation =
	| { kind: "launch"; headless: true }
	| { kind: "navigate"; url: string; origin: string }
	| { kind: "network"; origin: string; networkPolicyDigest: string }
	| { kind: "download"; url: string; downloadScopeDigest: string }
	| { kind: "cookie_credential"; access: "cookie" | "credential"; scopeDigest: string }
	| { kind: "screenshot"; outputName: string; schemaDigest: string; maxBytes: number }
	| { kind: "dom_read"; outputName: string; schemaDigest: string; maxBytes: number; domScopeDigest: string }
	| { kind: "console_read"; outputName: string; schemaDigest: string; maxBytes: number }
	| {
			kind: "network_evidence";
			outputName: string;
			schemaDigest: string;
			maxBytes: number;
			maxEntries: number;
			maxBodyBytes: number;
			redactionPolicyDigest: string;
	  }
	| { kind: "evidence_seal"; outputNamesDigest: string };

export const RestrictedBrowserProfileSchema = exact({
	schemaVersion: Type.Literal(BROWSER_BACKEND_SCHEMA_VERSION),
	runtimeResourceId: token,
	runtimeIdentityDigest: digest,
	profileResourceId: token,
	profileIdentityDigest: digest,
	profilePolicyDigest: digest,
	entryUrl: url,
	origin: Type.String({ minLength: 1, maxLength: 512 }),
	networkPolicyDigest: digest,
	networkMode: Type.Literal("allowlist"),
	allowedHosts: Type.Array(token, { minItems: 1, maxItems: 256, uniqueItems: true }),
	headless: Type.Literal(true),
	script: Type.Literal("deny"),
	upload: Type.Literal("deny"),
	download: Type.Literal("deny"),
	cookie: Type.Literal("deny"),
	credential: Type.Literal("deny"),
	profileDigest: digest,
});

export const BrowserBackendOperationSchema = Type.Union([
	exact({ kind: Type.Literal("launch"), headless: Type.Literal(true) }),
	exact({ kind: Type.Literal("navigate"), url, origin: Type.String({ minLength: 1, maxLength: 512 }) }),
	exact({ kind: Type.Literal("network"), origin: Type.String({ minLength: 1, maxLength: 512 }), networkPolicyDigest: digest }),
	exact({ kind: Type.Literal("download"), url, downloadScopeDigest: digest }),
	exact({
		kind: Type.Literal("cookie_credential"),
		access: Type.Union([Type.Literal("cookie"), Type.Literal("credential")]),
		scopeDigest: digest,
	}),
	exact({
		kind: Type.Literal("screenshot"),
		outputName: token,
		schemaDigest: digest,
		maxBytes: Type.Integer({ minimum: 1, maximum: 128 * 1024 * 1024 }),
	}),
	exact({
		kind: Type.Literal("dom_read"),
		outputName: token,
		schemaDigest: digest,
		maxBytes: Type.Integer({ minimum: 1, maximum: 128 * 1024 * 1024 }),
		domScopeDigest: digest,
	}),
	exact({
		kind: Type.Literal("console_read"),
		outputName: token,
		schemaDigest: digest,
		maxBytes: Type.Integer({ minimum: 1, maximum: 128 * 1024 * 1024 }),
	}),
	exact({
		kind: Type.Literal("network_evidence"),
		outputName: token,
		schemaDigest: digest,
		maxBytes: Type.Integer({ minimum: 1, maximum: 128 * 1024 * 1024 }),
		maxEntries: Type.Integer({ minimum: 1, maximum: 100_000 }),
		maxBodyBytes: Type.Integer({ minimum: 0, maximum: 128 * 1024 * 1024 }),
		redactionPolicyDigest: digest,
	}),
	exact({ kind: Type.Literal("evidence_seal"), outputNamesDigest: digest }),
]);

function profileBody(profile: RestrictedBrowserProfile): Omit<RestrictedBrowserProfile, "profileDigest"> {
	const { profileDigest: _profileDigest, ...body } = profile;
	return body;
}

export function isRestrictedBrowserProfile(value: unknown): value is RestrictedBrowserProfile {
	if (!Check(RestrictedBrowserProfileSchema, value)) return false;
	const profile = value as RestrictedBrowserProfile;
	return profile.profileDigest === canonicalDigest(profileBody(profile));
}

export function isBrowserBackendOperation(value: unknown): value is BrowserBackendOperation {
	return Check(BrowserBackendOperationSchema, value);
}

function artifactByKind(
	manifest: GateManifest,
	kind: GateExpectedArtifact["kind"],
): GateExpectedArtifact | undefined {
	return manifest.expectedArtifacts.find((artifact) => artifact.kind === kind && artifact.required);
}

function evidenceOperation(
	artifact: GateExpectedArtifact | undefined,
	browser: BrowserVerificationGate,
): BrowserBackendOperation | undefined {
	if (!artifact) return undefined;
	switch (artifact.kind) {
		case "screenshot":
			return {
				kind: "screenshot",
				outputName: artifact.name,
				schemaDigest: artifact.schemaDigest,
				maxBytes: artifact.maxBytes,
			};
		case "dom_snapshot":
			return {
				kind: "dom_read",
				outputName: artifact.name,
				schemaDigest: artifact.schemaDigest,
				maxBytes: artifact.maxBytes,
				domScopeDigest: browser.stepSchemaDigest,
			};
		case "console_log":
			return {
				kind: "console_read",
				outputName: artifact.name,
				schemaDigest: artifact.schemaDigest,
				maxBytes: artifact.maxBytes,
			};
		case "network_trace":
			return {
				kind: "network_evidence",
				outputName: artifact.name,
				schemaDigest: artifact.schemaDigest,
				maxBytes: artifact.maxBytes,
				maxEntries: browser.networkEvidence.maxEntries,
				maxBodyBytes: browser.networkEvidence.maxBodyBytes,
				redactionPolicyDigest: browser.networkEvidence.redactionPolicyDigest,
			};
		default:
			return undefined;
	}
}

/**
 * Profile 只允许固定 origin/network 与四类证据读取。下载、上传、脚本、cookie 和
 * credential 始终 deny；要扩大能力必须发布新的受信 profile identity。
 */
export function createRestrictedBrowserProfile(
	manifest: GateManifest,
): VerificationCoreResult<{ profile: RestrictedBrowserProfile; operations: readonly BrowserBackendOperation[] }> {
	const browser = manifest.browser;
	if (!browser || manifest.kind !== "browser") {
		return { ok: false, error: { code: "invalid_schema", message: "browser gate contract is missing", retryable: false } };
	}
	let entry: URL;
	try {
		entry = new URL(browser.entryUrl);
	} catch {
		return { ok: false, error: { code: "untrusted_gate", message: "browser entry URL is invalid", retryable: false } };
	}
	if (
		entry.origin !== browser.origin ||
		manifest.network.mode !== "allowlist" ||
		!manifest.network.hosts.includes(entry.hostname) ||
		browser.networkPolicyDigest !== canonicalDigest(manifest.network)
	) {
		return { ok: false, error: { code: "untrusted_gate", message: "browser origin is outside the fixed network policy", retryable: false } };
	}
	const body: Omit<RestrictedBrowserProfile, "profileDigest"> = {
		schemaVersion: BROWSER_BACKEND_SCHEMA_VERSION,
		runtimeResourceId: browser.runtime.resourceId,
		runtimeIdentityDigest: browser.runtime.identityDigest,
		profileResourceId: browser.profile.resourceId,
		profileIdentityDigest: browser.profile.identityDigest,
		profilePolicyDigest: browser.profile.policyDigest,
		entryUrl: browser.entryUrl,
		origin: browser.origin,
		networkPolicyDigest: browser.networkPolicyDigest,
		networkMode: "allowlist",
		allowedHosts: [...manifest.network.hosts],
		headless: true,
		script: "deny",
		upload: "deny",
		download: "deny",
		cookie: "deny",
		credential: "deny",
	};
	const profile: RestrictedBrowserProfile = { ...body, profileDigest: canonicalDigest(body) };
	const evidence = [
		evidenceOperation(artifactByKind(manifest, "screenshot"), browser),
		evidenceOperation(artifactByKind(manifest, "dom_snapshot"), browser),
		evidenceOperation(artifactByKind(manifest, "console_log"), browser),
		evidenceOperation(artifactByKind(manifest, "network_trace"), browser),
	];
	if (!isRestrictedBrowserProfile(profile) || evidence.some((operation) => operation === undefined)) {
		return { ok: false, error: { code: "invalid_schema", message: "browser evidence profile is incomplete", retryable: false } };
	}
	const evidenceOperations = evidence.filter((operation): operation is BrowserBackendOperation => operation !== undefined);
	const outputNames = evidenceOperations.flatMap((operation) =>
		"outputName" in operation ? [operation.outputName] : [],
	);
	return {
		ok: true,
		value: {
			profile,
			operations: [
				{ kind: "launch", headless: true },
				{ kind: "network", origin: browser.origin, networkPolicyDigest: browser.networkPolicyDigest },
				{ kind: "navigate", url: browser.entryUrl, origin: browser.origin },
				...evidenceOperations,
				{ kind: "evidence_seal", outputNamesDigest: canonicalDigest([...outputNames].sort()) },
			],
		},
	};
}

export function browserOperationDigest(operation: BrowserBackendOperation): string {
	if (!isBrowserBackendOperation(operation)) throw new Error("invalid browser backend operation");
	return canonicalDigest(operation);
}

export function restrictedProfileAllowsOperation(
	profile: RestrictedBrowserProfile,
	operation: BrowserBackendOperation,
): boolean {
	if (!isRestrictedBrowserProfile(profile) || !isBrowserBackendOperation(operation)) return false;
	if (operation.kind === "download" || operation.kind === "cookie_credential") return false;
	if (operation.kind === "navigate") return operation.origin === profile.origin && operation.url === profile.entryUrl;
	if (operation.kind === "network") {
		return operation.origin === profile.origin && operation.networkPolicyDigest === profile.networkPolicyDigest;
	}
	return true;
}
