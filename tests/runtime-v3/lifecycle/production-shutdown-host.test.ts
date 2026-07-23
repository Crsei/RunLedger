import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import type { HeadlessDaemonServer } from "../../../src/daemon/server.ts";
import {
	installDaemonLifecycleListeners,
	type DaemonLifecycleEventSource,
	type DaemonProcessSignal,
} from "../../../src/daemon/stdio-cli.ts";
import { createStdioParentPeerEvidence, runStdioControlPlaneHost } from "../../../src/daemon/stdio-host.ts";
import { ShutdownCoordinator } from "../../../src/runtime/control-plane/shutdown.ts";
import { createRuntimeTerminalErrorTrigger } from "../../../src/runtime/lifecycle/shutdown.ts";

class FakeLifecycleEvents implements DaemonLifecycleEventSource {
	readonly #signals = new Map<DaemonProcessSignal, Set<() => void>>();
	readonly #uncaught = new Set<(error: unknown) => void>();
	readonly #rejections = new Set<(reason: unknown) => void>();

	public addSignalListener(signal: DaemonProcessSignal, listener: () => void): void {
		const listeners = this.#signals.get(signal) ?? new Set<() => void>();
		listeners.add(listener);
		this.#signals.set(signal, listeners);
	}

	public removeSignalListener(signal: DaemonProcessSignal, listener: () => void): void {
		this.#signals.get(signal)?.delete(listener);
	}

	public addUncaughtExceptionListener(listener: (error: unknown) => void): void {
		this.#uncaught.add(listener);
	}

	public removeUncaughtExceptionListener(listener: (error: unknown) => void): void {
		this.#uncaught.delete(listener);
	}

	public addUnhandledRejectionListener(listener: (reason: unknown) => void): void {
		this.#rejections.add(listener);
	}

	public removeUnhandledRejectionListener(listener: (reason: unknown) => void): void {
		this.#rejections.delete(listener);
	}

	public emitSignal(signal: DaemonProcessSignal): void {
		for (const listener of this.#signals.get(signal) ?? []) listener();
	}

	public emitUncaught(error: unknown): void {
		for (const listener of this.#uncaught) listener(error);
	}

	public emitRejection(reason: unknown): void {
		for (const listener of this.#rejections) listener(reason);
	}

	public listenerCount(): number {
		return [...this.#signals.values()].reduce((total, listeners) => total + listeners.size, 0) +
			this.#uncaught.size + this.#rejections.size;
	}
}

function unusedServer(): HeadlessDaemonServer {
	return {
		createDispatcher: () => ({ dispatch: async () => { throw new Error("no protocol frame expected"); } }),
		closeConnection: () => undefined,
	} as unknown as HeadlessDaemonServer;
}

function capture(output: PassThrough): { readonly chunks: string[] } {
	const chunks: string[] = [];
	output.setEncoding("utf8");
	output.on("data", (chunk: string) => chunks.push(chunk));
	return { chunks };
}

async function startHost(controller?: AbortController, timeoutMs = 100) {
	const input = new PassThrough();
	const output = new PassThrough();
	const captured = capture(output);
	const shutdown = new ShutdownCoordinator(() => new Date("2026-07-22T00:00:00.000Z"));
	const running = runStdioControlPlaneHost({
		server: unusedServer(),
		shutdown,
		input,
		output,
		evidence: createStdioParentPeerEvidence(),
		shutdownTimeoutMs: timeoutMs,
		...(controller ? { signal: controller.signal } : {}),
	});
	return { input, output, captured, shutdown, running };
}

describe("production stdio shutdown host", () => {
	it.each([
		["SIGINT", "sigint", "signal"],
		["SIGTERM", "sigterm", "signal"],
		["SIGHUP", "daemon_upgrade", "daemon_upgrade"],
	] as const)("closes the mutation gate synchronously for %s and removes listeners", async (signal, reason, kind) => {
		const controller = new AbortController();
		const source = new FakeLifecycleEvents();
		const listeners = installDaemonLifecycleListeners(controller, source, "2.0.0");
		const host = await startHost(controller);

		source.emitSignal(signal);
		expect(host.shutdown.acceptsMutations()).toBe(false);
		await expect(host.running).resolves.toMatchObject({
			reason,
			trigger: { kind },
			shutdown: { recoveryRequired: false },
		});
		expect(host.captured.chunks.join("")).toBe("");
		listeners.dispose();
		listeners.dispose();
		expect(source.listenerCount()).toBe(0);
	});

	it.each([
		["uncaught_exception", (source: FakeLifecycleEvents) => source.emitUncaught(new Error("fatal"))],
		["unhandled_rejection", (source: FakeLifecycleEvents) => source.emitRejection(new Error("rejected"))],
	] as const)("routes %s through the same bounded drain without forcing process exit", async (reason, emit) => {
		const controller = new AbortController();
		const source = new FakeLifecycleEvents();
		const listeners = installDaemonLifecycleListeners(controller, source);
		const host = await startHost(controller);

		emit(source);
		expect(host.shutdown.acceptsMutations()).toBe(false);
		await expect(host.running).resolves.toMatchObject({ reason, trigger: { kind: reason } });
		expect(host.captured.chunks.join("")).toBe("");
		listeners.dispose();
		expect(source.listenerCount()).toBe(0);
	});

	it("routes stdin EOF and terminal/input/output errors through the same gate", async () => {
		const eof = await startHost();
		eof.input.end();
		await expect(eof.running).resolves.toMatchObject({
			reason: "stdin_eof",
			trigger: { kind: "stdin_eof" },
		});
		expect(eof.shutdown.acceptsMutations()).toBe(false);

		const inputFailure = await startHost();
		inputFailure.input.emit("error", new Error("input failed"));
		expect(inputFailure.shutdown.acceptsMutations()).toBe(false);
		await expect(inputFailure.running).resolves.toMatchObject({
			reason: "input_error",
			trigger: { kind: "terminal_error", source: "input" },
		});

		const outputFailure = await startHost();
		outputFailure.output.emit("error", new Error("output failed"));
		expect(outputFailure.shutdown.acceptsMutations()).toBe(false);
		await expect(outputFailure.running).resolves.toMatchObject({
			reason: "output_error",
			trigger: { kind: "terminal_error", source: "output" },
		});

		const controller = new AbortController();
		const terminal = await startHost(controller);
		controller.abort(createRuntimeTerminalErrorTrigger(new Error("terminal failed")));
		expect(terminal.shutdown.acceptsMutations()).toBe(false);
		await expect(terminal.running).resolves.toMatchObject({
			reason: "terminal_error",
			trigger: { kind: "terminal_error", source: "terminal" },
		});
	});

	it("returns recovery-required when a shutdown participant misses the shared deadline", async () => {
		const controller = new AbortController();
		const host = await startHost(controller, 5);
		expect(host.shutdown.register({
			id: "hung-writer",
			kind: "writer",
			drain: async () => new Promise<void>(() => undefined),
		}).ok).toBe(true);

		controller.abort({ kind: "signal", signal: "SIGTERM" });
		await expect(host.running).resolves.toMatchObject({
			reason: "sigterm",
			shutdown: {
				recoveryRequired: true,
				outcomes: [{ id: "hung-writer", status: "timed_out" }],
			},
		});
	});
});
