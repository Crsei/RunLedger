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

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRunledgerLayout } from "../src/runtime/contracts/storage-layout.ts";
import { HOST_PROTOCOL_VERSION } from "../src/runtime/host/contracts.ts";
import type { HostFrameEnvelope } from "../src/runtime/host/types.ts";
import { EndpointStore } from "../src/storage/host/endpoint-store.ts";
import {
	createLocalRuntimeHostScope,
	connectProductionRuntimeHost,
	type ProductionRuntimeHostConnection,
} from "../src/cli/runtime-host-production.ts";
import { buildLinuxPeerCredentialHelper } from "./build-linux-peer-credential-helper.ts";

export interface AcceptanceRunnerResult {
	readonly passed: boolean;
	readonly checks: readonly string[];
	readonly failures?: readonly string[];
}

export async function runMultiClientHostVerification(): Promise<AcceptanceRunnerResult> {
	if (process.platform !== "linux") {
		return { passed: false, checks: [], failures: ["Linux SO_PEERCRED runner is unsupported on this platform"] };
	}
	const root = await mkdtemp(join(tmpdir(), "runledger-r10-host-"));
	const layout = buildRunledgerLayout(join(root, "home"), "posix");
	const helperPath = join(root, "peer-credential-helper");
	const checks: string[] = [];
	let first: ProductionRuntimeHostConnection | undefined;
	let second: ProductionRuntimeHostConnection | undefined;
	let shutdownRequested = false;
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
			return { passed: false, checks, failures: ["standard connect-or-spawn did not reuse one resident Host"] };
		}
		checks.push("standard_path_connect_or_spawn", "two_clients_one_host");

		const opened = await command(first, "session-open-first", "session.open", { mode: "create", cwd: root });
		const sessionId = stringValue(opened.body.sessionId);
		if (opened.body.ok !== true || sessionId === undefined) {
			return { passed: false, checks, failures: ["first production session open failed"] };
		}
		const reopened = await command(second, "session-open-second", "session.open", { mode: "open", sessionId, cwd: root });
		if (reopened.body.ok !== true || reopened.body.sessionId !== sessionId) {
			return { passed: false, checks, failures: ["second production client did not reuse the session"] };
		}
		checks.push("same_session_owner");

		await command(first, "session-subscribe-first", "session.subscribe", { sessionId });
		await command(second, "session-subscribe-second", "session.subscribe", { sessionId });
		const claimed = await command(first, "session-claim-driver", "session.claim_driver", { sessionId });
		if (claimed.body.ok !== true) return { passed: false, checks, failures: ["production driver claim failed"] };

		const thinking = await command(first, "session-thinking", "session.set_thinking", { sessionId, level: "off" }, "session-thinking-command");
		const thinkingRetry = await command(first, "session-thinking-retry", "session.set_thinking", { sessionId, level: "off" }, "session-thinking-command");
		const observerMutation = await command(second, "session-observer-thinking", "session.set_thinking", { sessionId, level: "off" });
		if (thinking.body.ok !== true || thinkingRetry.body.ok !== true || observerMutation.body.code !== "observer_mutation_forbidden") {
			return { passed: false, checks, failures: ["production driver/idempotency fence failed"] };
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
		});
		const handle = isRecord(created.body.handle) ? created.body.handle : undefined;
		const executionId = handle === undefined ? undefined : stringValue(handle.executionId);
		if (created.body.ok !== true || executionId === undefined || /(?:pid|outputPath|command|cwd)/iu.test(JSON.stringify(created.body))) {
			return {
				passed: false,
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
			return { passed: false, checks, failures: ["production process output/recovery facade failed"] };
		}
		checks.push("standard_path_process_facade");

		const shutdown = await command(second, "host-shutdown", "host.shutdown", {});
		if (shutdown.body.ok !== true || shutdown.body.accepted !== true) {
			return { passed: false, checks, failures: ["explicit Host shutdown was not accepted"] };
		}
		shutdownRequested = true;
		checks.push("explicit_host_shutdown");
		await Promise.all([first.close(), second.close()]);
		await waitForEndpointGone(endpointStore);
		return { passed: true, checks };
	} catch (error) {
		return { passed: false, checks, failures: [error instanceof Error ? error.message : String(error)] };
	} finally {
		if (!shutdownRequested && first !== undefined) {
			await command(first, "host-shutdown-fallback", "host.shutdown", {}).catch(() => undefined);
		}
		await first?.close().catch(() => undefined);
		await second?.close().catch(() => undefined);
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
	throw new Error("resident Host endpoint did not clear after shutdown");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
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
