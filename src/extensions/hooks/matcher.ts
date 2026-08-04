/** Hooks matcher 编译与稳定串行顺序。 */

import type { HookDefinition, HookEventName, HookHandlerReference } from "./types.ts";

export class HookMatcherError extends Error {
	public constructor(message: string) {
		super(message);
		this.name = "HookMatcherError";
	}
}

export interface CompiledHookMatcher {
	readonly pattern?: string;
	readonly matches: (value: string | undefined) => boolean;
}

export function compileHookMatcher(pattern?: string): CompiledHookMatcher {
	if (pattern === undefined) return { matches: () => true };
	try {
		const expression = new RegExp(pattern, "u");
		return {
			pattern,
			matches: (value) => value !== undefined && expression.test(value),
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : "invalid regular expression";
		throw new HookMatcherError(message);
	}
}

const SOURCE_LAYER_ORDER: Readonly<Record<HookDefinition["sourceLayer"], number>> = {
	builtin: 0,
	user: 1,
	project: 2,
	plugin: 3,
	session: 4,
};

function compareText(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function compareDefinitions(left: HookHandlerReference, right: HookHandlerReference): number {
	const layer = SOURCE_LAYER_ORDER[left.hook.sourceLayer] - SOURCE_LAYER_ORDER[right.hook.sourceLayer];
	if (layer !== 0) return layer;
	const path = compareText(left.hook.sourcePath, right.hook.sourcePath);
	if (path !== 0) return path;
	const event = compareText(left.hook.event, right.hook.event);
	if (event !== 0) return event;
	const declaration = left.hook.declarationIndex - right.hook.declarationIndex;
	if (declaration !== 0) return declaration;
	const id = compareText(left.hook.id, right.hook.id);
	if (id !== 0) return id;
	return left.handlerIndex - right.handlerIndex;
}

/** 只返回当前事件与 matcher 命中的 handler，并保证跨平台确定性顺序。 */
export function orderHookHandlers(
	hooks: readonly HookDefinition[],
	event: HookEventName,
	matcherValue?: string,
): HookHandlerReference[] {
	const ordered: HookHandlerReference[] = [];
	for (const hook of hooks) {
		if (hook.event !== event) continue;
		let matches = false;
		try {
			matches = compileHookMatcher(hook.matcher).matches(matcherValue);
		} catch {
			continue;
		}
		if (!matches) continue;
		for (let handlerIndex = 0; handlerIndex < hook.handlers.length; handlerIndex += 1) {
			const handler = hook.handlers[handlerIndex];
			if (handler) ordered.push({ hook, handler, handlerIndex });
		}
	}
	return ordered.sort(compareDefinitions);
}

export function defaultHookFailureMode(event: HookEventName): "open" | "closed" {
	return event === "UserPromptSubmit" || event === "PreToolUse" ? "closed" : "open";
}
