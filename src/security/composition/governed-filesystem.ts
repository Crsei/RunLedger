/**
 * S2 拆分:governed filesystem leaf —— 授权完成后才触碰 broker 最终 I/O。
 *
 * 每个操作先经 `authorize` 取得 gateway context(attempt 已开始),effect
 * 通过 broker port 执行,最后 `settleGatewayEffect` 结算 attempt;effect
 * 失败同样结算后重抛。
 */

import type { FileSystem } from "../../runtime/execution-env.ts";
import { digestOf } from "../sandbox/common.ts";
import { settleGatewayEffect, unwrapSecurityResult } from "./audit-settlement.ts";
import type { createAuthorizer } from "./permission-requester.ts";

export function createGovernedFileSystem(
	authorize: ReturnType<typeof createAuthorizer>,
	cwd: string,
): FileSystem {
	return {
		readFile: async (path) => {
			const context = await authorize("read", [{ kind: "filesystem", operation: "read", path }], { path }, cwd);
			return settleGatewayEffect(context, async () => unwrapSecurityResult(await context.fs.readFile(path)));
		},
		writeFile: async (path, data) => {
			const context = await authorize("write", [{ kind: "filesystem", operation: "write", path }], { path, dataDigest: digestOf(data) }, cwd);
			return settleGatewayEffect(context, async () => unwrapSecurityResult(await context.fs.writeFile(path, data)));
		},
		stat: async (path) => {
			const context = await authorize("stat", [{ kind: "filesystem", operation: "read", path }], { path }, cwd);
			const value = await settleGatewayEffect(context, async () => unwrapSecurityResult(await context.fs.stat(path)));
			return { size: value.size, mtimeMs: value.mtimeMs, isFile: value.isFile, isDirectory: value.isDirectory, isSymbolicLink: value.isSymbolicLink };
		},
		readdir: async (path) => {
			const context = await authorize("readdir", [{ kind: "filesystem", operation: "read", path }], { path }, cwd);
			return [...await settleGatewayEffect(context, async () => unwrapSecurityResult(await context.fs.readdir(path)))];
		},
		mkdir: async (path, opts) => {
			const context = await authorize("mkdir", [{ kind: "filesystem", operation: "write", path }], { path, opts: opts ?? {} }, cwd);
			return settleGatewayEffect(context, async () => unwrapSecurityResult(await context.fs.mkdir(path, opts)));
		},
		rm: async (path, opts) => {
			const context = await authorize("rm", [{ kind: "filesystem", operation: "delete", path }], { path, opts: opts ?? {} }, cwd);
			return settleGatewayEffect(context, async () => unwrapSecurityResult(await context.fs.rm(path, opts)));
		},
		rename: async (from, to) => {
			const context = await authorize("rename", [
				{ kind: "filesystem", operation: "delete", path: from },
				{ kind: "filesystem", operation: "write", path: to },
			], { from, to }, cwd);
			return settleGatewayEffect(context, async () => unwrapSecurityResult(await context.fs.rename(from, to)));
		},
	};
}
