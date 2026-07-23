import { describe, expect, it } from "vitest";
import {
	ChildOperationBudget,
	ChildOperationBudgetError,
} from "../../../src/runtime/agents/integration/child-operation-budget.ts";
import type {
	AgentBudgetRequest,
	AgentBudgetUsage,
} from "../../../src/runtime/agents/types.ts";
import {
	zeroAgentOperationBudgetUsage,
	type AgentOperationBudgetCommitRequest,
	type AgentOperationBudgetPort,
	type AgentOperationBudgetRefundRequest,
	type AgentOperationBudgetReservation,
	type AgentOperationBudgetReserveRequest,
	type AgentOperationBudgetUsage,
} from "../../../src/runtime/operation-budget.ts";
import { canonicalDigest } from "../../../src/runtime/protocol/v3/canonical-json.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/v3/ids.ts";

const DEFAULT_BUDGET: AgentBudgetRequest = {
	maxTurns: 4,
	maxInputTokens: 1_000,
	maxOutputTokens: 1_000,
	maxUsdMicros: 1_000_000,
	maxWallTimeMs: 10_000,
	maxToolCalls: 10,
	maxNetworkBytes: 1_000_000,
	maxStorageBytes: 1_000_000,
};

function operationUsage(
	values: Partial<AgentOperationBudgetUsage> = {},
): AgentOperationBudgetUsage {
	return { ...zeroAgentOperationBudgetUsage(), ...values };
}

function childBudget(
	budget: Partial<AgentBudgetRequest> = {},
	delegate?: AgentOperationBudgetPort,
): ChildOperationBudget {
	return new ChildOperationBudget({
		budget: { ...DEFAULT_BUDGET, ...budget },
		...(delegate ? { delegate } : {}),
		clock: () => new Date("2026-07-23T00:00:00.000Z"),
	});
}

function expectUsage(
	result: Awaited<ReturnType<ChildOperationBudget["usage"]>>,
	expected: AgentBudgetUsage,
): void {
	expect(result).toEqual({ ok: true, value: expected });
}

class RecordingDelegate implements AgentOperationBudgetPort {
	public readonly reserves: AgentOperationBudgetReserveRequest[] = [];
	public readonly commits: AgentOperationBudgetCommitRequest[] = [];
	public readonly refunds: AgentOperationBudgetRefundRequest[] = [];
	public commitFailures = 0;

	public async reserve(
		request: AgentOperationBudgetReserveRequest,
	): Promise<AgentOperationBudgetReservation> {
		this.reserves.push(structuredClone(request));
		const suffix = canonicalDigest(request).slice(0, 40);
		return {
			kind: request.kind,
			operationKey: request.operationKey,
			operationId: createRuntimeId("command", `child-delegate-${suffix}`),
			reservationId: createRuntimeId(
				"budgetReservation",
				`child-delegate-${suffix}`,
			),
			estimatedUpperBound: { ...request.estimatedUpperBound },
			reservedAtMs: Date.parse("2026-07-23T00:00:00.000Z"),
		};
	}

	public async commit(request: AgentOperationBudgetCommitRequest): Promise<void> {
		this.commits.push(structuredClone(request));
		if (this.commitFailures > 0) {
			this.commitFailures -= 1;
			throw new Error("delegate commit unavailable");
		}
	}

	public async refund(request: AgentOperationBudgetRefundRequest): Promise<void> {
		this.refunds.push(structuredClone(request));
	}
}

