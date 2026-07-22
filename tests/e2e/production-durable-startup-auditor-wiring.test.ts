import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { main } from "../../src/cli/main.ts";
import { startLocalV3Daemon } from "../../src/daemon/local-v3-daemon.ts";
import { createLocalIdentityContext } from "../../src/runtime/identity/local-principal.ts";
import type { RuntimeIdentityContext } from "../../src/runtime/identity/types.ts";
import type { StartupExternalReceiptAuditPort } from "../../src/runtime/lifecycle/recovery.ts";
import type { ApprovalReceiptRef } from "../../src/runtime/protocol/v3/capability.ts";
import { canonicalDigest } from "../../src/runtime/protocol/v3/canonical-json.ts";
import { createRuntimeId } from "../../src/runtime/protocol/v3/ids.ts";
import type { WorkspaceLeaseRef } from "../../src/runtime/protocol/v3/workspace.ts";
import {
	DEFAULT_RUNTIME_FEATURES,
	type RuntimeFeatureFlags,
} from "../../src/runtime/runtime-features.ts";
import { FileApprovalStateStore } from "../../src/storage/security-runtime-state.ts";
import { saveProjectSettings } from "../../src/storage/settings-manager.ts";
import { V3SessionManager } from "../../src/storage/v3-session-manager.ts";
import {
	FileWorkspaceLeaseMutationPort,
	type DurableWorktreeScope,
} from "../../src/storage/worktree-state-adapter.ts";
import type { WorkspaceLeaseSecret } from "../../src/worktree/ports.ts";

const surfaceCalls = vi.hoisted(() => ({ constructed: 0, run: 0 }));

vi.mock("../../src/tui/interactive-mode.ts", () => ({
	InteractiveMode: class {
		public constructor() { surfaceCalls.constructed += 1; }
		public async run(): Promise<void> { surfaceCalls.run += 1; }
	},
}));

const CLI_FEATURES: RuntimeFeatureFlags = {
	...DEFAULT_RUNTIME_FEATURES,
	sessionV3: true,
};

