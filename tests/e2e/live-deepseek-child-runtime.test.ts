import { afterEach, describe, expect, it } from "vitest";
import { builtinModels } from "../../src/providers/all.ts";
import type { AgentBudgetRequest } from "../../src/runtime/agents/types.ts";
import type { StreamFn } from "../../src/runtime/types.ts";
import { AuthStorage } from "../../src/storage/auth-storage.ts";
import type { Api, Context, Model } from "../../src/types.ts";
import {
	createGovernedChildRuntimeFixture,
	type GovernedChildRuntimeFixture,
} from "./helpers/governed-child-runtime-fixture.ts";

const LIVE_E2E_ENABLED =
	process.env["RUNLEDGER_LIVE_E2E"] === "1";
const LIVE_MODEL_MAX_TOKENS = 256;
const LIVE_ABORT_MS = 110_000;
const LIVE_COMPLETION_WAIT_MS = 115_000;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/u;

const LIVE_CHILD_BUDGET: AgentBudgetRequest = {
	maxTurns: 2,
	maxInputTokens: 32_000,
	maxOutputTokens: LIVE_MODEL_MAX_TOKENS * 2,
	maxUsdMicros: 100_000,
	// Agent operation admission reserves 120s/provider + 60s/tool.
	maxWallTimeMs: 300_000,
	maxToolCalls: 1,
	maxNetworkBytes: 0,
	maxStorageBytes: 1_000_000,
};

const fixtures: GovernedChildRuntimeFixture[] = [];

afterEach(async () => {
	await Promise.all(
		fixtures
			.splice(0)
			.map((fixture) => fixture.cleanup()),
	);
});

async function requireLiveDeepSeekModel(): Promise<{
	model: Model<Api>;
	streamFn: StreamFn;
	providerDispatches(): number;
}> {
	const models = builtinModels({
		credentials: AuthStorage.create(),
	});
	const catalogModel = models.getModel(
		"deepseek",
		"deepseek-v4-pro",
	);
	if (!catalogModel) {
		throw new Error(
			"live DeepSeek E2E requires deepseek/deepseek-v4-pro in the builtin catalog",
		);
	}
	let authConfigured = false;
	try {
		authConfigured =
			(await models.checkAuth("deepseek")) !== undefined;
	} catch {
		throw new Error(
			"live DeepSeek E2E could not verify configured deepseek auth",
		);
	}
	if (!authConfigured) {
		throw new Error(
			"live DeepSeek E2E requires configured deepseek auth",
		);
	}

	const model: Model<Api> = {
		...catalogModel,
		maxTokens: LIVE_MODEL_MAX_TOKENS,
	};
	let providerDispatches = 0;
	const streamFn: StreamFn = (
		requestModel,
		context,
		options,
	) => {
		providerDispatches += 1;
		if (providerDispatches > 2) {
			throw new Error(
				"live DeepSeek E2E exceeded its two-provider-call bound",
			);
		}
		if (
			requestModel.provider !== "deepseek" ||
			requestModel.id !== "deepseek-v4-pro"
		) {
			throw new Error(
				"live DeepSeek E2E received an unexpected provider/model",
			);
		}
		return models.streamSimple(
			requestModel,
			context as Context,
			{
				...options,
				maxTokens: LIVE_MODEL_MAX_TOKENS,
			},
		);
	};
	return {
		model,
		streamFn,
		providerDispatches: () => providerDispatches,
	};
}

async function waitForRequiredSecondRound(
	fixture: GovernedChildRuntimeFixture,
): Promise<void> {
	let timer:
		| ReturnType<typeof setTimeout>
		| undefined;
	try {
		const outcome = await Promise.race([
			fixture.runtimeFactory
				.waitUntilAttestationBarrier()
				.then(() => "barrier" as const),
			fixture.runtimeFactory
				.completion()
				.then(() => "completed" as const),
			new Promise<"timeout">((resolve) => {
				timer = setTimeout(
					() => resolve("timeout"),
					LIVE_COMPLETION_WAIT_MS,
				);
				timer.unref();
			}),
		]);
		if (outcome !== "barrier") {
			throw new Error(
				outcome === "completed"
					? "live DeepSeek child ended before the required second-round barrier"
					: "live DeepSeek child did not reach the second-round barrier within its bound",
			);
		}
	} finally {
		if (timer) clearTimeout(timer);
	}
}

