/** 五层 Context 的 exact TypeBox schema 与 scope/budget 约束。 */

import { Type, type TSchema } from "typebox";
import { Check } from "typebox/value";
import { ArtifactRefSchema, CapabilityClaimSchema } from "../protocol/v3/capability.ts";
import { WorkspaceBindingRefSchema } from "../protocol/v3/workspace.ts";
import {
	DeclassificationReceiptRefSchema,
	InputSourceRefSchema,
	isDeclassificationReceiptRef,
	isInputSourceRef,
} from "../protocol/v3/taint.ts";
import {
	CONTEXT_CONTRACT_VERSION,
	CONTEXT_LAYERS,
	CONTEXT_OMISSION_REASONS,
	CONTEXT_TAINTS,
	CONTEXT_TRUST_LEVELS,
	type ContextAssemblyBudget,
	type ContextAssemblyReceipt,
	type ContextAssemblyRequest,
	type ContextFragment,
	type ContextFragmentReceipt,
	type ContextOmissionDiagnostic,
	type ContextProvenance,
} from "./types.ts";

export const CONTEXT_SCHEMA_VERSION = CONTEXT_CONTRACT_VERSION;
export const MAX_CONTEXT_FRAGMENTS = 256;
export const MAX_CONTEXT_FRAGMENT_CHARS = 65_536;
export const MAX_CONTEXT_TOTAL_CHARS = 1_048_576;
export const MAX_CONTEXT_TOKENS = 4_194_304;
export const MAX_CONTEXT_DIAGNOSTICS = 256;

const digestPattern = "^[a-f0-9]{64}$";
const timestampPattern = "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{3})?Z$";
const id = (kind: string) =>
	Type.String({ pattern: `^${kind}_[A-Za-z0-9][A-Za-z0-9._~-]*$`, maxLength: 128 });
const digest = Type.String({ pattern: digestPattern, minLength: 64, maxLength: 64 });
const timestamp = Type.String({ pattern: timestampPattern, maxLength: 24 });
const token = Type.String({ minLength: 1, maxLength: 256 });
const count = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const boundedTokens = Type.Integer({ minimum: 0, maximum: MAX_CONTEXT_TOKENS });
const exact = <T extends Record<string, TSchema>>(properties: T) =>
	Type.Object(properties, { additionalProperties: false });
const literals = <T extends readonly string[]>(values: T) =>
	Type.Union(values.map((value) => Type.Literal(value)));

const provenanceBase = {
	authorityId: id("authority"),
	tenantId: id("tenant"),
	sourceDigest: digest,
	observedAt: timestamp,
} as const;

export const ContextProvenanceSchema = Type.Unsafe<ContextProvenance>(Type.Union([
	exact({ ...provenanceBase, kind: Type.Literal("organization_policy"), policyId: id("resource") }),
	exact({ ...provenanceBase, kind: Type.Literal("principal"), principalId: id("principal") }),
	exact({
		...provenanceBase,
		kind: Type.Literal("session_range"),
		sessionId: id("session"),
		fromSequence: count,
		toSequence: count,
	}),
	exact({ ...provenanceBase, kind: Type.Literal("workspace"), workspace: WorkspaceBindingRefSchema }),
	exact({ ...provenanceBase, kind: Type.Literal("artifact"), artifact: ArtifactRefSchema }),
	exact({ ...provenanceBase, kind: Type.Literal("memory"), memoryId: id("memory"), recordDigest: digest }),
	exact({ ...provenanceBase, kind: Type.Literal("tool"), toolCallId: id("toolCall"), resultDigest: digest }),
]));

const fragmentBase = {
	schemaVersion: Type.Literal(CONTEXT_SCHEMA_VERSION),
	authorityId: id("authority"),
	tenantId: id("tenant"),
	fragmentId: id("resource"),
	layer: literals(CONTEXT_LAYERS),
	order: Type.Integer({ minimum: 0, maximum: MAX_CONTEXT_FRAGMENTS - 1 }),
	contentDigest: digest,
	trust: literals(CONTEXT_TRUST_LEVELS),
	taint: Type.Array(literals(CONTEXT_TAINTS), { maxItems: CONTEXT_TAINTS.length, uniqueItems: true }),
	inputSources: Type.Array(InputSourceRefSchema, { maxItems: 256 }),
	declassificationReceipts: Type.Array(DeclassificationReceiptRefSchema, { maxItems: 256 }),
	priority: literals(["required", "high", "normal", "optional"] as const),
	maxTokens: boundedTokens,
	maxChars: Type.Integer({ minimum: 0, maximum: MAX_CONTEXT_FRAGMENT_CHARS }),
	provenance: ContextProvenanceSchema,
} as const;

