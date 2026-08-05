/** Resident Host process entry used by the production connect-or-spawn path. */

import { Value } from "typebox/value";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AuthStorage } from "../storage/auth-storage.ts";
import { loadProjectSettings } from "../storage/settings-manager.ts";
import { resolveRecordingConfig } from "../storage/settings-manager.ts";
import { builtinModels } from "../providers/all.ts";
import { EndpointStore } from "../storage/host/endpoint-store.ts";
import { acquireHostWriterLease } from "../storage/host/writer-lease.ts";
import { HostRecoveryMarkerStore } from "../storage/host/recovery-marker.ts";
import { buildRunledgerLayout } from "../runtime/contracts/storage-layout.ts";
import { createRuntimeId, parseRuntimeId } from "../runtime/protocol/ids.ts";
import { runtimeDigest } from "../runtime/protocol/foundation.ts";
import { HostCompatibilityEnvelopeSchema, type HostCompatibilityEnvelope } from "../runtime/host/contracts.ts";
import { createLocalTraceRecorderFactory } from "../runtime/trace/composition.ts";
import { FileArtifactStore } from "../runtime/trace/artifact-store.ts";
import { createArtifactToolResultOverflowStore } from "../runtime/trace/tool-result-overflow.ts";
import { HostReversePermissionPrompter, ResidentRuntimeHost } from "./runtime-host-service.ts";
import { createProductionHostSessionFactory } from "./runtime-host-session.ts";
import { ProductionManagedProcessPort } from "./runtime-host-process.ts";
import { createProductionHostSecurity } from "./runtime-host-security.ts";
import { productionHostSocketPath } from "./runtime-host-production.ts";
import { createLinuxSocketPeerAttestor, defaultLinuxPeerCredentialHelperPath } from "./linux-peer-attestor.ts";
import { RuntimeHostLifecycle } from "../runtime/host/lifecycle.ts";
import { JsonlHostEventStore } from "../storage/host/event-store.ts";
import { JsonlRuntimeEventStore } from "../storage/host/runtime-event-store.ts";
import { JsonHostCommandStore } from "../storage/host/command-store.ts";
import { JsonWorkspaceBindingStore } from "../worktree/persisted-binding.ts";
import { HostWorkspaceBindingService, type WorkspaceBindingAuditPort } from "../worktree/host-binding.ts";
import { RuntimeWorkspaceAuditAdapter } from "../worktree/integration/runtime-workspace-events.ts";
import { JsonlWorktreeRegistryStore, WorktreeRegistry } from "../worktree/registry.ts";
import { createProductionGitCommandPort } from "./runtime-host-production.ts";
import { createExtensionSnapshotEvent, createHostDomainPorts } from "./runtime-host-domains.ts";
import { createHostModelContextDomainPort, type HostModelContextDomainOptions } from "./runtime-host-model-context.ts";
import { loadCanonicalModelCompatibilityRouter } from "./runtime-host-model-manifest.ts";
import { createHostModelRequestRouter } from "./runtime-host-model-router.ts";
import { createHostMcpResourceInvocationPort, createHostMcpRuntime } from "./runtime-host-mcp.ts";
import { createMcpExecutionEnvFetch, createSdkMcpClientFactory } from "../extensions/mcp/sdk-factory.ts";
import { McpConnectionManager } from "../extensions/mcp/connection-manager.ts";
import { loadCanonicalMcpConfigs } from "../extensions/mcp/config.ts";
import type { ContextAssemblySink } from "../runtime/types.ts";
import type { RuntimeEventPayloadFor } from "../runtime/protocol/events.ts";
import type { RuntimeEventAppendInput, RuntimeEventWriter } from "../storage/host/runtime-event-store.ts";
import { NodeExtensionStorage } from "../storage/extensions/extension-storage.ts";
import { ExtensionStateStore } from "../extensions/state-store.ts";
import { TrustStore } from "../extensions/trust/trust-store.ts";
import { PluginManager } from "../extensions/plugins/manager.ts";
import { ExtensionHostManager, projectExtensionSnapshot } from "../extensions/host-manager.ts";
import { sourceKey } from "../extensions/paths.ts";
import type { ExtensionSource, ExtensionSourceRoot } from "../extensions/types.ts";

