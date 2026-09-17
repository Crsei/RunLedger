/**
 * 受治 git materializer（P5、D7）。
 *
 * git 只经注入的既有 governed managed process port 执行：本模块不 import
 * `node:child_process`，也不接受原始 spawn。因此 clone/fetch 与其它工具副作用
 * 走同一条治理路径（authorization / ExecutionGateway / attempt barrier），
 * network policy 由该会话的 ExecutionEnv 决定——**默认拒绝**，需要真实网络时
 * 必须显式授权，这里不提供任何绕过开关。
 *
 * 参数一律经 shell 引用后拼成命令行；不接受调用方传入的裸 shell 片段。
 */

import { isAbsolute, relative, resolve, sep } from "node:path";
import type { OutputCursor } from "../../runtime/process/output.ts";
import type { ExecutionHandleRef } from "../../runtime/process/types.ts";
import type { ProcessToolClient } from "../../runtime/tools/process-tool-support.ts";
import type { ManagedBackgroundBashOperations } from "../../runtime/tools/bash.ts";
import type { ExtensionDistributionPort } from "./distribution-port.ts";
import type { ExtensionSourceMaterializer } from "./installer.ts";
import type { ResolvedGitSource } from "./marketplace/source-resolver.ts";

type ManagedMaterializeProcess = Pick<ProcessToolClient, "processOutput" | "processWait" | "stop"> & Pick<ManagedBackgroundBashOperations, "start">;

