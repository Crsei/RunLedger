import { describe, expect, it } from "vitest";
import { runtimeDigest } from "../../../src/runtime/protocol/foundation.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/ids.ts";
import { composeSessionResourceDomains } from "../../../src/runtime/session-runtime/resource-domain-composition.ts";
import { createSecuritySettingsResourceDomain } from "../../../src/runtime/session-runtime/security-settings-domain.ts";

describe("security settings Session resource domain", () => {
	it("exposes only typed inspect/update operations and keeps the running snapshot immutable", async () => {
		const initialDigest = runtimeDigest({ profile: "workspace-write" });
		const nextDigest = runtimeDigest({ profile: "approve-for-me" });
		const calls: unknown[] = [];
		const domain = createSecuritySettingsResourceDomain({
			generation: 7,
			settings: {
				inspect: async ({ scope }) => ({ ok: true, value: { scope, document: { profile: "workspace-write" }, sourceDigest: initialDigest } }),
				update: async (input) => {
					calls.push(input);
					return { ok: true, value: { scope: input.scope, document: input.document, sourceDigest: nextDigest } };
				},
			},
		});

		expect(domain.operationManifest).toEqual([
			{ operation: "security.settings.inspect", capability: "session.security.inspect", access: "read" },
			{ operation: "security.settings.update", capability: "session.security.inspect", access: "mutate" },
		]);
		expect(await domain.query("security.settings.inspect", { scope: "user" }, { correlationId: "correlation-1", effectId: "effect-1" })).toMatchObject({
			ok: true,
			domainRevision: 7,
			value: { scope: "user", document: { profile: "workspace-write" }, sourceDigest: initialDigest, appliesTo: "new_sessions", editable: true },
		});
		expect(await domain.mutate("security.settings.update", {
			scope: "workspace",
			expectedSourceDigest: initialDigest,
			document: { profile: "approve-for-me" },
		}, { correlationId: "correlation-2", effectId: "effect-2", expectedRevision: 7 })).toMatchObject({
			ok: true,
			domainRevision: 7,
			value: { scope: "workspace", document: { profile: "approve-for-me" }, sourceDigest: nextDigest, appliesTo: "new_sessions" },
		});
		expect(calls).toEqual([{
			scope: "workspace",
			expectedSourceDigest: initialDigest,
			document: { profile: "approve-for-me" },
		}]);
	});

	it("keeps constraint-governed settings editable for values accepted by the settings port", async () => {
		const domain = createSecuritySettingsResourceDomain({
			generation: 8,
			settings: {
				inspect: async ({ scope }) => ({ ok: true, value: { scope, document: { profile: "workspace-write" }, sourceDigest: runtimeDigest({ profile: "workspace-write" }) } }),
				update: async () => ({ ok: false, error: { code: "policy_denied", message: "unused", retryable: false } }),
			},
		});

		expect(await domain.query("security.settings.inspect", { scope: "user" }, { correlationId: "correlation-managed", effectId: "effect-managed" })).toMatchObject({
			ok: true,
			value: { editable: true },
		});
	});

	it("records a durable attempt receipt for a committed settings update", async () => {
		const attemptId = createRuntimeId("attempt", "security-settings");
		const commandId = createRuntimeId("command", "security-settings");
		const settled: unknown[] = [];
		const domain = createSecuritySettingsResourceDomain({
			generation: 4,
			settings: {
				inspect: async ({ scope }) => ({ ok: true, value: { scope, document: {}, sourceDigest: runtimeDigest({}) } }),
				update: async (input) => ({ ok: true, value: { scope: input.scope, document: input.document, sourceDigest: runtimeDigest(input.document) } }),
			},
			attemptPort: () => ({
				beginAttempt: () => ({ attemptId, commandId }),
				settleAttempt: (...input: unknown[]) => { settled.push(input); return { ok: true as const }; },
			}),
		});

		const result = await domain.mutate("security.settings.update", {
			scope: "user",
			expectedSourceDigest: runtimeDigest({}),
			document: { profile: "workspace-write" },
		}, { correlationId: "correlation-4", effectId: "effect-4", expectedRevision: 4 });

		expect(result).toMatchObject({ ok: true, receipt: { attemptId, commandId, outcome: "committed" } });
		expect(settled).toHaveLength(1);
	});

	it("composes the settings domain with existing Session resources without a routing bypass", async () => {
		const settings = createSecuritySettingsResourceDomain({
			generation: 3,
			settings: {
				inspect: async ({ scope }) => ({ ok: true, value: { scope, document: {}, sourceDigest: runtimeDigest({}) } }),
				update: async () => ({ ok: false, error: { code: "policy_denied", message: "unused", retryable: false } }),
			},
		});
		const existing = {
			operationManifest: [{ operation: "extension.inspect", capability: "session.extensions", access: "read" as const }],
			query: async (operation: string) => ({ ok: true as const, status: "ok" as const, operation, domainRevision: 3, value: { source: "existing" } }),
		};

		const resources = composeSessionResourceDomains([existing, settings]);
		expect(resources.operationManifest.map((entry) => entry.operation)).toEqual([
			"extension.inspect",
			"security.settings.inspect",
			"security.settings.update",
		]);
		expect(await resources.query("extension.inspect", {}, { correlationId: "correlation-3", effectId: "effect-3" })).toMatchObject({
			ok: true,
			value: { source: "existing" },
		});
	});
});