export async function runResidentRuntimeHost(): Promise<void> {
	if (process.platform !== "linux") throw new Error("resident production Host currently requires Linux local peer attestation");
	const home = process.env.RUNLEDGER_HOST_HOME;
	const rawScope = process.env.RUNLEDGER_HOST_SCOPE;
	const cwd = process.env.RUNLEDGER_HOST_CWD;
	const hostGeneration = parseGeneration(process.env.RUNLEDGER_HOST_GENERATION);
	if (!home || !rawScope || !cwd) throw new Error("resident Host environment is incomplete");
	const scope = parseScope(rawScope);
	const layout = buildRunledgerLayout(home, "posix");
	const extensionStorage = new NodeExtensionStorage({ runledgerHome: layout.home });
	const mcpConfig = await loadCanonicalMcpConfigs({
		layout,
		workspaceStorageKey: scope.workspaceStorageKey,
		storage: extensionStorage,
		environment: process.env,
	});
	if (mcpConfig.diagnostics.some((item) => item.severity === "error")) throw new Error("canonical MCP configuration is invalid");
	const endpointStore = new EndpointStore(layout, scope.workspaceStorageKey);
	const lease = await acquireHostWriterLease(layout, scope.workspaceStorageKey);
	if (!lease.ok) throw new Error(lease.code);
	const markerStore = new HostRecoveryMarkerStore(layout, scope.workspaceStorageKey);
	const settings = await loadProjectSettings({ layout });
	const recording = resolveRecordingConfig(settings);
	const traceRecorderFactory = createLocalTraceRecorderFactory({ layout, config: recording });
	const models = builtinModels({ credentials: AuthStorage.create(layout) });
	await models.refresh({ allowNetwork: false });
	const modelCompatibility = await loadCanonicalModelCompatibilityRouter(layout);
	const modelPrincipalId = createRuntimeId("principal", `host-model-${scope.workspaceStorageKey.slice(3, 67)}`);
	const workspaceBindingStore = new JsonWorkspaceBindingStore({ layout, workspaceStorageKey: scope.workspaceStorageKey });
	const runtimeEventWriter = new JsonlRuntimeEventStore({ layout, workspaceStorageKey: scope.workspaceStorageKey });
	const workspaceAudit = new RuntimeWorkspaceAuditAdapter({
		authorityId: scope.authorityId,
		tenantId: scope.tenantId,
		sessionId: createRuntimeId("session", `workspace-${scope.workspaceStorageKey.slice(3)}`),
		principalId: createRuntimeId("principal", `host-workspace-${scope.workspaceStorageKey.slice(3)}`),
		writer: runtimeEventWriter,
	});
	const workspaceBinding = await restoreResidentWorkspaceBinding({ layout, scope, cwd, workspaceAudit });
	const hostRuntimeId = createRuntimeId("runtime", `host-${hostGeneration}-${scope.workspaceStorageKey.slice(3, 19)}`);
	const extensionStateRoot = join(layout.state, "extensions");
	const extensionPrincipalId = createRuntimeId("principal", `host-extension-${scope.workspaceStorageKey.slice(3, 19)}`);
	const extensionEventSessionId = createRuntimeId("session", `extensions-${scope.workspaceStorageKey.slice(3, 67)}`);
	const extensionRoots = await discoverCanonicalPluginRoots(extensionStorage, [
		{ source: "user", root: join(extensionStateRoot, "user", "plugins"), priority: 100 },
		{ source: "project", root: join(extensionStateRoot, "workspaces", scope.workspaceStorageKey, "plugins"), priority: 200 },
	]);
	const extensionManager = new ExtensionHostManager({
		pluginManager: new PluginManager({
			storage: extensionStorage,
			trustStore: new TrustStore(join(extensionStateRoot, "trust.json"), extensionStorage),
			stateStore: new ExtensionStateStore(join(extensionStateRoot, "extensions-state.json"), extensionStorage),
			scope: { authorityId: scope.authorityId, tenantId: scope.tenantId, principalId: extensionPrincipalId },
			roots: extensionRoots,
		}),
	});
	const extensionLoad = await extensionManager.load();
	if (extensionLoad.status === "failed") throw new Error(extensionLoad.error ?? "extension snapshot could not be loaded");
	if (extensionLoad.snapshot !== undefined) {
		const event = createExtensionSnapshotEvent({ authorityId: scope.authorityId, tenantId: scope.tenantId, principalId: extensionPrincipalId, sessionId: extensionEventSessionId, snapshot: projectExtensionSnapshot(extensionLoad.snapshot) });
		if (event === undefined) throw new Error("initial extension snapshot event identity is invalid");
		await runtimeEventWriter.append(event);
	}
	const workspaceBindingService = new HostWorkspaceBindingService({
		layout,
		workspaceStorageKey: scope.workspaceStorageKey,
		managedRoot: join(layout.tmp, "worktrees"),
		registry: new WorktreeRegistry(new JsonlWorktreeRegistryStore(layout)),
		git: createProductionGitCommandPort(),
		ownerRuntimeId: workspaceBinding?.lease.ownerRuntimeId ?? hostRuntimeId,
		audit: workspaceAudit,
	});
	let residentHost: ResidentRuntimeHost | undefined;
	const security = await createProductionHostSecurity({
		layout,
		scope,
		cwd,
		...(workspaceBinding === undefined ? {} : { workspaceBinding }),
		runtimeEventWriter,
		permissionPrompter: new HostReversePermissionPrompter(() => residentHost),
	});
	const artifactStore = recording.mode === "events_and_artifacts"
		? new FileArtifactStore({ dataRoot: layout.artifacts, metadataRoot: layout.artifactMetadata })
		: undefined;
	const toolResultOverflowStore = artifactStore === undefined
		? undefined
		: createArtifactToolResultOverflowStore(artifactStore);
	let lifecycle: RuntimeHostLifecycle | undefined;
	let closing = false;
	let shutdownHost: () => Promise<void> = async () => {};
	const processPort = new ProductionManagedProcessPort({
		layout,
		scope,
		hostGeneration,
		recordingMode: recording.mode,
		recordingFailurePolicy: recording.failurePolicy,
		traceRecorderFactory,
		...(artifactStore === undefined ? {} : { artifactStore }),
		security,
	});
	const modelContextDomain = createProductionModelContextDomainPort({
		layout,
		scope,
		policyCeilingDigest: security.snapshot.policyDigest,
		...(modelCompatibility.ok ? { modelRouter: modelCompatibility.router } : { modelRouterUnavailable: modelCompatibility.error.code }),
	});
	const host = new ResidentRuntimeHost({
		socketPath: productionHostSocketPath(layout, scope.workspaceStorageKey),
		scope,
		hostRuntimeId,
		hostGeneration,
		processPort,
		domainPorts: createHostDomainPorts({
			security: { snapshot: security.snapshot },
			workspace: { workspaceId: scope.workspaceId, defaultCwd: cwd, service: workspaceBindingService },
			mcp: { authorityId: scope.authorityId, tenantId: scope.tenantId },
			extensions: { manager: extensionManager, authorityId: scope.authorityId, tenantId: scope.tenantId },
			modelContext: modelContextDomain,
		}),
		runtimeEventWriter,
		eventStore: new JsonlHostEventStore({ layout, workspaceStorageKey: scope.workspaceStorageKey }),
		commandStore: new JsonHostCommandStore({ layout, workspaceStorageKey: scope.workspaceStorageKey }),
		attestor: createLinuxSocketPeerAttestor({
			helperPath: process.env.RUNLEDGER_HOST_PEER_CREDENTIAL_HELPER ?? defaultLinuxPeerCredentialHelperPath(),
			scopeDigest: scope.compatibilityDigest,
			hostGeneration,
		}),
		onEndpoint: (endpoint) => endpointStore.publish(endpoint),
		createSession: createProductionHostSessionFactory({
			layout,
			defaultCwd: cwd,
			systemPrompt: buildSystemPrompt(cwd, layout.agents),
			models,
			settings,
			traceRecorderFactory,
			toolResultOverflowStore,
			processPort,
			security,
			workspaceBinding,
			workspaceBindingStore,
			mcpConfigs: mcpConfig.configs,
			createMcpRuntime: async ({ sessionId, cwd: sessionCwd, toolRegistry }) => {
				const parsedSessionId = parseRuntimeId("session", sessionId);
				if (parsedSessionId === undefined) throw new Error("Host session identity is invalid for MCP composition");
				const mcpPrincipalId = createRuntimeId("principal", `host-mcp-${runtimeDigest({ sessionId, workspace: scope.workspaceStorageKey }).digest.slice(0, 48)}`);
				const executionEnv = security.createExecutionEnv({ sessionId, principalId: mcpPrincipalId, cwd: sessionCwd });
				if (executionEnv.network === undefined) throw new Error("Host network Gateway is unavailable for MCP");
				const managedProcess = processPort.toolClient(sessionId, 1, mcpPrincipalId);
				const adapter = {
					adapterId: "runledger.host.mcp",
					generation: 1,
					configDigest: mcpConfig.digest,
				};
				const manager = new McpConnectionManager({
					factory: createSdkMcpClientFactory({
						managedProcess,
						managedProcessCwd: sessionCwd,
						httpFetch: createMcpExecutionEnvFetch(executionEnv.network),
					}),
				});
				return createHostMcpRuntime({
					manager,
					resources: {
						invocation: createHostMcpResourceInvocationPort({
							adapter,
							sessionId,
							principalId: mcpPrincipalId,
							cwd: sessionCwd,
							authorize: (request) => security.authorizeResource(request),
						}),
					},
					toolRegistry,
					adapter,
					authorityId: scope.authorityId,
					tenantId: scope.tenantId,
					principalId: mcpPrincipalId,
					sessionId: parsedSessionId,
					snapshotId: createRuntimeId("snapshot", `mcp-${scope.workspaceStorageKey.slice(3, 19)}-${mcpConfig.digest.digest.slice(0, 32)}`),
				});
			},
			extensionManager,
			onExtensionIdleReload: async (sessionId, result) => {
				if (result.snapshot === undefined) return;
				const event = createExtensionSnapshotEvent({ authorityId: scope.authorityId, tenantId: scope.tenantId, principalId: extensionPrincipalId, sessionId, snapshot: projectExtensionSnapshot(result.snapshot) });
				if (event === undefined) throw new Error("extension reload event identity is invalid");
				await runtimeEventWriter.append(event);
			},
			contextAssemblySink: createContextAssemblySink({
				authorityId: scope.authorityId,
				tenantId: scope.tenantId,
				principalId: modelPrincipalId,
				writer: runtimeEventWriter,
			}),
			createModelRequestRouter: (sessionId) => {
				const parsedSessionId = parseRuntimeId("session", sessionId);
				if (parsedSessionId === undefined) throw new Error("Host session identity is invalid for model routing");
				return createHostModelRequestRouter({
					authorityId: scope.authorityId,
					tenantId: scope.tenantId,
					principalId: modelPrincipalId,
					sessionId: parsedSessionId,
					writer: runtimeEventWriter,
					...(modelCompatibility.ok ? { router: modelCompatibility.router } : { unavailableCode: modelCompatibility.error.code }),
				});
			},
			planStateProvider: (sessionId) => modelContextDomain.planState(sessionId),
		}),
		onShutdown: async () => {
			await shutdownHost();
			setImmediate(() => process.exit(process.exitCode ?? 0));
		},
	});
	residentHost = host;
	lifecycle = new RuntimeHostLifecycle({
		hostGeneration,
		artifactMode: recording.mode,
		ports: {
			recoverUnattached: () => processPort.recoverUnattached(),
			closeAdmission: () => host.closeAdmission(),
			drainTurns: () => host.drainTurns(),
			listProcesses: async () => processPort.lifecycleProcesses(),
			flushWriter: () => host.flushWriters(),
			release: async () => {
				await host.close();
				const released = await workspaceBindingService.release("host_shutdown");
				if (!released.ok) throw new Error(`workspace release ${released.error.code}: ${released.error.message}`);
			},
			writeRecoveryMarker: (marker) => markerStore.append(marker),
		},
	});
	const shutdown = async (): Promise<void> => {
		if (closing) return;
		closing = true;
		const result = await lifecycle.shutdown().catch(() => undefined);
		await endpointStore.remove().catch(() => undefined);
		await lease.release().catch(() => undefined);
		if (result && !result.ok) process.exitCode = 1;
	};
	shutdownHost = shutdown;
	process.once("SIGTERM", () => { void shutdown().finally(() => process.exit(process.exitCode ?? 0)); });
	process.once("SIGINT", () => { void shutdown().finally(() => process.exit(process.exitCode ?? 0)); });
	try {
		const recovery = await lifecycle.recoverAfterRestart();
		if (!recovery.ok) throw new Error("Host recovery incomplete");
		await host.start();
	} catch (error) {
		await host.close().catch(() => undefined);
		await endpointStore.remove().catch(() => undefined);
		await lease.release().catch(() => undefined);
		throw error;
	}
}

