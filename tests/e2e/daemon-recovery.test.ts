import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	DirectoryV3SessionLocator,
	V3DaemonRuntimeRecoveryPortAdapter,
	V3SessionEvidenceReader,
} from "../../src/daemon/v3-session-adapters.ts";
import { canonicalDigest } from "../../src/runtime/protocol/v3/canonical-json.ts";
import { createIdempotencyKey } from "../../src/runtime/protocol/v3/coordination.ts";
import type { RuntimeEventPayloadMap } from "../../src/runtime/protocol/v3/event-payloads.ts";
import type { RuntimeEventType } from "../../src/runtime/protocol/v3/event-catalog.ts";
import { createSessionEventStreamRef } from "../../src/runtime/protocol/v3/events.ts";
import { createRuntimeId } from "../../src/runtime/protocol/v3/ids.ts";
import { createLocalIdentityContext } from "../../src/runtime/identity/local-principal.ts";
import { createAgentSemanticTerminalRecord } from "../../src/runtime/agents/graph-store.ts";
import { workspaceBindingDigest } from "../../src/runtime/protocol/v3/workspace.ts";
import { FileCommandIdempotencyRepository } from "../../src/daemon/durable-command-store.ts";
import {
	DaemonRecoveryAdapter,
	type DaemonRuntimeRecoveryPort,
	type DaemonSessionRecoveryDescriptor,
	type RestoredDaemonSession,
} from "../../src/daemon/recovery-adapter.ts";
import { InMemoryCommandIdempotencyRepository } from "../../src/runtime/control-plane/idempotency.ts";
import { DEFAULT_RUNTIME_FEATURES } from "../../src/runtime/runtime-features.ts";
import type { DurableTurnHandle } from "../../src/runtime/session/agent-loop-events.ts";
import { V3SessionManager } from "../../src/storage/v3-session-manager.ts";

const DIGEST = "d".repeat(64);

async function appendEvent<TType extends RuntimeEventType>(
	manager: V3SessionManager,
	type: TType,
	payload: RuntimeEventPayloadMap[TType],
	seed: string,
): Promise<void> {
	const appended = await manager.writer().append({
		type,
		principalId: manager.identity().principalId,
		traceId: createRuntimeId("trace", seed),
		payload,
	});
	if (!appended.ok) throw new Error(`${type}: ${appended.error.message}`);
}

function agentCommandBase(
	rootAgentId: ReturnType<typeof createRuntimeId<"agent">>,
	graphRevision: number,
	seed: string,
) {
	const requestId = createRuntimeId("command", `recovery-agent-${seed}`);
	const idempotencyKey = createIdempotencyKey(`recovery-agent-${seed}-key`);
	return {
		rootAgentId,
		graphRevision,
		requestId,
		idempotencyKey,
		commandDigest: canonicalDigest({ rootAgentId, graphRevision, requestId, idempotencyKey }),
	};
}

function childAgentNode(
	manager: V3SessionManager,
	rootAgentId: ReturnType<typeof createRuntimeId<"agent">>,
	agentId: ReturnType<typeof createRuntimeId<"agent">>,
	seed: string,
): RuntimeEventPayloadMap["agent.spawned"]["node"] {
	const timestamp = "2026-07-22T00:00:00.000Z";
	const artifactContract = { expected: [], allowPartial: true };
	return {
		agentId,
		rootAgentId,
		parentAgentId: rootAgentId,
		sessionId: manager.sessionId(),
		goalId: createRuntimeId("goal", `recovery-${seed}`),
		role: "build",
		objectiveDigest: DIGEST,
		depth: 1,
		state: "running",
		requestedCapabilities: [],
		workspaceReceipt: {
			receiptId: createRuntimeId("receipt", `agent-workspace-${seed}`),
			strategy: {
				strategyId: createRuntimeId("resource", `agent-workspace-${seed}`),
				kind: "managed_worktree",
				strategyDigest: DIGEST,
			},
			sessionId: manager.sessionId(),
			workspaceId: createRuntimeId("workspace", `agent-${seed}`),
			repositoryId: createRuntimeId("repository", "recovery"),
			bindingRevision: 1,
			bindingDigest: DIGEST,
			status: "active",
			issuedAt: timestamp,
			receiptDigest: DIGEST,
		},
		budget: {
			maxTurns: 1,
			maxInputTokens: 1,
			maxOutputTokens: 1,
			maxUsdMicros: 1,
			maxWallTimeMs: 1,
			maxToolCalls: 1,
			maxNetworkBytes: 0,
			maxStorageBytes: 0,
		},
		turnsUsed: 0,
		turnIds: [],
		artifactContract: {
			...artifactContract,
			contractDigest: canonicalDigest(artifactContract),
		},
		artifacts: [],
		inputSources: [],
		declassificationReceipts: [],
		createdAt: timestamp,
		updatedAt: timestamp,
	};
}

