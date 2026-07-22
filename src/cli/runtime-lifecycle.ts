/** CLI/TUI 进程终止源到 Runtime bounded shutdown 的唯一宿主。 */

import type {
	RuntimeDrainParticipant,
	RuntimeShutdownReceipt,
	RuntimeShutdownTrigger,
} from "../runtime/lifecycle/shutdown.ts";
import {
	RuntimeShutdownCoordinator,
	createRuntimeTerminalErrorTrigger,
	createRuntimeUnhandledErrorTrigger,
} from "../runtime/lifecycle/shutdown.ts";
import type {
	AuthorityId,
	RuntimeInstanceId,
	TenantId,
} from "../runtime/protocol/v3/ids.ts";
import type { LifecycleResult } from "../runtime/lifecycle/recovery.ts";

export type CliProcessSignal = "SIGINT" | "SIGTERM" | "SIGHUP";

export interface CliLifecycleEventSource {
	addSignalListener(signal: CliProcessSignal, listener: () => void): void;
	removeSignalListener(signal: CliProcessSignal, listener: () => void): void;
	addStdinEndListener(listener: () => void): void;
	removeStdinEndListener(listener: () => void): void;
	stdinEnded(): boolean;
	addUncaughtExceptionListener(listener: (error: unknown) => void): void;
	removeUncaughtExceptionListener(listener: (error: unknown) => void): void;
	addUnhandledRejectionListener(listener: (reason: unknown) => void): void;
	removeUnhandledRejectionListener(listener: (reason: unknown) => void): void;
}

export interface CliInteractiveShutdownPort {
	readonly inFlight: boolean;
	interrupt(): void;
	waitForIdle(): Promise<void>;
	dispose(): void;
}

export interface CliSurfaceShutdownPort {
	quit(): void;
}

export interface CliRuntimeLifecycleOptions {
	scope: {
		authorityId: AuthorityId;
		tenantId: TenantId;
		runtimeId: RuntimeInstanceId;
	};
	controller: CliInteractiveShutdownPort;
	surface: CliSurfaceShutdownPort;
	writer: { close(): Promise<void> };
	extension?: { close(): Promise<void> };
	children?: { close(signal: AbortSignal): Promise<void> };
	exporter?: { close(signal: AbortSignal): Promise<void> };
	events?: CliLifecycleEventSource;
	timeoutMs?: number;
	onFatal?: (kind: "uncaught_exception" | "unhandled_rejection") => void;
}

export interface InstalledCliRuntimeLifecycle {
	readonly coordinator: RuntimeShutdownCoordinator;
	request(trigger: RuntimeShutdownTrigger): Promise<LifecycleResult<RuntimeShutdownReceipt>>;
	terminalError(error: unknown, source?: "terminal" | "input" | "output"): Promise<LifecycleResult<RuntimeShutdownReceipt>>;
	pending(): Promise<LifecycleResult<RuntimeShutdownReceipt>> | undefined;
	dispose(): void;
}

const NODE_CLI_LIFECYCLE_EVENTS: CliLifecycleEventSource = {
	addSignalListener: (signal, listener) => { process.on(signal, listener); },
	removeSignalListener: (signal, listener) => { process.off(signal, listener); },
	addStdinEndListener: (listener) => { process.stdin.once("end", listener); },
	removeStdinEndListener: (listener) => { process.stdin.off("end", listener); },
	stdinEnded: () => process.stdin.readableEnded,
	addUncaughtExceptionListener: (listener) => { process.on("uncaughtException", listener); },
	removeUncaughtExceptionListener: (listener) => { process.off("uncaughtException", listener); },
	addUnhandledRejectionListener: (listener) => { process.on("unhandledRejection", listener); },
	removeUnhandledRejectionListener: (listener) => { process.off("unhandledRejection", listener); },
};

function registerOrThrow(
	coordinator: RuntimeShutdownCoordinator,
	participant: RuntimeDrainParticipant,
): void {
	const registered = coordinator.register(participant);
	if (!registered.ok) throw new Error(`CLI shutdown participant registration failed: ${participant.id}`);
}

