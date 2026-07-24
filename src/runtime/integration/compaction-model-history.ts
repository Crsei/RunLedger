/** 已安装 compaction checkpoint -> model-visible summary + canonical raw tail。 */

import { canonicalDigest, canonicalJson } from "../protocol/v3/canonical-json.ts";
import { createRuntimeId } from "../protocol/v3/ids.ts";
import type { RuntimeEventStore } from "../session/event-store.ts";
import type { RuntimeEventV3 } from "../protocol/v3/events.ts";
import { readAllRuntimeEvents } from "../session/snapshot.ts";
import { replayConversationEvents } from "../session/conversation-replay.ts";
import { defaultConvertToLlm } from "../agent-loop.ts";
import type { AgentMessage } from "../types.ts";
import type { ContextFragment } from "../context/types.ts";
import type { CompactedHistoryProjection } from "../context/compaction/projection.ts";
import type {
	GovernedContextFragmentRequest,
	GovernedContextFragmentResult,
	GovernedContextFragmentProvider,
	ModelHistoryProjection,
	ModelHistoryProjectionPort,
} from "./governed-model-request.ts";
import {
	compactionToolPairing,
	type CompactionSourceEntry,
} from "../context/compaction/cut-planner.ts";

export type CompactionSourceHistoryResult =
	| {
			ok: true;
			entries: readonly CompactionSourceEntry[];
			toolPairingDigest: string;
	  }
	| {
			ok: false;
			code: "conversation_replay_failed" | "orphan_conversation_message";
			message: string;
	  };

type ProjectedCompactionEntry = Pick<
	CompactionSourceEntry,
	"kind" | "content" | "contentDigest" | "toolCallId" | "artifact"
>;

function projectedMessageEntries(
	message: AgentMessage,
): readonly ProjectedCompactionEntry[] {
	if (message.role === "user") {
		return message.content.map((part) => ({
			kind: "user" as const,
			content: part.text,
			contentDigest: canonicalDigest(part.text),
		}));
	}
	if (message.role === "assistant") {
		return message.content.flatMap<ProjectedCompactionEntry>((part) => {
			if (part.type === "text") {
				return [{
					kind: "assistant" as const,
					content: part.text,
					contentDigest: canonicalDigest(part.text),
				}];
			}
			if (part.type === "toolCall") {
				const content = canonicalJson({
					name: part.name,
					arguments: part.arguments,
				});
				return [{
					kind: "tool_call" as const,
					content,
					contentDigest: canonicalDigest(content),
					toolCallId: part.id,
				}];
			}
			// Provider-private reasoning/signatures are intentionally outside summaries.
			return [];
		});
	}
	return message.content.map((part) => {
		const content = canonicalJson({
			toolName: part.toolName,
			isError: part.isError === true,
			content: part.content.flatMap((item) =>
				item.type === "text" ? [item.text] : []),
		});
		return {
			kind: "tool_result" as const,
			content,
			contentDigest: canonicalDigest(content),
			toolCallId: part.toolCallId,
			...(part.artifactRef === undefined
				? {}
				: { artifact: part.artifactRef }),
		};
	});
}

/**
 * 从 canonical conversation events 投影完整 turn 与 parallel tool batch。
 * 同一 event 的多 entry 保留真实 sequence，并用 sequenceIndex 排序，绝不伪造 event sequence。
 */
export function buildCompactionSourceHistory(
	events: readonly RuntimeEventV3[],
): CompactionSourceHistoryResult {
	const entries: CompactionSourceEntry[] = [];
	const indexesByTurn = new Map<string, number[]>();
	let activeTurnId: string | undefined;
	for (const event of events) {
		if (event.type === "turn.started") {
			const startedTurnId = event.payload.turnId;
			activeTurnId = startedTurnId;
			indexesByTurn.set(startedTurnId, []);
			continue;
		}
		if (event.type === "conversation.message_recorded") {
			if (!activeTurnId) {
				return {
					ok: false,
					code: "orphan_conversation_message",
					message: "conversation message is not bound to a durable turn",
				};
			}
			const replayed = replayConversationEvents([event]);
			if (!replayed.ok || replayed.value.length !== 1) {
				return {
					ok: false,
					code: "conversation_replay_failed",
					message: "canonical conversation message could not be decoded for compaction",
				};
			}
			const projectedEntries = projectedMessageEntries(replayed.value[0]!);
			for (const [sequenceIndex, projected] of projectedEntries.entries()) {
				const entry: CompactionSourceEntry = {
					sequence: event.sequence,
					sequenceIndex,
					turnId: activeTurnId,
					...projected,
					stable: false,
					turnCompleted: false,
					inputSources: [],
					declassificationReceipts: [],
				};
				indexesByTurn.get(activeTurnId)?.push(entries.length);
				entries.push(entry);
			}
			continue;
		}
		if (
			event.type === "turn.finished" ||
			event.type === "turn.failed" ||
			event.type === "turn.interrupted"
		) {
			const indexes = indexesByTurn.get(event.payload.turnId) ?? [];
			for (const index of indexes) {
				const current = entries[index];
				if (current) entries[index] = { ...current, stable: true };
			}
			const last = indexes.at(-1);
			if (last !== undefined && entries[last]) {
				entries[last] = { ...entries[last]!, turnCompleted: true };
			}
			if (activeTurnId === event.payload.turnId) activeTurnId = undefined;
		}
	}
	return {
		ok: true,
		entries,
		toolPairingDigest: compactionToolPairing(entries).digest,
	};
}

