/** Hooks JSON descriptor 的 strict parser。解析阶段不读取文件也不执行命令。 */

import { runtimeDigest } from "../../runtime/protocol/foundation.ts";
import { createRuntimeId } from "../../runtime/protocol/ids.ts";
import { extensionDiagnostic, sortExtensionDiagnostics } from "../diagnostics.ts";
import { compileHookMatcher, HookMatcherError } from "./matcher.ts";
import { HOOK_EVENT_NAMES } from "./types.ts";
import type {
	HookDefinition,
	HookFailureMode,
	HookHandlerDescriptor,
	HookParseResult,
	HookParserOptions,
	HookSourceLayer,
} from "./types.ts";

export { HOOK_EVENT_NAMES } from "./types.ts";
export { orderHookHandlers } from "./matcher.ts";

const ROOT_KEYS = ["hooks"] as const;
const HOOK_KEYS = ["id", "matcher", "failureMode", "handlers"] as const;
const HANDLER_KEYS = ["type", "command", "args", "timeoutMs", "env"] as const;
const ID_PATTERN = /^[A-Za-z][A-Za-z0-9._-]{0,127}$/u;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
	const allowed = new Set([...required, ...optional]);
	const keys = Object.keys(value);
	return required.every((key) => Object.hasOwn(value, key)) && keys.every((key) => allowed.has(key));
}

function addDiagnostic(
	diagnostics: ExtensionDiagnosticBuilder,
	code: string,
	message: string,
	path: string,
): void {
	diagnostics.push(extensionDiagnostic(code, "error", message, "hooks", path));
}

type ExtensionDiagnosticBuilder = ReturnType<typeof createDiagnosticList>;

function createDiagnosticList() {
	return [] as ReturnType<typeof extensionDiagnostic>[];
}

function stringValue(value: unknown, path: string, diagnostics: ExtensionDiagnosticBuilder, maxLength: number): string | undefined {
	if (typeof value !== "string" || value.length === 0 || value.length > maxLength || value.includes("\u0000")) {
		addDiagnostic(diagnostics, "hooks.invalid_string", `expected a non-empty string of at most ${maxLength} characters`, path);
		return undefined;
	}
	return value;
}

function parseHandler(value: unknown, path: string, diagnostics: ExtensionDiagnosticBuilder): HookHandlerDescriptor | undefined {
	if (!isPlainRecord(value)) {
		addDiagnostic(diagnostics, "hooks.handler_invalid", "handler must be an object", path);
		return undefined;
	}
	if (!hasExactKeys(value, HANDLER_KEYS)) {
		const unknown = Object.keys(value).filter((key) => !(HANDLER_KEYS as readonly string[]).includes(key));
		addDiagnostic(diagnostics, unknown.length > 0 ? "hooks.handler_unknown_field" : "hooks.handler_missing_field", "handler descriptor fields are not exact", path);
		return undefined;
	}
	if (value.type !== "command") {
		addDiagnostic(diagnostics, "hooks.handler_type", "only command handlers are supported", `${path}.type`);
		return undefined;
	}
	const command = stringValue(value.command, `${path}.command`, diagnostics, 512);
	if (!command) return undefined;
	if (!Array.isArray(value.args) || value.args.length > 64 || !value.args.every((arg) => typeof arg === "string" && arg.length <= 512 && !arg.includes("\u0000"))) {
		addDiagnostic(diagnostics, "hooks.handler_args", "args must be an array of at most 64 NUL-free strings", `${path}.args`);
		return undefined;
	}
	if (typeof value.timeoutMs !== "number" || !Number.isSafeInteger(value.timeoutMs) || value.timeoutMs < 1 || value.timeoutMs > 600_000) {
		addDiagnostic(diagnostics, "hooks.handler_timeout", "timeoutMs must be an integer between 1 and 600000", `${path}.timeoutMs`);
		return undefined;
	}
	if (!isPlainRecord(value.env) || Object.keys(value.env).length > 128 || !Object.entries(value.env).every(([key, item]) => ID_PATTERN.test(key.replace(/-/gu, "_")) && typeof item === "string" && item.length <= 4_096 && !item.includes("\u0000"))) {
		addDiagnostic(diagnostics, "hooks.handler_env", "env must be a bounded map of NUL-free strings", `${path}.env`);
		return undefined;
	}
	const env = Object.fromEntries(Object.entries(value.env).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)) as Record<string, string>;
	return { type: "command", command, args: [...value.args], timeoutMs: value.timeoutMs, env };
}

function parseFailureMode(value: unknown, path: string, diagnostics: ExtensionDiagnosticBuilder): HookFailureMode | undefined {
	if (value === undefined) return undefined;
	if (value !== "open" && value !== "closed") {
		addDiagnostic(diagnostics, "hooks.failure_mode", "failureMode must be open or closed", path);
		return undefined;
	}
	return value;
}

