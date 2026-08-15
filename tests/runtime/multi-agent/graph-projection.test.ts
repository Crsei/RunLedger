import { describe, expect, it } from "vitest";
import { runtimeDigest, type RuntimeDigest } from "../../../src/runtime/protocol/foundation.ts";
import { createRuntimeId, type AgentId, type CommandId } from "../../../src/runtime/protocol/ids.ts";
import {
	createAgentGraphEventPayload,
	decodeAgentGraphEventPayload,
	type AgentGraphCommand,
	type AgentSemanticTerminalRecord,
} from "../../../src/runtime/agents/graph-events.ts";
import {
	applyAgentGraphCommand,
	createEmptyAgentGraphProjection,
	inspectAgentGraph,
	type AgentGraphProjection,
} from "../../../src/runtime/agents/graph-projection.ts";

const rootAgentId = createRuntimeId("agent", "root");
const childAgentId = createRuntimeId("agent", "child");
const policyReceiptDigest = runtimeDigest({ policy: "m1" });

function digest(seed: string): RuntimeDigest {
	return runtimeDigest({ seed });
}

function commandId(seed: string): CommandId {
	return createRuntimeId("command", seed);
}

function terminalRecord(overrides: Partial<AgentSemanticTerminalRecord> = {}): AgentSemanticTerminalRecord {
	const base = {
		spawnRequestDigest: digest("spawn-request"),
		runtimeDescriptorDigest: digest("runtime-descriptor"),
		outcome: "completed" as const,
		report: "bounded report",
		reportDigest: runtimeDigest("bounded report"),
		reportBytes: new TextEncoder().encode("bounded report").byteLength,
		usage: { modelTurns: 1, toolCalls: 2, activeDurationMs: 3 },
	};
	const withoutDigest = { ...base, ...overrides };
	return { ...withoutDigest, terminalDigest: runtimeDigest(withoutDigest) };
}

function rootCommand(overrides: Partial<Extract<AgentGraphCommand, { type: "agent.root_registered" }>> = {}): AgentGraphCommand {
	return {
		type: "agent.root_registered",
		commandId: commandId("root-register"),
		requestDigest: digest("root-request"),
		expectedRevision: 0,
		rootAgentId,
		agentId: rootAgentId,
		policyReceiptDigest,
		...overrides,
	};
}

function spawnRequestedCommand(
	overrides: Partial<Extract<AgentGraphCommand, { type: "agent.spawn_requested" }>> = {},
): AgentGraphCommand {
	return {
		type: "agent.spawn_requested",
		commandId: commandId("spawn-request"),
		requestDigest: digest("spawn-request"),
		expectedRevision: 1,
		rootAgentId,
		agentId: childAgentId,
		parentAgentId: rootAgentId,
		role: "research",
		objective: "Inspect the repository and report the relevant entry points.",
		requestedCapabilities: ["workspace.read", "workspace.search"],
		budget: { maxModelTurns: 2, maxToolCalls: 3, maxActiveDurationMs: 1000 },
		maxReportBytes: 1024,
		...overrides,
	};
}

function apply(
	state: AgentGraphProjection,
		command: AgentGraphCommand,
		graphRevision: number,
): AgentGraphProjection {
	const result = applyAgentGraphCommand(state, command, graphRevision);
	if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
	return result.value;
}

