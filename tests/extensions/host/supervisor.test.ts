import { describe, expect, it } from "vitest";
import { runExtensionHost, type ExtensionFactory } from "../../../src/extensions/host/runtime.ts";
import { connectExtensionHost } from "../../../src/extensions/host/client.ts";
import { EXTENSION_DEFAULT_HOST_LIMITS } from "../../../src/contracts/extensions/registry.ts";
import type { ExtensionHostBootstrap } from "../../../src/extensions/host/bootstrap.ts";
import { createLoopback, waitFor } from "./loopback.ts";

const bootstrap: ExtensionHostBootstrap = {
	packageId: "sample-plugin@local",
	digest: "d".repeat(64),
	generation: 3,
	apiVersion: "1.0.0",
	limits: EXTENSION_DEFAULT_HOST_LIMITS,
	rootPath: "/tmp/runledger-ext-host",
	entrypoint: "/tmp/runledger-ext-host/entry.ts",
};

async function connected(factory: ExtensionFactory, overrides: { readonly apiVersion?: string } = {}) {
	const loopback = createLoopback();
	const expected = overrides.apiVersion === undefined ? bootstrap : { ...bootstrap, apiVersion: overrides.apiVersion };
	void runExtensionHost({ bootstrap: expected, factory, duplex: loopback.hostDuplex, pid: 4_242 });
	return { loopback, result: await connectExtensionHost({ channel: loopback.channel, bootstrap: expected, onAction: async () => ({ ok: true }) }) };
}

describe("extension host handshake and registry", () => {
	it("completes hello + registry and exposes the frozen registry identity", async () => {
		const { result, loopback } = await connected(() => undefined);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const state = result.client.state();
		expect(state.status).toBe("ready");
		if (state.status !== "ready") return;
		expect(state.hello.hostPid).toBe(4_242);
		expect(state.hello.packageId).toBe(bootstrap.packageId);
		expect(state.registry.tools).toEqual([]);
		expect(state.registryDigest).toMatch(/^[0-9a-f]{64}$/u);
		await result.client.close("owner-request");
		await waitFor(() => loopback.observedStops.length > 0);
	});

	it("publishes registrations the extension declared and keeps them sorted", async () => {
		const { result } = await connected((api) => {
			api.registerTool({ name: "zeta", description: "z", parameters: {}, approvalClass: "read-only", handler: () => "z" });
			api.registerTool({ name: "alpha", description: "a", parameters: {}, approvalClass: "read-only", handler: () => "a" });
			api.registerFlag({ name: "dry-run", description: "no writes", type: "boolean" });
			api.on("PreToolUse", () => undefined);
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const state = result.client.state();
		if (state.status !== "ready") throw new Error("host is not ready");
		expect(state.registry.tools.map((tool) => tool.name)).toEqual(["alpha", "zeta"]);
		expect(state.registry.flags.map((flag) => flag.name)).toEqual(["dry-run"]);
		expect(state.registry.subscriptions).toEqual([{ name: "PreToolUse" }]);
		await result.client.close("owner-request");
	});

	it("fails the handshake when the extension factory throws, and reports it as a failure rather than a crash", async () => {
		const { result, loopback } = await connected(() => { throw new Error("factory exploded"); });
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.code).toBe("extension_factory_failed");
		expect(result.message).toBe("factory exploded");
		expect(loopback.observedStops.length).toBeGreaterThan(0);
	});

	it("fails the handshake when the host api version does not match the owner's expectation", async () => {
		const loopback = createLoopback();
		void runExtensionHost({ bootstrap, factory: () => undefined, duplex: loopback.hostDuplex, pid: 4_242 });
		const result = await connectExtensionHost({
			channel: loopback.channel,
			bootstrap: { ...bootstrap, apiVersion: "2.0.0" },
			onAction: async () => ({ ok: true }),
		});
		expect(result).toEqual({ ok: false, code: "host_api_version_mismatch", message: "host api version 1.0.0 is not the expected 2.0.0" });
	});

	it("fails closed when the host registers an event outside the projection whitelist (frame schema rejects it first)", async () => {
		const loopback = createLoopback();
		void runExtensionHost({
			bootstrap,
			factory: () => undefined,
			duplex: {
				send: (line) => {
					const frame = JSON.parse(line) as { readonly kind?: string } & Record<string, unknown>;
					if (frame.kind === "registry") frame.subscriptions = [{ name: "ToolCall" }];
					loopback.hostDuplex.send(JSON.stringify(frame));
				},
				onLine: (handler) => loopback.hostDuplex.onLine(handler),
				onEnd: (handler) => loopback.hostDuplex.onEnd(handler),
				close: () => undefined,
			},
			pid: 1,
		});
		const result = await connectExtensionHost({ channel: loopback.channel, bootstrap, onAction: async () => ({ ok: true }) });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.code).toBe("protocol_frame_schema_invalid");
	});
});

