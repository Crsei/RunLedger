/** 安全的 exec token 前缀 amendment；不解析或扩张 shell 语法。 */

import type { RuntimeDigest, SessionId } from "../../runtime/contracts/public.ts";
import type { SecurityResult } from "../types.ts";

export interface ExecPrefixRule {
	readonly sessionId: SessionId;
	readonly policyDigest: RuntimeDigest;
	readonly prefix: readonly string[];
}

const DANGEROUS_EXECUTABLES = new Set(["rm", "chmod", "chown", "chgrp", "kill", "pkill", "sudo", "tee"]);
const SIMPLE_TOKEN = /^[A-Za-z0-9_./:@%+=,-]+$/u;
const ENV_PREFIX = /^[A-Za-z_][A-Za-z0-9_]*=/u;

function failure(message: string): SecurityResult<never> {
	return { ok: false, error: { code: "invalid_request", message, retryable: false } };
}

function commandTokens(command: string): readonly string[] | undefined {
	if (!command.trim() || command.includes("\0") || /(?:<<|>>|[<>;|&`\n]|\$\()/u.test(command)) return undefined;
	const tokens = command.trim().split(/\s+/u);
	if (tokens.some((token) => !SIMPLE_TOKEN.test(token))) return undefined;
	return tokens;
}

export function isDangerousExecCommand(command: string): boolean {
	const tokens = commandTokens(command);
	if (tokens === undefined || tokens.length === 0) return true;
	const executable = (tokens[0] ?? "").replace(/^.*[\\/]/u, "");
	return ENV_PREFIX.test(tokens[0] ?? "") || DANGEROUS_EXECUTABLES.has(executable) ||
		(executable === "git" && tokens[1] === "push");
}

export function validateExecPrefixRule(
	command: string,
	prefix: readonly string[],
	sessionId: SessionId,
	policyDigest: RuntimeDigest,
): SecurityResult<ExecPrefixRule> {
	const tokens = commandTokens(command);
	if (tokens === undefined) return failure("exec prefix rules forbid shell operators, redirection, heredocs, substitutions, quotes, and newlines");
	if (tokens.length === 0 || ENV_PREFIX.test(tokens[0] ?? "")) return failure("exec prefix rules forbid environment prefixes");
	if (isDangerousExecCommand(command)) return failure("dangerous commands cannot create exec prefix rules");
	if (prefix.length === 0 || prefix.length > tokens.length || prefix.some((token) => !SIMPLE_TOKEN.test(token) || ENV_PREFIX.test(token))) {
		return failure("exec prefix rule must contain a non-empty simple token prefix");
	}
	if (!prefix.every((token, index) => tokens[index] === token)) return failure("exec prefix rule does not match the approved command");
	return { ok: true, value: { sessionId, policyDigest, prefix: [...prefix] } };
}

export function execPrefixRuleMatches(rule: ExecPrefixRule, command: string, sessionId: SessionId, policyDigest: RuntimeDigest): boolean {
	if (rule.sessionId !== sessionId || rule.policyDigest.digest !== policyDigest.digest || isDangerousExecCommand(command)) return false;
	const tokens = commandTokens(command);
	return tokens !== undefined && rule.prefix.every((token, index) => tokens[index] === token);
}
