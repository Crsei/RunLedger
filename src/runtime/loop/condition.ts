/**
 * `/loop --while` / `--until` 的继续条件判定（重写 oh-my-pi `modes/loop-condition.ts`）。
 *
 * 三段语义原样保留：
 * 1. **退出码权威、stdout 忽略**：`0` 与 `1` 按 `--while`/`--until` 极性映射；
 * 2. `>1`（127/126/2 等）判为条件自身损坏 → 停止并说明，而不是当作 false 继续跑；
 * 3. 超时判 error、取消判 aborted —— 两者必须区分：deadline 是坏条件，Esc 不是。
 *
 * 执行路径与 omp 不同（D10 裁定 a）：条件命令经调用方注入的受治理 shell 端口执行
 * （Session Owner 的 ExecutionGateway + attempt + owner fence），不复用 agent 的
 * 持久 shell 会话，也不出现 raw I/O。
 */

import type { LoopConditionConfig } from "./limit.ts";

export type LoopConditionVerdict =
	/** 条件说再跑一轮。 */
	| { readonly kind: "continue" }
	/** 条件干净地判定停止。 */
	| { readonly kind: "halt"; readonly message: string }
	/** 条件命令本身损坏或超时；停止并说明原因。 */
	| { readonly kind: "error"; readonly message: string }
	/** 用户在求值中被取消；UX 由调用方负责。 */
	| { readonly kind: "aborted" };

/** 条件求值结果；由注入的受治理 shell 端口产出。 */
export interface LoopConditionExecution {
	readonly exitCode: number | undefined;
	readonly timedOut: boolean;
	readonly cancelled: boolean;
	/** 已截断的 stdout/stderr 合并输出；只用于错误消息预览。 */
	readonly output?: string;
}

export interface LoopConditionOptions {
	/** 受治理执行端口：退出码权威，stdout 忽略。 */
	readonly execute: (command: string, signal: AbortSignal) => Promise<LoopConditionExecution>;
	readonly timeoutMs: number;
	readonly signal: AbortSignal;
}

const COMMAND_PREVIEW_MAX = 80;
const OUTPUT_PREVIEW_MAX = 80;

/** 截断到宽度上限，并压成单行（状态/错误消息必须单行可显示）。 */
function bound(text: string, max: number): string {
	const single = text.replaceAll(/\s+/gu, " ").trim();
	return single.length <= max ? single : `${single.slice(0, max - 1)}…`;
}

function quoteCommand(command: string): string {
	return `\`${bound(command, COMMAND_PREVIEW_MAX)}\``;
}

/** 失败输出的第一行有内容行，供错误消息引用。 */
function previewOutput(output: string | undefined): string {
	if (output === undefined) return "";
	const line = output.split("\n").map((entry) => entry.trim()).find((entry) => entry.length > 0);
	return line === undefined ? "" : bound(line, OUTPUT_PREVIEW_MAX);
}

function formatTimeout(timeoutMs: number): string {
	return timeoutMs % 1_000 === 0 ? `${timeoutMs / 1_000}s` : `${timeoutMs}ms`;
}

/** 展示形式：`while \`bun test\` succeeds`。 */
export function describeLoopCondition(condition: LoopConditionConfig): string {
	return `${condition.until ? "until" : "while"} ${quoteCommand(condition.command)} succeeds`;
}

/**
 * 执行一次条件求值并映射为 loop 判定。**从不抛出**：spawn 失败也映射为 error，
 * 否则调用方会在坏条件上反复重试。
 */
export async function evaluateLoopCondition(
	condition: LoopConditionConfig,
	options: LoopConditionOptions,
): Promise<LoopConditionVerdict> {
	let result: LoopConditionExecution;
	try {
		result = await options.execute(condition.command, options.signal);
	} catch (error) {
		return {
			kind: "error",
			message: `Loop condition ${quoteCommand(condition.command)} could not run: ${bound(String(error), OUTPUT_PREVIEW_MAX)}. Loop stopped.`,
		};
	}
	// 超时先于取消判定：超时同样可能报告 cancelled，但两者含义不同。
	if (result.timedOut) {
		return {
			kind: "error",
			message: `Loop condition ${quoteCommand(condition.command)} timed out after ${formatTimeout(options.timeoutMs)}. Loop stopped.`,
		};
	}
	if (result.cancelled) return { kind: "aborted" };
	const exitCode = result.exitCode;
	if (exitCode === 0) {
		return condition.until
			? { kind: "halt", message: `Loop condition ${quoteCommand(condition.command)} is now satisfied. Loop stopped.` }
			: { kind: "continue" };
	}
	if (exitCode === 1) {
		return condition.until
			? { kind: "continue" }
			: { kind: "halt", message: `Loop condition ${quoteCommand(condition.command)} no longer succeeds. Loop stopped.` };
	}
	// 127/126/2 等：条件命令自身损坏，停止而不是当作 false。
	const status = exitCode === undefined ? "no exit status" : `exit ${exitCode}`;
	const preview = previewOutput(result.output);
	return {
		kind: "error",
		message: `Loop condition ${quoteCommand(condition.command)} failed (${status})${preview.length === 0 ? "" : `: ${preview}`}. Loop stopped.`,
	};
}
