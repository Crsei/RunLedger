import type {
	BashAstAssetPaths,
	BashAstClassification,
	BashAstClassificationResult,
	CanonicalBashAssignment,
	CanonicalBashRedirect,
	CanonicalSimpleCommand,
} from "./types.ts";
import {
	BASH_AST_COMMAND_MAX_CHARS,
	BASH_AST_DETAIL_MAX_CHARS,
	BASH_AST_NODE_LIMIT,
} from "./types.ts";

export const BASH_AST_WORKER_PROTOCOL_VERSION = 1 as const;

export interface BashAstWorkerData {
	protocolVersion: 1;
	assets: BashAstAssetPaths;
}

export type BashAstWorkerRequest = {
	protocolVersion: 1;
	type: "classify";
	requestId: string;
	command: string;
};

export type BashAstWorkerResponse =
	| {
			protocolVersion: 1;
			type: "ready";
	  }
	| {
			protocolVersion: 1;
			type: "result";
			requestId: string;
			result: BashAstClassificationResult;
	  }
	| {
			protocolVersion: 1;
			type: "failed";
			requestId?: string;
			reasonCode: string;
	  };

function record(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? value as Record<string, unknown>
		: undefined;
}

function boundedText(value: unknown, max: number): string | undefined {
	return typeof value === "string" && value.length <= max ? value : undefined;
}

function digest(value: unknown): string | undefined {
	return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value)
		? value
		: undefined;
}

function assignment(
	value: unknown,
	budget: { remaining: number },
): CanonicalBashAssignment | undefined {
	if (budget.remaining <= 0) return undefined;
	budget.remaining -= 1;
	const item = record(value);
	const name = boundedText(item?.name, 256);
	if (!item || !name || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) return undefined;
	if (item.value === undefined) return { name };
	const assignmentValue = boundedText(item.value, BASH_AST_COMMAND_MAX_CHARS);
	return assignmentValue === undefined ? undefined : { name, value: assignmentValue };
}

function redirect(
	value: unknown,
	budget: { remaining: number },
): CanonicalBashRedirect | undefined {
	if (budget.remaining <= 0) return undefined;
	budget.remaining -= 1;
	const item = record(value);
	const path = boundedText(item?.path, BASH_AST_COMMAND_MAX_CHARS);
	if (
		!item ||
		(item.operation !== "read" &&
			item.operation !== "write" &&
			item.operation !== "append") ||
		path === undefined
	) return undefined;
	return { operation: item.operation, path };
}

function simpleCommand(
	value: unknown,
	budget: { remaining: number },
): CanonicalSimpleCommand | undefined {
	if (budget.remaining <= 0) return undefined;
	budget.remaining -= 1;
	const item = record(value);
	const executable = boundedText(item?.executable, BASH_AST_COMMAND_MAX_CHARS);
	if (
		!item ||
		executable === undefined ||
		!Array.isArray(item.arguments) ||
		!Array.isArray(item.assignments) ||
		!Array.isArray(item.redirects)
	) return undefined;
	const argumentsValue: string[] = [];
	for (const argument of item.arguments) {
		if (budget.remaining <= 0) return undefined;
		budget.remaining -= 1;
		const parsed = boundedText(argument, BASH_AST_COMMAND_MAX_CHARS);
		if (parsed === undefined) return undefined;
		argumentsValue.push(parsed);
	}
	const assignments: CanonicalBashAssignment[] = [];
	for (const candidate of item.assignments) {
		const parsed = assignment(candidate, budget);
		if (!parsed) return undefined;
		assignments.push(parsed);
	}
	const redirects: CanonicalBashRedirect[] = [];
	for (const candidate of item.redirects) {
		const parsed = redirect(candidate, budget);
		if (!parsed) return undefined;
		redirects.push(parsed);
	}
	return {
		executable,
		arguments: argumentsValue,
		assignments,
		redirects,
	};
}

function classification(value: unknown): BashAstClassification | undefined {
	const item = record(value);
	if (!item) return undefined;
	if (item.kind === "simple") {
		const parserDigest = digest(item.parserDigest);
		if (!parserDigest || !Array.isArray(item.commands)) return undefined;
		const budget = { remaining: BASH_AST_NODE_LIMIT };
		const commands: CanonicalSimpleCommand[] = [];
		for (const candidate of item.commands) {
			const parsed = simpleCommand(candidate, budget);
			if (!parsed) return undefined;
			commands.push(parsed);
		}
		return commands.length > 0
			? { kind: "simple", commands, parserDigest }
			: undefined;
	}
	if (item.kind === "too-complex") {
		const reasonCode = boundedText(item.reasonCode, BASH_AST_DETAIL_MAX_CHARS);
		const parserDigest = digest(item.parserDigest);
		const nodeType = item.nodeType === undefined
			? undefined
			: boundedText(item.nodeType, 256);
		if (!reasonCode || !parserDigest || (item.nodeType !== undefined && !nodeType)) {
			return undefined;
		}
		return {
			kind: "too-complex",
			reasonCode,
			...(nodeType ? { nodeType } : {}),
			parserDigest,
		};
	}
	if (item.kind === "parse-unavailable") {
		const reasonCode = boundedText(item.reasonCode, BASH_AST_DETAIL_MAX_CHARS);
		const parserDigest = item.parserDigest === undefined
			? undefined
			: digest(item.parserDigest);
		if (
			!reasonCode ||
			(item.parserDigest !== undefined && parserDigest === undefined)
		) return undefined;
		return {
			kind: "parse-unavailable",
			reasonCode,
			...(parserDigest ? { parserDigest } : {}),
		};
	}
	return undefined;
}

function result(value: unknown): BashAstClassificationResult | undefined {
	const item = record(value);
	const metrics = record(item?.metrics);
	const parsedClassification = classification(item?.classification);
	const durationBucket = boundedText(metrics?.durationBucket, 64);
	const nodeCountBucket = boundedText(metrics?.nodeCountBucket, 64);
	const nodeCount = metrics?.nodeCount;
	if (
		!item ||
		!metrics ||
		!parsedClassification ||
		durationBucket === undefined ||
		nodeCountBucket === undefined ||
		typeof nodeCount !== "number" ||
		!Number.isSafeInteger(nodeCount) ||
		nodeCount < 0 ||
		nodeCount > BASH_AST_NODE_LIMIT + 1
	) return undefined;
	return {
		classification: parsedClassification,
		metrics: { durationBucket, nodeCountBucket, nodeCount },
	};
}

export function parseBashAstWorkerResponse(
	value: unknown,
): BashAstWorkerResponse | undefined {
	const message = record(value);
	if (!message || message.protocolVersion !== BASH_AST_WORKER_PROTOCOL_VERSION) return undefined;
	if (message.type === "ready") return { protocolVersion: 1, type: "ready" };
	if (
		message.type === "failed" &&
		typeof message.reasonCode === "string" &&
		(message.requestId === undefined || typeof message.requestId === "string")
	) {
		return {
			protocolVersion: 1,
			type: "failed",
			...(typeof message.requestId === "string" ? { requestId: message.requestId } : {}),
			reasonCode: message.reasonCode.slice(0, 2_048),
		};
	}
	if (
		message.type === "result" &&
		typeof message.requestId === "string"
	) {
		const parsed = result(message.result);
		return parsed
			? {
					protocolVersion: 1,
					type: "result",
					requestId: message.requestId,
					result: parsed,
				}
			: undefined;
	}
	return undefined;
}
