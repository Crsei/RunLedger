import type { Api, Model, ModelThinkingLevel } from "../../../types.ts";
import type { SessionCommandPort, SessionCommandRouteTable } from "../command-routes.ts";

export function createModelCommandRoutes(port: SessionCommandPort): Pick<SessionCommandRouteTable, "provider_status" | "models" | "select_model" | "set_thinking" | "editor_activity"> {
	return {
		provider_status: async () => {
			if (port.domain === undefined) return { ok: false, code: "domain_unavailable" };
			return { ok: true, kind: "provider_status", result: { providers: await port.domain.controller.getProviderStatuses() } };
		},
		models: async (request) => {
			if (port.domain === undefined) return { ok: false, code: "domain_unavailable" };
			const provider = typeof request.body.provider === "string" ? request.body.provider : undefined;
			return { ok: true, kind: "models", result: { models: await port.domain.controller.getAvailableModels(provider) } };
		},
		select_model: async (request) => {
			port.invalidateIdleRecap();
			if (port.domain === undefined) return { ok: false, code: "domain_unavailable" };
			if (typeof request.body.provider !== "string" || typeof request.body.model !== "string") return { ok: false, code: "invalid_input" };
			await port.domain.controller.selectModel({ provider: request.body.provider, id: request.body.model } as Model<Api>);
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
