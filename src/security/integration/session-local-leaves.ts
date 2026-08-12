/**
 * Session Runtime 的精确本地执行叶。
 *
 * 该文件是唯一允许 Session Security 组合触碰 raw fs/fetch/child_process 的
 * adapter；上层只能消费受策略约束的 broker/launch-plan 接口。
 */

import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import { delimiter, dirname, join, resolve } from "node:path";
import type { Stats } from "node:fs";
import { promisify } from "node:util";
import type { ShellResult } from "../../runtime/execution-env.ts";
import type { FileSystemBrokerPort } from "../policy-filesystem.ts";
import type { NetworkBrokerPort, NetworkBrokerResponse } from "../policy-network.ts";
import type { SandboxLaunchPlan } from "../sandbox/types.ts";
import type { GovernedProcessEnvironment, SessionToolchainProbe } from "../toolchain.ts";

const execFileAsync = promisify(execFile);

export interface SessionProcessIo {
	readonly signal?: AbortSignal;
	readonly maxOutputChars?: number;
	readonly onStdout?: (chunk: string) => void;
	readonly onStderr?: (chunk: string) => void;
}

/** 限制性进程叶只能消费不可变 sandbox launch plan。 */
export interface SessionProcessLeaf {
	execute(plan: SandboxLaunchPlan, io?: SessionProcessIo): Promise<ShellResult>;
}

export function createLocalFileSystemBroker(): FileSystemBrokerPort {
	return {
		readFile: (path) => fs.readFile(path),
		writeFile: async (path, data) => { await fs.writeFile(path, data); },
		stat: async (path) => fileStats(await fs.stat(path)),
		lstat: async (path) => fileStats(await fs.lstat(path)),
		realpath: (path) => fs.realpath(path),
		readdir: (path) => fs.readdir(path),
		mkdir: async (path, options) => { await fs.mkdir(path, options); },
		rm: async (path, options) => { await fs.rm(path, options); },
		rename: async (from, to) => { await fs.rename(from, to); },
	};
}

/** Security config source 的 UTF-8 文件读取也必须经过同一个精确 adapter。 */
export function readLocalUtf8File(path: string): Promise<string> {
	return fs.readFile(path, "utf8");
}

export function createLocalNetworkBroker(): NetworkBrokerPort {
	return {
		request: async (request, signal): Promise<NetworkBrokerResponse> => {
			const response = await fetch(request.url, {
				method: request.method,
				headers: request.headers,
				body: request.body === undefined ? undefined : typeof request.body === "string" ? request.body : Uint8Array.from(request.body),
				redirect: "manual",
				signal,
			});
			const headers: Record<string, string> = {};
			response.headers.forEach((value, key) => { headers[key] = value; });
			return { status: response.status, headers, body: Buffer.from(await response.arrayBuffer()), finalUrl: request.url };
		},
	};
}

export function createLocalSessionProcessLeaf(): SessionProcessLeaf {
	return {
		execute: (plan, io) => executeLaunchPlan(plan, io),
	};
}

/** Sandbox backend probe 使用的本机 executable locator。 */
export async function findLocalExecutable(program: string): Promise<string | undefined> {
	if (program.includes("/") || program.includes("\\")) return existsSync(program) ? program : undefined;
	for (const entry of (process.env.PATH ?? "").split(delimiter)) {
		const candidate = join(entry || ".", program);
		if (existsSync(candidate)) return candidate;
	}
	return undefined;
}

/** Session composition root 使用的本机工具链探针。 */
export function createLocalSessionToolchainProbe(): SessionToolchainProbe {
	return {
		which: (program) => findLocalExecutable(program),
		realpath: async (path) => fs.realpath(path).catch(() => undefined),
		readFile: (path) => fs.readFile(path),
		stat: async (path) => {
			const value = await fs.stat(path);
			return { device: value.dev, inode: value.ino, size: value.size, mtimeMs: value.mtimeMs };
		},
		run: async (program, args) => {
			try {
				const result = await execFileAsync(program, [...args], {
					timeout: 10_000,
					windowsHide: true,
					env: { PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "" },
				});
				return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
			} catch (error) {
				const value = error as { readonly code?: number | string; readonly stdout?: string; readonly stderr?: string };
				return { exitCode: typeof value.code === "number" ? value.code : 127, stdout: value.stdout ?? "", stderr: value.stderr ?? "" };
			}
		},
	};
}

