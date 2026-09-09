import { describe, expect, it, vi } from "vitest";
import type { OwnedSessionHandle } from "../../src/cli/session-client.ts";
import { SessionInteractiveController } from "../../src/cli/session-interactive-controller.ts";
import { standardHarnessProfileRef } from "../../src/runtime/harness-profiles/index.ts";
import type { SessionClientTransport } from "../../src/runtime/session-server/client-transport.ts";
import type { SessionFrameEnvelope } from "../../src/runtime/session-server/protocol.ts";

describe("Session permission event subscription", () => {
	it("acknowledges the last apply event despite a failing view and retains the effective profile for late views", () => {
		let listener!: (frame: SessionFrameEnvelope) => void;
		const notify = vi.fn();
		const transport = { onEvent: (callback: typeof listener) => { listener = callback; return () => undefined; }, notify } as unknown as SessionClientTransport;
		const controller = new SessionInteractiveController({ transport, generation: 1 } as unknown as OwnedSessionHandle, {
			sessionId: "session_permission-events", harnessProfile: standardHarnessProfileRef(), permissionProfile: "workspace-write",
			messages: [], warnings: [], auditEntries: [], selection: { thinkingLevel: "off" }, toolCount: 0, eventCursor: 4, driverRevision: 0,
		});
		const received: string[] = [];
		try {
			controller.subscribePermissionProfile((profile) => { if (profile === "danger-full-access") throw new Error("view failure"); });
			controller.subscribePermissionProfile((profile) => received.push(profile));
			const frame: SessionFrameEnvelope = { protocolVersion: 3, kind: "subscription_event", frameId: "event-permission", body: {
				eventType: "session.security.update", sequence: 5, payload: { stage: "applied", profile: "danger-full-access", toRevision: 2 },
			} };
			listener(frame);
			expect(received).toEqual(["workspace-write", "danger-full-access"]);
			expect(notify).toHaveBeenCalledWith(expect.objectContaining({ kind: "ack_cursor", body: { cursor: 5 } }));
			listener(frame);
			expect(received).toHaveLength(2);
			const late = vi.fn(); controller.subscribePermissionProfile(late);
			expect(late).toHaveBeenCalledWith("danger-full-access");
		} finally { controller.dispose(); }
	});
});
