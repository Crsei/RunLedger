/** Legacy paths 单测 —— 只验证 source metadata locator，不验证 canonical 写入 authority。 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	getAgentDir,
	getBinDir,
	getDefaultUserSessionDirForCwd,
	getGlobalAgentsMd,
	getProjectDir,
	getProjectSessionsDir,
	getProjectSettingsPath,
	getUserSessionsDir,
	normalizePath,
} from "../../src/storage/paths.ts";

const ORIGINAL_RUNLEDGER_DIR = process.env.RUNLEDGER_DIR;

beforeEach(() => {
	delete process.env.RUNLEDGER_DIR;
});

afterEach(() => {
	if (ORIGINAL_RUNLEDGER_DIR === undefined) delete process.env.RUNLEDGER_DIR;
	else process.env.RUNLEDGER_DIR = ORIGINAL_RUNLEDGER_DIR;
});

function posix(value: string): string {
	return value.replace(/[\\/]/g, "/");
}

describe("normalizePath", () => {
	it("展开 ~/ 至 homedir", () => {
		expect(normalizePath("~/foo")).toContain("foo");
		expect(normalizePath("~/foo")).not.toContain("~");
	});

	it("非 ~ 路径原样返回", () => {
		expect(normalizePath("/abs/path")).toBe("/abs/path");
	});
});

describe("legacy user source locators", () => {
	it("getAgentDir 默认指向历史 ~/.runledger/agent", () => {
		expect(posix(getAgentDir()).endsWith(".runledger/agent")).toBe(true);
	});

	it("RUNLEDGER_DIR 只影响显式 legacy source locator", () => {
		process.env.RUNLEDGER_DIR = "/tmp/custom-rl";
		expect(posix(getAgentDir())).toBe("/tmp/custom-rl");
		expect(posix(getBinDir())).toBe("/tmp/custom-rl/bin");
		expect(posix(getUserSessionsDir())).toBe("/tmp/custom-rl/sessions");
		expect(posix(getGlobalAgentsMd())).toBe("/tmp/custom-rl/AGENTS.md");
	});

	it("cwd encoded source locator 只用于迁移输入", () => {
		process.env.RUNLEDGER_DIR = "/tmp/rl";
		expect(posix(getDefaultUserSessionDirForCwd("/home/foo/proj"))).toBe(
			"/tmp/rl/sessions/--home-foo-proj--",
		);
	});
});

describe("legacy project source locators", () => {
	it("getProjectDir 接受自定义 cwd", () => {
		expect(posix(getProjectDir("/x/y"))).toBe("/x/y/.runledger");
	});

	it("settings 与 sessions source locator 都位于历史 .runledger", () => {
		expect(posix(getProjectSettingsPath("/x/y"))).toBe("/x/y/.runledger/settings.json");
		expect(posix(getProjectSessionsDir("/x/y"))).toBe("/x/y/.runledger/sessions");
	});
});
