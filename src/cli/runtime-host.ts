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
import { HostCompatibilityEnvelopeSchema, type HostCompatibilityEnvelope } from "../runtime/host/contracts.ts";
import { createLocalTraceRecorderFactory } from "../runtime/trace/composition.ts";
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
import { HostWorkspaceBindingService } from "../worktree/host-binding.ts";
import { JsonlWorktreeRegistryStore, WorktreeRegistry } from "../worktree/registry.ts";
import { createProductionGitCommandPort } from "./runtime-host-production.ts";

export async function runResidentRuntimeHost(): Promise<void> {
	if (process.platform !== "linux") throw new Error("resident production Host currently requires Linux local peer attestation");
	const home = process.env.RUNLEDGER_HOST_HOME;
	const rawScope = process.env.RUNLEDGER_HOST_SCOPE;
	const cwd = process.env.RUNLEDGER_HOST_CWD;
	const hostGeneration = parseGeneration(process.env.RUNLEDGER_HOST_GENERATION);
	if (!home || !rawScope || !cwd) throw new Error("resident Host environment is incomplete");
	const scope = parseScope(rawScope);
	const layout = buildRunledgerLayout(home, "posix");
	const endpointStore = new EndpointStore(layout, scope.workspaceStorageKey);
	const lease = await acquireHostWriterLease(layout, scope.workspaceStorageKey);
	if (!lease.ok) throw new Error(lease.code);
	const markerStore = new HostRecoveryMarkerStore(layout, scope.workspaceStorageKey);
	const settings = await loadProjectSettings({ layout });
	const recording = resolveRecordingConfig(settings);
	const traceRecorderFactory = createLocalTraceRecorderFactory({ layout, config: recording });
	const models = builtinModels({ credentials: AuthStorage.create(layout) });
	await models.refresh({ allowNetwork: false });
	const workspaceBindingStore = new JsonWorkspaceBindingStore({ layout, workspaceStorageKey: scope.workspaceStorageKey });
	const workspaceBinding = await restoreResidentWorkspaceBinding({ layout, scope, cwd });
	const runtimeEventWriter = new JsonlRuntimeEventStore({ layout, workspaceStorageKey: scope.workspaceStorageKey });
	let residentHost: ResidentRuntimeHost | undefined;
	const security = await createProductionHostSecurity({
		layout,
		scope,
		cwd,
		...(workspaceBinding === undefined ? {} : { workspaceBinding }),
		runtimeEventWriter,
		permissionPrompter: new HostReversePermissionPrompter(() => residentHost),
	});
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
		security,
	});
	const host = new ResidentRuntimeHost({
		socketPath: productionHostSocketPath(layout, scope.workspaceStorageKey),
		scope,
		hostGeneration,
		processPort,
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
			processPort,
			security,
			workspaceBinding,
			workspaceBindingStore,
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
			release: () => host.close(),
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

export interface RestoreResidentWorkspaceBindingOptions {
	readonly layout: ReturnType<typeof buildRunledgerLayout>;
	readonly scope: Pick<HostCompatibilityEnvelope, "workspaceId" | "repositoryId" | "workspaceStorageKey">;
	readonly cwd: string;
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
