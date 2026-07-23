/** MCP text/image/resource/unknown content 的有界规范化与 spill。 */

import { canonicalDigest, canonicalJson } from "../../runtime/protocol/v3/canonical-json.ts";
import { DEFAULT_EXTENSION_LIMITS } from "../diagnostics.ts";
import type { ExtensionSpillPort } from "../types.ts";
import type { McpCallResult, McpNormalizedResult } from "./types.ts";

function record(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export async function normalizeMcpResult(result: McpCallResult, spill?: ExtensionSpillPort): Promise<McpNormalizedResult> {
	const raw = canonicalJson({ content: result.content, ...(result.structuredContent !== undefined ? { structuredContent: result.structuredContent } : {}), isError: result.isError });
	const originalBytes = Buffer.byteLength(raw);
	let budget = DEFAULT_EXTENSION_LIMITS.maxMcpResultBytes;
	let truncated = false;
	const content = [];
	for (const item of result.content) {
		const value = record(item);
		if (!value) continue;
		let normalized;
		if (value.type === "text" && typeof value.text === "string") normalized = { type: "text" as const, text: value.text, contentDigest: canonicalDigest(value.text) };
		else if (value.type === "image" && typeof value.data === "string" && typeof value.mimeType === "string") normalized = { type: "image" as const, dataBase64: value.data, mediaType: value.mimeType, contentDigest: canonicalDigest({ data: value.data, mimeType: value.mimeType }) };
		else if (value.type === "resource" && record(value.resource)) {
			const resource = record(value.resource);
			const uri = typeof resource?.uri === "string" ? resource.uri : "mcp-resource:unknown";
			const text = typeof resource?.text === "string" ? resource.text : typeof resource?.blob === "string" ? resource.blob : "";
			normalized = { type: "resource" as const, uri, ...(text ? { text } : {}), contentDigest: canonicalDigest(resource) };
		} else {
			const json = canonicalJson(value);
			normalized = { type: "json" as const, text: json, contentDigest: canonicalDigest(value) };
		}
		const encoded = canonicalJson(normalized);
		const bytes = Buffer.byteLength(encoded);
		if (bytes > budget) {
			truncated = true;
			if (budget > 128) content.push({ type: "text" as const, text: Buffer.from(encoded).subarray(0, budget - 128).toString("utf8"), contentDigest: normalized.contentDigest });
			break;
		}
		content.push(normalized);
		budget -= bytes;
	}
	if (result.structuredContent !== undefined && budget > 0) {
		const json = canonicalJson(result.structuredContent);
		if (Buffer.byteLength(json) <= budget) content.push({ type: "json" as const, text: json, contentDigest: canonicalDigest(result.structuredContent) });
		else truncated = true;
	}
	const spillRef = (truncated || originalBytes > DEFAULT_EXTENSION_LIMITS.maxMcpResultBytes) && spill ? await spill.write("mcp-result", Buffer.from(raw)) : undefined;
	return { content, isError: result.isError, originalBytes, truncated: truncated || originalBytes > DEFAULT_EXTENSION_LIMITS.maxMcpResultBytes, contentDigest: canonicalDigest(content), ...(spillRef ? { spill: spillRef } : {}) };
}
