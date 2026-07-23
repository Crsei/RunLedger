/** Child-scoped operation admission：所有 provider/tool/command/resume/cancel 共用一个入口。 */

import { canonicalDigest } from "../protocol/v3/canonical-json.ts";
import { createRuntimeId } from "../protocol/v3/ids.ts";
import type { AgentResult } from "./types.ts";
import type {
	ChildGovernedOperationAdmissionPort,
	ChildGovernedOperationAdmissionReceipt,
	ChildGovernedOperationAdmissionRequest,
} from "./child-runtime-contracts.ts";

export interface ChildOperationAdmissionEvidence {
	agentId: ChildGovernedOperationAdmissionRequest["agentId"];
	sessionId: ChildGovernedOperationAdmissionRequest["sessionId"];
	workspaceId: ChildGovernedOperationAdmissionRequest["workspaceId"];
	capabilityReceiptDigest: string;
	workspaceReceiptDigest: string;
	resourceGeneration: number;
	resourceManifestDigest: string;
	evidenceDigest: string;
}

export interface ChildOperationEvidenceResolverPort {
	resolve(
		request: ChildGovernedOperationAdmissionRequest,
		signal?: AbortSignal,
	): Promise<AgentResult<ChildOperationAdmissionEvidence>>;
}

function denied(
	message: string,
	retryable = false,
): AgentResult<ChildGovernedOperationAdmissionReceipt> {
	return {
		ok: false,
		error: {
			code: "delegation_invalid",
			message,
			retryable,
		},
	};
}

export class ChildGovernedOperationAdmission
	implements ChildGovernedOperationAdmissionPort {
	readonly #resolver: ChildOperationEvidenceResolverPort;
	readonly #clock: () => Date;

	public constructor(options: {
		resolver: ChildOperationEvidenceResolverPort;
		clock?: () => Date;
	}) {
		this.#resolver = options.resolver;
		this.#clock = options.clock ?? (() => new Date());
	}

	public async admit(
		request: ChildGovernedOperationAdmissionRequest,
		signal?: AbortSignal,
	): Promise<AgentResult<ChildGovernedOperationAdmissionReceipt>> {
		let resolved: AgentResult<ChildOperationAdmissionEvidence>;
		try {
			resolved = await this.#resolver.resolve(request, signal);
		} catch {
			return denied("child operation admission evidence is unavailable", true);
		}
		if (!resolved.ok) return resolved;
		const evidence = resolved.value;
		if (
			evidence.agentId !== request.agentId ||
			evidence.sessionId !== request.sessionId ||
			evidence.workspaceId !== request.workspaceId
		) return denied("child operation escaped its durable identity scope");
		if (
			evidence.capabilityReceiptDigest !== request.capabilityReceiptDigest ||
			evidence.workspaceReceiptDigest !== request.workspaceReceiptDigest
		) return denied("child capability or Workspace receipt drifted");
		if (
			evidence.resourceGeneration !== request.resourceGeneration ||
			evidence.resourceManifestDigest !== request.resourceManifestDigest
		) return denied("child resource generation or manifest drifted");
		const checkedAt = this.#clock().toISOString();
		const body = {
			receiptId: createRuntimeId(
				"receipt",
				`child-operation-${canonicalDigest({
					requestId: request.requestId,
					evidenceDigest: evidence.evidenceDigest,
				}).slice(0, 48)}`,
			),
			requestId: request.requestId,
			agentId: request.agentId,
			sessionId: request.sessionId,
			operation: request.operation,
			decision: "allowed" as const,
			resourceGeneration: request.resourceGeneration,
			checkedAt,
		};
		return {
			ok: true,
			value: {
				...body,
				receiptDigest: canonicalDigest({
					...body,
					operationDigest: request.operationDigest,
					evidenceDigest: evidence.evidenceDigest,
				}),
			},
		};
	}
}
