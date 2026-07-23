/** Headless child Agent host：把 prepare、activation、completion 与 drain 明确分相。 */

import { Agent } from "../../agent.ts";
import type { UserAgentMessage } from "../../types.ts";
import type { EventCursor } from "../../protocol/v3/events.ts";
import { sameRuntimeEventStream } from "../../protocol/v3/events.ts";
import { parseRuntimeId, type TurnId } from "../../protocol/v3/ids.ts";
import { readAllRuntimeEvents } from "../../session/snapshot.ts";
import type { V3SessionManager } from "../../../storage/v3-session-manager.ts";
import type { ChildOperationBudget } from "./child-operation-budget.ts";
import type {
	AgentBudgetUsage,
	AgentInterruptionCause,
	AgentResult,
} from "../types.ts";

export interface HeadlessChildRuntimeFactoryContext {
	sessionEvents: ReturnType<V3SessionManager["sessionEvents"]>;
	operationBudget: ChildOperationBudget;
}

export interface HeadlessChildRuntimeHostOptions {
	manager: V3SessionManager;
	operationBudget: ChildOperationBudget;
	prompt: string | UserAgentMessage | UserAgentMessage[];
	/**
	 * factory 只能组装 Agent；模型与工具副作用必须等到 host.activate()。
	 * production caller 负责注入已经收窄到 child scope 的 model/tool adapters。
	 */
	agentFactory(context: HeadlessChildRuntimeFactoryContext): Agent;
}

export interface HeadlessChildRuntimeCompletion {
	outcome: "completed" | "failed" | "stopped";
	reason?: AgentInterruptionCause;
	usage: AgentBudgetUsage;
	turnIds: readonly TurnId[];
	finalCursor: EventCursor;
}

function unavailable(
	message: string,
): AgentResult<HeadlessChildRuntimeCompletion> {
	return {
		ok: false,
		error: {
			code: "reference_unavailable",
			message,
			retryable: true,
		},
	};
}

function terminalOutcome(
	stopReason: string | undefined,
):
	| Pick<HeadlessChildRuntimeCompletion, "outcome" | "reason">
	| undefined {
	if (stopReason === "aborted") {
		return { outcome: "stopped", reason: "cancelled" };
	}
	if (stopReason === "error") {
		return { outcome: "failed", reason: "crash" };
	}
	if (stopReason === "length") {
		return { outcome: "stopped", reason: "budget_exhausted" };
	}
	return stopReason === "stop" ? { outcome: "completed" } : undefined;
}

/**
 * 本类不拥有 manager，也不关闭 writer/lease。launcher release 必须先 interrupt/drain
 * 该 host，再按现有 authority saga stop/close manager。
 */
export class HeadlessChildRuntimeHost {
	readonly #options: HeadlessChildRuntimeHostOptions;
	#agent: Agent | undefined;
	#preparePromise: Promise<void> | undefined;
	#runPromise:
		| Promise<AgentResult<HeadlessChildRuntimeCompletion>>
		| undefined;
	#drainPromise: Promise<void> | undefined;
	#interruptRequested = false;

	public constructor(options: HeadlessChildRuntimeHostOptions) {
		this.#options = options;
	}

