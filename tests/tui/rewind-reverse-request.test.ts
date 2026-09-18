import { describe, expect, it } from "vitest";
import { InteractiveMode } from "../../src/tui/interactive-mode.ts";
import { SESSION_PROTOCOL_VERSION, type SessionFrameEnvelope } from "../../src/runtime/session-server/protocol.ts";
import { CHECKPOINT_REWIND_REQUEST_KIND, encodeRewindRequest, type RewindDriverRequest } from "../../src/runtime/session-runtime/rewind-reverse-request.ts";
import { ContractController, ContractTerminal } from "./fixtures/contract-integration.ts";

const REQUEST: RewindDriverRequest = {
	checkpointId: "snapshot_tui_rewind", checkpointGoal: "Before refactor", sourceSessionId: "contract-session",
	checkpointSequence: 4, expectedSourceHeadSequence: 7, expectedCatalogRevision: 2,
	report: "Keep the verified approach.",
};

function frame(body: Record<string, unknown>): SessionFrameEnvelope {
	return { frameId: "rewind-1", kind: "reverse_request", protocolVersion: SESSION_PROTOCOL_VERSION, body: { kind: CHECKPOINT_REWIND_REQUEST_KIND, body } };
}

describe("checkpoint rewind reverse-request dispatch", () => {
	it("executes a single fenced session.rewind command and returns the switch target", async () => {
		let operation: string | undefined;
		let payload: Record<string, unknown> | undefined;
		let expectedRevision: number | undefined;
		const controller = new ContractController({
			supportedOperations: ["session.rewind"],
			commandSessionDomain: async (nextOperation, nextPayload, context) => {
				operation = nextOperation;
				payload = nextPayload;
				expectedRevision = context?.expectedRevision;
				return { targetSessionId: "session_tui_rewound", domainRevision: 3 };
			},
		});
		const mode = new InteractiveMode({ controller, terminal: new ContractTerminal() });
		await expect(mode.handleSessionReverseRequest(frame(encodeRewindRequest(REQUEST)), new AbortController().signal))
			.resolves.toEqual({ ok: true, targetSessionId: "session_tui_rewound" });
		expect(operation).toBe("session.rewind");
		expect(payload).toEqual({
			checkpointId: REQUEST.checkpointId, checkpointGoal: REQUEST.checkpointGoal,
			sourceSessionId: REQUEST.sourceSessionId, checkpointSequence: REQUEST.checkpointSequence,
			expectedSourceHeadSequence: REQUEST.expectedSourceHeadSequence, report: REQUEST.report,
		});
		expect(expectedRevision).toBe(REQUEST.expectedCatalogRevision);
	});

	it("rejects malformed reverse payload before issuing a session command", async () => {
		const mode = new InteractiveMode({ controller: new ContractController({ supportedOperations: ["session.rewind"] }), terminal: new ContractTerminal() });
		await expect(mode.handleSessionReverseRequest(frame({ ...encodeRewindRequest(REQUEST), report: "" }), new AbortController().signal))
			.resolves.toEqual({ ok: false, code: "reverse_request_invalid" });
	});
});