async function appendToolEffect(
	manager: V3SessionManager,
	turn: DurableTurnHandle,
	seed: string,
	terminal: boolean,
): Promise<{ toolCallId: ReturnType<typeof createRuntimeId<"toolCall">>; requestId: ReturnType<typeof createRuntimeId<"command">> }> {
	const toolCallId = createRuntimeId("toolCall", seed);
	const requestId = createRuntimeId("command", `sandbox-${seed}`);
	const profileId = createRuntimeId("resource", `sandbox-${seed}`);
	const sandboxResolutionReceiptId = createRuntimeId("receipt", `sandbox-resolution-${seed}`);
	await appendEvent(manager, "tool.requested", {
		turnId: turn.turnId,
		toolCallId,
		agentId: createRuntimeId("agent", "recovery-root"),
		toolIdentityDigest: DIGEST,
		argumentsDigest: DIGEST,
	}, `tool-requested-${seed}`);
	await appendEvent(manager, "sandbox.resolved", {
		requestId,
		profileId,
		requested: "strict",
		resolved: "strict",
		policyDigest: DIGEST,
		resolutionReceiptId: sandboxResolutionReceiptId,
		backendId: "shared-backend",
		effectiveEnforcement: "enforced",
	}, `sandbox-resolved-${seed}`);
	await appendEvent(manager, "tool.authorized", {
		toolCallId,
		requestId,
		decisionReceiptId: createRuntimeId("receipt", `tool-decision-${seed}`),
		approvalId: createRuntimeId("approval", `tool-${seed}`),
		sessionId: manager.sessionId(),
		runtimeId: manager.runtimeId(),
		runtimeGeneration: 1,
		turnId: turn.turnId,
		capability: "repository_read",
		requestDigest: DIGEST,
		policyDigest: DIGEST,
		workspaceEnvelopeDigest: DIGEST,
		sandboxResolutionReceiptId,
	}, `tool-authorized-${seed}`);
	await appendEvent(manager, "tool.started", {
		toolCallId,
		invocationDigest: DIGEST,
		workspaceReceiptId: createRuntimeId("receipt", `workspace-${seed}`),
	}, `tool-started-${seed}`);
	if (terminal) {
		await appendEvent(manager, "sandbox.execution_recorded", {
			requestId,
			invocationDigest: DIGEST,
			toolCallId,
			receipt: {
				authorityId: manager.identity().authorityId,
				tenantId: manager.identity().tenantId,
				principalId: manager.identity().principalId,
				receiptId: createRuntimeId("receipt", `sandbox-execution-${seed}`),
				requestId,
				profileId,
				requested: "strict",
				resolved: "strict",
				policyDigest: DIGEST,
				backendId: "shared-backend",
				effectiveEnforcement: "enforced",
				invocationDigest: DIGEST,
			},
		}, `sandbox-recorded-${seed}`);
		await appendEvent(manager, "tool.finished", { toolCallId, resultDigest: DIGEST }, `tool-finished-${seed}`);
	}
	return { toolCallId, requestId };
}

async function appendWorkspaceEffect(
	manager: V3SessionManager,
	seed: string,
	terminal: boolean,
): Promise<ReturnType<typeof createRuntimeId<"lease">>> {
	const workspaceId = createRuntimeId("workspace", seed);
	const leaseId = createRuntimeId("lease", seed);
	const binding = {
		authorityId: manager.identity().authorityId,
		tenantId: manager.identity().tenantId,
		workspaceId,
		repositoryId: createRuntimeId("repository", seed),
		bindingKind: "source" as const,
		canonicalCwd: "/workspace/shared",
		effectiveCwd: "/workspace/shared",
		branch: "shared-branch",
		baseCommit: "1".repeat(40),
		headCommit: "2".repeat(40),
	};
	await appendEvent(manager, "workspace.bound", {
		binding,
		bindingDigest: workspaceBindingDigest(binding),
		lease: {
			authorityId: manager.identity().authorityId,
			tenantId: manager.identity().tenantId,
			principalId: manager.identity().principalId,
			leaseId,
			workspaceId,
			ownerRuntimeId: manager.runtimeId(),
			leaseRevision: 1,
			fencingTokenDigest: DIGEST,
			state: "active",
		},
	}, `workspace-bound-${seed}`);
	if (terminal) {
		await appendEvent(manager, "workspace.released", {
			workspaceId,
			leaseId,
			leaseRevision: 1,
			bindingDigest: workspaceBindingDigest(binding),
			receiptId: createRuntimeId("receipt", `workspace-release-${seed}`),
		}, `workspace-released-${seed}`);
	}
	return leaseId;
}

