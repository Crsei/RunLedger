import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AssistantMessage } from "../../../src/types.ts";
import { runtimeDigest } from "../../../src/runtime/protocol/foundation.ts";
import { runAgentLoop } from "../../../src/runtime/agent-loop.ts";
import { mockModel, mockStreamFn } from "../../../src/runtime/providers/mock-stream.ts";
import type { AgentContext } from "../../../src/runtime/types.ts";
import { echoTool } from "../../../src/runtime/tools/echo.ts";
import { FileArtifactStore } from "../../../src/runtime/trace/artifact-store.ts";
import { JsonlTraceEventStore } from "../../../src/runtime/trace/event-store.ts";
import {
	RuntimeTraceRecorder,
	TraceRecordingError,
	sanitizeTraceValue,
} from "../../../src/runtime/trace/recorder.ts";
import type { RecordingFailurePolicy, RecordingMode } from "../../../src/storage/settings-manager.ts";

const roots: string[] = [];

async function createRecorder(
	clock?: { now: () => number; monotonic: () => number },
	mode: RecordingMode = "events_and_artifacts",
	failurePolicy: RecordingFailurePolicy = "fail_closed",
) {
	const root = await mkdtemp(join(tmpdir(), "runledger-trace-recorder-"));
	roots.push(root);
	const eventStore = new JsonlTraceEventStore({
		filePath: join(root, "events.jsonl"),
		traceId: "trace_recorder",
	});
	const artifactStore = new FileArtifactStore({
		dataRoot: join(root, "artifacts"),
		metadataRoot: join(root, "artifact-metadata"),
	});
	const recorder = new RuntimeTraceRecorder({
		eventStore,
		...(mode === "events_and_artifacts" ? { artifactStore } : {}),
		traceId: "trace_recorder",
		redactionPolicyDigest: "policy_trace_v1",
		mode,
		failurePolicy,
		clock,
	});
	return { root, eventStore, artifactStore, recorder };
}

