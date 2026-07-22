/** 将完整工具输出写入 CAS，只把 bounded summary 与 ArtifactRef 回灌模型。 */

import { canonicalDigest, canonicalJson } from "../protocol/v3/canonical-json.ts";
import { createRuntimeId } from "../protocol/v3/ids.ts";
import type { AgentId, AuthorityId, PrincipalId, SessionId, TenantId, WorkspaceId } from "../protocol/v3/ids.ts";
import type { ToolResultArtifactProjection, ToolResultArtifactRequest, ToolResultArtifactSink } from "../types.ts";
import type { ArtifactRepository } from "./cas-store.ts";
import type { ArtifactLineageInput } from "./types.ts";

const MAX_TOOL_RESULT_SUMMARY_CHARS = 8_192;

export interface ArtifactToolResultSinkOptions {
	repository: ArtifactRepository;
	authorityId: AuthorityId;
	tenantId: TenantId;
	principalId: PrincipalId;
	sessionId: SessionId;
	producerId: AgentId | PrincipalId;
	workspaceId?: WorkspaceId;
	lineage?: ArtifactLineageInput;
}

function textSummary(request: ToolResultArtifactRequest): string {
	const textBlocks = request.content.filter((block) => block.type === "text");
	const imageBlocks = request.content.length - textBlocks.length;
	const originalChars = textBlocks.reduce((total, block) => total + block.text.length, 0);
	return `tool=${request.toolName}; textBlocks=${textBlocks.length}; imageBlocks=${imageBlocks}; originalChars=${originalChars}; isError=${request.isError}`;
}

export class ArtifactToolResultSink implements ToolResultArtifactSink {
	readonly #options: ArtifactToolResultSinkOptions;

	public constructor(options: ArtifactToolResultSinkOptions) {
		this.#options = options;
	}

	public async storeToolResult(request: ToolResultArtifactRequest): Promise<ToolResultArtifactProjection> {
		const serialized = canonicalJson({
			toolCallId: request.toolCallId,
			toolName: request.toolName,
			isError: request.isError,
			content: request.content,
		});
		const artifactId = createRuntimeId("artifact");
		const written = await this.#options.repository.write({
			authorityId: this.#options.authorityId,
			tenantId: this.#options.tenantId,
			artifactId,
			intentId: createRuntimeId("command"),
			principalId: this.#options.principalId,
			source: {
				sessionId: this.#options.sessionId,
				...(this.#options.workspaceId ? { workspaceId: this.#options.workspaceId } : {}),
				producerId: this.#options.producerId,
			},
			kind: "tool_output",
			mediaType: "application/json",
			content: serialized,
			...(this.#options.lineage ? { lineage: this.#options.lineage } : {}),
			retention: { pins: [this.#options.sessionId], referenceCount: 1 },
			redaction: "default",
		});
		if (!written.ok) {
			throw new Error(`Artifact tool-result write failed: ${written.error.code}: ${written.error.message}`);
		}
		if (written.value.state !== "committed" || !written.value.reference) {
			throw new Error("Artifact tool-result write did not reach a durable committed reference");
		}

		const referenceText = canonicalJson(written.value.reference);
		const prefix = `Tool output stored as ArtifactRef:\n${referenceText}`;
		const requestedLimit = Number.isSafeInteger(request.maxPromptChars) && request.maxPromptChars > 0
			? request.maxPromptChars
			: MAX_TOOL_RESULT_SUMMARY_CHARS;
		const boundedLimit = Math.min(requestedLimit, MAX_TOOL_RESULT_SUMMARY_CHARS);
		const available = Math.max(0, boundedLimit - prefix.length - 12);
		const summary = textSummary(request).slice(0, available);
		const promptText = summary.length > 0 ? `${prefix}\nSummary:\n${summary}` : prefix;
		return {
			content: [{ type: "text", text: promptText }],
			artifactRef: written.value.reference,
			resultDigest: canonicalDigest(serialized),
		};
	}
}
