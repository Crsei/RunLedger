/** read-only query facade；artifact authorization 与数据来源全部由注入 adapter 负责。 */

import { canonicalDigest } from "../protocol/v3/canonical-json.ts";
import { sameRuntimeEventStream } from "../protocol/v3/events.ts";
import { isRuntimeActivityProjection } from "../activity/types.ts";
import { isChangeProposalRef } from "../verification/change-proposal.ts";
import type { ControlPlaneResult } from "./errors.ts";
import { controlPlaneFailure } from "./errors.ts";
import {
	adapterException,
	type ControlPlaneQuery,
	type ControlPlaneQueryResponse,
	type ControlPlaneQueryValue,
	type ControlPlaneRequestContext,
	type ControlPlaneSessionHandle,
	type QueryExecutorPort,
	isControlPlaneQueryValue,
	validateControlPlaneQuery,
} from "./types.ts";

export interface SessionHandleValidationPort {
	validate(handle: ControlPlaneSessionHandle): ControlPlaneResult<void>;
}

export interface ControlPlaneQueryServiceOptions {
	executor: QueryExecutorPort;
	handles: SessionHandleValidationPort;
}

function queryHandle(query: ControlPlaneQuery): ControlPlaneSessionHandle | null {
	switch (query.type) {
		case "session:inspect":
		case "activity:get":
			return query.payload.sessionHandle;
		case "queue:list":
		case "changeProposal:inspect":
		case "artifact:read":
		case "artifact:metadata":
			return query.payload.sessionHandle;
		case "health":
			return null;
	}
}

