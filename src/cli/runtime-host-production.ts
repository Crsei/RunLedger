/** Shared production Runtime Host scope and canonical IPC path composition. */

import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import {
	buildRunledgerLayout,
	hostSocketRelativeLocator,
	workspaceStorageKey as createWorkspaceStorageKey,
	type RunledgerLayout,
} from "../runtime/contracts/storage-layout.ts";
import {
	createHostCompatibilityEnvelope,
	HOST_PROTOCOL_VERSION,
	HOST_SESSION_STORAGE_CONTRACT_VERSION,
	type HostCompatibilityEnvelope,
	type RuntimeHostScope,
} from "../runtime/host/contracts.ts";
import { runtimeDigest } from "../runtime/protocol/foundation.ts";
import { createRuntimeId } from "../runtime/protocol/ids.ts";
import type { HostFrameEnvelope } from "../runtime/host/types.ts";
import type { ProjectSettings } from "../storage/settings-manager.ts";
import { EndpointStore, type HostEndpointRecord } from "../storage/host/endpoint-store.ts";
import { hostStartupElectionRelativeLocator } from "../runtime/contracts/storage-layout.ts";
import { acquireStartupElection } from "../storage/host/startup-election.ts";
import { isHostWriterLeaseActive } from "../storage/host/writer-lease.ts";
import {
	connectOrSpawnHost,
	type HostConnectionResult,
	type HostSpawnResult,
	type RuntimeHostLaunchResult,
} from "./runtime-host-composition.ts";
import {
	JsonLineHostClient,
	type HostTransportFrameContext,
	type HostTransportAttestor,
} from "./runtime-host-transport.ts";
import { defaultLinuxPeerCredentialHelperPath, LinuxSocketPeerAttestor } from "./linux-peer-attestor.ts";

export interface LocalRuntimeHostScopeOptions {
	readonly layout: RunledgerLayout;
	readonly cwd: string;
	readonly settings: ProjectSettings;
}

export function createLocalRuntimeHostScope(options: LocalRuntimeHostScopeOptions): HostCompatibilityEnvelope {
	const identityDigest = runtimeDigest({ home: options.layout.home, cwd: options.cwd });
	const authorityId = createRuntimeId("authority", runtimeDigest({ home: options.layout.home }).digest.slice(0, 32));
	const tenantId = createRuntimeId("tenant", "local");
	const workspaceId = createRuntimeId("workspace", identityDigest.digest.slice(0, 32));
	const repositoryId = createRuntimeId("repository", runtimeDigest({ cwd: options.cwd }).digest.slice(0, 32));
	const workspaceKey = createWorkspaceStorageKey({ authorityId, tenantId, workspaceId, repositoryId });
	const tracePolicyDigest = runtimeDigest({ recording: options.settings.recording ?? { mode: "off", failurePolicy: "best_effort" } });
	const scope: RuntimeHostScope = {
		authorityId,
		tenantId,
		workspaceId,
		repositoryId,
		workspaceStorageKey: workspaceKey,
		protocolVersion: HOST_PROTOCOL_VERSION,
		hostBuildDigest: runtimeDigest({ product: "runledger", hostProtocol: HOST_PROTOCOL_VERSION }),
		compositionDigest: runtimeDigest({ kind: "production", processBackend: "governed" }),
		settingsDigest: runtimeDigest(options.settings),
		modelCatalogDigest: runtimeDigest({ catalog: "builtin" }),
		tracePolicyDigest,
		securityAdapterDigest: runtimeDigest({ permission: "none", approval: "none", sandbox: "none", gateway: "none", containment: "none" }),
		extensionProfileDigest: runtimeDigest({ extensions: "none" }),
		sessionStorageContractVersion: HOST_SESSION_STORAGE_CONTRACT_VERSION,
		peerAttestor: {
			kind: process.platform === "linux" ? "linux-so-peercred" : "windows-named-pipe",
			generation: 1,
			configDigest: runtimeDigest({ platform: process.platform, uid: typeof process.getuid === "function" ? process.getuid() : undefined }),
		},
	};
	return createHostCompatibilityEnvelope(scope);
}

