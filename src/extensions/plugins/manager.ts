/**
 * Declarative `.runledger-plugin/plugin.json` discovery.
 *
 * Plugin discovery is intentionally passive: this module parses manifests,
 * checks component containment and emits bounded descriptors.  It never
 * starts a hook/MCP process and never loads executable plugin code.
 */

import { basename, join } from "node:path";
import { canonicalDigest } from "../../runtime/protocol/canonical-json.ts";
import { runtimeDigest } from "../../runtime/protocol/foundation.ts";
import type { ResourceIdentity } from "../../runtime/resources/types.ts";
import { DEFAULT_EXTENSION_LIMITS, extensionDiagnostic, sortExtensionDiagnostics, type ExtensionDiagnostic } from "../diagnostics.ts";
import { createExtensionResourceIdentity, createExtensionResourceProvenance, qualifiedResourceId } from "../identity.ts";
import { resolveDeclaredPath } from "../paths.ts";
import type { ExtensionStoragePort } from "../storage-port.ts";
import type { ExtensionResourceDescriptor, ExtensionRuntimeScope, ExtensionSourceRoot } from "../types.ts";
import { buildResourceManifestDigest, digestDirectory, digestFile, type ExtensionManifestDigest } from "../trust/digest.ts";
import { TrustStore } from "../trust/trust-store.ts";
import type { TrustEvaluation } from "../trust/types.ts";
import { ExtensionStateStore } from "../state-store.ts";
import { discoverSkills } from "../skills/discovery.ts";
import type { SkillDescriptor } from "../skills/types.ts";
import { parseHookDocument } from "../hooks/parser.ts";

const PLUGIN_NAME = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const MANIFEST_KEYS = ["name", "version", "description", "author", "keywords", "skills", "hooks", "mcpServers"] as const;

export interface PluginManifest {
	readonly name: string;
	readonly version: string;
	readonly description: string;
	readonly author?: { readonly name: string };
	readonly keywords?: readonly string[];
	readonly skills?: readonly string[];
	readonly hooks?: readonly string[];
	readonly mcpServers?: string;
}

export type PluginManifestParseResult =
	| { readonly ok: true; readonly manifest: PluginManifest; readonly diagnostics: readonly ExtensionDiagnostic[]; readonly digest: ReturnType<typeof runtimeDigest> }
	| { readonly ok: false; readonly diagnostics: readonly ExtensionDiagnostic[]; readonly digest: ReturnType<typeof runtimeDigest> };

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown, max: number): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= max && !value.includes("\0");
}

function pathList(value: unknown): value is readonly string[] {
	return Array.isArray(value) && value.length <= 64 && value.every((item) => text(item, 512) && item.startsWith("./"));
}

function parseManifestAuthor(value: unknown, diagnostics: ExtensionDiagnostic[]): PluginManifest["author"] | undefined {
	if (value === undefined) return undefined;
	if (!record(value) || Object.keys(value).some((key) => key !== "name") || !text(value.name, 256)) {
		diagnostics.push(extensionDiagnostic("plugin.author_invalid", "error", "author must contain only a bounded name", "plugin", "$.author"));
		return undefined;
	}
	return { name: value.name };
}

