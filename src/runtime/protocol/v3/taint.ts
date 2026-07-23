/** 不可信输入、taint 传播与显式去污收据的 Runtime v3 合同。 */

import { Type, type TSchema } from "typebox";
import { Check } from "typebox/value";
import { canonicalDigest } from "./canonical-json.ts";
import type {
	AuthorityId,
	DeclassificationId,
	InputSourceId,
	PrincipalId,
	TenantId,
} from "./ids.ts";

const digestPattern = "^[a-f0-9]{64}$";
const timestampPattern = "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{3})?Z$";
const runtimeId = (kind: string) =>
	Type.String({ pattern: `^${kind}_[A-Za-z0-9][A-Za-z0-9._~-]*$`, maxLength: 128 });
const digest = Type.String({ pattern: digestPattern, maxLength: 64 });
const timestamp = Type.String({ pattern: timestampPattern, maxLength: 24 });
const revision = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const exact = <T extends Record<string, TSchema>>(properties: T) =>
	Type.Object(properties, { additionalProperties: false });

export const INPUT_SOURCE_KINDS = [
	"user",
	"repository",
	"instruction",
	"issue",
	"pull_request",
	"comment",
	"webhook",
	"web",
	"mcp",
	"model",
	"candidate_config",
] as const;
export type InputSourceKind = (typeof INPUT_SOURCE_KINDS)[number];

export const INPUT_TRUST_LEVELS = ["trusted", "tainted", "derived"] as const;
export type InputTrust = (typeof INPUT_TRUST_LEVELS)[number];

export const TAINT_LABELS = [
	"external_untrusted",
	"repository_controlled",
	"candidate_controlled",
	"model_derived",
	"secret_derived",
	"executable_instruction",
] as const;
export type TaintLabel = (typeof TAINT_LABELS)[number];

export const TAINT_SINKS = [
	"context",
	"filesystem",
	"shell",
	"network",
	"credential",
	"verification",
	"publication",
] as const;
export type TaintSink = (typeof TAINT_SINKS)[number];

export interface InputSourceRef {
	schemaVersion: 1;
	authorityId: AuthorityId;
	tenantId: TenantId;
	sourceId: InputSourceId;
	kind: InputSourceKind;
	sourceDigest: string;
	trust: InputTrust;
	taintLabels: readonly TaintLabel[];
	observedAt: string;
}

export interface DeclassificationReceiptRef {
	schemaVersion: 1;
	authorityId: AuthorityId;
	tenantId: TenantId;
	receiptId: DeclassificationId;
	sourceId: InputSourceId;
	sourceDigest: string;
	allowedSink: TaintSink;
	policyDigest: string;
	approverPrincipalId: PrincipalId;
	decisionRevision: number;
	issuedAt: string;
	expiresAt?: string;
	receiptDigest: string;
}

const literalUnion = <T extends readonly string[]>(values: T) =>
	Type.Union(values.map((value) => Type.Literal(value)));

export const InputSourceKindSchema = literalUnion(INPUT_SOURCE_KINDS);
export const InputTrustSchema = literalUnion(INPUT_TRUST_LEVELS);
export const TaintLabelSchema = literalUnion(TAINT_LABELS);
export const TaintSinkSchema = literalUnion(TAINT_SINKS);

export const InputSourceRefSchema = exact({
	schemaVersion: Type.Literal(1),
	authorityId: runtimeId("authority"),
	tenantId: runtimeId("tenant"),
	sourceId: runtimeId("inputSource"),
	kind: InputSourceKindSchema,
	sourceDigest: digest,
	trust: InputTrustSchema,
	taintLabels: Type.Array(TaintLabelSchema, { maxItems: TAINT_LABELS.length, uniqueItems: true }),
	observedAt: timestamp,
});

const declassificationReceiptBodyProperties = {
	schemaVersion: Type.Literal(1),
	authorityId: runtimeId("authority"),
	tenantId: runtimeId("tenant"),
	receiptId: runtimeId("declassification"),
	sourceId: runtimeId("inputSource"),
	sourceDigest: digest,
	allowedSink: TaintSinkSchema,
	policyDigest: digest,
	approverPrincipalId: runtimeId("principal"),
	decisionRevision: revision,
	issuedAt: timestamp,
	expiresAt: Type.Optional(timestamp),
} as const;

