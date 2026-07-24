import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalDigest } from "../../../src/runtime/protocol/v3/canonical-json.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/v3/ids.ts";
import type { ArtifactRef } from "../../../src/runtime/protocol/v3/capability.ts";
import {
	createCompactedHistoryProjection,
} from "../../../src/runtime/context/compaction/projection.ts";
import type { CompactionCheckpointRef } from "../../../src/runtime/context/compaction/types.ts";
import {
	CompactionSummaryContextProvider,
	SessionCompactionModelHistoryProjection,
	buildCompactionSourceHistory,
} from "../../../src/runtime/integration/compaction-model-history.ts";
import type { ModelRequestPreparationInput } from "../../../src/runtime/types.ts";
import type { ModelRouteDecision } from "../../../src/runtime/model-routing/types.ts";
import { DEFAULT_RUNTIME_FEATURES } from "../../../src/runtime/runtime-features.ts";
import { V3SessionManager } from "../../../src/storage/v3-session-manager.ts";
import { readAllRuntimeEvents } from "../../../src/runtime/session/snapshot.ts";

const roots: string[] = [];
const managers: V3SessionManager[] = [];

afterEach(async () => {
	await Promise.all(managers.splice(0).map((manager) => manager.closeAll().catch(() => undefined)));
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function artifact(
	manager: V3SessionManager,
	key: string,
	digest: string,
): ArtifactRef {
	const identity = manager.identity();
	return {
		authorityId: identity.authorityId,
		tenantId: identity.tenantId,
		artifactId: createRuntimeId("artifact", key),
		storedDigest: digest,
		kind: "session_report",
		originalSize: 1,
		storedSize: 1,
		mediaType: "text/markdown",
		redaction: "metadata_only",
		transformReceipt: createRuntimeId("receipt", key),
	};
}

describe("production compaction model projection", () => {
	it("builds stable source entries without inventing sequences for parallel tool batches", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-compaction-source-"));
		roots.push(root);
		const manager = await V3SessionManager.create({
			cwd: root,
			sessionDir: join(root, "sessions"),
			features: { ...DEFAULT_RUNTIME_FEATURES, sessionV3: true },
		});
		managers.push(manager);
		const first = await manager.sessionEvents().beginTurn();
		await manager.sessionEvents().recordMessage({
			role: "user",
			content: [{ type: "text", text: "first request" }],
		});
		await manager.sessionEvents().recordMessage({
			role: "assistant",
			content: [{ type: "text", text: "first answer" }],
			stopReason: "stop",
		});
		await manager.sessionEvents().finishTurn(first, { ok: true }, "stop");
		const firstFlush = await manager.flushCurrentHead();
		if (!firstFlush.ok) throw new Error(firstFlush.error.message);
		const replay = await readAllRuntimeEvents(manager.eventStore());
		if (!replay.ok) throw new Error(replay.error.message);
		expect(buildCompactionSourceHistory(replay.value)).toMatchObject({
			ok: true,
			entries: [
				expect.objectContaining({
					turnId: first.turnId,
					kind: "user",
					content: "first request",
					stable: true,
					turnCompleted: false,
				}),
				expect.objectContaining({
					turnId: first.turnId,
					kind: "assistant",
					content: "first answer",
					stable: true,
					turnCompleted: true,
				}),
			],
		});

		const second = await manager.sessionEvents().beginTurn();
		await manager.sessionEvents().recordMessage({
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: "provider-call-a",
					name: "read",
					arguments: { path: "a.txt" },
				},
				{
					type: "toolCall",
					id: "provider-call-b",
					name: "read",
					arguments: { path: "b.txt" },
				},
			],
			stopReason: "toolUse",
		});
		await manager.sessionEvents().recordMessage({
			role: "toolResult",
			content: [
				{
					type: "toolResult",
					toolCallId: "provider-call-a",
					toolName: "read",
					content: [{ type: "text", text: "tool output a" }],
				},
				{
					type: "toolResult",
					toolCallId: "provider-call-b",
					toolName: "read",
					content: [{ type: "text", text: "tool output b" }],
				},
			],
		});
		await manager.sessionEvents().finishTurn(second, { ok: true }, "stop");
		const secondFlush = await manager.flushCurrentHead();
		if (!secondFlush.ok) throw new Error(secondFlush.error.message);
		const withTools = await readAllRuntimeEvents(manager.eventStore());
		if (!withTools.ok) throw new Error(withTools.error.message);
		const projected = buildCompactionSourceHistory(withTools.value);
		expect(projected).toMatchObject({
			ok: true,
			entries: [
				expect.anything(),
				expect.anything(),
				expect.objectContaining({
					kind: "tool_call",
					toolCallId: "provider-call-a",
				}),
				expect.objectContaining({
					kind: "tool_call",
					toolCallId: "provider-call-b",
				}),
				expect.objectContaining({
					kind: "tool_result",
					toolCallId: "provider-call-a",
				}),
				expect.objectContaining({
					kind: "tool_result",
					toolCallId: "provider-call-b",
					turnCompleted: true,
				}),
			],
		});
		if (!projected.ok) throw new Error(projected.message);
		const parallelSequences = projected.entries
			.filter((entry) =>
				entry.toolCallId === "provider-call-a" ||
				entry.toolCallId === "provider-call-b")
			.map((entry) => entry.sequence);
		expect(new Set(parallelSequences).size).toBe(2);
		expect(projected.toolPairingDigest).toMatch(/^[a-f0-9]{64}$/);
	});

	it("rebuilds only the canonical post-checkpoint tail and injects summary separately", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-compaction-model-"));
		roots.push(root);
		const manager = await V3SessionManager.create({
			cwd: root,
			sessionDir: join(root, "sessions"),
			features: { ...DEFAULT_RUNTIME_FEATURES, sessionV3: true },
		});
		managers.push(manager);
		await manager.sessionEvents().recordMessage({
			role: "user",
			content: [{ type: "text", text: "compacted old message" }],
			timestamp: 1,
		});
		const tailStart = (manager.writer().currentHead()?.sequence ?? 0) + 1;
		await manager.sessionEvents().recordMessage({
			role: "user",
			content: [{ type: "text", text: "retained canonical tail" }],
			timestamp: 2,
		});
		const flushed = await manager.writer().flush();
		if (!flushed.ok) throw new Error(flushed.error.message);
		const identity = manager.identity();
		const summary = "Audited compacted summary";
		const summaryDigest = canonicalDigest(summary);
		const replacementDigest = canonicalDigest("replacement");
		const checkpointBody = {
			schemaVersion: 1 as const,
			authorityId: identity.authorityId,
			tenantId: identity.tenantId,
			checkpointId: createRuntimeId("checkpoint", "model-projection"),
			compactionId: createRuntimeId("compaction", "model-projection"),
			sessionId: manager.sessionId(),
			sourceFromSequence: 1,
			sourceToSequence: tailStart - 1,
			retainedFromSequence: tailStart,
			survivingSuffixFromSequence: tailStart,
			summaryArtifact: artifact(manager, "summary-model-projection", summaryDigest),
			summaryDigest,
			replacementHistoryArtifact: artifact(manager, "replacement-model-projection", replacementDigest),
			replacementHistoryDigest: replacementDigest,
			invariantDigest: canonicalDigest("invariants"),
		};
		const checkpoint: CompactionCheckpointRef = {
			...checkpointBody,
			checkpointDigest: canonicalDigest(checkpointBody),
		};
		const installed = createCompactedHistoryProjection(checkpoint, summary, []);
		const projection = { load: async () => installed };
		const history = new SessionCompactionModelHistoryProjection({
			events: manager.eventStore(),
			projection,
		});
		const input = {
			turn: 2,
			turnId: createRuntimeId("turn", "model-projection"),
			model: {
				id: "fixture",
				name: "fixture",
				api: "openai-completions" as const,
				provider: "fixture",
				baseUrl: "https://example.invalid",
				reasoning: false,
				input: ["text"] as const,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 8_192,
				maxTokens: 1_024,
			},
			context: { messages: [] },
			messages: [],
		} satisfies ModelRequestPreparationInput;
		const projected = await history.project(input);
		expect(projected.agentMessages).toEqual([
			expect.objectContaining({
				role: "user",
				content: [{ type: "text", text: "retained canonical tail" }],
			}),
		]);

		const route = {
			schemaVersion: 2,
			authorityId: identity.authorityId,
			tenantId: identity.tenantId,
			principalId: identity.principalId,
			decisionId: createRuntimeId("receipt", "model-projection-route"),
			requestId: createRuntimeId("command", "model-projection-route"),
			sessionId: manager.sessionId(),
			alias: "builder",
			outcome: "compatible",
			targetModelId: "fixture/fixture",
			profileId: createRuntimeId("resource", "model-projection-profile"),
			manifestDigest: canonicalDigest("manifest"),
			profileDigest: canonicalDigest("profile"),
			decisionDigest: canonicalDigest("decision"),
			reason: "fixture",
			adapterStateTransfer: "none",
		} satisfies Extract<ModelRouteDecision, { outcome: "compatible" }>;
		const fragments = await new CompactionSummaryContextProvider(projection).load({
			input,
			contextRequestId: createRuntimeId("contextRequest", "model-projection"),
			sessionId: manager.sessionId(),
			route,
			traceId: createRuntimeId("trace", "model-projection"),
		});
		expect(fragments.fragments).toEqual([
			expect.objectContaining({
				content: summary,
				contentDigest: summaryDigest,
				provenance: expect.objectContaining({ artifact: checkpoint.summaryArtifact }),
			}),
		]);
	});
});