describe("ChildOperationBudget", () => {
	it("fails usage closed while live work exists and returns complete exact settled usage", async () => {
		const budget = childBudget();
		const provider = await budget.reserve({
			kind: "provider",
			operationKey: "modelRequest_turn-1",
			estimatedUpperBound: operationUsage({
				inputTokens: 100,
				outputTokens: 50,
				usdMicros: 500,
				wallTimeMs: 1_000,
			}),
		});

		expect(await budget.usage()).toMatchObject({
			ok: false,
			error: { code: "reference_unavailable", retryable: true },
		});

		await budget.commit({
			reservation: provider,
			outcome: "succeeded",
			actual: operationUsage({
				inputTokens: 80,
				outputTokens: 20,
				usdMicros: 300,
				wallTimeMs: 125,
				retries: 1,
			}),
			resultDigest: canonicalDigest("provider-result"),
		});
		const tool = await budget.reserve({
			kind: "tool",
			operationKey: "toolCall_turn-1",
			estimatedUpperBound: operationUsage({
				wallTimeMs: 500,
				toolCalls: 1,
				networkBytes: 200,
				storageBytes: 300,
				artifactCount: 1,
				verifications: 1,
			}),
		});
		await budget.commit({
			reservation: tool,
			outcome: "succeeded",
			actual: operationUsage({
				wallTimeMs: 25,
				toolCalls: 1,
				networkBytes: 120,
				storageBytes: 240,
				artifactCount: 1,
				verifications: 1,
			}),
			resultDigest: canonicalDigest("tool-result"),
		});

		expectUsage(await budget.usage(), {
			inputTokens: 80,
			outputTokens: 20,
			usdMicros: 300,
			wallTimeMs: 150,
			toolCalls: 1,
			networkBytes: 120,
			storageBytes: 240,
			artifactCount: 1,
			verifications: 1,
		});
	});

	it("enforces cumulative estimates and releases capacity after a refund", async () => {
		const budget = childBudget({ maxToolCalls: 1 });
		const first = await budget.reserve({
			kind: "tool",
			operationKey: "toolCall_first",
			estimatedUpperBound: operationUsage({ toolCalls: 1 }),
		});
		await expect(
			budget.reserve({
				kind: "tool",
				operationKey: "toolCall_second",
				estimatedUpperBound: operationUsage({ toolCalls: 1 }),
			}),
		).rejects.toMatchObject({ code: "budget_exhausted" });

		await budget.refund({ reservation: first, reason: "not_started" });
		const second = await budget.reserve({
			kind: "tool",
			operationKey: "toolCall_second",
			estimatedUpperBound: operationUsage({ toolCalls: 1 }),
		});
		await budget.commit({
			reservation: second,
			outcome: "succeeded",
			actual: operationUsage({ toolCalls: 1 }),
			resultDigest: canonicalDigest("second"),
		});
		expectUsage(await budget.usage(), {
			inputTokens: 0,
			outputTokens: 0,
			usdMicros: 0,
			wallTimeMs: 0,
			toolCalls: 1,
			networkBytes: 0,
			storageBytes: 0,
			artifactCount: 0,
			verifications: 0,
		});
	});

	it("counts distinct non-refunded provider operations against maxTurns", async () => {
		const budget = childBudget({ maxTurns: 1 });
		const abandoned = await budget.reserve({
			kind: "provider",
			operationKey: "modelRequest_abandoned",
			estimatedUpperBound: operationUsage({ inputTokens: 1 }),
		});
		await budget.refund({ reservation: abandoned, reason: "not_started" });

		const turn = await budget.reserve({
			kind: "provider",
			operationKey: "modelRequest_turn",
			estimatedUpperBound: operationUsage({ inputTokens: 1 }),
		});
		await budget.commit({
			reservation: turn,
			outcome: "succeeded",
			actual: operationUsage({ inputTokens: 1 }),
			resultDigest: canonicalDigest("turn"),
		});
		await expect(
			budget.reserve({
				kind: "provider",
				operationKey: "modelRequest_too-many",
				estimatedUpperBound: operationUsage({ inputTokens: 1 }),
			}),
		).rejects.toMatchObject({ code: "budget_exhausted" });
	});

	it("records exact actual overage, rejects the commit and stops further admission", async () => {
		const budget = childBudget({ maxInputTokens: 10 });
		const reservation = await budget.reserve({
			kind: "provider",
			operationKey: "modelRequest_overage",
			estimatedUpperBound: operationUsage({ inputTokens: 5 }),
		});
		await expect(
			budget.commit({
				reservation,
				outcome: "succeeded",
				actual: operationUsage({ inputTokens: 11 }),
				resultDigest: canonicalDigest("overage"),
			}),
		).rejects.toMatchObject({ code: "budget_exhausted" });

		expectUsage(await budget.usage(), {
			inputTokens: 11,
			outputTokens: 0,
			usdMicros: 0,
			wallTimeMs: 0,
			toolCalls: 0,
			networkBytes: 0,
			storageBytes: 0,
			artifactCount: 0,
			verifications: 0,
		});
		await expect(
			budget.reserve({
				kind: "tool",
				operationKey: "toolCall_after-overage",
				estimatedUpperBound: operationUsage({ toolCalls: 1 }),
			}),
		).rejects.toMatchObject({ code: "budget_exhausted" });
	});

	it("makes exact retries idempotent and rejects operation or settlement digest conflicts", async () => {
		const delegate = new RecordingDelegate();
		const budget = childBudget({}, delegate);
		const request: AgentOperationBudgetReserveRequest = {
			kind: "provider",
			operationKey: "modelRequest_idempotent",
			estimatedUpperBound: operationUsage({ inputTokens: 10 }),
		};
		const first = await budget.reserve(request);
		expect(await budget.reserve(structuredClone(request))).toEqual(first);
		expect(delegate.reserves).toHaveLength(1);
		await expect(
			budget.reserve({
				...request,
				estimatedUpperBound: operationUsage({ inputTokens: 11 }),
			}),
		).rejects.toMatchObject({ code: "idempotency_conflict" });

		const commit: AgentOperationBudgetCommitRequest = {
			reservation: first,
			outcome: "succeeded",
			actual: operationUsage({ inputTokens: 8 }),
			resultDigest: canonicalDigest("idempotent"),
		};
		await budget.commit(commit);
		await budget.commit(structuredClone(commit));
		expect(delegate.commits).toHaveLength(1);
		await expect(
			budget.commit({
				...commit,
				resultDigest: canonicalDigest("conflict"),
			}),
		).rejects.toMatchObject({ code: "idempotency_conflict" });
		await expect(
			budget.refund({ reservation: first, reason: "cancelled" }),
		).rejects.toMatchObject({ code: "idempotency_conflict" });
	});

	it("rejects malformed usage, forged reservations and unsafe integer accumulation", async () => {
		expect(
			() =>
				childBudget({
					maxInputTokens: Number.MAX_SAFE_INTEGER + 1,
				}),
		).toThrowError(ChildOperationBudgetError);

		const budget = childBudget();
		await expect(
			budget.reserve({
				kind: "provider",
				operationKey: "modelRequest_invalid",
				estimatedUpperBound: operationUsage({ inputTokens: -1 }),
			}),
		).rejects.toMatchObject({ code: "invalid_operation" });

		const reservation = await budget.reserve({
			kind: "provider",
			operationKey: "modelRequest_valid",
			estimatedUpperBound: operationUsage({ inputTokens: 2 }),
		});
		await expect(
			budget.commit({
				reservation: {
					...reservation,
					reservationId: createRuntimeId(
						"budgetReservation",
						"forged-child-reservation",
					),
				},
				outcome: "succeeded",
				actual: operationUsage({ inputTokens: 1 }),
				resultDigest: canonicalDigest("forged"),
			}),
		).rejects.toMatchObject({ code: "reservation_mismatch" });
		await expect(
			budget.commit({
				reservation,
				outcome: "succeeded",
				actual: operationUsage({ inputTokens: Number.NaN }),
				resultDigest: canonicalDigest("invalid"),
			}),
		).rejects.toMatchObject({ code: "invalid_operation" });
	});

	it("fails closed after a semantically uncertain outcome", async () => {
		const budget = childBudget();
		const reservation = await budget.reserve({
			kind: "tool",
			operationKey: "toolCall_uncertain",
			estimatedUpperBound: operationUsage({ toolCalls: 1 }),
		});
		await budget.commit({
			reservation,
			outcome: "uncertain",
			actual: operationUsage({ toolCalls: 1 }),
			resultDigest: canonicalDigest("uncertain"),
		});

		expect(await budget.usage()).toMatchObject({
			ok: false,
			error: { code: "reference_unavailable", retryable: true },
		});
		await expect(
			budget.reserve({
				kind: "provider",
				operationKey: "modelRequest_after-uncertain",
				estimatedUpperBound: operationUsage({ inputTokens: 1 }),
			}),
		).rejects.toMatchObject({ code: "uncertain_operation" });
	});

	it("fails usage promptly during delegate settlement and permits an exact recovery retry", async () => {
		let finishCommit: (() => void) | undefined;
		const delegate = new RecordingDelegate();
		delegate.commit = async (request) => {
			delegate.commits.push(structuredClone(request));
			await new Promise<void>((resolveCommit) => {
				finishCommit = resolveCommit;
			});
		};
		const budget = childBudget({}, delegate);
		const reservation = await budget.reserve({
			kind: "provider",
			operationKey: "modelRequest_pending",
			estimatedUpperBound: operationUsage({ inputTokens: 2 }),
		});
		const request: AgentOperationBudgetCommitRequest = {
			reservation,
			outcome: "succeeded",
			actual: operationUsage({ inputTokens: 1 }),
			resultDigest: canonicalDigest("pending"),
		};
		const committing = budget.commit(request);
		await viWaitUntil(() => finishCommit !== undefined);
		expect(await budget.usage()).toMatchObject({
			ok: false,
			error: { code: "reference_unavailable", retryable: true },
		});
		finishCommit?.();
		await committing;

		const recoveringDelegate = new RecordingDelegate();
		recoveringDelegate.commitFailures = 1;
		const recovering = childBudget({}, recoveringDelegate);
		const recoveringReservation = await recovering.reserve({
			kind: "provider",
			operationKey: "modelRequest_recover",
			estimatedUpperBound: operationUsage({ inputTokens: 2 }),
		});
		const recoveringCommit: AgentOperationBudgetCommitRequest = {
			reservation: recoveringReservation,
			outcome: "succeeded",
			actual: operationUsage({ inputTokens: 1 }),
			resultDigest: canonicalDigest("recover"),
		};
		await expect(recovering.commit(recoveringCommit)).rejects.toMatchObject({
			code: "delegate_unavailable",
		});
		expect(await recovering.usage()).toMatchObject({ ok: false });
		await recovering.commit(recoveringCommit);
		expect(recoveringDelegate.commits).toHaveLength(2);
		expect((await recovering.usage()).ok).toBe(true);
	});
});

async function viWaitUntil(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 20; attempt += 1) {
		if (predicate()) return;
		await Promise.resolve();
	}
	throw new Error("condition did not become true");
}