export const DeclassificationReceiptRefSchema = exact({
	...declassificationReceiptBodyProperties,
	receiptDigest: digest,
});

const TAINTED_SOURCE_KINDS: ReadonlySet<InputSourceKind> = new Set([
	"repository",
	"instruction",
	"issue",
	"pull_request",
	"comment",
	"webhook",
	"web",
	"mcp",
	"candidate_config",
]);

const REQUIRED_LABELS: Readonly<Partial<Record<InputSourceKind, TaintLabel>>> = {
	repository: "repository_controlled",
	instruction: "executable_instruction",
	issue: "external_untrusted",
	pull_request: "external_untrusted",
	comment: "external_untrusted",
	webhook: "external_untrusted",
	web: "external_untrusted",
	mcp: "external_untrusted",
	model: "model_derived",
	candidate_config: "candidate_controlled",
};

function declassificationBody(
	receipt: DeclassificationReceiptRef,
): Omit<DeclassificationReceiptRef, "receiptDigest"> {
	const { receiptDigest: _receiptDigest, ...body } = receipt;
	return body;
}

export function isInputSourceRef(value: unknown): value is InputSourceRef {
	if (!Check(InputSourceRefSchema, value)) return false;
	const source = value as unknown as InputSourceRef;
	if (source.trust === "trusted" && source.taintLabels.length > 0) return false;
	if (TAINTED_SOURCE_KINDS.has(source.kind) && source.trust === "trusted") return false;
	const required = REQUIRED_LABELS[source.kind];
	return required === undefined || source.taintLabels.includes(required);
}

export function isDeclassificationReceiptRef(value: unknown): value is DeclassificationReceiptRef {
	if (!Check(DeclassificationReceiptRefSchema, value)) return false;
	const receipt = value as unknown as DeclassificationReceiptRef;
	if (receipt.expiresAt !== undefined && Date.parse(receipt.expiresAt) <= Date.parse(receipt.issuedAt)) return false;
	return receipt.receiptDigest === canonicalDigest(declassificationBody(receipt));
}

/** 合并时只去除完全相同的 source identity，所有不同 digest/label 都继续传播。 */
export function propagateInputSources(
	...groups: readonly (readonly InputSourceRef[])[]
): readonly InputSourceRef[] | undefined {
	const sources = new Map<string, InputSourceRef>();
	for (const group of groups) {
		for (const source of group) {
			if (!isInputSourceRef(source)) return undefined;
			const key = `${source.authorityId}/${source.tenantId}/${source.sourceId}/${source.sourceDigest}`;
			const existing = sources.get(key);
			if (existing && canonicalDigest(existing) !== canonicalDigest(source)) return undefined;
			sources.set(key, source);
		}
	}
	return [...sources.values()].sort((left, right) =>
		`${left.authorityId}/${left.tenantId}/${left.sourceId}/${left.sourceDigest}`.localeCompare(
			`${right.authorityId}/${right.tenantId}/${right.sourceId}/${right.sourceDigest}`,
		),
	);
}

export function declassificationAllowsSourceAtSink(
	receipt: DeclassificationReceiptRef,
	source: InputSourceRef,
	sink: TaintSink,
	at: Date,
): boolean {
	return (
		isDeclassificationReceiptRef(receipt) &&
		isInputSourceRef(source) &&
		receipt.authorityId === source.authorityId &&
		receipt.tenantId === source.tenantId &&
		receipt.sourceId === source.sourceId &&
		receipt.sourceDigest === source.sourceDigest &&
		receipt.allowedSink === sink &&
		Date.parse(receipt.issuedAt) <= at.getTime() &&
		(receipt.expiresAt === undefined || Date.parse(receipt.expiresAt) > at.getTime())
	);
}

/** 任一带 taint 的 source 缺少精确、未过期的 sink receipt 时均 fail closed。 */
export function inputSourcesAllowedAtSink(
	sources: readonly InputSourceRef[],
	sink: TaintSink,
	receipts: readonly DeclassificationReceiptRef[],
	at: Date,
): boolean {
	const propagated = propagateInputSources(sources);
	if (!propagated) return false;
	return propagated.every(
		(source) =>
			source.taintLabels.length === 0 ||
			receipts.some((receipt) => declassificationAllowsSourceAtSink(receipt, source, sink, at)),
	);
}
