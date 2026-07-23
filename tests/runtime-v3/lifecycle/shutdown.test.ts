import { describe, expect, it } from "vitest";
import { createRuntimeId } from "../../../src/runtime/protocol/v3/ids.ts";
import { RuntimeShutdownCoordinator, RuntimeShutdownTriggerAdapter } from "../../../src/runtime/lifecycle/shutdown.ts";

function coordinator() {
	return new RuntimeShutdownCoordinator({
		authorityId: createRuntimeId("authority", "shutdown"), tenantId: createRuntimeId("tenant", "shutdown"), runtimeId: createRuntimeId("runtime", "shutdown"),
	}, () => new Date("2026-07-22T00:00:00.000Z"));
}

describe("bounded graceful shutdown", () => {
	it("closes mutation gate synchronously and drains side effects before writer/exporter", async () => {
		const runtime = coordinator();
		const order: string[] = [];
		for (const [id, kind] of [["tool", "tool"], ["child", "child"], ["writer", "writer"], ["exporter", "exporter"]] as const) {
			expect(runtime.register({ id, kind, drain: async () => { order.push(id); } }).ok).toBe(true);
		}
		const shutdown = runtime.shutdown({ kind: "signal", signal: "SIGTERM" }, 100);
		expect(runtime.acceptsMutations()).toBe(false);
		const receipt = await shutdown;
		expect(receipt).toMatchObject({ ok: true, value: { recoveryRequired: false, trigger: { kind: "signal" } } });
		expect(order.indexOf("writer")).toBeGreaterThan(order.indexOf("tool"));
		expect(order.indexOf("exporter")).toBeGreaterThan(order.indexOf("writer"));
		expect(runtime.state()).toBe("closed");
	});

	it("returns a recovery-required receipt at the global deadline when a participant hangs", async () => {
		const runtime = coordinator();
		runtime.register({ id: "hung-tool", kind: "tool", drain: async () => new Promise<void>(() => undefined) });
		const receipt = await runtime.shutdown({ kind: "stdin_eof" }, 5);
		expect(receipt).toMatchObject({ ok: true, value: { recoveryRequired: true, outcomes: [{ id: "hung-tool", status: "timed_out" }] } });
	});

	it("normalizes signal, EOF, terminal/input/output errors, process failures and daemon upgrade triggers", async () => {
		const actions = [
			(adapter: RuntimeShutdownTriggerAdapter) => adapter.signal("SIGINT"),
			(adapter: RuntimeShutdownTriggerAdapter) => adapter.stdinEof(),
			(adapter: RuntimeShutdownTriggerAdapter) => adapter.terminalError(new Error("terminal detail")),
			(adapter: RuntimeShutdownTriggerAdapter) => adapter.inputError(new Error("input detail")),
			(adapter: RuntimeShutdownTriggerAdapter) => adapter.outputError(new Error("output detail")),
			(adapter: RuntimeShutdownTriggerAdapter) => adapter.uncaughtException(new Error("exception detail")),
			(adapter: RuntimeShutdownTriggerAdapter) => adapter.unhandledRejection(new Error("rejection detail")),
			(adapter: RuntimeShutdownTriggerAdapter) => adapter.daemonUpgrade("2.0.0"),
		];
		const triggers: Array<{ kind: string; source?: string }> = [];
		for (const action of actions) {
			const receipt = await action(new RuntimeShutdownTriggerAdapter(coordinator(), 100));
			if (receipt.ok) triggers.push(receipt.value.trigger);
		}
		expect(triggers.map((trigger) => trigger.kind)).toEqual([
			"signal",
			"stdin_eof",
			"terminal_error",
			"terminal_error",
			"terminal_error",
			"uncaught_exception",
			"unhandled_rejection",
			"daemon_upgrade",
		]);
		expect(triggers.slice(2, 5).map((trigger) => trigger.source)).toEqual(["terminal", "input", "output"]);
	});
});