export interface InstalledCompactionProjectionPort {
	load(): Promise<CompactedHistoryProjection | undefined>;
}

export class SessionCompactionModelHistoryProjection implements ModelHistoryProjectionPort {
	readonly #events: RuntimeEventStore;
	readonly #projection: InstalledCompactionProjectionPort;

	public constructor(options: {
		events: RuntimeEventStore;
		projection: InstalledCompactionProjectionPort;
	}) {
		this.#events = options.events;
		this.#projection = options.projection;
	}

	public async project(
		input: Parameters<ModelHistoryProjectionPort["project"]>[0],
		signal?: AbortSignal,
	): Promise<ModelHistoryProjection> {
		if (signal?.aborted) throw new Error("compaction history projection was aborted");
		const installed = await this.#projection.load();
		if (!installed) {
			const body = {
				agentMessages: input.messages,
				llmMessages: input.context.messages,
			};
			return { ...body, projectionDigest: canonicalDigest(body) };
		}
		const replay = await readAllRuntimeEvents(this.#events);
		if (!replay.ok) throw new Error(`compaction history replay failed: ${replay.error.code}`);
		const tailEvents = replay.value.filter(
			(event) => event.sequence >= installed.checkpoint.survivingSuffixFromSequence,
		);
		const decoded = replayConversationEvents(tailEvents);
		if (!decoded.ok) throw new Error(`compaction history decode failed: ${decoded.error.code}`);
		const agentMessages = [...decoded.value];
		const llmMessages = defaultConvertToLlm(agentMessages);
		const body = { agentMessages, llmMessages };
		return { ...body, projectionDigest: canonicalDigest(body) };
	}
}

/** Summary 作为独立 fragment 注入；不会伪造 user/assistant/tool 消息。 */
export class CompactionSummaryContextProvider implements GovernedContextFragmentProvider {
	readonly #projection: InstalledCompactionProjectionPort;

	public constructor(projection: InstalledCompactionProjectionPort) {
		this.#projection = projection;
	}

	public async load(
		request: GovernedContextFragmentRequest,
	): Promise<GovernedContextFragmentResult> {
		const installed = await this.#projection.load();
		if (!installed) return { fragments: [] };
		const checkpoint = installed.checkpoint;
		if (
			checkpoint.authorityId !== request.route.authorityId ||
			checkpoint.tenantId !== request.route.tenantId ||
			checkpoint.sessionId !== request.sessionId ||
			canonicalDigest(installed.summary) !== checkpoint.summaryDigest
		) throw new Error("installed compaction summary is outside the governed request scope");
		const fragment: ContextFragment = {
			schemaVersion: 1,
			authorityId: checkpoint.authorityId,
			tenantId: checkpoint.tenantId,
			fragmentId: createRuntimeId(
				"resource",
				`compaction-summary-${checkpoint.checkpointId.slice(-48)}`,
			),
			layer: "session_memory",
			order: 25,
			contentDigest: checkpoint.summaryDigest,
			trust: "derived",
			taint: ["model_generated"],
			inputSources: [],
			declassificationReceipts: [],
			priority: "required",
			maxTokens: Math.max(1, installed.summary.length),
			maxChars: Math.max(1, installed.summary.length),
			provenance: {
				authorityId: checkpoint.authorityId,
				tenantId: checkpoint.tenantId,
				kind: "artifact",
				artifact: checkpoint.summaryArtifact,
				sourceDigest: checkpoint.summaryDigest,
				observedAt: new Date().toISOString(),
			},
			storage: "inline",
			content: installed.summary,
		};
		return { fragments: [fragment] };
	}
}
