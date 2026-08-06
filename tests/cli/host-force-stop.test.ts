import { afterEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHostEndpointRecord } from "../../src/storage/host/endpoint-store.ts";
import { readLinuxProcessIdentity } from "../../src/storage/host/linux-process-identity.ts";
import { runtimeDigest } from "../../src/runtime/protocol/foundation.ts";
import { createRuntimeId } from "../../src/runtime/protocol/ids.ts";
import { forceStopValidatedLinuxHost } from "../../src/cli/host-command.ts";

const children: ChildProcess[] = [];
const roots: string[] = [];

afterEach(async () => {
	for (const child of children.splice(0)) {
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
	}
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe.runIf(process.platform === "linux")("validated Host force stop", () => {
	it("refuses a PID whose live start identity does not match the endpoint", async () => {
		const { child, socketPath } = await spawnSocketOwner();
		const endpoint = await endpointFor(child, runtimeDigest("wrong-start-identity"));
		await expect(forceStopValidatedLinuxHost({ endpoint, socketPath })).resolves.toEqual({ ok: false, code: "host_process_identity_mismatch" });
		expect(child.exitCode).toBeNull();
	});

	it("sends SIGTERM only after the socket owner and process identity match", async () => {
		const { child, socketPath } = await spawnSocketOwner();
		const identity = await readLinuxProcessIdentity(child.pid!);
		const endpoint = await endpointFor(child, identity.digest);
		await expect(forceStopValidatedLinuxHost({ endpoint, socketPath })).resolves.toEqual({ ok: true, signal: "SIGTERM", pid: child.pid });
		await new Promise<void>((resolve) => child.once("exit", () => resolve()));
		expect(child.signalCode).toBe("SIGTERM");
	});
});

async function spawnSocketOwner(): Promise<{ child: ChildProcess; socketPath: string }> {
	const root = await mkdtemp(join(tmpdir(), "runledger-force-stop-"));
	roots.push(root);
	const socketPath = join(root, "host.sock");
	const child = spawn(process.execPath, ["-e", [
		"const net=require('node:net');",
		"const server=net.createServer();",
		"server.listen(process.argv[1],()=>process.stdout.write('ready\\n'));",
		"setInterval(()=>{},1000);",
	].join(""), socketPath], { stdio: ["ignore", "pipe", "inherit"] });
	children.push(child);
	await new Promise<void>((resolve, reject) => {
		child.once("error", reject);
		child.stdout!.once("data", () => resolve());
	});
	return { child, socketPath };
}

async function endpointFor(child: ChildProcess, processDigest: ReturnType<typeof runtimeDigest>) {
	return createHostEndpointRecord({
		protocolVersion: 1,
		managementProtocolVersion: 1,
		workspaceStorageKey: "ws-" + "f".repeat(64),
		hostRuntimeId: createRuntimeId("runtime", "force-stop-test"),
		hostGeneration: 8,
		hostProcessId: child.pid!,
		hostProcessStartIdentityDigest: processDigest,
		hostBuildDigest: runtimeDigest("build"),
		state: "ready",
		compatibilityDigest: runtimeDigest("scope"),
		publishedAt: "2026-08-07T00:00:00.000Z",
	});
}
