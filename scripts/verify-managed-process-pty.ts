#!/usr/bin/env node

/** R10 standard-path local managed PTY runner (node-pty-backed on POSIX). */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRunledgerLayout } from "../src/runtime/contracts/storage-layout.ts";
import { HOST_PROTOCOL_VERSION } from "../src/runtime/host/contracts.ts";
import type { HostFrameEnvelope } from "../src/runtime/host/types.ts";
import { EndpointStore } from "../src/storage/host/endpoint-store.ts";
import {
	connectProductionRuntimeHost,
	createLocalRuntimeHostScope,
	type ProductionRuntimeHostConnection,
} from "../src/cli/runtime-host-production.ts";
import { buildLinuxPeerCredentialHelper } from "./build-linux-peer-credential-helper.ts";

export interface ManagedProcessPtyRunnerResult {
	readonly passed: boolean;
	readonly checks: readonly string[];
	readonly failures?: readonly string[];
}

export async function runManagedProcessPtyVerification(): Promise<ManagedProcessPtyRunnerResult> {
	if (process.platform === "win32") return { passed: false, checks: [], failures: ["POSIX node-pty runner requires POSIX"] };
	const root = await mkdtemp(join(tmpdir(), "runledger-r10-pty-"));
	const layout = buildRunledgerLayout(join(root, "home"), "posix");
	const scope = createLocalRuntimeHostScope({ layout, cwd: root, settings: {} });
	const endpointStore = new EndpointStore(layout, scope.workspaceStorageKey);
	const helperPath = join(root, "peer-credential-helper");
	const checks: string[] = [];
	let driver: ProductionRuntimeHostConnection | undefined;
	let observer: ProductionRuntimeHostConnection | undefined;
	let reconnected: ProductionRuntimeHostConnection | undefined;
	let shutdownRequested = false;
	try {
		await buildLinuxPeerCredentialHelper(helperPath);
		driver = await connectProductionRuntimeHost({
			layout,
			cwd: root,
			settings: {},
			peerCredentialHelperPath: helperPath,
			wait: { timeoutMs: 15_000, intervalMs: 25 },
		});
		observer = await connectProductionRuntimeHost({
			layout,
			cwd: root,
			settings: {},
			peerCredentialHelperPath: helperPath,
			wait: { timeoutMs: 15_000, intervalMs: 25 },
		});

		const opened = await command(driver, "pty-session-open", "session.open", { mode: "create", cwd: root });
		const sessionId = stringValue(opened.body.sessionId);
		if (opened.body.ok !== true || sessionId === undefined) {
			return { passed: false, checks, failures: ["production PTY session open failed"] };
		}
		const firstSubscription = await command(driver, "pty-subscribe-driver", "session.subscribe", { sessionId });
		const secondSubscription = await command(observer, "pty-subscribe-observer", "session.subscribe", { sessionId });
		if (firstSubscription.body.ok !== true || secondSubscription.body.ok !== true) {
			return { passed: false, checks, failures: ["production PTY subscription failed"] };
		}
		const claimed = await command(driver, "pty-claim-driver", "session.claim_driver", { sessionId });
		if (claimed.body.ok !== true) return { passed: false, checks, failures: ["production PTY driver claim failed"] };

		const created = await command(driver, "pty-process-create", "process.create", {
			sessionId,
			command: buildPtyCommand(),
			cwd: root,
			backend: "pty",
			executionMode: "background",
			timeoutMs: 5_000,
			containment: "none",
		});
		const handle = isRecord(created.body.handle) ? created.body.handle : undefined;
		const executionId = handle === undefined ? undefined : stringValue(handle.executionId);
		if (
			created.body.ok !== true ||
			executionId === undefined ||
		/(?:pid|outputPath|command|cwd)/iu.test(JSON.stringify(created.body))
		) {
			return { passed: false, checks, failures: ["production PTY facade did not return a safe handle"] };
		}
		checks.push("production_host_facade");

		const observerStop = await command(observer, "pty-observer-stop", "process.stop", { sessionId, executionId, signal: "SIGTERM" });
		if (observerStop.body.ok !== false || observerStop.body.code !== "observer_mutation_forbidden") {
			return { passed: false, checks, failures: ["PTY observer mutation was not fenced"] };
		}
		checks.push("driver_fence");

		const resized = await command(driver, "pty-resize", "process.resize", {
			sessionId,
			executionId,
			columns: 100,
			rows: 30,
		});
		if (resized.body.ok !== true) return { passed: false, checks, failures: ["production PTY resize failed"] };
		checks.push("pty_resize");

		await driver.close();
		driver = undefined;
		checks.push("client_detach");

		const terminal = await command(observer, "pty-process-wait", "process.wait", { sessionId, executionId, timeoutMs: 5_000 });
		const output = await command(observer, "pty-process-output", "process.output", {
			sessionId,
			executionId,
			cursor: { sequence: 0, byteOffset: 0 },
			maxBytes: 1024,
		});
		if (
			terminal.body.ok !== true ||
			terminal.body.outcome !== "terminal" ||
			output.body.ok !== true ||
			output.body.page !== "pty✅\r\n" && output.body.page !== "pty✅\n"
		) {
			return { passed: false, checks, failures: ["production PTY terminal/output recovery failed"] };
		}
		checks.push("pty_utf8");

		const duplicate = await command(observer, "pty-process-wait-duplicate", "process.wait", { sessionId, executionId, timeoutMs: 5_000 });
		if (duplicate.body.ok !== true || duplicate.body.outcome !== "terminal") {
			return { passed: false, checks, failures: ["production PTY Queue delivery was not idempotent"] };
		}
		checks.push("queue_dedupe");

		await observer.close();
		observer = undefined;
		reconnected = await connectProductionRuntimeHost({
			layout,
			cwd: root,
			settings: {},
			peerCredentialHelperPath: helperPath,
			wait: { timeoutMs: 15_000, intervalMs: 25 },
		});
		const reopened = await command(reconnected, "pty-session-reopen", "session.open", { mode: "open", sessionId, cwd: root });
		const recovered = await command(reconnected, "pty-output-reconnect", "process.output", {
			sessionId,
			executionId,
			cursor: { sequence: 0, byteOffset: 0 },
			maxBytes: 1024,
		});
		if (
			reopened.body.ok !== true ||
			recovered.body.ok !== true ||
			!stringValue(recovered.body.page)?.includes("pty✅")
		) {
			return { passed: false, checks, failures: ["production PTY reconnect cursor recovery failed"] };
		}
		checks.push("output_recovery");

		const shutdown = await command(reconnected, "pty-host-shutdown", "host.shutdown", {});
		if (shutdown.body.ok !== true || shutdown.body.accepted !== true) {
			return { passed: false, checks, failures: ["production PTY Host shutdown was not accepted"] };
		}
		shutdownRequested = true;
		checks.push("explicit_host_shutdown");
		await reconnected.close();
		reconnected = undefined;
		await waitForEndpointGone(endpointStore);
		return { passed: true, checks };
	} catch (error) {
		return { passed: false, checks, failures: [error instanceof Error ? error.message : String(error)] };
	} finally {
		if (!shutdownRequested) {
			const remaining = reconnected ?? observer ?? driver;
			if (remaining !== undefined) await command(remaining, "pty-host-shutdown-fallback", "host.shutdown", {}).catch(() => undefined);
		}
		await Promise.all([
			driver?.close().catch(() => undefined),
			observer?.close().catch(() => undefined),
			reconnected?.close().catch(() => undefined),
		]);
		await waitForEndpointGone(endpointStore).catch(() => undefined);
		await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
	}
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
	throw new Error("resident PTY Host endpoint did not clear after shutdown");
}

function buildPtyCommand(): string {
	const javascript = "setTimeout(() => process.stdout.write('pty✅\\n'), 1000)";
	return `${shellQuote(process.execPath)} -e ${shellQuote(javascript)}`;
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

if (process.argv[1]?.endsWith("verify-managed-process-pty.ts")) {
	runManagedProcessPtyVerification().then((result) => {
		console.log(JSON.stringify(result));
		if (!result.passed) process.exitCode = 1;
	}).catch((error: unknown) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	});
}
