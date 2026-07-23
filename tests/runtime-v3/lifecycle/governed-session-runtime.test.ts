import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createExternalReceiptAuditReceipt,
	type StartupExternalReceiptAuditPort,
} from "../../../src/runtime/lifecycle/recovery.ts";
import { canonicalDigest } from "../../../src/runtime/protocol/v3/canonical-json.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/v3/ids.ts";
import type { WorkspaceLeaseRef } from "../../../src/runtime/protocol/v3/workspace.ts";
import { DEFAULT_RUNTIME_FEATURES } from "../../../src/runtime/runtime-features.ts";
import { GovernedV3SessionRuntime } from "../../../src/storage/v3-runtime-adapter.ts";
import { V3SessionManager } from "../../../src/storage/v3-session-manager.ts";

const roots: string[] = [];
const features = { ...DEFAULT_RUNTIME_FEATURES, sessionV3: true };

afterEach(async () => {
	vi.restoreAllMocks();
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function rejectedError(operation: Promise<unknown>): Promise<Error> {
	try {
		await operation;
	} catch (cause) {
		if (cause instanceof Error) return cause;
		throw new Error("operation rejected with a non-Error value");
	}
	throw new Error("operation unexpectedly resolved");
}

const unexpectedAuditor: StartupExternalReceiptAuditPort = {
	auditWorkspaceLease: async () => { throw new Error("workspace audit should not run without references"); },
	auditApprovalDecision: async () => { throw new Error("approval audit should not run without references"); },
};

async function createSession(root: string): Promise<{ filePath: string; manager: V3SessionManager }> {
	const manager = await V3SessionManager.create({
		cwd: root,
		sessionDir: join(root, "sessions"),
		features,
	});
	return { filePath: manager.filePath(), manager };
}

describe("GovernedV3SessionRuntime admission", () => {
	it("preserves both startup and writer-close failures when governed open aborts", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-governed-open-cleanup-"));
		roots.push(root);
		const created = await createSession(root);
		await created.manager.closeAll();
		const startupFailure = new Error("injected governed startup failure");
		const cleanupFailure = new Error("injected governed writer close failure");
		const realOpen = V3SessionManager.open.bind(V3SessionManager);
		let opened: V3SessionManager | undefined;
		vi.spyOn(V3SessionManager, "open").mockImplementation(async (...args) => {
			opened = await realOpen(...args);
			vi.spyOn(opened, "reconcileArtifacts").mockRejectedValue(startupFailure);
			const close = opened.closeAll.bind(opened);
			vi.spyOn(opened, "closeAll").mockImplementation(async () => {
				await close();
				throw cleanupFailure;
			});
			return opened;
		});

		const error = await rejectedError(GovernedV3SessionRuntime.open({
			filePath: created.filePath,
			features,
			externalReceiptAuditor: unexpectedAuditor,
		}));

		expect(error).toBeInstanceOf(AggregateError);
		expect((error as AggregateError).errors.map(String).join("\n")).toContain(startupFailure.message);
		expect((error as AggregateError).errors.map(String).join("\n")).toContain(cleanupFailure.message);
		expect(opened?.isClosed()).toBe(true);
	});

	it("runs at most one resumable callback for a governed handle", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-governed-admission-"));
		roots.push(root);
		const created = await V3SessionManager.create({
			cwd: root,
			sessionDir: join(root, "sessions"),
			features,
		});
		const filePath = created.filePath();
		await created.closeAll();

		const governed = await GovernedV3SessionRuntime.open({
			filePath,
			features,
			externalReceiptAuditor: unexpectedAuditor,
		});
		let callbackCalls = 0;
		const first = governed.runIfResumable(async () => {
			callbackCalls += 1;
			await Promise.resolve();
			return "first";
		});
		const second = governed.runIfResumable(async () => {
			callbackCalls += 1;
			return "second";
		});

		expect(await first).toEqual({ ok: true, value: "first" });
		expect(await second).toMatchObject({
			ok: false,
			error: { code: "external_unavailable" },
		});
		expect(callbackCalls).toBe(1);
		await governed.close();
	});

	it("does not let a caller mutate the reported paused disposition into admission", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-governed-report-copy-"));
		roots.push(root);
		const created = await createSession(root);
		await created.manager.closeAll();
		const controller = new AbortController();
		controller.abort("pause governed startup before external references");
		const governed = await GovernedV3SessionRuntime.open({
			filePath: created.filePath,
			features,
			externalReceiptAuditor: unexpectedAuditor,
			signal: controller.signal,
		});
		try {
			const exposed = governed.startupReport();
			expect(exposed.sessions[0]).toMatchObject({ disposition: "paused" });
			const exposedSession = exposed.sessions[0];
			if (!exposedSession) throw new Error("governed report has no session");
			exposedSession.disposition = "resumable";
			exposedSession.reasons = [];
			let callbackCalls = 0;
			const admitted = await governed.runIfResumable(async () => {
				callbackCalls += 1;
			});
			expect(admitted).toMatchObject({ ok: false, error: { code: "external_unavailable" } });
			expect(callbackCalls).toBe(0);
			expect(governed.startupReport().sessions[0]).toMatchObject({ disposition: "paused" });
		} finally {
			await governed.close();
		}
	});

	it("rechecks audit validity horizons when admission is claimed", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-governed-valid-through-"));
		roots.push(root);
		const created = await createSession(root);
		const identity = created.manager.identity();
		const lease: WorkspaceLeaseRef = {
			authorityId: identity.authorityId,
			tenantId: identity.tenantId,
			principalId: identity.principalId,
			leaseId: createRuntimeId("lease", "governed-valid-through"),
			workspaceId: createRuntimeId("workspace", "governed-valid-through"),
			ownerRuntimeId: created.manager.runtimeId(),
			leaseRevision: 1,
			fencingTokenDigest: canonicalDigest({ fixture: "governed-valid-through" }),
			state: "active",
		};
		const appended = await created.manager.writer().append({
			type: "lease.acquired",
			principalId: identity.principalId,
			traceId: createRuntimeId("trace", "governed-valid-through"),
			payload: {
				lease,
				receiptId: createRuntimeId("receipt", "governed-valid-through"),
			},
		});
		if (!appended.ok) throw new Error(appended.error.message);
		await created.manager.closeAll();
		let now = new Date("2026-07-23T00:00:00.000Z");
		const auditor: StartupExternalReceiptAuditPort = {
			auditWorkspaceLease: async (sessionId, candidate) => ({
				ok: true,
				value: createExternalReceiptAuditReceipt({
					authorityId: candidate.authorityId,
					tenantId: candidate.tenantId,
					sessionId,
					subjectKind: "workspace_lease",
					subjectId: candidate.leaseId,
					subjectDigest: canonicalDigest(candidate),
					authoritativeDigest: canonicalDigest(candidate),
					observedRevision: candidate.leaseRevision,
					status: "valid",
					outcomeReason: "exact_match",
					checkedAt: now.toISOString(),
					validThrough: "2026-07-23T00:01:00.000Z",
				}),
			}),
			auditApprovalDecision: async () => {
				throw new Error("approval audit is outside this fixture");
			},
		};
		const governed = await GovernedV3SessionRuntime.open({
			filePath: created.filePath,
			features,
			externalReceiptAuditor: auditor,
			clock: () => now,
		});
		try {
			expect(governed.startupReport().sessions[0]).toMatchObject({ disposition: "resumable" });
			now = new Date("2026-07-23T00:01:01.000Z");
			let callbackCalls = 0;
			const admitted = await governed.runIfResumable(async () => {
				callbackCalls += 1;
			});
			expect(admitted).toMatchObject({ ok: false, error: { code: "external_unavailable" } });
			expect(callbackCalls).toBe(0);
		} finally {
			await governed.close();
		}
	});
});
