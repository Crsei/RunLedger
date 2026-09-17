import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSystemPrompt, productionSessionTools } from "../../../src/runtime/session-runtime/domain.ts";
import type { ExecutionEnv } from "../../../src/runtime/execution-env.ts";
import { canonicalDigest } from "../../../src/runtime/protocol/canonical-json.ts";
import { unavailableWebSearchCredentials } from "../../../src/websource/credentials.ts";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function inertExecutionEnv(cwd: string): ExecutionEnv {
	const unavailable = async (): Promise<never> => { throw new Error("not executed by characterization test"); };
	return {
		cwd,
		fs: {
			readFile: unavailable,
			writeFile: unavailable,
			stat: unavailable,
			readdir: unavailable,
			mkdir: unavailable,
			rm: unavailable,
			rename: unavailable,
		},
		shell: { exec: unavailable },
	};
}

describe("standard@1 production characterization", () => {
	it("keeps the existing assembled prompt bytes and AGENTS order", () => {
		const root = mkdtempSync(join(tmpdir(), "runledger-harness-standard-"));
		roots.push(root);
		const globalAgents = join(root, "global-AGENTS.md");
		writeFileSync(join(root, "AGENTS.md"), "workspace instructions\n", "utf8");
		writeFileSync(globalAgents, "user instructions\n", "utf8");
		expect(buildSystemPrompt(root, globalAgents)).toBe(
			`You are RunLedger's interactive coding agent inside a TUI. Work in ${root}. `
			+ "Use governed Read/Write/Edit/Bash/process tools and keep replies concise."
			+ "\n\n---\n\nworkspace instructions\n\n\n---\n\nuser instructions\n",
		);
	});

	it("pins the current governed base tool order and provider-facing schemas", () => {
		const cwd = "/workspace/standard-characterization";
		// 与生产装配一致:web 检索端口注入时才出现 web_search。
		const tools = productionSessionTools(cwd, inertExecutionEnv(cwd), undefined, undefined, undefined, {
			credentials: unavailableWebSearchCredentials(),
		});
		expect(tools.map((tool) => tool.name)).toEqual([
			"read",
			"write",
			"edit",
			"MultiEdit",
			"bash",
			"grep",
			"glob",
			"ls",
			"WebFetch",
			"web_search",
			"todo",
		]);
		expect(canonicalDigest(tools.map((tool) => ({
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters,
		})))).toBe("c3c366e1ee9729039e14c17027017ff984da4c90110d85a64acf8795cec7a0b5");
	});
});
