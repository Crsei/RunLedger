import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { rmSyncRetry } from "../helpers/cleanup.ts";

const CLI_PATH = resolve("src/cli/cli.ts");
const TSX_LOADER = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSyncRetry(root);
});

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "runledger-control-cli-"));
	roots.push(root);
	const home = join(root, "state");
	const userHome = join(root, "user");
	const workspace = join(root, "workspace");
	for (const directory of [home, userHome, workspace]) mkdirSync(directory, { mode: 0o700 });
	const env = {
		PATH: process.env.PATH,
		SystemRoot: process.env.SystemRoot,
		HOME: userHome,
		USERPROFILE: userHome,
		RUNLEDGER_DIR: home,
		XDG_CONFIG_HOME: join(root, "config"),
		XDG_DATA_HOME: join(root, "data"),
		XDG_CACHE_HOME: join(root, "cache"),
		XDG_RUNTIME_DIR: root,
	};
	return {
		home,
		run: (args: string[]) => {
			const result = spawnSync(process.execPath, ["--import", TSX_LOADER, CLI_PATH, ...args], {
				cwd: workspace, env, encoding: "utf8", timeout: 20_000, input: "",
			});
			expect(result.error, result.stderr).toBeUndefined();
			expect(result.stdout, result.stderr).not.toBe("");
			return { status: result.status, body: JSON.parse(result.stdout) as Record<string, unknown> };
		},
	};
}

describe("source CLI control command production dispatch", () => {
	it("executes security inspection and extension reload through the published operations", () => {
		const { run } = fixture();
		expect(run(["security", "inspect"])).toMatchObject({ status: 0, body: { ok: true, operation: "session.security.inspect" } });
		expect(run(["plugin", "reload"])).toMatchObject({ status: 0, body: { ok: true, operation: "extension.reload" } });
	}, 40_000);

	it("persists provider enable and disable mutations in the supported user scope", () => {
		const { home, run } = fixture();
		expect(run(["skill", "provider", "disable", "runledger-user", "--scope", "user"])).toMatchObject({ status: 0, body: { ok: true, operation: "skill.provider.disable" } });
		const settingsPath = join(home, "settings.json");
		expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toMatchObject({ skills: { providers: { "runledger-user": false } } });
		expect(run(["skill", "provider", "enable", "runledger-user", "--scope=user"])).toMatchObject({ status: 0, body: { ok: true, operation: "skill.provider.enable" } });
		expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toMatchObject({ skills: { providers: { "runledger-user": true } } });
	}, 40_000);

	it("rejects unsupported workspace scope without silently changing user policy", () => {
		const { home, run } = fixture();
		expect(run(["skill", "provider", "disable", "runledger-user", "--scope=workspace"])).toMatchObject({ status: 1, body: { ok: false, operation: "skill.provider.disable" } });
		expect(existsSync(join(home, "settings.json"))).toBe(false);
	});

	it("returns a failure exit code for query, prerequisite and mutation failures", () => {
		const { run } = fixture();
		// plan reenter/export 在无工件的会话上是真实的前置失败；plan enter 现在可用，单独断言。
		for (const args of [["memory", "search", "missing"], ["memory", "revoke", "missing"], ["plan", "reenter"], ["plan", "export"], ["skill", "provider", "disable", "missing-provider"]]) {
			expect(run(args)).toMatchObject({ status: 1, body: { ok: false } });
		}
	}, 80_000);

	it("dispatches the plan lifecycle commands through the control command channel", () => {
		const { run } = fixture();
		// 每次 CLI 调用都是独立进程并通过 cwd 解析会话；空会话在退出时被回收，
		// 因此这里只断言单次调用的派发与前置语义，跨调用状态由 runtime 测试覆盖。
		expect(run(["plan", "enter"])).toMatchObject({ status: 0, body: { ok: true, operation: "plan.enter", value: { state: { status: "active", plan: { revision: 0 } } } } });
		expect(run(["plan", "inspect"])).toMatchObject({ status: 0, body: { ok: true, operation: "plan.inspect" } });
		expect(run(["plan", "list"])).toMatchObject({ status: 0, body: { ok: true, operation: "plan.list", value: { revisions: [] } } });
		// 没有活动工作流时 exit/cancel 是前置失败，不是静默成功。
		expect(run(["plan", "exit"])).toMatchObject({ status: 1, body: { ok: false } });
	}, 80_000);

	it("uses nonzero check status while keeping token status and successful checks usable", () => {
		const { home, run } = fixture();
		expect(run(["auth-gateway", "status", "--json"])).toMatchObject({ status: 0, body: { ok: true, token: { configured: false } } });
		expect(run(["auth-gateway", "check", "--json"])).toMatchObject({ status: 1, body: { ok: false } });
		writeFileSync(join(home, "auth-gateway.token"), `${"a".repeat(43)}\n`, { mode: 0o600 });
		expect(run(["auth-gateway", "check", "--json"])).toMatchObject({ status: 0, body: { ok: true } });
	}, 60_000);
});
