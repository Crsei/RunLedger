import { describe, expect, it } from "vitest";
import { runExtensionHost } from "../../src/extensions/host/runtime.ts";
import { connectExtensionHost } from "../../src/extensions/host/client.ts";
import { createSessionExtensionHostPort } from "../../src/runtime/session-runtime/extension-composition.ts";
import type { DistributionHostSelection } from "../../src/extensions/plugins/host-activation.ts";
import { EXTENSION_DEFAULT_HOST_LIMITS } from "../../src/contracts/extensions/registry.ts";
import type { ExtensionHostBootstrap } from "../../src/extensions/host/bootstrap.ts";
import { createLoopback } from "./host/loopback.ts";

const bootstrap: ExtensionHostBootstrap = {
	packageId: "sample-plugin@local",
	digest: "d".repeat(64),
	generation: 3,
	apiVersion: "1.0.0",
	limits: EXTENSION_DEFAULT_HOST_LIMITS,
	rootPath: "/tmp/runledger-ext-host",
	entrypoint: "/tmp/runledger-ext-host/entry.ts",
};

describe("extension tool invocation", () => {
	it("invokes a handler that lives only in the host process", async () => {
		const loopback = createLoopback();
		void runExtensionHost({
			bootstrap,
			factory: (api) => {
				api.registerTool({
					name: "fixture_echo",
					description: "echoes",
					parameters: { type: "object", properties: { value: { type: "string" } } },
					approvalClass: "read-only",
					handler: (input) => ({ echoed: input.args, toolCallId: input.toolCallId }),
				});
			},
			duplex: loopback.hostDuplex,
			pid: 4_242,
		});
		const result = await connectExtensionHost({ channel: loopback.channel, bootstrap, onAction: async () => ({ ok: true }) });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const outcome = await result.client.requestEvent({
			name: "tool:fixture_echo",
			cancelable: false,
			payload: { toolCallId: "call-1", args: { value: "hi" } },
			deadlineMs: 1_000,
		});
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(outcome.value).toMatchObject({ handlers: [{ index: 0, outcome: "result", result: { echoed: { value: "hi" }, toolCallId: "call-1" } }] });
		await result.client.close("owner-request");
	});

	it("fails a call for a tool the host never registered", async () => {
		const loopback = createLoopback();
		void runExtensionHost({ bootstrap, factory: () => undefined, duplex: loopback.hostDuplex, pid: 1 });
		const result = await connectExtensionHost({ channel: loopback.channel, bootstrap, onAction: async () => ({ ok: true }) });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const outcome = await result.client.requestEvent({ name: "tool:ghost", cancelable: false, payload: { args: {} }, deadlineMs: 500 });
		expect(outcome.ok).toBe(false);
		if (!outcome.ok) expect(outcome.code).toBe("tool_not_registered");
		await result.client.close("owner-request");
	});

	it("reports a handler that throws as a tool failure without killing the host", async () => {
		const loopback = createLoopback();
		void runExtensionHost({
			bootstrap,
			factory: (api) => {
				api.registerTool({ name: "boom", description: "boom", parameters: {}, approvalClass: "read-only", handler: () => { throw new Error("kaboom"); } });
			},
			duplex: loopback.hostDuplex,
			pid: 2,
		});
		const result = await connectExtensionHost({ channel: loopback.channel, bootstrap, onAction: async () => ({ ok: true }) });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const outcome = await result.client.requestEvent({ name: "tool:boom", cancelable: false, payload: { args: {} }, deadlineMs: 500 });
		expect(outcome.ok).toBe(false);
		if (!outcome.ok) expect(outcome.code).toBe("tool_failed");
		expect(result.client.state().status).toBe("ready");
		await result.client.close("owner-request");
	});
});

