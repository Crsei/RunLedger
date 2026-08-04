/** Workspace binding lifecycle adapter for the Host-owned Runtime event writer. */

import {
	createRuntimeId,
	runtimeDigest,
	type AuthorityId,
	type PrincipalId,
	type RuntimeEventPayloadFor,
	type RuntimeEventBinding,
	type SessionId,
	type TenantId,
} from "../../runtime/contracts/public.ts";
import type { RuntimeEventAppendInput, RuntimeEventWriter } from "../../storage/host/runtime-event-store.ts";
import type { PersistedWorkspaceBinding } from "../persisted-binding.ts";
import type { WorkspaceBindingAuditPort } from "../host-binding.ts";

export interface RuntimeWorkspaceAuditAdapterOptions {
	readonly authorityId: AuthorityId;
	readonly tenantId: TenantId;
	readonly sessionId: SessionId;
	readonly principalId: PrincipalId;
	readonly writer: RuntimeEventWriter;
}

export class RuntimeWorkspaceAuditAdapter implements WorkspaceBindingAuditPort {
	readonly #authorityId: AuthorityId;
	readonly #tenantId: TenantId;
	readonly #sessionId: SessionId;
	readonly #principalId: PrincipalId;
	readonly #writer: RuntimeEventWriter;

	public constructor(options: RuntimeWorkspaceAuditAdapterOptions) {
		this.#authorityId = options.authorityId;
		this.#tenantId = options.tenantId;
		this.#sessionId = options.sessionId;
		this.#principalId = options.principalId;
		this.#writer = options.writer;
	}

	public async bound(binding: PersistedWorkspaceBinding): Promise<void> {
		const traceId = this.trace(binding, "bound");
		const payload: RuntimeEventPayloadFor<"workspace.bound"> = {
			subject: { kind: "workspace", id: binding.binding.workspaceId },
			correlationId: traceId,
			effect: "committed",
			idempotencyKey: `workspace:bound:${binding.bindingDigest.digest}`,
			transition: { revision: 0, previousStatus: null, nextStatus: "bound" },
			expectedRevision: 0,
			bindings: this.bindings(binding),
			refs: [this.ref(binding.bindingDigest, "application/vnd.runledger.workspace-binding+json")],
		};
		await this.append("workspace.bound", traceId, payload);
	}

	public async validationRecorded(binding: PersistedWorkspaceBinding): Promise<void> {
		const observedDigest = runtimeDigest({
			bindingDigest: binding.bindingDigest,
			headCommit: binding.headCommit ?? null,
			effectiveCwdDigest: binding.binding.effectiveCwdDigest,
		});
		const traceId = this.trace(binding, `validation:${observedDigest.digest}`);
		const payload: RuntimeEventPayloadFor<"workspace.validation_recorded"> = {
			subject: { kind: "workspace", id: binding.binding.workspaceId },
			correlationId: traceId,
			effect: "committed",
			idempotencyKey: `workspace:validation:${observedDigest.digest}`,
			refs: [
				this.ref(binding.bindingDigest, "application/vnd.runledger.workspace-binding+json"),
				this.ref(observedDigest, "application/vnd.runledger.workspace-validation+json"),
			],
			metadataDigest: runtimeDigest({
				bindingDigest: binding.bindingDigest,
				headCommit: binding.headCommit ?? null,
				effectiveCwdDigest: binding.binding.effectiveCwdDigest,
			}),
		};
		await this.append("workspace.validation_recorded", traceId, payload);
	}

	public async released(binding: PersistedWorkspaceBinding, reason: string): Promise<void> {
		const traceId = this.trace(binding, `released:${reason}`);
		const payload: RuntimeEventPayloadFor<"workspace.released"> = {
			subject: { kind: "workspace", id: binding.binding.workspaceId },
			correlationId: traceId,
			effect: "committed",
			idempotencyKey: `workspace:released:${binding.bindingDigest.digest}:${reason}`,
			transition: { revision: binding.lease.leaseRevision, previousStatus: "bound", nextStatus: "released" },
			expectedRevision: Math.max(0, binding.lease.leaseRevision - 1),
			reasonCode: reason,
			refs: [this.ref(binding.bindingDigest, "application/vnd.runledger.workspace-binding+json")],
		};
		await this.append("workspace.released", traceId, payload);
	}

	private bindings(binding: PersistedWorkspaceBinding): readonly RuntimeEventBinding[] {
		return [
			{ role: "repository", subjectId: binding.binding.repositoryId },
			{ role: "lease-owner", subjectId: binding.lease.ownerRuntimeId },
		];
	}

	private ref(digest: ReturnType<typeof runtimeDigest>, mediaType: string) {
		return { subjectKind: "receipt" as const, digest, mediaType, size: 0 };
	}

	private trace(binding: PersistedWorkspaceBinding, suffix: string) {
		return createRuntimeId("trace", runtimeDigest({ workspaceId: binding.binding.workspaceId, bindingDigest: binding.bindingDigest, suffix }).digest.slice(0, 48));
	}

	private async append(
		type: RuntimeEventAppendInput["type"],
		traceId: RuntimeEventAppendInput["traceId"],
		payload: RuntimeEventAppendInput["payload"],
	): Promise<void> {
		await this.#writer.append({
			authorityId: this.#authorityId,
			tenantId: this.#tenantId,
			principalId: this.#principalId,
			sessionId: this.#sessionId,
			traceId,
			type,
			payload,
		});
	}
}
