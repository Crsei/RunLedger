/** Local Host management commands; these never open an interactive session. */

import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { resolveRunledgerHome } from "../storage/runledger-home.ts";
import { loadProjectSettings } from "../storage/settings-manager.ts";
import { EndpointStore, type HostEndpointRecord } from "../storage/host/endpoint-store.ts";
import { isHostWriterLeaseActive } from "../storage/host/writer-lease.ts";
import { discoverLinuxUnixSocketOwnerPid, verifyLinuxProcessIdentity } from "../storage/host/linux-process-identity.ts";
import { runtimeWorkspacePlatform } from "../workspace/runtime-platform.ts";
import type { HostFrameEnvelope } from "../runtime/host/types.ts";
import { loadVerifiedHostBuildManifest, productionDistributionRoot } from "./host-build-identity.ts";
import {
	connectProductionHostManagement,
	connectProductionRuntimeHost,
	productionHostSocketPath,
	resolveLocalRuntimeHostScope,
} from "./runtime-host-production.ts";

export type HostCommandAction = "list" | "status" | "stop" | "restart";

export interface ParsedHostCommand {
	readonly action: HostCommandAction;
	readonly workspaceKey?: string;
	readonly json: boolean;
	readonly confirmActive: boolean;
	readonly force: boolean;
}

export type HostCommandParseResult =
	| { readonly ok: true; readonly command: ParsedHostCommand }
	| { readonly ok: false; readonly error: string };

const WORKSPACE_KEY = /^ws-[a-f0-9]{64}$/u;

export function parseHostCommand(argv: readonly string[]): HostCommandParseResult {
	const action = argv[0];
	if (action !== "list" && action !== "status" && action !== "stop" && action !== "restart") {
		return { ok: false, error: `unsupported host action: ${action ?? "missing"}` };
	}
	let workspaceKey: string | undefined;
	let json = false;
	let confirmActive = false;
	let force = false;
	for (let index = 1; index < argv.length; index += 1) {
		const argument = argv[index];
		if (argument === "--json") { json = true; continue; }
		if (argument === "--confirm-active") { confirmActive = true; continue; }
		if (argument === "--force") { force = true; continue; }
		if (argument === "--workspace-key") {
			workspaceKey = argv[++index];
			if (workspaceKey === undefined || !WORKSPACE_KEY.test(workspaceKey)) return { ok: false, error: "invalid workspace key" };
			continue;
		}
		return { ok: false, error: `unsupported host option: ${argument}` };
	}
	if (action === "list" && workspaceKey !== undefined) return { ok: false, error: "host list does not accept a workspace key" };
	return { ok: true, command: { action, ...(workspaceKey === undefined ? {} : { workspaceKey }), json, confirmActive, force } };
}

export async function runHostCommand(argv: readonly string[]): Promise<void> {
	const parsed = parseHostCommand(argv);
	if (!parsed.ok) {
		process.stderr.write(`[runledger] ${parsed.error}\n`);
		process.exitCode = 2;
		return;
	}
	const { layout } = await resolveRunledgerHome();
	if (parsed.command.action === "list") {
		writeOutput(await listHosts(layout), parsed.command.json);
		return;
	}
	const settings = await loadProjectSettings({ layout });
	const manifest = await loadVerifiedHostBuildManifest(productionDistributionRoot());
	const resolved = await resolveLocalRuntimeHostScope({
		layout,
		cwd: process.cwd(),
		settings,
		hostBuildDigest: manifest.contentDigest,
	});
	const workspaceKey = parsed.command.workspaceKey ?? resolved.scope.workspaceStorageKey;
	const endpointStore = new EndpointStore(layout, workspaceKey);
	const endpoint = await endpointStore.read();
	if (!endpoint) {
		writeOutput({ ok: false, code: "host_not_found", workspaceStorageKey: workspaceKey }, parsed.command.json);
		process.exitCode = 3;
		return;
	}
	let management;
	try {
		management = await connectProductionHostManagement({ layout, endpoint });
	} catch {
		if (parsed.command.force && (parsed.command.action === "stop" || parsed.command.action === "restart")) {
			if (parsed.command.action === "restart" && workspaceKey !== resolved.scope.workspaceStorageKey) {
				writeOutput({ ok: false, code: "restart_requires_workspace_cwd", workspaceStorageKey: workspaceKey }, parsed.command.json);
				process.exitCode = 4;
				return;
			}
			const forced = await forceStopValidatedLinuxHost({ endpoint, socketPath: productionHostSocketPath(layout, workspaceKey) });
			if (!forced.ok) {
				writeOutput({ ...forced, workspaceStorageKey: workspaceKey }, parsed.command.json);
				process.exitCode = 6;
				return;
			}
			await waitForHostRelease(layout, workspaceKey);
			if (parsed.command.action === "stop") {
				writeOutput({ ok: true, stopped: true, forced: true, workspaceStorageKey: workspaceKey }, parsed.command.json);
				return;
			}
			const replacement = await connectProductionRuntimeHost({ layout, cwd: process.cwd(), settings, hostBuildDigest: manifest.contentDigest });
			await replacement.close();
			writeOutput({ ok: true, restarted: true, forced: true, workspaceStorageKey: workspaceKey, endpoint: replacement.endpoint }, parsed.command.json);
			return;
		}
		writeOutput({
			ok: false,
			code: "host_unreachable",
			workspaceStorageKey: workspaceKey,
			endpoint,
			writerLease: await isHostWriterLeaseActive(layout, workspaceKey) ? "active" : "absent",
		}, parsed.command.json);
		process.exitCode = 5;
		return;
	}
	try {
		const inspected = await management.request(frame("query_request", "host.inspect", {}));
		if (parsed.command.action === "status") {
			writeOutput({ ok: true, endpoint, writerLease: await isHostWriterLeaseActive(layout, workspaceKey) ? "active" : "absent", host: inspected.body }, parsed.command.json);
			return;
		}
		if (parsed.command.action === "restart" && workspaceKey !== resolved.scope.workspaceStorageKey) {
			writeOutput({ ok: false, code: "restart_requires_workspace_cwd", workspaceStorageKey: workspaceKey }, parsed.command.json);
			process.exitCode = 4;
			return;
		}
		const reason = parsed.command.action === "restart" ? "maintenance_restart" : "manual_stop";
		const stopped = await management.request(frame("command_request", "host.shutdown", {
			commandId: `host-shutdown-${randomUUID()}`,
			expectedHostRuntimeId: endpoint.hostRuntimeId,
			expectedHostGeneration: endpoint.hostGeneration,
			reason,
			confirmActive: parsed.command.confirmActive,
			...(reason === "maintenance_restart" ? { targetBuildDigest: manifest.contentDigest } : {}),
		}));
		if (stopped.body.ok !== true) {
			writeOutput(stopped.body, parsed.command.json);
			process.exitCode = stopped.body.code === "host_busy" ? 4 : 5;
			return;
		}
		await management.close();
		management = undefined;
		await waitForHostRelease(layout, workspaceKey);
		if (parsed.command.action === "stop") {
			writeOutput({ ok: true, stopped: true, workspaceStorageKey: workspaceKey }, parsed.command.json);
			return;
		}
		const replacement = await connectProductionRuntimeHost({
			layout,
			cwd: process.cwd(),
			settings,
			hostBuildDigest: manifest.contentDigest,
		});
		await replacement.close();
		writeOutput({ ok: true, restarted: true, workspaceStorageKey: workspaceKey, endpoint: replacement.endpoint }, parsed.command.json);
	} finally {
		await management?.close().catch(() => undefined);
	}
}

