import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Agent } from "../../../src/runtime/agent.ts";
import { echoTool } from "../../../src/runtime/tools/echo.ts";
import { mockModel, mockStreamFn } from "../../../src/runtime/providers/mock-stream.ts";
import { FileArtifactStore } from "../../../src/runtime/trace/artifact-store.ts";
import { JsonlTraceEventStore } from "../../../src/runtime/trace/event-store.ts";
import { RuntimeTraceRecorder } from "../../../src/runtime/trace/recorder.ts";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Agent trace recorder factory", () => {
	it("creates a fresh recorder for every prompt", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-agent-traces-"));
		roots.push(root);
		const traceIds: string[] = [];
		const agent = new Agent({
			initialState: {
				systemPrompt: "trace factory",
				model: mockModel,
				tools: [echoTool],
			},
			streamFn: mockStreamFn,
			traceRecorderFactory: {
				create: async () => {
					const traceId = `trace_prompt_${traceIds.length + 1}`;
					traceIds.push(traceId);
					return new RuntimeTraceRecorder({
						eventStore: new JsonlTraceEventStore({
							filePath: join(root, `${traceId}.jsonl`),
							traceId,
						}),
						artifactStore: new FileArtifactStore({
							dataRoot: join(root, "artifacts"),
							metadataRoot: join(root, "artifact-metadata"),
						}),
						traceId,
						redactionPolicyDigest: "policy_trace_v1",
						mode: "events_and_artifacts",
						failurePolicy: "fail_closed",
					});
				},
			},
		});

		await agent.prompt("first");
		await agent.prompt("second");

		expect(traceIds).toEqual(["trace_prompt_1", "trace_prompt_2"]);
	});
});
