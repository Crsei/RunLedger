import { describe, expect, it } from "vitest";
import { createLocalIdentityContext } from "../../src/runtime/identity/local-principal.ts";
import {
	COORDINATION_STATE_TRANSITIONS,
	createIdempotencyKey,
	isAllowedCoordinationTransition,
	parseIdempotencyKey,
} from "../../src/runtime/protocol/v3/coordination.ts";
import { RUNTIME_ERROR_CODES, isRuntimeErrorCode, RuntimeContractError } from "../../src/runtime/protocol/v3/errors.ts";
import {
	createRuntimeId,
	createScopedRuntimeKey,
	parseRuntimeId,
	parseScopedRuntimeKey,
	RUNTIME_ID_KINDS,
} from "../../src/runtime/protocol/v3/ids.ts";
import { createWorktreeId, parseWorktreeId } from "../../src/runtime/protocol/v3/workspace.ts";
import { describeIntegrityClaim, RUNTIME_THREAT_MODELS } from "../../src/runtime/protocol/v3/threat-model.ts";
import { isAllowedRuntimeStateTransition } from "../../src/runtime/protocol/v3/state-transitions.ts";
import {
	DEFAULT_RUNTIME_FEATURES,
	RUNTIME_FEATURE_NAMES,
	sessionCompatibilityDecision,
	validateRuntimeFeatureFlags,
} from "../../src/runtime/runtime-features.ts";

describe("Runtime v3 identifiers", () => {
	it("round-trips every registered ID kind", () => {
		const authorityId = createRuntimeId("authority", "local");
		const tenantId = createRuntimeId("tenant", "local");
		for (const kind of RUNTIME_ID_KINDS) {
			const value = createRuntimeId(kind, "fixture-01");
			expect(parseRuntimeId(kind, value), kind).toBe(value);
			const scopedKey = createScopedRuntimeKey({ authorityId, tenantId }, value);
			expect(parseScopedRuntimeKey(kind, scopedKey), kind).toEqual({
				scope: { authorityId, tenantId },
				id: value,
			});
		}
	});

	it("keeps the Workspace helper on the unified Worktree ID contract", () => {
		const worktreeId = createWorktreeId("fixture-01");
		expect(RUNTIME_ID_KINDS).toContain("worktree");
		expect(parseRuntimeId("worktree", worktreeId)).toBe(worktreeId);
		expect(parseWorktreeId(worktreeId)).toBe(worktreeId);
	});

	it("rejects invalid seeds instead of lossy sanitization", () => {
		expect(() => createRuntimeId("session", "a/b")).toThrow(RuntimeContractError);
		expect(() => createRuntimeId("session", "a?b")).toThrow(RuntimeContractError);
		expect(() => createRuntimeId("session", "x".repeat(97))).toThrow("invalid session id seed");
		expect(parseRuntimeId("session", "goal_fixture")).toBeUndefined();
	});

	it("binds primary keys to authority and tenant", () => {
		const authorityId = createRuntimeId("authority", "local");
		const tenantId = createRuntimeId("tenant", "tenant-a");
		const sessionId = createRuntimeId("session", "fixture");
		const key = createScopedRuntimeKey({ authorityId, tenantId }, sessionId);
		expect(parseScopedRuntimeKey("session", key)).toEqual({ scope: { authorityId, tenantId }, id: sessionId });
		const other = createScopedRuntimeKey({ authorityId, tenantId: createRuntimeId("tenant", "tenant-b") }, sessionId);
		expect(other).not.toBe(key);
	});

	it("keeps the local authority, tenant, and OS principal stable across persisted contexts", () => {
		const first = createLocalIdentityContext(new Date("2026-07-22T00:00:00.000Z"));
		const second = createLocalIdentityContext(new Date("2026-07-23T00:00:00.000Z"));
		expect(second).toMatchObject({
			authorityId: first.authorityId,
			tenantId: first.tenantId,
			principalId: first.principalId,
			source: "local-os",
		});
		expect(JSON.parse(JSON.stringify(first))).toEqual(first);
	});
});

