import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	CapabilityReplayGuard,
	CAPABILITY_GATEWAY_SCHEMA_VERSION,
	capabilityGatewayRequestDigest,
	gatewayRateLimitReceiptMatchesRequest,
	isCapabilityGatewayRequest,
	isGatewayRateLimitReceipt,
	validateCapabilityGatewayRequest,
	type CapabilityGatewayRequest,
	type CapabilityGatewayRequestBody,
	type GatewayRateLimitReceipt,
	type GatewayRateLimitRequest,
} from "../../../src/runtime/protocol/v3/capability.ts";
import { canonicalDigest } from "../../../src/runtime/protocol/v3/canonical-json.ts";
import { createSessionEventStreamRef, type EventCursor } from "../../../src/runtime/protocol/v3/events.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/v3/ids.ts";
import {
	declassificationAllowsSourceAtSink,
	isDeclassificationReceiptRef,
	isInputSourceRef,
	propagateInputSources,
	type DeclassificationReceiptRef,
	type InputSourceRef,
} from "../../../src/runtime/protocol/v3/taint.ts";
import { CapabilityAuthenticationAdapter } from "../../../src/security/integration/capability-authentication.ts";

const AUTHORITY_ID = createRuntimeId("authority", "security-auth");
const TENANT_ID = createRuntimeId("tenant", "security-auth");
const PRINCIPAL_ID = createRuntimeId("principal", "security-auth");
const REQUEST_ID = createRuntimeId("command", "security-auth");
const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);
const NOW = new Date("2026-07-22T00:01:00.000Z");

function source(): InputSourceRef {
	return {
		schemaVersion: 1,
		authorityId: AUTHORITY_ID,
		tenantId: TENANT_ID,
		sourceId: createRuntimeId("inputSource", "candidate-comment"),
		kind: "comment",
		sourceDigest: DIGEST_A,
		trust: "tainted",
		taintLabels: ["external_untrusted"],
		observedAt: "2026-07-22T00:00:00.000Z",
	};
}

function declassification(input = source()): DeclassificationReceiptRef {
	const body: Omit<DeclassificationReceiptRef, "receiptDigest"> = {
		schemaVersion: 1,
		authorityId: input.authorityId,
		tenantId: input.tenantId,
		receiptId: createRuntimeId("declassification", "candidate-comment-shell"),
		sourceId: input.sourceId,
		sourceDigest: input.sourceDigest,
		allowedSink: "shell",
		policyDigest: DIGEST_B,
		approverPrincipalId: createRuntimeId("principal", "independent-reviewer"),
		decisionRevision: 1,
		issuedAt: "2026-07-22T00:00:30.000Z",
		expiresAt: "2026-07-22T00:05:00.000Z",
	};
	return { ...body, receiptDigest: canonicalDigest(body) };
}

function gatewayBody(receipts: readonly DeclassificationReceiptRef[] = []): CapabilityGatewayRequestBody {
	const input = source();
	const envelope = {
		authorityId: AUTHORITY_ID,
		tenantId: TENANT_ID,
		principalId: PRINCIPAL_ID,
		sessionId: createRuntimeId("session", "security-auth"),
		workspaceId: createRuntimeId("workspace", "security-auth"),
		repositoryId: createRuntimeId("repository", "security-auth"),
		worktreePath: "/workspace/security-auth",
		branch: "runtime/security-auth",
		baseCommit: "1".repeat(40),
		agentId: createRuntimeId("agent", "security-auth"),
		toolCallId: createRuntimeId("toolCall", "security-auth"),
		traceId: createRuntimeId("trace", "security-auth"),
		cwd: "/workspace/security-auth",
		ownerRuntimeId: createRuntimeId("runtime", "security-auth"),
		leaseRevision: 1,
		fencingToken: "security-auth-fence",
	};
	return {
		schemaVersion: CAPABILITY_GATEWAY_SCHEMA_VERSION,
		request: {
			authorityId: AUTHORITY_ID,
			tenantId: TENANT_ID,
			principalId: PRINCIPAL_ID,
			requestId: REQUEST_ID,
			approvalId: createRuntimeId("approval", "security-auth"),
			sessionId: envelope.sessionId,
			runtimeId: envelope.ownerRuntimeId,
			runtimeGeneration: envelope.leaseRevision,
			turnId: createRuntimeId("turn", "security-auth"),
			toolCallId: envelope.toolCallId,
			capability: "process",
			argumentsDigest: DIGEST_A,
			workspaceEnvelopeDigest: DIGEST_B,
			policyDigest: DIGEST_B,
			serverScope: "tool_server",
			resourceScopeDigest: DIGEST_A,
			commandScopeDigest: DIGEST_B,
		},
		invocation: {
			requestId: REQUEST_ID,
			toolManifestDigest: DIGEST_A,
			rawArguments: { argv: ["trusted-tool", "untrusted-value"] },
			envelope,
			requestedClaims: [{
				authorityId: AUTHORITY_ID,
				tenantId: TENANT_ID,
				name: "process",
				resourceKind: "process",
				resourceDigest: DIGEST_A,
				constraintsDigest: DIGEST_B,
			}],
		},
		idempotencyKey: REQUEST_ID,
		inputSources: [input],
		targetSink: "shell",
		declassificationReceipts: receipts,
	};
}