/**
 * 所有 listener 都只同步关闭 mutation gate、发出 interrupt 并退出 TUI；真正 drain
 * 由同一个 coordinator 串行完成。listener 不调用 process.exit，也不吞掉 receipt。
 */
export function installCliRuntimeLifecycle(
	options: CliRuntimeLifecycleOptions,
): InstalledCliRuntimeLifecycle {
	const events = options.events ?? NODE_CLI_LIFECYCLE_EVENTS;
	const timeoutMs = Math.max(1, Math.min(300_000, Math.trunc(options.timeoutMs ?? 30_000)));
	const coordinator = new RuntimeShutdownCoordinator(options.scope);
	registerOrThrow(coordinator, {
		id: "interactive-controller",
		kind: "tool",
		drain: async () => {
			if (options.controller.inFlight) options.controller.interrupt();
			await options.controller.waitForIdle();
			options.controller.dispose();
		},
	});
	if (options.extension) {
		registerOrThrow(coordinator, {
			id: "extension-runtime",
			kind: "tool",
			drain: async () => options.extension?.close(),
		});
	}
	if (options.children) {
		registerOrThrow(coordinator, {
			id: "child-runtime",
			kind: "child",
			drain: (signal) => options.children?.close(signal) ?? Promise.resolve(),
		});
	}
	registerOrThrow(coordinator, {
		id: "session-writer",
		kind: "writer",
		drain: async () => options.writer.close(),
	});
	if (options.exporter) {
		registerOrThrow(coordinator, {
			id: "telemetry-exporter",
			kind: "exporter",
			drain: (signal) => options.exporter?.close(signal) ?? Promise.resolve(),
		});
	}

	let shutdown: Promise<LifecycleResult<RuntimeShutdownReceipt>> | undefined;
	const request = (trigger: RuntimeShutdownTrigger): Promise<LifecycleResult<RuntimeShutdownReceipt>> => {
		if (!shutdown) {
			// shutdown() 在返回 Promise 前同步把 coordinator 切到 draining。
			shutdown = coordinator.shutdown(trigger, timeoutMs);
			if (options.controller.inFlight) options.controller.interrupt();
			options.surface.quit();
		}
		return shutdown;
	};
	const onSigint = (): void => { void request({ kind: "signal", signal: "SIGINT" }); };
	const onSigterm = (): void => { void request({ kind: "signal", signal: "SIGTERM" }); };
	const onSighup = (): void => { void request({ kind: "signal", signal: "SIGHUP" }); };
	const onStdinEnd = (): void => { void request({ kind: "stdin_eof" }); };
	const onUncaughtException = (error: unknown): void => {
		options.onFatal?.("uncaught_exception");
		void request(createRuntimeUnhandledErrorTrigger("uncaught_exception", error));
	};
	const onUnhandledRejection = (reason: unknown): void => {
		options.onFatal?.("unhandled_rejection");
		void request(createRuntimeUnhandledErrorTrigger("unhandled_rejection", reason));
	};

	events.addSignalListener("SIGINT", onSigint);
	events.addSignalListener("SIGTERM", onSigterm);
	events.addSignalListener("SIGHUP", onSighup);
	events.addStdinEndListener(onStdinEnd);
	events.addUncaughtExceptionListener(onUncaughtException);
	events.addUnhandledRejectionListener(onUnhandledRejection);
	if (events.stdinEnded()) queueMicrotask(onStdinEnd);

	let disposed = false;
	return {
		coordinator,
		request,
		terminalError: (error, source = "terminal") => request(createRuntimeTerminalErrorTrigger(error, source)),
		pending: () => shutdown,
		dispose: () => {
			if (disposed) return;
			disposed = true;
			events.removeSignalListener("SIGINT", onSigint);
			events.removeSignalListener("SIGTERM", onSigterm);
			events.removeSignalListener("SIGHUP", onSighup);
			events.removeStdinEndListener(onStdinEnd);
			events.removeUncaughtExceptionListener(onUncaughtException);
			events.removeUnhandledRejectionListener(onUnhandledRejection);
		},
	};
}
