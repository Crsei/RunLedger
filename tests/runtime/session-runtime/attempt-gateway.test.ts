/** P0 回归:side-effect attempt 的 digest、outcome 与 fail-closed settlement。 */

import { afterEach, describe, expect, it } from "vitest";
import type { ExecutionEnv } from "../../../src/runtime/execution-env.ts";
import { gatedExecutionEnv, type AttemptPort } from "../../../src/runtime/session-runtime/attempt-gateway.ts";
import { runtimeDigest, type RuntimeDigest } from "../../../src/runtime/protocol/foundation.ts";
import { createRuntimeId, type AttemptId, type CommandId } from "../../../src/runtime/protocol/ids.ts";
import type { CommandEffectClass } from "../../../src/runtime/session-owner/types.ts";
import { createRuntimeHarness, type RuntimeHarness } from "./harness.ts";

const harnesses: RuntimeHarness[] = [];

afterEach(async () => {
	for (const harness of harnesses.splice(0)) {
		await harness.runtime.shutdownAfterLastAttachment("paused");
		harness.store.database().close();
		harness.cleanup();
	}
});

function fakeEnv(write: (path: string, data: string | Buffer) => Promise<void>): ExecutionEnv {
	return {
		cwd: "/workspace",
		fs: {
			readFile: async () => Buffer.alloc(0),
			stat: async () => ({ size: 0, mtimeMs: 0, isFile: true, isDirectory: false }),
			readdir: async () => [],
			writeFile: write,
			mkdir: async () => undefined,
			rm: async () => undefined,
		},
		shell: {
			exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
		},
		network: {
			request: async (request) => ({ status: 200, headers: {}, body: Buffer.alloc(0), finalUrl: request.url }),
		},
	};
}

describe("attempt gateway audit safety", () => {
	it("marks a post-invocation write error uncertain because partial effects cannot be disproved", async () => {
		const harness = await createRuntimeHarness("partial-effect");
		harnesses.push(harness);
		let touched = false;
		const env = gatedExecutionEnv(
			fakeEnv(async () => {
				touched = true;
				throw new Error("write failed after opening the file");
			}),
			() => harness.runtime,
			harness.sessionId,
		);
		await expect(env.fs.writeFile("/workspace/a.txt", "value")).rejects.toThrow("write failed");
		expect(touched).toBe(true);
		const latest = harness.store.listAllAttemptReceipts(harness.sessionId).at(-1);
		expect(latest?.outcome).toBe("uncertain");
		expect(latest?.settledGeneration).toBeUndefined();
	});

	it("does not return an external success when the committed receipt cannot be settled", async () => {
		const port: AttemptPort = {
			beginAttempt: () => ({
				attemptId: createRuntimeId("attempt", "settlement-failure"),
				commandId: createRuntimeId("command", "settlement-failure"),
			}),
			settleAttempt: () => ({ ok: false, code: "owner_fenced" }),
		};
		const env = gatedExecutionEnv(fakeEnv(async () => undefined), () => port, createRuntimeId("session", "settlement-failure"));
		await expect(env.fs.writeFile("/workspace/a.txt", "value")).rejects.toThrow("attempt_settlement_failed");
	});

	it("binds write path and content digest into distinct immutable command request digests", async () => {
		const harness = await createRuntimeHarness("request-digest");
		harnesses.push(harness);
		const env = gatedExecutionEnv(fakeEnv(async () => undefined), () => harness.runtime, harness.sessionId);
		await env.fs.writeFile("/workspace/a.txt", "same");
		await env.fs.writeFile("/workspace/b.txt", "same");
		const rows = harness.store.database().queryAll(
			"SELECT request_digest FROM commands WHERE session_id = ? ORDER BY created_at_ms, command_id",
			[harness.sessionId],
		);
		expect(rows).toHaveLength(2);
		expect(String(rows[0]!.request_digest)).not.toBe(String(rows[1]!.request_digest));
	});

	it("self-stops when settlement is rejected by the durable owner fence", async () => {
		const harness = await createRuntimeHarness("settle-fence");
		harnesses.push(harness);
		const beginWithDigest = harness.runtime.beginAttempt.bind(harness.runtime) as unknown as (
			effectClass: CommandEffectClass,
			requestDigest: RuntimeDigest,
		) => { readonly attemptId: AttemptId; readonly commandId: CommandId } | { readonly error: string };
		const begun = beginWithDigest("workspace_mutation", runtimeDigest({ operation: "fs.write", pathDigest: "a" }));
		if ("error" in begun) throw new Error("expected attempt");
		harness.store.database().runSync(
			"UPDATE session_owners SET runtime_id = ?, generation = 2, state = 'running' WHERE session_id = ?",
			[createRuntimeId("runtime", "replacement"), harness.sessionId],
		);
		const settled = harness.runtime.settleAttempt(begun.attemptId, "committed", runtimeDigest({ ok: true }));
		expect(settled).toEqual({ ok: false, code: "owner_fenced" });
		expect(harness.runtime.runtimeState).toBe("fenced");
	});

	it("does not create a meaningless unresolved readonly receipt for a completed prompt", async () => {
		const harness = await createRuntimeHarness("prompt-receipt");
		harnesses.push(harness);
		const result = await harness.runtime.handleCommand(
			{ commandId: createRuntimeId("command", "prompt"), kind: "prompt", body: { promptText: "hello" } },
			{ connectionId: createRuntimeId("connection", "driver"), clientId: "client_driver", isDriver: true },
		);
		expect(result.ok).toBe(true);
		expect(harness.store.listAllAttemptReceipts(harness.sessionId)).toHaveLength(0);
	});
});