/** Production composition helper used by the resident Host and its tests. */
export function createProductionModelContextDomainPort(options: {
	readonly layout: ReturnType<typeof buildRunledgerLayout>;
	readonly scope: HostCompatibilityEnvelope;
	readonly policyCeilingDigest?: HostModelContextDomainOptions["policyCeilingDigest"];
	readonly modelRouter?: HostModelContextDomainOptions["modelRouter"];
	readonly modelRouterUnavailable?: HostModelContextDomainOptions["modelRouterUnavailable"];
	readonly summarizer?: HostModelContextDomainOptions["summarizer"];
}) {
	return createHostModelContextDomainPort({
		layout: options.layout,
		workspaceStorageKey: options.scope.workspaceStorageKey,
		authorityId: options.scope.authorityId,
		tenantId: options.scope.tenantId,
		workspaceId: options.scope.workspaceId,
		policyCeilingDigest: options.policyCeilingDigest ?? runtimeDigest({ securityAdapterDigest: options.scope.securityAdapterDigest }),
		...(options.modelRouter === undefined ? {} : { modelRouter: options.modelRouter }),
		...(options.modelRouterUnavailable === undefined ? {} : { modelRouterUnavailable: options.modelRouterUnavailable }),
		...(options.summarizer === undefined ? {} : { summarizer: options.summarizer }),
	});
}

