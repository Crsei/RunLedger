import { describe, expect, it } from "vitest";
import { createRuntimeId, runtimeDigest } from "../../src/runtime/contracts/public.ts";

describe("request_permissions grant lifecycle", () => {
	it("consumes one_off exactly once and expires turn grants at the turn boundary", async () => {
		const module = await import("../../src/security/permission/grants.ts").catch(() => undefined);
		const store = module === undefined ? undefined : new module.MemoryPermissionGrantStore();
		const sessionId = createRuntimeId("session", "grant-session");
		const turnId = createRuntimeId("turn", "grant-turn");
		const policyDigest = runtimeDigest("grant-policy");
		const requests = [{ kind: "filesystem" as const, operation: "write" as const, path: "/repo/file" }];
		await store?.issue({ scope: "one_off", sessionId, turnId, policyDigest, requests });
		expect(await store?.authorize({ sessionId, turnId, policyDigest, requests })).toMatchObject({ scope: "one_off" });
		expect(await store?.authorize({ sessionId, turnId, policyDigest, requests })).toBeUndefined();

		await store?.issue({ scope: "turn", sessionId, turnId, policyDigest, requests });
		expect(await store?.authorize({ sessionId, turnId, policyDigest, requests })).toMatchObject({ scope: "turn" });
		await store?.endTurn(sessionId, turnId);
		expect(await store?.authorize({ sessionId, turnId, policyDigest, requests })).toBeUndefined();
	});

	it("binds session grants to the session and invalidates them on policy digest change", async () => {
		const module = await import("../../src/security/permission/grants.ts").catch(() => undefined);
		const store = module === undefined ? undefined : new module.MemoryPermissionGrantStore();
		const sessionId = createRuntimeId("session", "grant-session");
		const otherSessionId = createRuntimeId("session", "grant-other-session");
		const turnId = createRuntimeId("turn", "grant-turn");
		const nextTurnId = createRuntimeId("turn", "grant-next-turn");
		const policyDigest = runtimeDigest("grant-policy");
		const requests = [{ kind: "network" as const, operation: "fetch" as const, host: "api.example", protocol: "https" as const }];
		await store?.issue({ scope: "session", sessionId, turnId, policyDigest, requests });
		expect(await store?.authorize({ sessionId, turnId: nextTurnId, policyDigest, requests })).toMatchObject({ scope: "session" });
		expect(await store?.authorize({ sessionId: otherSessionId, turnId: nextTurnId, policyDigest, requests })).toBeUndefined();
		expect(await store?.authorize({ sessionId, turnId: nextTurnId, policyDigest: runtimeDigest("changed-policy"), requests })).toBeUndefined();
	});
});
