import { describe, expect, it } from "vitest";
import {
	credentialAudienceReceiptMatchesRequest,
	isCredentialAudienceValidationReceiptRef,
	isCredentialGrantRevocationReceiptRef,
	isSessionCredentialGrantRef,
} from "../../src/runtime/identity/enterprise-schemas.ts";
import type {
	CredentialAudienceValidationRequest,
	CredentialGrantIssueRequest,
	CredentialGrantRevocationRequest,
	EnterprisePortResult,
	SessionCredentialGrantRef,
} from "../../src/runtime/identity/enterprise-types.ts";
import { canonicalDigest } from "../../src/runtime/protocol/v3/canonical-json.ts";
import { createRuntimeId } from "../../src/runtime/protocol/v3/ids.ts";
import {
	CredentialBroker,
	type CredentialMaterialHandle,
} from "../../src/security/enterprise/credential-broker.ts";
import {
	RuntimeCredentialBrokerAdapter,
	type CredentialAudienceBindingRef,
	type CredentialAudienceBindingRequest,
	type CredentialAudienceBindingResolverPort,
} from "../../src/security/integration/credential-broker-adapter.ts";

const NOW = new Date("2026-07-22T00:00:00.000Z");
const SECRET = "credential-value-must-never-escape";
const AUDIENCE = "a".repeat(64);
const OTHER_AUDIENCE = "b".repeat(64);
const SCOPE = "c".repeat(64);
const REASON = "d".repeat(64);
const authorityId = createRuntimeId("authority", "credential-adapter");
const tenantId = createRuntimeId("tenant", "credential-adapter");
const otherTenantId = createRuntimeId("tenant", "credential-adapter-other");
const principalId = createRuntimeId("principal", "credential-adapter");
const sessionId = createRuntimeId("session", "credential-adapter");
const executorId = createRuntimeId("resource", "credential-adapter-executor");

class MutableClock {
	public value = new Date(NOW);

	public now = (): Date => new Date(this.value);

	public advance(milliseconds: number): void {
		this.value = new Date(this.value.getTime() + milliseconds);
	}
}

class AudienceResolver implements CredentialAudienceBindingResolverPort {
	public calls = 0;
	public audienceDigest = AUDIENCE;
	public throws = false;
	public mutateBinding = false;
	readonly #clock: MutableClock;

	public constructor(clock: MutableClock) {
		this.#clock = clock;
	}

