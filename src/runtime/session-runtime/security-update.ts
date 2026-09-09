import { builtinPermissionPresets } from "../../security/config/presets.ts";
import { parseSecurityConfigDocument } from "../../security/config/schema.ts";
import { permissionConfigurationDigest } from "../../security/composition/permission-versions.ts";
import type { SessionSecurityComposition } from "../../security/session-composition.ts";
import type { SecuritySettingsInspection } from "../../storage/security-settings-port.ts";
import { runtimeDigest } from "../protocol/foundation.ts";
import type { AttemptPort, AttemptPortBeginResult } from "./attempt-gateway.ts";
import type { SessionDomainMutationContext, SessionDomainResult } from "./domain-router.ts";
import type { SecuritySettingsPort } from "./security-settings-domain.ts";
import type { PermissionUpdateJournal, PermissionUpdateRecord } from "./security-update-journal.ts";

export interface SessionPermissionUpdater {
	apply(payload: Record<string, unknown>, context: SessionDomainMutationContext): Promise<SessionDomainResult>;
}

const OPERATION = "session.security.apply";

export function createSessionPermissionUpdater(options: {
	readonly generation: number;
	readonly security: SessionSecurityComposition;
	readonly settings: SecuritySettingsPort;
	readonly journal: PermissionUpdateJournal;
	readonly attemptPort?: () => AttemptPort | undefined;
}): SessionPermissionUpdater {
	let applying = false;
	return {
		apply: async (payload, context) => {
			if (context.expectedRevision !== options.generation) return fail("generation_mismatch", "stale");
			if (options.security.applicationState === "recovery_required") return fail("permission_update_requires_recovery", "recovery_required");
			if (payload.scope !== "user") return fail("permission_apply_requires_user_scope");
			const document = parseSecurityConfigDocument(payload.document);
			const requested = document.ok ? builtinPermissionPresets().find((preset) => preset.id === document.value.profile) : undefined;
			if (!document.ok || requested === undefined) return fail("invalid_permission_preset");
			if (!Number.isSafeInteger(payload.expectedSecurityRevision) || Number(payload.expectedSecurityRevision) < 1) return fail("security_revision_required");
			const updateId = runtimeDigest({ generation: options.generation, effectId: context.effectId, correlationId: context.correlationId }).digest;
			const inputDigest = runtimeDigest(payload);
			let previous: PermissionUpdateRecord | undefined;
			try { previous = options.journal.records().filter((record) => record.updateId === updateId).at(-1); }
			catch { return fail("permission_journal_unavailable", "recovery_required"); }
			if (previous !== undefined) {
				if (previous.inputDigest.digest !== inputDigest.digest) return fail("permission_update_binding_changed", "stale");
				if (previous.stage === "applied") {
					const saved = await options.settings.inspect({ scope: "user" });
					return saved.ok ? success(saved.value, previous.toRevision) : fail("settings_unavailable");
				}
				return fail(previous.stage === "prepared" ? "permission_update_requires_recovery" : "permission_update_not_committed", "recovery_required");
			}
			if (applying) return fail("security_update_in_progress", "stale");
			const availability = requested.availability(options.security.snapshot.managedConstraints, options.security.sandboxCapability);
			if (availability.state !== "available") return fail("permission_preset_unavailable", "denied");
			applying = true;
			try {
				const saved = await options.settings.inspect({ scope: "user" });
				if (!saved.ok) return fail(saved.error.code);
				if (runtimeDigest(payload.expectedSourceDigest).digest !== runtimeDigest(saved.value.sourceDigest).digest) return fail("revision_conflict", "stale");
				const oldSnapshot = options.security.snapshot;
				const prepared = await options.security.prepareUpdate(document.value, Number(payload.expectedSecurityRevision));
				if (!prepared.ok) return fail(prepared.error.code, prepared.error.code === "revision_conflict" ? "stale" : prepared.error.code === "policy_denied" ? "denied" : "failed");
				const candidate = prepared.value;
				const record: PermissionUpdateRecord = {
					stage: "prepared", updateId, inputDigest,
					fromRevision: oldSnapshot.securityRevision!, toRevision: candidate.snapshot.securityRevision!,
					previousPolicyDigest: oldSnapshot.policyDigest, policyDigest: candidate.snapshot.policyDigest,
					configurationDigest: permissionConfigurationDigest(candidate.snapshot),
					previousSourceDigest: saved.value.sourceDigest, sourceDigest: runtimeDigest(document.value),
					profile: candidate.snapshot.profile.name,
				};
				let attempt: AttemptPort | undefined;
				let begun: AttemptPortBeginResult | undefined;
				try {
					attempt = options.attemptPort?.();
					begun = attempt?.beginAttempt("external_mutation", runtimeDigest({ operation: OPERATION, updateId, inputDigest }));
				} catch {
					candidate.block();
					return fail("permission_attempt_unavailable", "recovery_required");
				}
				if (begun !== undefined && !("attemptId" in begun)) {
					await candidate.discard();
					return fail("permission_attempt_unavailable", "recovery_required");
				}
				let wroteSettings = false;
				let attemptedWrite = false;
				try {
					options.journal.append(record);
					attemptedWrite = true;
					const updated = await options.settings.update({ scope: "user", expectedSourceDigest: saved.value.sourceDigest, document: document.value });
					if (!updated.ok) {
						// rename 已成功但后续文件操作失败时，不能把跨存储部分保存当作未修改。
						const observed = await options.settings.inspect({ scope: "user" });
						if (!observed.ok || observed.value.sourceDigest.digest !== saved.value.sourceDigest.digest) {
							wroteSettings = true;
							throw new Error("permission settings outcome is uncertain");
						}
						options.journal.append({ ...record, stage: "rejected" });
						if (begun !== undefined && attempt?.settleAttempt(begun.attemptId, "rejected", runtimeDigest({ code: updated.error.code })).ok === false) {
							candidate.block();
							return fail("permission_attempt_settle_failed", "recovery_required");
						}
						await candidate.discard();
						return fail(updated.error.code, updated.error.code === "revision_conflict" ? "stale" : "failed");
					}
					wroteSettings = true;
					if (!(await candidate.verifySaved())) throw new Error("security source changed before publication");
					if (begun !== undefined && attempt?.settleAttempt(begun.attemptId, "committed", runtimeDigest({ updateId, revision: record.toRevision })).ok === false) throw new Error("permission attempt settlement failed");
					options.journal.append({ ...record, stage: "applied" });
					candidate.publish();
					return success(updated.value, record.toRevision);
				} catch {
					candidate.block();
					if (attemptedWrite && !wroteSettings) {
						try {
							const observed = await options.settings.inspect({ scope: "user" });
							wroteSettings = !observed.ok || observed.value.sourceDigest.digest !== saved.value.sourceDigest.digest;
						} catch { wroteSettings = true; }
					}
					try {
						if (begun !== undefined) attempt?.settleAttempt(begun.attemptId, "uncertain", runtimeDigest({ updateId, wroteSettings }));
					} catch { /* admission 已封闭，接管者通过持久 attempt 与 intent 恢复。 */ }
					return fail(wroteSettings ? "permissions_saved_not_applied" : "permission_update_requires_recovery", "recovery_required");
				}
			} catch {
				return fail("permission_update_requires_recovery", "recovery_required");
			} finally { applying = false; }
		}
	};

	function success(saved: SecuritySettingsInspection, appliedRevision: number): SessionDomainResult {
		return {
			ok: true, status: "ok", operation: OPERATION, domainRevision: options.generation, value: {
				...saved, appliesTo: "current_and_new_sessions", appliedRevision,
				securityRevision: options.security.snapshot.securityRevision,
				effectiveProfile: options.security.snapshot.profile.name,
				policyDigest: options.security.snapshot.policyDigest,
			}
		};
	}
}

function fail(code: string, status: "failed" | "stale" | "denied" | "recovery_required" = "failed"): SessionDomainResult {
	return { ok: false, status, operation: OPERATION, code };
}

/** 接管仅核对持久绑定；不会重放工具，也不根据未知配置猜测未完成更新。 */
export async function recoverPermissionUpdates(options: {
	readonly security: SessionSecurityComposition;
	readonly settings: SecuritySettingsPort;
	readonly journal: PermissionUpdateJournal;
}): Promise<void> {
	const latest = new Map(options.journal.records().map((record) => [record.updateId, record]));
	for (const record of latest.values()) {
		if (record.stage !== "prepared") continue;
		const saved = await options.settings.inspect({ scope: "user" });
		if (!saved.ok) throw new Error("permission update recovery cannot read settings");
		if (saved.value.sourceDigest.digest === record.previousSourceDigest.digest) {
			options.journal.append({ ...record, stage: "abandoned" });
		} else if (saved.value.sourceDigest.digest === record.sourceDigest.digest && permissionConfigurationDigest(options.security.snapshot).digest === record.configurationDigest.digest) {
			options.journal.append({ ...record, stage: "recovered" });
		} else throw new Error("permission update recovery requires resolving a security source conflict");
	}
}
