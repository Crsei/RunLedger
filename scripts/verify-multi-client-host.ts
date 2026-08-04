#!/usr/bin/env node

/**
 * R10 standard-path multi-client runner。
 *
 * The runner deliberately starts the same detached resident Host used by the
 * CLI through connect-or-spawn. It does not replace the production session or
 * process composition with a test controller. Non-Linux platforms report an
 * honest unsupported result because this runner requires the channel-bound
 * SO_PEERCRED adapter.
 */

import { mkdtemp, readFile, readdir, readlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRunledgerLayout } from "../src/runtime/contracts/storage-layout.ts";
import { HOST_PROTOCOL_VERSION } from "../src/runtime/host/contracts.ts";
import type { HostFrameEnvelope } from "../src/runtime/host/types.ts";
import { EndpointStore } from "../src/storage/host/endpoint-store.ts";
import {
	createLocalRuntimeHostScope,
	connectProductionRuntimeHost,
	productionHostSocketPath,
	type ProductionRuntimeHostConnection,
} from "../src/cli/runtime-host-production.ts";
import { buildLinuxPeerCredentialHelper } from "./build-linux-peer-credential-helper.ts";

export interface AcceptanceRunnerResult {
	readonly passed: boolean;
	readonly outcome: "pass" | "fail" | "unsupported";
	readonly checks: readonly string[];
	readonly failures?: readonly string[];
}

export interface AcceptanceRunnerOptions {
	readonly platform?: NodeJS.Platform;
}

