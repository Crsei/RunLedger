/** request_permissions 的被动 grant 状态；授权创建仍由 Host governed port 拥有。 */

import { canonicalDigest, runtimeDigest } from "../../runtime/contracts/public.ts";
import type { RuntimeDigest, SessionId, TurnId } from "../../runtime/contracts/public.ts";
import type { AccessRequest } from "../types.ts";

export type PermissionGrantScope = "one_off" | "turn" | "session";

export interface PermissionGrant {
	readonly grantId: string;
	readonly scope: PermissionGrantScope;
	readonly sessionId: SessionId;
	readonly turnId?: TurnId;
	readonly policyDigest: RuntimeDigest;
	readonly requestsDigest: RuntimeDigest;
	readonly issuedAt: string;
}

export interface PermissionGrantBinding {
	readonly sessionId: SessionId;
	readonly turnId: TurnId;
	readonly policyDigest: RuntimeDigest;
	readonly requests: readonly AccessRequest[];
}

export interface IssuePermissionGrantInput extends PermissionGrantBinding {
	readonly scope: PermissionGrantScope;
}

function requestsDigest(requests: readonly AccessRequest[]): RuntimeDigest {
	return runtimeDigest([...requests].sort((left, right) => canonicalDigest(left).localeCompare(canonicalDigest(right))));
}

function sameBinding(grant: PermissionGrant, input: PermissionGrantBinding): boolean {
	return grant.sessionId === input.sessionId && grant.policyDigest.digest === input.policyDigest.digest &&
		grant.requestsDigest.digest === requestsDigest(input.requests).digest &&
		(grant.scope === "session" || grant.turnId === input.turnId);
}

export class MemoryPermissionGrantStore {
	readonly #grants = new Map<string, PermissionGrant>();
	readonly #clock: () => Date;
	#revision = 0;

	public constructor(clock: () => Date = () => new Date()) {
		this.#clock = clock;
	}

	public async issue(input: IssuePermissionGrantInput): Promise<PermissionGrant> {
		this.#revision += 1;
		const digest = requestsDigest(input.requests);
		const issuedAt = this.#clock().toISOString();
		const grant: PermissionGrant = {
			grantId: `permissionGrant_${canonicalDigest({ sessionId: input.sessionId, turnId: input.turnId, scope: input.scope, policyDigest: input.policyDigest, requestsDigest: digest, issuedAt, revision: this.#revision }).slice(0, 48)}`,
			scope: input.scope,
			sessionId: input.sessionId,
			...(input.scope === "session" ? {} : { turnId: input.turnId }),
			policyDigest: input.policyDigest,
			requestsDigest: digest,
			issuedAt,
		};
		this.#grants.set(grant.grantId, grant);
		return structuredClone(grant);
	}

	public async authorize(input: PermissionGrantBinding): Promise<PermissionGrant | undefined> {
		for (const [grantId, grant] of this.#grants) {
			if (grant.sessionId === input.sessionId && grant.policyDigest.digest !== input.policyDigest.digest) this.#grants.delete(grantId);
		}
		const priority: Readonly<Record<PermissionGrantScope, number>> = { one_off: 0, turn: 1, session: 2 };
		const grant = [...this.#grants.values()]
			.filter((candidate) => sameBinding(candidate, input))
			.sort((left, right) => priority[left.scope] - priority[right.scope])[0];
		if (grant === undefined) return undefined;
		if (grant.scope === "one_off") this.#grants.delete(grant.grantId);
		return structuredClone(grant);
	}

	public async endTurn(sessionId: SessionId, turnId: TurnId): Promise<void> {
		for (const [grantId, grant] of this.#grants) {
			if (grant.sessionId === sessionId && grant.turnId === turnId) this.#grants.delete(grantId);
		}
	}
}
