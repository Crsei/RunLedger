import { describe, expect, it } from "vitest";
import {
	controlCommandBody,
	controlCommandRequest,
	controlCommandQueryOperation,
	parseControlCommand,
	type ControlCommand,
} from "../../src/cli/control-commands.ts";

describe("Host control command parsing", () => {
	it("maps read-only resource and security commands to Host queries", () => {
		expect(parseControlCommand(["security", "inspect"])).toEqual({
			ok: true,
			command: { group: "security", action: "inspect", args: [], mutation: false },
		});
		expect(parseControlCommand(["plugin", "list"])).toEqual({
			ok: true,
			command: { group: "plugin", action: "list", args: [], mutation: false },
		});
		expect(parseControlCommand(["mcp"])).toEqual({
			ok: true,
			command: { group: "mcp", action: "list", args: [], mutation: false },
		});
	});

	it("requires explicit action arguments for mutating Host commands", () => {
		expect(parseControlCommand(["plugin", "trust", "plugin.example"])).toEqual({
			ok: true,
			command: { group: "plugin", action: "trust", args: ["plugin.example"], mutation: true },
		});
		expect(parseControlCommand(["worktree", "release", "confirm"])).toEqual({
			ok: true,
			command: { group: "worktree", action: "release", args: ["confirm"], mutation: true },
		});
		expect(parseControlCommand(["plugin", "trust"])).toMatchObject({ ok: false, error: /plugin id/i });
		expect(parseControlCommand(["unknown", "list"])).toBeUndefined();
	});

	it("produces bounded typed Host operation bodies without accepting raw command text", () => {
		const command: ControlCommand = { group: "plugin", action: "trust", args: ["plugin.example"], mutation: true };
		expect(controlCommandRequest(command)).toEqual({
			operation: "plugin.trust",
			body: { pluginId: "plugin.example" },
			mutation: true,
		});
		expect(controlCommandRequest({ group: "memory", action: "search", args: ["workspace rules"], mutation: false })).toEqual({
			operation: "memory.search",
			body: { query: "workspace rules" },
			mutation: false,
		});
	});

	it("maps plan approval and plan writes to the Host-owned operation contracts", () => {
		expect(controlCommandRequest({ group: "plan", action: "approve", args: ["approval_abc"], mutation: true })).toEqual({
			operation: "plan.resolve_approval",
			body: { approvalId: "approval_abc", decision: "approved" },
			mutation: true,
		});
		expect(controlCommandRequest({ group: "plan", action: "write", args: ["#", "new", "plan"], mutation: true })).toEqual({
			operation: "plan.write",
			body: { content: "# new plan" },
			mutation: true,
		});
	});

	it("requires destructive worktree release confirmation and maps remember to memory proposal", () => {
		expect(parseControlCommand(["worktree", "release"])).toMatchObject({ ok: false, error: /confirm/i });
		expect(parseControlCommand(["worktree", "release", "confirm"])).toMatchObject({ ok: true });
		expect(controlCommandRequest({ group: "worktree", action: "release", args: ["confirm"], mutation: true })).toEqual({
			operation: "worktree.release",
			body: { confirm: true },
			mutation: true,
		});
		const proposal = controlCommandRequest({ group: "remember", action: "propose", args: ["Keep", "the", "release", "check"], mutation: true });
		expect(proposal.operation).toBe("memory.propose");
		expect(proposal.body).toMatchObject({ title: "Keep the release check", content: "Keep the release check", scope: "workspace", sourceKind: "user" });
	});

	it("requires a bounded source range for manual compaction", () => {
		expect(parseControlCommand(["compact", "run", "transcript"])).toMatchObject({ ok: false, error: /source range/i });
		expect(parseControlCommand(["compact", "run", "{}", "transcript"])).toMatchObject({ ok: false, error: /source range/i });
	});

	it("derives Host domain and Plan revisions from a read before mutation", () => {
		const command: ControlCommand = { group: "plan", action: "write", args: ["#", "next"], mutation: true };
		expect(controlCommandQueryOperation(command)).toBe("plan.inspect");
		expect(controlCommandBody(command, 7, { state: { revision: 3, plan: { revision: 1 } } })).toEqual({
			expectedDomainRevision: 7,
			expectedRevision: 3,
			expectedPlanRevision: 1,
		content: "# next",
		});
		expect(controlCommandQueryOperation({ group: "memory", action: "approve", args: ["proposal_1", "{}"], mutation: true })).toBe("memory.inspect");
	});
});

describe("skill control commands", () => {
	it("parses skill provider list/enable/disable with scope and skill trust/untrust", () => {
		expect(parseControlCommand(["skill", "provider", "list"])).toEqual({
			ok: true,
			command: { group: "skill", action: "provider", args: ["list"], mutation: false },
		});
		expect(parseControlCommand(["skill", "provider", "enable", "runledger-user"])).toEqual({
			ok: true,
			command: { group: "skill", action: "provider", args: ["enable", "runledger-user"], mutation: true },
		});
		expect(parseControlCommand(["skill", "provider", "disable", "codex-user", "--scope=workspace"])).toEqual({
			ok: true,
			command: { group: "skill", action: "provider", args: ["disable", "codex-user", "--scope=workspace"], mutation: true },
		});
		expect(parseControlCommand(["skill", "trust", "skill:user:abc:review"])).toEqual({
			ok: true,
			command: { group: "skill", action: "trust", args: ["skill:user:abc:review"], mutation: true },
		});
		expect(parseControlCommand(["skill", "untrust", "skill:user:abc:review"])).toEqual({
			ok: true,
			command: { group: "skill", action: "untrust", args: ["skill:user:abc:review"], mutation: true },
		});
		expect(parseControlCommand(["skill", "provider", "enable"])).toMatchObject({ ok: false, error: /provider id/i });
		expect(parseControlCommand(["skill", "provider", "bogus"])).toMatchObject({ ok: false, error: /list\|enable\|disable/i });
		expect(parseControlCommand(["skill", "provider", "enable", "x", "--scope=root"])).toMatchObject({ ok: false, error: /scope must be user or workspace/i });
		expect(parseControlCommand(["skill", "trust"])).toMatchObject({ ok: false, error: /skill id/i });
	});

	it("maps skill requests to domain operations with bounded bodies", () => {
		const list = parseControlCommand(["skill", "provider", "list"]);
		expect(list.ok && controlCommandRequest(list.command)).toEqual({ operation: "skill.provider.list", body: {}, mutation: false });
		const enable = parseControlCommand(["skill", "provider", "enable", "runledger-user"]);
		expect(enable.ok && controlCommandRequest(enable.command)).toEqual({ operation: "skill.provider.enable", body: { providerId: "runledger-user" }, mutation: true });
		const workspaceDisable = parseControlCommand(["skill", "provider", "disable", "codex-user", "--scope=workspace"]);
		expect(workspaceDisable.ok && controlCommandRequest(workspaceDisable.command)).toEqual({ operation: "skill.provider.disable", body: { providerId: "codex-user", scope: "workspace" }, mutation: true });
		const trust = parseControlCommand(["skill", "trust", "skill:user:abc:review"]);
		expect(trust.ok && controlCommandRequest(trust.command)).toEqual({ operation: "skill.trust", body: { skillId: "skill:user:abc:review" }, mutation: true });
		expect(controlCommandQueryOperation({ group: "skill", action: "trust", args: ["x"], mutation: true })).toBe("skill.list");
		expect(controlCommandQueryOperation({ group: "skill", action: "provider", args: ["list"], mutation: false })).toBeUndefined();
	});
});