export async function runMultiClientHostVerification(options: AcceptanceRunnerOptions = {}): Promise<AcceptanceRunnerResult> {
	if ((options.platform ?? process.platform) !== "linux") {
		return { passed: false, outcome: "unsupported", checks: [], failures: ["Linux SO_PEERCRED runner is unsupported on this platform"] };
	}
	const root = await mkdtemp(join(tmpdir(), "runledger-r10-host-"));
	const layout = buildRunledgerLayout(join(root, "home"), "posix");
	const helperPath = join(root, "peer-credential-helper");
	const checks: string[] = [];
	let first: ProductionRuntimeHostConnection | undefined;
	let second: ProductionRuntimeHostConnection | undefined;
	let shutdownRequested = false;
	let sessionIdValue: string | undefined;
	let driverFence: DriverFence | undefined;
	const endpointScope = createLocalRuntimeHostScope({ layout, cwd: root, settings: {} });
	const endpointStore = new EndpointStore(layout, endpointScope.workspaceStorageKey);
	try {
		await buildLinuxPeerCredentialHelper(helperPath);
		first = await connectProductionRuntimeHost({
			layout,
			cwd: root,
			settings: {},
			peerCredentialHelperPath: helperPath,
			wait: { timeoutMs: 15_000, intervalMs: 25 },
		});
		second = await connectProductionRuntimeHost({
			layout,
			cwd: root,
			settings: {},
			peerCredentialHelperPath: helperPath,
			wait: { timeoutMs: 15_000, intervalMs: 25 },
		});
		if (!first.startedHost || second.startedHost || first.endpoint.hostRuntimeId !== second.endpoint.hostRuntimeId) {
			return { passed: false, outcome: "fail", checks, failures: ["standard connect-or-spawn did not reuse one resident Host"] };
		}
		checks.push("production_api_connect_or_spawn", "two_clients_one_host");

		const opened = await command(first, "session-open-first", "session.open", { mode: "create", cwd: root });
		const sessionId = stringValue(opened.body.sessionId);
		if (opened.body.ok !== true || sessionId === undefined) {
			return { passed: false, outcome: "fail", checks, failures: ["first production session open failed"] };
		}
		sessionIdValue = sessionId;
		driverFence = fenceFrom(opened);
		if (driverFence === undefined) return { passed: false, outcome: "fail", checks, failures: ["session open omitted the driver fence"] };
		const initialFence = driverFence;
		const reopened = await command(second, "session-open-second", "session.open", { mode: "open", sessionId, cwd: root });
		if (reopened.body.ok !== true || reopened.body.sessionId !== sessionId) {
			return { passed: false, outcome: "fail", checks, failures: ["second production client did not reuse the session"] };
		}
		checks.push("same_session_owner");

		await command(first, "session-subscribe-first", "session.subscribe", { sessionId });
		await command(second, "session-subscribe-second", "session.subscribe", { sessionId });
		const claimed = await command(first, "session-claim-driver", "session.claim_driver", { sessionId, ...driverFence });
		if (claimed.body.ok !== true) return { passed: false, outcome: "fail", checks, failures: ["production driver claim failed"] };
		driverFence = fenceFrom(claimed);
		if (driverFence === undefined) return { passed: false, outcome: "fail", checks, failures: ["driver claim omitted the updated fence"] };
		const staleMutation = await command(first, "session-stale-fence", "session.set_thinking", { sessionId, level: "off", ...initialFence });
		if (staleMutation.body.code !== "driver_revision_conflict") {
			return { passed: false, outcome: "fail", checks, failures: ["stale driver revision was not rejected"] };
		}
		checks.push("stale_fence_rejected");

		const firstRelease = await command(first, "session-release-first", "session.release_driver", { sessionId, ...driverFence });
		driverFence = fenceWithRevision(driverFence, firstRelease);
		if (firstRelease.body.ok !== true || driverFence === undefined) {
			return { passed: false, outcome: "fail", checks, failures: ["first driver release failed"] };
		}
		const secondClaim = await command(second, "session-claim-second", "session.claim_driver", { sessionId, ...driverFence });
		driverFence = fenceFrom(secondClaim);
		if (secondClaim.body.ok !== true || driverFence === undefined) {
			return { passed: false, outcome: "fail", checks, failures: ["second client driver claim failed"] };
		}
		const secondMutation = await command(second, "session-thinking-second-driver", "session.set_thinking", { sessionId, level: "off", ...driverFence });
		const oldDriverMutation = await command(first, "session-thinking-old-driver", "session.set_thinking", { sessionId, level: "off", ...driverFence });
		if (secondMutation.body.ok !== true || oldDriverMutation.body.code !== "observer_mutation_forbidden") {
			return { passed: false, outcome: "fail", checks, failures: ["transferred driver authority was not enforced"] };
		}
		const secondRelease = await command(second, "session-release-second", "session.release_driver", { sessionId, ...driverFence });
		driverFence = fenceWithRevision(driverFence, secondRelease);
		if (secondRelease.body.ok !== true || driverFence === undefined) {
			return { passed: false, outcome: "fail", checks, failures: ["second driver release failed"] };
		}
		const firstReclaim = await command(first, "session-reclaim-first", "session.claim_driver", { sessionId, ...driverFence });
		driverFence = fenceFrom(firstReclaim);
		if (firstReclaim.body.ok !== true || driverFence === undefined) {
			return { passed: false, outcome: "fail", checks, failures: ["first client driver reclaim failed"] };
		}
		checks.push("explicit_driver_transfer");

		const thinking = await command(first, "session-thinking", "session.set_thinking", { sessionId, level: "off", ...driverFence }, "session-thinking-command");
		const thinkingRetry = await command(first, "session-thinking-retry", "session.set_thinking", { sessionId, level: "off", ...driverFence }, "session-thinking-command");
		const observerMutation = await command(second, "session-observer-thinking", "session.set_thinking", { sessionId, level: "off", ...driverFence });
		if (thinking.body.ok !== true || thinkingRetry.body.ok !== true || observerMutation.body.code !== "observer_mutation_forbidden") {
			return { passed: false, outcome: "fail", checks, failures: ["production driver/idempotency fence failed"] };
		}
		checks.push("driver_fence", "command_idempotency");

		const created = await command(first, "process-create", "process.create", {
			sessionId,
			command: "printf 'standard-path-process\\n'",
			cwd: root,
			backend: "pipe",
			executionMode: "background",
			timeoutMs: 5_000,
			containment: "none",
			...driverFence,
		});
		const handle = isRecord(created.body.handle) ? created.body.handle : undefined;
		const executionId = handle === undefined ? undefined : stringValue(handle.executionId);
		if (created.body.ok !== true || executionId === undefined || /(?:pid|outputPath|command|cwd)/iu.test(JSON.stringify(created.body))) {
				return {
					passed: false,
					outcome: "fail",
					checks,
				failures: [`production process facade did not return a safe handle (ok=${String(created.body.ok)}, code=${String(created.body.code)}, keys=${Object.keys(created.body).join(",")})`],
			};
		}
		const waited = await command(second, "process-wait", "process.wait", { sessionId, executionId, timeoutMs: 5_000 });
		const output = await command(second, "process-output", "process.output", {
			sessionId,
			executionId,
			cursor: { sequence: 0, byteOffset: 0 },
			maxBytes: 1024,
		});
		if (waited.body.ok !== true || waited.body.outcome !== "terminal" || output.body.ok !== true || output.body.page !== "standard-path-process\n") {
			return { passed: false, outcome: "fail", checks, failures: ["production process output/recovery facade failed"] };
		}
		checks.push("production_process_facade");

		const observerShutdown = await command(second, "host-shutdown-observer", "host.shutdown", { sessionId, ...driverFence });
		if (observerShutdown.body.code !== "observer_mutation_forbidden") {
			return { passed: false, outcome: "fail", checks, failures: ["observer Host shutdown was not fenced"] };
		}
		const shutdown = await command(first, "host-shutdown", "host.shutdown", { sessionId, ...driverFence });
		if (shutdown.body.ok !== true || shutdown.body.accepted !== true) {
			return { passed: false, outcome: "fail", checks, failures: ["explicit Host shutdown was not accepted"] };
		}
		shutdownRequested = true;
		checks.push("driver_only_explicit_host_shutdown");
		await Promise.all([first.close(), second.close()]);
		first = undefined;
		second = undefined;
		await waitForEndpointGone(endpointStore);
		await verifyHostCrashRecovery({ root, layout, helperPath, checks });
		return { passed: true, outcome: "pass", checks };
	} catch (error) {
		return { passed: false, outcome: "fail", checks, failures: [error instanceof Error ? error.message : String(error)] };
	} finally {
		if (!shutdownRequested && first !== undefined && sessionIdValue !== undefined && driverFence !== undefined) {
			await command(first, "host-shutdown-fallback", "host.shutdown", { sessionId: sessionIdValue, ...driverFence }).catch(() => undefined);
		}
		await first?.close().catch(() => undefined);
		await second?.close().catch(() => undefined);
		await waitForEndpointGone(endpointStore).catch(() => undefined);
		await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
	}
}

