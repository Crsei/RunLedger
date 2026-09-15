import type { Api, Model, ModelThinkingLevel } from "../../../types.ts";
import { SESSION_PROTOCOL_BOUNDS } from "../../session-server/protocol.ts";
import type { SessionCommandPort, SessionCommandRouteTable } from "../command-routes.ts";

/**
 * 单帧模型页预算:取传输上限的一半,给 command_result envelope 与其他字段留余量。
 * 完整 catalog 远超单帧上限,因此 `models` 必须分页,不能整表塞进一个 frame。
 */
const MODEL_PAGE_BUDGET_BYTES = Math.floor(SESSION_PROTOCOL_BOUNDS.maxFrameBytes / 2);

const textEncoder = new TextEncoder();

export interface ModelPage {
	readonly models: readonly Model<Api>[];
	readonly nextCursor?: string;
}

/**
 * 按字节预算切分模型列表。cursor 是不透明的十进制偏移;非法 cursor 返回 undefined。
 * 单条模型即使自身超预算也独占一页,保证 offset 严格前进、分页必然收敛。
 */
export function pageModels(models: readonly Model<Api>[], cursor: unknown): ModelPage | undefined {
	if (cursor !== undefined && (typeof cursor !== "string" || !/^\d+$/u.test(cursor))) return undefined;
	const offset = cursor === undefined ? 0 : Number(cursor);
	if (!Number.isSafeInteger(offset) || offset < 0 || offset > models.length) return undefined;
	let bytes = 0;
	let end = offset;
	while (end < models.length) {
		const size = textEncoder.encode(JSON.stringify(models[end])).byteLength;
		if (end > offset && bytes + size > MODEL_PAGE_BUDGET_BYTES) break;
		bytes += size;
		end += 1;
	}
	return end < models.length
		? { models: models.slice(offset, end), nextCursor: String(end) }
		: { models: models.slice(offset, end) };
}

export function createModelCommandRoutes(port: SessionCommandPort): Pick<SessionCommandRouteTable, "provider_status" | "models" | "select_model" | "set_thinking" | "editor_activity"> {
	return {
		provider_status: async () => {
			if (port.domain === undefined) return { ok: false, code: "domain_unavailable" };
			return { ok: true, kind: "provider_status", result: { providers: await port.domain.controller.getProviderStatuses() } };
		},
		models: async (request) => {
			if (port.domain === undefined) return { ok: false, code: "domain_unavailable" };
			const provider = typeof request.body.provider === "string" ? request.body.provider : undefined;
			// 打开模型列表前做 best-effort 网络刷新(pi 在模型选择器里同样刷新);
			// 失败不影响列表,controller 内部保留 last-known-good 并有 TTL 节流。
			await port.domain.controller.refreshModels?.(provider).catch(() => undefined);
			const available = await port.domain.controller.getAvailableModels(provider);
			const page = pageModels(available, request.body.cursor);
			if (page === undefined) return { ok: false, code: "invalid_input" };
			return {
				ok: true,
				kind: "models",
				result: page.nextCursor === undefined
					? { models: page.models }
					: { models: page.models, nextCursor: page.nextCursor },
			};
		},
		select_model: async (request) => {
			port.invalidateIdleRecap();
			if (port.domain === undefined) return { ok: false, code: "domain_unavailable" };
			if (typeof request.body.provider !== "string" || typeof request.body.model !== "string") return { ok: false, code: "invalid_input" };
			try { await port.domain.controller.selectModel({ provider: request.body.provider, id: request.body.model } as Model<Api>); }
			catch (error) {
				if (error instanceof Error && ["native_compaction_incompatible", "model_context_requires_compaction"].includes(error.message)) return { ok: false, code: error.message };
				throw error;
			}
			return { ok: true, kind: "select_model", result: { selection: port.domain.snapshot().selection } };
		},
		set_thinking: async (request) => {
			port.invalidateIdleRecap();
			if (port.domain === undefined) return { ok: false, code: "domain_unavailable" };
			await port.domain.controller.setThinkingLevel(String(request.body.level ?? "off") as ModelThinkingLevel);
			return { ok: true, kind: "set_thinking", result: { selection: port.domain.snapshot().selection } };
		},
		editor_activity: async (request) => {
			if (typeof request.body.empty !== "boolean") return { ok: false, code: "invalid_input" };
			port.handleEditorActivity(request.body.empty);
			return { ok: true, kind: "editor_activity", result: {} };
		},
	};
}