/** Parses only the current exact manifest shape; no compatibility fields. */
export function parsePluginManifest(value: unknown, sourcePath = "plugin.json"): PluginManifestParseResult {
	const diagnostics: ExtensionDiagnostic[] = [];
	if (!record(value)) {
		diagnostics.push(extensionDiagnostic("plugin.document_invalid", "error", "plugin manifest must be a JSON object", "plugin", sourcePath));
		return { ok: false, diagnostics, digest: runtimeDigest(value) };
	}
	const unknown = Object.keys(value).filter((key) => !(MANIFEST_KEYS as readonly string[]).includes(key));
	if (unknown.length > 0) diagnostics.push(extensionDiagnostic("plugin.unknown_field", "error", `unknown plugin manifest field: ${unknown.sort()[0]}`, "plugin", sourcePath));
	if (!text(value.name, 64) || !PLUGIN_NAME.test(value.name)) diagnostics.push(extensionDiagnostic("plugin.name_invalid", "error", "name must be a lower-case package name", "plugin", `${sourcePath}#/name`));
	if (!text(value.version, 128) || !SEMVER.test(value.version)) diagnostics.push(extensionDiagnostic("plugin.version_invalid", "error", "version must be strict semver", "plugin", `${sourcePath}#/version`));
	if (!text(value.description, 1_024)) diagnostics.push(extensionDiagnostic("plugin.description_invalid", "error", "description is required and bounded", "plugin", `${sourcePath}#/description`));
	const author = parseManifestAuthor(value.author, diagnostics);
	if (value.keywords !== undefined && (!Array.isArray(value.keywords) || value.keywords.length > 64 || !value.keywords.every((item) => text(item, 128)))) diagnostics.push(extensionDiagnostic("plugin.keywords_invalid", "error", "keywords must be bounded strings", "plugin", `${sourcePath}#/keywords`));
	if (value.skills !== undefined && !pathList(value.skills)) diagnostics.push(extensionDiagnostic("plugin.skills_invalid", "error", "skills must be relative plugin paths", "plugin", `${sourcePath}#/skills`));
	if (value.hooks !== undefined && !pathList(value.hooks)) diagnostics.push(extensionDiagnostic("plugin.hooks_invalid", "error", "hooks must be relative plugin paths", "plugin", `${sourcePath}#/hooks`));
	if (value.mcpServers !== undefined && (!text(value.mcpServers, 512) || !value.mcpServers.startsWith("./"))) diagnostics.push(extensionDiagnostic("plugin.mcp_invalid", "error", "mcpServers must be one relative config path", "plugin", `${sourcePath}#/mcpServers`));
	const sorted = sortExtensionDiagnostics(diagnostics);
	if (sorted.some((item) => item.severity === "error")) return { ok: false, diagnostics: sorted, digest: runtimeDigest(value) };
	const manifest: PluginManifest = {
		name: value.name as string,
		version: value.version as string,
		description: value.description as string,
		...(author === undefined ? {} : { author }),
		...(value.keywords === undefined ? {} : { keywords: [...value.keywords as string[]] }),
		...(value.skills === undefined ? {} : { skills: [...value.skills as string[]] }),
		...(value.hooks === undefined ? {} : { hooks: [...value.hooks as string[]] }),
		...(value.mcpServers === undefined ? {} : { mcpServers: value.mcpServers as string }),
	};
	return { ok: true, manifest, diagnostics: sorted, digest: runtimeDigest(manifest) };
}

export interface PluginRecord {
	readonly descriptor: ExtensionResourceDescriptor;
	readonly rootPath: string;
	readonly manifestPath: string;
	readonly manifest: PluginManifest;
	readonly binding: ExtensionManifestDigest;
	readonly trust: TrustEvaluation;
	readonly componentPaths: readonly string[];
}

export interface PluginDiscoveryResult {
	readonly plugins: readonly PluginRecord[];
	readonly descriptors: readonly ExtensionResourceDescriptor[];
	readonly diagnostics: readonly ExtensionDiagnostic[];
}

export interface PluginManagerOptions {
	readonly storage: ExtensionStoragePort;
	readonly trustStore: TrustStore;
	readonly stateStore: ExtensionStateStore;
	readonly scope: ExtensionRuntimeScope;
	readonly roots: readonly ExtensionSourceRoot[];
}

function trustScope(root: ExtensionSourceRoot): "user" | "project" | "session" {
	return root.source === "user" ? "user" : root.source === "session" ? "session" : "project";
}

function pluginIdentity(root: ExtensionSourceRoot, manifest: PluginManifest, digest: string): ResourceIdentity {
	return createExtensionResourceIdentity({ kind: "plugin", qualifiedId: qualifiedResourceId({ kind: "plugin", sourceKey: root.sourceKey, name: manifest.name }), version: manifest.version, source: root.source, digest });
}

