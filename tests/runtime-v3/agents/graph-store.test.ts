import { describe, expect, it } from "vitest";
import { canonicalDigest } from "../../../src/runtime/protocol/v3/canonical-json.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/v3/ids.ts";
import { createAgentResidencyReceipt } from "../../../src/runtime/agents/residency.ts";
import { DEFAULT_AGENT_GRAPH_LIMITS, type AgentGraphSemanticCommand } from "../../../src/runtime/agents/types.ts";
import {
	applyAgentGraphCommand,
	createAgentSemanticTerminalRecord,
} from "../../../src/runtime/agents/graph-store.ts";
import {
	artifact,
	digest,
	key,
	rootRegistration,
	runtimeFakes,
	spawnRequest,
	workspaceReceipt as createWorkspaceReceipt,
	zeroUsage,
} from "./helpers.ts";

const NOW = "2026-07-22T00:00:02.000Z";

describe("durable agent graph", () => {
	it("accepts only an exact monotonic root Workspace revalidation", async () => {
		const runtime = runtimeFakes();
		const baseRoot = rootRegistration();
		const root = {
			...baseRoot,
			workspaceReceipt: createWorkspaceReceipt(baseRoot.sessionId, "root-revalidation", "isolated_lease"),
		};
		expect((await runtime.supervisor.registerRoot(root)).ok).toBe(true);
		const loaded = await runtime.store.load(root.agentId);
		if (!loaded.ok) throw new Error(loaded.error.message);
		const { receiptDigest: _receiptDigest, ...previousBody } = root.workspaceReceipt;
		const nextBody = {
			...previousBody,
			bindingRevision: previousBody.bindingRevision + 1,
			leaseRevision: 2,
			issuedAt: NOW,
		};
		const workspaceReceipt = { ...nextBody, receiptDigest: canonicalDigest(nextBody) };
		const revalidated: AgentGraphSemanticCommand = {
			type: "agent.root_revalidated",
			requestId: createRuntimeId("command", "root-revalidated"),
			idempotencyKey: key("root-revalidated"),
			occurredAt: NOW,
			agentId: root.agentId,
			workspaceReceipt,
			capabilityGrant: root.capabilityGrant,
		};
		const committed = await runtime.store.commit(root.agentId, loaded.value.revision, revalidated);
		expect(committed).toMatchObject({ ok: true, value: { status: "committed" } });
		expect(await runtime.store.commit(root.agentId, loaded.value.revision, revalidated)).toMatchObject({
			ok: true,
			value: { status: "duplicate" },
		});
		const current = await runtime.store.load(root.agentId);
		if (!current.ok) throw new Error(current.error.message);
		expect(await runtime.store.commit(root.agentId, current.value.revision, {
			...revalidated,
			requestId: createRuntimeId("command", "root-revalidated-stale"),
			idempotencyKey: key("root-revalidated-stale"),
		})).toMatchObject({ ok: false, error: { code: "invalid_graph" } });
		const driftedBody = {
			...nextBody,
			repositoryId: createRuntimeId("repository", "root-revalidated-drift"),
			bindingRevision: nextBody.bindingRevision + 1,
			leaseRevision: nextBody.leaseRevision + 1,
		};
		expect(await runtime.store.commit(root.agentId, current.value.revision, {
			...revalidated,
			requestId: createRuntimeId("command", "root-revalidated-drift"),
			idempotencyKey: key("root-revalidated-drift"),
			workspaceReceipt: { ...driftedBody, receiptDigest: canonicalDigest(driftedBody) },
		})).toMatchObject({ ok: false, error: { code: "invalid_graph" } });
	});

	it("loads the canonical projection/head after a supervisor restart", async () => {
		const runtime = runtimeFakes();
		const root = rootRegistration();
		expect((await runtime.supervisor.registerRoot(root)).ok).toBe(true);
		const request = spawnRequest(root.capabilityGrant);
		expect((await runtime.supervisor.spawn(request)).ok).toBe(true);

		const loaded = await runtime.store.load(root.agentId);
		expect(loaded.ok).toBe(true);
		if (!loaded.ok) return;
		expect(loaded.value.projection.nodes.get(request.childAgentId)).toMatchObject({
			parentAgentId: root.agentId,
			sessionId: request.childSessionId,
			state: "running",
		});
		expect(loaded.value.projection.edges).toHaveLength(1);
		expect(loaded.value.projection.revision).toBe(loaded.value.revision);
	});

	it("uses expected revision CAS and semantic-command idempotency", async () => {
		const runtime = runtimeFakes();
		const root = rootRegistration();
		await runtime.supervisor.registerRoot(root);
		const loaded = await runtime.store.load(root.agentId);
		if (!loaded.ok) throw new Error(loaded.error.message);
		const stopRequestId = createRuntimeId("command", "stop-root");
		const stopKey = key("stop-root");
		const stopped: AgentGraphSemanticCommand = {
			type: "agent.stopped",
			requestId: stopRequestId,
			idempotencyKey: stopKey,
			occurredAt: NOW,
			agentId: root.agentId,
			from: "running",
			reason: "cancelled",
			terminal: createAgentSemanticTerminalRecord({
				agentId: root.agentId,
				requestId: stopRequestId,
				idempotencyKey: stopKey,
				outcome: "stopped",
				reason: "cancelled",
				partialResults: [],
			}),
		};
		const committed = await runtime.store.commit(root.agentId, loaded.value.revision, stopped);
		expect(committed.ok && committed.value.status).toBe("committed");
		const duplicate = await runtime.store.commit(root.agentId, loaded.value.revision, stopped);
		expect(duplicate.ok && duplicate.value.status).toBe("duplicate");

		const staleRequestId = createRuntimeId("command", "stale-root");
		const staleKey = key("stale-root");
		const stale: AgentGraphSemanticCommand = {
			type: "agent.failed",
			requestId: staleRequestId,
			idempotencyKey: staleKey,
			occurredAt: NOW,
			agentId: root.agentId,
			from: "running",
			reason: "crash",
			terminal: createAgentSemanticTerminalRecord({
				agentId: root.agentId,
				requestId: staleRequestId,
				idempotencyKey: staleKey,
				outcome: "failed",
				reason: "crash",
				partialResults: [],
			}),
			error: {
				code: "crash",
				messageDigest: "0".repeat(64),
				retryable: false,
				outcomeCertain: true,
				effect: "none",
			},
		};
		const conflict = await runtime.store.commit(root.agentId, loaded.value.revision, stale);
		expect(conflict).toMatchObject({ ok: true, value: { status: "conflict" } });
	});

	it("rejects a spawn terminal without a correlated pending intent", async () => {
		const runtime = runtimeFakes();
		const root = rootRegistration();
		await runtime.supervisor.registerRoot(root);
		const request = spawnRequest(root.capabilityGrant);
		const spawned = await runtime.supervisor.spawn(request);
		if (!spawned.ok) throw new Error(spawned.error.message);
		const loaded = await runtime.store.load(root.agentId);
		if (!loaded.ok) throw new Error(loaded.error.message);
		const orphanTerminal: AgentGraphSemanticCommand = {
			type: "agent.spawned",
			requestId: createRuntimeId("command", "orphan-spawn-terminal"),
			idempotencyKey: key("orphan-spawn-terminal"),
			occurredAt: NOW,
			intentRequestId: request.requestId,
			node: spawned.value.node,
			edge: loaded.value.projection.edges[0]!,
		};
		expect(await runtime.store.commit(root.agentId, loaded.value.revision, orphanTerminal)).toMatchObject({
			ok: false,
			error: { code: "invalid_graph" },
		});
	});

	it("requires an exact usage object for a started child semantic terminal", async () => {
		const runtime = runtimeFakes();
		const root = rootRegistration();
		expect((await runtime.supervisor.registerRoot(root)).ok).toBe(true);
		const spawned = await runtime.supervisor.spawn(spawnRequest(root.capabilityGrant));
		if (!spawned.ok) throw new Error(spawned.error.message);
		const loaded = await runtime.store.load(root.agentId);
		if (!loaded.ok) throw new Error(loaded.error.message);
		const child = loaded.value.projection.nodes.get(spawned.value.node.agentId);
		if (!child?.parentAgentId || !child.budgetReservation || !child.launchReceipt || !child.residency) {
			throw new Error("started child lacks exact launch and budget correlations");
		}

		const missingUsageRequestId = createRuntimeId("command", "terminal-missing-usage");
		const missingUsageKey = key("terminal-missing-usage");
		const missingUsage: AgentGraphSemanticCommand = {
			type: "agent.failed",
			requestId: missingUsageRequestId,
			idempotencyKey: missingUsageKey,
			occurredAt: NOW,
			agentId: child.agentId,
			from: child.state,
			reason: "crash",
			error: {
				code: "crash",
				messageDigest: digest("1"),
				retryable: false,
				outcomeCertain: true,
				effect: "none",
			},
			terminal: createAgentSemanticTerminalRecord({
				agentId: child.agentId,
				requestId: missingUsageRequestId,
				idempotencyKey: missingUsageKey,
				outcome: "failed",
				reason: "crash",
				partialResults: [],
			}),
		};
		expect(applyAgentGraphCommand(loaded.value.projection, missingUsage, DEFAULT_AGENT_GRAPH_LIMITS)).toMatchObject({
			ok: false,
			error: { code: "invalid_transition" },
		});

		const inexactUsage = { ...zeroUsage(), unexpectedCounter: 0 };
		const inexactUsageRequestId = createRuntimeId("command", "terminal-inexact-usage");
		const inexactUsageKey = key("terminal-inexact-usage");
		const inexactUsageCommand: AgentGraphSemanticCommand = {
			...missingUsage,
			requestId: inexactUsageRequestId,
			idempotencyKey: inexactUsageKey,
			terminal: createAgentSemanticTerminalRecord({
				agentId: child.agentId,
				requestId: inexactUsageRequestId,
				idempotencyKey: inexactUsageKey,
				outcome: "failed",
				reason: "crash",
				usage: inexactUsage,
				partialResults: [],
			}),
		};
		expect(applyAgentGraphCommand(loaded.value.projection, inexactUsageCommand, DEFAULT_AGENT_GRAPH_LIMITS)).toMatchObject({
			ok: false,
			error: { code: "invalid_transition" },
		});

		const exactUsageRequestId = createRuntimeId("command", "terminal-exact-usage");
		const exactUsageKey = key("terminal-exact-usage");
		const exactUsageCommand: AgentGraphSemanticCommand = {
			...missingUsage,
			requestId: exactUsageRequestId,
			idempotencyKey: exactUsageKey,
			terminal: createAgentSemanticTerminalRecord({
				agentId: child.agentId,
				requestId: exactUsageRequestId,
				idempotencyKey: exactUsageKey,
				outcome: "failed",
				reason: "crash",
				usage: zeroUsage(),
				partialResults: [],
			}),
		};
		expect(applyAgentGraphCommand(loaded.value.projection, exactUsageCommand, DEFAULT_AGENT_GRAPH_LIMITS)).toMatchObject({
			ok: true,
			value: { nodes: expect.any(Map) },
		});
	});

	it("rejects terminal usage below durable artifact and verified-label facts", async () => {
		const runtime = runtimeFakes();
		const root = rootRegistration();
		expect((await runtime.supervisor.registerRoot(root)).ok).toBe(true);
		const spawned = await runtime.supervisor.spawn(spawnRequest(root.capabilityGrant));
		if (!spawned.ok) throw new Error(spawned.error.message);
		const child = spawned.value.node;
		expect((await runtime.supervisor.reportArtifact({
			requestId: createRuntimeId("command", "usage-artifact-report"),
			idempotencyKey: key("usage-artifact-report"),
			report: {
				agentId: child.agentId,
				logicalName: "patch",
				artifact: artifact("usage-artifact", child.workspaceReceipt.workspaceId),
				integrity: "valid",
				verification: "verified",
				inputSources: child.inputSources,
				declassificationReceipts: child.declassificationReceipts,
				reportedAt: NOW,
			},
		})).ok).toBe(true);
		expect((await runtime.supervisor.recordTurn({
			requestId: createRuntimeId("command", "usage-turn"),
			idempotencyKey: key("usage-turn"),
			agentId: child.agentId,
			turnId: createRuntimeId("turn", "usage-turn"),
		})).ok).toBe(true);

		const loaded = await runtime.store.load(root.agentId);
		if (!loaded.ok) throw new Error(loaded.error.message);
		const current = loaded.value.projection.nodes.get(child.agentId);
		if (!current || current.artifacts.length !== 1 || current.turnsUsed !== 1) {
			throw new Error("durable artifact/turn facts were not recorded");
		}
		const requestId = createRuntimeId("command", "usage-underreported-artifact");
		const terminalKey = key("usage-underreported-artifact");
		const command: AgentGraphSemanticCommand = {
			type: "agent.failed",
			requestId,
			idempotencyKey: terminalKey,
			occurredAt: NOW,
			agentId: current.agentId,
			from: current.state,
			reason: "crash",
			error: {
				code: "crash",
				messageDigest: digest("8"),
				retryable: false,
				outcomeCertain: true,
				effect: "none",
			},
			terminal: createAgentSemanticTerminalRecord({
				agentId: current.agentId,
				requestId,
				idempotencyKey: terminalKey,
				outcome: "failed",
				reason: "crash",
				usage: zeroUsage(),
				partialResults: current.artifacts.map((report) => report.artifact),
			}),
		};
		expect(applyAgentGraphCommand(loaded.value.projection, command, DEFAULT_AGENT_GRAPH_LIMITS)).toMatchObject({
			ok: false,
			error: { code: "invalid_transition" },
		});

		const missingVerificationUsage = { ...zeroUsage(), artifactCount: 1 };
		expect(applyAgentGraphCommand(loaded.value.projection, {
			...command,
			terminal: createAgentSemanticTerminalRecord({
				agentId: current.agentId,
				requestId,
				idempotencyKey: terminalKey,
				outcome: "failed",
				reason: "crash",
				usage: missingVerificationUsage,
				partialResults: current.artifacts.map((report) => report.artifact),
			}),
		}, DEFAULT_AGENT_GRAPH_LIMITS)).toMatchObject({
			ok: false,
			error: { code: "invalid_transition" },
		});

		const minimumUsage = { ...missingVerificationUsage, verifications: 1 };
		expect(applyAgentGraphCommand(loaded.value.projection, {
			...command,
			terminal: createAgentSemanticTerminalRecord({
				agentId: current.agentId,
				requestId,
				idempotencyKey: terminalKey,
				outcome: "failed",
				reason: "crash",
				usage: minimumUsage,
				partialResults: current.artifacts.map((report) => report.artifact),
			}),
		}, DEFAULT_AGENT_GRAPH_LIMITS)).toMatchObject({
			ok: true,
			value: { nodes: expect.any(Map) },
		});
	});

	it("rejects malformed or uncorrelated launch receipts at graph authority", async () => {
		const runtime = runtimeFakes();
		const root = rootRegistration();
		expect((await runtime.supervisor.registerRoot(root)).ok).toBe(true);
		const spawned = await runtime.supervisor.spawn(spawnRequest(root.capabilityGrant));
		if (!spawned.ok) throw new Error(spawned.error.message);
		const loaded = await runtime.store.load(root.agentId);
		if (!loaded.ok) throw new Error(loaded.error.message);
		const child = loaded.value.projection.nodes.get(spawned.value.node.agentId);
		if (!child?.launchReceipt || !child.residency) throw new Error("started child lacks launch receipts");
		const nextRevision = child.launchReceipt.launchRevision + 1;
		const nextResidency = createAgentResidencyReceipt({
			agentId: child.agentId,
			sessionId: child.sessionId,
			runtimeInstanceId: child.residency.runtimeInstanceId,
			state: "resident",
			revision: nextRevision,
			observedAt: NOW,
		});
		if (!nextResidency.ok) throw new Error(nextResidency.error.message);
		const { receiptDigest: _oldLaunchDigest, ...previousLaunchBody } = child.launchReceipt;
		const nextLaunchWithoutDigest = {
			...previousLaunchBody,
			launchRevision: nextRevision,
			launchedAt: NOW,
		};
		const nextLaunchReceipt = {
			...nextLaunchWithoutDigest,
			receiptDigest: canonicalDigest(nextLaunchWithoutDigest),
		};

		const invalidDigest: AgentGraphSemanticCommand = {
			type: "agent.launch_recorded",
			requestId: createRuntimeId("command", "launch-invalid-digest"),
			idempotencyKey: key("launch-invalid-digest"),
			occurredAt: NOW,
			agentId: child.agentId,
			launchReceipt: { ...nextLaunchReceipt, receiptDigest: digest("7") },
			residencyReceipt: nextResidency.value,
		};
		expect(applyAgentGraphCommand(loaded.value.projection, invalidDigest, DEFAULT_AGENT_GRAPH_LIMITS)).toMatchObject({
			ok: false,
			error: { code: "invalid_graph" },
		});

		const mismatchedRevision: AgentGraphSemanticCommand = {
			...invalidDigest,
			requestId: createRuntimeId("command", "launch-mismatched-revision"),
			idempotencyKey: key("launch-mismatched-revision"),
			launchReceipt: nextLaunchReceipt,
			residencyReceipt: child.residency,
		};
		expect(applyAgentGraphCommand(loaded.value.projection, mismatchedRevision, DEFAULT_AGENT_GRAPH_LIMITS)).toMatchObject({
			ok: false,
			error: { code: "invalid_graph" },
		});

		const invalidTimestampBody = { ...nextLaunchWithoutDigest, launchedAt: "not-a-timestamp" };
		expect(applyAgentGraphCommand(loaded.value.projection, {
			...mismatchedRevision,
			requestId: createRuntimeId("command", "launch-invalid-timestamp"),
			idempotencyKey: key("launch-invalid-timestamp"),
			launchReceipt: {
				...invalidTimestampBody,
				receiptDigest: canonicalDigest(invalidTimestampBody),
			},
			residencyReceipt: nextResidency.value,
		}, DEFAULT_AGENT_GRAPH_LIMITS)).toMatchObject({
			ok: false,
			error: { code: "invalid_graph" },
		});
		expect(applyAgentGraphCommand(loaded.value.projection, {
			...invalidDigest,
			requestId: createRuntimeId("command", "launch-valid-next-revision"),
			idempotencyKey: key("launch-valid-next-revision"),
			launchReceipt: nextLaunchReceipt,
		}, DEFAULT_AGENT_GRAPH_LIMITS)).toMatchObject({
			ok: true,
			value: { nodes: expect.any(Map) },
		});
	});

	it.each([
		["stopped", "crash"],
		["failed", "cancelled"],
		["completed", "timeout"],
	] as const)("rejects the contradictory %s/%s terminal outcome matrix", async (outcome, reason) => {
		const runtime = runtimeFakes();
		const root = rootRegistration();
		expect((await runtime.supervisor.registerRoot(root)).ok).toBe(true);
		const spawned = await runtime.supervisor.spawn(spawnRequest(root.capabilityGrant));
		if (!spawned.ok) throw new Error(spawned.error.message);
		const loaded = await runtime.store.load(root.agentId);
		if (!loaded.ok) throw new Error(loaded.error.message);
		const child = loaded.value.projection.nodes.get(spawned.value.node.agentId);
		if (!child) throw new Error("spawned child vanished from graph");
		const requestId = createRuntimeId("command", `terminal-matrix-${outcome}-${reason}`);
		const terminalKey = key(`terminal-matrix-${outcome}-${reason}`);
		const terminal = createAgentSemanticTerminalRecord({
			agentId: child.agentId,
			requestId,
			idempotencyKey: terminalKey,
			outcome,
			reason,
			usage: zeroUsage(),
			partialResults: [],
		});
		const common = {
			requestId,
			idempotencyKey: terminalKey,
			occurredAt: NOW,
			agentId: child.agentId,
			from: child.state,
		};
		const command: AgentGraphSemanticCommand = outcome === "completed"
			? { ...common, type: "agent.finished", terminal }
			: outcome === "stopped"
				? { ...common, type: "agent.stopped", reason, terminal }
				: {
						...common,
						type: "agent.failed",
						reason,
						error: {
							code: "terminal_matrix",
							messageDigest: digest("6"),
							retryable: false,
							outcomeCertain: true,
							effect: "none",
						},
						terminal,
					};
		expect(applyAgentGraphCommand(loaded.value.projection, command, DEFAULT_AGENT_GRAPH_LIMITS)).toMatchObject({
			ok: false,
			error: { code: "invalid_transition" },
		});
	});

	it("permits a no-usage launch_rejected terminal only before runtime start", async () => {
		const runtime = runtimeFakes();
		const root = rootRegistration();
		expect((await runtime.supervisor.registerRoot(root)).ok).toBe(true);
		const spawned = await runtime.supervisor.spawn(spawnRequest(root.capabilityGrant));
		if (!spawned.ok) throw new Error(spawned.error.message);
		const loaded = await runtime.store.load(root.agentId);
		if (!loaded.ok) throw new Error(loaded.error.message);
		const child = loaded.value.projection.nodes.get(spawned.value.node.agentId);
		if (!child?.budgetReservation) throw new Error("child lacks its budget reservation");
		const {
			launchReceipt: _launchReceipt,
			residency: _residency,
			terminal: _terminal,
			stateReason: _stateReason,
			...unstartedBase
		} = child;
		const unstartedChild = { ...unstartedBase, state: "starting" as const };
		const nodes = new Map(loaded.value.projection.nodes);
		nodes.set(child.agentId, unstartedChild);
		const unstartedProjection = { ...loaded.value.projection, nodes };
		const requestId = createRuntimeId("command", "launch-rejected-terminal");
		const terminalKey = key("launch-rejected-terminal");
		const launchRejected: AgentGraphSemanticCommand = {
			type: "agent.failed",
			requestId,
			idempotencyKey: terminalKey,
			occurredAt: NOW,
			agentId: child.agentId,
			from: "starting",
			reason: "launch_rejected",
			error: {
				code: "launch_failed",
				messageDigest: digest("2"),
				retryable: false,
				outcomeCertain: true,
				effect: "none",
			},
			terminal: createAgentSemanticTerminalRecord({
				agentId: child.agentId,
				requestId,
				idempotencyKey: terminalKey,
				outcome: "failed",
				reason: "launch_rejected",
				partialResults: [],
			}),
		};
		expect(applyAgentGraphCommand(unstartedProjection, launchRejected, DEFAULT_AGENT_GRAPH_LIMITS)).toMatchObject({
			ok: true,
			value: { nodes: expect.any(Map) },
		});
	});

	it("rejects ordinary node mutations after a semantic terminal", async () => {
		const runtime = runtimeFakes();
		const root = rootRegistration();
		expect((await runtime.supervisor.registerRoot(root)).ok).toBe(true);
		const spawned = await runtime.supervisor.spawn(spawnRequest(root.capabilityGrant));
		if (!spawned.ok) throw new Error(spawned.error.message);
		const loaded = await runtime.store.load(root.agentId);
		if (!loaded.ok) throw new Error(loaded.error.message);
		const child = loaded.value.projection.nodes.get(spawned.value.node.agentId);
		if (!child?.budgetReservation || !child.launchReceipt || !child.residency || !child.delegationReceipt) {
			throw new Error("started child lacks mutation correlations");
		}
		const terminalRequestId = createRuntimeId("command", "terminal-before-mutations");
		const terminalKey = key("terminal-before-mutations");
		const terminal = applyAgentGraphCommand(
			loaded.value.projection,
			{
				type: "agent.failed",
				requestId: terminalRequestId,
				idempotencyKey: terminalKey,
				occurredAt: NOW,
				agentId: child.agentId,
				from: child.state,
				reason: "crash",
				error: {
					code: "crash",
					messageDigest: digest("3"),
					retryable: false,
					outcomeCertain: true,
					effect: "none",
				},
				terminal: createAgentSemanticTerminalRecord({
					agentId: child.agentId,
					requestId: terminalRequestId,
					idempotencyKey: terminalKey,
					outcome: "failed",
					reason: "crash",
					usage: zeroUsage(),
					partialResults: [],
				}),
			},
			DEFAULT_AGENT_GRAPH_LIMITS,
		);
		if (!terminal.ok) throw new Error(terminal.error.message);

		const changedResidency = createAgentResidencyReceipt({
			agentId: child.agentId,
			sessionId: child.sessionId,
			runtimeInstanceId: child.residency.runtimeInstanceId,
			state: "unavailable",
			revision: child.residency.revision + 1,
			observedAt: NOW,
		});
		if (!changedResidency.ok) throw new Error(changedResidency.error.message);
		const nested = spawnRequest(child.capabilityGrant ?? root.capabilityGrant, {
			parentAgentId: child.agentId,
			depth: child.depth + 1,
		});
		const forbidden: readonly (readonly [string, AgentGraphSemanticCommand])[] = [
			["state transition", {
				type: "agent.transitioned",
				requestId: createRuntimeId("command", "post-terminal-transition"),
				idempotencyKey: key("post-terminal-transition"),
				occurredAt: NOW,
				agentId: child.agentId,
				from: "failed",
				to: "running",
			}],
			["spawn request", {
				type: "agent.spawn_requested",
				requestId: nested.requestId,
				idempotencyKey: nested.idempotencyKey,
				occurredAt: NOW,
				intent: {
					requestId: nested.requestId,
					admissionRequestDigest: digest("4"),
					parentAgentId: nested.parentAgentId,
					childAgentId: nested.childAgentId,
					childSessionId: nested.childSessionId,
					role: nested.role,
					objectiveDigest: canonicalDigest(nested.objective),
					expectedArtifacts: nested.expectedArtifacts,
					allowPartial: nested.allowPartial,
					depth: nested.depth,
					budget: nested.budget,
					parentGrant: nested.parentGrant,
					requestedCapabilities: nested.requestedCapabilities,
					workspaceStrategy: nested.workspaceStrategy,
					inputSources: nested.inputSources,
					declassificationReceipts: nested.declassificationReceipts,
					requestedAt: NOW,
				},
			}],
			["cursor advancement", {
				type: "agent.cursor_advanced",
				requestId: createRuntimeId("command", "post-terminal-cursor"),
				idempotencyKey: key("post-terminal-cursor"),
				occurredAt: NOW,
				agentId: child.agentId,
				cursor: {
					stream: {
						scope: "session",
						streamId: createRuntimeId("eventStream", "post-terminal"),
						sessionId: child.sessionId,
					},
					sequence: 1,
					eventId: createRuntimeId("event", "post-terminal"),
					eventHash: digest("5"),
				},
			}],
			["Artifact report", {
				type: "agent.artifact_reported",
				requestId: createRuntimeId("command", "post-terminal-artifact"),
				idempotencyKey: key("post-terminal-artifact"),
				occurredAt: NOW,
				report: {
					agentId: child.agentId,
					logicalName: "patch",
					artifact: artifact("post-terminal", child.workspaceReceipt.workspaceId),
					integrity: "valid",
					verification: "verified",
					inputSources: child.inputSources,
					declassificationReceipts: child.declassificationReceipts,
					reportedAt: NOW,
				},
			}],
			["residency change", {
				type: "agent.residency_changed",
				requestId: createRuntimeId("command", "post-terminal-residency"),
				idempotencyKey: key("post-terminal-residency"),
				occurredAt: NOW,
				receipt: changedResidency.value,
			}],
			["budget rebound", {
				type: "agent.budget_rebound",
				requestId: createRuntimeId("command", "post-terminal-budget"),
				idempotencyKey: key("post-terminal-budget"),
				occurredAt: NOW,
				agentId: child.agentId,
				previousReservationId: child.budgetReservation.reservationId,
				reservation: {
					reservationId: createRuntimeId("budgetReservation", "post-terminal"),
					operationId: createRuntimeId("command", "post-terminal-budget-operation"),
					requestDigest: digest("6"),
				},
			}],
			["turn record", {
				type: "agent.turn_recorded",
				requestId: createRuntimeId("command", "post-terminal-turn"),
				idempotencyKey: key("post-terminal-turn"),
				occurredAt: NOW,
				agentId: child.agentId,
				turnId: createRuntimeId("turn", "post-terminal"),
				turnNumber: child.turnsUsed + 1,
			}],
			["launch record", {
				type: "agent.launch_recorded",
				requestId: createRuntimeId("command", "post-terminal-launch"),
				idempotencyKey: key("post-terminal-launch"),
				occurredAt: NOW,
				agentId: child.agentId,
				launchReceipt: child.launchReceipt,
				residencyReceipt: child.residency,
			}],
			["resume revalidation", {
				type: "agent.resume_revalidated",
				requestId: createRuntimeId("command", "post-terminal-resume"),
				idempotencyKey: key("post-terminal-resume"),
				occurredAt: NOW,
				agentId: child.agentId,
				delegationReceipt: child.delegationReceipt,
				workspaceReceipt: child.workspaceReceipt,
				denialReceipt: {
					receiptId: createRuntimeId("receipt", "post-terminal-denial"),
					agentId: child.agentId,
					sessionId: child.sessionId,
					status: "allowed",
					decisionRevision: 1,
					checkedAt: NOW,
					receiptDigest: digest("7"),
				},
			}],
		];

		for (const [label, command] of forbidden) {
			expect(
				applyAgentGraphCommand(terminal.value, command, DEFAULT_AGENT_GRAPH_LIMITS),
				label,
			).toMatchObject({ ok: false, error: { code: "invalid_transition" } });
		}
	});

	it.each(["unverified", "inconclusive"] as const)(
		"rejects completion with a %s artifact",
		async (verification) => {
			const runtime = runtimeFakes();
			const root = rootRegistration();
			await runtime.supervisor.registerRoot(root);
			const request = spawnRequest(root.capabilityGrant);
			const spawned = await runtime.supervisor.spawn(request);
			if (!spawned.ok) throw new Error(spawned.error.message);
			const child = spawned.value.node;
			expect((await runtime.supervisor.reportArtifact({
				requestId: createRuntimeId("command", `report-${verification}`),
				idempotencyKey: key(`report-${verification}`),
				report: {
					agentId: child.agentId,
					logicalName: "patch",
					artifact: artifact(`replay-${verification}`, child.workspaceReceipt.workspaceId),
					integrity: "valid",
					verification,
					inputSources: child.inputSources,
					declassificationReceipts: child.declassificationReceipts,
					reportedAt: NOW,
				},
			})).ok).toBe(true);
			const loaded = await runtime.store.load(root.agentId);
			if (!loaded.ok) throw new Error(loaded.error.message);
			const currentChild = loaded.value.projection.nodes.get(child.agentId);
			if (!currentChild) throw new Error("reported child vanished from graph");
			const terminalRequestId = createRuntimeId("command", `complete-${verification}`);
			const terminalKey = key(`complete-${verification}`);
			const terminal: AgentGraphSemanticCommand = {
				type: "agent.finished",
				requestId: terminalRequestId,
				idempotencyKey: terminalKey,
				occurredAt: NOW,
				agentId: child.agentId,
				from: "running",
				terminal: createAgentSemanticTerminalRecord({
					agentId: child.agentId,
					requestId: terminalRequestId,
					idempotencyKey: terminalKey,
					outcome: "completed",
					usage: { ...zeroUsage(), artifactCount: currentChild.artifacts.length },
					partialResults: currentChild.artifacts.map((report) => report.artifact),
				}),
			};
			expect(await runtime.store.commit(root.agentId, loaded.value.revision, terminal)).toMatchObject({
				ok: false,
				error: { code: "artifact_contract_mismatch" },
			});
		},
	);
});