export function productionHostSocketPath(layout: RunledgerLayout, workspaceStorageKey: string): string {
	const canonicalPath = join(layout.home, hostSocketRelativeLocator(workspaceStorageKey));
	// Linux/macOS Unix sockets have a roughly 108-byte sockaddr path bound. A
	// long user home plus the current-format workspace key can exceed it before
	// Node has a chance to report a useful bind error. Keep the locator stable
	// for the same home/scope while using a short per-user temporary namespace.
	if (process.platform === "win32" || Buffer.byteLength(canonicalPath, "utf8") <= 100) return canonicalPath;
	const shortName = `runledger-host-${runtimeDigest({ home: layout.home, workspaceStorageKey }).digest}.sock`;
	return join(tmpdir(), shortName);
}

export function productionHostLayout(home: string): RunledgerLayout {
	return buildRunledgerLayout(home, process.platform === "win32" ? "win32" : "posix");
}

export interface ProductionHostSpawnSpec {
	readonly command: string;
	readonly args: readonly string[];
	readonly env: NodeJS.ProcessEnv;
	readonly detached: true;
	readonly stdio: ["ignore", "ignore", "ignore"];
}

export interface ProductionHostSpawnSpecOptions {
	readonly layout: RunledgerLayout;
	readonly scope: HostCompatibilityEnvelope;
	readonly entryPath?: string;
	readonly hostGeneration?: number;
	readonly cwd?: string;
	readonly peerCredentialHelperPath?: string;
}

export function productionHostSpawnSpec(options: ProductionHostSpawnSpecOptions): ProductionHostSpawnSpec {
	const entryPath = options.entryPath ?? defaultHostEntryPath();
	const sourceTypeScript = entryPath.endsWith(".ts");
	const args = sourceTypeScript
		? ["--import", "tsx", entryPath]
		: [entryPath];
	return {
		command: process.execPath,
		args,
		env: {
			...process.env,
			RUNLEDGER_HOST_HOME: options.layout.home,
			RUNLEDGER_HOST_SCOPE: JSON.stringify(options.scope),
			RUNLEDGER_HOST_GENERATION: String(options.hostGeneration ?? 1),
			...(options.peerCredentialHelperPath === undefined ? {} : { RUNLEDGER_HOST_PEER_CREDENTIAL_HELPER: options.peerCredentialHelperPath }),
			...(options.cwd === undefined ? {} : { RUNLEDGER_HOST_CWD: options.cwd }),
		},
		detached: true,
		stdio: ["ignore", "ignore", "ignore"],
	};
}

export interface ProductionRuntimeHostConnection {
	readonly endpoint: HostEndpointRecord;
	readonly startedHost: boolean;
	readonly request: (frame: import("../runtime/host/types.ts").HostFrameEnvelope) => Promise<import("../runtime/host/types.ts").HostFrameEnvelope>;
	readonly onEvent: (listener: (frame: import("../runtime/host/types.ts").HostFrameEnvelope) => void) => () => void;
	readonly notify: (frame: import("../runtime/host/types.ts").HostFrameEnvelope) => void;
	close(): Promise<void>;
}

export interface ConnectProductionRuntimeHostOptions {
	readonly layout: RunledgerLayout;
	readonly cwd: string;
	readonly settings: ProjectSettings;
	readonly entryPath?: string;
	readonly wait?: { readonly timeoutMs?: number; readonly intervalMs?: number };
	readonly peerCredentialHelperPath?: string;
}