function componentDescriptor(input: {
	readonly plugin: PluginRecord;
	readonly kind: "skill" | "hook" | "mcp-server";
	readonly name: string;
	readonly path: string;
	readonly digest: string;
	readonly enabled: boolean;
	readonly trusted: boolean;
	readonly ready: boolean;
	readonly diagnostic?: ExtensionDiagnostic;
}): ExtensionResourceDescriptor {
	const qualifiedId = `${input.kind}:${input.plugin.descriptor.identity.qualifiedId}:${input.name}`;
	const resource = createExtensionResourceIdentity({ kind: input.kind, qualifiedId, version: input.plugin.manifest.version, source: "plugin", digest: input.digest });
	return {
		kind: input.kind,
		identity: { kind: input.kind, qualifiedId, version: input.plugin.manifest.version, source: "plugin", digest: input.digest },
		resource,
		provenance: createExtensionResourceProvenance({ source: "plugin", canonicalLocator: input.path, sourceRoot: input.plugin.rootPath, parentResourceId: input.plugin.descriptor.resource.resourceId }),
		displayName: input.name,
		sourcePath: input.path,
		pluginId: input.plugin.descriptor.identity.qualifiedId,
		priority: input.plugin.descriptor.priority,
		enabled: input.enabled,
		trusted: input.trusted,
		ready: input.ready,
		trust: input.trusted ? "trusted" : "untrusted",
		activation: !input.enabled ? "disabled" : input.ready ? "ready" : "blocked",
		...(input.diagnostic === undefined ? {} : { diagnostics: [input.diagnostic] }),
	};
}

function componentName(path: string, fallback: string): string {
	const name = basename(path).replace(/\.[^.]+$/u, "");
	return name.length > 0 ? name : fallback;
}

async function readJson(storage: ExtensionStoragePort, path: string, maxBytes: number): Promise<{ readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly message: string }> {
	const read = await storage.readFile(path, maxBytes);
	if (!read.ok) return read;
	try { return { ok: true, value: JSON.parse(Buffer.from(read.value).toString("utf8")) as unknown }; }
	catch { return { ok: false, message: "JSON document is invalid" }; }
}

export class PluginManager {
	readonly #options: PluginManagerOptions;
	#last: PluginDiscoveryResult | undefined;

	public constructor(options: PluginManagerOptions) {
		this.#options = options;
	}

	public last(): PluginDiscoveryResult | undefined {
		return this.#last;
	}

