import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { createBashTool } from "../../src/runtime/tools/bash.ts";
import { createRuntimeId } from "../../src/runtime/protocol/ids.ts";
import { runtimeDigest } from "../../src/runtime/protocol/foundation.ts";
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

	it("uses an injected Host launcher for background mode and returns a safe handle", async () => {
		let starts = 0;
		const tool = createBashTool(repoRoot, {
			managedProcess: {
				start: async (input) => {
					starts += 1;
					expect(input.command).toBe("echo governed");
					return {
						ok: true as const,
						handle: {
							authorityId: createRuntimeId("authority", "bash"),
							tenantId: createRuntimeId("tenant", "bash"),
							workspaceId: createRuntimeId("workspace", "bash"),
							sessionId: createRuntimeId("session", "bash"),
							hostGeneration: 1,
							sessionGeneration: 1,
							executionId: createRuntimeId("execution", "bash"),
							attemptId: createRuntimeId("attempt", "bash_1"),
							revision: 2,
							requestDigest: runtimeDigest("request"),
						},
						summary: { state: "backgrounded" as const },
					};
				},
			},
		});
		const result = await tool.execute("toolCall-host", { command: "echo governed", run_in_background: true });
		expect(starts).toBe(1);
		expect(result.isError).not.toBe(true);
		expect(result.details).toMatchObject({ background: { summary: { state: "backgrounded" } } });
		expect(JSON.stringify(result)).not.toMatch(/(?:pid|outputPath|cwd|command|logPath)/iu);
	});

	it("routes foreground execution through the Host facade when one is attached", async () => {
		let localExecCalls = 0;
		let managedExecCalls = 0;
		const managedProcess = {
			start: async () => ({ ok: false as const, code: "not_used" }),
			exec: async (input: { readonly command: string; readonly onStdout?: (chunk: string) => void }) => {
				managedExecCalls += 1;
				input.onStdout?.("managed output\n");
				return { stdout: "managed output\n", stderr: "", exitCode: 0 };
			},
		};
		const tool = createBashTool(repoRoot, {
			operations: {
				async exec() {
					localExecCalls += 1;
					return { stdout: "raw output\n", stderr: "", exitCode: 0 };
				},
			},
			managedProcess,
		});

		const result = await tool.execute("toolCall-foreground-host", { command: "echo governed" });
		expect(managedExecCalls).toBe(1);
		expect(localExecCalls).toBe(0);
		expect((result.content[0] as { readonly text: string }).text).toContain("managed output");
	});

	it("does not allow bash to bypass the execution boundary checker", () => {
		const violations = scanExecutionBoundaries(repoRoot);
		expect(violations).toEqual([]);
	});
});