describe.skipIf(!LIVE_E2E_ENABLED)(
	"live DeepSeek governed child runtime E2E",
	() => {
		it(
			"runs deepseek-v4-pro through one governed tool and durable terminal cleanup",
			async () => {
				const live = await requireLiveDeepSeekModel();
				expect({
					provider: live.model.provider,
					model: live.model.id,
					maxTokens: live.model.maxTokens,
				}).toEqual({
					provider: "deepseek",
					model: "deepseek-v4-pro",
					maxTokens: LIVE_MODEL_MAX_TOKENS,
				});

				const fixture =
					await createGovernedChildRuntimeFixture({
						model: live.model,
						streamFn: live.streamFn,
						systemPrompt:
							"Call the echo tool exactly once in the first turn. After its tool result, finish without another tool call.",
						objective:
							"Use echo exactly once with a short test value, then finish after the ArtifactRef is available.",
						childBudget: LIVE_CHILD_BUDGET,
					});
				fixtures.push(fixture);

				const abortController = new AbortController();
				const abortTimer = setTimeout(
					() => abortController.abort(),
					LIVE_ABORT_MS,
				);
				abortTimer.unref();
				try {
					const spawned =
						await fixture.composition.supervisor.spawn(
							fixture.spawnRequest,
							abortController.signal,
						);
					if (!spawned.ok) {
						throw new Error(
							"live DeepSeek child spawn failed before activation",
						);
					}
					expect(spawned.value.node.state).toBe(
						"running",
					);

					await waitForRequiredSecondRound(fixture);
					await fixture.attestBeforeSecondRound();
					expect(
						fixture.runtimeFactory.providerCalls(),
					).toBe(2);
					expect(live.providerDispatches()).toBe(1);
					expect(
						fixture.runtimeFactory.gateway().counts(),
					).toEqual({
						authorize: 1,
						start: 1,
						execute: 1,
					});
					expect(
						fixture.runtimeFactory.artifactCalls(),
					).toBe(1);

					fixture.runtimeFactory.releaseSecondRound();
					const completed =
						await fixture.composition.supervisor.waitForRuntimeCompletion(
							fixture.spawnRequest.childAgentId,
							LIVE_COMPLETION_WAIT_MS,
						);
					if (!completed.ok) {
						throw new Error(
							"live DeepSeek child completion coordination failed",
						);
					}
					expect(live.providerDispatches()).toBe(2);

					const runtimeCompletion =
						await fixture.runtimeFactory.completion();
					if (!runtimeCompletion.ok) {
						throw new Error(
							"live DeepSeek child runtime completion was unavailable",
						);
					}
					expect(runtimeCompletion.value.outcome).toBe(
						"completed",
					);
					expect(
						runtimeCompletion.value.turnIds,
					).toHaveLength(2);
					expect(
						runtimeCompletion.value.usage.toolCalls,
					).toBe(1);
					expect(
						runtimeCompletion.value.usage.artifactCount,
					).toBe(1);
					expect(
						runtimeCompletion.value.usage.verifications,
					).toBe(1);
					expect(
						runtimeCompletion.value.finalCursor.eventHash,
					).toMatch(DIGEST_PATTERN);

					const node = completed.value.nodes.get(
						fixture.spawnRequest.childAgentId,
					);
					expect(node).toMatchObject({
						state: "completed",
						turnsUsed: 2,
						cursor:
							runtimeCompletion.value.finalCursor,
						terminal: { outcome: "completed" },
					});
					expect(
						completed.value.cleanups.get(
							fixture.spawnRequest.childAgentId,
						),
					).toMatchObject({
						kind: "started",
						completionReceipt: {
							kind: "started",
						},
					});
					expect(fixture.cleanupOrder).toEqual([
						"runtime",
						"Workspace",
						"Budget",
					]);
					expect(
						fixture.composition.childSnapshots(),
					).toEqual([]);

					const authority =
						await fixture.authorityStore.list();
					expect(authority).toHaveLength(1);
					const released = authority[0];
					if (
						!released ||
						released.state !== "released"
					) {
						throw new Error(
							"live DeepSeek child lacks a released authority record",
						);
					}
					expect(
						released.releaseReceipt.receiptDigest,
					).toMatch(DIGEST_PATTERN);
					expect(
						released.releaseReceipt.finalCursor.stream,
					).toEqual(
						runtimeCompletion.value.finalCursor
							.stream,
					);
				} finally {
					clearTimeout(abortTimer);
					fixture.runtimeFactory.releaseSecondRound();
				}
			},
			120_000,
		);
	},
);
