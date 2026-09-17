/**
 * Extension host 子进程入口。
 *
 * 由 owner 通过既有 governed managed process 启动，argv 里只有一个 bootstrap
 * JSON。这个文件刻意不安装任何进程级错误处理器：扩展的裸 timer /
 * detached promise 抛错必须表现为 host 进程非零退出，由 owner 判定该
 * generation failed（D2）。
 *
 * 用法（owner 侧构造，不面向用户）:
 *   <runtime> <dist>/extensions/host/entry.js '<bootstrap-json>'
 */

import { pathToFileURL } from "node:url";
import { parseExtensionHostBootstrap } from "./bootstrap.ts";
import { runExtensionHost, type ExtensionFactory, type ExtensionHostDuplex } from "./runtime.ts";

function createStdioDuplex(): ExtensionHostDuplex {
	const handlers = new Set<(line: string) => void>();
	let pending = "";
	process.stdin.setEncoding("utf8");
	const flush = (): void => {
		while (true) {
			const newline = pending.indexOf("\n");
			if (newline < 0) return;
			const line = pending.slice(0, newline).replace(/\r$/u, "");
			pending = pending.slice(newline + 1);
			if (line.trim().length === 0) continue;
			for (const handler of handlers) handler(line);
		}
	};
	const endHandlers = new Set<() => void>();
	process.stdin.on("data", (chunk: string) => { pending += chunk; flush(); });
	process.stdin.on("end", () => {
		pending = "";
		for (const handler of [...endHandlers]) handler();
	});
	return {
		send: (line) => { process.stdout.write(`${line}\n`); },
		onLine: (handler) => { handlers.add(handler); return () => { handlers.delete(handler); }; },
		onEnd: (handler) => { endHandlers.add(handler); return () => { endHandlers.delete(handler); }; },
		close: () => {
			handlers.clear();
			endHandlers.clear();
			// 结束 stdin 让事件循环可以自然退出；残留的扩展 timer 由 owner 的
			// 停进程路径回收。
			try { process.stdin.pause(); } catch { /* stdin 可能已关闭 */ }
		},
	};
}

/**
 * 解析 entrypoint 导出的工厂。
 *
 * 这里必须使用动态 import：entrypoint 是安装后才确定的第三方模块，不存在
 * 顶层静态导入的可能。这也是 D12 要求独立 API 包的原因——扩展 import 的
 * 是 RunLedger 自有契约，而不是宿主内部模块。
 */
export function resolveExtensionFactory(module: unknown): ExtensionFactory | undefined {
	if (typeof module !== "object" || module === null) return undefined;
	const namespace = module as { readonly default?: unknown; readonly createExtension?: unknown };
	if (typeof namespace.default === "function") return namespace.default as ExtensionFactory;
	if (typeof namespace.createExtension === "function") return namespace.createExtension as ExtensionFactory;
	const nested = namespace.default as { readonly createExtension?: unknown } | undefined;
	if (nested !== undefined && typeof nested === "object" && nested !== null && typeof nested.createExtension === "function") {
		return nested.createExtension as ExtensionFactory;
	}
	return undefined;
}

async function main(): Promise<number> {
	const encoded = process.argv[2];
	if (typeof encoded !== "string" || encoded.length === 0) return 2;
	const parsed = parseExtensionHostBootstrap(encoded);
	if (!parsed.ok) return 2;
	let module: unknown;
	try {
		module = await import(pathToFileURL(parsed.bootstrap.entrypoint).href);
	} catch {
		return 3;
	}
	const factory = resolveExtensionFactory(module);
	if (factory === undefined) return 3;
	const result = await runExtensionHost({
		bootstrap: parsed.bootstrap,
		factory,
		duplex: createStdioDuplex(),
		pid: process.pid,
	});
	return result.exitCode;
}

/**
 * 只有作为进程入口被直接运行时才驱动协议；被测试 import 时不得有副作用。
 * `process.argv[1]` 在 dist 下指向 entry.js，与 `import.meta.url` 一致。
 */
function isProcessEntrypoint(): boolean {
	const invoked = process.argv[1];
	if (typeof invoked !== "string" || invoked.length === 0) return false;
	try {
		return import.meta.url === pathToFileURL(invoked).href;
	} catch {
		return false;
	}
}

if (isProcessEntrypoint()) {
	let exitCode = 2;
	try {
		exitCode = await main();
	} catch {
		exitCode = 4;
	}
	// stdout 是管道；先等排空再退出，否则 fatal error 帧可能被截断。
	await new Promise<void>((resolve) => { process.stdout.write("", () => resolve()); });
	process.exit(exitCode);
}
