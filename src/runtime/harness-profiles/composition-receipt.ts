/** 模型 composition 的 bounded receipt；不保存 prompt 或 extension 正文。 */

import { runtimeDigest } from "../protocol/foundation.ts";
import type {
	HarnessCompositionReceipt,
	HarnessProfileDescriptor,
	HarnessProfileRef,
	ResolvedHarnessComposition,
} from "./types.ts";
import { isHarnessCompositionReceipt } from "./types.ts";

export type HarnessCompositionDiagnosticCode =
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
		tools: Object.freeze(input.composition.tools.map((tool) => Object.freeze({
			name: tool.name,
			descriptorDigest: runtimeDigest({
				description: tool.description,
				parameters: tool.parameters,
			}),
		}))),
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
		const derived = runtimeDigest({
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
