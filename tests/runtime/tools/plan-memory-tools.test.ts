/**
 * plan/memory agent tools 测试 —— 全部经注入的 Host domain client 执行，
 * 客户端不装配 store/reducer；typed 失败不抛错。
 */

import { describe, expect, it } from "vitest";
import {
	createPlanMemoryTools,
	type HostDomainToolClient,
	type HostDomainToolResponse,
} from "../../../src/runtime/tools/plan-memory-tools.ts";

function stubClient(routes: Record<string, (body: Record<string, unknown>) => HostDomainToolResponse>): HostDomainToolClient {
	return {
		query: async (operation, body = {}) => routes[operation]?.(body) ?? { ok: false, code: `unsupported_query:${operation}` },
		command: async (operation, body = {}) => routes[operation]?.(body) ?? { ok: false, code: `unsupported_command:${operation}` },
	};
}

async function toolResult(tool: ReturnType<typeof createPlanMemoryTools>[number], params: Record<string, unknown>): Promise<{ text: string; isError: boolean; details: Record<string, unknown> }> {
	const result = await (tool as { execute(tc: string, params: Record<string, unknown>): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean; details?: Record<string, unknown> }> }).execute("tc-1", params);
	const text = result.content.filter((part) => part.type === "text").map((part) => part.text).join("");
	return { text, isError: result.isError === true, details: (result.details ?? {}) as Record<string, unknown> };
}

describe("plan_write", () => {
	it("writes the plan through the Host domain with expected revisions", async () => {
		let received: Record<string, unknown> | undefined;
		const tools = createPlanMemoryTools(stubClient({
			"plan.write": (body) => {
				received = body;
				return { ok: true, body: { state: { revision: 4, plan: { revision: 2 } } } };
			},
		}));
		const result = await toolResult(tools[0]!, { expectedRevision: 3, expectedPlanRevision: 1, content: "# Plan revision 2" });

		expect(received).toMatchObject({ expectedRevision: 3, expectedPlanRevision: 1, content: "# Plan revision 2" });
		expect(result.text).toContain("revision=4");
		expect(result.details.revision).toBe(4);
		expect(result.details.planRevision).toBe(2);
	});

	it("returns a typed error when the Host rejects the write", async () => {
		const tools = createPlanMemoryTools(stubClient({
			"plan.write": () => ({ ok: false, code: "stale_plan_revision" }),
		}));
		const result = await toolResult(tools[0]!, { expectedRevision: 3, expectedPlanRevision: 1, content: "x" });
		expect(result.text).toContain("stale_plan_revision");
	});

	it("returns a typed error when the domain channel throws", async () => {
		const tools = createPlanMemoryTools({
			query: async () => ({ ok: false, code: "unused" }),
			command: async () => { throw new Error("channel broken"); },
		});
		const result = await toolResult(tools[0]!, { expectedRevision: 0, expectedPlanRevision: 0, content: "x" });
		expect(result.text).toContain("channel broken");
	});
});

describe("memory_search / memory_get / memory_propose", () => {
	it("searches approved memory through the Host domain and renders bounded rows", async () => {
		const tools = createPlanMemoryTools(stubClient({
			"memory.search": (body) => ({
				ok: true,
				body: {
					results: [
						{ memoryId: "memory_a", title: "release rule", snippet: "always run the release check", score: 1 },
					],
				},
			}),
		}));
		const result = await toolResult(tools[1]!, { query: "release", scope: "workspace" });
		expect(result.text).toContain("release rule");
		expect(result.text).toContain("memory_a");
		expect(result.details.results).toBe(1);
	});

	it("gets a single record metadata", async () => {
		const tools = createPlanMemoryTools(stubClient({
			"memory.get": () => ({ ok: true, body: { record: { memoryId: "memory_a", title: "release rule" } } }),
		}));
		const result = await toolResult(tools[2]!, { memoryId: "memory_a" });
		expect(result.text).toContain("release rule");
	});

	it("proposes a memory record with agent provenance", async () => {
		let received: Record<string, unknown> | undefined;
		const tools = createPlanMemoryTools(stubClient({
			"memory.propose": (body) => {
				received = body;
				return { ok: true, body: { proposal: { proposalId: "proposal_123" } } };
			},
		}));
		const result = await toolResult(tools[3]!, { title: "keep", content: "remember this" });

		expect(received).toMatchObject({ scope: "workspace", title: "keep", sourceKind: "agent" });
		expect(result.text).toContain("proposal_123");
		expect(result.text).toContain("pending approval");
	});

	it("propagates typed memory failures", async () => {
		const tools = createPlanMemoryTools(stubClient({
			"memory.search": () => ({ ok: false, code: "memory_search_request_invalid" }),
		}));
		const result = await toolResult(tools[1]!, { query: "" });
		expect(result.text).toContain("memory_search_request_invalid");
	});
});
