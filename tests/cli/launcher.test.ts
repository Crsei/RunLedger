import { spawn, type ChildProcess } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";

const launcherPath = resolve(import.meta.dirname, "../../bin/runledger.js");

async function createFixture(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "runledger-launcher-"));
	await mkdir(join(root, "bin"));
	await mkdir(join(root, "dist/cli"), { recursive: true });
	await writeFile(join(root, "package.json"), '{"type":"module"}');
	await copyFile(launcherPath, join(root, "bin/runledger.js"));
	await writeFile(join(root, "dist/cli/cli.js"), `
import { createServer } from "node:http";
import { writeFileSync } from "node:fs";
if (process.argv[2] === "exit") process.exit(Number(process.argv[3]));
if (process.argv[2] === "signal") process.kill(process.pid, "SIGTERM");
const server = createServer((_request, response) => response.end("alive"));
let stopping = false;
process.on("SIGTERM", () => {
  if (stopping) return;
  stopping = true;
  setTimeout(() => server.close(() => {
    writeFileSync("stopped.json", JSON.stringify({ pid: process.pid }));
    process.exit(0);
  }), 150);
});
server.listen(0, "127.0.0.1", () => console.log(JSON.stringify({ pid: process.pid, port: server.address().port })));
`);
	return root;
}

function exited(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
	return new Promise((resolveExit, reject) => {
		child.once("exit", (code, signal) => resolveExit({ code, signal }));
		child.once("error", reject);
	});
}

async function ready(child: ChildProcess): Promise<{ pid: number; port: number }> {
	return new Promise((resolveReady, reject) => {
		let output = "";
		const timer = setTimeout(() => reject(new Error("launcher fixture did not listen")), 5_000);
		child.stdout?.on("data", (data: Buffer) => {
			output += data.toString();
			if (!output.includes("\n")) return;
			clearTimeout(timer);
			resolveReady(JSON.parse(output.trim()) as { pid: number; port: number });
		});
		child.once("error", (error) => { clearTimeout(timer); reject(error); });
	});
}

function killIfAlive(pid: number): void {
	try { process.kill(pid, "SIGKILL"); } catch { /* 已退出，无需清理。 */ }
}

describe("npm bin launcher lifecycle", () => {
	it.skipIf(process.platform === "win32")("starts Bun only once and preserves the CLI exit code", async () => {
		const root = await createFixture();
		const runtime = join(root, "bin/bun");
		await writeFile(runtime, `#!${process.execPath}
import { appendFileSync } from "node:fs";
appendFileSync("bun-calls", "called\\n");
process.exit(process.argv.includes("--version") ? 0 : 23);
`);
		await chmod(runtime, 0o700);
		try {
			const child = spawn(process.execPath, [join(root, "bin/runledger.js")], { cwd: root, env: { ...process.env, PATH: join(root, "bin") } });
			expect(await exited(child)).toEqual({ code: 23, signal: null });
			expect((await readFile(join(root, "bun-calls"), "utf8")).trim().split("\n")).toHaveLength(1);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it.skipIf(process.platform === "win32")("reports missing Bun with exit 127", async () => {
		const root = await createFixture();
		try {
			const child = spawn(process.execPath, [join(root, "bin/runledger.js")], { cwd: root, env: { ...process.env, PATH: join(root, "empty") } });
			let diagnostic = "";
			child.stderr?.on("data", (data: Buffer) => { diagnostic += data.toString(); });
			expect(await exited(child)).toEqual({ code: 127, signal: null });
			expect(diagnostic).toMatch(/Bun.*required/);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it.each([0, 23])("preserves child exit code %i", async (code) => {
		const root = await createFixture();
		try {
			const child = spawn(process.execPath, [join(root, "bin/runledger.js"), "exit", String(code)], { cwd: root });
			expect(await exited(child)).toEqual({ code, signal: null });
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it.skipIf(process.platform === "win32")("preserves an unhandled child termination signal", async () => {
		const root = await createFixture();
		try {
			const child = spawn(process.execPath, [join(root, "bin/runledger.js"), "signal"], { cwd: root });
			expect(await exited(child)).toEqual({ code: null, signal: "SIGTERM" });
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it.skipIf(process.platform === "win32").each(["launcher", "process-group"] as const)("waits for graceful child shutdown after %s SIGTERM", async (target) => {
		const root = await createFixture();
		const child = spawn(process.execPath, [join(root, "bin/runledger.js")], { cwd: root, detached: true });
		const exit = exited(child);
		let serverPid: number | undefined;
		try {
			const address = await ready(child);
			serverPid = address.pid;
			expect((await fetch(`http://127.0.0.1:${address.port}`)).status).toBe(200);
			if (child.pid === undefined) throw new Error("launcher PID missing");
			process.kill(target === "launcher" ? child.pid : -child.pid, "SIGTERM");
			expect(await exit).toEqual({ code: 0, signal: null });
			expect(JSON.parse(await readFile(join(root, "stopped.json"), "utf8"))).toEqual({ pid: address.pid });
			await expect(fetch(`http://127.0.0.1:${address.port}`, { signal: AbortSignal.timeout(1_000) })).rejects.toThrow();
			expect(() => process.kill(address.pid, 0)).toThrow();
		} finally {
			if (child.pid !== undefined) killIfAlive(-child.pid);
			if (serverPid !== undefined) killIfAlive(serverPid);
			await Promise.race([exit, delay(1_000)]);
			await rm(root, { recursive: true, force: true });
		}
	});
});
