/** 模型 composition 的 bounded receipt；不保存 prompt 或 extension 正文。 */

import { resolveHarnessProfile } from "./resolver.ts";
import { harnessToolReceiptTable } from "./tool-receipt-table.ts";
import { runtimeDigest } from "../protocol/foundation.ts";
import type {
	HarnessCompositionReceipt,
	HarnessProfileDescriptor,
	HarnessProfileRef,
	ResolvedHarnessComposition,
} from "./types.ts";
import { isHarnessCompositionReceipt } from "./types.ts";

export type HarnessCompositionDiagnosticCode =
	| "tool_manifest_mismatch"
	| "descriptor_mismatch"
	| "malformed_receipt"
	| "session_mismatch"
	| "generation_mismatch"
	| "profile_mismatch"
	| "composition_digest_mismatch"
	| "duplicate_generation";

export interface HarnessCompositionDiagnostic {
	readonly code: HarnessCompositionDiagnosticCode;
	readonly eventSequence: number;
	readonly ownerGeneration?: number;
}

export type HarnessCompositionAudit =
	| { readonly ok: true; readonly receipts: readonly HarnessCompositionReceipt[] }
	| { readonly ok: false; readonly diagnostic: HarnessCompositionDiagnostic; readonly detail: string };

export interface HarnessCompositionEventInput {
	readonly sequence: number;
	readonly ownerGeneration: number;
	readonly eventType: string;
	readonly payloadJson: string;
}

export function createHarnessCompositionReceipt(input: {
	readonly sessionId: string;
	readonly ownerGeneration: number;
	readonly descriptor: HarnessProfileDescriptor;
	readonly composition: ResolvedHarnessComposition;
}): HarnessCompositionReceipt {
	return Object.freeze({
		sessionId: input.sessionId,
		ownerGeneration: input.ownerGeneration,
		profile: input.composition.ref,
		promptDigest: input.composition.promptDigest,
		manifestFormat: input.composition.manifestFormat,
		tools: harnessToolReceiptTable(input.composition.tools),
		toolManifestDigest: input.composition.toolManifestDigest,
		contextPolicyDigest: input.composition.contextPolicyDigest,
		extensions: input.descriptor.extensions,
		multiAgent: input.descriptor.multiAgent,
		compositionDigest: input.composition.compositionDigest,
	});
}

