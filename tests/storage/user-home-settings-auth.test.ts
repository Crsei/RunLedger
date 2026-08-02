import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AuthStorage, readStoredCredential } from "../../src/storage/auth-storage.ts";
import {
	loadProjectSettings,
	saveProjectSettings,
	type ProjectSettings,
} from "../../src/storage/settings-manager.ts";
import { buildRunledgerLayout, type RunledgerLayout } from "../../src/runtime/contracts/storage-layout.ts";

const cleanup: string[] = [];

afterEach(() => {
	for (const directory of cleanup.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture(): { cwd: string; layout: RunledgerLayout } {
	const cwd = mkdtempSync(join(tmpdir(), "runledger-home-storage-"));
	cleanup.push(cwd);
	return { cwd, layout: buildRunledgerLayout(join(cwd, "home"), "posix") };
}

describe("canonical user-home settings", () => {
	it("只从注入的 home settings 读取，不把旧项目 settings 当作 authority", async () => {
		const { cwd, layout } = fixture();
		mkdirSync(join(cwd, ".runledger"), { recursive: true });
		writeFileSync(
			join(cwd, ".runledger", "settings.json"),
			JSON.stringify({ model: "legacy-model", sessionDir: "/legacy" }),
			"utf8",
		);
		mkdirSync(layout.home, { recursive: true });
		writeFileSync(layout.settings, JSON.stringify({ model: "canonical-model" }), "utf8");

		expect(await loadProjectSettings({ layout })).toEqual({ model: "canonical-model" });
	});

	it("支持固定的 workspace settings locator，而不是任意目录", async () => {
		const { layout } = fixture();
		await saveProjectSettings(
			{ layout, workspaceKey: "ws-fixture" },
			{ provider: "fixture", model: "model" },
		);

		expect(await loadProjectSettings({ layout, workspaceKey: "ws-fixture" })).toEqual({
			provider: "fixture",
			model: "model",
		});
		expect(existsSync(join(layout.projects, "ws-fixture", "settings.json"))).toBe(true);
	});

	it("收到 sessionDir 时结构化拒绝且不修改既有目标", async () => {
		const { layout } = fixture();
		await saveProjectSettings({ layout }, { model: "before" });
		const before = readFileSync(layout.settings, "utf8");
		const legacyInput = { model: "after", sessionDir: "/outside" } as unknown as ProjectSettings;

		await expect(saveProjectSettings({ layout }, legacyInput)).rejects.toMatchObject({
			code: "unsupported_setting",
			field: "sessionDir",
		});
		expect(readFileSync(layout.settings, "utf8")).toBe(before);
	});
});

describe("canonical user-home auth", () => {
	it("AuthStorage 只写入注入 layout.auth，不创建旧 agent-dir 文件", async () => {
		const { cwd, layout } = fixture();
		const auth = AuthStorage.create(layout);
		await auth.modify("fixture", async () => ({ type: "api_key", key: "secret" }));

		expect(existsSync(layout.auth)).toBe(true);
		expect(readStoredCredential("fixture", layout)).toEqual({ type: "api_key", key: "secret" });
		expect(existsSync(join(cwd, ".runledger", "agent", "auth.json"))).toBe(false);
	});
});