export interface ManagedGitMaterializerOptions {
	readonly managedProcess: ManagedMaterializeProcess;
	/** 用于 subdir 的落位与临时 worktree 清理；移动始终经 containment 校验的适配器。 */
	readonly storage: ExtensionDistributionPort;
	/** 绝对执行根；clone 的相对路径都以此为基准。 */
	readonly cwd: string;
	readonly timeoutMs?: number;
	readonly maxOutputBytes?: number;
	readonly stopTimeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_STOP_TIMEOUT_MS = 2_000;
/**
 * 输出页与单次等待的上限。这里刻意**不** import legacy Host 的
 * `RUNTIME_HOST_BOUNDS`：本模块是 R0 freeze 之后新增的生产消费者，导入 legacy
 * Host 会被 `check:session-owner-boundaries` 判为违规。取值镜像受管进程控制面的
 * 公开上界；若二者将来不一致，端口会返回 `output_cursor_invalid` /
 * `invalid_timeout`——失败是 fail-closed 的，不会变成无界读取。
 */
const OUTPUT_PAGE_BYTES = 64 * 1024;
const MAX_WAIT_MS = 30_000;
const GIT_ENV = "GIT_TERMINAL_PROMPT=0 GIT_ASKPASS= GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_PARAMETERS=''";

function shellQuote(value: string): string {
	return value.length === 0 ? "''" : `'${value.replaceAll("'", "'\\''")}'`;
}

/** 只接受 https URL 与保守的 ref/sha 字符集；其它输入直接拒绝。 */
function validate(source: ResolvedGitSource): { readonly ok: true } | { readonly ok: false; readonly message: string } {
	if (!source.url.startsWith("https://")) return { ok: false, message: "git source must use https" };
	if (/[\s'"\\]/u.test(source.url)) return { ok: false, message: "git source url contains characters that are not allowed" };
	if (source.ref !== undefined && !/^[A-Za-z0-9._/-]{1,256}$/u.test(source.ref)) return { ok: false, message: "git ref is not a conservative identifier" };
	if (source.sha !== undefined && !/^[0-9a-f]{7,64}$/u.test(source.sha)) return { ok: false, message: "git sha must be a lowercase hex prefix" };
	if (source.subdir !== undefined && (source.subdir.startsWith("/") || source.subdir.split("/").includes(".."))) return { ok: false, message: "git subdir must be relative and must not escape" };
	return { ok: true };
}

/**
 * 构造 git 命令行。有 sha 时用 fetch + detach，保证拿到的是**那个**提交，
 * 而不是一个可能已经前进的分支头。
 */
export function buildGitMaterializeCommand(source: ResolvedGitSource, worktree: string): string {
	if (source.sha !== undefined) {
		return [
			`${GIT_ENV} git init ${shellQuote(worktree)}`,
			`cd ${shellQuote(worktree)} && git fetch --depth 1 origin ${shellQuote(source.sha)} && git checkout --detach FETCH_HEAD`,
		].join(" && ");
	}
	const branch = source.ref === undefined ? "" : `--branch ${shellQuote(source.ref)} `;
	return `${GIT_ENV} git clone --depth 1 --single-branch ${branch}${shellQuote(source.url)} ${shellQuote(worktree)}`;
}

export function createManagedGitMaterializer(options: ManagedGitMaterializerOptions): ExtensionSourceMaterializer {
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const maxOutputBytes = options.maxOutputBytes ?? OUTPUT_PAGE_BYTES;
	const stopTimeoutMs = options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS;
	if (!isAbsolute(options.cwd)) throw new Error("git materializer cwd must be absolute");
	if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600_000) throw new Error("git materializer timeout is out of range");

	return {
		materialize: async ({ source, destination, signal }) => {
			const validated = validate(source);
			if (!validated.ok) return { ok: false, code: "source_invalid", message: validated.message };
			if (!isAbsolute(destination)) return { ok: false, code: "destination_invalid", message: "materialize destination must be absolute" };
			// 有 subdir 时先 clone 到同级的临时 worktree，再用受治理的文件适配器把
			// 子目录落位——不用 shell `mv`，移动仍然过 containment 校验。
			const finalDestination = resolve(destination);
			const worktree = source.subdir === undefined ? finalDestination : `${finalDestination}.worktree`;
			const command = buildGitMaterializeCommand(source, worktree);
			const started = await options.managedProcess.start({
				command,
				cwd: resolve(options.cwd),
				timeoutMs,
				...(signal === undefined ? {} : { signal }),
			});
			if (!started.ok) return { ok: false, code: "governed_process_rejected", message: `governed git process was rejected: ${started.code}` };
			const exit = await drain(options.managedProcess, started.handle, timeoutMs, maxOutputBytes, stopTimeoutMs);
			if (!exit.ok) return { ok: false, code: exit.code, message: exit.message };
			if (exit.exitCode !== 0) return { ok: false, code: "git_failed", message: `git exited with code ${exit.exitCode ?? "unknown"}` };
			if (source.subdir === undefined) return { ok: true };

			// subdir：只接受 worktree 内的相对路径，然后把它落位成 destination。
			const subdirPath = resolve(worktree, source.subdir);
			const rel = relative(worktree, subdirPath);
			if (rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel)) {
				await options.storage.remove(worktree, { recursive: true }).catch(() => undefined);
				return { ok: false, code: "source_escapes_root", message: "git subdir escapes the cloned worktree" };
			}
			const moved = await options.storage.rename(subdirPath, finalDestination);
			if (!moved.ok) {
				await options.storage.remove(worktree, { recursive: true }).catch(() => undefined);
				return { ok: false, code: "subdir_failed", message: moved.message };
			}
			await options.storage.remove(worktree, { recursive: true }).catch(() => undefined);
			return { ok: true };
		},
	};
}

interface DrainResult {
	readonly ok: boolean;
	readonly code: string;
	readonly message: string;
	readonly exitCode: number | null;
}

/** 有界排空输出并等待终态；超限即停进程，绝不无界累积。 */
async function drain(port: ManagedMaterializeProcess, handle: ExecutionHandleRef, timeoutMs: number, maxOutputBytes: number, stopTimeoutMs: number): Promise<DrainResult> {
	let cursor: OutputCursor = { sequence: 0, byteOffset: 0 };
	let captured = 0;
	try {
		while (true) {
			const page = await port.processOutput(handle, cursor, OUTPUT_PAGE_BYTES);
			if (!page.ok) return { ok: false, code: "output_unavailable", message: `governed git output failed: ${page.code}`, exitCode: null };
			const bytes = Buffer.byteLength(page.page.text, "utf8");
			captured += bytes;
			const previous = cursor;
			cursor = page.page.nextCursor;
			if (captured > maxOutputBytes) {
				await stopAndReap(port, handle, stopTimeoutMs);
				return { ok: false, code: "output_oversize", message: `governed git output exceeded ${maxOutputBytes} bytes`, exitCode: null };
			}
			if (page.page.truncated && previous.sequence !== cursor.sequence) continue;
			const waited = await port.processWait(handle, Math.min(timeoutMs, MAX_WAIT_MS), "driver");
			if (!waited.ok) return { ok: false, code: "wait_failed", message: `governed git wait failed: ${waited.code}`, exitCode: null };
			if (waited.outcome === "terminal" || waited.outcome === "uncertain") {
				return { ok: true, code: "ok", message: "terminal", exitCode: waited.summary.terminal?.exitCode ?? null };
			}
		}
	} catch (error) {
		await stopAndReap(port, handle, stopTimeoutMs).catch(() => undefined);
		return { ok: false, code: "materialize_failed", message: error instanceof Error ? error.message : "governed git materialization failed", exitCode: null };
	}
}

async function stopAndReap(port: ManagedMaterializeProcess, handle: ExecutionHandleRef, stopTimeoutMs: number): Promise<void> {
	await port.stop(handle, "driver", "SIGTERM").catch(() => undefined);
	const first = await port.processWait(handle, stopTimeoutMs, "driver").catch(() => undefined);
	if (first?.ok === true && (first.outcome === "terminal" || first.outcome === "uncertain")) return;
	await port.stop(handle, "driver", "SIGKILL").catch(() => undefined);
	await port.processWait(handle, stopTimeoutMs, "driver").catch(() => undefined);
}