	/**
	 * prepare 只校验 durable child scope 并构造 Agent。不得调用 prompt、model 或 tool。
	 */
	public prepare(): Promise<void> {
		this.#preparePromise ??= Promise.resolve().then(() => {
			const manager = this.#options.manager;
			const head = manager.writer().currentHead();
			if (
				manager.isClosed() ||
				!head ||
				head.stream.scope !== "session" ||
				head.stream.sessionId !== manager.sessionId()
			) {
				throw new Error(
					"headless child runtime requires an open initialized child session",
				);
			}
			this.#agent = this.#options.agentFactory({
				sessionEvents: manager.sessionEvents(),
				operationBudget: this.#options.operationBudget,
			});
			if (!(this.#agent instanceof Agent)) {
				throw new TypeError(
					"headless child runtime factory must return an Agent",
				);
			}
		});
		return this.#preparePromise;
	}

	/**
	 * activation 只负责启动 background run，不能等待 completion。调用方必须在父 graph
	 * 的 launch_recorded/running durable barrier 之后调用。
	 */
	public async activate(): Promise<void> {
		await this.prepare();
		if (this.#runPromise) return;
		this.#runPromise = Promise.resolve().then(() => this.#run());
	}

	public completion(): Promise<
		AgentResult<HeadlessChildRuntimeCompletion>
	> {
		return (
			this.#runPromise ??
			Promise.resolve(
				unavailable(
					"headless child runtime has not crossed its activation boundary",
				),
			)
		);
	}

	/** interrupt 可重复；尚未 activation 时保留 latch，避免后续误启动 provider。 */
	public interrupt(): void {
		if (this.#interruptRequested) return;
		this.#interruptRequested = true;
		this.#agent?.interrupt();
	}

	/**
	 * drain 只等待 Agent run/queue 收敛，不把 completion fail-closed 结果改写成成功，
	 * 也不等待上层 Supervisor.finish() coordinator。
	 */
	public drain(): Promise<void> {
		if (!this.#runPromise) return Promise.resolve();
		this.#drainPromise ??= (async () => {
			await this.#runPromise;
		})();
		return this.#drainPromise;
	}

	async #run(): Promise<AgentResult<HeadlessChildRuntimeCompletion>> {
		const agent = this.#agent;
		if (!agent) {
			return unavailable(
				"headless child runtime activation lacks a prepared Agent",
			);
		}

		let stopReason: string | undefined;
		let promptFailed = false;
		if (!this.#interruptRequested) {
			try {
				const messages = await agent.prompt(this.#options.prompt);
				stopReason = [...messages]
					.reverse()
					.find((message) => message.role === "assistant")
					?.stopReason;
			} catch {
				promptFailed = true;
			}
		} else {
			stopReason = "aborted";
		}

		await agent.waitForIdle();
		const usage = await this.#options.operationBudget.usage();
		if (!usage.ok) {
			return unavailable(
				"headless child runtime usage is live, uncertain, or unavailable",
			);
		}

		const evidence = await this.#completionEvidence();
		if (!evidence.ok) return evidence;
		const outcome = promptFailed
			? ({ outcome: "failed", reason: "crash" } as const)
			: terminalOutcome(stopReason);
		if (!outcome) {
			return unavailable(
				"headless child runtime lacks a semantic terminal stop reason",
			);
		}
		return {
			ok: true,
			value: {
				...outcome,
				usage: usage.value,
				turnIds: evidence.value.turnIds,
				finalCursor: evidence.value.finalCursor,
			},
		};
	}

	async #completionEvidence(): Promise<
		AgentResult<Pick<HeadlessChildRuntimeCompletion, "turnIds" | "finalCursor">>
	> {
		const manager = this.#options.manager;
		let flushed;
		try {
			flushed = await manager.flushCurrentHead();
		} catch {
			return unavailable(
				"headless child runtime final cursor flush is unavailable",
			);
		}
		if (!flushed.ok) {
			return unavailable(
				"headless child runtime final cursor is not durable",
			);
		}
		const replay = await readAllRuntimeEvents(manager.eventStore());
		if (!replay.ok || replay.value.length === 0) {
			return unavailable(
				"headless child runtime event replay is unavailable",
			);
		}
		const last = replay.value[replay.value.length - 1]!;
		const finalCursor = flushed.value.cursor;
		if (
			!sameRuntimeEventStream(last.stream, finalCursor.stream) ||
			last.sequence !== finalCursor.sequence ||
			last.eventId !== finalCursor.eventId ||
			last.currentEventHash !== finalCursor.eventHash
		) {
			return unavailable(
				"headless child runtime final cursor does not match durable replay",
			);
		}

		const started = new Set<TurnId>();
		const terminal = new Set<TurnId>();
		const turnIds: TurnId[] = [];
		for (const event of replay.value) {
			if (event.type === "turn.started") {
				const turnId = parseRuntimeId("turn", event.payload.turnId);
				if (!turnId) {
					return unavailable(
						"headless child runtime turn start identity is invalid",
					);
				}
				if (started.has(turnId)) {
					return unavailable(
						"headless child runtime contains a duplicate turn start",
					);
				}
				started.add(turnId);
				continue;
			}
			if (
				event.type !== "turn.finished" &&
				event.type !== "turn.failed" &&
				event.type !== "turn.interrupted"
			) {
				continue;
			}
			const turnId = parseRuntimeId("turn", event.payload.turnId);
			if (!turnId) {
				return unavailable(
					"headless child runtime turn terminal identity is invalid",
				);
			}
			if (
				!started.has(turnId) ||
				terminal.has(turnId)
			) {
				return unavailable(
					"headless child runtime turn terminal evidence is uncorrelated",
				);
			}
			terminal.add(turnId);
			turnIds.push(turnId);
		}
		if (started.size !== terminal.size) {
			return unavailable(
				"headless child runtime has an unterminated durable turn",
			);
		}
		return {
			ok: true,
			value: {
				turnIds,
				finalCursor,
			},
		};
	}
}
