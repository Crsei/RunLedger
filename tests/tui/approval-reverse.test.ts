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

	it("encodes session, exec-prefix, and exact network amendment payloads", () => {
		expect(approvalDecisionBody({ decision: "allow-session" } as never)).toEqual({ ok: true, decision: "allow-session" });
		expect(approvalDecisionBody({ decision: "allow-with-prefix-rule", prefixRule: ["npm", "test"] } as never)).toEqual({
			ok: true,
			decision: "allow-with-prefix-rule",
			prefixRule: ["npm", "test"],
		});
		expect(approvalDecisionBody({ decision: "allow-with-network-rule", host: "api.example", protocol: "https", port: 8443 } as never)).toEqual({
			ok: true,
			decision: "allow-with-network-rule",
			host: "api.example",
			protocol: "https",
			port: 8443,
		});
	});

	it("projects popup choices only from exact shell or network requests", async () => {
		const module = await import("../../src/tui/approval.ts") as typeof import("../../src/tui/approval.ts") & {
			approvalChoices?: (view: unknown) => readonly { readonly decision: Record<string, unknown>; readonly label: string }[];
		};
		const shellView = parseApprovalReverseRequest({
			requestType: "permission",
			toolName: "bash",
			summary: "run tests",
			requests: [{ kind: "shell", command: "npm test", cwd: "/workspace", analysis: "known" }],
		});
		const networkView = parseApprovalReverseRequest({
			requestType: "permission",
			toolName: "WebFetch",
			summary: "fetch API",
			requests: [{ kind: "network", operation: "fetch", host: "API.Example.", protocol: "https", port: 8443 }],
		});
		expect(module.approvalChoices?.(shellView)).toEqual(expect.arrayContaining([
			expect.objectContaining({ decision: { decision: "allow-session" } }),
			expect.objectContaining({ decision: { decision: "allow-with-prefix-rule", prefixRule: ["npm", "test"] } }),
		]));
		expect(module.approvalChoices?.(networkView)).toEqual(expect.arrayContaining([
			expect.objectContaining({ decision: { decision: "allow-with-network-rule", host: "api.example", protocol: "https", port: 8443 } }),
		]));
	});
});