/** 标准 CLI 唯一使用的 authenticated connect-or-spawn composition。 */
export async function connectProductionRuntimeHost(
	options: ConnectProductionRuntimeHostOptions,
): Promise<ProductionRuntimeHostConnection> {
	if (process.platform !== "linux") throw new Error("production local Host transport is unavailable on this platform");
	const scope = createLocalRuntimeHostScope({ layout: options.layout, cwd: options.cwd, settings: options.settings });
	const endpointStore = new EndpointStore(options.layout, scope.workspaceStorageKey);
	const socketPath = productionHostSocketPath(options.layout, scope.workspaceStorageKey);
	const helperPath = options.peerCredentialHelperPath ?? defaultLinuxPeerCredentialHelperPath();
	if (!existsSync(helperPath)) throw new Error("peer_attestation_required");
	const launcherOptions = {
		endpoint: {
			read: () => endpointStore.read(),
			remove: () => endpointStore.remove(),
		},
		writer: {
			state: async (): Promise<"active" | "absent" | "unknown"> => {
				try {
					return await isHostWriterLeaseActive(options.layout, scope.workspaceStorageKey) ? "active" : "absent";
				} catch {
					return "unknown";
				}
			},
		},
		election: {
			acquire: () => acquireStartupElection(join(options.layout.home, hostStartupElectionRelativeLocator(scope.workspaceStorageKey))),
		},
		connector: {
			connect: (endpoint: HostEndpointRecord) => connectProductionEndpoint(socketPath, scope, endpoint),
		},
		spawner: {
			spawn: (input: { readonly hostGeneration: number }) => spawnProductionHost({
				...options,
				layout: options.layout,
				scope,
				socketPath,
				endpointStore,
					helperPath,
				hostGeneration: input.hostGeneration,
			}),
		},
		expectedCompatibilityDigest: scope.compatibilityDigest,
		wait: options.wait,
	};
	const result: RuntimeHostLaunchResult = await connectOrSpawnHost(launcherOptions);
	if (!result.ok) throw new Error(result.code);
	if (!result.connection.request || !result.connection.onEvent) {
		await result.close();
		throw new Error("production Host connection does not expose a typed transport");
	}
	return {
		endpoint: result.endpoint,
		startedHost: result.startedHost,
		request: result.connection.request,
		onEvent: result.connection.onEvent,
		notify: (frame) => result.connection.notify?.(frame),
		close: result.close,
	};
}

async function connectProductionEndpoint(
	socketPath: string,
	scope: HostCompatibilityEnvelope,
	endpoint: HostEndpointRecord,
): Promise<HostConnectionResult> {
	let client: JsonLineHostClient | undefined;
	try {
		client = await JsonLineHostClient.connect(socketPath);
		const initialized = await client.request({
			frameId: `initialize_${endpoint.hostGeneration}_${Date.now()}`,
			kind: "initialize_request",
			protocolVersion: HOST_PROTOCOL_VERSION,
			body: { compatibility: scope },
		});
		if (initialized.body.accepted !== true) {
			await client.close().catch(() => undefined);
			const code = initialized.body.code === "host_configuration_conflict"
				? "host_configuration_conflict" as const
				: "peer_attestation_required" as const;
			return { ok: false, code, retryable: false };
		}
		return {
			ok: true,
			connection: {
				kind: "jsonl",
				id: endpoint.hostRuntimeId,
				close: () => client!.close(),
					request: (frame) => client!.request(frame),
					onEvent: (listener) => client!.onEvent(listener),
					notify: (frame: HostFrameEnvelope) => client!.notify(frame),
			},
		};
	} catch {
		await client?.close().catch(() => undefined);
		return { ok: false, code: "unreachable", retryable: true };
	}
}

async function spawnProductionHost(options: ConnectProductionRuntimeHostOptions & {
	readonly scope: HostCompatibilityEnvelope;
	readonly socketPath: string;
	readonly endpointStore: EndpointStore;
	readonly helperPath: string;
	readonly hostGeneration: number;
}): Promise<HostSpawnResult> {
	const spec = productionHostSpawnSpec({
		layout: options.layout,
		scope: options.scope,
		entryPath: options.entryPath,
		hostGeneration: options.hostGeneration,
		cwd: options.cwd,
		peerCredentialHelperPath: options.peerCredentialHelperPath,
	});
	const child = spawn(spec.command, [...spec.args], {
		env: spec.env,
		detached: spec.detached,
		stdio: spec.stdio,
		windowsHide: true,
	});
	child.unref();
	const deadline = Date.now() + (options.wait?.timeoutMs ?? 10_000);
	const interval = options.wait?.intervalMs ?? 25;
	while (Date.now() < deadline) {
		const endpoint = await options.endpointStore.read().catch(() => undefined);
		if (endpoint?.hostGeneration === options.hostGeneration && endpoint.state === "ready") {
			const connected = await connectProductionEndpoint(options.socketPath, options.scope, endpoint);
			if (connected.ok) {
				return {
					ok: true,
					endpoint,
					connection: connected.connection,
					close: connected.connection.close ?? (async () => {}),
				};
			}
		}
		if (child.exitCode !== null) break;
		await new Promise<void>((resolve) => setTimeout(resolve, interval));
	}
	return { ok: false, code: "host_startup_timeout" };
}

function defaultHostEntryPath(): string {
	const compiled = fileURLToPath(new URL("./runtime-host.js", import.meta.url));
	if (existsSync(compiled)) return compiled;
	return fileURLToPath(new URL("./runtime-host.ts", import.meta.url));
}