async function verifyHostCrashRecovery(input: {
	readonly root: string;
	readonly layout: ReturnType<typeof buildRunledgerLayout>;
	readonly helperPath: string;
	readonly checks: string[];
}): Promise<void> {
	let driver: ProductionRuntimeHostConnection | undefined;
	let recovered: ProductionRuntimeHostConnection | undefined;
	let sessionId: string | undefined;
	let fence: DriverFence | undefined;
	try {
		driver = await connectProductionRuntimeHost({
			layout: input.layout,
			cwd: input.root,
			settings: {},
			peerCredentialHelperPath: input.helperPath,
			wait: { timeoutMs: 15_000, intervalMs: 25 },
		});
		const opened = await command(driver, "crash-session-open", "session.open", { mode: "create", cwd: input.root });
		sessionId = stringValue(opened.body.sessionId);
		fence = fenceFrom(opened);
		if (opened.body.ok !== true || sessionId === undefined || fence === undefined) throw new Error("crash recovery session open failed");
		const claimed = await command(driver, "crash-session-claim", "session.claim_driver", { sessionId, ...fence });
		fence = fenceFrom(claimed);
		if (claimed.body.ok !== true || fence === undefined) throw new Error("crash recovery driver claim failed");

		const markerPath = join(input.root, "spawn-count.txt");
		const javascript = `require('node:fs').appendFileSync(${JSON.stringify(markerPath)},'spawn\\n');process.stdout.write('crash-started\\n');setTimeout(()=>process.exit(0),20000)`;
		const created = await command(driver, "crash-process-create", "process.create", {
			sessionId,
			command: `${shellQuote(process.execPath)} -e ${shellQuote(javascript)}`,
			cwd: input.root,
			backend: "pipe",
			executionMode: "background",
			timeoutMs: 30_000,
			containment: "none",
			...fence,
		});
		const handle = isRecord(created.body.handle) ? created.body.handle : undefined;
		const executionId = handle === undefined ? undefined : stringValue(handle.executionId);
		if (created.body.ok !== true || executionId === undefined || /(?:pid|outputPath|command|cwd)/iu.test(JSON.stringify(created.body))) {
			throw new Error("crash recovery process create failed");
		}
		await waitForMarker(markerPath);
		const socketPath = productionHostSocketPath(input.layout, createLocalRuntimeHostScope({ layout: input.layout, cwd: input.root, settings: {} }).workspaceStorageKey);
		const hostPid = await unixSocketOwnerPid(socketPath);
		process.kill(hostPid, "SIGKILL");
		await driver.close().catch(() => undefined);
		driver = undefined;
		await waitForPidExit(hostPid);

		recovered = await reconnectAfterCrash(input.layout, input.root, input.helperPath);
		if (!recovered.startedHost) throw new Error("crash recovery did not start a replacement Host");
		const reopened = await command(recovered, "crash-session-reopen", "session.open", { mode: "open", sessionId, cwd: input.root });
		fence = fenceFrom(reopened);
		if (reopened.body.ok !== true || fence === undefined) throw new Error("crash recovery session reopen failed");
		const listed = await command(recovered, "crash-process-list", "process.list", { sessionId });
		const processes = Array.isArray(listed.body.processes) ? listed.body.processes.filter(isRecord) : [];
		const projection = processes.find((entry) => entry.executionId === executionId);
		if (listed.body.ok !== true || projection === undefined || (projection.state !== "lost" && projection.state !== "uncertain")) {
			throw new Error("crash recovery did not expose lost or uncertain projection");
		}
		if (/(?:pid|outputPath|command|cwd)/iu.test(JSON.stringify(listed.body))) throw new Error("crash recovery list leaked private process data");
		const output = await command(recovered, "crash-process-output", "process.output", {
			sessionId,
			executionId,
			cursor: { sequence: 0, byteOffset: 0 },
			maxBytes: 1024,
		});
		if (output.body.ok !== true || !stringValue(output.body.page)?.includes("crash-started")) throw new Error("crash recovery output cursor was unavailable");
		const spawnCount = (await readFile(markerPath, "utf8")).split(/\r?\n/u).filter((line) => line === "spawn").length;
		if (spawnCount !== 1) throw new Error("crash recovery duplicated process spawn");
		input.checks.push("host_sigkill_no_duplicate_spawn", "lost_or_uncertain_projection");

		const reclaimed = await command(recovered, "crash-session-reclaim", "session.claim_driver", { sessionId, ...fence });
		fence = fenceFrom(reclaimed);
		if (reclaimed.body.ok !== true || fence === undefined) throw new Error("crash recovery driver reclaim failed");
		const shutdown = await command(recovered, "crash-host-shutdown", "host.shutdown", { sessionId, ...fence });
		if (shutdown.body.ok !== true || shutdown.body.accepted !== true) throw new Error("crash recovery replacement Host shutdown failed");
		await recovered.close();
		recovered = undefined;
	} finally {
		if (recovered !== undefined && sessionId !== undefined && fence !== undefined) {
			await command(recovered, "crash-host-shutdown-fallback", "host.shutdown", { sessionId, ...fence }).catch(() => undefined);
		}
		await Promise.all([driver?.close().catch(() => undefined), recovered?.close().catch(() => undefined)]);
	}
}

