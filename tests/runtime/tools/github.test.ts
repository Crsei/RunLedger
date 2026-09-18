import { describe, expect, it } from "vitest";
import { createGithubTool } from "../../../src/runtime/tools/github.ts";
import { createStdlibTools } from "../../../src/runtime/tools/index.ts";
import { evaluatePlanModeCapabilities } from "../../../src/runtime/modes/plan/policy.ts";
import type { ExecutionEnv } from "../../../src/runtime/execution-env.ts";
import type { WebSearchCredentialPort } from "../../../src/websource/credentials.ts";

const credentials: WebSearchCredentialPort = {
	has: async () => false,
	getApiKey: async () => undefined,
	getConfig: async () => undefined,
};

describe("github tool", () => {
	it("projects a readonly GitHub response and leaves Plan Mode denial to the network claim", async () => {
		const tool = createGithubTool({
			credentials,
			fetch: async () => Response.json({ items: [{ full_name: "acme/widget", html_url: "https://github.com/acme/widget" }], total_count: 1 }),
		});
		const result = await tool.execute("github-1", { op: "search_repos", query: "widget" });
		expect(result).toMatchObject({ details: { op: "search_repos" } });
		expect(result.isError).toBeUndefined();
		expect((result.content[0] as { text: string }).text).toContain("acme/widget");
		expect(tool.isReadOnly?.()).toBe(true);
		expect(evaluatePlanModeCapabilities({ state: undefined, claims: tool.capabilityClaims ?? [], enforceReadonly: true }))
			.toMatchObject({ decision: "deny" });
	});

	it("registers only when production composition supplies governed network and credentials", () => {
		const unavailable = async (): Promise<never> => { throw new Error("not executed"); };
		const env: ExecutionEnv = {
			cwd: "/workspace",
			fs: { readFile: unavailable, writeFile: unavailable, stat: unavailable, readdir: unavailable, mkdir: unavailable, rm: unavailable, rename: unavailable },
			shell: { exec: unavailable },
			network: { request: unavailable },
		};
		expect(createStdlibTools("/workspace", { executionEnv: env, requireExecutionEnv: true }).has("github")).toBe(false);
		expect(createStdlibTools("/workspace", { executionEnv: env, requireExecutionEnv: true, webSearch: { credentials } }).get("github")?.capabilityClaims?.[0]?.name)
			.toBe("network");
	});
});
