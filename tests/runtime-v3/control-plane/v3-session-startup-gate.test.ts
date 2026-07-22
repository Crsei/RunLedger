import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	DirectoryV3SessionLocator,
	V3SessionRuntimeFactoryAdapter,
	type V3CandidateAuthorityBindingPort,
} from "../../../src/daemon/v3-session-adapters.ts";
import type { ControlPlaneResult } from "../../../src/runtime/control-plane/errors.ts";
import type {
	CandidateAuthorityBinding,
	ManagedSessionRuntime,
} from "../../../src/runtime/control-plane/session-registry.ts";
import {
	DaemonAgentSessionRuntimeFactoryDecorator,
	DaemonOwnedAgentRuntime,
} from "../../../src/runtime/integration/daemon-agent-runtime.ts";
import type {
	DaemonAgentSessionBindingFactoryPort,
	DaemonAgentSessionBindingPort,
} from "../../../src/runtime/integration/daemon-agent-session.ts";
import {
	createExternalReceiptAuditReceipt,
	type ExternalReceiptAuditReceipt,
	type LifecycleResult,
	type StartupExternalReceiptAuditPort,
} from "../../../src/runtime/lifecycle/recovery.ts";
import type { ApprovalReceiptRef } from "../../../src/runtime/protocol/v3/capability.ts";
import { canonicalDigest } from "../../../src/runtime/protocol/v3/canonical-json.ts";
import type { EventCursor } from "../../../src/runtime/protocol/v3/events.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/v3/ids.ts";
import type { RuntimeIdentityContext } from "../../../src/runtime/identity/types.ts";
import type { DurableQueueReceipt } from "../../../src/runtime/session/agent-loop-events.ts";
import type { SessionResult } from "../../../src/runtime/session/types.ts";
import type { WorkspaceLeaseRef } from "../../../src/runtime/protocol/v3/workspace.ts";
import { workspaceBindingDigest } from "../../../src/runtime/protocol/v3/workspace.ts";
import { DEFAULT_RUNTIME_FEATURES, type RuntimeFeatureFlags } from "../../../src/runtime/runtime-features.ts";
import { V3SessionManager } from "../../../src/storage/v3-session-manager.ts";

const IDENTITY: RuntimeIdentityContext = {
	authorityId: createRuntimeId("authority", "startup-gate"),
	tenantId: createRuntimeId("tenant", "startup-gate"),
	principalId: createRuntimeId("principal", "startup-gate"),
	source: "managed",
	issuedAt: "2026-07-23T00:00:00.000Z",
};
const FEATURES: RuntimeFeatureFlags = { ...DEFAULT_RUNTIME_FEATURES, sessionV3: true };
const roots: string[] = [];

function value<T>(result: SessionResult<T>): T {
	if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
	return result.value;
}

async function fixture(): Promise<{
	root: string;
	sessionDir: string;
	filePath: string;
	sessionId: ReturnType<typeof createRuntimeId<"session">>;
	parentCursor: EventCursor;
}> {
	const root = await mkdtemp(join(tmpdir(), "runledger-v3-startup-gate-"));
	roots.push(root);
	const sessionDir = join(root, "sessions");
	const manager = await V3SessionManager.create({
		cwd: root,
		sessionDir,
		features: FEATURES,
		identity: IDENTITY,
		runtimeId: createRuntimeId("runtime", "startup-gate-fixture"),
	});
	const workspaceId = createRuntimeId("workspace", "startup-gate");
	const lease: WorkspaceLeaseRef = {
		authorityId: IDENTITY.authorityId,
		tenantId: IDENTITY.tenantId,
		principalId: IDENTITY.principalId,
		leaseId: createRuntimeId("lease", "startup-gate"),
		workspaceId,
		ownerRuntimeId: manager.runtimeId(),
		leaseRevision: 1,
		fencingTokenDigest: canonicalDigest({ fixture: "startup-gate-workspace-lease" }),
		state: "active",
	};
	const binding = {
		authorityId: IDENTITY.authorityId,
		tenantId: IDENTITY.tenantId,
		workspaceId,
		repositoryId: createRuntimeId("repository", "startup-gate"),
		bindingKind: "source" as const,
		canonicalCwd: join(root, "worktree"),
		effectiveCwd: join(root, "worktree"),
		branch: "worktree/startup-gate",
		baseCommit: "1".repeat(40),
		headCommit: "2".repeat(40),
	};
	value(await manager.writer().append({
		type: "workspace.bound",
		principalId: IDENTITY.principalId,
		traceId: createRuntimeId("trace", "startup-gate-workspace"),
		payload: {
			binding,
			bindingDigest: workspaceBindingDigest(binding),
			lease,
		},
	}));
	const parentCursor = manager.writer().currentHead();
	if (!parentCursor) throw new Error("startup-gate fixture has no durable parent cursor");
	const filePath = manager.filePath();
	const sessionId = manager.sessionId();
	await manager.closeAll();
	return { root, sessionDir, filePath, sessionId, parentCursor };
}

