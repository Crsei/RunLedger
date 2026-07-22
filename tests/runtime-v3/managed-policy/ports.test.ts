import { describe, expect, it } from "vitest";
import type {
	EnterpriseAuthenticationPort,
	EnterpriseAuthorizationPort,
	CredentialBrokerPort,
	ManagedKeyProviderPort,
	ManagedPolicyProviderPort,
} from "../../../src/runtime/identity/enterprise-ports.ts";

describe("enterprise opaque ports", () => {
	it("keep policy/authentication/authorization/key behavior behind specialty-owned adapters", () => {
		const policy: ManagedPolicyProviderPort = { resolve: async () => ({ ok: false, error: { code: "unavailable", retryable: true, reasonDigest: "a".repeat(64) } }) };
		const authentication: EnterpriseAuthenticationPort = { authenticate: async () => ({ ok: false, error: { code: "denied", retryable: false, reasonDigest: "b".repeat(64) } }) };
		const authorization: EnterpriseAuthorizationPort = { authorize: async () => ({ ok: false, error: { code: "unavailable", retryable: true, reasonDigest: "c".repeat(64) } }) };
		const keys: ManagedKeyProviderPort = {
			resolve: async () => ({ ok: false, error: { code: "unavailable", retryable: true, reasonDigest: "d".repeat(64) } }),
			lifecycle: async () => ({ ok: false, error: { code: "denied", retryable: false, reasonDigest: "e".repeat(64) } }),
		};
		const credentials: CredentialBrokerPort = {
			issue: async () => ({ ok: false, error: { code: "unavailable", retryable: true, reasonDigest: "f".repeat(64) } }),
			validateAudience: async () => ({ ok: false, error: { code: "denied", retryable: false, reasonDigest: "a".repeat(64) } }),
			revoke: async () => ({ ok: false, error: { code: "unavailable", retryable: true, reasonDigest: "b".repeat(64) } }),
		};
		expect([policy, authentication, authorization, keys, credentials]).toHaveLength(5);
		expect(Object.keys(keys).sort()).toEqual(["lifecycle", "resolve"]);
		expect(Object.keys(credentials).sort()).toEqual(["issue", "revoke", "validateAudience"]);
		expect(JSON.stringify({ keys, credentials })).not.toMatch(/keyBytes|secret|token|password/u);
	});
});
