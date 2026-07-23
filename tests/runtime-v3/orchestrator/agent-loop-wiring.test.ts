import { describe, expect, it } from "vitest";
import { Agent } from "../../../src/runtime/agent.ts";
import { echoTool } from "../../../src/runtime/tools/echo.ts";
import { mockModel, mockStreamFn } from "../../../src/runtime/providers/mock-stream.ts";
import { canonicalDigest } from "../../../src/runtime/protocol/v3/canonical-json.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/v3/ids.ts";
import type {
	AgentOperationBudgetCommitRequest,
	AgentOperationBudgetPort,
	AgentOperationBudgetRefundRequest,
	AgentOperationBudgetReservation,
	AgentOperationBudgetReserveRequest,
} from "../../../src/runtime/operation-budget.ts";
import type { StreamFn } from "../../../src/runtime/types.ts";

class RecordingBudget implements AgentOperationBudgetPort {
	public readonly events: string[] = [];
	public readonly commits: AgentOperationBudgetCommitRequest[] = [];
	#next = 0;

	public async reserve(request: AgentOperationBudgetReserveRequest): Promise<AgentOperationBudgetReservation> {
		this.#next += 1;
		this.events.push(`reserve:${request.kind}`);
		return {
			kind: request.kind,
			operationKey: request.operationKey,
			operationId: createRuntimeId("command", `recording-${this.#next}`),
			reservationId: createRuntimeId("budgetReservation", `recording-${this.#next}`),
			estimatedUpperBound: { ...request.estimatedUpperBound },
			reservedAtMs: Date.now(),
		};
	}

	public async commit(request: AgentOperationBudgetCommitRequest): Promise<void> {
		this.events.push(`commit:${request.reservation.kind}`);
		this.commits.push(request);
	}

	public async refund(request: AgentOperationBudgetRefundRequest): Promise<void> {
		this.events.push(`refund:${request.reservation.kind}`);
	}
}

describe("Agent loop operation budget wiring", () => {
	it("reserves before every provider/tool operation and commits before continuing", async () => {
		const budget = new RecordingBudget();
		const stream: StreamFn = (model, context, options) => {
			budget.events.push("execute:provider");
			return mockStreamFn(model, context, options);
		};
		const tool = {
			...echoTool,
			execute: async (...args: Parameters<typeof echoTool.execute>) => {
				budget.events.push("execute:tool");
				return echoTool.execute(...args);
			},
		};
		const agent = new Agent({
			initialState: { systemPrompt: "budget wiring", model: mockModel, tools: [tool] },
			streamFn: stream,
			loopConfig: { operationBudget: budget },
		});

		await agent.prompt("budgeted");
		expect(budget.commits.length).toBeGreaterThan(0);
		expect(budget.commits.every((commit) => /^[a-f0-9]{64}$/.test(commit.resultDigest))).toBe(true);
		expect(budget.events.filter((event) => event === "reserve:provider").length).toBe(
			budget.events.filter((event) => event === "commit:provider").length,
		);
		expect(budget.events.filter((event) => event === "reserve:tool").length).toBe(
			budget.events.filter((event) => event === "commit:tool").length,
		);
		for (const kind of ["provider", "tool"] as const) {
			const reserve = budget.events.indexOf(`reserve:${kind}`);
			const execute = budget.events.indexOf(`execute:${kind}`);
			const commit = budget.events.indexOf(`commit:${kind}`);
			expect(reserve).toBeGreaterThanOrEqual(0);
			expect(reserve).toBeLessThan(execute);
			expect(execute).toBeLessThan(commit);
		}
		expect(canonicalDigest(budget.commits.map((commit) => commit.resultDigest))).toMatch(/^[a-f0-9]{64}$/);
	}, 20_000);

	it("does not invoke the provider when reserve fails", async () => {
		let providerCalled = false;
		const budget: AgentOperationBudgetPort = {
			reserve: async () => { throw new Error("budget denied"); },
			commit: async () => undefined,
			refund: async () => undefined,
		};
		const agent = new Agent({
			initialState: { systemPrompt: "budget denial", model: mockModel, tools: [] },
			streamFn: (...args) => {
				providerCalled = true;
				return mockStreamFn(...args);
			},
			loopConfig: { operationBudget: budget },
		});
		await expect(agent.prompt("blocked")).rejects.toThrow("budget denied");
		expect(providerCalled).toBe(false);
	});
});