describe("bounded agent graph projection", () => {
	it("accepts the root and requested-prepared-running-terminal lifecycle", () => {
		let state = createEmptyAgentGraphProjection();
		state = apply(state, rootCommand(), 1);
		state = apply(state, spawnRequestedCommand(), 2);
		state = apply(state, {
			type: "agent.spawned",
			commandId: commandId("prepared"),
			requestDigest: digest("prepared"),
			expectedRevision: 2,
			rootAgentId,
			agentId: childAgentId,
			runtimeDescriptorDigest: digest("runtime-descriptor"),
		}, 3);
		state = apply(state, {
			type: "agent.activated",
			commandId: commandId("activated"),
			requestDigest: digest("activated"),
			expectedRevision: 3,
			rootAgentId,
			agentId: childAgentId,
			activationReceiptDigest: digest("activation"),
		}, 4);
		state = apply(state, {
			type: "agent.finished",
			commandId: commandId("finished"),
			requestDigest: digest("finished"),
			expectedRevision: 4,
			rootAgentId,
			agentId: childAgentId,
			terminal: terminalRecord(),
		}, 5);

		expect(state.revision).toBe(5);
		expect(state.nodes.get(rootAgentId)?.state).toBe("running");
		expect(state.nodes.get(childAgentId)).toMatchObject({
		state: "completed",
		role: "research",
		createdSequence: 2,
		reportBytes: 14,
	});
	});

	it("accepts failed, stopped, and reconciliation transitions only from their declared states", () => {
		let requested = apply(createEmptyAgentGraphProjection(), rootCommand(), 1);
		requested = apply(requested, spawnRequestedCommand(), 2);
		const failed = apply(requested, {
			type: "agent.failed",
			commandId: commandId("failed-requested"),
			requestDigest: digest("failed-requested"),
			expectedRevision: 2,
			rootAgentId,
			agentId: childAgentId,
			terminal: terminalRecord({ outcome: "failed", reasonCode: "runtime_failed" }),
		}, 3);
		expect(failed.nodes.get(childAgentId)?.state).toBe("failed");

		let prepared = apply(createEmptyAgentGraphProjection(), rootCommand(), 1);
		prepared = apply(prepared, spawnRequestedCommand(), 2);
		prepared = apply(prepared, {
			type: "agent.spawned",
			commandId: commandId("prepared-stop"),
			requestDigest: digest("prepared-stop"),
			expectedRevision: 2,
			rootAgentId,
			agentId: childAgentId,
			runtimeDescriptorDigest: digest("runtime-descriptor"),
		}, 3);
		const recovery = apply(prepared, {
			type: "agent.reconciliation_required",
			commandId: commandId("reconcile"),
			requestDigest: digest("reconcile"),
			expectedRevision: 3,
			rootAgentId,
			agentId: childAgentId,
			reasonCode: "activation_uncertain",
		}, 4);
		expect(recovery.nodes.get(childAgentId)?.state).toBe("recovery_required");
		const stopped = apply(recovery, {
			type: "agent.stopped",
			commandId: commandId("stopped-recovery"),
			requestDigest: digest("stopped-recovery"),
			expectedRevision: 4,
			rootAgentId,
			agentId: childAgentId,
			terminal: terminalRecord({ outcome: "stopped", reasonCode: "owner_takeover" }),
		}, 5);
		expect(stopped.nodes.get(childAgentId)?.state).toBe("stopped");
	});

	it("rejects every lifecycle transition outside the frozen transition table", () => {
		let requested = apply(createEmptyAgentGraphProjection(), rootCommand(), 1);
		requested = apply(requested, spawnRequestedCommand(), 2);
		expect(applyAgentGraphCommand(requested, {
			type: "agent.activated",
			commandId: commandId("activated-too-early"),
			requestDigest: digest("activated-too-early"),
			expectedRevision: 2,
			rootAgentId,
			agentId: childAgentId,
			activationReceiptDigest: digest("activation"),
		}, 3)).toMatchObject({ ok: false, error: { code: "invalid_request" } });
		expect(applyAgentGraphCommand(requested, {
			type: "agent.finished",
			commandId: commandId("finished-too-early"),
			requestDigest: digest("finished-too-early"),
			expectedRevision: 2,
			rootAgentId,
			agentId: childAgentId,
			terminal: terminalRecord(),
		}, 3)).toMatchObject({ ok: false, error: { code: "invalid_request" } });
		expect(applyAgentGraphCommand(requested, {
			type: "agent.reconciliation_required",
			commandId: commandId("reconcile-too-early"),
			requestDigest: digest("reconcile-too-early"),
			expectedRevision: 2,
			rootAgentId,
			agentId: childAgentId,
			reasonCode: "activation_uncertain",
		}, 3)).toMatchObject({ ok: false, error: { code: "invalid_request" } });

		const prepared = apply(requested, {
			type: "agent.spawned",
			commandId: commandId("prepared-illegal"),
			requestDigest: digest("prepared-illegal"),
			expectedRevision: 2,
			rootAgentId,
			agentId: childAgentId,
			runtimeDescriptorDigest: digest("runtime-descriptor"),
		}, 3);
		expect(applyAgentGraphCommand(prepared, {
			type: "agent.spawned",
			commandId: commandId("prepared-again"),
			requestDigest: digest("prepared-again"),
			expectedRevision: 3,
			rootAgentId,
			agentId: childAgentId,
			runtimeDescriptorDigest: digest("runtime-descriptor"),
		}, 4)).toMatchObject({ ok: false, error: { code: "invalid_request" } });
		expect(applyAgentGraphCommand(prepared, {
			type: "agent.finished",
			commandId: commandId("finished-prepared"),
			requestDigest: digest("finished-prepared"),
			expectedRevision: 3,
			rootAgentId,
			agentId: childAgentId,
			terminal: terminalRecord(),
		}, 4)).toMatchObject({ ok: false, error: { code: "invalid_request" } });

		const running = apply(prepared, {
			type: "agent.activated",
			commandId: commandId("running-illegal"),
			requestDigest: digest("running-illegal"),
			expectedRevision: 3,
			rootAgentId,
			agentId: childAgentId,
			activationReceiptDigest: digest("activation"),
		}, 4);
		expect(applyAgentGraphCommand(running, {
			type: "agent.spawned",
			commandId: commandId("spawned-running"),
			requestDigest: digest("spawned-running"),
			expectedRevision: 4,
			rootAgentId,
			agentId: childAgentId,
			runtimeDescriptorDigest: digest("runtime-descriptor"),
		}, 5)).toMatchObject({ ok: false, error: { code: "invalid_request" } });
		expect(applyAgentGraphCommand(running, {
			type: "agent.activated",
			commandId: commandId("activated-running"),
			requestDigest: digest("activated-running"),
			expectedRevision: 4,
			rootAgentId,
			agentId: childAgentId,
			activationReceiptDigest: digest("activation"),
		}, 5)).toMatchObject({ ok: false, error: { code: "invalid_request" } });
	});

	it("rejects illegal transitions, terminal mutation, and a terminal record with mismatched evidence", () => {
		let state = apply(createEmptyAgentGraphProjection(), rootCommand(), 1);
		state = apply(state, spawnRequestedCommand(), 2);
		const invalidEvidence = applyAgentGraphCommand(state, {
			type: "agent.finished",
			commandId: commandId("finished-requested"),
			requestDigest: digest("finished-requested"),
			expectedRevision: 2,
			rootAgentId,
			agentId: childAgentId,
			terminal: terminalRecord({ spawnRequestDigest: digest("wrong-request") }),
		}, 3);
		expect(invalidEvidence).toMatchObject({ ok: false, error: { code: "invalid_request" } });
		state = apply(state, {
			type: "agent.spawned",
			commandId: commandId("prepared-for-terminal"),
			requestDigest: digest("prepared-for-terminal"),
			expectedRevision: 2,
			rootAgentId,
			agentId: childAgentId,
			runtimeDescriptorDigest: digest("runtime-descriptor"),
		}, 3);
		state = apply(state, {
			type: "agent.activated",
			commandId: commandId("activated-for-terminal"),
			requestDigest: digest("activated-for-terminal"),
			expectedRevision: 3,
			rootAgentId,
			agentId: childAgentId,
			activationReceiptDigest: digest("activation"),
		}, 4);
		state = apply(state, {
			type: "agent.finished",
			commandId: commandId("finished-for-terminal"),
			requestDigest: digest("finished-for-terminal"),
			expectedRevision: 4,
			rootAgentId,
			agentId: childAgentId,
			terminal: terminalRecord(),
		}, 5);
		const illegal = applyAgentGraphCommand(state, {
			type: "agent.activated",
			commandId: commandId("after-terminal"),
			requestDigest: digest("after-terminal"),
			expectedRevision: 5,
			rootAgentId,
			agentId: childAgentId,
			activationReceiptDigest: digest("activation"),
		}, 6);
		expect(illegal).toMatchObject({ ok: false, error: { code: "invalid_request" } });

		const invalidTerminal = applyAgentGraphCommand(
			state,
			{
				type: "agent.finished",
				commandId: commandId("bad-terminal"),
				requestDigest: digest("bad-terminal"),
				expectedRevision: 5,
				rootAgentId,
				agentId: childAgentId,
				terminal: terminalRecord({ reportBytes: 1 }),
			},
			6,
		);
		expect(invalidTerminal).toMatchObject({ ok: false, error: { code: "invalid_request" } });
	});

	it("decodes exact payloads and rejects unknown keys or oversized UTF-8 text", () => {
		const command = spawnRequestedCommand();
		const payload = createAgentGraphEventPayload(command, 2);
		expect(decodeAgentGraphEventPayload("agent.spawn_requested", payload)).toMatchObject({ ok: true });
		expect(decodeAgentGraphEventPayload("agent.spawn_requested", { ...payload, unknown: true })).toMatchObject({
		ok: false,
		 error: { code: "invalid_request" },
		});
		expect(decodeAgentGraphEventPayload("agent.spawn_requested", { ...payload, objective: "目标".repeat(20_000) })).toMatchObject({
		ok: false,
		 error: { code: "limit_exceeded" },
		});
		expect(decodeAgentGraphEventPayload("agent.future", payload)).toMatchObject({
		ok: false,
		 error: { code: "invalid_request" },
		});
		const finishedPayload = createAgentGraphEventPayload({
			type: "agent.finished",
			commandId: commandId("missing-terminal"),
			requestDigest: digest("missing-terminal"),
			expectedRevision: 4,
			rootAgentId,
			agentId: childAgentId,
			terminal: terminalRecord(),
		}, 5);
		const { terminal: _terminal, ...missingTerminal } = finishedPayload;
		expect(decodeAgentGraphEventPayload("agent.finished", missingTerminal)).toMatchObject({
		ok: false,
		 error: { code: "invalid_request" },
		});
	});

	it("exposes a stable sorted inspect DTO that survives JSON round-trip", () => {
		let state = apply(createEmptyAgentGraphProjection(), rootCommand(), 1);
		state = apply(state, spawnRequestedCommand({
			commandId: commandId("spawn-z"),
			agentId: createRuntimeId("agent", "z-child"),
		}), 2);
		state = apply(state, spawnRequestedCommand({
			commandId: commandId("spawn-a"),
			agentId: createRuntimeId("agent", "a-child"),
			expectedRevision: 2,
		}), 3);

		const inspection = inspectAgentGraph(state);
		expect(inspection.nodes.map((node) => node.agentId)).toEqual([
			rootAgentId,
			createRuntimeId("agent", "z-child"),
			createRuntimeId("agent", "a-child"),
		]);
		expect(JSON.parse(JSON.stringify(inspection))).toEqual(inspection);
	});
});