/** 创建并复验 Session 私有 HOME/cache/tmp；拒绝符号链接和目录逃逸。 */
export async function prepareLocalGovernedProcessDirectories(
	temporaryRoot: string,
	governed: GovernedProcessEnvironment,
): Promise<void> {
	const root = resolve(governed.privateRoot);
	const expected = [
		root,
		join(root, "home"),
		join(root, "tmp"),
		join(root, "cache"),
		join(root, "npm-cache"),
	];
	if (dirname(root) !== resolve(temporaryRoot) ||
		governed.environment.HOME !== expected[1] ||
		governed.environment.TMPDIR !== expected[2] ||
		governed.environment.XDG_CACHE_HOME !== expected[3] ||
		governed.environment.npm_config_cache !== expected[4]) {
		throw new Error("governed process directory layout is invalid");
	}
	await ensurePrivateDirectory(resolve(temporaryRoot));
	for (const directory of expected) await ensurePrivateDirectory(directory);
}

/** 只在最终 sandbox adapter 边界探测 native path 是否存在。 */
export function existingLocalPaths(paths: readonly string[]): string[] {
	return paths.filter((path) => existsSync(path));
}

function fileStats(value: Stats) {
	return {
		size: value.size,
		mtimeMs: value.mtimeMs,
		isFile: value.isFile(),
		isDirectory: value.isDirectory(),
		isSymbolicLink: value.isSymbolicLink(),
	};
}

async function ensurePrivateDirectory(path: string): Promise<void> {
	await fs.mkdir(path, { recursive: true, mode: 0o700 });
	const info = await fs.lstat(path);
	if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`governed process path is not a private directory: ${path}`);
	await fs.chmod(path, 0o700);
}

function executeLaunchPlan(plan: SandboxLaunchPlan, io?: SessionProcessIo): Promise<ShellResult> {
	return new Promise((done) => {
		const child: ChildProcess = spawn(plan.program, [...plan.arguments], {
			cwd: plan.cwd,
			env: { ...plan.environment },
			windowsHide: true,
			stdio: ["pipe", "pipe", "pipe"],
		});
		const maxChars = io?.maxOutputChars ?? 1_000_000;
		let stdout = "";
		let stderr = "";
		let settled = false;
		const finish = (result: ShellResult): void => {
			if (settled) return;
			settled = true;
			done(result);
		};
		child.stdout?.on("data", (chunk: Buffer) => {
			const text = chunk.toString("utf8");
			stdout = boundedAppend(stdout, text, maxChars);
			io?.onStdout?.(text);
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			const text = chunk.toString("utf8");
			stderr = boundedAppend(stderr, text, maxChars);
			io?.onStderr?.(text);
		});
		const terminate = (): void => { try { child.kill("SIGKILL"); } catch { /* 已退出。 */ } };
		const timer = setTimeout(terminate, plan.timeoutMs);
		io?.signal?.addEventListener("abort", terminate, { once: true });
		child.on("error", (error) => {
			clearTimeout(timer);
			io?.signal?.removeEventListener("abort", terminate);
			finish({ stdout: truncate(stdout, maxChars), stderr: truncate(`${stderr}${error.message}`, maxChars), exitCode: 127, signaled: false });
		});
		child.on("close", (code, signal) => {
			clearTimeout(timer);
			io?.signal?.removeEventListener("abort", terminate);
			finish({ stdout: truncate(stdout, maxChars), stderr: truncate(stderr, maxChars), exitCode: code ?? 127, signaled: signal !== null });
		});
		if (plan.stdin !== undefined && child.stdin) child.stdin.write(plan.stdin);
		child.stdin?.end();
	});
}

function boundedAppend(current: string, chunk: string, maxChars: number): string {
	const next = current + chunk;
	return next.length > maxChars * 2 ? next.slice(-maxChars * 2) : next;
}

function truncate(value: string, maxChars: number): string {
	return value.length <= maxChars ? value : value.slice(-maxChars);
}
