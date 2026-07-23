import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { startLocalV3Daemon } from "../../src/daemon/local-v3-daemon.ts";
import { createLocalIdentityContext } from "../../src/runtime/identity/local-principal.ts";
import {
	createExternalReceiptAuditReceipt,
	type StartupExternalReceiptAuditPort,
} from "../../src/runtime/lifecycle/recovery.ts";
import { canonicalDigest } from "../../src/runtime/protocol/v3/canonical-json.ts";
import { createRuntimeId } from "../../src/runtime/protocol/v3/ids.ts";
import type { WorkspaceLeaseRef } from "../../src/runtime/protocol/v3/workspace.ts";
import type { RuntimeFeatureFlags } from "../../src/runtime/runtime-features.ts";
import { V3SessionManager } from "../../src/storage/v3-session-manager.ts";

const FEATURES: RuntimeFeatureFlags = {
	sessionV3: true,
	workspaceContracts: true,
	securityContracts: true,
	workspaceGuard: true,
	capabilityGateway: true,
	sandboxEnforcement: true,
	artifactCas: true,
	resourceContracts: true,
	planContextMemoryContracts: true,
	orchestrator: true,
	verification: true,
	daemon: true,
};

describe("local daemon startup external receipt gate", () => {
	it("passes the configured auditor into cold recovery and rejects an invalid active lease", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-daemon-startup-receipt-"));
		const sessionDir = join(root, "sessions");
		const identity = createLocalIdentityContext();
		let unexpectedDaemon: Awaited<ReturnType<typeof startLocalV3Daemon>> | undefined;
		try {
			const manager = await V3SessionManager.create({
				cwd: root,
				sessionDir,
				features: FEATURES,
				identity,
				runtimeId: createRuntimeId("runtime", "daemon-startup-receipt-fixture"),
			});
			const lease: WorkspaceLeaseRef = {
				authorityId: identity.authorityId,
				tenantId: identity.tenantId,
				principalId: identity.principalId,
				leaseId: createRuntimeId("lease", "daemon-startup-receipt"),
				workspaceId: createRuntimeId("workspace", "daemon-startup-receipt"),
				ownerRuntimeId: manager.runtimeId(),
				leaseRevision: 1,
				fencingTokenDigest: canonicalDigest({ fixture: "daemon-startup-receipt" }),
				state: "active",
			};
			const appended = await manager.writer().append({
				type: "lease.acquired",
				principalId: identity.principalId,
				traceId: createRuntimeId("trace", "daemon-startup-receipt"),
				payload: {
					lease,
					receiptId: createRuntimeId("receipt", "daemon-startup-receipt-acquired"),
				},
			});
			if (!appended.ok) throw new Error(appended.error.message);
			const filePath = manager.filePath();
			const sessionId = manager.sessionId();
			await manager.closeAll();

			let auditCalls = 0;
			const auditor: StartupExternalReceiptAuditPort = {
				auditWorkspaceLease: async (candidateSessionId, candidateLease) => {
					auditCalls += 1;
					return {
						ok: true,
						value: createExternalReceiptAuditReceipt({
							authorityId: candidateLease.authorityId,
							tenantId: candidateLease.tenantId,
							sessionId: candidateSessionId,
							subjectKind: "workspace_lease",
							subjectId: candidateLease.leaseId,
							subjectDigest: canonicalDigest(candidateLease),
							authoritativeDigest: canonicalDigest({ ...candidateLease, state: "revoked" }),
							observedRevision: candidateLease.leaseRevision,
							status: "invalid",
							outcomeReason: "revoked",
							checkedAt: new Date().toISOString(),
							validThrough: null,
						}),
					};
				},
				auditApprovalDecision: async () => {
					throw new Error("approval audit is outside this fixture");
				},
			};

			const started = await startLocalV3Daemon({
				cwd: root,
				sessionDir,
				features: FEATURES,
				identity,
				authorityStateDirectory: join(root, "authority"),
				shutdownTimeoutMs: 1_000,
				startupExternalReceiptAuditor: auditor,
				startupExternalReceiptAuditTimeoutMs: 1_000,
			});
			unexpectedDaemon = started;
			expect(started).toMatchObject({
				ok: false,
				error: { code: "recovery_required" },
			});
			expect(auditCalls).toBe(1);

			const reopened = await V3SessionManager.open(
				filePath,
				FEATURES,
				identity,
				{ reconcileArtifacts: false },
			);
			try {
				expect(reopened.sessionId()).toBe(sessionId);
				expect(reopened.recoveryDecision()).toMatchObject({ kind: "resume" });
			} finally {
				await reopened.closeAll();
			}
		} finally {
			if (unexpectedDaemon?.ok) {
				await unexpectedDaemon.value.composition.shutdown.begin(1_000);
				await unexpectedDaemon.value.authorityRuntime.close().catch(() => undefined);
			}
			await rm(root, { recursive: true, force: true });
		}
	});
});
