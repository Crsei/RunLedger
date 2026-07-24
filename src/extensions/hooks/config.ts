/** hooks v1 配置解析、路径约束和 trust gate。 */

import { dirname, isAbsolute, resolve } from "node:path";
import { canonicalDigest } from "../../runtime/protocol/v3/canonical-json.ts";
import { createRuntimeId } from "../../runtime/protocol/v3/ids.ts";
import type { ResourceCapabilityDeclaration } from "../../runtime/resources/types.ts";
import { DEFAULT_EXTENSION_LIMITS, extensionDiagnostic } from "../diagnostics.ts";
import type { ExtensionDiagnostic } from "../diagnostics.ts";
import {
	createExtensionResourceIdentity,
	createExtensionResourceProvenance,
	qualifiedResourceId,
} from "../identity.ts";
import { resolveDeclaredPath } from "../paths.ts";
import { schemaAccepts, HooksConfigSchema } from "../schemas.ts";
import { buildResourceManifestDigest, digestFile, sha256 } from "../trust/digest.ts";
import type { TrustStore } from "../trust/trust-store.ts";
import type { ExtensionRuntimeScope, ExtensionSourceRoot, ExtensionStateDocument } from "../types.ts";
import type { ExtensionStoragePort } from "../storage-port.ts";
import { HOOK_EVENTS } from "./types.ts";
import type { CommandHookHandler, HookDescriptor, HookEvent, HookFailureMode, HookHandler, HttpHookHandlerConfig } from "./types.ts";

interface RawCommandHandler {
	type: "command";
	command: string;
	args?: string[];
	timeoutMs?: number;
	env?: Record<string, string>;
}

interface RawHttpHandler {
	type: "http";
	url: string;
}

type RawHookHandler = RawCommandHandler | RawHttpHandler;

interface RawHookDeclaration {
	id?: string;
	matcher?: string;
	failureMode?: HookFailureMode;
	handlers: RawHookHandler[];
}

interface RawHooksConfig {
	schemaVersion: 1 | 2;
	hooks: Partial<Record<HookEvent, RawHookDeclaration[]>>;
}

export interface HookConfigLoadResult {
	hooks: readonly HookDescriptor[];
	diagnostics: readonly ExtensionDiagnostic[];
}

const blockingEvents = new Set<HookEvent>(["PreToolUse", "UserPromptSubmit"]);
const reservedEnvironment = new Set([
	"RUNLEDGER_HOOK_EVENT",
	"RUNLEDGER_HOOK_ID",
	"RUNLEDGER_SESSION_ID",
	"RUNLEDGER_WORKSPACE_ROOT",
	"RUNLEDGER_PLUGIN_ROOT",
	"RUNLEDGER_PLUGIN_DATA",
]);

export function effectiveHookFailureMode(event: HookEvent, source: ExtensionSourceRoot["source"], requested?: HookFailureMode): HookFailureMode {
	const defaultMode = blockingEvents.has(event) ? "closed" : "open";
	if (blockingEvents.has(event) && (source === "project" || source === "plugin") && requested === "open") return "closed";
	return requested ?? defaultMode;
}

