import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { productionSessionTools } from "../../../src/runtime/session-runtime/domain.ts";
import { localExecutionEnv } from "../../../src/runtime/execution-env.ts";
import { createStdlibTools } from "../../../src/runtime/tools/index.ts";
import { SettingsResolver } from "../../../src/storage/settings-resolver.ts";
import type { SettingPath } from "../../../src/storage/settings-schema.ts";
import { MemoryLedger } from "../../../src/runtime/ledger/memory-ledger.ts";

describe("settings-driven tool gates", () => {
	it("omits disabled tools while preserving enabled tools and their option projection", () => {
		const resolver = new SettingsResolver({
			user: {
				tools: {
					read: { enabled: true, defaultLimit: 7 },
					bash: { enabled: false },
					grep: { enabled: false },
					lsp: { enabled: false, timeoutMs: 3_000 },
				},
			},
		});
		const runtime = resolver.effectiveRuntimeSnapshot();
		const tools = createStdlibTools("/workspace", { toolPolicy: runtime.toolPolicy });

		expect(runtime.toolPolicy.read).toMatchObject({ enabled: true, defaultLimit: 7 });
		expect(runtime.toolPolicy.bash).toMatchObject({ enabled: false });
		expect(runtime.toolPolicy.grep).toMatchObject({ enabled: false });
		expect(tools.get("read")).toBeDefined();
		expect(tools.get("bash")).toBeUndefined();
		expect(tools.get("grep")).toBeUndefined();

		const production = productionSessionTools(
			"/workspace",
			localExecutionEnv("/workspace"),
			undefined,
			undefined,
			{ getConfig: () => ({ servers: {} }) },
			runtime.toolPolicy,
		);
		expect(production.some((tool) => tool.name === "lsp")).toBe(false);
	});

	it("keeps unknown tool settings fail-closed", () => {
		const resolver = new SettingsResolver({
			user: { tools: { imaginary: { enabled: false } } },
		});

		expect(() => resolver.get("tools.imaginary.enabled" as SettingPath)).toThrow("unknown settings path");
		expect(resolver.diagnostics()).toEqual([]);
	});

	it("carries read.renderMarkdown through the production stdlib tool result", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "runledger-settings-read-"));
		writeFileSync(join(cwd, "README.md"), "# heading\n\nbody\n");
		const runtime = new SettingsResolver({
			user: { tools: { read: { renderMarkdown: true } } },
		}).effectiveRuntimeSnapshot();
		const read = createStdlibTools(cwd, { toolPolicy: runtime.toolPolicy }).get("read");

		expect(read).toBeDefined();
		const result = await read!.execute("read-settings", { path: "README.md", lineNumbers: false });

		expect(result.details).toMatchObject({ renderMarkdown: true });
	});

	it("carries bounded search default limits into grep, find, glob, and ls", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "runledger-settings-search-"));
		writeFileSync(join(cwd, "one.ts"), "needle\n");
		writeFileSync(join(cwd, "two.ts"), "needle\n");
		const baseEnv = localExecutionEnv(cwd);
		const shellCalls: string[] = [];
		const executionEnv = {
			...baseEnv,
			shell: {
				exec: async (command: string) => {
					shellCalls.push(command);
					if (command === "rg --version") return { stdout: "rg 1", stderr: "", exitCode: 0 };
					if (command.startsWith("rg ")) return { stdout: "one.ts:1:needle\ntwo.ts:1:needle\n", stderr: "", exitCode: 0 };
					if (command === "fd --version") return { stdout: "", stderr: "missing", exitCode: 127 };
					if (command.startsWith("find ")) return { stdout: "one.ts\ntwo.ts\n", stderr: "", exitCode: 0 };
					return { stdout: "", stderr: "", exitCode: 0 };
				},
			},
		};
		const runtime = new SettingsResolver({
			user: {
				tools: {
					grep: { defaultLimit: 1 },
					find: { defaultLimit: 1 },
					glob: { defaultLimit: 1 },
					ls: { defaultLimit: 1 },
				},
			},
		}).effectiveRuntimeSnapshot();
		const registry = createStdlibTools(cwd, { executionEnv, toolPolicy: runtime.toolPolicy });

		const grep = await registry.get("grep")!.execute("grep-settings", { pattern: "needle" });
		const find = await registry.get("find")!.execute("find-settings", { pattern: "*.ts" });
		const glob = await registry.get("glob")!.execute("glob-settings", { pattern: "*.ts" });
		const ls = await registry.get("ls")!.execute("ls-settings", {});

		expect(grep.details).toMatchObject({ matchLimitReached: 1 });
		expect(find.details).toMatchObject({ resultLimitReached: 1 });
		expect(glob.details).toMatchObject({ limitReached: true, matchCount: 1 });
		expect(ls.details).toMatchObject({ entryLimitReached: 1 });
		expect(shellCalls.find((command) => command.startsWith("rg ") && command !== "rg --version")).toContain("--max-count 1");
	});

	it("projects grep context defaults into the governed search command", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "runledger-settings-grep-context-"));
		const commands: string[] = [];
		const baseEnv = localExecutionEnv(cwd);
		const executionEnv = {
			...baseEnv,
			shell: {
				exec: async (command: string) => {
					commands.push(command);
					if (command === "rg --version") return { stdout: "rg 1", stderr: "", exitCode: 0 };
					return { stdout: "file.ts:1:needle\n", stderr: "", exitCode: 0 };
				},
			},
		};
		const runtime = new SettingsResolver({
			user: { tools: { grep: { contextBefore: 2, contextAfter: 3 } } },
		}).effectiveRuntimeSnapshot();

		const registry = createStdlibTools(cwd, { executionEnv, toolPolicy: runtime.toolPolicy });
		await registry.get("grep")!.execute("grep-context-settings", { pattern: "needle" });

		expect(runtime.toolPolicy.grep).toMatchObject({ contextBefore: 2, contextAfter: 3 });
		expect(commands.find((command) => command.startsWith("rg ") && command !== "rg --version")).toContain("-B 2");
		expect(commands.find((command) => command.startsWith("rg ") && command !== "rg --version")).toContain("-A 3");
	});

	it("exposes ledger-backed task tools through the governed stdlib composition", async () => {
		const ledger = new MemoryLedger();
		const registry = createStdlibTools("/workspace", {
			taskOptions: { ledger },
		});

		expect(registry.get("Task")).toBeDefined();
		expect(registry.get("TaskUpdate")).toBeDefined();
		expect(registry.get("TaskList")).toBeDefined();
		expect(registry.get("TodoWrite")).toBeDefined();

		const created = await registry.get("Task")!.execute("task-settings", { content: "persist task" });
		const taskId = (created.details as { taskId: string }).taskId;
		await registry.get("TaskUpdate")!.execute("task-settings", { taskId, status: "completed" });
		const listed = await registry.get("TaskList")!.execute("task-settings", {});
		expect((listed.content[0] as { text: string }).text).toContain("completed");
	});
});
