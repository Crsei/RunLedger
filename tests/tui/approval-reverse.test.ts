import { describe, expect, it } from "vitest";
import { approvalDecisionBody, parseApprovalReverseRequest } from "../../src/tui/approval.ts";

describe("TUI approval reverse request projection", () => {
	it("accepts only bounded permission prompts and exposes safe display fields", () => {
		expect(parseApprovalReverseRequest({
			requestType: "permission",
			toolName: "bash",
			summary: "write workspace file",
			cwd: "/workspace",
			expiresAt: "2026-08-05T00:01:00.000Z",
		})).toEqual({
			toolName: "bash",
			summary: "write workspace file",
			cwd: "/workspace",
			expiresAt: "2026-08-05T00:01:00.000Z",
		});
	});

	it("rejects unknown or oversized reverse payloads and encodes explicit decisions", () => {
		expect(parseApprovalReverseRequest({ requestType: "unknown", summary: "x" })).toBeUndefined();
		expect(parseApprovalReverseRequest({ requestType: "permission", summary: "x".repeat(513) })).toBeUndefined();
		expect(approvalDecisionBody("allow-once")).toEqual({ ok: true, decision: "allow-once" });
		expect(approvalDecisionBody("deny")).toEqual({ ok: true, decision: "deny" });
		expect(approvalDecisionBody("cancel")).toEqual({ ok: true, decision: "cancel" });
	});
});