async function normalizeHandler(storage: ExtensionStoragePort, handler: RawHookHandler, configPath: string, pluginRoot?: string): Promise<{ handler?: HookHandler; diagnostics: ExtensionDiagnostic[] }> {
	const diagnostics: ExtensionDiagnostic[] = [];
	if (handler.type === "http") {
		let url: URL;
		try {
			url = new URL(handler.url);
		} catch {
			return { diagnostics: [extensionDiagnostic("hook.http_url_invalid", "error", "HTTP hook URL is invalid", "hook", configPath)] };
		}
		if (url.protocol !== "https:" || url.username || url.password) {
			return { diagnostics: [extensionDiagnostic("hook.http_url_insecure", "error", "HTTP hook URL must use HTTPS without userinfo", "hook", configPath)] };
		}
		const normalized: HttpHookHandlerConfig = {
			type: "http",
			url: url.href,
			urlDigest: canonicalDigest(url.href),
		};
		return { handler: normalized, diagnostics };
	}
	let command = handler.command;
	let commandDigest: string;
	if (command.startsWith("./")) {
		const containmentRoot = pluginRoot ?? dirname(configPath);
		const contained = await resolveDeclaredPath(storage, containmentRoot, command);
		if (!contained.ok) return { diagnostics: [extensionDiagnostic("hook.command_escape", "error", contained.message, "hook", configPath)] };
		command = contained.path;
		const digest = await digestFile(storage, command, DEFAULT_EXTENSION_LIMITS.maxFileBytes);
		if (!digest.ok) return { diagnostics: [extensionDiagnostic("hook.command_digest", "error", digest.message, "hook", configPath)] };
		commandDigest = digest.digest;
	} else if (isAbsolute(command)) {
		return { diagnostics: [extensionDiagnostic("hook.absolute_command", "error", "absolute hook commands are not allowed in declarative config", "hook", configPath)] };
	} else {
		commandDigest = sha256(command);
	}
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(handler.env ?? {})) {
		if (reservedEnvironment.has(key)) {
			diagnostics.push(extensionDiagnostic("hook.reserved_env", "warning", `reserved environment key ignored: ${key}`, "hook", configPath));
			continue;
		}
		env[key] = value;
	}
	return { handler: { type: "command", command, args: handler.args ?? [], timeoutMs: handler.timeoutMs ?? 5_000, env, commandDigest }, diagnostics };
}

function processCapability(scope: ExtensionRuntimeScope, qualifiedId: string, commandDigest: string): ResourceCapabilityDeclaration {
	return {
		authorityId: scope.authorityId,
		tenantId: scope.tenantId,
		capabilityId: createRuntimeId("resource", canonicalDigest({ qualifiedId, commandDigest }).slice(0, 32)),
		claim: { authorityId: scope.authorityId, tenantId: scope.tenantId, name: "process", resourceKind: "process", resourceDigest: commandDigest, constraintsDigest: commandDigest },
		boundary: { kind: "process", access: "spawn", commandScopeDigest: commandDigest },
		required: true,
	};
}

function networkCapability(scope: ExtensionRuntimeScope, qualifiedId: string, urlDigest: string): ResourceCapabilityDeclaration {
	return {
		authorityId: scope.authorityId,
		tenantId: scope.tenantId,
		capabilityId: createRuntimeId("resource", canonicalDigest({ qualifiedId, urlDigest }).slice(0, 32)),
		claim: { authorityId: scope.authorityId, tenantId: scope.tenantId, name: "network", resourceKind: "network", resourceDigest: urlDigest, constraintsDigest: urlDigest },
		boundary: { kind: "network", access: "connect", hostScopeDigest: urlDigest },
		required: true,
	};
}

