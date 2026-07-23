/** 五类 Hook 的稳定串行 dispatcher。 */

import type { HookDescriptor, HookDispatchResult, HookEnvelope, HookEvent, HookRunOutcome } from "./types.ts";
import type { HookRunner } from "./runner.ts";

function matches(hook: HookDescriptor, envelope: HookEnvelope): boolean {
	if (!hook.matcherRegex) return true;
	const candidate = typeof envelope.payload.toolName === "string"
		? envelope.payload.toolName
		: typeof envelope.payload.prompt === "string" ? envelope.payload.prompt : "";
	return hook.matcherRegex.test(candidate);
}

export class HookDispatcher {
	readonly #hooks: readonly HookDescriptor[];
	readonly #runner: HookRunner;

	public constructor(hooks: readonly HookDescriptor[], runner: HookRunner) {
		this.#hooks = [...hooks].sort((left, right) => left.priority - right.priority || left.configPath.localeCompare(right.configPath) || left.declarationIndex - right.declarationIndex);
		this.#runner = runner;
	}

	public list(event?: HookEvent): readonly HookDescriptor[] {
		return event ? this.#hooks.filter((hook) => hook.event === event) : this.#hooks;
	}

	public async dispatch(envelope: HookEnvelope, signal?: AbortSignal): Promise<HookDispatchResult> {
		let input: unknown = envelope.payload.input;
		let inputUpdated = false;
		const outcomes: HookRunOutcome[] = [];
		const contexts: string[] = [];
		for (const hook of this.#hooks) {
			if (hook.event !== envelope.event || hook.descriptor.activation !== "ready" || !matches(hook, envelope)) continue;
			for (const handler of hook.handlers) {
				const currentEnvelope: HookEnvelope = inputUpdated ? { ...envelope, payload: { ...envelope.payload, input } } : envelope;
				const outcome = await this.#runner.run(hook, handler, currentEnvelope, signal);
				outcomes.push(outcome);
				if (outcome.decision === "deny") return { decision: "deny", reason: outcome.reason, input, inputUpdated, ...(contexts.length ? { additionalContext: contexts.join("\n") } : {}), outcomes };
				if (outcome.updatedInput !== undefined) {
					input = outcome.updatedInput;
					inputUpdated = true;
				}
				if (outcome.additionalContext) contexts.push(outcome.additionalContext);
			}
		}
		return { decision: "allow", input, inputUpdated, ...(contexts.length ? { additionalContext: contexts.join("\n").slice(0, 32_768) } : {}), outcomes };
	}
}
