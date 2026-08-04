/** Skill qualified resolver 到 Host 可消费的 bounded adapter。 */

import type { AdapterIdentityRef } from "../../runtime/protocol/adapter.ts";
import type { RuntimeDigest } from "../../runtime/protocol/foundation.ts";
import { runtimeDigest } from "../../runtime/protocol/foundation.ts";
import type { RuntimeToolInvocation, RuntimeToolResult } from "../../runtime/resources/types.ts";
import type { SkillCatalog } from "../skills/catalog.ts";
import type { SkillResolveResult } from "../skills/types.ts";
import {
	boundedCanonicalInput,
	checkResourceCatalogPort,
	type ExtensionAdapterRequestBase,
	type ExtensionAdapterResult,
	type RuntimeExtensionResourcePorts,
	DEFAULT_EXTENSION_ADAPTER_INPUT_BYTES,
	sameResourceIdentity,
} from "./runtime-resource-adapter.ts";
import { createInvocationAudit } from "./runtime-audit-adapter.ts";

export interface SkillResolutionRequest extends ExtensionAdapterRequestBase {
	readonly value: string;
}

export interface SkillResolutionValue {
	readonly invocation: RuntimeToolInvocation;
	readonly skillId: string;
	readonly trigger: string;
	readonly argument?: string;
	readonly bodyDigest: string;
	readonly allowedTools: readonly string[];
	readonly runtimeResult: RuntimeToolResult;
}

export interface RuntimeSkillAdapterOptions {
	readonly catalog: SkillCatalog;
	readonly resources: RuntimeExtensionResourcePorts;
	readonly adapter: AdapterIdentityRef;
	readonly maxInputBytes?: number;
}

function sameDigest(left: RuntimeDigest, right: RuntimeDigest): boolean {
	return left.algorithm === right.algorithm && left.digest === right.digest;
}

function resultCode(result: Extract<SkillResolveResult, { readonly ok: false }>): import("./runtime-resource-adapter.ts").ExtensionAdapterErrorCode {
	if (result.code === "not_found") return "not_found";
	if (result.code === "ambiguous") return "ambiguous";
	if (result.code === "blocked") return "blocked";
	if (result.code === "stale") return "stale";
	return "invalid_request";
}

function failureMessage(code: import("./runtime-resource-adapter.ts").ExtensionAdapterErrorCode): string {
	switch (code) {
		case "not_found": return "skill was not found in the current catalog";
		case "ambiguous": return "skill name is ambiguous";
		case "blocked": return "skill is blocked or disabled";
		case "stale": return "skill snapshot is stale";
		case "unavailable": return "skill catalog is unavailable";
		case "cancelled": return "skill resolution was cancelled";
		case "oversized": return "skill invocation exceeds the adapter bound";
		case "invalid_input": return "skill invocation is not canonical input";
		case "invalid_request": return "skill invocation request is invalid";
		case "authorization_denied": return "skill authorization was denied";
		case "unknown_effect": return "skill catalog returned an unknown effect";
		case "unsupported": return "skill resolution is unsupported";
		case "execution_failed": return "skill resolution failed";
	}
}

export class RuntimeSkillAdapter {
	readonly #catalog: SkillCatalog;
	readonly #resources: RuntimeExtensionResourcePorts;
	readonly #adapter: AdapterIdentityRef;
	readonly #maxInputBytes: number;

	public constructor(options: RuntimeSkillAdapterOptions) {
		this.#catalog = options.catalog;
		this.#resources = options.resources;
		this.#adapter = options.adapter;
		this.#maxInputBytes = options.maxInputBytes ?? DEFAULT_EXTENSION_ADAPTER_INPUT_BYTES;
	}

