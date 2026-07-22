import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { main } from "../../src/cli/main.ts";
import {
	createExternalReceiptAuditReceipt,
	type ExternalReceiptAuditReceipt,
	type LifecycleResult,
	type StartupExternalReceiptAuditPort,
} from "../../src/runtime/lifecycle/recovery.ts";
import { canonicalDigest } from "../../src/runtime/protocol/v3/canonical-json.ts";
import { createRuntimeId } from "../../src/runtime/protocol/v3/ids.ts";
import {
	workspaceBindingDigest,
	type WorkspaceBindingRef,
	type WorkspaceLeaseRef,
} from "../../src/runtime/protocol/v3/workspace.ts";
import { DEFAULT_RUNTIME_FEATURES } from "../../src/runtime/runtime-features.ts";
import { saveProjectSettings } from "../../src/storage/settings-manager.ts";
import { V3SessionManager } from "../../src/storage/v3-session-manager.ts";

const surfaceCalls = vi.hoisted(() => ({ constructed: 0, run: 0 }));

vi.mock("../../src/tui/interactive-mode.ts", () => ({
	InteractiveMode: class {
		public constructor() { surfaceCalls.constructed += 1; }
		public async run(): Promise<void> { surfaceCalls.run += 1; }
	},
}));

const DIGEST = "a".repeat(64);
const roots: string[] = [];
const managers: V3SessionManager[] = [];
const originalCwd = process.cwd();

afterEach(async () => {
	process.chdir(originalCwd);
	surfaceCalls.constructed = 0;
	surfaceCalls.run = 0;
	await Promise.all(managers.splice(0).map((manager) => manager.closeAll().catch(() => undefined)));
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function invalidAudit(
	sessionId: ReturnType<typeof createRuntimeId<"session">>,
	lease: WorkspaceLeaseRef,
): LifecycleResult<ExternalReceiptAuditReceipt> {
	return {
		ok: true,
		value: createExternalReceiptAuditReceipt({
			authorityId: lease.authorityId,
			tenantId: lease.tenantId,
			sessionId,
			subjectKind: "workspace_lease",
			subjectId: lease.leaseId,
			subjectDigest: canonicalDigest(lease),
			authoritativeDigest: canonicalDigest({ ...lease, state: "revoked" }),
			observedRevision: lease.leaseRevision + 1,
			status: "invalid",
			outcomeReason: "revoked",
			checkedAt: "2026-07-23T00:00:00.000Z",
			validThrough: null,
		}),
	};
}

describe("CLI governed startup receipt gate", () => {
	it("rejects a locally resumable V3 session before controller, model, or tool composition when its lease is invalid", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-cli-startup-gate-"));
		roots.push(root);
		process.chdir(root);
		const features = { ...DEFAULT_RUNTIME_FEATURES, sessionV3: true };
		await saveProjectSettings(root, {
			sessionV3FeatureState: "default",
			runtimeFeatures: features,
		});
		const manager = await V3SessionManager.create({
			cwd: root,
			sessionDir: join(root, ".runledger", "sessions"),
			features,
		});
		const identity = manager.identity();
		const workspaceId = createRuntimeId("workspace", "cli-startup-gate");
		const binding: WorkspaceBindingRef = {
			authorityId: identity.authorityId,
			tenantId: identity.tenantId,
			workspaceId,
			repositoryId: createRuntimeId("repository", "cli-startup-gate"),
			bindingKind: "source",
			canonicalCwd: root,
			effectiveCwd: root,
			branch: "main",
			baseCommit: "1".repeat(40),
			headCommit: "1".repeat(40),
		};
		const lease: WorkspaceLeaseRef = {
			authorityId: identity.authorityId,
			tenantId: identity.tenantId,
			principalId: identity.principalId,
			leaseId: createRuntimeId("lease", "cli-startup-gate"),
			workspaceId,
			ownerRuntimeId: manager.runtimeId(),
			leaseRevision: 1,
			fencingTokenDigest: DIGEST,
			state: "active",
		};
		const appended = await manager.writer().append({
			type: "workspace.bound",
			principalId: identity.principalId,
			traceId: createRuntimeId("trace", "cli-startup-gate"),
			payload: { binding, bindingDigest: workspaceBindingDigest(binding), lease },
		});
		if (!appended.ok) throw new Error(appended.error.message);
		const filePath = manager.filePath();
		await manager.closeAll();

		const auditor: StartupExternalReceiptAuditPort = {
			auditWorkspaceLease: async (sessionId, candidate) => invalidAudit(sessionId, candidate),
			auditApprovalDecision: async () => ({
				ok: false,
				error: { code: "external_unavailable", message: "unexpected approval audit", retryable: false },
			}),
		};

		await expect(main(["--session", filePath], {
			startupExternalReceiptAuditor: auditor,
		})).rejects.toThrow(/external receipt|governed startup|not approved/u);
		expect(surfaceCalls).toEqual({ constructed: 0, run: 0 });

		const reopened = await V3SessionManager.open(filePath, features);
		managers.push(reopened);
		expect(reopened.recoveryDecision()).toMatchObject({ kind: "resume" });
	});
});
