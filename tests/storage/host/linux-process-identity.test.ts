import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:net";
import { runtimeDigest } from "../../../src/runtime/protocol/foundation.ts";
import {
	discoverLinuxUnixSocketOwnerPid,
	parseLinuxProcessStatStartTicks,
	readLinuxProcessIdentity,
	verifyLinuxProcessIdentity,
} from "../../../src/storage/host/linux-process-identity.ts";

const servers: Server[] = [];
const roots: string[] = [];

afterEach(async () => {
	await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe.runIf(process.platform === "linux")("Linux Host process identity", () => {
	it("parses start ticks after a command name containing spaces and parentheses", () => {
		const prefix = "42 (run ledger (host)) R";
		const fields4Through21 = Array.from({ length: 18 }, (_, index) => String(index + 4));
		expect(parseLinuxProcessStatStartTicks(`${prefix} ${fields4Through21.join(" ")} 987654 0 0`)).toBe("987654");
	});

	it("binds the live process to boot, uid, start ticks and executable inode", async () => {
		const identity = await readLinuxProcessIdentity(process.pid);
		expect(identity.pid).toBe(process.pid);
		expect(identity.uid).toBe(process.getuid?.());
		expect(identity.startTicks).toMatch(/^[0-9]+$/u);
		expect(identity.executableInode).toMatch(/^[0-9]+$/u);
		await expect(verifyLinuxProcessIdentity(process.pid, identity.digest)).resolves.toBe(true);
		await expect(verifyLinuxProcessIdentity(process.pid, runtimeDigest("different-process"))).resolves.toBe(false);
	});

	it("discovers the PID that owns an exact Unix socket path", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-socket-owner-"));
		roots.push(root);
		const socketPath = join(root, "host.sock");
		const server = createServer();
		servers.push(server);
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(socketPath, resolve);
		});
		await expect(discoverLinuxUnixSocketOwnerPid(socketPath)).resolves.toBe(process.pid);
	});
});
