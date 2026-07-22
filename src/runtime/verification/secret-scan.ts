/** Trusted-base SecretScanGate；raw match 永不进入 receipt。 */

import { canonicalDigest } from "../protocol/v3/canonical-json.ts";
import { createRuntimeId } from "../protocol/v3/ids.ts";
import {
	SECRET_SCAN_SCHEMA_VERSION,
	SECRET_SCAN_SCOPES,
	type AdmissionOutcome,
	type SecretScanContent,
	type SecretScanCoverage,
	type SecretScanFinding,
	type SecretScanInput,
	type SecretScanPolicy,
	type SecretScanReceipt,
	type SecretScanRule,
	type VerificationCoreResult,
} from "./types.ts";

const DIGEST = /^[a-f0-9]{64}$/u;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._+~-]{0,511}$/u;

function policyBody(policy: SecretScanPolicy): Omit<SecretScanPolicy, "policyDigest"> {
	const { policyDigest: _policyDigest, ...body } = policy;
	return body;
}

function receiptBody(receipt: SecretScanReceipt): Omit<SecretScanReceipt, "receiptDigest"> {
	const { receiptDigest: _receiptDigest, ...body } = receipt;
	return body;
}

function validTimestamp(value: string): boolean {
	return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value) && Number.isFinite(Date.parse(value));
}

function unique(values: readonly string[]): boolean {
	return new Set(values).size === values.length;
}

function safeLocation(value: string): boolean {
	return (
		value.length > 0 && value.length <= 4096 &&
		!value.startsWith("/") && !value.includes("\\") && !value.includes("\0") &&
		value.split("/").every((part) => part.length > 0 && part !== "." && part !== "..")
	);
}

function createRuleMatcher(rule: SecretScanRule): RegExp | undefined {
	try {
		const matcher = new RegExp(rule.pattern, rule.caseSensitive ? "gu" : "giu");
		matcher.lastIndex = 0;
		if (matcher.test("")) return undefined;
		matcher.lastIndex = 0;
		return matcher;
	} catch {
		return undefined;
	}
}

export function secretScanPolicyDigest(policy: Omit<SecretScanPolicy, "policyDigest">): string {
	return canonicalDigest(policy);
}

export function isSecretScanPolicy(value: unknown): value is SecretScanPolicy {
	if (typeof value !== "object" || value === null) return false;
	const policy = value as Partial<SecretScanPolicy>;
	if (
		policy.schemaVersion !== SECRET_SCAN_SCHEMA_VERSION ||
		typeof policy.policyId !== "string" || !TOKEN.test(policy.policyId) ||
		!Number.isSafeInteger(policy.policyRevision) || Number(policy.policyRevision) < 1 ||
		!Array.isArray(policy.rules) || policy.rules.length < 1 || policy.rules.length > 256 ||
		!Array.isArray(policy.allowlist) || policy.allowlist.length > 1_000 ||
		!Array.isArray(policy.requiredScopes) ||
		!Number.isSafeInteger(policy.maxItems) || Number(policy.maxItems) < 5 || Number(policy.maxItems) > 100_000 ||
		!Number.isSafeInteger(policy.maxInputBytes) || Number(policy.maxInputBytes) < 1 || Number(policy.maxInputBytes) > 1_073_741_824 ||
		!Number.isSafeInteger(policy.maxFindings) || Number(policy.maxFindings) < 1 || Number(policy.maxFindings) > 100_000 ||
		typeof policy.policyDigest !== "string" || !DIGEST.test(policy.policyDigest)
	) return false;
	const required = [...policy.requiredScopes].sort();
	const all = [...SECRET_SCAN_SCOPES].sort();
	if (required.length !== all.length || required.some((scope, index) => scope !== all[index])) return false;
	if (!policy.rules.every((rule) => (
		TOKEN.test(rule.ruleId) &&
		typeof rule.label === "string" && rule.label.length > 0 && rule.label.length <= 128 &&
		typeof rule.pattern === "string" && rule.pattern.length > 0 && rule.pattern.length <= 1024 &&
		typeof rule.caseSensitive === "boolean" &&
		createRuleMatcher(rule) !== undefined
	))) return false;
	if (!unique(policy.rules.map((rule) => rule.ruleId))) return false;
	if (!policy.allowlist.every((entry) => (
		TOKEN.test(entry.allowlistId) &&
		DIGEST.test(entry.findingDigest) &&
		DIGEST.test(entry.approvalReceiptDigest) &&
		DIGEST.test(entry.reasonDigest) &&
		validTimestamp(entry.expiresAt)
	))) return false;
	if (!unique(policy.allowlist.map((entry) => entry.allowlistId))) return false;
	const complete = policy as SecretScanPolicy;
	return complete.policyDigest === secretScanPolicyDigest(policyBody(complete));
}

