import { describe, expect, it } from "vitest";
import type { AgentEvent, AgentMessage } from "../../../src/runtime/types.ts";
import type { InteractiveSessionControllerPort, RuntimeSelection, SessionTitleChangedEvent } from "../../../src/runtime/interactive-session-controller.ts";
import type { SessionDomainPort, SessionDomainSnapshot } from "../../../src/runtime/session-runtime/session-runtime.ts";
import { createRuntimeHarness } from "./harness.ts";

function createTitleDomain(): {
	readonly domain: SessionDomainPort;
	emit(event: SessionTitleChangedEvent): void;
} {
	let titleListener: ((event: SessionTitleChangedEvent) => void) | undefined;
	const selection: RuntimeSelection = { thinkingLevel: "off" };
	const messages: readonly AgentMessage[] = [];
	const controller = {
		sessionId: "session-title-runtime",
		inFlight: false,
		currentSelection: selection,
		messages,
		warnings: [],
		auditEntries: [],
		toolCount: 0,
		subscribe: (_listener: (event: AgentEvent) => void) => () => undefined,
		getSteeringMessages: () => [],
		getFollowUpMessages: () => [],
		getProviderStatuses: async () => [],
		getProvider: () => undefined,
		getAvailableModels: async () => [],
		login: async () => ({ type: "api_key" }),
		logout: async () => undefined,
		selectModel: async () => undefined,
		setThinkingLevel: async (level: "off") => level,
		prompt: async () => undefined,
		interrupt: () => undefined,
		clearAllQueues: () => ({ steering: [], followUp: [] }),
		waitForIdle: async () => undefined,
		dispose: () => undefined,
	} as unknown as InteractiveSessionControllerPort;
	const snapshot = (): SessionDomainSnapshot => ({
		messages,
		warnings: [],
		auditEntries: [],
		selection,
		toolCount: 0,
		inFlight: false,
		providerStatuses: [],
	});
	return {
		domain: {
			controller,
			snapshot,
			subscribeTitleChanged: (listener: (event: SessionTitleChangedEvent) => void) => {
				titleListener = listener;
				return () => {
					if (titleListener === listener) titleListener = undefined;
				};
			},
		},
		emit(event) {
			titleListener?.(event);
		},
	} as { readonly domain: SessionDomainPort; emit(event: SessionTitleChangedEvent): void };
}

describe("SessionRuntime title event composition", () => {
	it("broadcasts an auto-title event through the owner event surface", async () => {
		const titleDomain = createTitleDomain();
		const harness = await createRuntimeHarness("title-runtime-event", { domain: titleDomain.domain });
		const events: Array<{ readonly eventType: string; readonly payload: Record<string, unknown>; readonly sequence?: number }> = [];
		const unsubscribe = harness.runtime.onEvent((event) => events.push(event));
		try {
			titleDomain.emit({
				sessionId: harness.sessionId,
				title: "Ship the title event",
				source: "auto",
				sequence: 4,
			});
			expect(events).toContainEqual({
				eventType: "session.title_changed",
				payload: { sessionId: harness.sessionId, title: "Ship the title event", source: "auto" },
				sequence: 4,
			});
		} finally {
			unsubscribe();
			await harness.runtime.shutdownAfterLastAttachment("paused");
			harness.store.database().close();
			harness.cleanup();
		}
	});
});
