/**
 * `/loop` 的迭代预算解析与运行时（移植 oh-my-pi `modes/loop-limit.ts`）。
 *
 * 与参考实现的差异：
 * - `LoopLimitRuntime` 不可变；消耗迭代返回新值而不是原地减 1，避免调用方忘记
 *   写回导致无限循环。
 * - 无显式 limit 时由 `settings.loop.maxIterations` 提供硬上限（参考实现无上限）。
 * - `readShellWord` 内联为最小的引号/转义解析器（本仓库无 shell tokenizer 依赖）。
 */

export type LoopLimitConfig =
	| { readonly kind: "iterations"; readonly iterations: number }
	| { readonly kind: "duration"; readonly durationMs: number };

export type LoopLimitRuntime =
	| { readonly kind: "iterations"; readonly initial: number; readonly remaining: number }
	| { readonly kind: "duration"; readonly durationMs: number; readonly deadlineMs: number };

const TIME_UNITS_MS: Record<string, number> = {
	s: 1_000, sec: 1_000, secs: 1_000, second: 1_000, seconds: 1_000,
	m: 60_000, min: 60_000, mins: 60_000, minute: 60_000, minutes: 60_000,
	h: 3_600_000, hr: 3_600_000, hrs: 3_600_000, hour: 3_600_000, hours: 3_600_000,
};

export const LOOP_USAGE =
	"Usage: /loop [count|duration] [--reset|--compact] [--while|--until '<command>'] [prompt]. Examples: /loop 10, /loop 10m, /loop 20 --until 'bun test' fix the failing tests.";

/** `--while` 在命令成功时继续；`--until` 在命令失败时继续。 */
const CONDITION_FLAGS: Record<string, boolean> = { "--while": false, "--until": true };

export interface LoopConditionConfig {
	readonly command: string;
	/** true 表示 `--until`（命令失败即继续）。 */
	readonly until: boolean;
}

export interface ParsedLoopArgs {
	readonly action?: "reset" | "compact";
	readonly limit?: LoopLimitConfig;
	readonly condition?: LoopConditionConfig;
	readonly prompt?: string;
}

/**
 * 解析 `/loop` 参数。形状像 limit（数字/符号开头）或 flag（`--` 开头）但解析失败
 * 必须硬报错，否则拼写错误会静默变成 prompt 文本。返回字符串即错误消息。
 */
export function parseLoopArgs(args: string): ParsedLoopArgs | string {
	const trimmed = args.trim();
	if (trimmed.length === 0) return {};

	const limitResult = takeLoopLimit(trimmed);
	if (typeof limitResult === "string") return limitResult;

	const conditionResult = takeLoopCondition(limitResult.rest);
	if (typeof conditionResult === "string") return conditionResult;

	return {
		...(limitResult.limit === undefined ? {} : { limit: limitResult.limit }),
		...(conditionResult.condition === undefined ? {} : { condition: conditionResult.condition }),
		...(conditionResult.action === undefined ? {} : { action: conditionResult.action }),
		...(conditionResult.rest.length === 0 ? {} : { prompt: conditionResult.rest }),
	};
}

/** 读取一个 shell 词：单/双引号与反斜杠转义；未闭合引号返回 "unterminated"。 */
export function readShellWord(text: string): { readonly value: string; readonly rest: string } | "unterminated" | undefined {
	let i = 0;
	while (i < text.length && /\s/.test(text[i]!)) i += 1;
	if (i >= text.length) return undefined;
	let value = "";
	let inSingle = false;
	let inDouble = false;
	for (; i < text.length; i += 1) {
		const ch = text[i]!;
		if (inSingle) {
			if (ch === "'") { inSingle = false; continue; }
			value += ch;
			continue;
		}
		if (inDouble) {
			if (ch === "\\" && i + 1 < text.length) {
				const next = text[i + 1]!;
				if (next === '"' || next === "\\" || next === "$" || next === "`") { value += next; i += 1; continue; }
			}
			if (ch === '"') { inDouble = false; continue; }
			value += ch;
			continue;
		}
		if (ch === "'") { inSingle = true; continue; }
		if (ch === '"') { inDouble = true; continue; }
		if (ch === "\\" && i + 1 < text.length) { value += text[i + 1]!; i += 1; continue; }
		if (/\s/.test(ch)) break;
		value += ch;
	}
	if (inSingle || inDouble) return "unterminated";
	return { value, rest: text.slice(i).trim() };
}

function takeLoopLimit(input: string): { readonly limit?: LoopLimitConfig; readonly rest: string } | string {
	const firstSpace = input.search(/\s/);
	const firstToken = firstSpace === -1 ? input : input.slice(0, firstSpace);
	const rest = firstSpace === -1 ? "" : input.slice(firstSpace + 1).trim();
	const token = firstToken.toLowerCase();

	// 不是 limit 尝试（散文或前导 condition flag）。
	if (!/^[+-]?\d/.test(token)) return { rest: input };

	// 裸整数：默认迭代次数；若下一个 token 是时间单位则按 `10 minutes` 解释。
	if (/^\d+$/.test(token)) {
		if (rest.length > 0) {
			const unitToken = /^\S+/.exec(rest)?.[0] ?? "";
			const unitMs = TIME_UNITS_MS[unitToken.toLowerCase()];
			if (unitMs !== undefined) {
				const limit = makeDuration(token, unitMs);
				if (typeof limit === "string") return limit;
				return { limit, rest: rest.slice(unitToken.length).trim() };
			}
		}
		const limit = makeIterations(token);
		if (typeof limit === "string") return limit;
		return { limit, rest };
	}

	const duration = parseCompoundDuration(token);
	if (duration !== undefined) {
		if (typeof duration === "string") return duration;
		return { limit: duration, rest };
	}
	// 形状像 limit 但不可解析（`-1`、`1.5h`、`10x10`）。
	return LOOP_USAGE;
}