describe("Runtime v3 coordination and errors", () => {
	it("uses explicit, validated idempotency keys", () => {
		const value = createIdempotencyKey("operation.0000001");
		expect(parseIdempotencyKey(value)).toBe(value);
		expect(parseIdempotencyKey("short")).toBeUndefined();
	});

	it("keeps intent/commit/reconcile transitions fail closed", () => {
		expect(isAllowedCoordinationTransition("intent_recorded", "external_pending")).toBe(true);
		expect(isAllowedCoordinationTransition("external_committed", "reconcile_required")).toBe(true);
		expect(isAllowedCoordinationTransition("reconciled", "external_pending")).toBe(false);
		expect(Object.keys(COORDINATION_STATE_TRANSITIONS)).toHaveLength(7);
	});

	it("freezes lifecycle transitions and terminal states", () => {
		expect(isAllowedRuntimeStateTransition("tool_call", "requested", "authorized")).toBe(true);
		expect(isAllowedRuntimeStateTransition("tool_call", "requested", "finished")).toBe(false);
		expect(isAllowedRuntimeStateTransition("session", "closed", "active")).toBe(false);
		expect(isAllowedRuntimeStateTransition("verification", "started", "inconclusive")).toBe(true);
		expect(isAllowedRuntimeStateTransition("episode", "evidence_ready", "manifest_committed")).toBe(true);
		expect(isAllowedRuntimeStateTransition("episode", "manifest_committed", "completed")).toBe(false);
		expect(isAllowedRuntimeStateTransition("episode", "seal_recorded", "completed")).toBe(true);
		expect(isAllowedRuntimeStateTransition("draft_pr", "requested", "created")).toBe(true);
		expect(isAllowedRuntimeStateTransition("draft_pr", "pending", "created")).toBe(false);
		expect(isAllowedRuntimeStateTransition("human_gate", "requested", "approved")).toBe(true);
	});

	it("publishes a stable typed error registry", () => {
		expect(new Set(RUNTIME_ERROR_CODES).size).toBe(RUNTIME_ERROR_CODES.length);
		expect(isRuntimeErrorCode("oversized_payload")).toBe(true);
		expect(isRuntimeErrorCode("future_error")).toBe(false);
	});
});

describe("Runtime v3 threat models and rollout", () => {
	it("separates local, managed, and remote trust roots", () => {
		expect(Object.keys(RUNTIME_THREAT_MODELS).sort()).toEqual(["local", "managed", "remote"]);
		expect(RUNTIME_THREAT_MODELS.local.defaultAttestation).toBe("unattested");
		expect(RUNTIME_THREAT_MODELS.managed.defaultAttestation).toBe("attested");
		expect(RUNTIME_THREAT_MODELS.remote.failClosedWhen.length).toBeGreaterThan(0);
		expect(describeIntegrityClaim("valid", "unattested")).toBe("valid/unattested");
	});

	it("keeps every governed feature disabled by default", () => {
		expect(Object.keys(DEFAULT_RUNTIME_FEATURES)).toEqual([...RUNTIME_FEATURE_NAMES]);
		expect(Object.values(DEFAULT_RUNTIME_FEATURES).every((enabled) => !enabled)).toBe(true);
		expect(validateRuntimeFeatureFlags(DEFAULT_RUNTIME_FEATURES)).toEqual([]);
		expect(validateRuntimeFeatureFlags({ ...DEFAULT_RUNTIME_FEATURES, daemon: true })).toContain("daemon requires sessionV3");
	});

	it("freezes the target v1/v2/v3 compatibility matrix", () => {
		expect(sessionCompatibilityDecision(1, "append")).toBe("explicit_migration_required");
		expect(sessionCompatibilityDecision(2, "migrate_to_v3")).toBe("allow");
		expect(sessionCompatibilityDecision(3, "append")).toBe("allow");
		expect(sessionCompatibilityDecision(3, "downgrade")).toBe("deny");
	});
});