async function reconnectAfterCrash(
	layout: ReturnType<typeof buildRunledgerLayout>,
	cwd: string,
	helperPath: string,
): Promise<ProductionRuntimeHostConnection> {
	const deadline = Date.now() + 20_000;
	let lastError: unknown;
	while (Date.now() < deadline) {
		try {
			return await connectProductionRuntimeHost({ layout, cwd, settings: {}, peerCredentialHelperPath: helperPath, wait: { timeoutMs: 2_000, intervalMs: 25 } });
		} catch (error) {
			lastError = error;
			await new Promise((resolve) => setTimeout(resolve, 250));
		}
	}
	throw lastError instanceof Error ? lastError : new Error("crash recovery reconnect timed out");
}

async function unixSocketOwnerPid(socketPath: string): Promise<number> {
	const table = await readFile("/proc/net/unix", "utf8");
	const row = table.split(/\r?\n/u).map((line) => line.trim().split(/\s+/u)).find((fields) => fields.at(-1) === socketPath);
	const inode = row?.[6];
	if (!inode || !/^\d+$/u.test(inode)) throw new Error("Host socket inode was not found");
	const processes = (await readdir("/proc")).filter((entry) => /^\d+$/u.test(entry)).sort((left, right) => Number(left) - Number(right));
	for (const entry of processes) {
		const pid = Number(entry);
		if (pid === process.pid) continue;
		const descriptors = await readdir(`/proc/${entry}/fd`).catch(() => []);
		for (const descriptor of descriptors) {
			const target = await readlink(`/proc/${entry}/fd/${descriptor}`).catch(() => "");
			if (target === `socket:[${inode}]`) return pid;
		}
	}
	throw new Error("Host socket owner was not found");
}