const DAEMON_FEATURES: RuntimeFeatureFlags = {
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

const ISSUED_AT = "2026-07-23T00:00:00.000Z";
const DECIDED_AT = "2026-07-23T00:01:00.000Z";
const FUTURE_EXPIRY = "2099-07-23T01:00:00.000Z";
const PAST_EXPIRY = "2000-07-23T00:01:30.000Z";
const roots: string[] = [];
const originalCwd = process.cwd();

const unusedRawAuditor: StartupExternalReceiptAuditPort = {
	auditWorkspaceLease: async () => { throw new Error("raw auditor must not run"); },
	auditApprovalDecision: async () => { throw new Error("raw auditor must not run"); },
};

type StartupSurface = "cli" | "daemon";
type DurableScenario = "exact" | "stale" | "revoked" | "expired" | "missing";

interface DurableFixture {
	root: string;
	cwd: string;
	sessionDir: string;
	filePath: string;
	stateRoot: string;
	identity: RuntimeIdentityContext;
	features: RuntimeFeatureFlags;
}

function productionProvider(workspaceStateRoot: string) {
	return {
		implementation: "production" as const,
		providerId: "runledger-local-production",
		evidenceDigest: canonicalDigest({ provider: "runledger-local-production", contract: 1 }),
		workspaceStateRoot,
		create: () => { throw new Error("provider create must not run before startup receipt admission"); },
	};
}

afterEach(async () => {
	process.chdir(originalCwd);
	surfaceCalls.constructed = 0;
	surfaceCalls.run = 0;
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function workspaceLease(
	identity: RuntimeIdentityContext,
	runtimeId: ReturnType<typeof createRuntimeId<"runtime">>,
	seed: string,
): { reference: WorkspaceLeaseRef; secret: WorkspaceLeaseSecret } {
	const fencingToken = `private-fencing-token-${seed}`;
	const reference: WorkspaceLeaseRef = {
		authorityId: identity.authorityId,
		tenantId: identity.tenantId,
		principalId: identity.principalId,
		leaseId: createRuntimeId("lease", seed),
		workspaceId: createRuntimeId("workspace", seed),
		ownerRuntimeId: runtimeId,
		leaseRevision: 1,
		fencingTokenDigest: canonicalDigest(fencingToken),
		state: "active",
	};
	return {
		reference,
		secret: {
			record: reference,
			fencingToken,
			issuedAt: ISSUED_AT,
			lastRenewedAt: ISSUED_AT,
		},
	};
}

function approvalReceipt(
	identity: RuntimeIdentityContext,
	seed: string,
	expiresAt: string,
): ApprovalReceiptRef {
	const body: Omit<ApprovalReceiptRef, "receiptDigest"> = {
		authorityId: identity.authorityId,
		tenantId: identity.tenantId,
		principalId: identity.principalId,
		receiptId: createRuntimeId("receipt", `approval-${seed}`),
		approvalId: createRuntimeId("approval", seed),
		requestId: createRuntimeId("command", `request-${seed}`),
		requestDigest: canonicalDigest({ seed, kind: "request" }),
		ticketDigest: canonicalDigest({ seed, kind: "ticket" }),
		decision: "allowed",
		decisionRevision: 1,
		decidedAt: DECIDED_AT,
		expiresAt,
		evidenceComplete: true,
		evidenceTruncated: false,
		originalInputDigest: canonicalDigest({ seed, kind: "input" }),
	};
	return { ...body, receiptDigest: canonicalDigest(body) };
}

async function appendWorkspaceReference(
	manager: V3SessionManager,
	lease: WorkspaceLeaseRef,
	seed: string,
): Promise<void> {
	const leaseResult = await manager.writer().append({
		type: "lease.acquired",
		principalId: manager.identity().principalId,
		traceId: createRuntimeId("trace", `lease-${seed}`),
		payload: {
			lease,
			receiptId: createRuntimeId("receipt", `lease-${seed}`),
		},
	});
	if (!leaseResult.ok) throw new Error(leaseResult.error.message);
}

async function appendApprovalReference(
	manager: V3SessionManager,
	approval: ApprovalReceiptRef,
	seed: string,
): Promise<void> {
	const turnId = createRuntimeId("turn", seed);
	const toolCallId = createRuntimeId("toolCall", seed);
	const requested = await manager.writer().append({
		type: "permission.requested",
		principalId: manager.identity().principalId,
		traceId: createRuntimeId("trace", `approval-request-${seed}`),
		payload: {
			approvalId: approval.approvalId,
			requestId: approval.requestId,
			sessionId: manager.sessionId(),
			runtimeId: manager.runtimeId(),
			runtimeGeneration: 1,
			turnId,
			toolCallId,
			capability: "workspace_write",
			resourceKind: "filesystem",
			requestDigest: approval.requestDigest,
			policyDigest: canonicalDigest({ seed, kind: "policy" }),
			workspaceEnvelopeDigest: canonicalDigest({ seed, kind: "workspace-envelope" }),
			ticketDigest: approval.ticketDigest,
			scope: "once",
			requestedAt: ISSUED_AT,
			expiresAt: approval.expiresAt,
			attemptId: createRuntimeId("command", `attempt-${seed}`),
			serverScope: "tool_server",
			resourceScopeDigest: canonicalDigest({ seed, kind: "resource-scope" }),
			commandScopeDigest: canonicalDigest({ seed, kind: "command-scope" }),
			evidenceComplete: true,
			evidenceTruncated: false,
			originalInputDigest: approval.originalInputDigest,
			summary: {
				operation: "write",
				toolIdentityDigest: canonicalDigest({ seed, kind: "tool" }),
				targetDigest: canonicalDigest({ seed, kind: "target" }),
				environmentKeyDigests: [],
			},
		},
	});
	if (!requested.ok) throw new Error(requested.error.message);

	const decided = await manager.writer().append({
		type: "permission.decided",
		principalId: manager.identity().principalId,
		traceId: createRuntimeId("trace", `approval-decision-${seed}`),
		payload: {
			approvalId: approval.approvalId,
			requestId: approval.requestId,
			requestDigest: approval.requestDigest,
			ticketDigest: approval.ticketDigest,
			sessionId: manager.sessionId(),
			runtimeId: manager.runtimeId(),
			runtimeGeneration: 1,
			turnId,
			toolCallId,
			decision: "allowed",
			decisionRevision: approval.decisionRevision,
			receiptId: approval.receiptId,
			receiptDigest: approval.receiptDigest,
			decidedAt: approval.decidedAt,
			expiresAt: approval.expiresAt,
			evidenceComplete: approval.evidenceComplete,
			evidenceTruncated: approval.evidenceTruncated,
			originalInputDigest: approval.originalInputDigest,
		},
	});
	if (!decided.ok) throw new Error(decided.error.message);
}

async function createFixture(
	surface: StartupSurface,
	scenario: DurableScenario,
): Promise<DurableFixture> {
	const root = await mkdtemp(join(tmpdir(), `runledger-${surface}-durable-startup-`));
	roots.push(root);
	const cwd = join(root, "workspace");
	const sessionDir = join(cwd, ".runledger", "sessions");
	const stateRoot = join(root, "deployment-state");
	await mkdir(cwd, { recursive: true });
	const identity = createLocalIdentityContext();
	const features = surface === "cli" ? CLI_FEATURES : DAEMON_FEATURES;
	if (surface === "cli") {
		await saveProjectSettings(cwd, {
			sessionV3FeatureState: "default",
			runtimeFeatures: features,
		});
	}
	const manager = await V3SessionManager.create({
		cwd,
		sessionDir,
		features,
		identity,
		runtimeId: createRuntimeId("runtime", `${surface}-${scenario}`),
	});
	const lease = workspaceLease(identity, manager.runtimeId(), `${surface}-${scenario}`);
	const approval = approvalReceipt(
		identity,
		`${surface}-${scenario}`,
		scenario === "expired" ? PAST_EXPIRY : FUTURE_EXPIRY,
	);
	if (scenario === "expired") {
		await appendApprovalReference(manager, approval, `${surface}-${scenario}`);
	} else {
		await appendWorkspaceReference(manager, lease.reference, `${surface}-${scenario}`);
	}

	const scope: DurableWorktreeScope = {
		authorityId: identity.authorityId,
		tenantId: identity.tenantId,
	};
	const leaseStore = new FileWorkspaceLeaseMutationPort(
		join(stateRoot, "workspace-leases.json"),
		scope,
	);
	const approvalStore = new FileApprovalStateStore(
		join(stateRoot, "tool-gateway", "approvals"),
	);
	await Promise.all([leaseStore.verify(), approvalStore.verify()]);
	if (scenario !== "missing") {
		if (scenario === "expired") {
			expect(await approvalStore.commit(approval, 0)).toMatchObject({ ok: true });
		} else {
			let authoritativeLease = lease.secret;
			if (scenario === "stale") {
				const fencingToken = `new-private-fencing-token-${surface}-${scenario}`;
				authoritativeLease = {
					...lease.secret,
					record: {
						...lease.reference,
						leaseRevision: 2,
						fencingTokenDigest: canonicalDigest(fencingToken),
					},
					fencingToken,
				};
			} else if (scenario === "revoked") {
				authoritativeLease = {
					...lease.secret,
					record: { ...lease.reference, state: "revoked" },
				};
			}
			expect(await leaseStore.create(authoritativeLease)).toBe("applied");
		}
	}
	const filePath = manager.filePath();
	await manager.closeAll();
	return { root, cwd, sessionDir, filePath, stateRoot, identity, features };
}

const cases = [
	{ scenario: "exact", expectedReason: undefined },
	{ scenario: "stale", expectedReason: "external_receipt_invalid" },
	{ scenario: "revoked", expectedReason: "external_receipt_invalid" },
	{ scenario: "expired", expectedReason: "external_receipt_invalid" },
	{ scenario: "missing", expectedReason: "external_receipt_unavailable" },
] as const;

describe("production durable startup auditor wiring", () => {
	it.each(cases)(
		"CLI composes real durable stores for $scenario receipts without an injected auditor",
		async ({ scenario, expectedReason }) => {
			const fixture = await createFixture("cli", scenario);
			process.chdir(fixture.cwd);
			const dependencies = {
				startupExternalReceiptAuditTimeoutMs: 1_000,
			};
			if (expectedReason === undefined) {
				await expect(main([
					"--state-root", fixture.stateRoot,
					"--session", fixture.filePath,
				], dependencies)).resolves.toBeUndefined();
				expect(surfaceCalls).toEqual({ constructed: 1, run: 1 });
				return;
			}
			await expect(main([
				"--state-root", fixture.stateRoot,
				"--session", fixture.filePath,
			], dependencies)).rejects.toThrow(expectedReason);
			expect(surfaceCalls).toEqual({ constructed: 0, run: 0 });
		},
	);

	it("uses the provider-admitted workspace root before opening a CLI session", async () => {
		const fixture = await createFixture("cli", "expired");
		process.chdir(fixture.cwd);
		await expect(main(["--session", fixture.filePath], {
			productionInteractiveOptions: productionProvider(fixture.stateRoot),
			startupExternalReceiptAuditTimeoutMs: 1_000,
		})).rejects.toThrow("external_receipt_invalid");
		expect(surfaceCalls).toEqual({ constructed: 0, run: 0 });
	});

	it("rejects explicit and provider workspace roots unless they exactly match", async () => {
		const fixture = await createFixture("cli", "exact");
		process.chdir(fixture.cwd);
		const differentRoot = join(fixture.root, "different-deployment-state");
		await mkdir(differentRoot, { mode: 0o700 });

		await expect(main(["--state-root", fixture.stateRoot, "--session", fixture.filePath], {
			productionInteractiveOptions: productionProvider(differentRoot),
		})).rejects.toThrow("state root");
		expect(surfaceCalls).toEqual({ constructed: 0, run: 0 });
	});

	it.each(["explicit", "provider"] as const)(
		"rejects a raw CLI auditor combined with a $source state root",
		async (source) => {
			const fixture = await createFixture("cli", "exact");
			process.chdir(fixture.cwd);
			await expect(main([
				...(source === "explicit" ? ["--state-root", fixture.stateRoot] : []),
				"--session",
				fixture.filePath,
			], {
				startupExternalReceiptAuditor: unusedRawAuditor,
				...(source === "provider"
					? { productionInteractiveOptions: productionProvider(fixture.stateRoot) }
					: {}),
			})).rejects.toThrow("state root");
			expect(surfaceCalls).toEqual({ constructed: 0, run: 0 });
		},
	);

	it.each(cases)(
		"daemon composes real durable stores for $scenario receipts without an injected auditor",
		async ({ scenario, expectedReason }) => {
			const fixture = await createFixture("daemon", scenario);
			const options = {
				cwd: fixture.cwd,
				sessionDir: fixture.sessionDir,
				features: fixture.features,
				identity: fixture.identity,
				authorityStateDirectory: join(fixture.root, "authority"),
				shutdownTimeoutMs: 1_000,
				startupExternalReceiptStateRoot: fixture.stateRoot,
				startupExternalReceiptAuditTimeoutMs: 1_000,
			};
			const started = await startLocalV3Daemon(options);
			if (expectedReason === undefined) {
				expect(started.ok).toBe(true);
				if (!started.ok) throw new Error(started.error.message);
				await started.value.composition.shutdown.begin(1_000);
				await started.value.authorityRuntime.close();
				return;
			}
			expect(started).toMatchObject({
				ok: false,
				error: {
					code: "recovery_required",
					details: { startupReasons: expect.stringContaining(expectedReason) },
				},
			});
		},
	);

	it("rejects a raw daemon auditor combined with a durable state root", async () => {
		const fixture = await createFixture("daemon", "exact");
		const started = await startLocalV3Daemon({
			cwd: fixture.cwd,
			sessionDir: fixture.sessionDir,
			features: fixture.features,
			identity: fixture.identity,
			authorityStateDirectory: join(fixture.root, "authority"),
			startupExternalReceiptAuditor: unusedRawAuditor,
			startupExternalReceiptStateRoot: fixture.stateRoot,
		});
		expect(started).toMatchObject({
			ok: false,
			error: { code: "invalid_request" },
		});
	});
});
