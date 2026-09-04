/** Session Owner 对 security settings 的受控资源域。 */

import { parseSecurityConfigDocument } from "../../security/config/schema.ts";
import type { SecurityResult } from "../../security/types.ts";
import type {
	SecuritySettingsInspection,
	SecuritySettingsScope,
	SecuritySettingsUpdate,
} from "../../storage/security-settings-port.ts";
import { runtimeDigest, type RuntimeDigest } from "../protocol/foundation.ts";
import type { AttemptPort } from "./attempt-gateway.ts";
import type { SessionDomainMutationContext, SessionDomainResult } from "./domain-router.ts";
import type { SessionResourceDomainPort } from "./session-runtime.ts";

export interface SecuritySettingsPort {
	inspect(input: { readonly scope: SecuritySettingsScope }): Promise<SecurityResult<SecuritySettingsInspection>>;
	update(input: SecuritySettingsUpdate): Promise<SecurityResult<SecuritySettingsInspection>>;
}

export interface SecuritySettingsResourceDomainOptions {
	readonly generation: number;
	readonly settings: SecuritySettingsPort;
	/** 由 SessionRuntime 在 active owner 上绑定；缺失时仅限低层测试接缝。 */
	readonly attemptPort?: () => AttemptPort | undefined;
}

const OPERATION_MANIFEST = Object.freeze([
	Object.freeze({ operation: "security.settings.inspect", capability: "session.security.inspect", access: "read" as const }),
	Object.freeze({ operation: "security.settings.update", capability: "session.security.inspect", access: "mutate" as const }),
]);

/**
 * Settings 均为下一次 create/resume 的 baseline；此域不重建或替换当前
 * immutable SecuritySnapshot。路径、layout 和 raw fs 永远留在 storage adapter。
 */
export function createSecuritySettingsResourceDomain(options: SecuritySettingsResourceDomainOptions): SessionResourceDomainPort {
	return {
		operationManifest: OPERATION_MANIFEST,
		query: async (operation, payload) => {
			if (operation !== "security.settings.inspect") return unavailable(operation);
			const scope = scopeOf(payload.scope);
			if (scope === undefined) return failed(operation, "security_settings_scope_required");
			const inspected = await options.settings.inspect({ scope });
			return inspected.ok
				? ok(operation, options.generation, inspectionValue(inspected.value))
				: settingsFailure(operation, inspected.error.code);
		},
		mutate: async (operation, payload, context) => {
			if (operation !== "security.settings.update") return unavailable(operation);
			if (context.expectedRevision !== options.generation) {
				return { ok: false, status: "stale", code: "domain_revision_conflict", operation, currentRevision: options.generation };
			}
			const scope = scopeOf(payload.scope);
			if (scope === undefined) return failed(operation, "security_settings_scope_required");
			const expectedSourceDigest = digestOf(payload.expectedSourceDigest);
			if (expectedSourceDigest === undefined) return failed(operation, "security_settings_source_digest_required");
			const document = parseSecurityConfigDocument(payload.document);
			if (!document.ok) return failed(operation, document.error.code);
			const attempt = options.attemptPort?.();
			const begun = attempt?.beginAttempt("external_mutation", runtimeDigest({
				operation,
				scope,
				expectedSourceDigest: expectedSourceDigest.digest,
				documentDigest: runtimeDigest(document.value).digest,
				correlationId: context.correlationId,
				effectId: context.effectId,
			}));
			if (begun !== undefined && !("attemptId" in begun && "commandId" in begun)) {
				const code = "error" in begun ? begun.error : "attempt_start_failed";
				return { ok: false, status: code === "recovery_barrier_active" ? "recovery_required" : "failed", code, operation };
			}
			let updated: Awaited<ReturnType<SecuritySettingsPort["update"]>>;
			try {
				updated = await options.settings.update({
					scope,
					expectedSourceDigest,
					document: document.value,
				});
			} catch {
				if (begun !== undefined) awaitSettle(attempt, begun.attemptId, "uncertain", { operation, code: "settings_update_threw" });
				return failed(operation, "security_settings_update_failed");
			}
			if (!updated.ok) {
				if (begun !== undefined) {
					const outcome = updated.error.code === "invalid_config" || updated.error.code === "policy_denied" || updated.error.code === "revision_conflict"
						? "rejected"
						: "uncertain";
					if (!awaitSettle(attempt, begun.attemptId, outcome, { operation, code: updated.error.code })) return failed(operation, "attempt_settle_failed");
				}
				return settingsFailure(operation, updated.error.code);
			}
			if (begun === undefined) return ok(operation, options.generation, inspectionValue(updated.value));
			if (!awaitSettle(attempt, begun.attemptId, "committed", { operation, sourceDigest: updated.value.sourceDigest.digest })) {
				return failed(operation, "attempt_settle_failed");
			}
			return ok(operation, options.generation, inspectionValue(updated.value), {
				attemptId: begun.attemptId,
				commandId: begun.commandId,
				outcome: "committed",
			});
		},
	};
}

function scopeOf(value: unknown): SecuritySettingsScope | undefined {
	return value === "user" || value === "workspace" ? value : undefined;
}

function digestOf(value: unknown): RuntimeDigest | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	return record.algorithm === "sha256" && typeof record.digest === "string" && /^[a-f0-9]{64}$/u.test(record.digest)
		? record as unknown as RuntimeDigest
		: undefined;
}

function inspectionValue(value: SecuritySettingsInspection): Record<string, unknown> {
	return {
		scope: value.scope,
		document: value.document,
		sourceDigest: value.sourceDigest,
		appliesTo: "new_sessions",
		editable: true,
	};
}

function ok(
	operation: string,
	domainRevision: number,
	value: Record<string, unknown>,
	receipt?: { readonly attemptId: string; readonly commandId: string; readonly outcome: "committed" },
): SessionDomainResult {
	return { ok: true, status: "ok", operation, domainRevision, value, ...(receipt === undefined ? {} : { receipt }) };
}

function unavailable(operation: string): SessionDomainResult {
	return { ok: false, status: "unavailable", code: "operation_unavailable", operation };
}

function failed(operation: string, code: string): SessionDomainResult {
	return { ok: false, status: "failed", code, operation };
}

function settingsFailure(operation: string, code: string): SessionDomainResult {
	if (code === "revision_conflict") return { ok: false, status: "stale", code, operation };
	if (code === "policy_denied") return { ok: false, status: "denied", code, operation };
	return failed(operation, code);
}

function awaitSettle(
	attempt: AttemptPort | undefined,
	attemptId: Parameters<AttemptPort["settleAttempt"]>[0],
	outcome: Parameters<AttemptPort["settleAttempt"]>[1],
	details: Record<string, unknown>,
): boolean {
	return attempt?.settleAttempt(attemptId, outcome, runtimeDigest(details)).ok !== false;
}
