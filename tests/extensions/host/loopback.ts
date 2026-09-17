/**
 * P1 host 测试用的内存通道。
 *
 * 它把真实的 `runExtensionHost` 与真实的 `connectExtensionHost` 直接对接，
 * 只替换“字节如何跨进程”这一层：协议编解码、注册表校验、握手与失败语义
 * 全部走生产代码路径。它**不是**生产闭环证据——进程创建/回收与真实
 * TTY 闭环由 P7 的真实 `runledger` smoke 覆盖。
 */

import { runtimeDigest } from "../../../src/runtime/protocol/foundation.ts";
import type { ExecutionHandleRef } from "../../../src/runtime/process/types.ts";
import type { ControlPlaneMutationResult } from "../../../src/storage/process/control-plane.ts";
import type { ExtensionHostChannel, ExtensionHostChannelRead } from "../../../src/extensions/host/channel.ts";
import type { ExtensionHostDuplex } from "../../../src/extensions/host/runtime.ts";

export function fakeHandle(executionId = "execution-extension-host"): ExecutionHandleRef {
	return {
		authorityId: "authority_test" as ExecutionHandleRef["authorityId"],
		tenantId: "tenant_test" as ExecutionHandleRef["tenantId"],
		workspaceId: "workspace_test" as ExecutionHandleRef["workspaceId"],
		sessionId: "session_test" as ExecutionHandleRef["sessionId"],
		hostGeneration: 1,
		sessionGeneration: 1,
		executionId: executionId as ExecutionHandleRef["executionId"],
		attemptId: "attempt_test" as ExecutionHandleRef["attemptId"],
		revision: 1,
		requestDigest: runtimeDigest("extension-host-test"),
	};
}

interface Loopback {
	readonly channel: ExtensionHostChannel;
	readonly hostDuplex: ExtensionHostDuplex;
	/** 模拟 host 进程退出。 */
	exit(exitCode?: number): void;
	readonly writtenToHost: readonly string[];
	readonly observedStops: readonly string[];
}

export function createLoopback(): Loopback {
	const toOwner: string[] = [];
	const toHost: string[] = [];
	const hostHandlers = new Set<(line: string) => void>();
	const waiters: Array<() => void> = [];
	const writtenToHost: string[] = [];
	const observedStops: string[] = [];
	let exited = false;
	let exitCode: number | null = null;
	let closed = false;

	const wake = (): void => {
		const pending = [...waiters];
		waiters.length = 0;
		for (const resolve of pending) resolve();
	};

	const channel: ExtensionHostChannel = {
		handle: fakeHandle(),
		write: async (line): Promise<ControlPlaneMutationResult> => {
			writtenToHost.push(line);
			toHost.push(line);
			for (const handler of [...hostHandlers]) handler(line);
			return {
				ok: true,
				operation: "write",
				receiptDigest: runtimeDigest(line),
				summary: {
					handle: fakeHandle(),
					state: "running",
					outputCursor: { sequence: 0, byteOffset: 0 },
					outputSize: 0,
					capabilities: { canWrite: true, canEof: true, canResize: false, canStop: true, canReadOutput: true },
				},
			};
		},
		read: async (timeoutMs: number): Promise<ExtensionHostChannelRead> => {
			if (toOwner.length === 0 && !exited) {
				await new Promise<void>((resolve) => {
					const timer = setTimeout(resolve, Math.max(1, Math.min(timeoutMs, 20)));
					timer.unref();
					waiters.push(() => { clearTimeout(timer); resolve(); });
				});
			}
			if (closed) return { ok: true, lines: [], closed: true, exitCode: exitCode ?? null, state: "killed" };
			if (toOwner.length > 0) {
				const lines = [...toOwner];
				toOwner.length = 0;
				return { ok: true, lines, closed: false };
			}
			if (exited) return { ok: true, lines: [], closed: true, exitCode: exitCode ?? null, state: exitCode === 0 ? "completed" : "failed" };
			return { ok: true, lines: [], closed: false };
		},
		close: async () => {
			if (closed) return;
			closed = true;
			observedStops.push("close");
			exited = true;
			exitCode ??= 0;
			wake();
		},
	};

	const endHandlers = new Set<() => void>();
	const hostDuplex: ExtensionHostDuplex = {
		send: (line) => { toOwner.push(line); wake(); },
		onLine: (handler) => { hostHandlers.add(handler); return () => { hostHandlers.delete(handler); }; },
		// 内存通道里 EOF 由显式的 exit() 模拟，避免和 close() 语义重复。
		onEnd: (handler) => { endHandlers.add(handler); return () => { endHandlers.delete(handler); }; },
		close: () => { /* host 侧 close 只表示不再发送；退出由 exit() 显式模拟。 */ },
	};

	return {
		channel,
		hostDuplex,
		exit: (code = 1) => { exited = true; exitCode = code; wake(); },
		get writtenToHost() { return writtenToHost; },
		get observedStops() { return observedStops; },
	};
}

/** 等待到断言成立或超时；避免用固定 sleep 掩盖竞态。 */
export async function waitFor(predicate: () => boolean, timeoutMs = 2_000, stepMs = 5): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise<void>((resolve) => { setTimeout(resolve, stepMs); });
	}
	throw new Error("waitFor timed out");
}