/** 恢复前语义校验 hash-chain 内的 bounded composition receipts。 */
export function auditHarnessCompositionReceipts(input: {
	readonly sessionId: string;
	readonly profile: HarnessProfileRef;
	readonly events: readonly HarnessCompositionEventInput[];
}): HarnessCompositionAudit {
	const receipts: HarnessCompositionReceipt[] = [];
	const generations = new Set<number>();
	for (const event of input.events) {
		if (event.eventType !== "harness.composed") continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(event.payloadJson) as unknown;
		} catch {
			return failure("malformed_receipt", event, "harness composition receipt is not valid JSON");
		}
		if (!isHarnessCompositionReceipt(parsed)) {
			return failure("malformed_receipt", event, "harness composition receipt does not match its exact schema");
		}
		if (parsed.sessionId !== input.sessionId) {
			return failure("session_mismatch", event, "harness composition receipt session differs from the catalog session");
		}
		if (parsed.ownerGeneration !== event.ownerGeneration) {
			return failure("generation_mismatch", event, "harness composition receipt generation differs from its owner-fenced event");
		}
		if (!sameProfile(parsed.profile, input.profile)) {
			return failure("profile_mismatch", event, "harness composition receipt profile differs from the catalog authority");
		}
		const resolved = resolveHarnessProfile(parsed.profile);
		if (!resolved.ok
			|| runtimeDigest(parsed.extensions).digest !== runtimeDigest(resolved.descriptor.extensions).digest
			|| parsed.multiAgent !== resolved.descriptor.multiAgent
			|| (resolved.descriptor.prompt.mode === "complete" && parsed.promptDigest.digest !== runtimeDigest(resolved.descriptor.prompt).digest)
			|| parsed.contextPolicyDigest.digest !== runtimeDigest({ assembler: "assembleAgentModelContext@1", history: "selected", extensionSources: resolved.descriptor.extensions.context }).digest
			|| (resolved.descriptor.tools.mode === "allowlist" && runtimeDigest(parsed.tools.map((tool) => tool.name)).digest !== runtimeDigest(resolved.descriptor.tools.allowlist).digest)) {
			return failure("descriptor_mismatch", event, "harness receipt violates the exact builtin descriptor");
		}
		if (parsed.profile.id === "plan" && (parsed.manifestFormat !== "descriptor-digests@1" || parsed.toolManifestDigest.digest !== "d11dcb4da8c9e40e0f03c31f807d1511c9c2f38663b851021e0d6e00c1032cf6")) {
			return failure("tool_manifest_mismatch", event, "plan tool descriptors differ from the frozen builtin manifest");
		}
		if (parsed.profile.id === "minimal") {
			const expected = parsed.manifestFormat === undefined
				? (parsed.profile.version === 1 ? "3325e5598de3f84582ef89c65532a6c969355c3eb4821bd19c4529ea7bdacafc" : "ae5d2f08cd47a0c48d2a1408eae36e4cac0376a3f8a7d9bc339b8894c2350712")
				: (parsed.profile.version === 1 ? "d2c8fe72792fcd0313513f23eab6ddd7f0f6e9073796c01fa245e1818a2c9327" : "dc93397ad8328602012d01d24bda980f50fd970e5c6527855421685c2941e1ea");
			const expectedTable = parsed.profile.version === 1 ? "d2c8fe72792fcd0313513f23eab6ddd7f0f6e9073796c01fa245e1818a2c9327" : "dc93397ad8328602012d01d24bda980f50fd970e5c6527855421685c2941e1ea";
			if (parsed.toolManifestDigest.digest !== expected || runtimeDigest(parsed.tools).digest !== expectedTable) return failure("tool_manifest_mismatch", event, "minimal tool descriptors differ from the frozen builtin manifest");
		}
		if (new Set(parsed.tools.map((tool) => tool.name)).size !== parsed.tools.length
			|| (parsed.manifestFormat !== undefined && runtimeDigest(parsed.tools).digest !== parsed.toolManifestDigest.digest)) {
			return failure("tool_manifest_mismatch", event, "harness tool manifest differs from its ordered descriptor table");
		}
		const derived = runtimeDigest({
			...(parsed.manifestFormat === undefined ? {} : { manifestFormat: parsed.manifestFormat }),
			ref: parsed.profile,
			promptDigest: parsed.promptDigest,
			toolManifestDigest: parsed.toolManifestDigest,
			contextPolicyDigest: parsed.contextPolicyDigest,
			extensions: parsed.extensions,
			multiAgent: parsed.multiAgent,
		});
		if (derived.digest !== parsed.compositionDigest.digest) {
			return failure("composition_digest_mismatch", event, "harness composition digest is not derived from its bounded receipt fields");
		}
		if (generations.has(parsed.ownerGeneration)) {
			return failure("duplicate_generation", event, "an owner generation has more than one harness composition receipt");
		}
		generations.add(parsed.ownerGeneration);
		receipts.push(parsed);
	}
	return { ok: true, receipts: Object.freeze(receipts) };
}

function sameProfile(left: HarnessProfileRef, right: HarnessProfileRef): boolean {
	return left.id === right.id
		&& left.version === right.version
		&& left.descriptorDigest.algorithm === right.descriptorDigest.algorithm
		&& left.descriptorDigest.digest === right.descriptorDigest.digest;
}

function failure(
	code: HarnessCompositionDiagnosticCode,
	event: HarnessCompositionEventInput,
	detail: string,
): Extract<HarnessCompositionAudit, { readonly ok: false }> {
	return {
		ok: false,
		diagnostic: { code, eventSequence: event.sequence, ownerGeneration: event.ownerGeneration },
		detail,
	};
}
