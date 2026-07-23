/** Runtime-owned production dependency readiness receipt。 */

import { canonicalDigest } from "../protocol/v3/canonical-json.ts";

export const RUNTIME_DEPENDENCY_READINESS_VERSION = 1 as const;
export const RUNTIME_DEPENDENCY_READINESS_STATUSES = [
	"ready",
	"unsupported",
	"external_gap",
] as const;

export type RuntimeDependencyReadinessStatus =
	(typeof RUNTIME_DEPENDENCY_READINESS_STATUSES)[number];

export const RUNTIME_DEPENDENCY_SCOPES = [
	"plan_context_memory",
	"resources_extensions",
	"workspace_security",
	"verification_core",
	"browser_backend",
	"episode_seal",
] as const;

export type RuntimeDependencyScope = (typeof RUNTIME_DEPENDENCY_SCOPES)[number];
export type RuntimeProductionFeature =
	| "governed_operations"
	| "verification"
	| "browser_verification"
	| "completion";

export interface RuntimeDependencyReadinessEntryBody {
	scope: RuntimeDependencyScope;
	status: RuntimeDependencyReadinessStatus;
	contractId: string;
	schemaVersion: number;
	contractDigest: string;
	adapterId?: string;
	adapterIdentityDigest?: string;
	adapterGeneration?: number;
	adapterGenerationDigest?: string;
	recoveryEvidenceDigest?: string;
	recovery: "recoverable" | "unavailable" | "not_applicable";
	requiredFor: readonly RuntimeProductionFeature[];
	reasonDigest?: string;
}

export interface RuntimeDependencyReadinessEntry
	extends RuntimeDependencyReadinessEntryBody {
	entryDigest: string;
}

export interface RuntimeDependencyReadinessReceiptBody {
	schemaVersion: typeof RUNTIME_DEPENDENCY_READINESS_VERSION;
	environment: "production";
	compositionId: string;
	generatedAt: string;
	entries: readonly RuntimeDependencyReadinessEntry[];
}

export interface RuntimeDependencyReadinessReceipt
	extends RuntimeDependencyReadinessReceiptBody {
	receiptDigest: string;
}

const DIGEST = /^[a-f0-9]{64}$/u;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;
const FEATURE_SET: ReadonlySet<string> = new Set<RuntimeProductionFeature>([
	"governed_operations",
	"verification",
	"browser_verification",
	"completion",
]);

function entryBody(entry: RuntimeDependencyReadinessEntry): RuntimeDependencyReadinessEntryBody {
	const { entryDigest: _entryDigest, ...body } = entry;
	return body;
}

function validEntry(entry: RuntimeDependencyReadinessEntry): boolean {
	if (
		!RUNTIME_DEPENDENCY_SCOPES.includes(entry.scope) ||
		!RUNTIME_DEPENDENCY_READINESS_STATUSES.includes(entry.status) ||
		!entry.contractId ||
		!Number.isSafeInteger(entry.schemaVersion) ||
		entry.schemaVersion < 1 ||
		!DIGEST.test(entry.contractDigest) ||
		entry.requiredFor.length === 0 ||
		new Set(entry.requiredFor).size !== entry.requiredFor.length ||
		!entry.requiredFor.every((feature) => FEATURE_SET.has(feature)) ||
		entry.entryDigest !== canonicalDigest(entryBody(entry))
	) return false;
	if (entry.status !== "ready") return !!entry.reasonDigest && DIGEST.test(entry.reasonDigest);
	if (entry.recovery === "unavailable") return false;
	if (
		!entry.adapterId ||
		!entry.adapterIdentityDigest ||
		!DIGEST.test(entry.adapterIdentityDigest) ||
		entry.adapterGeneration === undefined ||
		!Number.isSafeInteger(entry.adapterGeneration) ||
		entry.adapterGeneration < 1 ||
		!entry.adapterGenerationDigest ||
		!DIGEST.test(entry.adapterGenerationDigest)
	) return false;
	return entry.recovery !== "recoverable" ||
		(!!entry.recoveryEvidenceDigest && DIGEST.test(entry.recoveryEvidenceDigest));
}

export function createRuntimeDependencyReadinessEntry(
	body: RuntimeDependencyReadinessEntryBody,
): RuntimeDependencyReadinessEntry {
	const entry = { ...body, requiredFor: [...body.requiredFor], entryDigest: canonicalDigest(body) };
	if (!validEntry(entry)) throw new TypeError("runtime dependency readiness entry is invalid");
	return entry;
}

export function isRuntimeDependencyReadinessReceipt(
	value: RuntimeDependencyReadinessReceipt,
): boolean {
	if (
		value.schemaVersion !== RUNTIME_DEPENDENCY_READINESS_VERSION ||
		value.environment !== "production" ||
		!value.compositionId ||
		!TIMESTAMP.test(value.generatedAt) ||
		value.entries.length !== RUNTIME_DEPENDENCY_SCOPES.length ||
		new Set(value.entries.map((entry) => entry.scope)).size !== value.entries.length ||
		!value.entries.every(validEntry)
	) return false;
	const { receiptDigest: _receiptDigest, ...body } = value;
	return value.receiptDigest === canonicalDigest(body);
}

export function createRuntimeDependencyReadinessReceipt(input: {
	compositionId: string;
	generatedAt: string;
	entries: readonly RuntimeDependencyReadinessEntry[];
}): RuntimeDependencyReadinessReceipt {
	const ordered = [...input.entries].sort(
		(left, right) => RUNTIME_DEPENDENCY_SCOPES.indexOf(left.scope) -
			RUNTIME_DEPENDENCY_SCOPES.indexOf(right.scope),
	);
	const body: RuntimeDependencyReadinessReceiptBody = {
		schemaVersion: RUNTIME_DEPENDENCY_READINESS_VERSION,
		environment: "production",
		compositionId: input.compositionId,
		generatedAt: input.generatedAt,
		entries: ordered,
	};
	const receipt = { ...body, receiptDigest: canonicalDigest(body) };
	if (!isRuntimeDependencyReadinessReceipt(receipt)) {
		throw new TypeError("runtime dependency readiness receipt is invalid");
	}
	return receipt;
}

export function runtimeFeatureReadiness(
	receipt: RuntimeDependencyReadinessReceipt,
	feature: RuntimeProductionFeature,
): RuntimeDependencyReadinessStatus {
	if (!isRuntimeDependencyReadinessReceipt(receipt)) return "unsupported";
	const required = receipt.entries.filter((entry) => entry.requiredFor.includes(feature));
	if (required.length === 0 || required.some((entry) => entry.status === "unsupported")) return "unsupported";
	return required.some((entry) => entry.status === "external_gap") ? "external_gap" : "ready";
}

export function createUnavailableRuntimeReadiness(
	compositionId: string,
	generatedAt: string,
): RuntimeDependencyReadinessReceipt {
	return createRuntimeDependencyReadinessReceipt({
		compositionId,
		generatedAt,
		entries: RUNTIME_DEPENDENCY_SCOPES.map((scope) =>
			createRuntimeDependencyReadinessEntry({
				scope,
				status: "external_gap",
				contractId: `runledger.${scope}`,
				schemaVersion: 1,
				contractDigest: canonicalDigest({ scope, schemaVersion: 1 }),
				recovery: "unavailable",
				requiredFor: scope === "browser_backend"
					? ["browser_verification", "completion"]
					: scope === "verification_core" || scope === "episode_seal"
						? ["verification", "completion"]
						: ["governed_operations", "completion"],
				reasonDigest: canonicalDigest(`${scope} production readiness was not supplied`),
			})),
	});
}
