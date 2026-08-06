#!/usr/bin/env node

/** Real same-version, different-content resident Host replacement runner. */

import { appendFile, copyFile, mkdir, mkdtemp, readFile, rename, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join, resolve } from "node:path";
import { buildRunledgerLayout } from "../src/runtime/contracts/storage-layout.ts";
import type { HostFrameEnvelope } from "../src/runtime/host/types.ts";
import { EndpointStore } from "../src/storage/host/endpoint-store.ts";
import { writeHostBuildManifest, loadVerifiedHostBuildManifest } from "../src/cli/host-build-identity.ts";
import {
	connectProductionHostManagement,
	connectProductionRuntimeHost,
	type ProductionRuntimeHostConnection,
} from "../src/cli/runtime-host-production.ts";

export interface HostBuildReplacementVerification {
	readonly passed: boolean;
	readonly outcome: "pass" | "fail" | "unsupported";
	readonly checks: readonly string[];
	readonly failures?: readonly string[];
}

const execFileAsync = promisify(execFile);

export async function runHostBuildReplacementVerification(): Promise<HostBuildReplacementVerification> {
	if (process.platform !== "linux") return { passed: false, outcome: "unsupported", checks: [] };
	await mkdir(resolve("tmp"), { recursive: true });
	const root = await mkdtemp(join(resolve("tmp"), "host-build-replacement-"));
	const oldRoot = resolve("dist");
	const newRoot = join(root, "new", "dist");
	const layout = buildRunledgerLayout(join(root, "home"), "posix");
	const checks: string[] = [];
	let active: ProductionRuntimeHostConnection | undefined;
	let endpointStore: EndpointStore | undefined;
	try {
		await mkdir(join(root, "new"), { recursive: true });
		await execFileAsync("cp", ["-al", oldRoot, newRoot], { maxBuffer: 64 * 1024 * 1024 });
		const packageDocument = JSON.parse(await readFile(resolve("package.json"), "utf8")) as { version?: unknown };
		if (typeof packageDocument.version !== "string") throw new Error("package version unavailable");
		const replacementEntry = join(newRoot, "cli", "runtime-host.js");
		const replacementStaging = join(root, "runtime-host.replacement.js");
		await copyFile(join(oldRoot, "cli", "runtime-host.js"), replacementStaging);
		await rename(replacementStaging, replacementEntry);
		await appendFile(join(newRoot, "cli", "runtime-host.js"), "\n// same-version replacement acceptance content\n", "utf8");
		await writeHostBuildManifest(newRoot, packageDocument.version);
		const oldManifest = await loadVerifiedHostBuildManifest(oldRoot);
		const newManifest = await loadVerifiedHostBuildManifest(newRoot);
		if (oldManifest.packageVersion !== newManifest.packageVersion || oldManifest.contentDigest.digest === newManifest.contentDigest.digest) {
			throw new Error("runner did not create same-version distinct build content");
		}
		checks.push("same_version_different_content");

		active = await connectProductionRuntimeHost({
			layout,
			cwd: root,
			settings: {},
			hostBuildDigest: oldManifest.contentDigest,
			entryPath: join(oldRoot, "cli", "runtime-host.js"),
			peerCredentialHelperPath: join(oldRoot, "native", "runledger-linux-peer-credential"),
			wait: { timeoutMs: 15_000, intervalMs: 25 },
		});
		endpointStore = new EndpointStore(layout, active.endpoint.workspaceStorageKey);
		const oldEndpoint = active.endpoint;
		await active.close();
		active = undefined;

		let mismatch = "";
		try {
			await connectProductionRuntimeHost({
				layout,
				cwd: root,
				settings: {},
				hostBuildDigest: newManifest.contentDigest,
				entryPath: join(newRoot, "cli", "runtime-host.js"),
				peerCredentialHelperPath: join(newRoot, "native", "runledger-linux-peer-credential"),
			});
		} catch (error) {
			mismatch = error instanceof Error ? error.message : String(error);
		}
		if (mismatch !== "host_build_mismatch") throw new Error(`expected host_build_mismatch, received ${mismatch || "success"}`);
		checks.push("host_build_mismatch");

		const management = await connectProductionHostManagement({ layout, endpoint: oldEndpoint });
		try {
			const stopped = await management.request(command("build-replacement-stop", "host.shutdown", {
				expectedHostRuntimeId: oldEndpoint.hostRuntimeId,
				expectedHostGeneration: oldEndpoint.hostGeneration,
				reason: "maintenance_restart",
				confirmActive: false,
				targetBuildDigest: newManifest.contentDigest,
			}));
			if (stopped.body.ok !== true) throw new Error(`maintenance shutdown rejected: ${String(stopped.body.code)}`);
		} finally {
			await management.close();
		}
		await waitForEndpointGone(endpointStore);
		checks.push("maintenance_target_fence");

		active = await connectProductionRuntimeHost({
			layout,
			cwd: root,
			settings: {},
			hostBuildDigest: newManifest.contentDigest,
			entryPath: join(newRoot, "cli", "runtime-host.js"),
			peerCredentialHelperPath: join(newRoot, "native", "runledger-linux-peer-credential"),
			wait: { timeoutMs: 15_000, intervalMs: 25 },
		});
		if (active.endpoint.hostGeneration <= oldEndpoint.hostGeneration || active.endpoint.hostBuildDigest.digest !== newManifest.contentDigest.digest) {
			throw new Error("replacement Host did not advance generation with target build");
		}
		checks.push("replacement_generation_advanced");
		await stopHost(layout, active);
		active = undefined;
		await waitForEndpointGone(endpointStore);
		return { passed: true, outcome: "pass", checks };
	} catch (error) {
		return { passed: false, outcome: "fail", checks, failures: [error instanceof Error ? error.message : String(error)] };
	} finally {
		if (active !== undefined) await stopHost(layout, active).catch(() => undefined);
		await rm(root, { recursive: true, force: true });
	}
}

async function stopHost(layout: ReturnType<typeof buildRunledgerLayout>, connection: ProductionRuntimeHostConnection): Promise<void> {
	const endpoint = connection.endpoint;
	await connection.close().catch(() => undefined);
	const management = await connectProductionHostManagement({ layout, endpoint });
	try {
		await management.request(command("build-replacement-cleanup", "host.shutdown", {
			expectedHostRuntimeId: endpoint.hostRuntimeId,
			expectedHostGeneration: endpoint.hostGeneration,
			reason: "manual_stop",
			confirmActive: true,
		}));
	} finally {
		await management.close().catch(() => undefined);
	}
}

function command(frameId: string, operation: string, body: Record<string, unknown>): HostFrameEnvelope {
	return { frameId, kind: "command_request", protocolVersion: 1, body: { operation, commandId: frameId, ...body } };
}

async function waitForEndpointGone(store: EndpointStore): Promise<void> {
	for (let attempt = 0; attempt < 400; attempt += 1) {
		if (await store.read().catch(() => undefined) === undefined) return;
		await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 25));
	}
	throw new Error("Host endpoint did not clear after shutdown");
}

if (process.argv[1]?.endsWith("verify-host-build-replacement.ts")) {
	runHostBuildReplacementVerification().then((result) => {
		console.log(JSON.stringify(result));
		if (!result.passed) process.exitCode = 1;
	}).catch((error: unknown) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	});
}