async function waitForMarker(markerPath: string): Promise<void> {
	for (let attempt = 0; attempt < 200; attempt += 1) {
		if ((await readFile(markerPath, "utf8").catch(() => "")).includes("spawn")) return;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	throw new Error("crash process did not publish its spawn marker");
}

async function waitForPidExit(pid: number): Promise<void> {
	for (let attempt = 0; attempt < 200; attempt += 1) {
		try {
			process.kill(pid, 0);
		} catch {
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	throw new Error("resident Host did not exit after SIGKILL");
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

interface DriverFence {
	readonly expectedHostGeneration: number;
	readonly expectedSessionGeneration: number;
	readonly expectedDriverRevision: number;
}

function fenceFrom(frame: HostFrameEnvelope): DriverFence | undefined {
	const expectedHostGeneration = integerValue(frame.body.hostGeneration);
	const expectedSessionGeneration = integerValue(frame.body.sessionGeneration);
	const expectedDriverRevision = integerValue(frame.body.driverRevision);
	return expectedHostGeneration === undefined || expectedSessionGeneration === undefined || expectedDriverRevision === undefined
		? undefined
		: { expectedHostGeneration, expectedSessionGeneration, expectedDriverRevision };
}

function fenceWithRevision(fence: DriverFence, frame: HostFrameEnvelope): DriverFence | undefined {
	const expectedDriverRevision = integerValue(frame.body.driverRevision);
	return expectedDriverRevision === undefined ? undefined : { ...fence, expectedDriverRevision };
}

async function command(
	connection: ProductionRuntimeHostConnection,
	frameId: string,
	operation: string,
	body: Record<string, unknown>,
	commandId = frameId,
): Promise<HostFrameEnvelope> {
	return connection.request({
		frameId,
		kind: "command_request",
		protocolVersion: HOST_PROTOCOL_VERSION,
		body: { operation, commandId, ...body },
	});
}

async function waitForEndpointGone(store: EndpointStore): Promise<void> {
	for (let attempt = 0; attempt < 200; attempt += 1) {
		if ((await store.read().catch(() => undefined)) === undefined) return;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	throw new Error("resident Host endpoint did not clear after shutdown");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function integerValue(value: unknown): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

if (process.argv[1]?.endsWith("verify-multi-client-host.ts")) {
	runMultiClientHostVerification().then((result) => {
		console.log(JSON.stringify(result));
		if (!result.passed) process.exitCode = 1;
	}).catch((error: unknown) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	});
}
