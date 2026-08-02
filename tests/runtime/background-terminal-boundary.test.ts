import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { createBashTool } from "../../src/runtime/tools/bash.ts";
import { scanExecutionBoundaries } from "../../scripts/check-execution-boundaries.ts";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

describe("R0 governed background terminal closure", () => {
	it("rejects background execution with a stable unsupported result without invoking shell", async () => {
		let execCalls = 0;
		const tool = createBashTool(repoRoot, {
			operations: {
				async exec() {
					execCalls += 1;
					return { stdout: "unexpected", stderr: "", exitCode: 0 };
				},
			},
		});

		const result = await tool.execute("toolCall_r0", {
			command: "echo should-not-run",
			run_in_background: true,
		});

		expect(execCalls).toBe(0);
		expect(result.isError).toBe(true);
		expect(result.details).toMatchObject({
			unsupported: { code: "managed_process_unavailable" },
		});
		expect(JSON.stringify(result)).not.toMatch(/(?:logPath|pid|tmp\/bash-)/iu);
	});

	it("keeps raw background process and private log authority out of bash source", async () => {
		const source = await readFile(join(repoRoot, "src/runtime/tools/bash.ts"), "utf8");

		expect(source).not.toContain("node:child_process");
		expect(source).not.toContain("spawnBackground");
		expect(source).not.toContain("detached: true");
		expect(source).not.toContain("logPath");
		expect(source).not.toContain("tmp/bash-");
	});

	it("does not allow bash to bypass the execution boundary checker", () => {
		const violations = scanExecutionBoundaries(repoRoot);
		expect(violations).toEqual([]);
	});
});
