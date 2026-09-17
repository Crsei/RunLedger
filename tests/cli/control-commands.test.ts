import { describe, expect, it } from "vitest";
import {
	controlCommandBody,
	controlCommandHelp,
	controlCommandRequest,
	controlCommandQueryOperation,
	parseControlCommand,
	type ControlCommand,
} from "../../src/cli/control-commands.ts";

describe("Host control command parsing", () => {
	it.each([
		[{ group: "security", action: "inspect", args: [], mutation: false }, "session.security.inspect"],
		[{ group: "plugin", action: "reload", args: [], mutation: true }, "extension.reload"],
	] satisfies readonly (readonly [ControlCommand, string])[])("maps %j to %s", (command, operation) => {
		expect(controlCommandRequest(command).operation).toBe(operation);
	});

	it("accepts the documented remember text and preserves the explicit propose spelling", () => {
		for (const words of [["remember", "Keep", "release", "checks"], ["remember", "propose", "Keep", "release", "checks"]]) {
			const parsed = parseControlCommand(words);
			expect(parsed).toEqual({ ok: true, command: { group: "remember", action: "propose", args: ["Keep", "release", "checks"], mutation: true } });
			if (parsed?.ok) expect(controlCommandRequest(parsed.command).body.content).toBe("Keep release checks");
		}
		expect(parseControlCommand(["remember"])).toMatchObject({ ok: false, error: expect.stringContaining("proposal text") });
	});

	it("classifies MCP restart as a fenced mutation", () => {
		expect(parseControlCommand(["mcp", "restart", "missing-server"])).toMatchObject({ ok: true, command: { mutation: true } });
	});

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

	it("lets the Owner capture history and accepts only known strategy flags", () => {
		expect(parseControlCommand(["compact", "run"])).toMatchObject({ ok: true });
		expect(parseControlCommand(["compact", "run", "--strategy=handoff"])).toMatchObject({ ok: true });
		expect(controlCommandRequest({ group: "compact", action: "run", args: ["--strategy=handoff"], mutation: true })).toMatchObject({ operation: "compact.run", body: { strategy: "handoff" } });
		expect(controlCommandRequest({ group: "compact", action: "list", args: [], mutation: false })).toEqual({ operation: "compaction.list", body: {}, mutation: false });
		expect(parseControlCommand(["compact", "run", "--strategy=unknown"])).toMatchObject({ ok: false });
		expect(controlCommandRequest({ group: "compact", action: "run", args: ["--strategy=hierarchical", "pending", "work"], mutation: true })).toEqual({ operation: "compact.run", body: { strategy: "hierarchical", focus: "pending work" }, mutation: true });
	});

	it("derives Host domain and Plan revisions from a read before mutation", () => {
		const command: ControlCommand = { group: "plan", action: "write", args: ["#", "next"], mutation: true };
		expect(controlCommandQueryOperation(command)).toBe("plan.inspect");
		expect(controlCommandBody(command, 7, { state: { revision: 3, plan: { revision: 1 } } })).toEqual({
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
		expect(list?.ok && controlCommandRequest(list.command)).toEqual({ operation: "skill.provider.list", body: {}, mutation: false });
		const enable = parseControlCommand(["skill", "provider", "enable", "runledger-user"]);
		expect(enable?.ok && controlCommandRequest(enable.command)).toEqual({ operation: "skill.provider.enable", body: { providerId: "runledger-user" }, mutation: true });
		const workspaceDisable = parseControlCommand(["skill", "provider", "disable", "codex-user", "--scope=workspace"]);
		expect(workspaceDisable?.ok && controlCommandRequest(workspaceDisable.command)).toEqual({ operation: "skill.provider.disable", body: { providerId: "codex-user", scope: "workspace" }, mutation: true });
		const trust = parseControlCommand(["skill", "trust", "skill:user:abc:review"]);
		expect(trust?.ok && controlCommandRequest(trust.command)).toEqual({ operation: "skill.trust", body: { skillId: "skill:user:abc:review" }, mutation: true });
		expect(controlCommandQueryOperation({ group: "skill", action: "trust", args: ["x"], mutation: true })).toBe("skill.list");
		expect(controlCommandQueryOperation({ group: "skill", action: "provider", args: ["list"], mutation: false })).toBeUndefined();
	});
});

describe("Host control command distribution vocabulary", () => {
	it("maps plugin distribution actions to the P5 operations", () => {
		const cases: readonly (readonly [readonly string[], string, boolean])[] = [
			[["plugin", "distribution"], "plugin.distribution.list", false],
			[["plugin", "doctor"], "plugin.doctor", false],
			[["marketplace"], "marketplace.discover", false],
			[["marketplace", "discover"], "marketplace.discover", false],
			[["plugin", "install", "alpha@local"], "plugin.install", true],
			[["plugin", "upgrade", "alpha@local"], "plugin.upgrade", true],
			[["plugin", "uninstall", "alpha@local"], "plugin.uninstall", true],
			[["plugin", "link", "dev", "/tmp/dev"], "plugin.link", true],
			[["marketplace", "add", "local", "local", "/tmp/mkt"], "marketplace.add", true],
			[["marketplace", "remove", "local"], "marketplace.remove", true],
			[["marketplace", "update", "local"], "marketplace.update", true],
			[["marketplace", "upgrade", "local"], "marketplace.upgrade", true],
		];
		for (const [words, operation, mutation] of cases) {
			const parsed = parseControlCommand(words as readonly string[]);
			expect(parsed?.ok, words.join(" ")).toBe(true);
			if (parsed === undefined || !parsed.ok) continue;
			expect(parsed.command.mutation, words.join(" ")).toBe(mutation);
			expect(controlCommandRequest(parsed.command).operation, words.join(" ")).toBe(operation);
		}
	});

	it("builds bounded bodies and rejects raw positional text", () => {
		const install = parseControlCommand(["plugin", "install", "alpha@local", "--scope=workspace"]);
		expect(install?.ok).toBe(true);
		if (install !== undefined && install.ok) {
			expect(controlCommandRequest(install.command).body).toEqual({ spec: "alpha@local" });
		}
		const link = parseControlCommand(["plugin", "link", "dev", "/tmp/dev"]);
		if (link !== undefined && link.ok) expect(controlCommandRequest(link.command).body).toEqual({ pluginId: "dev", localPath: "/tmp/dev" });
		const add = parseControlCommand(["marketplace", "add", "local", "local", "/tmp/mkt"]);
		if (add !== undefined && add.ok) {
			expect(controlCommandRequest(add.command).body).toEqual({ name: "local", sourceType: "local", sourceUri: "/tmp/mkt" });
		}
		const upgrade = parseControlCommand(["marketplace", "upgrade"]);
		if (upgrade !== undefined && upgrade.ok) expect(controlCommandRequest(upgrade.command).body).toEqual({});
	});

	it("requires the documented arguments and a valid scope", () => {
		expect(parseControlCommand(["plugin", "install"])).toMatchObject({ ok: false, error: /install spec/i });
		expect(parseControlCommand(["plugin", "link", "dev"])).toMatchObject({ ok: false, error: /local path/i });
		expect(parseControlCommand(["plugin", "uninstall"])).toMatchObject({ ok: false, error: /plugin id/i });
		expect(parseControlCommand(["marketplace", "add", "local"])).toMatchObject({ ok: false, error: /name, source type and source uri/i });
		expect(parseControlCommand(["marketplace", "remove"])).toMatchObject({ ok: false, error: /marketplace name/i });
		expect(parseControlCommand(["plugin", "install", "alpha", "--scope=root"])).toMatchObject({ ok: false, error: /scope must be user or workspace/i });
		expect(parseControlCommand(["marketplace", "bogus"])).toMatchObject({ ok: false, error: /unsupported marketplace action/i });
	});

	it("takes the mutation revision from the distribution ledger, not the declarative snapshot", () => {
		const install = parseControlCommand(["plugin", "install", "alpha@local"]);
		if (install !== undefined && install.ok) expect(controlCommandQueryOperation(install.command)).toBe("plugin.distribution.list");
		const remove = parseControlCommand(["marketplace", "remove", "local"]);
		if (remove !== undefined && remove.ok) expect(controlCommandQueryOperation(remove.command)).toBe("marketplace.discover");
		// 声明式读仍旧走 plugin.list，避免把两种账本混成一个 revision 来源。
		const list = parseControlCommand(["plugin", "list"]);
		if (list !== undefined && list.ok) expect(controlCommandQueryOperation(list.command)).toBeUndefined();
	});

	it("documents the distribution and marketplace verbs in the help text", () => {
		const help = controlCommandHelp();
		expect(help).toContain("runledger plugin install");
		expect(help).toContain("runledger marketplace discover");
		expect(help).toContain("enable and trust stay separate decisions");
	});
});

describe("Host control command plugin config vocabulary", () => {
	it("maps config read and set to the two operations", () => {
		const read = parseControlCommand(["plugin", "config"]);
		expect(read?.ok).toBe(true);
		if (read !== undefined && read.ok) {
			expect(read.command.mutation).toBe(false);
			expect(controlCommandRequest(read.command).operation).toBe("plugin.config.read");
		}
		const explicit = parseControlCommand(["plugin", "config", "read"]);
		if (explicit !== undefined && explicit.ok) expect(controlCommandRequest(explicit.command).operation).toBe("plugin.config.read");

		const set = parseControlCommand(["plugin", "config", "set", "alpha@local", "theme", "dark"]);
		expect(set?.ok).toBe(true);
		if (set !== undefined && set.ok) {
			expect(set.command.mutation).toBe(true);
			const request = controlCommandRequest(set.command);
			expect(request.operation).toBe("plugin.config.write");
			// 值原样以字符串送出：类型/范围/枚举校验由声明式 schema 负责。
			expect(request.body).toEqual({ pluginId: "alpha@local", values: { theme: "dark" } });
		}
	});

	it("requires the documented config arguments", () => {
		expect(parseControlCommand(["plugin", "config", "bogus"])).toMatchObject({ ok: false, error: /read\|set/i });
		expect(parseControlCommand(["plugin", "config", "set", "alpha@local", "theme"])).toMatchObject({ ok: false, error: /setting name and a value/i });
	});

	it("takes the config mutation revision from the distribution ledger", () => {
		const set = parseControlCommand(["plugin", "config", "set", "alpha@local", "theme", "dark"]);
		if (set !== undefined && set.ok) expect(controlCommandQueryOperation(set.command)).toBe("plugin.distribution.list");
	});
});