export const ContextFragmentSchema = Type.Unsafe<ContextFragment>(Type.Union([
	exact({
		...fragmentBase,
		storage: Type.Literal("inline"),
		content: Type.String({ maxLength: MAX_CONTEXT_FRAGMENT_CHARS }),
	}),
	exact({
		...fragmentBase,
		storage: Type.Literal("artifact"),
		artifact: ArtifactRefSchema,
		excerpt: Type.Optional(Type.String({ maxLength: 4_096 })),
	}),
]));

export const ContextAssemblyBudgetSchema = Type.Unsafe<ContextAssemblyBudget>(exact({
	contextWindowTokens: Type.Integer({ minimum: 1, maximum: MAX_CONTEXT_TOKENS }),
	reservedOutputTokens: boundedTokens,
	reservedToolSchemaTokens: boundedTokens,
	providerSafetyTokens: boundedTokens,
	maxFragments: Type.Integer({ minimum: 1, maximum: MAX_CONTEXT_FRAGMENTS }),
	maxTotalChars: Type.Integer({ minimum: 1, maximum: MAX_CONTEXT_TOTAL_CHARS }),
}));

export const ContextAssemblyRequestSchema = Type.Unsafe<ContextAssemblyRequest>(exact({
	schemaVersion: Type.Literal(CONTEXT_SCHEMA_VERSION),
	authorityId: id("authority"),
	tenantId: id("tenant"),
	principalId: id("principal"),
	requestId: id("contextRequest"),
	sessionId: id("session"),
	modelId: token,
	modelProfileId: id("resource"),
	workspace: Type.Optional(WorkspaceBindingRefSchema),
	requiredCapabilities: Type.Array(CapabilityClaimSchema, { maxItems: 64 }),
	budget: ContextAssemblyBudgetSchema,
	fragments: Type.Array(ContextFragmentSchema, { maxItems: MAX_CONTEXT_FRAGMENTS }),
}));

export const ContextFragmentReceiptSchema = Type.Unsafe<ContextFragmentReceipt>(exact({
	authorityId: id("authority"),
	tenantId: id("tenant"),
	fragmentId: id("resource"),
	contentDigest: digest,
	layer: literals(CONTEXT_LAYERS),
	estimatedTokens: boundedTokens,
	includedChars: Type.Integer({ minimum: 0, maximum: MAX_CONTEXT_FRAGMENT_CHARS }),
	inputSources: Type.Array(InputSourceRefSchema, { maxItems: 256 }),
	declassificationReceipts: Type.Array(DeclassificationReceiptRefSchema, { maxItems: 256 }),
}));

export const ContextOmissionDiagnosticSchema = Type.Unsafe<ContextOmissionDiagnostic>(exact({
	fragmentId: id("resource"),
	layer: literals(CONTEXT_LAYERS),
	reason: literals(CONTEXT_OMISSION_REASONS),
	diagnosticDigest: digest,
}));

export const ContextAssemblyReceiptSchema = Type.Unsafe<ContextAssemblyReceipt>(exact({
	schemaVersion: Type.Literal(CONTEXT_SCHEMA_VERSION),
	authorityId: id("authority"),
	tenantId: id("tenant"),
	principalId: id("principal"),
	requestId: id("contextRequest"),
	receiptId: id("receipt"),
	sessionId: id("session"),
	modelId: token,
	modelProfileId: id("resource"),
	budget: ContextAssemblyBudgetSchema,
	included: Type.Array(ContextFragmentReceiptSchema, { maxItems: MAX_CONTEXT_FRAGMENTS }),
	omitted: Type.Array(ContextOmissionDiagnosticSchema, { maxItems: MAX_CONTEXT_DIAGNOSTICS }),
	estimatedInputTokens: boundedTokens,
	contextDigest: digest,
	projectionCheckpointId: Type.Optional(id("checkpoint")),
	assembledAt: timestamp,
}));

