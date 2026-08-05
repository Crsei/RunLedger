/** Resident Host hook lifecycle facade.
 *
 * The facade owns no process, filesystem, or event writer.  It binds the
 * currently published HookDefinition snapshot to RuntimeHookAdapter; the
 * adapter then applies the Resource invocation port and Host-managed runner.
 */

import { runtimeDigest, type RuntimeContentRef } from "../../runtime/protocol/foundation.ts";
import { createRuntimeId, parseRuntimeId } from "../../runtime/protocol/ids.ts";
import type { IdentityContext } from "../../runtime/identity/types.ts";
import type { ResourceIdentity, RuntimeToolInvocation } from "../../runtime/resources/types.ts";
import type { HookDefinition } from "./types.ts";
import type { HookLifecycleAdapterPort } from "../integration/runtime-hook-adapter.ts";
import type { ExtensionHookRuntime, ExtensionHookRuntimeResult } from "../turn-lifecycle.ts";

const DEFAULT_HOOK_DEADLINE_MS = 120_000;

export interface HostHookRuntimeOptions {
	readonly hooks: () => readonly HookDefinition[];
	readonly adapter: HookLifecycleAdapterPort;
	readonly identity: IdentityContext;
	readonly source: string;
	readonly now?: () => Date;
	readonly deadlineMs?: number;
}

export class HostHookRuntime implements ExtensionHookRuntime {
	readonly #hooks: HostHookRuntimeOptions["hooks"];
	readonly #adapter: HookLifecycleAdapterPort;
	readonly #identity: IdentityContext;
	readonly #source: string;
	readonly #now: () => Date;
	readonly #deadlineMs: number;

	public constructor(options: HostHookRuntimeOptions) {
		if (!Number.isSafeInteger(options.deadlineMs ?? DEFAULT_HOOK_DEADLINE_MS) || (options.deadlineMs ?? DEFAULT_HOOK_DEADLINE_MS) < 1 || (options.deadlineMs ?? DEFAULT_HOOK_DEADLINE_MS) > DEFAULT_HOOK_DEADLINE_MS) throw new Error("hook deadline is invalid");
		this.#hooks = options.hooks;
		this.#adapter = options.adapter;
		this.#identity = options.identity;
		this.#source = options.source;
		this.#now = options.now ?? (() => new Date());
		this.#deadlineMs = options.deadlineMs ?? DEFAULT_HOOK_DEADLINE_MS;
	}

	public async run(input: Parameters<ExtensionHookRuntime["run"]>[0]): Promise<ExtensionHookRuntimeResult> {
		const sessionId = parseRuntimeId("session", input.sessionId);
		const snapshotId = parseRuntimeId("snapshot", input.snapshotId);
		if (sessionId === undefined || snapshotId === undefined) return denied(input.input);
		const hooks = this.#hooks().filter((hook) => hook.event === input.event);
		if (hooks.length === 0) return allowed(input.input);
		const seed = runtimeDigest({
			event: input.event,
			sessionId,
			snapshotId,
			input: input.input,
			...(input.matcherValue === undefined ? {} : { matcherValue: input.matcherValue }),
		});
		const requestId = createRuntimeId("command", `hook-${seed.digest.slice(0, 48)}`);
		const eventId = createRuntimeId("event", `hook-${seed.digest.slice(0, 48)}`);
		const traceId = createRuntimeId("trace", `hook-${seed.digest.slice(0, 48)}`);
		const definition = hooks[0]!;
		const invocation: RuntimeToolInvocation = {
			requestId,
			tool: hookIdentity(definition),
			inputDigest: runtimeDigest(input.input),
			decisionReceiptRef: receiptRef(seed),
			requestedClaims: [],
			snapshotId,
			correlationId: traceId,
		};
		const result = await this.#adapter.invoke({
			identity: this.#identity,
			deadline: new Date(this.#now().getTime() + this.#deadlineMs).toISOString(),
			invocation,
			event: {
				event: input.event,
				eventId,
				timestamp: this.#now().toISOString(),
				sessionId,
				snapshotId,
				source: this.#source,
				...(input.matcherValue === undefined ? {} : { matcherValue: input.matcherValue }),
				input: input.input,
			},
			hooks,
			...(input.signal === undefined ? {} : { signal: input.signal }),
		});
		if (!result.ok) return denied(input.input);
		return {
			decision: result.value.decision,
			blocked: result.value.blocked,
			finalInput: result.value.finalInput,
			requiresRevalidation: result.value.requiresRevalidation,
			requiresAuthorization: result.value.requiresAuthorization,
			additionalContext: result.value.additionalContext,
		};
	}
}

function hookIdentity(definition: HookDefinition): ResourceIdentity {
	return {
		resourceId: definition.resourceId,
		kind: "hook",
		qualifiedId: `hook:${definition.sourceLayer}:${definition.sourcePath}:${definition.event}:${definition.id}`,
		version: "1.0.0",
		source: definition.sourceLayer,
		digest: runtimeDigest({ id: definition.id, event: definition.event, sourcePath: definition.sourcePath, handlers: definition.handlers }),
	};
}

function receiptRef(digest: ReturnType<typeof runtimeDigest>): RuntimeContentRef {
	return { subjectKind: "receipt", digest, mediaType: "application/vnd.runledger.hook-decision+json", size: 0 };
}

function allowed(input: unknown): ExtensionHookRuntimeResult {
	return { decision: "allow", blocked: false, finalInput: input, requiresRevalidation: false, requiresAuthorization: false, additionalContext: [] };
}

function denied(input: unknown): ExtensionHookRuntimeResult {
	return { decision: "deny", blocked: true, finalInput: input, requiresRevalidation: false, requiresAuthorization: true, additionalContext: [] };
}
