import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { once } from "node:events";
import { expect, it } from "vitest";

it("creates an isolated Unix socket leak only when the runner regression probe requests it", async () => {
	if (process.env.RUNLEDGER_TEST_CLEANUP_PROBE !== "socket" || process.platform === "win32") return;
	const root = process.env.RUNLEDGER_DIR;
	expect(root).toBeDefined();
	if (root === undefined) return;
	const socketPath = join(root, "probe-leaked.sock");
	const child = spawn(process.execPath, [
		"-e",
		"const net = require('node:net'); const server = net.createServer(); server.listen(process.argv[1], () => process.stdout.write('ready'));",
		socketPath,
	], { stdio: ["ignore", "pipe", "ignore"] });
	await once(child.stdout!, "data");
	child.kill("SIGKILL");
	await once(child, "exit");
	expect(existsSync(socketPath)).toBe(true);
});