describe("session extension host port", () => {
	/** ready 里是 **gate**（含 candidate），不是裸 candidate。 */
	function selection(candidates: readonly unknown[]): () => Promise<DistributionHostSelection> {
		const gates = candidates.map((candidate) => ({ ok: true as const, candidate: candidate as never, identity: {} as never, receiptId: "receipt-1" }));
		return async () => ({ candidates: candidates as never, ready: gates, gates, diagnostics: [] });
	}

	function candidate(packageId: string, scope: "user" | "project", declaredTools: readonly string[] = ["tool_a"]) {
		return {
			packageId,
			name: packageId.split("@")[0] ?? packageId,
			version: "1.0.0",
			digest: "a".repeat(64),
			installPath: `/tmp/${packageId}`,
			scope,
			enabled: true,
			entrypoints: ["./src/index.ts"],
			declaredTools,
		};
	}

	const snapshot = (tools: readonly { readonly name: string }[]) => ({
		generation: 3,
		hostPid: 10,
		packageId: "sample@local",
		digest: "a".repeat(64),
		tools: tools.map((tool) => ({ name: tool.name, description: "d", parameters: { type: "object" }, approvalClass: "read-only" as const })),
		commands: [],
		flags: [],
		subscriptions: [],
		limits: EXTENSION_DEFAULT_HOST_LIMITS,
	});

	it("admits only declared tools and exposes them after start", async () => {
		const audits: string[] = [];
		const port = createSessionExtensionHostPort({
			selection: selection([candidate("sample@local", "user", ["tool_a"])]),
			runtime: {
				start: async () => ({ ok: true, snapshot: snapshot([{ name: "tool_a" }, { name: "tool_undeclared" }]) }),
				shutdown: async () => undefined,
				dispatch: async () => ({ ok: true, value: null }),
				subscribersFor: () => ["sample@local"],
			},
			reservedNames: () => ["read", "bash"],
			invoke: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
			audit: async (event) => { audits.push(event.eventType); },
		});
		expect(port.tools()).toEqual([]);
		const started = await port.start();
		expect(started.ok).toBe(true);
		if (started.ok) expect(started.tools.map((tool) => tool.name)).toEqual(["tool_a"]);
		expect(port.tools().map((tool) => tool.name)).toEqual(["tool_a"]);
		expect(audits).toContain("extension.host.tools_rejected");
	});

	it("starts no host when nothing is ready", async () => {
		let started = 0;
		const port = createSessionExtensionHostPort({
			selection: async () => ({ candidates: [], ready: [], gates: [], diagnostics: [] }),
			runtime: {
				start: async () => { started += 1; return { ok: true, snapshot: snapshot([]) }; },
				shutdown: async () => undefined,
				dispatch: async () => ({ ok: true, value: null }),
				subscribersFor: () => [],
			},
			reservedNames: () => [],
			invoke: async () => ({ content: [], details: {} }),
		});
		await expect(port.start()).resolves.toEqual({ ok: true, tools: [] });
		expect(started).toBe(0);
	});

	it("picks one host deterministically and reports the skipped candidates", async () => {
		const audits: Array<Record<string, unknown>> = [];
		const order: string[] = [];
		const port = createSessionExtensionHostPort({
			selection: selection([candidate("beta@local", "user"), candidate("alpha@local", "project")]),
			runtime: {
				start: async (chosen) => { order.push(chosen.packageId); return { ok: true, snapshot: snapshot([{ name: "tool_a" }]) }; },
				shutdown: async () => undefined,
				dispatch: async () => ({ ok: true, value: null }),
				subscribersFor: () => [],
			},
			reservedNames: () => [],
			invoke: async () => ({ content: [], details: {} }),
			audit: async (event) => { audits.push({ type: event.eventType, ...event.payload }); },
		});
		await port.start();
		// project scope 优先，其次 packageId 排序。
		expect(order).toEqual(["alpha@local"]);
		const skipped = audits.find((event) => event.type === "extension.host.candidates_skipped");
		expect(skipped?.skipped).toEqual(["beta@local"]);
	});

	it("returns a failure instead of throwing when the host cannot start", async () => {
		const port = createSessionExtensionHostPort({
			selection: selection([candidate("sample@local", "user")]),
			runtime: {
				start: async () => ({ ok: false, code: "host_exited", message: "factory exploded" }),
				shutdown: async () => undefined,
				dispatch: async () => ({ ok: true, value: null }),
				subscribersFor: () => [],
			},
			reservedNames: () => [],
			invoke: async () => ({ content: [], details: {} }),
		});
		await expect(port.start()).resolves.toEqual({ ok: false, code: "host_exited", message: "factory exploded" });
		expect(port.tools()).toEqual([]);
	});

	it("routes dispatch through the runtime and clears tools on shutdown", async () => {
		let shutdowns = 0;
		const port = createSessionExtensionHostPort({
			selection: selection([candidate("sample@local", "user")]),
			runtime: {
				start: async () => ({ ok: true, snapshot: snapshot([{ name: "tool_a" }]) }),
				shutdown: async () => { shutdowns += 1; },
				dispatch: async (input) => ({ ok: true, value: { name: input.name } }),
				subscribersFor: () => [],
			},
			reservedNames: () => [],
			invoke: async () => ({ content: [], details: {} }),
		});
		await port.start();
		await expect(port.dispatchEvent({ name: "PreToolUse", cancelable: true, payload: {} })).resolves.toEqual({ ok: true, value: { name: "PreToolUse" } });
		await port.shutdown("paused");
		expect(port.tools()).toEqual([]);
		expect(shutdowns).toBe(1);
	});
});