afterEach(async () => {
	vi.useRealTimers();
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("RuntimeTraceRecorder", () => {
	it("exposes an idempotent explicit terminal API for non-Agent runtimes", async () => {
		const { eventStore, recorder } = await createRecorder(undefined, "events");
		const finishRun = (recorder as RuntimeTraceRecorder & {
			finishRun?: (input: {
				readonly phase: "failed";
				readonly error: { readonly code: string; readonly message: string; readonly outcomeCertain: boolean };
			}) => Promise<void>;
		}).finishRun;
		expect(finishRun).toBeTypeOf("function");
		if (finishRun === undefined) return;

		const terminal = {
			phase: "failed" as const,
			error: { code: "process_failed", message: "managed process failed", outcomeCertain: true },
		};
		await finishRun.call(recorder, terminal);
		await finishRun.call(recorder, terminal);

		const terminalEvents = (await eventStore.events()).filter((event) =>
			(event.kind === "agent" || event.kind === "trace") && event.phase === "failed"
		);
		expect(terminalEvents).toHaveLength(2);
		expect(terminalEvents).toEqual([
			expect.objectContaining({ kind: "agent", error: terminal.error, metadata: { event: "agent.failed" } }),
			expect.objectContaining({ kind: "trace", error: terminal.error, metadata: { event: "trace.failed" } }),
		]);
	});

	it("force-samples run and turn boundaries and stops the sampler when the run finishes", async () => {
		vi.useFakeTimers();
		const root = await mkdtemp(join(tmpdir(), "runledger-trace-recorder-"));
		roots.push(root);
		const eventStore = new JsonlTraceEventStore({ filePath: join(root, "events.jsonl"), traceId: "trace_lifecycle" });
		const recorder = new RuntimeTraceRecorder({
			eventStore,
			traceId: "trace_lifecycle",
			redactionPolicyDigest: "policy_trace_v1",
			mode: "events",
			failurePolicy: "fail_closed",
			metadata: { sessionId: "session_lifecycle", ownerGeneration: 4 },
		});

		await recorder.startRun();
		await recorder.recordAgentEvent({ type: "turn_start", timestamp: 1_000, turn: 1 });
		await recorder.recordAgentEvent({ type: "turn_end", timestamp: 1_100, turn: 1, stopReason: "stop" });
		await recorder.finishRun({ phase: "finished" });
		const eventsAtFinish = await eventStore.events();
		expect(eventsAtFinish.filter((event) => event.observation?.kind === "runtime_memory")).toHaveLength(4);

		await vi.advanceTimersByTimeAsync(2_200);
		expect(await eventStore.events()).toHaveLength(eventsAtFinish.length);
	});

	it("redacts credentials, auth headers, and environment values", () => {
		const value = sanitizeTraceValue({
			apiKey: "sk-secret",
			headers: { authorization: "Bearer secret" },
			env: { OPIK_API_KEY: "secret" },
			text: "password=hunter2 Authorization: Bearer inline-secret",
		});

		expect(value).toMatchObject({
			apiKey: "[REDACTED]",
			headers: "[REDACTED]",
			env: "[REDACTED]",
			text: "password=[REDACTED_CREDENTIAL] Authorization: [REDACTED_CREDENTIAL]",
		});
	});

	it("records safe model context, provider usage, cost, and monotonic duration", async () => {
		let wall = 1_000;
		let monotonic = 10;
		const { artifactStore, eventStore, recorder } = await createRecorder({
			now: () => wall,
			monotonic: () => monotonic,
		});

		await recorder.startRun({ agentId: "session_1" });
		await recorder.recordAgentEvent({ type: "turn_start", timestamp: wall, turn: 1 });
		const handle = await recorder.startModel({
			turn: 1,
			model: mockModel,
			context: {
				systemPrompt: "safe system prompt",
				messages: [{
					role: "assistant",
					content: [{ type: "thinking", thinking: "private reasoning must not persist" }],
					api: "mock",
					provider: "mock",
					model: "mock-1",
					usage: {
						input: 1,
						output: 2,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 3,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop",
					timestamp: wall,
				}],
				tools: [],
			},
		});

		wall = 1_125;
		monotonic = 135;
		const message: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "done" }],
			api: "mock",
			provider: "mock",
			model: "mock-1",
			usage: {
				input: 12,
				output: 8,
				cacheRead: 3,
				cacheWrite: 1,
				reasoning: 2,
				totalTokens: 24,
				cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 },
			},
			stopReason: "stop",
			timestamp: wall,
		};
		await recorder.finishModel(handle, message);

		const modelEvents = (await eventStore.events()).filter((event) => event.kind === "model");
		const finished = modelEvents.find((event) => event.phase === "finished");
		expect(finished).toMatchObject({
			name: "model:mock/mock-1",
			durationMs: 125,
			usage: {
				inputTokens: 12,
				outputTokens: 8,
				cacheReadTokens: 3,
				cacheWriteTokens: 1,
				reasoningTokens: 2,
				source: "provider_reported",
			},
			cost: { usdMicros: 3000, source: "provider", billable: true },
		});
		expect(finished?.inputContent).toMatchObject({ storage: "artifact" });
		expect(finished?.outputContent).toMatchObject({ storage: "artifact" });

		const contextRef = finished?.inputContent;
		expect(contextRef).toBeDefined();
		if (contextRef?.storage !== "artifact") throw new Error("expected artifact content");
		const contextText = new TextDecoder().decode(await artifactStore.read(contextRef));
		expect(contextText).toContain("safe system prompt");
		expect(contextText).not.toContain("private reasoning must not persist");
		expect(contextText).toContain("redacted");
	});

	it("events mode records digest-only content without creating artifacts", async () => {
		const { root, eventStore, recorder } = await createRecorder(undefined, "events");
		await recorder.startRun();
		await recorder.startModel({
			turn: 1,
			model: mockModel,
			context: { systemPrompt: "safe", messages: [], tools: [] },
		});

		const model = (await eventStore.events()).find((event) => event.kind === "model");
		expect(model?.inputContent).toMatchObject({
			storage: "digest_only",
			mediaType: "application/json",
		});
		expect(existsSync(join(root, "artifacts"))).toBe(false);
		expect(existsSync(join(root, "artifact-metadata"))).toBe(false);
	});

	it("records managed-process output as one idempotent safe tool attempt", async () => {
		const { eventStore, recorder } = await createRecorder(undefined, "events");
		const sourceDigest = runtimeDigest("managed-process-output");
		const recordDigest = runtimeDigest({ mode: "events", sourceDigest });
		const input = {
			executionId: "execution_trace_process",
			attemptId: "attempt_trace_process_1",
			mode: "events" as const,
			sourceDigest,
			recordDigest,
			outputContent: {
				storage: "digest_only" as const,
				digest: sourceDigest.digest,
				mediaType: "text/plain; charset=utf-8",
				size: 12,
			},
		};

		await recorder.recordManagedProcessOutput(input);
		await recorder.recordManagedProcessOutput(input);

		const events = await eventStore.events();
		const materialized = events.filter((event) => event.metadata?.event === "process.output_materialized");
		expect(materialized).toHaveLength(1);
		expect(materialized[0]).toMatchObject({
			kind: "tool_attempt",
			outputContent: { storage: "digest_only", digest: sourceDigest.digest },
			metadata: {
				executionId: input.executionId,
				attemptId: input.attemptId,
				mode: "events",
				recordDigest: recordDigest.digest,
			},
		});
		expect(JSON.stringify(materialized[0])).not.toMatch(/(?:pid|command|cwd|env|locator)/iu);
	});

	it("best_effort degrades after an Event Store failure", async () => {
		const diagnostics: string[] = [];
		const recorder = new RuntimeTraceRecorder({
			eventStore: {
				append: async () => { throw new Error("disk unavailable"); },
				events: async () => [],
			},
			traceId: "trace_best_effort",
			redactionPolicyDigest: "policy_trace_v1",
			mode: "events",
			failurePolicy: "best_effort",
			onDiagnostic: (diagnostic) => diagnostics.push(diagnostic.code),
		});

		await expect(recorder.startRun()).resolves.toBeUndefined();
		expect(recorder.status).toBe("degraded");
		expect(diagnostics).toEqual(["event_store_write_failed"]);
	});

	it("stops Artifact Store writes after an Event Store failure", async () => {
		let artifactWrites = 0;
		const recorder = new RuntimeTraceRecorder({
			eventStore: {
				append: async () => { throw new Error("disk unavailable"); },
				events: async () => [],
			},
			artifactStore: {
				put: async () => {
					artifactWrites += 1;
					throw new Error("unexpected artifact write");
				},
			},
			traceId: "trace_no_orphans",
			redactionPolicyDigest: "policy_trace_v1",
			mode: "events_and_artifacts",
			failurePolicy: "best_effort",
		});

		await recorder.startRun();
		await recorder.startModel({
			turn: 1,
			model: mockModel,
			context: { systemPrompt: "safe", messages: [], tools: [] },
		});
		expect(artifactWrites).toBe(0);
	});

	it("fail_closed surfaces an Event Store failure", async () => {
		const recorder = new RuntimeTraceRecorder({
			eventStore: {
				append: async () => { throw new Error("disk unavailable"); },
				events: async () => [],
			},
			traceId: "trace_fail_closed",
			redactionPolicyDigest: "policy_trace_v1",
			mode: "events",
			failurePolicy: "fail_closed",
		});

		await expect(recorder.startRun()).rejects.toBeInstanceOf(TraceRecordingError);
		expect(recorder.status).toBe("failed");
	});

	it("best_effort falls back to digest-only when Artifact Store fails", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-trace-recorder-"));
		roots.push(root);
		const eventStore = new JsonlTraceEventStore({
			filePath: join(root, "events.jsonl"),
			traceId: "trace_artifact_failure",
		});
		let artifactWrites = 0;
		const recorder = new RuntimeTraceRecorder({
			eventStore,
			artifactStore: { put: async () => {
				artifactWrites += 1;
				throw new Error("artifact unavailable");
			} },
			traceId: "trace_artifact_failure",
			redactionPolicyDigest: "policy_trace_v1",
			mode: "events_and_artifacts",
			failurePolicy: "best_effort",
		});

		await recorder.startModel({
			turn: 1,
			model: mockModel,
			context: { systemPrompt: "safe", messages: [], tools: [] },
		});
		await recorder.startModel({
			turn: 2,
			model: mockModel,
			context: { systemPrompt: "safe again", messages: [], tools: [] },
		});

		const model = (await eventStore.events()).find((event) => event.kind === "model");
		expect(model?.inputContent).toMatchObject({ storage: "digest_only" });
		expect(recorder.status).toBe("degraded");
		expect(artifactWrites).toBe(1);
	});

	it("connects agent loop model and tool lifecycle to a replayable tree", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-trace-recorder-"));
		roots.push(root);
		const eventStore = new JsonlTraceEventStore({ filePath: join(root, "events.jsonl"), traceId: "trace_agent_loop" });
		const recorder = new RuntimeTraceRecorder({
			eventStore,
			traceId: "trace_agent_loop",
			redactionPolicyDigest: "policy_trace_v1",
			mode: "events",
			failurePolicy: "fail_closed",
			metadata: { sessionId: "session_agent_loop", ownerGeneration: 7 },
		});
		const context: AgentContext = { messages: [], tools: [echoTool] };
		await runAgentLoop(
			[{ role: "user", content: [{ type: "text", text: "hello" }] }],
			context,
			{
				model: mockModel,
				traceRecorder: recorder,
				shouldStopAfterTurn: () => true,
			},
			async () => undefined,
			undefined,
			mockStreamFn,
		);

		const events = await eventStore.events();
		expect(events.some((event) => event.kind === "trace" && event.phase === "finished")).toBe(true);
		expect(events.some((event) => event.kind === "turn" && event.phase === "finished")).toBe(true);
		expect(events.some((event) => event.kind === "model" && event.phase === "finished")).toBe(true);
		expect(events.some((event) => event.kind === "tool" && event.phase === "finished")).toBe(true);
		expect(events.filter((event) => event.kind === "context")).toHaveLength(1);
		const logicalState = events.find((event) => event.observation?.kind === "logical_session_state")?.observation;
		expect(logicalState).toMatchObject({
			kind: "logical_session_state",
			correlation: { ownerGeneration: 7 },
			contextCurrentTokens: { availability: "available", accuracy: "estimated" },
		});
		const model = events.find((event) => event.kind === "model" && event.phase === "finished");
		const tool = events.find((event) => event.kind === "tool" && event.phase === "finished");
		expect(tool?.parentNodeId).toBe(model?.nodeId);
	});
});