export function parseHookDocument(value: unknown, options: HookParserOptions = {}): HookParseResult {
	const diagnostics = createDiagnosticList();
	const sourceLayer: HookSourceLayer = options.sourceLayer ?? "project";
	const sourcePath = options.sourcePath ?? "hooks.json";
	if (!isPlainRecord(value)) {
		addDiagnostic(diagnostics, "hooks.document_invalid", "hook document must be a JSON object", "$" );
		return { ok: false, hooks: [], diagnostics: sortExtensionDiagnostics(diagnostics) };
	}
	if (!hasExactKeys(value, ROOT_KEYS)) {
		addDiagnostic(diagnostics, "hooks.document_fields", "hook document must contain only the hooks field", "$" );
		return { ok: false, hooks: [], diagnostics: sortExtensionDiagnostics(diagnostics) };
	}
	if (!isPlainRecord(value.hooks)) {
		addDiagnostic(diagnostics, "hooks.map_invalid", "hooks must be an object keyed by event name", "$.hooks");
		return { ok: false, hooks: [], diagnostics: sortExtensionDiagnostics(diagnostics) };
	}

	const hooks: HookDefinition[] = [];
	const seenIds = new Set<string>();
	for (const event of Object.keys(value.hooks).sort()) {
		if (!(HOOK_EVENT_NAMES as readonly string[]).includes(event)) {
			addDiagnostic(diagnostics, "hooks.unknown_event", `unsupported hook event: ${event}`, `$.hooks.${event}`);
			continue;
		}
		const definitions = value.hooks[event];
		if (!Array.isArray(definitions) || definitions.length > 128) {
			addDiagnostic(diagnostics, "hooks.event_entries", "event value must be an array of at most 128 hook definitions", `$.hooks.${event}`);
			continue;
		}
		for (let declarationIndex = 0; declarationIndex < definitions.length; declarationIndex += 1) {
			const definition = definitions[declarationIndex];
			const path = `$.hooks.${event}[${declarationIndex}]`;
			if (!isPlainRecord(definition) || !hasExactKeys(definition, ["handlers"], ["id", "matcher", "failureMode"])) {
				addDiagnostic(diagnostics, "hooks.definition_fields", "hook definition fields are not exact", path);
				continue;
			}
			const declaredId = definition.id === undefined ? `${event.toLowerCase()}-${declarationIndex}` : stringValue(definition.id, `${path}.id`, diagnostics, 128);
			if (!declaredId || !ID_PATTERN.test(declaredId)) {
				addDiagnostic(diagnostics, "hooks.id_invalid", "hook id must match the stable identifier format", `${path}.id`);
				continue;
			}
			if (seenIds.has(`${event}\u0000${declaredId}`)) {
				addDiagnostic(diagnostics, "hooks.duplicate_id", `duplicate hook id: ${declaredId}`, `${path}.id`);
				continue;
			}
			seenIds.add(`${event}\u0000${declaredId}`);
			const matcher = definition.matcher === undefined ? undefined : stringValue(definition.matcher, `${path}.matcher`, diagnostics, 512);
			if (definition.matcher !== undefined && !matcher) continue;
			if (matcher !== undefined) {
				try {
					compileHookMatcher(matcher);
				} catch (error) {
					const message = error instanceof HookMatcherError ? error.message : "invalid matcher";
					addDiagnostic(diagnostics, "hooks.matcher_invalid", message, `${path}.matcher`);
					continue;
				}
			}
			const failureMode = parseFailureMode(definition.failureMode, `${path}.failureMode`, diagnostics);
			if (definition.failureMode !== undefined && failureMode === undefined) continue;
			if (!Array.isArray(definition.handlers) || definition.handlers.length === 0 || definition.handlers.length > 32) {
				addDiagnostic(diagnostics, "hooks.handlers_invalid", "handlers must contain 1 to 32 descriptors", `${path}.handlers`);
				continue;
			}
			const handlers: HookHandlerDescriptor[] = [];
			for (let handlerIndex = 0; handlerIndex < definition.handlers.length; handlerIndex += 1) {
				const parsed = parseHandler(definition.handlers[handlerIndex], `${path}.handlers[${handlerIndex}]`, diagnostics);
				if (parsed) handlers.push(parsed);
			}
			if (handlers.length !== definition.handlers.length) continue;
			const resourceId = createRuntimeId("resource", runtimeDigest({ sourceLayer, sourcePath, event, id: declaredId, declarationIndex }).digest.slice(0, 32));
			hooks.push({
				id: declaredId,
				event: event as HookDefinition["event"],
				...(matcher !== undefined ? { matcher } : {}),
				...(failureMode !== undefined ? { failureMode } : {}),
				handlers,
				sourceLayer,
				sourcePath,
				declarationIndex,
				resourceId,
			});
		}
	}

	const sortedDiagnostics = sortExtensionDiagnostics(diagnostics);
	if (sortedDiagnostics.some((diagnostic) => diagnostic.severity === "error")) {
		return { ok: false, hooks: [], diagnostics: sortedDiagnostics, digest: safeRuntimeDigest(value) };
	}
	return { ok: true, hooks, diagnostics: sortedDiagnostics, digest: safeRuntimeDigest(value) };
}

function safeRuntimeDigest(value: unknown) {
	return runtimeDigest(value);
}