function gatewayRequest(receipts: readonly DeclassificationReceiptRef[] = []): CapabilityGatewayRequest {
	const body = gatewayBody(receipts);
	return {
		...body,
		authentication: {
			channel: "local_socket",
			channelBindingDigest: DIGEST_A,
			requestDigest: capabilityGatewayRequestDigest(body),
			nonce: "nonce.security.auth.0001",
			issuedAt: "2026-07-22T00:00:00.000Z",
			expiresAt: "2026-07-22T00:05:00.000Z",
			keyRevision: 7,
			eventCursor: {
				stream: createSessionEventStreamRef(
					{ authorityId: body.request.authorityId, tenantId: body.request.tenantId },
					body.request.sessionId,
				),
				sequence: 4,
				eventId: createRuntimeId("event", "security-auth-head"),
				eventHash: DIGEST_B,
			},
		},
	};
}

function requestCursor(request: CapabilityGatewayRequest): EventCursor {
	if (request.authentication.channel === "signed_remote") throw new Error("expected local request");
	return request.authentication.eventCursor;
}

function authenticationAdapter(current: () => Promise<EventCursor | undefined>): CapabilityAuthenticationAdapter {
	return new CapabilityAuthenticationAdapter({
		clock: () => NOW,
		peerBindings: [{
			authorityId: AUTHORITY_ID,
			tenantId: TENANT_ID,
			principalId: PRINCIPAL_ID,
			channel: "local_socket",
			channelBindingDigest: DIGEST_A,
			keyRevision: 7,
			issuedAt: "2026-07-22T00:00:00.000Z",
		}],
		eventCursorAuthority: { current },
	});
}

