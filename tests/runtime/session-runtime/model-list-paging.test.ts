/**
 * 模型列表分页:完整 catalog 远超单帧上限,`models` 必须分页返回,
 * 客户端跟随 nextCursor 累积;否则大 catalog(如 openrouter 503 个模型)
 * 会让 RuntimeServer 直接 destroy 连接,TUI 模型列表整体失败。
 */

import { describe, expect, it } from "vitest";
import type { Model, ModelThinkingLevel } from "../../../src/types.ts";
import { SESSION_PROTOCOL_BOUNDS } from "../../../src/runtime/session-server/protocol.ts";
import type { SessionCommandResult } from "../../../src/runtime/session-server/runtime-server.ts";
import type { SessionFrameEnvelope } from "../../../src/runtime/session-server/protocol.ts";
import type { SessionClientTransport } from "../../../src/runtime/session-server/client-transport.ts";
import type { SessionCommandPort } from "../../../src/runtime/session-runtime/command-routes.ts";
import { createModelCommandRoutes, pageModels } from "../../../src/runtime/session-runtime/command-routes/model.ts";
import type { InteractiveSessionControllerPort } from "../../../src/runtime/interactive-session-controller.ts";
import { SessionInteractiveController, type SessionInteractiveSnapshot } from "../../../src/cli/session-interactive-controller.ts";
import type { OwnedSessionHandle } from "../../../src/cli/session-client.ts";

function model(index: number, nameBytes = 400): Model<"openai-completions"> {
	return {
		id: `model-${index}`,
		name: `Model ${index} ${"x".repeat(nameBytes)}`,
		api: "openai-completions",
		provider: "fixture",
		baseUrl: "https://fixture.invalid/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 1024,
	};
}

function routesFor(models: readonly Model<"openai-completions">[] | (() => Promise<never>)) {
	const port = {
		domain: {
			controller: {
				getAvailableModels: typeof models === "function" ? models : async () => models,
			} as unknown as InteractiveSessionControllerPort,
		},
		invalidateIdleRecap: () => undefined,
		handleEditorActivity: () => undefined,
	} as unknown as SessionCommandPort;
	return createModelCommandRoutes(port);
}

function frameBytes(result: Record<string, unknown>): number {
	return new TextEncoder().encode(JSON.stringify({ ok: true, kind: "models", result })).byteLength;
}

/** 断言成功响应并取回 result;失败分支直接抛错,避免未检查的 inline cast 读取。 */
function modelPage(result: SessionCommandResult): { models: Model<"openai-completions">[]; nextCursor?: string } {
	if (!result.ok) throw new Error(`models command failed: ${result.code}`);
	const models = result.result.models;
	if (!Array.isArray(models)) throw new Error("models result is not an array");
	return {
		models: models as Model<"openai-completions">[],
		...(typeof result.result.nextCursor === "string" ? { nextCursor: result.result.nextCursor } : {}),
	};
}

describe("model list paging", () => {
	it("pages a catalog larger than one frame and preserves every model in order", async () => {
		const models = Array.from({ length: 400 }, (_, index) => model(index));
		const routes = routesFor(models);
		const collected: Model<"openai-completions">[] = [];
		const pageSizes: number[] = [];
		let cursor: string | undefined;
		for (let page = 0; page < 200; page++) {
			const response = await routes.models({ body: cursor === undefined ? {} : { cursor } } as never, {} as never);
			expect(response.ok).toBe(true);
			const result = modelPage(response);
			pageSizes.push(frameBytes(result));
			collected.push(...result.models);
			if (result.nextCursor === undefined) break;
			cursor = result.nextCursor;
		}
		expect(collected.map((entry) => entry.id)).toEqual(models.map((entry) => entry.id));
		expect(pageSizes.length).toBeGreaterThan(1);
		expect(Math.max(...pageSizes)).toBeLessThanOrEqual(SESSION_PROTOCOL_BOUNDS.maxFrameBytes);
	});

	it("returns the whole catalog in the first page when it fits the frame budget", async () => {
		const models = [model(0, 0), model(1, 0)];
		const result = modelPage(await routesFor(models).models({ body: {} } as never, {} as never));
		expect(result.models.map((entry) => entry.id)).toEqual(["model-0", "model-1"]);
		expect(result.nextCursor).toBeUndefined();
	});

	it("gives a single oversized model its own page so the cursor always advances", () => {
		const oversized = model(0, SESSION_PROTOCOL_BOUNDS.maxFrameBytes);
		const page = pageModels([oversized, model(1, 0)], undefined);
		expect(page?.models.map((entry) => entry.id)).toEqual(["model-0"]);
		expect(page?.nextCursor).toBe("1");
		const next = pageModels([oversized, model(1, 0)], page?.nextCursor);
		expect(next?.models.map((entry) => entry.id)).toEqual(["model-1"]);
		expect(next?.nextCursor).toBeUndefined();
	});

	it("rejects malformed cursors instead of restarting the list", async () => {
		const routes = routesFor([model(0, 0)]);
		expect(await routes.models({ body: { cursor: "abc" } } as never, {} as never)).toMatchObject({ ok: false, code: "invalid_input" });
		expect(await routes.models({ body: { cursor: "-1" } } as never, {} as never)).toMatchObject({ ok: false, code: "invalid_input" });
		expect(await routes.models({ body: { cursor: "9" } } as never, {} as never)).toMatchObject({ ok: false, code: "invalid_input" });
	});
});

describe("SessionInteractiveController model list accumulation", () => {
	function controllerWithRequest(request: SessionClientTransport["request"]): SessionInteractiveController {
		const transport = { request, onEvent: () => () => undefined } as unknown as SessionClientTransport;
		const snapshot: SessionInteractiveSnapshot = {
			sessionId: "session_fixture",
			harnessProfile: { id: "standard", version: 1 } as SessionInteractiveSnapshot["harnessProfile"],
			permissionProfile: "workspace-write",
			messages: [],
			warnings: [],
			auditEntries: [],
			selection: { thinkingLevel: "off" as ModelThinkingLevel },
			toolCount: 0,
			eventCursor: 0,
			driverRevision: 0,
		};
		return new SessionInteractiveController({ transport, generation: 1 } as unknown as OwnedSessionHandle, snapshot);
	}

	it("follows nextCursor across frames and returns the full available list", async () => {
		const models = Array.from({ length: 300 }, (_, index) => model(index));
		const routes = routesFor(models);
		const requests: Record<string, unknown>[] = [];
		const request: SessionClientTransport["request"] = async (frame: SessionFrameEnvelope) => {
			const body = frame.body.body as Record<string, unknown>;
			requests.push(body);
			const response = await routes.models({ body } as never, {} as never);
			if (!response.ok) throw new Error(`models command failed: ${response.code}`);
			return {
				kind: "command_result",
				protocolVersion: 3,
				frameId: `result_${requests.length}`,
				body: { ok: true, kind: "models", result: response.result },
			} as unknown as SessionFrameEnvelope;
		};
		const controller = controllerWithRequest(request);
		const available = await controller.getAvailableModels("fixture");
		expect(available.map((entry) => entry.id)).toEqual(models.map((entry) => entry.id));
		expect(requests.length).toBeGreaterThan(1);
		expect(requests[0]).toEqual({ provider: "fixture" });
		expect(requests[1]).toMatchObject({ provider: "fixture", cursor: expect.any(String) });
	});
});