type AuditMode = "valid" | "invalid" | "unavailable" | "throw";

class RecordingAuditor implements StartupExternalReceiptAuditPort {
	public calls = 0;
	#mode: AuditMode;
	readonly #order: string[];

	public constructor(mode: AuditMode, order: string[]) {
		this.#mode = mode;
		this.#order = order;
	}

	public setMode(mode: AuditMode): void {
		this.#mode = mode;
	}

	public async auditWorkspaceLease(
		sessionId: ReturnType<typeof createRuntimeId<"session">>,
		lease: WorkspaceLeaseRef,
	): Promise<LifecycleResult<ExternalReceiptAuditReceipt>> {
		this.calls += 1;
		this.#order.push("audit");
		if (this.#mode === "throw") throw new Error("startup auditor unavailable");
		const subjectDigest = canonicalDigest(lease);
		const base = {
			authorityId: lease.authorityId,
			tenantId: lease.tenantId,
			sessionId,
			subjectKind: "workspace_lease" as const,
			subjectId: lease.leaseId,
			subjectDigest,
			checkedAt: "2026-07-23T00:00:01.000Z",
			validThrough: null,
		};
		if (this.#mode === "valid") {
			return {
				ok: true,
				value: createExternalReceiptAuditReceipt({
					...base,
					authoritativeDigest: subjectDigest,
					observedRevision: lease.leaseRevision,
					status: "valid",
					outcomeReason: "exact_match",
				}),
			};
		}
		if (this.#mode === "invalid") {
			return {
				ok: true,
				value: createExternalReceiptAuditReceipt({
					...base,
					authoritativeDigest: canonicalDigest({ ...lease, state: "revoked" }),
					observedRevision: lease.leaseRevision + 1,
					status: "invalid",
					outcomeReason: "revoked",
				}),
			};
		}
		return {
			ok: true,
			value: createExternalReceiptAuditReceipt({
				...base,
				status: "unavailable",
				outcomeReason: "store_unavailable",
			}),
		};
	}

	public auditApprovalDecision(
		_sessionId: ReturnType<typeof createRuntimeId<"session">>,
		_receipt: ApprovalReceiptRef,
	): Promise<LifecycleResult<ExternalReceiptAuditReceipt>> {
		throw new Error("approval audit is not part of this fixture");
	}
}

class RecordingCandidateAuthority implements V3CandidateAuthorityBindingPort {
	public calls = 0;
	readonly #order: string[];

	public constructor(order: string[]) {
		this.#order = order;
	}

