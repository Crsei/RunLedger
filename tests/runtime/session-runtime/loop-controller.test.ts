import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createEmbeddedSessionRuntime } from "../../../src/cli/embedded-session-runtime.ts";
import { SessionInteractiveController } from "../../../src/cli/session-interactive-controller.ts";
import { claimDriver, fetchDomainSnapshot } from "../../../src/cli/main.ts";
import { buildRunledgerLayout } from "../../../src/runtime/contracts/storage-layout.ts";
import { standardHarnessProfileRef } from "../../../src/runtime/harness-profiles/index.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/ids.ts";
import { AuthStorage } from "../../../src/storage/auth-storage.ts";
import { openSessionDatabase } from "../../../src/storage/session-store/database.ts";
import { OwnerStore } from "../../../src/storage/session-store/owner-store.ts";
import { installSessionStoreSchema } from "../../../src/storage/session-store/schema.ts";
import { SessionStore } from "../../../src/storage/session-store/session-store.ts";
import { builtinModels } from "../../../src/providers/all.ts";
import { createLoopTestHarness } from "./loop-test-harness.ts";
import { existsSync } from "node:fs";
import type { SessionDomainPort } from "../../../src/runtime/session-runtime/session-runtime.ts";
import { evaluateLoopCondition, type LoopConditionVerdict } from "../../../src/runtime/loop/condition.ts";

const noPromptTestSecurity = [{
	source: "cli" as const,
	read: async () => ({ status: "available" as const, text: JSON.stringify({ profile: "danger-full-access", approvalPolicy: "never" }) }),
}];

async function openLoopSession(seed: string) {
	const root = mkdtempSync(resolve(tmpdir(), `runledger-loop-${seed}-`));
	const home = resolve(root, "home");
	mkdirSync(home, { recursive: true, mode: 0o700 });
	const layout = buildRunledgerLayout(home, "posix");
	const db = openSessionDatabase(layout.database);
	installSessionStoreSchema(db);
	const store = new SessionStore(db);
	const ownerStore = new OwnerStore(db);
	const sessionId = createRuntimeId("session", `loop-${seed}`);
	store.createSession({
		sessionId,
		workspaceId: createRuntimeId("workspace", `loop-${seed}`),
		repositoryId: createRuntimeId("repository", `loop-${seed}`),
		settingsDigest: "d".repeat(64),
		harnessProfile: standardHarnessProfileRef(),
	});
	const models = builtinModels({ credentials: AuthStorage.create(layout) });
	await models.refresh({ allowNetwork: false });
	const embedded = await createEmbeddedSessionRuntime({
		sessionId,
		store,
		ownerStore,
		domain: { cwd: root, layout, settings: { autoTitle: false }, models, securitySources: noPromptTestSecurity },
	});
	const client = new SessionInteractiveController(embedded.handle, await fetchDomainSnapshot(embedded));
	await claimDriver(embedded, client);
	const cleanup = async () => {
		client.dispose();
		await embedded.handle.close().catch(() => undefined);
		await embedded.runtime?.shutdownAfterLastAttachment("paused");
		db.close();
		rmSync(root, { recursive: true, force: true });
	};
	return { sessionId, store, client, cleanup };
}