async function discoverCanonicalPluginRoots(
	storage: NodeExtensionStorage,
	inputs: readonly { readonly source: ExtensionSource; readonly root: string; readonly priority: number }[],
): Promise<readonly ExtensionSourceRoot[]> {
	const roots: ExtensionSourceRoot[] = [];
	for (const input of inputs) {
		const rootResult = await storage.realpath(input.root);
		if (!rootResult.ok) continue;
		const rootInfo = await storage.stat(rootResult.value);
		if (!rootInfo.ok || rootInfo.value.kind !== "directory") continue;
		const addIfPlugin = async (candidate: string): Promise<void> => {
			const manifest = await storage.stat(join(candidate, ".runledger-plugin", "plugin.json"));
			if (!manifest.ok || manifest.value.kind !== "file") return;
			const canonical = await storage.realpath(candidate);
			if (!canonical.ok) return;
			roots.push({ source: input.source, sourceKey: sourceKey(input.source, canonical.value), rootPath: canonical.value, priority: input.priority, layout: "plugin-root" });
		};
		await addIfPlugin(rootResult.value);
		const entries = await storage.readDirectory(rootResult.value);
		if (!entries.ok) continue;
		for (const entry of entries.value.filter((value) => value.kind === "directory").sort((left, right) => left.name.localeCompare(right.name))) {
			await addIfPlugin(join(rootResult.value, entry.name));
		}
	}
	return roots;
}