	public bind(manager: V3SessionManager): Promise<ControlPlaneResult<CandidateAuthorityBinding>> {
		this.calls += 1;
		this.#order.push("candidateAuthority");
		const fence = manager.writerFenceReceipt();
		return Promise.resolve({
			ok: true,
			value: {
				runtimeId: manager.runtimeId(),
				generation: 1,
				compositionReceiptId: createRuntimeId("compositionReceipt", "startup-gate"),
				compositionDigest: canonicalDigest({ fixture: "startup-gate-composition" }),
				fencingIntentDigest: canonicalDigest({
					runtimeId: manager.runtimeId(),
					fencingReceiptId: fence.receiptId,
					fencingReceiptDigest: fence.receiptDigest,
				}),
			},
		});
	}
}

class RecordingAgentBinding implements DaemonAgentSessionBindingPort {
	public readonly sessionId: ReturnType<typeof createRuntimeId<"session">>;
	public readonly manager: V3SessionManager;

	public constructor(manager: V3SessionManager) {
		this.manager = manager;
		this.sessionId = manager.sessionId();
	}

	public preflightPrompt(): Promise<void> {
		return Promise.resolve();
	}

	public acceptPrompt(
		_commandId: string,
		_text: string,
		_behavior: "start" | "steer" | "followUp",
		_receipt: DurableQueueReceipt,
	): never {
		throw new Error("prompt execution is outside the startup-gate fixture");
	}

	public interrupt(): void {}
	public waitForIdle(): Promise<void> { return Promise.resolve(); }
	public close(): Promise<void> { return Promise.resolve(); }
}

class RecordingAgentBindingFactory implements DaemonAgentSessionBindingFactoryPort {
	public calls = 0;
	readonly #order: string[];

	public constructor(order: string[]) {
		this.#order = order;
	}