describe("SessionRuntime loop surface", () => {
	it("advertises loop operations and inspects an idle loop", async () => {
		const { client, cleanup } = await openLoopSession("inspect");
		try {
			expect(client.supports("loop.inspect")).toBe(true);
			expect(client.supports("loop.start")).toBe(true);
			expect(client.supports("loop.stop")).toBe(true);

			const inspected = await client.querySessionDomain("loop.inspect", {}, { correlationId: "loop-0", effectId: "loop-0" });
			expect(inspected.ok).toBe(true);
			if (!inspected.ok) return;
			expect(inspected.value.loop).toEqual({ running: false });
		} finally {
			await cleanup();
		}
	});

	it("rejects a loop start that cannot be honored and never fakes a running loop", async () => {
		const { client, cleanup } = await openLoopSession("reject");
		try {
			// 空 prompt：必须拒绝，而不是启动一个无内容的自主循环。
			const empty = await client.commandSessionDomain("loop.start", { prompt: "   ", action: "prompt" }, {
				correlationId: "loop-empty", effectId: "loop-empty", expectedRevision: 0,
			});
			expect(empty.ok).toBe(false);
			if (empty.ok) return;
			expect(empty.code).toBe("loop_prompt_required");

			// reset 只能由 client 换新 session 执行；runtime 只发信号，必须明确拒绝。
			const reset = await client.commandSessionDomain("loop.start", { prompt: "keep going", action: "reset" }, {
				correlationId: "loop-reset", effectId: "loop-reset", expectedRevision: 0,
			});
			expect(reset.ok).toBe(false);
			if (reset.ok) return;
			expect(reset.code).toBe("loop_reset_requires_client");

			const inspected = await client.querySessionDomain("loop.inspect", {}, { correlationId: "loop-1", effectId: "loop-1" });
			expect(inspected.ok && inspected.value.loop).toEqual({ running: false });
		} finally {
			await cleanup();
		}
	});
});

