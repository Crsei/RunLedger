/** controller/agent-loop 串行接线所需的 Hook lifecycle adapter。 */

import type { HookDispatcher } from "../hooks/dispatcher.ts";
import type { HookDispatchResult, HookEnvelope, HookEvent } from "../hooks/types.ts";

export interface UpdatedInputValidationPort {
	validateAndCanonicalize(input: unknown): Promise<{ ok: true; value: unknown } | { ok: false; reason: string }>;
	reauthorize(input: unknown, signal?: AbortSignal): Promise<{ ok: true } | { ok: false; reason: string }>;
}

export type RuntimeHookAdapterResult =
	| { ok: true; input: unknown; additionalContext?: string; dispatch: HookDispatchResult }
	| { ok: false; reason: string; dispatch: HookDispatchResult };

export class RuntimeHookAdapter {
	readonly #dispatcher: HookDispatcher;
	readonly #validator: UpdatedInputValidationPort;

	public constructor(dispatcher: HookDispatcher, validator: UpdatedInputValidationPort) {
		this.#dispatcher = dispatcher;
		this.#validator = validator;
	}

	public async dispatch(envelope: HookEnvelope, signal?: AbortSignal): Promise<RuntimeHookAdapterResult> {
		const dispatch = await this.#dispatcher.dispatch(envelope, signal);
		if (dispatch.decision === "deny") return { ok: false, reason: dispatch.reason ?? "hook denied operation", dispatch };
		if (!dispatch.inputUpdated) return { ok: true, input: dispatch.input, ...(dispatch.additionalContext ? { additionalContext: dispatch.additionalContext } : {}), dispatch };
		const validated = await this.#validator.validateAndCanonicalize(dispatch.input);
		if (!validated.ok) return { ok: false, reason: `updated hook input failed schema validation: ${validated.reason}`, dispatch };
		const authorized = await this.#validator.reauthorize(validated.value, signal);
		if (!authorized.ok) return { ok: false, reason: `updated hook input was not authorized: ${authorized.reason}`, dispatch };
		return { ok: true, input: validated.value, ...(dispatch.additionalContext ? { additionalContext: dispatch.additionalContext } : {}), dispatch };
	}

	public envelope(input: Omit<HookEnvelope, "schemaVersion">): HookEnvelope {
		return { schemaVersion: 1, ...input };
	}

	public lifecycleEvents(): readonly HookEvent[] {
		return ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "SessionEnd"];
	}
}
