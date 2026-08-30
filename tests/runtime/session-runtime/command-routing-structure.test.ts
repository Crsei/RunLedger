import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SESSION_COMMAND_KINDS, SESSION_COMMAND_ROUTE_GROUPS } from "../../../src/runtime/session-runtime/command-routes.ts";

const expectedKinds = [
	"prompt",
	"steer",
	"follow_up",
	"clear_queues",
	"provider_status",
	"models",
	"select_model",
	"set_thinking",
	"editor_activity",
	"logout",
	"login",
	"domain_query",
	"domain_command",
	"recovery_explain",
	"recovery_assess",
	"recovery_verify",
	"recovery_abort",
	"recovery_resume",
	"interrupt",
] as const;

describe("session command routing structure", () => {
	it("registers every supported command exactly once across narrow route groups", () => {
		const routedKinds = Object.values(SESSION_COMMAND_ROUTE_GROUPS).flat();

		expect([...SESSION_COMMAND_KINDS].sort()).toEqual([...expectedKinds].sort());
		expect([...routedKinds].sort()).toEqual([...expectedKinds].sort());
		expect(new Set(routedKinds).size).toBe(routedKinds.length);
		expect(Object.values(SESSION_COMMAND_ROUTE_GROUPS).every((group) => group.length <= 6)).toBe(true);
	});

	it("keeps the facade table-driven instead of retaining the migrated giant switch", () => {
		const sourcePath = fileURLToPath(new URL("../../../src/runtime/session-runtime/command-handler.ts", import.meta.url));
		const source = readFileSync(sourcePath, "utf8");

		expect(source).not.toMatch(/switch\s*\(\s*request\.kind\s*\)/u);
		expect(source).toContain("createSessionCommandRoutes");
	});
});
