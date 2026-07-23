/** Runtime WorkspaceServicePort -> WorktreeManager；不暴露 manager/path/token handle。 */

import { canonicalDigest } from "../../runtime/protocol/v3/canonical-json.ts";
import {
	isWorkspaceServiceRequest,
	workspaceExecutionEnvelopeDigest,
	type WorkspaceServicePort,
	type WorkspaceServiceRequest,
	type WorkspaceServiceResult,
} from "../../runtime/protocol/v3/workspace.ts";
import { WorktreeManager } from "../manager.ts";
import type { WorktreeError } from "../types.ts";

function rejected(request: WorkspaceServiceRequest, error: WorktreeError | { code: string; message: string; retryable: boolean }): WorkspaceServiceResult {
	return {
		schemaVersion: 1,
		requestId: request.requestId,
		kind: "rejected",
		code: error.code,
		messageDigest: canonicalDigest(error.message),
		retryable: error.retryable,
	};
}

export class RuntimeWorkspaceServiceAdapter implements WorkspaceServicePort {
	readonly #manager: WorktreeManager;
	readonly #requestDigests = new Map<WorkspaceServiceRequest["requestId"], string>();
	readonly #terminalResults = new Map<WorkspaceServiceRequest["requestId"], WorkspaceServiceResult>();

	public constructor(manager: WorktreeManager) {
		this.#manager = manager;
	}

	public async request(request: WorkspaceServiceRequest, signal?: AbortSignal): Promise<WorkspaceServiceResult> {
		if (!isWorkspaceServiceRequest(request)) return rejected(request, { code: "invalid_request", message: "workspace request schema is invalid", retryable: false });
		const requestDigest = canonicalDigest(request);
		const claimedDigest = this.#requestDigests.get(request.requestId);
		if (claimedDigest !== undefined && claimedDigest !== requestDigest) {
			return rejected(request, { code: "idempotency_conflict", message: "workspace request id was reused with another payload", retryable: false });
		}
		this.#requestDigests.set(request.requestId, requestDigest);
		const terminal = this.#terminalResults.get(request.requestId);
		if (terminal) return terminal;
		let result: WorkspaceServiceResult;
		switch (request.kind) {
			case "bind": {
				const source = await this.#manager.discoverSource(request.requestedCwd);
				if (!source.ok) {
					result = rejected(request, source.error);
					break;
				}
				if (request.baseCommit !== source.value.headCommit && request.bindingKind === "source") {
					result = rejected(request, { code: "stale", message: "source binding base commit changed", retryable: false });
					break;
				}
				const common = {
					authorityId: request.authorityId, tenantId: request.tenantId, principalId: request.principalId,
					sessionId: request.sessionId, repositoryId: request.repositoryId,
					sourceRepo: source.value.sourceRepo, sourceCwd: source.value.sourceCwd,
					baseRef: request.baseCommit, branch: request.branch, ownerRuntimeId: request.ownerRuntimeId, requestId: request.requestId,
				};
				const bound = request.bindingKind === "source"
					? await this.#manager.bindSource({ ...common, bindingKind: "source" })
					: await this.#manager.create({
						...common,
						label: `session-${canonicalDigest({ sessionId: request.sessionId, requestId: request.requestId }).slice(0, 12)}`,
						bindingKind: request.bindingKind,
					}, signal);
				result = bound.ok
					? { schemaVersion: 1, requestId: request.requestId, kind: "bound", receiptId: bound.value.receiptId, binding: bound.value.runtimeBinding, lease: bound.value.lease }
					: rejected(request, bound.error);
				break;
			}
			case "validate": {
				if (request.envelopeDigest !== workspaceExecutionEnvelopeDigest(request.envelope)) {
					result = rejected(request, { code: "invalid_request", message: "workspace envelope digest is invalid", retryable: false });
					break;
				}
				const validated = await this.#manager.validate(request.envelope);
				result = validated.ok
					? { schemaVersion: 1, requestId: request.requestId, kind: "validated", validation: validated.value.validation }
					: rejected(request, validated.error);
				break;
			}
			case "checkpoint": {
				const checkpointed = await this.#manager.checkpoint(request);
				result = checkpointed.ok
					? { schemaVersion: 1, requestId: request.requestId, kind: "checkpointed", receiptId: checkpointed.value.receiptId, checkpoint: checkpointed.value.checkpoint }
					: rejected(request, checkpointed.error);
				break;
			}
			case "release": {
				const released = await this.#manager.release(request);
				result = released.ok && released.value.record.lease
					? {
						schemaVersion: 1,
						requestId: request.requestId,
						kind: "released",
						receipt: released.value.receipt,
					}
					: rejected(request, released.ok
						? { code: "lease_conflict", message: "released record lacks a lease receipt", retryable: false }
						: released.error);
				break;
			}
		}
		if (result.kind !== "rejected" || !result.retryable) {
			this.#terminalResults.set(request.requestId, result);
		}
		return result;
	}
}
