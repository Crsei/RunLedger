import { describe, expect, it } from "vitest";
import { createRuntimeId, runtimeDigest } from "../../src/runtime/contracts/public.ts";

describe("request_permissions tool", () => {
	it("delegates grant creation to the injected governed port", async () => {
		const module = await import("../../src/security/tools/request-permissions.ts").catch(() => undefined);
		let received: unknown;
		const grant = {
			grantId: "permissionGrant_test",
			scope: "turn" as const,
			sessionId: createRuntimeId("session", "request-permissions"),
			turnId: createRuntimeId("turn", "request-permissions"),
			policyDigest: runtimeDigest("request-permissions"),
			requestsDigest: runtimeDigest("requests"),
			issuedAt: "2026-08-11T00:00:00.000Z",
		};
		const tool = module?.createRequestPermissionsTool({
			request: async (input) => { received = input; return { ok: true, value: grant }; },
		});
		const result = await tool?.execute("toolCall_request-permissions", {
			scope: "turn",
			permissions: { filesystem: [{ path: "/repo/generated", access: "write" }] },
		});
		expect(received).toEqual({
			toolCallId: "toolCall_request-permissions",
			scope: "turn",
			permissions: { filesystem: [{ path: "/repo/generated", access: "write" }] },
		});
		expect(result).toMatchObject({ details: { ok: true, scope: "turn" }, content: [{ type: "text" }] });
	});

	it("fails closed without a governed port instead of creating a local grant", async () => {
		const module = await import("../../src/security/tools/request-permissions.ts").catch(() => undefined);
		const tool = module?.createRequestPermissionsTool();
		const result = await tool?.execute("toolCall_request-permissions", {
			scope: "session",
			permissions: { network: [{ host: "api.example", protocol: "https", access: "allow" }] },
		});
		expect(result).toMatchObject({ details: { ok: false, code: "governed_port_unavailable" } });
	});
});
