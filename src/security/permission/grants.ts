/** policy/project-bound grant store；policy drift 或 revocation 后不可重放。 */

import { canonicalDigest } from "../../runtime/protocol/v3/canonical-json.ts";
import type { SessionGrant } from "../types.ts";

export class SessionGrantStore {
	readonly #grants = new Map<string, SessionGrant>();

	public put(grant: Omit<SessionGrant, "grantId">): SessionGrant {
		const grantId = `grant-${canonicalDigest(grant)}`;
		const value: SessionGrant = { ...grant, grantId };
		this.#grants.set(grantId, value);
		return value;
	}

	public resolve(input: {
		grantId: string;
		sessionId: SessionGrant["sessionId"];
		projectIdentityDigest: string;
		requestDigest: string;
		policyDigest: string;
		at: Date;
	}): SessionGrant | undefined {
		const grant = this.#grants.get(input.grantId);
		if (
			!grant ||
			grant.sessionId !== input.sessionId ||
			grant.projectIdentityDigest !== input.projectIdentityDigest ||
			grant.requestDigest !== input.requestDigest ||
			grant.policyDigest !== input.policyDigest ||
			grant.revokedAt !== undefined ||
			(grant.expiresAt !== undefined && Date.parse(grant.expiresAt) <= input.at.getTime())
		) return undefined;
		return grant;
	}

	public revoke(grantId: string, revokedAt: string): boolean {
		const grant = this.#grants.get(grantId);
		if (!grant || grant.revokedAt !== undefined) return false;
		this.#grants.set(grantId, { ...grant, revokedAt });
		return true;
	}
}