	public create(manager: V3SessionManager): Promise<DaemonAgentSessionBindingPort> {
		this.calls += 1;
		this.#order.push("agentBind");
		return Promise.resolve(new RecordingAgentBinding(manager));
	}
}

function composedFactory(options: {
	root: string;
	sessionDir: string;
	auditor: StartupExternalReceiptAuditPort;
	candidateAuthority: V3CandidateAuthorityBindingPort;
	agentBindings: DaemonAgentSessionBindingFactoryPort;
}) {
	const locator = new DirectoryV3SessionLocator({ cwd: options.root, sessionDir: options.sessionDir });
	const sessions = new V3SessionRuntimeFactoryAdapter({
		cwd: options.root,
		sessionDir: options.sessionDir,
		features: FEATURES,
		identity: IDENTITY,
		locator,
		candidateAuthority: options.candidateAuthority,
		externalReceiptAuditor: options.auditor,
		externalReceiptAuditTimeoutMs: 1_000,
	});
	const agents = new DaemonOwnedAgentRuntime({ sessions: options.agentBindings });
	return {
		locator,
		sessions,
		factory: new DaemonAgentSessionRuntimeFactoryDecorator(sessions, agents),
	};
}

async function cleanupUnexpectedSuccess(result: ControlPlaneResult<ManagedSessionRuntime>): Promise<void> {
	if (result.ok) await result.value.teardown("shutdown");
}

afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("V3 session production startup gate", () => {
	it.each(["invalid", "unavailable", "throw"] as const)(
		"rejects %s workspace audit before authority or Agent composition and releases the candidate lease",
		async (mode) => {
			const session = await fixture();
			const order: string[] = [];
			const auditor = new RecordingAuditor(mode, order);
			const candidateAuthority = new RecordingCandidateAuthority(order);
			const agentBindings = new RecordingAgentBindingFactory(order);
			const composed = composedFactory({
				root: session.root,
				sessionDir: session.sessionDir,
				auditor,
				candidateAuthority,
				agentBindings,
			});

			const resumed = await composed.factory.resume(session.sessionId);
			expect.soft(resumed).toMatchObject({
				ok: false,
				error: { code: "recovery_required" },
			});
			expect.soft(auditor.calls).toBe(1);
			expect.soft(candidateAuthority.calls).toBe(0);
			expect.soft(agentBindings.calls).toBe(0);
			expect.soft(order).toEqual(["audit"]);
			expect.soft(composed.sessions.activeRuntime(session.sessionId)).toBeUndefined();
			await cleanupUnexpectedSuccess(resumed);

			const reopened = await V3SessionManager.open(
				session.filePath,
				FEATURES,
				IDENTITY,
				{ reconcileArtifacts: false },
			);
			expect(reopened.recoveryDecision()).toMatchObject({ kind: "resume" });
			await reopened.closeAll();
		},
	);

	it("orders a valid audit before candidate authority binding and Agent composition exactly once", async () => {
		const session = await fixture();
		const order: string[] = [];
		const auditor = new RecordingAuditor("valid", order);
		const candidateAuthority = new RecordingCandidateAuthority(order);
		const agentBindings = new RecordingAgentBindingFactory(order);
		const composed = composedFactory({
			root: session.root,
			sessionDir: session.sessionDir,
			auditor,
			candidateAuthority,
			agentBindings,
		});

		const resumed = await composed.factory.resume(session.sessionId);
		expect.soft(resumed).toMatchObject({ ok: true, value: { sessionId: session.sessionId } });
		expect.soft(order).toEqual(["audit", "candidateAuthority", "agentBind"]);
		expect.soft(auditor.calls).toBe(1);
		expect.soft(candidateAuthority.calls).toBe(1);
		expect.soft(agentBindings.calls).toBe(1);
		await cleanupUnexpectedSuccess(resumed);
	});

	it("audits an inactive fork parent before creating or binding a child runtime", async () => {
		const session = await fixture();
		const order: string[] = [];
		const auditor = new RecordingAuditor("invalid", order);
		const candidateAuthority = new RecordingCandidateAuthority(order);
		const agentBindings = new RecordingAgentBindingFactory(order);
		const composed = composedFactory({
			root: session.root,
			sessionDir: session.sessionDir,
			auditor,
			candidateAuthority,
			agentBindings,
		});

		const forked = await composed.factory.fork(
			session.sessionId,
			session.parentCursor,
			"continue_existing_goal",
		);
		expect.soft(forked).toMatchObject({
			ok: false,
			error: { code: "recovery_required" },
		});
		expect.soft(order).toEqual(["audit"]);
		expect.soft(auditor.calls).toBe(1);
		expect.soft(candidateAuthority.calls).toBe(0);
		expect.soft(agentBindings.calls).toBe(0);
		await cleanupUnexpectedSuccess(forked);

		const locations = await composed.locator.list();
		expect(locations).toMatchObject({
			ok: true,
			value: [{ sessionId: session.sessionId, filePath: session.filePath }],
		});
	});

	it("revalidates an active fork parent and creates no child after its lease becomes invalid", async () => {
		const session = await fixture();
		const order: string[] = [];
		const auditor = new RecordingAuditor("valid", order);
		const candidateAuthority = new RecordingCandidateAuthority(order);
		const agentBindings = new RecordingAgentBindingFactory(order);
		const composed = composedFactory({
			root: session.root,
			sessionDir: session.sessionDir,
			auditor,
			candidateAuthority,
			agentBindings,
		});

		const resumed = await composed.factory.resume(session.sessionId);
		expect(resumed).toMatchObject({ ok: true, value: { sessionId: session.sessionId } });
		if (!resumed.ok) throw new Error(resumed.error.message);
		expect(auditor.calls).toBe(1);

		auditor.setMode("invalid");
		order.length = 0;
		const forked = await composed.factory.fork(
			session.sessionId,
			session.parentCursor,
			"continue_existing_goal",
		);
		expect(forked).toMatchObject({
			ok: false,
			error: { code: "recovery_required" },
		});
		expect(auditor.calls).toBe(2);
		expect(order).toEqual(["audit"]);
		expect(candidateAuthority.calls).toBe(1);
		expect(agentBindings.calls).toBe(1);

		const locations = await composed.locator.list();
		expect(locations).toMatchObject({
			ok: true,
			value: [{ sessionId: session.sessionId, filePath: session.filePath }],
		});
		await cleanupUnexpectedSuccess(forked);
		await resumed.value.teardown("shutdown");
	});
});
