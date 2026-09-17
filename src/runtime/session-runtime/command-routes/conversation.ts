import type { SessionCommandPort, SessionCommandRouteTable } from "../command-routes.ts";

export function createConversationCommandRoutes(port: SessionCommandPort): Pick<SessionCommandRouteTable, "prompt" | "steer" | "follow_up" | "clear_queues" | "interrupt"> {
	return {
		prompt: async (request) => {
			port.invalidateIdleRecap();
			if (port.state() === "recovery_required") {
				return { ok: false, code: "recovery_barrier_active", detail: "session is in RECOVERY_REQUIRED" };
			}
			const admission = port.barrier.admitPrompt();
			if (!admission.ok) return { ok: false, code: "recovery_barrier_active" };
			port.emit({ eventType: "turn.started", payload: { promptText: String(request.body.promptText ?? "").slice(0, 512) } });
			if (port.domain !== undefined) {
				const behavior = request.body.behavior === "followUp" ? "followUp" as const : request.body.behavior === "steer" ? "steer" as const : undefined;
				try {
					await port.domain.controller.prompt(String(request.body.promptText ?? ""), behavior);
				} catch (error) {
					return { ok: false, code: "domain_prompt_failed", detail: error instanceof Error ? error.message.slice(0, 200) : undefined };
				}
			}
			return { ok: true, kind: "prompt", result: { accepted: true } };
		},
		steer: async (request) => queuePrompt(port, request.body.text, "steer"),
		follow_up: async (request) => queuePrompt(port, request.body.text, "followUp"),
		clear_queues: async () => {
			port.invalidateIdleRecap();
			if (port.domain === undefined) return { ok: false, code: "domain_unavailable" };
			port.domain.controller.clearAllQueues();
			return { ok: true, kind: "clear_queues", result: {} };
		},
		interrupt: async () => {
			port.invalidateIdleRecap();
			port.loop?.stop?.("interrupted");
			port.domain?.controller.interrupt();
			port.emit({ eventType: "turn.interrupted", payload: {} });
			return { ok: true, kind: "interrupt", result: {} };
		},
	};
}

async function queuePrompt(port: SessionCommandPort, text: unknown, behavior: "steer" | "followUp") {
	port.invalidateIdleRecap();
	if (port.domain === undefined) return { ok: false as const, code: "domain_unavailable" };
	if (port.state() === "recovery_required") return { ok: false as const, code: "recovery_barrier_active" };
	await port.domain.controller.prompt(String(text ?? ""), behavior);
	return { ok: true as const, kind: behavior === "steer" ? "steer" : "follow_up", result: {} };
}