export function secretScanContentDigest(content: string): string {
	return canonicalDigest(content);
}

export function secretScanItemDigest(item: Pick<SecretScanContent, "scope" | "path" | "contentDigest">): string {
	return canonicalDigest(item);
}

export function secretScanCoverageDigest(
	coverage: Omit<SecretScanCoverage, "inventoryDigest">,
): string {
	return canonicalDigest(coverage);
}

export function secretScanInventoryDigest(coverage: readonly SecretScanCoverage[]): string {
	return canonicalDigest(
		[...coverage]
			.map(({ itemDigests: _itemDigests, ...entry }) => entry)
			.sort((left, right) => left.scope.localeCompare(right.scope)),
	);
}

function validCoverage(value: SecretScanCoverage): boolean {
	return (
		SECRET_SCAN_SCOPES.includes(value.scope) &&
		typeof value.complete === "boolean" &&
		Number.isSafeInteger(value.itemCount) && value.itemCount >= 0 &&
		Array.isArray(value.itemDigests) && value.itemDigests.length === value.itemCount &&
		value.itemDigests.every((entry) => DIGEST.test(entry)) && unique(value.itemDigests) &&
		DIGEST.test(value.inventoryDigest) &&
		value.inventoryDigest === secretScanCoverageDigest({
			scope: value.scope,
			complete: value.complete,
			itemCount: value.itemCount,
			itemDigests: value.itemDigests,
		})
	);
}

function validContent(value: SecretScanContent): boolean {
	return (
		SECRET_SCAN_SCOPES.includes(value.scope) &&
		safeLocation(value.path) &&
		typeof value.content === "string" &&
		DIGEST.test(value.contentDigest) &&
		value.contentDigest === secretScanContentDigest(value.content)
	);
}

export function isSecretScanInput(value: unknown): value is SecretScanInput {
	if (typeof value !== "object" || value === null) return false;
	const input = value as Partial<SecretScanInput>;
	if (
		input.schemaVersion !== SECRET_SCAN_SCHEMA_VERSION ||
		typeof input.authorityId !== "string" || !input.authorityId.startsWith("authority_") ||
		typeof input.tenantId !== "string" || !input.tenantId.startsWith("tenant_") ||
		typeof input.requestId !== "string" || !input.requestId.startsWith("command_") ||
		typeof input.verificationId !== "string" || !input.verificationId.startsWith("verification_") ||
		typeof input.gateDigest !== "string" || !DIGEST.test(input.gateDigest) ||
		typeof input.candidateCommit !== "string" || input.candidateCommit.length < 1 || input.candidateCommit.length > 512 ||
		typeof input.policyDigest !== "string" || !DIGEST.test(input.policyDigest) ||
		typeof input.scannerId !== "string" || !TOKEN.test(input.scannerId) ||
		typeof input.scannerIdentityDigest !== "string" || !DIGEST.test(input.scannerIdentityDigest) ||
		!Array.isArray(input.coverage) || !input.coverage.every(validCoverage) || !unique(input.coverage.map((entry) => entry.scope)) ||
		!Array.isArray(input.items) || !input.items.every(validContent) ||
		typeof input.truncated !== "boolean" ||
		typeof input.collectedAt !== "string" || !validTimestamp(input.collectedAt) ||
		typeof input.inventoryDigest !== "string" || !DIGEST.test(input.inventoryDigest) ||
		input.inventoryDigest !== secretScanInventoryDigest(input.coverage)
	) return false;
	const actualByScope = new Map<string, string[]>();
	for (const item of input.items) {
		const values = actualByScope.get(item.scope) ?? [];
		values.push(secretScanItemDigest(item));
		actualByScope.set(item.scope, values);
	}
	return input.coverage.every((coverage) => {
		const actual = [...(actualByScope.get(coverage.scope) ?? [])].sort();
		const declared = [...coverage.itemDigests].sort();
		return actual.length === declared.length && actual.every((digest, index) => digest === declared[index]);
	});
}

export function secretScanReceiptDigest(receipt: Omit<SecretScanReceipt, "receiptDigest">): string {
	return canonicalDigest(receipt);
}

