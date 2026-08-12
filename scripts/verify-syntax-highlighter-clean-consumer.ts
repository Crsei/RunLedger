/** 在临时 consumer 中安装两个 tarball，并分别用 Node/Bun 验证 optional package。 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const target = process.env.RUNLEDGER_SYNTAX_TARGET;
if (target === undefined || !/^(?:linux-(?:x64|arm64)-(?:gnu|musl)|darwin-(?:x64|arm64)|win32-(?:x64|arm64)-msvc)$/u.test(target)) {
	throw new Error("RUNLEDGER_SYNTAX_TARGET is required");
}

const root = resolve(".");
const packageDirectory = resolve(`npm/syntax-highlighter-${target}`);
const rootTarball = resolve(root, pack(root));
const targetTarball = resolve(packageDirectory, pack(packageDirectory));
const consumer = await mkdtemp(join(tmpdir(), "runledger-syntax-consumer-"));
try {
	await writeFile(join(consumer, "package.json"), '{"name":"syntax-clean-consumer","private":true,"type":"module"}\n');
	run(npmCommand(), ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--no-package-lock", rootTarball, targetTarball], consumer);
	try {
		await readFile(join(consumer, "node_modules/runledger/dist/native/runledger-syntax-highlighter.node"));
		throw new Error("root package unexpectedly contains a local syntax addon");
	} catch (error) {
		if (error instanceof Error && error.message === "root package unexpectedly contains a local syntax addon") throw error;
	}
	const smoke = resolve(root, "scripts/smoke-syntax-highlighter-clean-consumer.ts");
	const environment = { ...process.env, RUNLEDGER_SYNTAX_CONSUMER_ROOT: consumer };
	run(process.execPath, ["--experimental-strip-types", smoke], root, environment);
	run(bunCommand(), [smoke], root, environment);
} finally {
	await rm(consumer, { recursive: true, force: true });
}

function pack(cwd: string): string {
	const result = spawnSync(npmCommand(), ["pack", "--json", "--ignore-scripts"], { cwd, encoding: "utf8", shell: false });
	if (result.status !== 0) throw new Error(result.stderr || `npm pack failed with status ${String(result.status)}`);
	const output = JSON.parse(result.stdout) as unknown;
	if (!Array.isArray(output) || !isObject(output[0]) || typeof output[0].filename !== "string") throw new Error("npm pack returned an invalid manifest");
	return output[0].filename;
}

function run(command: string, args: readonly string[], cwd: string, environment: NodeJS.ProcessEnv = process.env): void {
	const result = spawnSync(command, [...args], {
		cwd,
		env: { ...environment, PATH: environment.PATH ?? process.env.PATH ?? "" },
		stdio: "inherit",
		shell: false,
	});
	if (result.status !== 0) throw new Error(`${command} failed with status ${String(result.status)}`);
}

function npmCommand(): string {
	return process.platform === "win32" ? "npm.cmd" : "npm";
}

function bunCommand(): string {
	const executable = process.platform === "win32" ? "bun.exe" : "bun";
	for (const directory of (process.env.PATH ?? "").split(delimiter)) {
		if (directory.length > 0 && process.execPath.startsWith(directory)) break;
	}
	return executable;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