describe("extension host event dispatch", () => {
	it("answers projected events and isolates a throwing handler from the rest", async () => {
		const diagnostics: string[] = [];
		const loopback = createLoopback();
		void runExtensionHost({
			bootstrap,
			factory: (api) => {
				api.on("PreToolUse", () => { throw new Error("handler exploded"); });
				api.on("PreToolUse", () => ({ allow: true }));
			},
			duplex: loopback.hostDuplex,
			pid: 7,
			onDiagnostic: (diagnostic) => diagnostics.push(diagnostic.code),
		});
		const result = await connectExtensionHost({ channel: loopback.channel, bootstrap, onAction: async () => ({ ok: true }) });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const outcome = await result.client.requestEvent({ name: "PreToolUse", cancelable: true, payload: { toolName: "bash" }, deadlineMs: 1_000 });
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(outcome.value).toMatchObject({ handlers: [{ index: 0, outcome: "error", result: null }, { index: 1, outcome: "result", result: { allow: true } }] });
		expect(diagnostics).toContain("extension.handler_failed");
		await result.client.close("owner-request");
	});

	it("times out a stuck handler, keeps the host alive and still answers the frame", async () => {
		const diagnostics: string[] = [];
		const loopback = createLoopback();
		void runExtensionHost({
			bootstrap: { ...bootstrap, limits: { ...EXTENSION_DEFAULT_HOST_LIMITS, handlerTimeoutMs: 50 } },
			factory: (api) => {
				api.on("PostToolUse", async () => { await new Promise<void>((resolve) => { setTimeout(resolve, 5_000); }); });
			},
			duplex: loopback.hostDuplex,
			pid: 8,
			onDiagnostic: (diagnostic) => diagnostics.push(diagnostic.code),
		});
		const expected = { ...bootstrap, limits: { ...EXTENSION_DEFAULT_HOST_LIMITS, handlerTimeoutMs: 50 } };
		const result = await connectExtensionHost({ channel: loopback.channel, bootstrap: expected, onAction: async () => ({ ok: true }) });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const outcome = await result.client.requestEvent({ name: "PostToolUse", cancelable: false, payload: {}, deadlineMs: 1_000 });
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(outcome.value).toMatchObject({ handlers: [{ index: 0, outcome: "timeout", result: null }] });
		expect(diagnostics).toContain("extension.handler_timeout");
		expect(result.client.state().status).toBe("ready");
		await result.client.close("owner-request");
	});

	it("answers an event nobody subscribed to without invoking the host registry", async () => {
		const { result } = await connected(() => undefined);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		await expect(result.client.requestEvent({ name: "TurnStart", cancelable: false, payload: {}, deadlineMs: 200 })).resolves.toEqual({ ok: true, value: { handlers: [] } });
		await result.client.close("owner-request");
	});
});

describe("extension host owner actions", () => {
	it("delivers action frames to the owner and returns its receipt to the extension", async () => {
		const received: string[] = [];
		const loopback = createLoopback();
		let extensionOutcome: unknown;
		void runExtensionHost({
			bootstrap,
			// 动作只在 initialize 之后合法：注册期只登记 handler，动作在事件里发起。
			factory: (api) => {
				api.on("TurnStart", async () => {
					extensionOutcome = await api.setModel({ providerId: "openai", modelId: "gpt" });
				});
			},
			duplex: loopback.hostDuplex,
			pid: 9,
		});
		const result = await connectExtensionHost({
			channel: loopback.channel,
			bootstrap,
			onAction: async (request) => {
				received.push(request.action);
				return { ok: false, code: "model_unavailable", message: "no credentials" };
			},
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const event = await result.client.requestEvent({ name: "TurnStart", cancelable: false, payload: {}, deadlineMs: 1_000 });
		expect(event.ok).toBe(true);
		expect(received).toEqual(["set-model"]);
		expect(extensionOutcome).toEqual({ ok: false, code: "model_unavailable", message: "no credentials" });
		await result.client.close("owner-request");
	});
});