	public async discover(): Promise<PluginDiscoveryResult> {
		const plugins: PluginRecord[] = [];
		const descriptors: ExtensionResourceDescriptor[] = [];
		const diagnostics: ExtensionDiagnostic[] = [];
		const state = await this.#options.stateStore.load();
		for (const root of [...this.#options.roots].sort((left, right) => left.priority - right.priority || left.rootPath.localeCompare(right.rootPath))) {
			const rootResult = await this.#options.storage.realpath(root.rootPath);
			if (!rootResult.ok) continue;
			const manifestPath = join(rootResult.value, ".runledger-plugin", "plugin.json");
			const manifestFile = await readJson(this.#options.storage, manifestPath, DEFAULT_EXTENSION_LIMITS.maxFileBytes);
			if (!manifestFile.ok) {
				diagnostics.push(extensionDiagnostic("plugin.manifest_unavailable", "error", manifestFile.message, "plugin", manifestPath));
				continue;
			}
			const parsed = parsePluginManifest(manifestFile.value, manifestPath);
			diagnostics.push(...parsed.diagnostics);
			if (!parsed.ok) {
				descriptors.push(invalidPluginDescriptor(root, rootResult.value, manifestPath, parsed.digest.digest, parsed.diagnostics));
				continue;
			}
			const rootDigest = await digestDirectory(this.#options.storage, rootResult.value, DEFAULT_EXTENSION_LIMITS);
			const manifestDigest = await digestFile(this.#options.storage, manifestPath, DEFAULT_EXTENSION_LIMITS.maxFileBytes);
			if (!manifestDigest.ok) {
				diagnostics.push(extensionDiagnostic("plugin.digest_failed", "error", "plugin root or manifest could not be digested", "plugin", manifestPath));
				continue;
			}
			const rootDigestValue = rootDigest.ok ? rootDigest.digest : canonicalDigest({ root: rootResult.value, error: rootDigest.message });
			if (!rootDigest.ok) diagnostics.push(extensionDiagnostic("plugin.root_invalid", "error", rootDigest.message, "plugin", rootResult.value));
			const binding = buildResourceManifestDigest({ rootDigest: rootDigestValue, manifestDigest: manifestDigest.digest, configDigest: parsed.digest.digest, assetsDigest: rootDigestValue, capabilityDigest: canonicalDigest({ skills: parsed.manifest.skills ?? [], hooks: parsed.manifest.hooks ?? [], mcpServers: parsed.manifest.mcpServers ?? null }) });
			const resource = pluginIdentity(root, parsed.manifest, binding.combinedDigest);
			const qualifiedId = resource.qualifiedId;
			const trust = await this.#options.trustStore.evaluate({ identity: resource, canonicalPath: rootResult.value, binding, principalId: this.#options.scope.principalId, scope: trustScope(root) });
			const enabled = state.resources[qualifiedId]?.enabled ?? false;
			let plugin: PluginRecord = {
				descriptor: {
					kind: "plugin" as const,
					identity: { kind: "plugin" as const, qualifiedId, version: parsed.manifest.version, source: root.source, digest: binding.combinedDigest },
					resource,
					provenance: createExtensionResourceProvenance({ source: root.source, canonicalLocator: rootResult.value, sourceRoot: rootResult.value }),
					displayName: parsed.manifest.name,
					description: parsed.manifest.description,
					sourcePath: manifestPath,
					priority: root.priority,
					enabled,
					trusted: trust.state === "trusted",
					ready: enabled && trust.state === "trusted",
					trust: trust.state,
					activation: !enabled ? "disabled" as const : trust.state !== "trusted" ? "blocked" as const : "ready" as const,
					...(trust.state === "trusted" ? { approvalReceiptId: trust.receipt.receiptId } : {}),
				},
				rootPath: rootResult.value,
				manifestPath,
				manifest: parsed.manifest,
				binding,
				trust,
				componentPaths: [...(parsed.manifest.skills ?? []), ...(parsed.manifest.hooks ?? []), ...(parsed.manifest.mcpServers === undefined ? [] : [parsed.manifest.mcpServers])],
			};
			let pathFailure = !rootDigest.ok;
			const trustedAndEnabled = plugin.descriptor.enabled && plugin.descriptor.trusted;
			for (const declaration of parsed.manifest.skills ?? []) {
				const path = await resolveDeclaredPath(this.#options.storage, rootResult.value, declaration);
				if (!path.ok) {
					pathFailure = true;
					const diagnostic = extensionDiagnostic("plugin.path_escape", "error", path.message, "plugin", `${manifestPath}#/skills`);
					diagnostics.push(diagnostic);
					continue;
				}
				const name = componentName(path.path, "skill");
				if (!trustedAndEnabled) {
					descriptors.push(componentDescriptor({ plugin, kind: "skill", name, path: path.path, digest: binding.combinedDigest, enabled: plugin.descriptor.enabled, trusted: plugin.descriptor.trusted, ready: false }));
					continue;
				}
				const discovered = await discoverSkills({ roots: [{ ...root, rootPath: rootResult.value, skillsPath: path.path, pluginId: qualifiedId, layout: "plugin-root" }], scope: this.#options.scope, trustStore: this.#options.trustStore, state, storage: this.#options.storage });
				diagnostics.push(...discovered.diagnostics);
				for (const skill of discovered.skills) descriptors.push(skill.descriptor);
			}
			for (const declaration of parsed.manifest.hooks ?? []) {
				const path = await resolveDeclaredPath(this.#options.storage, rootResult.value, declaration);
				if (!path.ok) {
					pathFailure = true;
					diagnostics.push(extensionDiagnostic("plugin.path_escape", "error", path.message, "plugin", `${manifestPath}#/hooks`));
					continue;
				}
				const parsedHook = trustedAndEnabled ? await readJson(this.#options.storage, path.path, DEFAULT_EXTENSION_LIMITS.maxFileBytes) : undefined;
				if (parsedHook !== undefined && parsedHook.ok) {
					const hookResult = parseHookDocument(parsedHook.value, { sourceLayer: "plugin", sourcePath: path.path });
					diagnostics.push(...hookResult.diagnostics);
					for (const hook of hookResult.hooks) descriptors.push(componentDescriptor({ plugin, kind: "hook", name: hook.id, path: path.path, digest: hookResult.digest?.digest ?? binding.combinedDigest, enabled: true, trusted: true, ready: hookResult.ok }));
				} else if (trustedAndEnabled) {
					diagnostics.push(extensionDiagnostic("plugin.hook_invalid", "error", parsedHook?.message ?? "hook configuration is unavailable", "plugin", path.path));
				} else {
					descriptors.push(componentDescriptor({ plugin, kind: "hook", name: componentName(path.path, "hook"), path: path.path, digest: binding.combinedDigest, enabled: plugin.descriptor.enabled, trusted: plugin.descriptor.trusted, ready: false }));
				}
			}
			if (parsed.manifest.mcpServers !== undefined) {
				const path = await resolveDeclaredPath(this.#options.storage, rootResult.value, parsed.manifest.mcpServers);
				if (!path.ok) {
					pathFailure = true;
					diagnostics.push(extensionDiagnostic("plugin.path_escape", "error", path.message, "plugin", `${manifestPath}#/mcpServers`));
				}
				else {
					const config = trustedAndEnabled ? await readJson(this.#options.storage, path.path, DEFAULT_EXTENSION_LIMITS.maxFileBytes) : undefined;
					const names = config !== undefined && config.ok ? mcpNames(config.value) : [componentName(path.path, "mcp")];
					for (const name of names) descriptors.push(componentDescriptor({ plugin, kind: "mcp-server", name, path: path.path, digest: config !== undefined && config.ok ? canonicalDigest(config.value) : binding.combinedDigest, enabled: plugin.descriptor.enabled, trusted: plugin.descriptor.trusted, ready: trustedAndEnabled && config !== undefined && config.ok }));
					if (trustedAndEnabled && (config === undefined || !config.ok)) diagnostics.push(extensionDiagnostic("plugin.mcp_invalid", "error", config?.message ?? "MCP configuration is unavailable", "plugin", path.path));
				}
			}
			if (pathFailure) plugin = { ...plugin, descriptor: { ...plugin.descriptor, ready: false, activation: "failed" } };
			plugins.push(plugin);
			descriptors.unshift(plugin.descriptor);
		}
		const duplicateIds = new Set<string>();
		const duplicateGroups = new Map<string, PluginRecord[]>();
		for (const plugin of plugins) {
			const key = plugin.descriptor.identity.qualifiedId;
			const group = duplicateGroups.get(key) ?? [];
			group.push(plugin);
			duplicateGroups.set(key, group);
		}
		for (const [qualifiedId, group] of duplicateGroups) {
			if (group.length < 2) continue;
			duplicateIds.add(qualifiedId);
			diagnostics.push(extensionDiagnostic("plugin.duplicate_identity", "error", `duplicate plugin identity: ${qualifiedId}`, "plugin", qualifiedId));
		}
		const duplicateDiagnostic = (qualifiedId: string): ExtensionDiagnostic => extensionDiagnostic("plugin.duplicate_identity", "error", "plugin identity is ambiguous and cannot be activated", "plugin", qualifiedId);
		const resolvedPlugins = plugins
			.map((plugin) => duplicateIds.has(plugin.descriptor.identity.qualifiedId)
				? { ...plugin, descriptor: { ...plugin.descriptor, ready: false, activation: "failed" as const, diagnostics: [ ...(plugin.descriptor.diagnostics ?? []), duplicateDiagnostic(plugin.descriptor.identity.qualifiedId) ] } }
				: plugin)
			.sort((left, right) => left.descriptor.identity.qualifiedId.localeCompare(right.descriptor.identity.qualifiedId));
		const resolvedDescriptors = descriptors.map((descriptor) => {
			const pluginId = descriptor.kind === "plugin" ? descriptor.identity.qualifiedId : descriptor.pluginId;
			if (!pluginId || !duplicateIds.has(pluginId)) return descriptor;
			return { ...descriptor, ready: false, activation: "failed" as const, diagnostics: [ ...(descriptor.diagnostics ?? []), duplicateDiagnostic(pluginId) ] };
		});
		const result = { plugins: resolvedPlugins, descriptors: resolvedDescriptors, diagnostics: sortExtensionDiagnostics(diagnostics) };
		this.#last = result;
		return result;
	}

	public async setEnabled(pluginId: string, enabled: boolean): Promise<PluginDiscoveryResult> {
		if (!this.#last?.plugins.some((plugin) => plugin.descriptor.identity.qualifiedId === pluginId)) throw new Error("plugin identity is not present in the current snapshot");
		await this.#options.stateStore.setEnabled(pluginId, enabled);
		return this.discover();
	}

	public async trust(pluginId: string): Promise<PluginDiscoveryResult> {
		const plugin = this.#last?.plugins.find((item) => item.descriptor.identity.qualifiedId === pluginId);
		if (!plugin) throw new Error("plugin identity is not present in the current snapshot");
		await this.#options.trustStore.grant({ identity: plugin.descriptor.resource, canonicalPath: plugin.rootPath, binding: plugin.binding, principalId: this.#options.scope.principalId, scope: trustScope(this.#options.roots.find((root) => root.rootPath === plugin.rootPath) ?? this.#options.roots[0]!) });
		return this.discover();
	}

	public async untrust(pluginId: string): Promise<PluginDiscoveryResult> {
		const plugin = this.#last?.plugins.find((item) => item.descriptor.identity.qualifiedId === pluginId);
		if (!plugin) throw new Error("plugin identity is not present in the current snapshot");
		await this.#options.trustStore.revoke(plugin.descriptor.resource);
		return this.discover();
	}
}

function invalidPluginDescriptor(
	root: ExtensionSourceRoot,
	canonicalRoot: string,
	manifestPath: string,
	digest: string,
	diagnostics: readonly ExtensionDiagnostic[],
): ExtensionResourceDescriptor {
	const qualifiedId = `plugin:${root.sourceKey}:invalid-${digest.slice(0, 16)}`;
	const identity = createExtensionResourceIdentity({
		kind: "plugin",
		qualifiedId,
		version: "0.0.0",
		source: root.source,
		digest,
	});
	return {
		kind: "plugin",
		identity: { kind: "plugin", qualifiedId, version: "0.0.0", source: root.source, digest },
		resource: identity,
		provenance: createExtensionResourceProvenance({ source: root.source, canonicalLocator: canonicalRoot, sourceRoot: canonicalRoot }),
		displayName: "invalid-plugin",
		sourcePath: manifestPath,
		priority: root.priority,
		enabled: false,
		trusted: false,
		ready: false,
		trust: "untrusted",
		activation: "failed",
		diagnostics: diagnostics.length > 0 ? [...diagnostics] : [extensionDiagnostic("plugin.invalid_manifest", "error", "plugin manifest is invalid", "plugin", manifestPath)],
	};
}

function mcpNames(value: unknown): readonly string[] {
	if (!record(value) || !record(value.mcpServers)) return ["mcp"];
	return Object.keys(value.mcpServers).filter((name) => PLUGIN_NAME.test(name)).sort();
}

export type { SkillDescriptor };