export function isSecretScanReceipt(value: unknown): value is SecretScanReceipt {
	if (typeof value !== "object" || value === null) return false;
	const receipt = value as Partial<SecretScanReceipt>;
	return (
		receipt.schemaVersion === SECRET_SCAN_SCHEMA_VERSION &&
		typeof receipt.receiptId === "string" && receipt.receiptId.startsWith("receipt_") &&
		typeof receipt.requestId === "string" && receipt.requestId.startsWith("command_") &&
		typeof receipt.verificationId === "string" && receipt.verificationId.startsWith("verification_") &&
		typeof receipt.gateDigest === "string" && DIGEST.test(receipt.gateDigest) &&
		typeof receipt.policyDigest === "string" && DIGEST.test(receipt.policyDigest) &&
		(receipt.outcome === "passed" || receipt.outcome === "blocked" || receipt.outcome === "inconclusive") &&
		Array.isArray(receipt.coverage) && receipt.coverage.length <= SECRET_SCAN_SCOPES.length &&
		Array.isArray(receipt.findings) && receipt.findings.length <= 100_000 &&
		Array.isArray(receipt.reasonCodes) && receipt.reasonCodes.length <= 8 &&
		typeof receipt.receiptDigest === "string" && DIGEST.test(receipt.receiptDigest) &&
		receipt.receiptDigest === secretScanReceiptDigest(receiptBody(receipt as SecretScanReceipt))
	);
}

function position(content: string, index: number): { line: number; column: number } {
	const prefix = content.slice(0, index);
	const lastLine = prefix.lastIndexOf("\n");
	return {
		line: 1 + (prefix.match(/\n/gu)?.length ?? 0),
		column: index - lastLine,
	};
}

function finding(
	policy: SecretScanPolicy,
	input: SecretScanInput,
	rule: SecretScanRule,
	item: SecretScanContent,
	index: number,
	matchLength: number,
): SecretScanFinding {
	const location = position(item.content, index);
	const locationDigest = canonicalDigest({
		candidateCommit: input.candidateCommit,
		scope: item.scope,
		path: item.path,
		line: location.line,
		column: location.column,
	});
	const findingDigest = canonicalDigest({
		policyDigest: policy.policyDigest,
		candidateCommit: input.candidateCommit,
		ruleId: rule.ruleId,
		locationDigest,
		matchLength,
	});
	return {
		ruleId: rule.ruleId,
		label: rule.label,
		scope: item.scope,
		path: item.path,
		line: location.line,
		column: location.column,
		locationDigest,
		findingDigest,
	};
}

function createReceipt(input: {
	policy: SecretScanPolicy;
	scan: SecretScanInput;
	outcome: AdmissionOutcome;
	coverage: SecretScanReceipt["coverage"];
	findings: readonly SecretScanFinding[];
	findingsTruncated: boolean;
	reasonCodes: SecretScanReceipt["reasonCodes"];
	evaluatedAt: string;
}): SecretScanReceipt {
	const body: Omit<SecretScanReceipt, "receiptDigest"> = {
		schemaVersion: SECRET_SCAN_SCHEMA_VERSION,
		authorityId: input.scan.authorityId,
		tenantId: input.scan.tenantId,
		receiptId: createRuntimeId("receipt", `secret-scan-${canonicalDigest({
			requestId: input.scan.requestId,
			verificationId: input.scan.verificationId,
			policyDigest: input.policy.policyDigest,
			inventoryDigest: input.scan.inventoryDigest,
		}).slice(0, 48)}`),
		requestId: input.scan.requestId,
		verificationId: input.scan.verificationId,
		gateDigest: input.scan.gateDigest,
		candidateCommit: input.scan.candidateCommit,
		policyId: input.policy.policyId,
		policyRevision: input.policy.policyRevision,
		policyDigest: input.policy.policyDigest,
		scannerId: input.scan.scannerId,
		scannerIdentityDigest: input.scan.scannerIdentityDigest,
		inputInventoryDigest: input.scan.inventoryDigest,
		outcome: input.outcome,
		coverage: input.coverage,
		findings: input.findings,
		findingsTruncated: input.findingsTruncated,
		reasonCodes: input.reasonCodes,
		evaluatedAt: input.evaluatedAt,
	};
	return { ...body, receiptDigest: secretScanReceiptDigest(body) };
}

export interface SecretScanEvaluationOptions {
	clock?: () => Date;
	expectedScannerId?: string;
	expectedScannerIdentityDigest?: string;
}

export class SecretScanGate {
	readonly #clock: () => Date;

	public constructor(options: Pick<SecretScanEvaluationOptions, "clock"> = {}) {
		this.#clock = options.clock ?? (() => new Date());
	}

