/**
 * ContextEngine schema guard。
 *
 * TODO(runtime-phase-6): 固定 fragment layer order、hard cap、integer overflow
 * 和 provider usage fallback 的 contract tests。
 */

import type { ContextAssemblyReceipt } from "./types.ts";

export const CONTEXT_SCHEMA_VERSION = 1 as const;

export function isContextAssemblyReceipt(value: unknown): value is ContextAssemblyReceipt {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return false;
	}
	const candidate = value as Record<string, unknown>;
	return (
		typeof candidate.requestId === "string" &&
		typeof candidate.modelId === "string" &&
		Array.isArray(candidate.fragmentIds) &&
		Array.isArray(candidate.omittedFragmentIds) &&
		typeof candidate.estimatedInputTokens === "number" &&
		typeof candidate.reservedOutputTokens === "number" &&
		typeof candidate.contextDigest === "string" &&
		Array.isArray(candidate.diagnostics)
	);
}