async function appendExecutorEffect(
	manager: V3SessionManager,
	seed: string,
	terminal: boolean,
): Promise<ReturnType<typeof createRuntimeId<"command">>> {
	const requestId = createRuntimeId("command", `executor-${seed}`);
	const executorId = createRuntimeId("resource", "shared-executor");
	await appendEvent(manager, "executor.requested", {
		requestId,
		idempotencyKey: createRuntimeId("command", `executor-idempotency-${seed}`),
		executorId,
		executorKind: "ci",
		invocationDigest: DIGEST,
	}, `executor-requested-${seed}`);
	if (terminal) {
		await appendEvent(manager, "executor.execution_recorded", {
			requestId,
			executorId,
			executorKind: "ci",
			invocationDigest: DIGEST,
			receiptId: createRuntimeId("receipt", `executor-${seed}`),
			receiptDigest: DIGEST,
			status: "succeeded",
		}, `executor-recorded-${seed}`);
	}
	return requestId;
}

async function appendChildAgentEffect(
	manager: V3SessionManager,
	seed: string,
	terminal: boolean,
): Promise<ReturnType<typeof createRuntimeId<"agent">>> {
	const rootAgentId = createRuntimeId("agent", "recovery-root");
	const agentId = createRuntimeId("agent", seed);
	const node = childAgentNode(manager, rootAgentId, agentId, seed);
	await appendEvent(manager, "agent.spawned", {
		...agentCommandBase(rootAgentId, 1, `${seed}-spawn`),
		intentRequestId: createRuntimeId("command", `agent-intent-${seed}`),
		node,
		edge: {
			parentAgentId: rootAgentId,
			childAgentId: agentId,
			createdAt: node.createdAt,
		},
	}, `agent-spawned-${seed}`);
	if (terminal) {
		const terminalBase = agentCommandBase(rootAgentId, 2, `${seed}-finish`);
		await appendEvent(manager, "agent.finished", {
			...terminalBase,
			agentId,
			from: "running",
			terminal: createAgentSemanticTerminalRecord({
				agentId,
				requestId: terminalBase.requestId,
				idempotencyKey: terminalBase.idempotencyKey,
				outcome: "completed",
				partialResults: node.artifacts.map((report) => report.artifact),
			}),
		}, `agent-finished-${seed}`);
	}
	return agentId;
}