describe("authenticated capability requests and taint propagation", () => {
	it("preserves exact source labels and requires a sink-specific independent receipt", () => {
		const input = source();
		const receipt = declassification(input);
		expect(isInputSourceRef(input)).toBe(true);
		expect(isDeclassificationReceiptRef(receipt)).toBe(true);
		expect(propagateInputSources([input], [input])).toEqual([input]);
		expect(declassificationAllowsSourceAtSink(receipt, input, "shell", NOW)).toBe(true);
		expect(declassificationAllowsSourceAtSink(receipt, input, "network", NOW)).toBe(false);
		expect(isInputSourceRef({ ...input, trust: "trusted", taintLabels: [] })).toBe(false);
	});

	it("rejects undeclassified sinks, replayed nonces, expired requests, and revoked key revisions", () => {
		const undeclassified = gatewayRequest();
		expect(isCapabilityGatewayRequest(undeclassified)).toBe(true);
		expect(validateCapabilityGatewayRequest(undeclassified, { at: NOW })).toEqual({
			ok: false,
			reason: "taint_not_declassified",
		});

		const request = gatewayRequest([declassification()]);
		const replayGuard = new CapabilityReplayGuard();
		expect(validateCapabilityGatewayRequest(request, { at: NOW, replayGuard }).ok).toBe(true);
		expect(validateCapabilityGatewayRequest(request, { at: NOW, replayGuard })).toEqual({
			ok: false,
			reason: "replayed_nonce",
		});
		expect(validateCapabilityGatewayRequest(request, { at: NOW, revokedKeyRevisions: new Set([7]) })).toEqual({
			ok: false,
			reason: "revoked_key",
		});
		expect(validateCapabilityGatewayRequest(request, { at: new Date("2026-07-22T00:05:00.000Z") })).toEqual({
			ok: false,
			reason: "expired",
		});
		expect(isCapabilityGatewayRequest({
			...request,
			inputSources: [{ ...source(), tenantId: createRuntimeId("tenant", "other") }],
		})).toBe(false);
	});

	it("requires strict v2 bodies and exact local cursor fields", () => {
		const request = gatewayRequest([declassification()]);
		const { schemaVersion: _schemaVersion, ...unversioned } = request;
		const authentication = request.authentication;
		if (authentication.channel === "signed_remote") throw new Error("expected local request");
		const { eventCursor: _eventCursor, ...withoutCursor } = authentication;

		expect(isCapabilityGatewayRequest(unversioned)).toBe(false);
		expect(isCapabilityGatewayRequest({ ...request, schemaVersion: 1 })).toBe(false);
		expect(isCapabilityGatewayRequest({ ...request, schemaVersion: 3 })).toBe(false);
		expect(isCapabilityGatewayRequest({ ...request, futureField: true })).toBe(false);
		expect(isCapabilityGatewayRequest({ ...request, authentication: withoutCursor })).toBe(false);
		expect(isCapabilityGatewayRequest({
			...request,
			authentication: {
				...authentication,
				eventCursor: { ...authentication.eventCursor, futureField: true },
			},
		})).toBe(false);
	});

	it("rejects a local cursor from another session even when its stream ID is canonical", () => {
		const request = gatewayRequest([declassification()]);
		const authentication = request.authentication;
		if (authentication.channel === "signed_remote") throw new Error("expected local request");
		const otherSessionId = createRuntimeId("session", "security-auth-other");

		expect(isCapabilityGatewayRequest({
			...request,
			authentication: {
				...authentication,
				eventCursor: {
					...authentication.eventCursor,
					stream: createSessionEventStreamRef(
						{ authorityId: AUTHORITY_ID, tenantId: TENANT_ID },
						otherSessionId,
					),
				},
			},
		})).toBe(false);
	});

	it("accepts only the exact trusted current local writer head", async () => {
		const request = gatewayRequest([declassification()]);
		const cursor = requestCursor(request);
		expect(await authenticationAdapter(async () => cursor).verify(request)).toMatchObject({
			status: "authenticated",
		});

		for (const candidate of [
			{ ...cursor, sequence: cursor.sequence - 1 },
			{ ...cursor, sequence: cursor.sequence + 1 },
			{ ...cursor, eventId: createRuntimeId("event", "security-auth-tampered") },
			{ ...cursor, eventHash: DIGEST_A },
		]) {
			const authentication = request.authentication;
			if (authentication.channel === "signed_remote") throw new Error("expected local request");
			const changed: CapabilityGatewayRequest = {
				...request,
				authentication: { ...authentication, eventCursor: candidate },
			};
			expect(await authenticationAdapter(async () => cursor).verify(changed)).toMatchObject({
				status: "rejected",
			});
		}

		expect(await authenticationAdapter(async () => undefined).verify(request)).toMatchObject({
			status: "rejected",
		});
	});

	it("reports cursor authority failures as unavailable", async () => {
		const request = gatewayRequest([declassification()]);
		const adapter = authenticationAdapter(() => {
			throw new Error("writer head unavailable");
		});
		expect(await adapter.verify(request)).toMatchObject({ status: "unavailable" });
	});

	it("keeps signed_remote signature-only and does not consult the local cursor authority", async () => {
		const local = gatewayRequest([declassification()]);
		const authentication = local.authentication;
		if (authentication.channel === "signed_remote") throw new Error("expected local request");
		const { eventCursor: _eventCursor, channel: _channel, ...authenticationBase } = authentication;
		const signed: CapabilityGatewayRequest = {
			...local,
			authentication: {
				...authenticationBase,
				channel: "signed_remote",
				signingKeyId: createRuntimeId("resource", "security-auth-signing-key"),
				signatureDigest: DIGEST_B,
			},
		};

		expect(isCapabilityGatewayRequest(signed)).toBe(true);
		expect(isCapabilityGatewayRequest({
			...signed,
			authentication: { ...signed.authentication, eventCursor: requestCursor(local) },
		})).toBe(false);
		const { signatureDigest: _signatureDigest, ...missingSignature } = signed.authentication;
		expect(isCapabilityGatewayRequest({ ...signed, authentication: missingSignature })).toBe(false);

		let cursorCalls = 0;
		let verifierCalls = 0;
		const receiptId = createRuntimeId("receipt", "security-auth-signed");
		const adapter = new CapabilityAuthenticationAdapter({
			clock: () => NOW,
			peerBindings: [],
			eventCursorAuthority: {
				current: async () => {
					cursorCalls += 1;
					throw new Error("must not be called");
				},
			},
			signedVerifier: {
				verify: async (candidate) => {
					verifierCalls += 1;
					expect(candidate).toMatchObject({
						signingKeyId: signed.authentication.channel === "signed_remote"
							? signed.authentication.signingKeyId
							: undefined,
						signatureDigest: DIGEST_B,
						requestDigest: signed.authentication.requestDigest,
					});
					return { status: "authenticated", verifierReceiptId: receiptId };
				},
			},
		});
		expect(await adapter.verify(signed)).toEqual({
			requestId: signed.request.requestId,
			requestDigest: signed.authentication.requestDigest,
			status: "authenticated",
			verifierReceiptId: receiptId,
		});
		expect(cursorCalls).toBe(0);
		expect(verifierCalls).toBe(1);
	});

	it("round-trips the v2 golden request and pins its body and file digests", () => {
		const path = fileURLToPath(new URL("./fixtures/capability-gateway-v2.json", import.meta.url));
		const bytes = readFileSync(path);
		const fixture = JSON.parse(bytes.toString("utf8")) as unknown;
		const roundTrip = JSON.parse(JSON.stringify(fixture)) as unknown;

		expect(isCapabilityGatewayRequest(roundTrip)).toBe(true);
		if (!isCapabilityGatewayRequest(roundTrip)) throw new Error("invalid capability gateway v2 fixture");
		const { authentication, ...body } = roundTrip;
		expect(authentication.requestDigest).toBe(capabilityGatewayRequestDigest(body));
		expect(createHash("sha256").update(bytes).digest("hex")).toBe(
			"ebe846c2e64658fff82a9059c809931ad352f28f026cd6e702b646addc1ab2bc",
		);
	});
});