describe("governed loop condition path", () => {
	it("runs the condition through the session's governed shell and stops on a broken condition", async () => {
		const root = mkdtempSync(resolve(tmpdir(), "runledger-loop-condition-"));
		const home = resolve(root, "home");
		mkdirSync(home, { recursive: true, mode: 0o700 });
		const layout = buildRunledgerLayout(home, "posix");
		const db = openSessionDatabase(layout.database);
		installSessionStoreSchema(db);
		const store = new SessionStore(db);
		const ownerStore = new OwnerStore(db);
		const sessionId = createRuntimeId("session", "loop-condition");
		store.createSession({
			sessionId,
			workspaceId: createRuntimeId("workspace", "loop-condition"),
			repositoryId: createRuntimeId("repository", "loop-condition"),
			settingsDigest: "d".repeat(64),
			harnessProfile: standardHarnessProfileRef(),
		});
		const models = builtinModels({ credentials: AuthStorage.create(layout) });
		await models.refresh({ allowNetwork: false });
		// 在 standard profile 上显式启用条件谓词：默认关闭（D10 前默认 false）。
		const embedded = await createEmbeddedSessionRuntime({
			sessionId,
			store,
			ownerStore,
			domain: {
				cwd: root, layout, models,
				settings: { autoTitle: false, loop: { conditionEnabled: true } },
				securitySources: noPromptTestSecurity,
			},
		});
		try {
			const sentinel = resolve(root, "condition-ran.txt");
			// 受治理 shell 实际执行了条件命令：文件被创建，说明走的是 ExecutionEnv 而非绕过。
			const ran = await runConditionThroughDomain(embedded, `printf ran > ${sentinel} && exit 1`);
			expect(ran.kind).toBe("continue");
			expect(existsSync(sentinel)).toBe(true);

			// 退出码 127（条件自身损坏）必须判错并停止，而不是当作 false 继续。
			const broken = await runConditionThroughDomain(embedded, "command-that-does-not-exist-xyz");
			expect(broken.kind).toBe("error");

			// 退出码 1 是干净判定：--while 停止。
			const halt = await runConditionThroughDomain(embedded, "exit 1", false);
			expect(halt.kind).toBe("halt");
		} finally {
			await embedded.handle.close().catch(() => undefined);
			await embedded.runtime?.shutdownAfterLastAttachment("paused");
			db.close();
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("SessionLoopController iteration audit", () => {
	it("submits the initial round plus exactly the requested iterations and audits each step", async () => {
		const harness = createLoopTestHarness();
		const started = await harness.controller.start({ prompt: "iterate", action: "prompt", limit: { kind: "iterations", iterations: 3 } });
		expect(started).toEqual({ ok: true });
		// 首轮立即提交（omp 的 `/loop N` 语义：首轮 + N 次迭代）。
		expect(harness.submissions).toEqual(["iterate"]);

		for (let round = 0; round < 4; round += 1) {
			harness.emitAgentEnd();
			await harness.settle();
		}
		expect(harness.submissions).toEqual(["iterate", "iterate", "iterate", "iterate"]);
		expect(harness.stopReasons).toEqual(["iteration_limit_reached"]);
		expect(harness.controller.inspect()).toEqual({ running: false });
		expect(harness.audits.map((entry: { readonly eventType: string }) => entry.eventType)).toEqual([
			"loop.iteration_submitted",
			"loop.iteration_settled", "loop.iteration_submitted",
			"loop.iteration_settled", "loop.iteration_submitted",
			"loop.iteration_settled", "loop.iteration_submitted",
			"loop.iteration_settled",
			"loop.stopped",
		]);
	});

	it("falls back to the configured hard cap when no explicit limit was given", async () => {
		const harness = createLoopTestHarness();
		await harness.controller.start({ prompt: "iterate", action: "prompt" });
		// 首轮已提交；inspect 报告剩余 50 次（settings.loop.maxIterations）。
		expect(harness.controller.inspect()).toMatchObject({ running: true, iteration: 1, limit: "50 of 50 iterations remaining" });
	});

	it("stops the loop when a run ends on a run-budget termination", async () => {
		const harness = createLoopTestHarness();
		await harness.controller.start({ prompt: "iterate", action: "prompt", limit: { kind: "iterations", iterations: 5 } });
		harness.emitAgentEnd("model_turn_limit");
		await harness.settle();
		// run budget 终止后不得再提交，也不得靠自主循环绕过既有边界（D9）。
		expect(harness.submissions).toEqual(["iterate"]);
		expect(harness.stopReasons).toEqual(["run_budget_terminated"]);
		expect(harness.controller.inspect()).toEqual({ running: false });
	});

	it("stops the loop when the recovery barrier opens", async () => {
		const harness = createLoopTestHarness();
		await harness.controller.start({ prompt: "iterate", action: "prompt", limit: { kind: "iterations", iterations: 5 } });
		harness.openBarrier();
		harness.emitAgentEnd();
		await harness.settle();
		expect(harness.submissions).toEqual(["iterate"]);
		expect(harness.stopReasons).toEqual(["recovery_barrier_active"]);
	});

	it("surfaces why an iteration could not start instead of stopping silently", async () => {
		const harness = createLoopTestHarness({ promptFailure: new Error("No model selected. Use /provider or /model.") });
		const started = await harness.controller.start({ prompt: "iterate", action: "prompt", limit: { kind: "iterations", iterations: 3 } });
		expect(started).toEqual({ ok: true });
		// 静默停止会让「loop 看起来在跑」变成误导：必须把原因投递出去并记录停止原因。
		expect(harness.controller.inspect()).toEqual({ running: false });
		expect(harness.stopReasons).toEqual(["prompt_failed"]);
		expect(harness.events).toContainEqual({
			eventType: "session.loop_notice",
			payload: { message: "Loop iteration could not start: No model selected. Use /provider or /model." },
		});
	});

	it("reports the running loop through the owner-side inspect view", async () => {
		const harness = createLoopTestHarness();
		await harness.controller.start({ prompt: "iterate", action: "prompt", limit: { kind: "iterations", iterations: 2 } });
		expect(harness.controller.inspect()).toEqual({
			running: true, prompt: "iterate", iteration: 1, action: "prompt", limit: "2 of 2 iterations remaining",
		});
		await harness.controller.stop("user_requested");
		expect(harness.controller.inspect()).toEqual({ running: false });
		expect(harness.stopReasons).toEqual(["user_requested"]);
	});
});

/** 经真实 Session 组合取受治理执行器，再走 condition.ts 的三段判定。 */
async function runConditionThroughDomain(
	embedded: Awaited<ReturnType<typeof createEmbeddedSessionRuntime>>,
	command: string,
	until = true,
): Promise<LoopConditionVerdict> {
	const domain = (embedded.runtime as unknown as { domain: SessionDomainPort }).domain;
	const execute = domain.loopConditionExecutor;
	if (execute === undefined) throw new Error("loop condition executor is not wired");
	return evaluateLoopCondition({ command, until }, {
		execute,
		timeoutMs: 30_000,
		signal: new AbortController().signal,
	});
}