function sameScope(
	value: { authorityId: string; tenantId: string },
	child: { authorityId: string; tenantId: string },
): boolean {
	return value.authorityId === child.authorityId && value.tenantId === child.tenantId;
}

function budgetFits(value: ContextAssemblyBudget): boolean {
	return (
		value.reservedOutputTokens + value.reservedToolSchemaTokens + value.providerSafetyTokens <
		value.contextWindowTokens
	);
}

export function isContextProvenance(value: unknown): value is ContextProvenance {
	if (!Check(ContextProvenanceSchema, value)) return false;
	if (value.kind === "session_range") return value.fromSequence <= value.toSequence;
	if (value.kind === "workspace") return sameScope(value, value.workspace);
	if (value.kind === "artifact") return sameScope(value, value.artifact);
	return true;
}

export function isContextFragment(value: unknown): value is ContextFragment {
	if (!Check(ContextFragmentSchema, value) || !isContextProvenance(value.provenance) || !sameScope(value, value.provenance)) {
		return false;
	}
	if (value.storage === "inline" && value.content.length > value.maxChars) return false;
	if (value.storage === "artifact" && (!sameScope(value, value.artifact) || value.artifact.storedDigest !== value.contentDigest)) {
		return false;
	}
	if (value.layer === "organization_policy" && value.trust !== "system") return false;
	if (value.layer === "user_memory" && value.trust !== "user_approved") return false;
	if (
		!value.inputSources.every((source) => sameScope(value, source) && isInputSourceRef(source)) ||
		!value.declassificationReceipts.every(
			(receipt) => sameScope(value, receipt) && isDeclassificationReceiptRef(receipt),
		)
	) return false;
	const hasSourceTaint = value.inputSources.some((source) => source.taintLabels.length > 0);
	if ((value.taint.length > 0) !== hasSourceTaint) return false;
	return value.trust !== "system" || value.taint.length === 0;
}

export function isContextAssemblyBudget(value: unknown): value is ContextAssemblyBudget {
	return Check(ContextAssemblyBudgetSchema, value) && budgetFits(value);
}

export function isContextAssemblyRequest(value: unknown): value is ContextAssemblyRequest {
	if (!Check(ContextAssemblyRequestSchema, value) || !isContextAssemblyBudget(value.budget)) return false;
	if (value.fragments.length > value.budget.maxFragments) return false;
	if (value.workspace !== undefined && !sameScope(value, value.workspace)) return false;
	if (!value.requiredCapabilities.every((claim) => sameScope(value, claim))) return false;
	if (!value.fragments.every((fragment) => sameScope(value, fragment) && isContextFragment(fragment))) return false;
	const totalChars = value.fragments.reduce((sum, fragment) => {
		const chars = fragment.storage === "inline" ? fragment.content.length : (fragment.excerpt?.length ?? 0);
		return sum + chars;
	}, 0);
	return totalChars <= value.budget.maxTotalChars;
}

export function isContextFragmentReceipt(value: unknown): value is ContextFragmentReceipt {
	return (
		Check(ContextFragmentReceiptSchema, value) &&
		value.inputSources.every((source) => sameScope(value, source) && isInputSourceRef(source)) &&
		value.declassificationReceipts.every(
			(receipt) => sameScope(value, receipt) && isDeclassificationReceiptRef(receipt),
		)
	);
}

export function isContextOmissionDiagnostic(value: unknown): value is ContextOmissionDiagnostic {
	return Check(ContextOmissionDiagnosticSchema, value);
}

export function isContextAssemblyReceipt(value: unknown): value is ContextAssemblyReceipt {
	if (!Check(ContextAssemblyReceiptSchema, value) || !isContextAssemblyBudget(value.budget)) return false;
	if (!value.included.every((entry) => sameScope(value, entry) && isContextFragmentReceipt(entry))) return false;
	const includedIds = new Set(value.included.map((entry) => entry.fragmentId));
	if (includedIds.size !== value.included.length) return false;
	if (value.omitted.some((entry) => includedIds.has(entry.fragmentId))) return false;
	const available = value.budget.contextWindowTokens - value.budget.reservedOutputTokens -
		value.budget.reservedToolSchemaTokens - value.budget.providerSafetyTokens;
	return value.estimatedInputTokens <= available;
}