describe("Gateway rate-limit receipts", () => {
	it("binds reserve receipts to principal, capability, resource, window, and units", () => {
		const request: GatewayRateLimitRequest = {
			authorityId: AUTHORITY_ID,
			tenantId: TENANT_ID,
			principalId: PRINCIPAL_ID,
			rateLimitId: createRuntimeId("rateLimit", "security-auth"),
			requestId: REQUEST_ID,
			operation: "reserve",
			capability: "process",
			resourceDigest: DIGEST_A,
			windowStartedAt: "2026-07-22T00:00:00.000Z",
			windowExpiresAt: "2026-07-22T00:05:00.000Z",
			units: 1,
			idempotencyKey: createRuntimeId("command", "rate-limit-reserve"),
		};
		const body: Omit<GatewayRateLimitReceipt, "receiptDigest"> = {
			authorityId: AUTHORITY_ID,
			tenantId: TENANT_ID,
			principalId: PRINCIPAL_ID,
			receiptId: createRuntimeId("receipt", "rate-limit-reserve"),
			rateLimitId: request.rateLimitId,
			requestId: request.requestId,
			operation: request.operation,
			outcome: "reserved",
			capability: request.capability,
			resourceDigest: request.resourceDigest,
			windowStartedAt: request.windowStartedAt,
			windowExpiresAt: request.windowExpiresAt,
			requestedUnits: request.units,
			acceptedUnits: 1,
			remainingUnits: 9,
			policyDigest: DIGEST_B,
			issuedAt: "2026-07-22T00:01:00.000Z",
		};
		const receipt: GatewayRateLimitReceipt = { ...body, receiptDigest: canonicalDigest(body) };
		expect(isGatewayRateLimitReceipt(receipt)).toBe(true);
		expect(gatewayRateLimitReceiptMatchesRequest(receipt, request)).toBe(true);
		expect(isGatewayRateLimitReceipt({ ...receipt, acceptedUnits: 2 })).toBe(false);
		expect(gatewayRateLimitReceiptMatchesRequest({ ...receipt, tenantId: createRuntimeId("tenant", "other") }, request)).toBe(false);
	});
});