function takeLoopCondition(input: string): { readonly condition?: LoopConditionConfig; readonly action?: "reset" | "compact"; readonly rest: string } | string {
	let rest = input.trim();
	let action: "reset" | "compact" | undefined;
	let condition: LoopConditionConfig | undefined;
	while (rest.startsWith("--")) {
		const name = /^(--[a-z][a-z-]*)(?=[\s=]|$)/u.exec(rest)?.[1];
		if (name === "--reset" || name === "--compact") {
			if (action !== undefined || rest[name.length] === "=") return LOOP_USAGE;
			action = name === "--reset" ? "reset" : "compact";
			rest = rest.slice(name.length).trim();
			continue;
		}
		const until = name === undefined ? undefined : CONDITION_FLAGS[name];
		if (name === undefined || until === undefined) {
			return `Unknown /loop flag ${name ?? rest.split(/\s+/, 1)[0]}. ${LOOP_USAGE}`;
		}
		if (condition !== undefined) return "Use only one of --while or --until.";
		const afterName = rest.slice(name.length);
		const valueText = afterName.startsWith("=") ? afterName.slice(1) : afterName;
		const value = readShellWord(valueText);
		if (value === "unterminated") return `${name} has an unterminated quote.`;
		if (value === undefined || value.value.trim().length === 0 || valueText.trim().startsWith("-")) {
			return `${name} needs a shell command. Quote it when it contains spaces: /loop ${name} 'bun test'.`;
		}
		condition = { command: value.value.trim(), until };
		rest = value.rest;
	}
	return { ...(condition === undefined ? {} : { condition }), ...(action === undefined ? {} : { action }), rest };
}

function makeIterations(amountText: string): LoopLimitConfig | string {
	const amount = Number(amountText);
	if (!Number.isSafeInteger(amount) || amount <= 0) return "Loop count must be a positive integer.";
	return { kind: "iterations", iterations: amount };
}

function makeDuration(amountText: string, unitMs: number): LoopLimitConfig | string {
	const amount = Number(amountText);
	if (!Number.isSafeInteger(amount) || amount <= 0) return "Loop duration must be positive.";
	return { kind: "duration", durationMs: amount * unitMs };
}

function parseCompoundDuration(token: string): LoopLimitConfig | string | undefined {
	if (!/^(?:\d+[a-z]+)+$/u.test(token)) return undefined;
	const segments = token.match(/\d+[a-z]+/gu);
	if (segments === null) return undefined;
	let totalMs = 0;
	for (const segment of segments) {
		const match = /^(\d+)([a-z]+)$/u.exec(segment);
		if (match === null) return LOOP_USAGE;
		const unitMs = TIME_UNITS_MS[match[2]!];
		if (unitMs === undefined) return "Loop duration unit must be seconds, minutes, or hours.";
		const amount = Number(match[1]!);
		if (!Number.isSafeInteger(amount) || amount <= 0) return "Loop duration must be positive.";
		totalMs += amount * unitMs;
	}
	if (totalMs <= 0) return "Loop duration must be positive.";
	return { kind: "duration", durationMs: totalMs };
}

/**
 * 建立运行时预算。无显式 limit 时用 `fallbackIterations`（settings 硬上限），
 * 保证自主迭代永远有界（D8）。
 */
export function createLoopLimitRuntime(
	config: LoopLimitConfig | undefined,
	fallbackIterations: number,
	nowMs = Date.now(),
): LoopLimitRuntime {
	if (config === undefined) return { kind: "iterations", initial: fallbackIterations, remaining: fallbackIterations };
	if (config.kind === "iterations") return { kind: "iterations", initial: config.iterations, remaining: config.iterations };
	return { kind: "duration", durationMs: config.durationMs, deadlineMs: nowMs + config.durationMs };
}

/** 消耗一次迭代；返回 undefined 表示预算已耗尽。 */
export function consumeLoopLimitIteration(limit: LoopLimitRuntime, nowMs = Date.now()): LoopLimitRuntime | undefined {
	if (limit.kind === "duration") return nowMs < limit.deadlineMs ? limit : undefined;
	return limit.remaining <= 0 ? undefined : { ...limit, remaining: limit.remaining - 1 };
}

/** 预算是否已耗尽；不消耗迭代，供「决定是否再跑一次条件命令」这类预检使用。 */
export function isLoopLimitExhausted(limit: LoopLimitRuntime, nowMs = Date.now()): boolean {
	if (limit.kind === "duration") return nowMs >= limit.deadlineMs;
	return limit.remaining <= 0;
}

export function describeLoopLimit(config: LoopLimitConfig): string {
	return config.kind === "iterations"
		? `${config.iterations} ${config.iterations === 1 ? "iteration" : "iterations"}`
		: formatLoopDuration(config.durationMs);
}

export function describeLoopLimitRuntime(limit: LoopLimitRuntime): string {
	if (limit.kind === "iterations") {
		return `${limit.remaining} of ${limit.initial} ${limit.initial === 1 ? "iteration" : "iterations"} remaining`;
	}
	return `${formatLoopDuration(limit.durationMs)} limit`;
}

function formatLoopDuration(durationMs: number): string {
	if (durationMs % 3_600_000 === 0) {
		const hours = durationMs / 3_600_000;
		return `${hours} ${hours === 1 ? "hour" : "hours"}`;
	}
	if (durationMs % 60_000 === 0) {
		const minutes = durationMs / 60_000;
		return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
	}
	const seconds = durationMs / 1_000;
	return `${seconds} ${seconds === 1 ? "second" : "seconds"}`;
}