export interface RestoreResidentWorkspaceBindingOptions {
	readonly layout: ReturnType<typeof buildRunledgerLayout>;
	readonly scope: Pick<HostCompatibilityEnvelope, "workspaceId" | "repositoryId" | "workspaceStorageKey">;
	readonly cwd: string;
	readonly workspaceAudit?: WorkspaceBindingAuditPort;
}

/**
 * Replays the persisted worktree binding through the Host-owned services.
 *
 * The binding file is only an identity hint: resume() replays the registry,
 * lease, Git worktree registration, HEAD and effective cwd before any
 * Security, Session, or Process object is composed.  A missing binding is
 * the explicit source-repository case; present state that cannot be
 * revalidated fails closed.
 */
export async function restoreResidentWorkspaceBinding(
	options: RestoreResidentWorkspaceBindingOptions,
): Promise<Awaited<ReturnType<HostWorkspaceBindingService["resume"]>> extends infer Result
	? Result extends { readonly ok: true; readonly value: infer Binding } ? Binding | undefined : never
	: never> {
	const store = new JsonWorkspaceBindingStore({ layout: options.layout, workspaceStorageKey: options.scope.workspaceStorageKey });
	const stored = await store.read();
	if (stored === undefined) return undefined;
	if (stored.binding.workspaceId !== options.scope.workspaceId || stored.binding.repositoryId !== options.scope.repositoryId) {
		throw new Error("workspace binding identity mismatch with Host scope");
	}
	const registry = new WorktreeRegistry(new JsonlWorktreeRegistryStore(options.layout));
	const service = new HostWorkspaceBindingService({
		layout: options.layout,
		workspaceStorageKey: options.scope.workspaceStorageKey,
		managedRoot: join(options.layout.tmp, "worktrees"),
		registry,
		git: createProductionGitCommandPort(),
		ownerRuntimeId: stored.lease.ownerRuntimeId,
		...(options.workspaceAudit === undefined ? {} : { audit: options.workspaceAudit }),
	});
	const resumed = await service.resume({ cwd: options.cwd });
	if (!resumed.ok) throw new Error(`workspace binding ${resumed.error.code}: ${resumed.error.message}`);
	return resumed.value;
}