	public async resolve(
		request: CredentialAudienceBindingRequest,
	): Promise<EnterprisePortResult<CredentialAudienceBindingRef>> {
		this.calls += 1;
		if (this.throws) throw new Error(`unavailable ${SECRET}`);
		const body = {
			...request,
			...(this.mutateBinding ? { targetExecutorId: createRuntimeId("resource", "uncorrelated-executor") } : {}),
			audienceDigest: this.audienceDigest,
			issuedAt: this.#clock.now().toISOString(),
			expiresAt: new Date(this.#clock.now().getTime() + 60_000).toISOString(),
		};
		return { ok: true, value: { ...body, bindingDigest: canonicalDigest(body) } };
	}
}

interface Harness {
	adapter: RuntimeCredentialBrokerAdapter;
	audience: AudienceResolver;
	clock: MutableClock;
	counts: {
		materialResolve: number;
		materialRevoke: number;
		inject: number;
		injectionRevoke: number;
	};
	failMaterialResolve(): void;
}

function createHarness(options: { maxGrantTtlMs?: number; maxRequestAgeMs?: number } = {}): Harness {
	const clock = new MutableClock();
	const audience = new AudienceResolver(clock);
	const counts = { materialResolve: 0, materialRevoke: 0, inject: 0, injectionRevoke: 0 };
	let materialUnavailable = false;
	const material = {
		handleId: createRuntimeId("resource", "credential-material-handle"),
		keyRefId: createRuntimeId("resource", "credential-material-key"),
		credentialKind: "ci-oidc",
		audienceDigest: AUDIENCE,
		providerRevision: 7,
		credentialValue: SECRET,
	};
	const broker = new CredentialBroker(
		{
			resolve: async (): Promise<{ ok: true; value: CredentialMaterialHandle } | { ok: false; error: { code: "credential_unavailable"; message: string; retryable: true } }> => {
				counts.materialResolve += 1;
				if (materialUnavailable) {
					return { ok: false, error: { code: "credential_unavailable", message: SECRET, retryable: true } };
				}
				return { ok: true, value: material };
			},
			revoke: async () => {
				counts.materialRevoke += 1;
				return { ok: true, value: undefined };
			},
		},
		{
			inject: async () => {
				counts.inject += 1;
				throw new Error("runtime adapter must not inject credential material during audience validation");
			},
			revoke: async () => {
				counts.injectionRevoke += 1;
				return { ok: true, value: undefined };
			},
		},
		60_000,
		clock.now,
	);
	return {
		adapter: new RuntimeCredentialBrokerAdapter({
			broker,
			audienceResolver: audience,
			maxGrantTtlMs: options.maxGrantTtlMs ?? 30_000,
			maxRequestAgeMs: options.maxRequestAgeMs ?? 60_000,
			allowedClockSkewMs: 0,
			clock: clock.now,
		}),
		audience,
		clock,
		counts,
		failMaterialResolve: () => {
			materialUnavailable = true;
		},
	};
}

function issueRequest(overrides: Partial<CredentialGrantIssueRequest> = {}): CredentialGrantIssueRequest {
	return {
		schemaVersion: 1,
		authorityId,
		tenantId,
		requestId: createRuntimeId("command", "credential-issue"),
		principalId,
		sessionId,
		credentialKind: "ci-oidc",
		audienceDigest: AUDIENCE,
		scopeDigest: SCOPE,
		requestedTtlMs: 20_000,
		requestedAt: NOW.toISOString(),
		...overrides,
	};
}

function validationRequest(
	grant: SessionCredentialGrantRef,
	overrides: Partial<CredentialAudienceValidationRequest> = {},
): CredentialAudienceValidationRequest {
	return {
		schemaVersion: 1,
		authorityId,
		tenantId,
		requestId: createRuntimeId("command", "credential-audience"),
		principalId,
		sessionId,
		grant,
		targetKind: "ci",
		targetExecutorId: executorId,
		invocationDigest: "e".repeat(64),
		requestedAt: NOW.toISOString(),
		...overrides,
	};
}

function revocationRequest(
	grant: SessionCredentialGrantRef,
	overrides: Partial<CredentialGrantRevocationRequest> = {},
): CredentialGrantRevocationRequest {
	return {
		schemaVersion: 1,
		authorityId,
		tenantId,
		requestId: createRuntimeId("command", "credential-revoke"),
		principalId,
		sessionId,
		grantId: grant.grantId,
		expectedReceiptDigest: grant.receiptDigest,
		reasonDigest: REASON,
		requestedAt: NOW.toISOString(),
		...overrides,
	};
}

async function issue(harness: Harness): Promise<SessionCredentialGrantRef> {
	const result = await harness.adapter.issue(issueRequest());
	if (!result.ok) throw new Error(`issue failed: ${result.error.code}`);
	return result.value;
}

function withTenant(grant: SessionCredentialGrantRef, nextTenantId: typeof tenantId): SessionCredentialGrantRef {
	const { receiptDigest: _receiptDigest, ...original } = grant;
	const body = { ...original, tenantId: nextTenantId };
	return { ...body, receiptDigest: canonicalDigest(body) };
}

describe("runtime credential broker adapter issuance", () => {
	it("issues one minimal audience-bound opaque grant and replays it idempotently", async () => {
		const harness = createHarness({ maxRequestAgeMs: 500 });
		const request = issueRequest();
		const first = await harness.adapter.issue(request);
		const replay = await harness.adapter.issue(request);
		expect(first).toEqual(replay);
		harness.clock.advance(501);
		expect(await harness.adapter.issue(request)).toEqual(first);
		expect(first).toMatchObject({
			ok: true,
			value: {
				authorityId,
				tenantId,
				principalId,
				sessionId,
				credentialKind: request.credentialKind,
				audienceDigest: request.audienceDigest,
				scopeDigest: request.scopeDigest,
			},
		});
		expect(harness.counts.materialResolve).toBe(1);
		if (!first.ok) return;
		expect(isSessionCredentialGrantRef(first.value)).toBe(true);
		const { receiptDigest, ...body } = first.value;
		expect(receiptDigest).toBe(canonicalDigest(body));
		expect(Date.parse(first.value.expiresAt) - Date.parse(first.value.issuedAt)).toBe(request.requestedTtlMs);
		expect(JSON.stringify({ first, replay })).not.toContain(SECRET);
		expect(harness.counts.inject).toBe(0);
	});

	it("rejects over-long grants and same-id content collisions without resolving material", async () => {
		const harness = createHarness({ maxGrantTtlMs: 20_000 });
		expect(await harness.adapter.issue(issueRequest({ requestedTtlMs: 20_001 }))).toMatchObject({
			ok: false,
			error: { code: "denied" },
		});
		expect(harness.counts.materialResolve).toBe(0);

		const request = issueRequest();
		expect(await harness.adapter.issue(request)).toMatchObject({ ok: true });
		expect(await harness.adapter.issue({ ...request, audienceDigest: OTHER_AUDIENCE })).toMatchObject({
			ok: false,
			error: { code: "invalid_request" },
		});
		expect(harness.counts.materialResolve).toBe(1);
	});

	it("maps broker unavailability to a secret-free fail-closed result", async () => {
		const harness = createHarness();
		harness.failMaterialResolve();
		const result = await harness.adapter.issue(issueRequest());
		expect(result).toMatchObject({ ok: false, error: { code: "unavailable", retryable: true } });
		expect(JSON.stringify(result)).not.toContain(SECRET);
	});
});

describe("runtime credential broker adapter audience validation", () => {
	it("requires an exact target binding and returns a canonical correlated receipt", async () => {
		const harness = createHarness();
		const grant = await issue(harness);
		const request = validationRequest(grant);
		const first = await harness.adapter.validateAudience(request);
		const replay = await harness.adapter.validateAudience(request);
		expect(first).toEqual(replay);
		expect(first).toMatchObject({ ok: true, value: { outcome: "valid", audienceDigest: AUDIENCE } });
		expect(harness.audience.calls).toBe(1);
		if (!first.ok) return;
		expect(isCredentialAudienceValidationReceiptRef(first.value)).toBe(true);
		expect(credentialAudienceReceiptMatchesRequest(first.value, request)).toBe(true);
		expect(JSON.stringify(first.value)).not.toContain(SECRET);
		expect(harness.counts.inject).toBe(0);

		const collision = await harness.adapter.validateAudience({
			...request,
			targetExecutorId: createRuntimeId("resource", "different-executor"),
		});
		expect(collision).toMatchObject({ ok: false, error: { code: "invalid_request" } });
		expect(harness.audience.calls).toBe(1);
	});

	it("rejects wrong audience, uncorrelated binding, cross-tenant grant, and stale request", async () => {
		const harness = createHarness({ maxRequestAgeMs: 5_000 });
		const grant = await issue(harness);

		harness.audience.audienceDigest = OTHER_AUDIENCE;
		const wrongAudience = await harness.adapter.validateAudience(validationRequest(grant, {
			requestId: createRuntimeId("command", "credential-audience-wrong"),
		}));
		expect(wrongAudience).toMatchObject({ ok: true, value: { outcome: "rejected" } });

		harness.audience.audienceDigest = AUDIENCE;
		harness.audience.mutateBinding = true;
		const uncorrelated = await harness.adapter.validateAudience(validationRequest(grant, {
			requestId: createRuntimeId("command", "credential-audience-uncorrelated"),
		}));
		expect(uncorrelated).toMatchObject({ ok: true, value: { outcome: "rejected" } });

		const otherGrant = withTenant(grant, otherTenantId);
		const crossTenant = await harness.adapter.validateAudience(validationRequest(otherGrant, {
			tenantId: otherTenantId,
			requestId: createRuntimeId("command", "credential-audience-cross-tenant"),
		}));
		expect(crossTenant).toMatchObject({ ok: false, error: { code: "scope_mismatch" } });

		const { receiptDigest: _receiptDigest, ...grantBody } = grant;
		const staleBody = { ...grantBody, scopeDigest: OTHER_AUDIENCE };
		const staleGrant = { ...staleBody, receiptDigest: canonicalDigest(staleBody) };
		const staleGrantReplay = await harness.adapter.validateAudience(validationRequest(staleGrant, {
			requestId: createRuntimeId("command", "credential-audience-stale-grant"),
		}));
		expect(staleGrantReplay).toMatchObject({ ok: false, error: { code: "stale_receipt" } });

		harness.clock.advance(5_001);
		const stale = await harness.adapter.validateAudience(validationRequest(grant, {
			requestId: createRuntimeId("command", "credential-audience-stale"),
		}));
		expect(stale).toMatchObject({ ok: false, error: { code: "stale_receipt" } });
	});

	it("returns an unavailable receipt when the trusted audience resolver fails", async () => {
		const harness = createHarness();
		const grant = await issue(harness);
		harness.audience.throws = true;
		const result = await harness.adapter.validateAudience(validationRequest(grant));
		expect(result).toMatchObject({ ok: true, value: { outcome: "unavailable" } });
		expect(JSON.stringify(result)).not.toContain(SECRET);
	});
});

describe("runtime credential broker adapter revocation", () => {
	it("serializes revocation, returns canonical receipts, and rejects a previously valid replay", async () => {
		const harness = createHarness({ maxRequestAgeMs: 5_000 });
		const grant = await issue(harness);
		const audienceRequest = validationRequest(grant);
		expect(await harness.adapter.validateAudience(audienceRequest)).toMatchObject({ ok: true, value: { outcome: "valid" } });

		harness.clock.advance(1_000);
		const request = revocationRequest(grant, { requestedAt: harness.clock.now().toISOString() });
		const first = await harness.adapter.revoke(request);
		const replay = await harness.adapter.revoke(request);
		expect(first).toEqual(replay);
		expect(first).toMatchObject({ ok: true, value: { outcome: "revoked" } });
		expect(harness.counts.materialRevoke).toBe(1);
		if (!first.ok) return;
		expect(isCredentialGrantRevocationReceiptRef(first.value)).toBe(true);

		const secondRequest = revocationRequest(grant, {
			requestId: createRuntimeId("command", "credential-revoke-second"),
			requestedAt: harness.clock.now().toISOString(),
		});
		expect(await harness.adapter.revoke(secondRequest)).toMatchObject({ ok: true, value: { outcome: "revoked" } });
		expect(harness.counts.materialRevoke).toBe(1);

		const revokedReplay = await harness.adapter.validateAudience(audienceRequest);
		expect(revokedReplay).toMatchObject({ ok: true, value: { outcome: "rejected" } });
		expect(harness.audience.calls).toBe(1);
		harness.clock.advance(5_001);
		expect(await harness.adapter.revoke(request)).toEqual(first);
		expect(harness.counts.materialRevoke).toBe(1);
		expect(JSON.stringify({ first, replay, revokedReplay })).not.toContain(SECRET);
	});

	it("rejects cross-tenant and stale-receipt revocation attempts without touching material", async () => {
		const harness = createHarness();
		const grant = await issue(harness);
		const crossTenant = await harness.adapter.revoke(revocationRequest(grant, {
			tenantId: otherTenantId,
			requestId: createRuntimeId("command", "credential-revoke-cross-tenant"),
		}));
		expect(crossTenant).toMatchObject({ ok: false, error: { code: "scope_mismatch" } });

		const stale = await harness.adapter.revoke(revocationRequest(grant, {
			requestId: createRuntimeId("command", "credential-revoke-stale"),
			expectedReceiptDigest: OTHER_AUDIENCE,
		}));
		expect(stale).toMatchObject({ ok: false, error: { code: "stale_receipt" } });
		expect(harness.counts.materialRevoke).toBe(0);
	});
});
