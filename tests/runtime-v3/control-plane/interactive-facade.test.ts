import { describe, expect, it, vi } from "vitest";
import type { InteractiveSessionControllerPort } from "../../../src/runtime/interactive-session-controller.ts";
import {
	GovernedInteractiveSessionFacade,
	type GovernedInteractiveMutationPort,
} from "../../../src/runtime/control-plane/interactive-facade.ts";
import type { UserAgentMessage } from "../../../src/runtime/types.ts";

function user(text: string): UserAgentMessage {
	return { role: "user", content: [{ type: "text", text }] };
}

describe("GovernedInteractiveSessionFacade", () => {
	it("routes every TUI mutation through the Control Plane port while keeping view-only metadata local", async () => {
		const directPrompt = vi.fn<InteractiveSessionControllerPort["prompt"]>(async () => {
			throw new Error("direct view mutation must not run");
		});
		const view: InteractiveSessionControllerPort = {
			sessionId: "session_control-plane",
			inFlight: true,
			currentSelection: { provider: "provider", thinkingLevel: "off" },
			messages: [user("history")],
			warnings: [],
			auditEntries: [],
			toolCount: 7,
			subscribe: () => () => undefined,
			getProviderStatuses: async () => [],
			getProvider: () => undefined,
			getAvailableModels: async () => [],
			login: async () => { throw new Error("unused"); },
			logout: async () => undefined,
			selectModel: async () => undefined,
			setThinkingLevel: async (level) => level,
			prompt: directPrompt,
			interrupt: () => { throw new Error("direct view mutation must not run"); },
			cancelAllQueues: async () => { throw new Error("direct view mutation must not run"); },
			waitForIdle: async () => { throw new Error("direct view mutation must not run"); },
			dispose: () => { throw new Error("direct view mutation must not run"); },
		};
		const prompt = vi.fn<GovernedInteractiveMutationPort["prompt"]>(async () => undefined);
		const interrupt = vi.fn<GovernedInteractiveMutationPort["interrupt"]>();
		const cancelAllQueues = vi.fn<GovernedInteractiveMutationPort["cancelAllQueues"]>(async () => ({
			steering: [user("steer")],
			followUp: [],
		}));
		const waitForIdle = vi.fn<GovernedInteractiveMutationPort["waitForIdle"]>(async () => undefined);
		const dispose = vi.fn<GovernedInteractiveMutationPort["dispose"]>();
		const facade = new GovernedInteractiveSessionFacade({
			view,
			mutations: { prompt, interrupt, cancelAllQueues, waitForIdle, dispose },
		});

		await facade.prompt("next", "steer");
		facade.interrupt();
		expect((await facade.cancelAllQueues("restore")).steering[0]).toEqual(user("steer"));
		await facade.waitForIdle();
		facade.dispose();
		expect(prompt).toHaveBeenCalledWith("next", "steer");
		expect(interrupt).toHaveBeenCalledOnce();
		expect(cancelAllQueues).toHaveBeenCalledWith("restore");
		expect(waitForIdle).toHaveBeenCalledOnce();
		expect(dispose).toHaveBeenCalledOnce();
		expect(directPrompt).not.toHaveBeenCalled();
		expect(facade.sessionId).toBe("session_control-plane");
		expect(facade.toolCount).toBe(7);
	});
});