function validateResult(query: ControlPlaneQuery, result: ControlPlaneQueryValue): ControlPlaneResult<void> {
	if (!isControlPlaneQueryValue(query.type, result)) {
		return controlPlaneFailure("adapter_contract_violation", "query adapter returned a malformed exact result");
	}
	if (query.type !== result.type) {
		return controlPlaneFailure("adapter_contract_violation", "query adapter returned the wrong result type");
	}
	switch (query.type) {
		case "session:inspect":
			if (result.type !== "session:inspect") return controlPlaneFailure("adapter_contract_violation", "inspection result type is inconsistent");
			return result.sessionId === query.payload.sessionId
				? { ok: true, value: undefined }
					: controlPlaneFailure("adapter_contract_violation", "session inspection correlation is invalid");
		case "queue:list": {
			if (result.type !== "queue:list") return controlPlaneFailure("adapter_contract_violation", "queue result type is inconsistent");
			const ordered = result.items.every((item, index) => (
				index === 0 || item.enqueuedSequence > result.items[index - 1]!.enqueuedSequence
			));
			const unique = new Set(result.items.map((item) => item.queueItemId)).size === result.items.length;
			const contentBound = result.items.every((item) => (
				item.contentDigest === canonicalDigest(item.content) &&
				(item.content.storage === "bounded_text"
					? item.message !== null && JSON.stringify(item.message) === item.content.messageJson
					: item.message === null &&
						item.content.artifact.authorityId === query.authorityId &&
						item.content.artifact.tenantId === query.tenantId)
			));
			const revisionBound = result.items.every((item) => (
				item.enqueueRevision.stream.scope === "session" &&
				item.enqueueRevision.stream.sessionId === result.sessionId &&
				item.enqueueRevision.sequence + 1 === item.enqueuedSequence &&
				(item.targetTurnRevision === null || (
					sameRuntimeEventStream(item.targetTurnRevision.sessionRevision.stream, item.enqueueRevision.stream) &&
					item.targetTurnRevision.sessionRevision.sequence === item.enqueueRevision.sequence &&
					item.targetTurnRevision.sessionRevision.eventHash === item.enqueueRevision.eventHash
				)) &&
				(item.kind === "steer"
					? item.nextTurnPolicy === "next_model_turn"
					: item.nextTurnPolicy === "after_active_run")
			));
			const queueRevision = canonicalDigest(result.items.map((item) => ({
				queueItemId: item.queueItemId,
				sourceCommandId: item.sourceCommandId,
				kind: item.kind,
				enqueueRevision: item.enqueueRevision,
				targetTurnRevision: item.targetTurnRevision,
				nextTurnPolicy: item.nextTurnPolicy,
				contentDigest: item.contentDigest,
				content: item.content,
				status: item.status,
				enqueuedSequence: item.enqueuedSequence,
			})));
			return result.sessionId === query.payload.sessionId && ordered && unique && contentBound && revisionBound && result.queueRevision === queueRevision
				? { ok: true, value: undefined }
				: controlPlaneFailure("adapter_contract_violation", "queue list is not canonically bound to the requested session state");
		}
		case "changeProposal:inspect":
			if (result.type !== "changeProposal:inspect") {
				return controlPlaneFailure("adapter_contract_violation", "change proposal result type is inconsistent");
			}
			return isChangeProposalRef(result.proposal) &&
				result.proposal.proposalId === query.payload.proposalId &&
				result.proposal.sessionId === query.payload.sessionId &&
				result.proposal.authorityId === query.authorityId &&
				result.proposal.tenantId === query.tenantId
				? { ok: true, value: undefined }
				: controlPlaneFailure("adapter_contract_violation", "change proposal inspection correlation is invalid");
		case "artifact:metadata":
			if (result.type !== "artifact:metadata") return controlPlaneFailure("adapter_contract_violation", "metadata result type is inconsistent");
			return result.artifactId === query.payload.artifactId
				? { ok: true, value: undefined }
				: controlPlaneFailure("adapter_contract_violation", "artifact metadata correlation is invalid");
		case "artifact:read": {
			if (result.type !== "artifact:read") return controlPlaneFailure("adapter_contract_violation", "artifact result type is inconsistent");
			if (
				result.artifactId !== query.payload.artifactId ||
				result.storedDigest !== query.payload.expectedDigest ||
				result.byteLength > query.payload.maxBytes
			) return controlPlaneFailure("adapter_contract_violation", "artifact read result violates the query bounds");
			let decoded: Buffer;
			try {
				decoded = Buffer.from(result.content, "base64");
			} catch {
				return controlPlaneFailure("adapter_contract_violation", "artifact read content is not base64");
			}
			return decoded.byteLength === result.byteLength
				? { ok: true, value: undefined }
				: controlPlaneFailure("adapter_contract_violation", "artifact read byteLength is invalid");
		}
		case "activity:get":
			if (result.type !== "activity:get") return controlPlaneFailure("adapter_contract_violation", "activity result type is inconsistent");
			if (result.sessionId !== query.payload.sessionId) {
				return controlPlaneFailure("adapter_contract_violation", "activity result session correlation is invalid");
			}
			if (result.sessionId === null) {
				return result.snapshot === null && result.activeTurnId === null && result.state !== "running" && result.state !== "waiting_approval"
					? { ok: true, value: undefined }
					: controlPlaneFailure("adapter_contract_violation", "daemon activity without a session fabricated session state");
			}
			if (
				!result.snapshot ||
				!isRuntimeActivityProjection(result.snapshot) ||
				result.snapshot.authorityId !== query.authorityId ||
				result.snapshot.tenantId !== query.tenantId ||
				result.snapshot.principalId !== query.principalId ||
				result.snapshot.sessionId !== result.sessionId ||
				result.snapshot.activeTurnId !== result.activeTurnId ||
				result.snapshot.heartbeat.observedAt !== result.updatedAt
			) return controlPlaneFailure("adapter_contract_violation", "activity snapshot is not canonically correlated");
			const expectedState = result.snapshot.status === "active"
				? "running"
				: result.snapshot.status === "waiting_permission"
					? "waiting_approval"
					: result.snapshot.status;
			return result.state === expectedState
				? { ok: true, value: undefined }
				: controlPlaneFailure("adapter_contract_violation", "activity summary diverges from its canonical snapshot");
		case "health":
			if (result.type !== "health") return controlPlaneFailure("adapter_contract_violation", "health result type is inconsistent");
			return { ok: true, value: undefined };
	}
}

export class ControlPlaneQueryService {
	readonly #executor: QueryExecutorPort;
	readonly #handles: SessionHandleValidationPort;

	public constructor(options: ControlPlaneQueryServiceOptions) {
		this.#executor = options.executor;
		this.#handles = options.handles;
	}

	public async execute(input: unknown, context: ControlPlaneRequestContext): Promise<ControlPlaneResult<ControlPlaneQueryResponse>> {
		const validated = validateControlPlaneQuery(input);
		if (!validated.ok) return { ok: false, error: validated.error, effect: "none" };
		const query = validated.value;
		const handle = queryHandle(query);
		if (handle) {
			const current = this.#handles.validate(handle);
			if (!current.ok) return current;
		}
		let result: ControlPlaneResult<ControlPlaneQueryValue>;
		try {
			result = await this.#executor.execute(query, context);
		} catch (error) {
			result = adapterException("query", error);
		}
		if (!result.ok) return result;
		const checked = validateResult(query, result.value);
		if (!checked.ok) return checked;
		return {
			ok: true,
			value: { kind: "query_result", queryId: query.queryId, type: query.type, result: result.value },
		};
	}
}