	public evaluate(
		policy: SecretScanPolicy,
		input: SecretScanInput,
		options: Omit<SecretScanEvaluationOptions, "clock"> = {},
	): VerificationCoreResult<SecretScanReceipt> {
		if (!isSecretScanPolicy(policy)) {
			return { ok: false, error: { code: "invalid_schema", message: "Secret Scan policy is invalid", retryable: false } };
		}
		if (!isSecretScanInput(input)) {
			return { ok: false, error: { code: "invalid_schema", message: "Secret Scan input is invalid", retryable: false } };
		}
		const evaluatedAt = this.#clock().toISOString();
		const reasonCodes: SecretScanReceipt["reasonCodes"][number][] = [];
		if (
			input.policyDigest !== policy.policyDigest ||
			(options.expectedScannerId !== undefined && input.scannerId !== options.expectedScannerId) ||
			(options.expectedScannerIdentityDigest !== undefined && input.scannerIdentityDigest !== options.expectedScannerIdentityDigest)
		) reasonCodes.push("policy_mismatch");
		const coverageByScope = new Map(input.coverage.map((entry) => [entry.scope, entry]));
		if (policy.requiredScopes.some((scope) => !coverageByScope.get(scope)?.complete)) reasonCodes.push("coverage_incomplete");
		const totalBytes = input.items.reduce((sum, item) => sum + new TextEncoder().encode(item.content).byteLength, 0);
		if (input.truncated || input.items.length > policy.maxItems || totalBytes > policy.maxInputBytes) {
			reasonCodes.push("evidence_truncated");
		}
		const allFindings: SecretScanFinding[] = [];
		if (!reasonCodes.includes("evidence_truncated")) {
			for (const item of input.items) {
				for (const rule of policy.rules) {
					const matcher = createRuleMatcher(rule);
					if (!matcher) {
						reasonCodes.push("policy_mismatch");
						continue;
					}
					for (const match of item.content.matchAll(matcher)) {
						if (match.index === undefined || match[0].length === 0) continue;
						allFindings.push(finding(policy, input, rule, item, match.index, match[0].length));
						if (allFindings.length > policy.maxFindings) break;
					}
					if (allFindings.length > policy.maxFindings) break;
				}
				if (allFindings.length > policy.maxFindings) break;
			}
		}
		const now = Date.parse(evaluatedAt);
		const blocking = allFindings.filter((candidate) => !policy.allowlist.some((entry) => (
			entry.findingDigest === candidate.findingDigest && Date.parse(entry.expiresAt) > now
		)));
		if (blocking.length > 0) reasonCodes.push("secret_detected");
		const incomplete = reasonCodes.some((code) => code !== "secret_detected");
		const outcome: AdmissionOutcome = blocking.length > 0 ? "blocked" : incomplete ? "inconclusive" : "passed";
		const bounded = blocking.slice(0, policy.maxFindings);
		return {
			ok: true,
			value: createReceipt({
				policy,
				scan: input,
				outcome,
				coverage: input.coverage.map(({ itemDigests: _itemDigests, ...entry }) => entry),
				findings: bounded,
				findingsTruncated: blocking.length > bounded.length,
				reasonCodes: [...new Set(reasonCodes)],
				evaluatedAt,
			}),
		};
	}
}

export function createUnavailableSecretScanReceipt(input: {
	policy: SecretScanPolicy;
	authorityId: SecretScanInput["authorityId"];
	tenantId: SecretScanInput["tenantId"];
	requestId: SecretScanInput["requestId"];
	verificationId: SecretScanInput["verificationId"];
	gateDigest: string;
	candidateCommit: string;
	scannerId: string;
	scannerIdentityDigest: string;
	evaluatedAt: string;
}): SecretScanReceipt {
	const coverage: SecretScanCoverage[] = SECRET_SCAN_SCOPES.map((scope) => {
		const body: Omit<SecretScanCoverage, "inventoryDigest"> = {
			scope,
			complete: false,
			itemCount: 0,
			itemDigests: [],
		};
		return { ...body, inventoryDigest: secretScanCoverageDigest(body) };
	});
	const scan: SecretScanInput = {
		schemaVersion: SECRET_SCAN_SCHEMA_VERSION,
		authorityId: input.authorityId,
		tenantId: input.tenantId,
		requestId: input.requestId,
		verificationId: input.verificationId,
		gateDigest: input.gateDigest,
		candidateCommit: input.candidateCommit,
		policyDigest: input.policy.policyDigest,
		scannerId: input.scannerId,
		scannerIdentityDigest: input.scannerIdentityDigest,
		coverage,
		items: [],
		truncated: true,
		collectedAt: input.evaluatedAt,
		inventoryDigest: secretScanInventoryDigest(coverage),
	};
	return createReceipt({
		policy: input.policy,
		scan,
		outcome: "inconclusive",
		coverage: coverage.map(({ itemDigests: _itemDigests, ...entry }) => entry),
		findings: [],
		findingsTruncated: false,
		reasonCodes: ["scanner_unavailable", "coverage_incomplete", "evidence_truncated"],
		evaluatedAt: input.evaluatedAt,
	});
}
