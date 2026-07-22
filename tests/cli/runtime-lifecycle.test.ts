import { describe, expect, it } from "vitest";
import { installCliRuntimeLifecycle, type CliLifecycleEventSource, type CliProcessSignal } from "../../src/cli/runtime-lifecycle.ts";
import { createRuntimeId } from "../../src/runtime/protocol/v3/ids.ts";

class FakeLifecycleEvents implements CliLifecycleEventSource {
	readonly #signals = new Map<CliProcessSignal, Set<() => void>>();
	readonly #stdin = new Set<() => void>();
	readonly #uncaught = new Set<(error: unknown) => void>();
	readonly #rejections = new Set<(reason: unknown) => void>();
	ended = false;

	public addSignalListener(signal: CliProcessSignal, listener: () => void): void {
		const listeners = this.#signals.get(signal) ?? new Set<() => void>();
		listeners.add(listener);
		this.#signals.set(signal, listeners);
	}
	public removeSignalListener(signal: CliProcessSignal, listener: () => void): void { this.#signals.get(signal)?.delete(listener); }
	public addStdinEndListener(listener: () => void): void { this.#stdin.add(listener); }
	public removeStdinEndListener(listener: () => void): void { this.#stdin.delete(listener); }
	public stdinEnded(): boolean { return this.ended; }
	public addUncaughtExceptionListener(listener: (error: unknown) => void): void { this.#uncaught.add(listener); }
	public removeUncaughtExceptionListener(listener: (error: unknown) => void): void { this.#uncaught.delete(listener); }
	public addUnhandledRejectionListener(listener: (reason: unknown) => void): void { this.#rejections.add(listener); }
	public removeUnhandledRejectionListener(listener: (reason: unknown) => void): void { this.#rejections.delete(listener); }
	public emitSignal(signal: CliProcessSignal): void { for (const listener of this.#signals.get(signal) ?? []) listener(); }
	public emitStdinEnd(): void { for (const listener of this.#stdin) listener(); }
	public emitUncaught(error: unknown): void { for (const listener of this.#uncaught) listener(error); }
	public emitRejection(error: unknown): void { for (const listener of this.#rejections) listener(error); }
	public count(): number {
		return [...this.#signals.values()].reduce((total, value) => total + value.size, 0) +
			this.#stdin.size + this.#uncaught.size + this.#rejections.size;
	}
}

function scope() {
	return {
		authorityId: createRuntimeId("authority", "cli-lifecycle"),
		tenantId: createRuntimeId("tenant", "cli-lifecycle"),
		runtimeId: createRuntimeId("runtime", "cli-lifecycle"),
	};
}

describe("CLI Runtime lifecycle host", () => {
	it.each(["SIGINT", "SIGTERM", "SIGHUP"] as const)("closes the gate synchronously and drains in order for %s", async (signal) => {
		const events = new FakeLifecycleEvents();
		const order: string[] = [];
		let inFlight = true;
		const installed = installCliRuntimeLifecycle({
			scope: scope(),
			events,
			controller: {
				get inFlight() { return inFlight; },
				interrupt: () => { order.push("interrupt"); inFlight = false; },
				waitForIdle: async () => { order.push("tool"); },
				dispose: () => { order.push("dispose"); },
			},
			surface: { quit: () => { order.push("quit"); } },
			extension: { close: async () => { order.push("extension"); } },
			children: { close: async () => { order.push("child"); } },
			writer: { close: async () => { order.push("writer"); } },
			exporter: { close: async () => { order.push("exporter"); } },
		});
		events.emitSignal(signal);
		expect(installed.coordinator.acceptsMutations()).toBe(false);
		const receipt = await installed.pending();
		expect(receipt).toMatchObject({ ok: true, value: { trigger: { kind: "signal", signal }, recoveryRequired: false } });
		expect(order.slice(0, 2)).toEqual(["interrupt", "quit"]);
		expect(order.indexOf("writer")).toBeGreaterThan(order.indexOf("tool"));
		expect(order.indexOf("writer")).toBeGreaterThan(order.indexOf("extension"));
		expect(order.indexOf("writer")).toBeGreaterThan(order.indexOf("child"));
		expect(order.indexOf("exporter")).toBeGreaterThan(order.indexOf("writer"));
		installed.dispose();
		expect(events.count()).toBe(0);
	});

	it("routes EOF, terminal errors and fatal process events through one idempotent receipt", async () => {
		for (const emit of [
			(events: FakeLifecycleEvents) => events.emitStdinEnd(),
			(events: FakeLifecycleEvents) => events.emitUncaught(new Error("fatal")),
			(events: FakeLifecycleEvents) => events.emitRejection(new Error("rejected")),
		] as const) {
			const events = new FakeLifecycleEvents();
			let closes = 0;
			const installed = installCliRuntimeLifecycle({
				scope: scope(),
				events,
				controller: { inFlight: false, interrupt: () => undefined, waitForIdle: async () => undefined, dispose: () => undefined },
				surface: { quit: () => undefined },
				writer: { close: async () => { closes += 1; } },
			});
			emit(events);
			await installed.pending();
			expect(closes).toBe(1);
			expect(installed.request({ kind: "stdin_eof" })).toBe(installed.pending());
			installed.dispose();
		}

		const events = new FakeLifecycleEvents();
		const installed = installCliRuntimeLifecycle({
			scope: scope(),
			events,
			controller: { inFlight: false, interrupt: () => undefined, waitForIdle: async () => undefined, dispose: () => undefined },
			surface: { quit: () => undefined },
			writer: { close: async () => undefined },
		});
		await expect(installed.terminalError(new Error("terminal"), "output")).resolves.toMatchObject({
			ok: true,
			value: { trigger: { kind: "terminal_error", source: "output" } },
		});
		installed.dispose();
	});
});