function parseScope(raw: string): HostCompatibilityEnvelope {
	let value: unknown;
	try {
		value = JSON.parse(raw) as unknown;
	} catch {
		throw new Error("resident Host scope is invalid JSON");
	}
	if (!Value.Check(HostCompatibilityEnvelopeSchema, value)) throw new Error("resident Host scope is invalid");
	return value as HostCompatibilityEnvelope;
}

export function createContextAssemblySink(input: {
	readonly authorityId: RuntimeEventAppendInput["authorityId"];
	readonly tenantId: RuntimeEventAppendInput["tenantId"];
	readonly principalId: RuntimeEventAppendInput["principalId"];
	readonly writer: RuntimeEventWriter;
}): ContextAssemblySink {
	return async (assembly) => {
		const sessionId = parseRuntimeId("session", assembly.sessionId);
		if (!sessionId) throw new Error("context assembly session identity is invalid");
		const receiptDigest = runtimeDigest(assembly.receipt);
		const traceId = createRuntimeId("trace", runtimeDigest({
			sessionId,
			requestId: assembly.receipt.requestId,
			turn: assembly.turn,
			contextDigest: assembly.receipt.contextDigest,
		}).digest.slice(0, 48));
		const payload: RuntimeEventPayloadFor<"context.assembled"> = {
			subject: { kind: "session", id: sessionId },
			correlationId: traceId,
			effect: "committed",
			idempotencyKey: `context:assembled:${assembly.receipt.requestId}`,
			transition: {
				revision: assembly.turn,
				previousStatus: assembly.turn === 1 ? null : `turn-${assembly.turn - 1}`,
				nextStatus: `turn-${assembly.turn}`,
			},
			expectedRevision: Math.max(0, assembly.turn - 1),
			refs: [{ subjectKind: "receipt", digest: receiptDigest, mediaType: "application/vnd.runledger.context-assembly+json", size: 0 }],
			metadataDigest: runtimeDigest({
				model: { provider: assembly.model.provider, id: assembly.model.id, api: assembly.model.api },
				receiptDigest,
				turn: assembly.turn,
			}),
		};
		await input.writer.append({
			authorityId: input.authorityId,
			tenantId: input.tenantId,
			principalId: input.principalId,
			sessionId,
			traceId,
			type: "context.assembled",
			payload,
		});
	};
}

function parseGeneration(raw: string | undefined): number {
	const value = raw === undefined ? 1 : Number(raw);
	if (!Number.isSafeInteger(value) || value < 0) throw new Error("resident Host generation is invalid");
	return value;
}

function buildSystemPrompt(cwd: string, globalAgents: string): string {
	const instructions: string[] = [];
	for (const path of [join(cwd, "AGENTS.md"), globalAgents]) {
		try {
			const content = readFileSync(path, "utf8");
			if (content.length > 0) instructions.push(content);
		} catch {
			// AGENTS.md 不存在或不可读时只保留默认提示。
		}
	}
	return `You are RunLedger's interactive coding agent inside a TUI. Work in ${cwd}. ` +
		"Use governed Read/Write/Edit/Bash/process tools and keep replies concise." +
	(instructions.length > 0 ? `\n\n---\n\n${instructions.join("\n\n---\n\n")}` : "");
}

if (process.argv[1]?.endsWith("runtime-host.js") || process.argv[1]?.endsWith("runtime-host.ts")) {
	runResidentRuntimeHost().catch((error: unknown) => {
		process.stderr.write(`[runledger-host] fatal: ${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	});
}