	public async resolve(request: SkillResolutionRequest): Promise<ExtensionAdapterResult<SkillResolutionValue>> {
		const startedAt = Date.now();
		const input = boundedCanonicalInput(request.value, this.#maxInputBytes);
		const inputDigest = input.ok ? input.value.digest : input.digest;
		const inputBytes = input.ok ? input.value.bytes : input.bytes;
		if (request.invocation.tool.kind !== "skill") return this.#failure(request, "invalid_request", inputDigest, inputBytes, startedAt);
		if (!sameDigest(request.invocation.inputDigest, inputDigest)) return this.#failure(request, "invalid_request", inputDigest, inputBytes, startedAt);
		if (!input.ok) return this.#failure(request, input.error.code, inputDigest, inputBytes, startedAt);

		const resolved = this.#catalog.resolve(request.value);
		if (!resolved.ok) return this.#failure(request, resultCode(resolved), inputDigest, inputBytes, startedAt);
		if (!sameResourceIdentity(resolved.skill.descriptor.resource, request.invocation.tool)) return this.#failure(request, "stale", inputDigest, inputBytes, startedAt);

		const gate = await checkResourceCatalogPort({
			port: this.#resources.catalog,
			identity: request.identity,
			requestId: request.invocation.requestId,
			traceId: request.invocation.correlationId,
			deadline: request.deadline,
			snapshotId: request.invocation.snapshotId,
			resource: request.invocation.tool,
			signal: request.signal,
		});
		if (!gate.ok) return this.#failure(request, gate.error.code, inputDigest, inputBytes, startedAt, gate.outputDigest);

		const text = `skill resolved: ${resolved.skill.descriptor.identity.qualifiedId}`;
		const content = [{ type: "text" as const, text }];
		const runtimeResult: RuntimeToolResult = {
			requestId: request.invocation.requestId,
			tool: request.invocation.tool,
			content,
			outcome: "ok",
			originalBytes: Buffer.byteLength(text, "utf8"),
			truncated: false,
			contentDigest: runtimeDigest(content),
		};
		const audit = createInvocationAudit({
			kind: "skill.invocation",
			requestId: request.invocation.requestId,
			correlationId: request.invocation.correlationId,
			snapshotId: request.invocation.snapshotId,
			resource: request.invocation.tool,
			outcome: "ok",
			inputDigest,
			outputDigest: runtimeResult.contentDigest,
			metadata: { skillId: resolved.skill.descriptor.identity.qualifiedId, trigger: resolved.trigger, argumentDigest: runtimeDigest(resolved.argument ?? null), bodyDigest: resolved.skill.bodyDigest, adapter: this.#adapter },
			portDigest: gate.outputDigest,
			bodyDigest: { algorithm: "sha256", digest: resolved.skill.bodyDigest as RuntimeDigest["digest"] } satisfies RuntimeDigest,
			originalBytes: inputBytes,
			resultBytes: runtimeResult.originalBytes,
			durationMs: Date.now() - startedAt,
		});
		return {
			ok: true,
			value: {
				invocation: request.invocation,
				skillId: resolved.skill.descriptor.identity.qualifiedId,
				trigger: resolved.trigger,
				...(resolved.argument ? { argument: resolved.argument } : {}),
				bodyDigest: resolved.skill.bodyDigest,
				allowedTools: resolved.skill.frontmatter.allowedTools ? [...resolved.skill.frontmatter.allowedTools] : [],
				runtimeResult,
			},
			audit: audit.audit,
			auditDigest: audit.auditDigest,
		};
	}

	#failure(
		request: SkillResolutionRequest,
		code: Parameters<typeof failureMessage>[0],
		inputDigest: RuntimeDigest,
		inputBytes: number,
		startedAt: number,
		portDigest = runtimeDigest("extension-skill-not-invoked"),
	): ExtensionAdapterResult<SkillResolutionValue> {
		const audit = createInvocationAudit({
			kind: "skill.invocation",
			requestId: request.invocation.requestId,
			correlationId: request.invocation.correlationId,
			snapshotId: request.invocation.snapshotId,
			resource: request.invocation.tool,
			outcome: code === "authorization_denied" ? "denied" : code === "cancelled" ? "cancelled" : code === "unsupported" ? "unsupported" : "error",
			inputDigest,
			outputDigest: runtimeDigest({ code }),
			metadata: { code, adapter: this.#adapter },
			portDigest,
			originalBytes: inputBytes,
			resultBytes: 0,
			durationMs: Date.now() - startedAt,
			errorCode: code,
		});
		return { ok: false, error: { code, message: failureMessage(code), retryable: code === "unavailable" }, audit: audit.audit, auditDigest: audit.auditDigest };
	}
}
