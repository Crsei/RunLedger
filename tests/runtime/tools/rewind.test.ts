import { describe, expect, it } from "vitest";
import { Value } from "typebox/value";
import { createRuntimeId } from "../../../src/runtime/protocol/ids.ts";
import { createRewindTool, rewindSchema } from "../../../src/runtime/tools/rewind.ts";
import {
	CHECKPOINT_REWIND_REQUEST_KIND,
	createReverseRequestRewindPort,
	decodeRewindRequest,
	encodeRewindRequest,
	type RewindDriverRequest,
} from "../../../src/runtime/session-runtime/rewind-reverse-request.ts";
import type { ReverseRequestSender } from "../../../src/runtime/session-runtime/credential-reverse-request.ts";
import { SESSION_PROTOCOL_VERSION, type SessionFrameEnvelope } from "../../../src/runtime/session-server/protocol.ts";

const REQUEST: RewindDriverRequest = {
	checkpointId: createRuntimeId("snapshot", "rewind-tool"), checkpointGoal: "Before refactor",
	sourceSessionId: createRuntimeId("session", "rewind-tool"), checkpointSequence: 5,
	expectedSourceHeadSequence: 8, expectedCatalogRevision: 3, report: "Continue from the safer approach.",
};

describe("rewind tool and reverse request", () => {
	it("uses a bounded closed schema", () => {
		expect(Value.Check(rewindSchema, { checkpoint: REQUEST.checkpointId, report: REQUEST.report })).toBe(true);
		expect(Value.Check(rewindSchema, { checkpoint: REQUEST.checkpointId, report: "", extra: true })).toBe(false);
	});

	it("round-trips the driver request and does not wait without a driver", async () => {
		expect(decodeRewindRequest(encodeRewindRequest(REQUEST))).toEqual(REQUEST);
		expect(decodeRewindRequest({ ...REQUEST, report: "" })).toBeUndefined();
		const port = createReverseRequestRewindPort({
			sender: { requestToConnection: async () => { throw new Error("must not send"); } } as ReverseRequestSender,
			connectionId: () => undefined,
		});
		expect(await port.request(REQUEST)).toEqual({ ok: false, code: "reverse_request_unhandled" });
	});

	it("forwards a successful driver response through the tool", async () => {
		let sentKind: string | undefined;
		const sender: ReverseRequestSender = {
			async requestToConnection(_connection, request): Promise<SessionFrameEnvelope> {
				sentKind = request.kind;
				return { frameId: "reverse_response_1", kind: "reverse_response", protocolVersion: SESSION_PROTOCOL_VERSION, body: { ok: true, targetSessionId: createRuntimeId("session", "rewound") } };
			},
		};
		const port = createReverseRequestRewindPort({ sender, connectionId: createRuntimeId("connection", "driver") });
		const tool = createRewindTool({ create: async () => ({ ok: false, code: "not_called" }), rewind: async () => port.request(REQUEST) });
		const result = await tool.execute("tool-rewind", { checkpoint: REQUEST.checkpointId, report: REQUEST.report });
		expect(sentKind).toBe(CHECKPOINT_REWIND_REQUEST_KIND);
		expect(result).toMatchObject({ details: { ok: true, targetSessionId: createRuntimeId("session", "rewound") } });
	});
});