export type ForceStopHostResult =
	| { readonly ok: true; readonly signal: "SIGTERM"; readonly pid: number }
	| { readonly ok: false; readonly code: "host_socket_owner_mismatch" | "host_process_identity_mismatch" | "host_process_signal_failed" | "force_stop_unsupported" };

/** Last-resort stop: validate the exact endpoint process twice, then send SIGTERM once. */
export async function forceStopValidatedLinuxHost(options: {
	readonly endpoint: HostEndpointRecord;
	readonly socketPath: string;
}): Promise<ForceStopHostResult> {
	if (runtimeWorkspacePlatform() !== "linux") return { ok: false, code: "force_stop_unsupported" };
	const pid = options.endpoint.hostProcessId;
	const firstOwner = await discoverLinuxUnixSocketOwnerPid(options.socketPath).catch(() => undefined);
	if (firstOwner !== pid) return { ok: false, code: "host_socket_owner_mismatch" };
	if (!await verifyLinuxProcessIdentity(pid, options.endpoint.hostProcessStartIdentityDigest)) {
		return { ok: false, code: "host_process_identity_mismatch" };
	}
	const finalOwner = await discoverLinuxUnixSocketOwnerPid(options.socketPath).catch(() => undefined);
	if (finalOwner !== pid || !await verifyLinuxProcessIdentity(pid, options.endpoint.hostProcessStartIdentityDigest)) {
		return { ok: false, code: "host_process_identity_mismatch" };
	}
	try {
		process.kill(pid, "SIGTERM");
		return { ok: true, signal: "SIGTERM", pid };
	} catch {
		return { ok: false, code: "host_process_signal_failed" };
	}
}

async function listHosts(layout: Awaited<ReturnType<typeof resolveRunledgerHome>>["layout"]): Promise<Record<string, unknown>> {
	const root = join(layout.ipc, "hosts");
	let entries;
	try { entries = await readdir(root, { withFileTypes: true }); } catch { return { ok: true, hosts: [] }; }
	const hosts: Array<Record<string, unknown>> = [];
	for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
		if (!entry.isDirectory() || !WORKSPACE_KEY.test(entry.name)) continue;
		try {
			const endpoint = await new EndpointStore(layout, entry.name).read();
			if (endpoint) hosts.push({ endpoint, writerLease: await isHostWriterLeaseActive(layout, entry.name) ? "active" : "absent" });
		} catch {
			hosts.push({ workspaceStorageKey: entry.name, state: "invalid_endpoint" });
		}
	}
	return { ok: true, hosts };
}

function frame(kind: "query_request" | "command_request", operation: string, body: Record<string, unknown>): HostFrameEnvelope {
	return { frameId: `host-${randomUUID()}`, kind, protocolVersion: 1, body: { operation, ...body } };
}

async function waitForHostRelease(
	layout: Awaited<ReturnType<typeof resolveRunledgerHome>>["layout"],
	workspaceKey: string,
): Promise<void> {
	const endpointStore = new EndpointStore(layout, workspaceKey);
	const deadline = Date.now() + 65_000;
	while (Date.now() < deadline) {
		const endpoint = await endpointStore.read().catch(() => undefined);
		const active = await isHostWriterLeaseActive(layout, workspaceKey);
		if (!endpoint && !active) return;
		await new Promise<void>((resolve) => setTimeout(resolve, 50));
	}
	throw new Error("host_shutdown_timeout");
}

function writeOutput(value: unknown, json: boolean): void {
	if (json) {
		process.stdout.write(`${JSON.stringify(value)}\n`);
		return;
	}
	process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}