export async function loadHookConfig(options: {
	configPath: string;
	root: ExtensionSourceRoot;
	scope: ExtensionRuntimeScope;
	trustStore: TrustStore;
	state?: ExtensionStateDocument;
	pluginRoot?: string;
	pluginDataPath?: string;
	storage: ExtensionStoragePort;
}): Promise<HookConfigLoadResult> {
	const read = await options.storage.readFile(options.configPath, DEFAULT_EXTENSION_LIMITS.maxConfigBytes);
	if (!read.ok) {
		return { hooks: [], diagnostics: [extensionDiagnostic("hook.config_missing", "error", "hook config cannot be read", "hook", options.configPath)] };
	}
	const bytes = Buffer.from(read.value);
	if (bytes.byteLength > DEFAULT_EXTENSION_LIMITS.maxConfigBytes) return { hooks: [], diagnostics: [extensionDiagnostic("hook.config_oversize", "error", "hook config exceeds byte bound", "hook", options.configPath)] };
	let raw: unknown;
	try {
		raw = JSON.parse(bytes.toString("utf8"));
	} catch {
		return { hooks: [], diagnostics: [extensionDiagnostic("hook.config_json", "error", "hook config is invalid JSON", "hook", options.configPath)] };
	}
	if (!schemaAccepts(HooksConfigSchema, raw)) return { hooks: [], diagnostics: [extensionDiagnostic("hook.config_schema", "error", "hook config does not match schema v1/v2", "hook", options.configPath)] };
	const config = raw as RawHooksConfig;
	const diagnostics: ExtensionDiagnostic[] = [];
	const hooks: HookDescriptor[] = [];
	const configDigest = sha256(bytes);
	for (const event of HOOK_EVENTS) {
		for (const [index, declaration] of (config.hooks[event] ?? []).entries()) {
			let matcherRegex: RegExp | undefined;
			if (declaration.matcher) {
				try {
					matcherRegex = new RegExp(declaration.matcher, "u");
				} catch {
					diagnostics.push(extensionDiagnostic("hook.matcher_invalid", "error", "hook matcher is not a valid regular expression", "hook", options.configPath));
					continue;
				}
			}
			const normalizedHandlers: HookHandler[] = [];
			for (const handler of declaration.handlers) {
				const normalized = await normalizeHandler(options.storage, handler, options.configPath, options.pluginRoot);
				diagnostics.push(...normalized.diagnostics);
				if (normalized.handler) normalizedHandlers.push(normalized.handler);
			}
			if (normalizedHandlers.length !== declaration.handlers.length) continue;
			const name = declaration.id ?? `${event.toLocaleLowerCase()}-${index}`;
			const qualifiedId = qualifiedResourceId({ kind: "hook", sourceKey: options.root.sourceKey, name: `${event.toLocaleLowerCase()}-${name}`, ...(options.root.pluginId ? { pluginId: options.root.pluginId } : {}) });
			const commandDigest = canonicalDigest(normalizedHandlers.map((handler) =>
				handler.type === "command"
					? { type: handler.type, command: handler.command, commandDigest: handler.commandDigest, args: handler.args, envKeys: Object.keys(handler.env).sort() }
					: { type: handler.type, url: handler.url, urlDigest: handler.urlDigest }
			));
			const binding = buildResourceManifestDigest({ rootDigest: configDigest, configDigest, commandDigest, capabilityDigest: canonicalDigest({ capabilities: normalizedHandlers.map((handler) => handler.type), commandDigest }) });
			const identity = createExtensionResourceIdentity({ scope: options.scope, kind: "hook", qualifiedId, version: "1", source: options.root.pluginId ? "plugin" : options.root.source, digest: binding.combinedDigest });
			const trust = await options.trustStore.evaluate({ identity, canonicalPath: resolve(options.configPath), binding, principalId: options.scope.principalId });
			const enabled = options.state?.resources[qualifiedId]?.enabled ?? true;
			const activation = !enabled ? "disabled" : trust.state === "trusted" ? "ready" : "blocked";
			const capabilities = normalizedHandlers.map((handler) =>
				handler.type === "command"
					? processCapability(options.scope, qualifiedId, handler.commandDigest)
					: networkCapability(options.scope, qualifiedId, handler.urlDigest)
			);
			hooks.push({
				descriptor: {
					schemaVersion: 1,
					kind: "hook",
					identity,
					provenance: createExtensionResourceProvenance({
						scope: options.scope,
						source: options.root.pluginId ? "plugin" : options.root.source,
						canonicalLocator: options.configPath,
						sourceRoot: options.root.rootPath,
					}),
					manifest: binding,
					displayName: name,
					description: `${event} hook`,
					sourcePath: options.configPath,
					...(options.root.pluginId ? { pluginId: options.root.pluginId } : {}),
					enabled,
					trust: trust.state,
					activation,
					...(trust.state === "trusted" ? { approvalReceiptId: trust.receipt.receiptId } : {}),
					capabilities,
					risk: { level: "high", sideEffect: "external", rationaleDigest: canonicalDigest({ event, commandDigest }) },
					exposure: "hidden",
					diagnostics: trust.state === "trusted" ? [] : [extensionDiagnostic(`hook.${trust.state}`, "warning", trust.reason, "hook", options.configPath)],
				},
				event,
				...(declaration.matcher ? { matcher: declaration.matcher, matcherRegex } : {}),
				failureMode: effectiveHookFailureMode(event, options.root.pluginId ? "plugin" : options.root.source, declaration.failureMode),
				handlers: normalizedHandlers,
				configPath: options.configPath,
				configDirectory: dirname(options.configPath),
				priority: options.root.priority,
				declarationIndex: index,
				...(options.pluginDataPath ? { pluginDataPath: options.pluginDataPath } : {}),
			});
		}
	}
	return { hooks: hooks.sort((left, right) => left.priority - right.priority || left.configPath.localeCompare(right.configPath) || left.declarationIndex - right.declarationIndex), diagnostics };
}
