import { runtimeDigest } from "../../protocol/foundation.ts";
import type { AttemptId, PrincipalId } from "../../protocol/ids.ts";
import type { RecoveryDecision } from "../recovery-barrier.ts";
import type { SessionCommandPort, SessionCommandRouteTable } from "../command-routes.ts";

export function createRecoveryCommandRoutes(port: SessionCommandPort): Pick<SessionCommandRouteTable, "recovery_explain" | "recovery_assess" | "recovery_verify" | "recovery_abort" | "recovery_resume"> {
	return {
		recovery_explain: async () => ({
			ok: true,
			kind: "recovery_explain",
			result: {
				state: port.state(),
				barrierState: port.barrier.currentState,
				unresolvedAttempts: port.barrier.unresolvedAttempts().map((receipt) => ({
					attemptId: receipt.attemptId,
					commandId: receipt.commandId,
					effectClass: receipt.effectClass,
					outcome: receipt.outcome,
					originGeneration: receipt.originGeneration,
				})),
				sideEffectSpawnCount: port.barrier.sideEffectSpawnCount,
			},
		}),
		recovery_assess: async () => {
			port.recoveryAssess();
			return { ok: true, kind: "recovery_assess", result: { state: port.state(), unresolvedRemaining: port.unresolvedAttemptsCount() } };
		},
		recovery_verify: async (request) => {
			const decision = request.body as Partial<RecoveryDecision> & { kind: "verify" };
			if (typeof decision.attemptId !== "string") return { ok: false, code: "invalid_input" };
			const result = port.recoveryDecide({
				kind: "verify",
				attemptId: decision.attemptId as AttemptId,
				outcome: decision.outcome === "verified_clean" ? "verified_clean" : "settled",
				evidenceDigest: decision.evidenceDigest,
			});
			if (!result.ok) return { ok: false, code: result.code ?? "recovery_verify_failed" };
			return { ok: true, kind: "recovery_verify", result: { state: result.state } };
		},
		recovery_abort: async (request) => {
			const reasonCode = typeof request.body.reasonCode === "string" ? request.body.reasonCode : "operator-abort";
			port.recoveryDecide({ kind: "abort", reasonCode });
			return { ok: true, kind: "recovery_abort", result: { state: port.state() } };
		},
		recovery_resume: async (request) => {
			const principalId = (typeof request.body.principalId === "string" ? request.body.principalId : "principal_operator") as PrincipalId;
			const result = port.recoveryDecide({
				kind: "resume_despite_uncertainty",
				principalId,
				reasonCode: typeof request.body.reasonCode === "string" ? request.body.reasonCode : "user-accepted-uncertainty",
				originGeneration: port.fence.generation,
				settledGeneration: port.fence.generation,
				evidenceDigest: runtimeDigest({ resume: String(request.body.reasonCode ?? "") }),
			});
			if (!result.ok) return { ok: false, code: result.code ?? "recovery_resume_failed" };
			return { ok: true, kind: "recovery_resume", result: { state: result.state } };
		},
	};
}
