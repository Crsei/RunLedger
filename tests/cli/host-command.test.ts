import { describe, expect, it } from "vitest";
import { parseHostCommand } from "../../src/cli/host-command.ts";

describe("Host management CLI", () => {
	it("parses list and status without starting an interactive session", () => {
		expect(parseHostCommand(["list", "--json"])).toEqual({ ok: true, command: { action: "list", json: true, confirmActive: false, force: false } });
		expect(parseHostCommand(["status", "--workspace-key", `ws-${"a".repeat(64)}`])).toEqual({
			ok: true,
			command: { action: "status", workspaceKey: `ws-${"a".repeat(64)}`, json: false, confirmActive: false, force: false },
		});
	});

	it("keeps active-work confirmation separate from unreachable force", () => {
		expect(parseHostCommand(["restart", "--confirm-active", "--force"])).toEqual({
			ok: true,
			command: { action: "restart", json: false, confirmActive: true, force: true },
		});
	});

	it("rejects unknown actions and invalid workspace keys", () => {
		expect(parseHostCommand(["destroy"])).toEqual({ ok: false, error: "unsupported host action: destroy" });
		expect(parseHostCommand(["stop", "--workspace-key", "bad"])).toEqual({ ok: false, error: "invalid workspace key" });
	});
});
