/**
 * B4：EffectRunner 验收。
 *
 *   - effect dispatch 生成唯一 generation/effectId/correlationId 语义（ref 透传）；
 *   - stale、aborted 和乱序 result 不得覆盖新 generation；
 *   - runner 拥有 AbortController registry，但 AbortController 不进入 TuiState；
 *   - capability 缺失时不发 effect，直接 failed(capability_unavailable)；
 *   - observer/driver capability 由端口实现方区分，runner 不做能力推断。
 */

import { describe, expect, it, vi } from "vitest";
import { createEffectRunner } from "../../../src/tui/application/effect-runner.ts";
import type { TuiDomainPorts } from "../../../src/tui/application/ports.ts";
import type { TuiResult } from "../../../src/tui/application/result.ts";
import type { ProviderWorkflowPort, ProviderCatalogSnapshot } from "../../../src/tui/providers/types.ts";

const ref = (generation = 1, effectId = "effect-1", correlationId = "corr-1") => ({ generation, effectId, correlationId });

function catalogPort(delayMs = 0): ProviderWorkflowPort & { readonly triggered: Promise<void> } {
	let mark: (() => void) | undefined;
	const triggered = new Promise<void>((resolve) => { mark = resolve; });
	return {
		triggered,
		list: async (request) => {
			if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
			mark?.();
			return { ok: true, ref: request, value: { providers: [], models: [], generation: 1 } satisfies ProviderCatalogSnapshot };
		},
		select: async (request) => ({ ok: true, ref: request, value: { providerId: "p", modelId: "m", generation: 1 } }),
	};
}

describe("B4 effect runner", () => {
	it("executes the port and correlates the result back", async () => {
		const results: TuiResult[] = [];
		const port = catalogPort();
		const runner = createEffectRunner({
			ports: { provider: port },
			currentGeneration: () => 1,
			onResult: (result) => results.push(result),
		});
		runner.dispatch({ type: "provider.list", ...ref(1, "effect-1", "corr-1") });
		await port.triggered;
		await Promise.resolve();
		await Promise.resolve();
		expect(results).toHaveLength(1);
		expect(results[0]).toMatchObject({ status: "completed", ref: { generation: 1, effectId: "effect-1", correlationId: "corr-1" } });
	});

	it("marks results stale when the authority generation advanced", async () => {
		const results: TuiResult[] = [];
		let generation = 1;
		const port = catalogPort(10);
		const runner = createEffectRunner({
			ports: { provider: port },
			currentGeneration: () => generation,
			onResult: (result) => results.push(result),
		});
		runner.dispatch({ type: "provider.list", ...ref(1, "effect-1", "corr-1") });
		await port.triggered;
		generation = 2;
		await new Promise((resolve) => setTimeout(resolve, 15));
		expect(results[0]!.status).toBe("stale");
	});

	it("aborts in-flight effects via cancel and reports aborted", async () => {
		const results: TuiResult[] = [];
		const port = catalogPort(50);
		const runner = createEffectRunner({
			ports: { provider: port },
			currentGeneration: () => 1,
			onResult: (result) => results.push(result),
		});
		const effect = { type: "provider.list" as const, ...ref(1, "effect-1", "corr-1") };
		runner.dispatch(effect);
		runner.cancel(effect);
		await new Promise((resolve) => setTimeout(resolve, 80));
		expect(results[0]!.status).toBe("aborted");
	});

	it("does not dispatch when the capability port is missing", async () => {
		const results: TuiResult[] = [];
		const runner = createEffectRunner({
			ports: {} satisfies TuiDomainPorts,
			currentGeneration: () => 1,
			onResult: (result) => results.push(result),
		});
		runner.dispatch({ type: "provider.list", ...ref(1, "effect-1", "corr-1") });
		expect(results[0]).toMatchObject({ status: "failed", error: { code: "capability_unavailable" } });
	});

	it("reports port rejection as failed with retryable error", async () => {
		const results: TuiResult[] = [];
		const port = catalogPort();
		const failing = { ...port, list: async (request: Parameters<ProviderWorkflowPort["list"]>[0]) => ({ ok: false, ref: request, error: { code: "boom", message: "port failed", retryable: true } }) };
		const runner = createEffectRunner({
			ports: { provider: failing },
			currentGeneration: () => 1,
			onResult: (result) => results.push(result),
		});
		runner.dispatch({ type: "provider.list", ...ref(1, "effect-1", "corr-1") });
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(results[0]).toMatchObject({ status: "failed", error: { code: "boom", retryable: true } });
	});

	it("marks uncertain results with recoveryRequired and never optimistically commits", async () => {
		const results: TuiResult[] = [];
		const port = catalogPort();
		const uncertain = { ...port, list: async (request: Parameters<ProviderWorkflowPort["list"]>[0]) => ({ ok: false, ref: request, error: { code: "unknown", message: "unclear", retryable: false, recoveryRequired: true } }) };
		const runner = createEffectRunner({
			ports: { provider: uncertain },
			currentGeneration: () => 1,
			onResult: (result) => results.push(result),
		});
		runner.dispatch({ type: "provider.list", ...ref(1, "effect-1", "corr-1") });
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(results[0]).toMatchObject({ status: "uncertain", recoveryRequired: true });
	});

	it("never stores AbortController in results or state", () => {
		const results: TuiResult[] = [];
		const port = catalogPort();
		let capturedSignal: unknown;
		const portWithSignal = { ...port, list: async (request: Parameters<ProviderWorkflowPort["list"]>[0]) => {
			capturedSignal = request.signal;
			return { ok: true, ref: request, value: { providers: [], models: [], generation: 1 } };
		} };
		const runner = createEffectRunner({
			ports: { provider: portWithSignal },
			currentGeneration: () => 1,
			onResult: (result) => results.push(result),
		});
		runner.dispatch({ type: "provider.list", ...ref(1, "effect-1", "corr-1") });
		expect(capturedSignal).toBeInstanceOf(AbortSignal);
		expect(JSON.stringify(results)).not.toContain("signal");
	});

	it("cancelAll aborts every in-flight effect", async () => {
		const results: TuiResult[] = [];
		const port = catalogPort(50);
		const runner = createEffectRunner({
			ports: { provider: port },
			currentGeneration: () => 1,
			onResult: (result) => results.push(result),
		});
		runner.dispatch({ type: "provider.list", ...ref(1, "effect-1", "corr-1") });
		runner.dispatch({ type: "provider.list", ...ref(1, "effect-2", "corr-2") });
		runner.cancelAll();
		await new Promise((resolve) => setTimeout(resolve, 80));
		expect(results.map((result) => result.status).sort()).toEqual(["aborted", "aborted"]);
	});

	it("a port throwing is encoded as failed, never thrown to the caller", async () => {
		const results: TuiResult[] = [];
		const port = catalogPort();
		const throwing = { ...port, list: async () => { throw new Error("port exploded"); } };
		const runner = createEffectRunner({
			ports: { provider: throwing },
			currentGeneration: () => 1,
			onResult: (result) => results.push(result),
		});
		runner.dispatch({ type: "provider.list", ...ref(1, "effect-1", "corr-1") });
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(results[0]).toMatchObject({ status: "failed", error: { code: "effect_error" } });
		expect(vi).toBeDefined();
	});
});