describe("headless daemon crash recovery", () => {
	it("keeps uncertain commands fenced across restart and never activates terminal/uncertain side effects", async () => {
		const directory = await mkdtemp(join(tmpdir(), "runledger-daemon-recovery-"));
		try {
			const filePath = join(directory, "command-journal.jsonl");
			const first = await FileCommandIdempotencyRepository.open(filePath);
			if (!first.ok) throw new Error(first.error.message);
			const terminalCommand = {
				commandId: createRuntimeId("command", "terminal-command"),
				idempotencyKey: createIdempotencyKey("terminal-command-key-001"),
				commandType: "session:stop" as const,
				requestDigest: "c".repeat(64),
			};
			const terminalClaim = await first.value.claim(terminalCommand);
			if (!terminalClaim.ok || terminalClaim.value.status !== "claimed") throw new Error("terminal claim failed");
			const terminalSession = createRuntimeId("session", "terminal-command");
			const terminalStream = createSessionEventStreamRef(createLocalIdentityContext(), terminalSession);
			expect(
				await first.value.commit(terminalClaim.value.claim, {
					type: "session:stop",
					sessionId: terminalSession,
					terminalCursor: {
						stream: terminalStream,
						sequence: 8,
						eventId: createRuntimeId("event", "terminal-command"),
						eventHash: "e".repeat(64),
					},
				}),
			).toMatchObject({ ok: true });
			const command = {
				commandId: createRuntimeId("command", "crash-window"),
				idempotencyKey: createIdempotencyKey("crash-window-key-0001"),
				commandType: "session:stop" as const,
				requestDigest: DIGEST,
			};
			expect(await first.value.claim(command)).toMatchObject({ ok: true, value: { status: "claimed" } });

			const restarted = await FileCommandIdempotencyRepository.open(filePath);
			if (!restarted.ok) throw new Error(restarted.error.message);
			expect(await restarted.value.lookup(terminalCommand)).toMatchObject({
				ok: true,
				value: { status: "duplicate", receipt: { result: { type: "session:stop" } } },
			});
			expect(await restarted.value.claim(command)).toMatchObject({
				ok: true,
				value: { status: "in_flight" },
			});

			const safe = createRuntimeId("session", "safe");
			const uncertain = createRuntimeId("session", "uncertain");
			const stopped = createRuntimeId("session", "stopped");
			const corrupted = createRuntimeId("session", "corrupted");
			const descriptors: readonly DaemonSessionRecoveryDescriptor[] = [
				{
					sessionId: safe,
					state: "resume",
					sideEffects: [{ kind: "artifact", operationId: createRuntimeId("command", "safe-terminal"), state: "terminal" }],
				},
				{
					sessionId: uncertain,
					state: "resume",
					sideEffects: [{ kind: "remote_executor", operationId: createRuntimeId("command", "uncertain-effect"), state: "uncertain" }],
				},
				{ sessionId: stopped, state: "stopped", sideEffects: [] },
				{ sessionId: corrupted, state: "corrupted", sideEffects: [] },
			];
			const restored: Array<{ sessionId: string; mode: string }> = [];
			const activated: string[] = [];
			const port: DaemonRuntimeRecoveryPort = {
				discover: async () => ({ ok: true, value: descriptors }),
				restoreProjection: async (descriptor, mode) => {
					restored.push({ sessionId: descriptor.sessionId, mode });
					const value: RestoredDaemonSession = {
						sessionId: descriptor.sessionId,
						projectionDigest: DIGEST,
						mode,
					};
					return { ok: true, value };
				},
				activate: async (session) => {
					activated.push(session.sessionId);
					return { ok: true, value: undefined };
				},
			};
			const recovered = await new DaemonRecoveryAdapter(port, restarted.value).recover();
			expect(recovered).toMatchObject({
				ok: true,
				value: {
					active: [safe],
					paused: [uncertain],
					terminal: [stopped],
					corrupted: [corrupted],
					inFlightCommands: [{ commandId: command.commandId }],
				},
			});
			expect(activated).toEqual([safe]);
			expect(restored).toEqual([
				{ sessionId: safe, mode: "active_candidate" },
				{ sessionId: uncertain, mode: "paused" },
				{ sessionId: stopped, mode: "read_only" },
				{ sessionId: corrupted, mode: "read_only" },
			]);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("rebuilds five side-effect lifecycles from durable correlation ids without replaying terminal work", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-v3-side-effect-recovery-"));
		try {
			const sessionDir = join(root, "sessions");
			const terminalManager = await V3SessionManager.create({
				cwd: root,
				sessionDir,
				features: DEFAULT_RUNTIME_FEATURES,
			});
			const identity = terminalManager.identity();
			const terminalTurn = await terminalManager.sessionEvents().beginTurn();
			const terminalTool = await appendToolEffect(terminalManager, terminalTurn, "terminal", true);
			await terminalManager.sessionEvents().finishTurn(terminalTurn, { status: "done" }, "stop");
			const terminalWorkspace = await appendWorkspaceEffect(terminalManager, "terminal", true);
			const terminalExecutor = await appendExecutorEffect(terminalManager, "terminal", true);
			const terminalAgent = await appendChildAgentEffect(terminalManager, "terminal", true);
			const terminalSessionId = terminalManager.sessionId();
			const terminalPath = terminalManager.filePath();
			await terminalManager.closeAll();

			const mixedManager = await V3SessionManager.create({
				cwd: root,
				sessionDir,
				features: DEFAULT_RUNTIME_FEATURES,
				identity,
			});
			const mixedTurn = await mixedManager.sessionEvents().beginTurn();
			const completedTool = await appendToolEffect(mixedManager, mixedTurn, "shared-terminal", true);
			const uncertainTool = await appendToolEffect(mixedManager, mixedTurn, "shared-uncertain", false);
			const completedWorkspace = await appendWorkspaceEffect(mixedManager, "shared-terminal", true);
			const uncertainWorkspace = await appendWorkspaceEffect(mixedManager, "shared-uncertain", false);
			const completedExecutor = await appendExecutorEffect(mixedManager, "shared-terminal", true);
			const uncertainExecutor = await appendExecutorEffect(mixedManager, "shared-uncertain", false);
			const completedAgent = await appendChildAgentEffect(mixedManager, "shared-terminal", true);
			const uncertainAgent = await appendChildAgentEffect(mixedManager, "shared-uncertain", false);
			const mixedSessionId = mixedManager.sessionId();
			const mixedPath = mixedManager.filePath();
			await mixedManager.closeAll();

			const externalOnlyManager = await V3SessionManager.create({
				cwd: root,
				sessionDir,
				features: DEFAULT_RUNTIME_FEATURES,
				identity,
			});
			await appendWorkspaceEffect(externalOnlyManager, "external-only", false);
			await appendExecutorEffect(externalOnlyManager, "external-only", false);
			await appendChildAgentEffect(externalOnlyManager, "external-only", false);
			const externalOnlySessionId = externalOnlyManager.sessionId();
			const externalOnlyPath = externalOnlyManager.filePath();
			await externalOnlyManager.closeAll();

			const beforeRecovery = await Promise.all([
				readFile(terminalPath),
				readFile(mixedPath),
				readFile(externalOnlyPath),
			]);
			const locator = new DirectoryV3SessionLocator({ cwd: root, sessionDir });
			const evidence = new V3SessionEvidenceReader({ locator, identity });
			const activation = vi.fn(async () => ({ ok: true as const, value: undefined }));
			const runtime = new V3DaemonRuntimeRecoveryPortAdapter({ evidence, activation: { activate: activation } });
			const discovered = await runtime.discover();
			expect(discovered.ok).toBe(true);
			if (!discovered.ok) throw new Error(discovered.error.message);
			const terminalDescriptor = discovered.value.find((entry) => entry.sessionId === terminalSessionId);
			const mixedDescriptor = discovered.value.find((entry) => entry.sessionId === mixedSessionId);
			const externalOnlyDescriptor = discovered.value.find((entry) => entry.sessionId === externalOnlySessionId);
			if (!terminalDescriptor || !mixedDescriptor || !externalOnlyDescriptor) {
				throw new Error("side-effect recovery fixtures were not discovered");
			}

			expect(terminalDescriptor).toMatchObject({ state: "resume" });
			expect(terminalDescriptor.sideEffects).toEqual(expect.arrayContaining([
				{ kind: "tool", operationId: terminalTool.toolCallId, state: "terminal" },
				{ kind: "sandbox", operationId: terminalTool.requestId, state: "terminal" },
				{ kind: "workspace", operationId: terminalWorkspace, state: "terminal" },
				{ kind: "remote_executor", operationId: terminalExecutor, state: "terminal" },
				{ kind: "child_agent", operationId: terminalAgent, state: "terminal" },
			]));
			expect(terminalDescriptor.sideEffects).toHaveLength(5);

			expect(mixedDescriptor.sideEffects).toEqual(expect.arrayContaining([
				{ kind: "tool", operationId: completedTool.toolCallId, state: "terminal" },
				{ kind: "tool", operationId: uncertainTool.toolCallId, state: "uncertain" },
				{ kind: "sandbox", operationId: completedTool.requestId, state: "terminal" },
				{ kind: "sandbox", operationId: uncertainTool.requestId, state: "uncertain" },
				{ kind: "workspace", operationId: completedWorkspace, state: "terminal" },
				{ kind: "workspace", operationId: uncertainWorkspace, state: "uncertain" },
				{ kind: "remote_executor", operationId: completedExecutor, state: "terminal" },
				{ kind: "remote_executor", operationId: uncertainExecutor, state: "uncertain" },
				{ kind: "child_agent", operationId: completedAgent, state: "terminal" },
				{ kind: "child_agent", operationId: uncertainAgent, state: "uncertain" },
			]));
			expect(mixedDescriptor.sideEffects).toHaveLength(10);
			expect(externalOnlyDescriptor).toMatchObject({ state: "resume" });
			expect(externalOnlyDescriptor.sideEffects.every((effect) => effect.state === "uncertain")).toBe(true);

			const recovered = await new DaemonRecoveryAdapter(
				runtime,
				new InMemoryCommandIdempotencyRepository(),
			).recover();
			expect(recovered).toMatchObject({
				ok: true,
				value: {
					active: [terminalSessionId],
					paused: expect.arrayContaining([mixedSessionId, externalOnlySessionId]),
					terminal: [],
					corrupted: [],
				},
			});
			expect(activation).toHaveBeenCalledTimes(1);
			expect(activation).toHaveBeenCalledWith(expect.objectContaining({
				sessionId: terminalSessionId,
				mode: "active_candidate",
			}));
			const afterRecovery = await Promise.all([
				readFile(terminalPath),
				readFile(mixedPath),
				readFile(externalOnlyPath),
			]);
			expect(afterRecovery).toEqual(beforeRecovery);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
