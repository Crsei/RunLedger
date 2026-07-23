import { describe, expect, it } from "vitest";
import {
	childMaySpawn,
	evaluateSpawnDelegation,
	validateSpawnAgentRequest,
} from "../../../src/runtime/agents/delegation.ts";
import type { SpawnAgentRequest } from "../../../src/runtime/agents/types.ts";
import {
	declassificationReceipt,
	FakeCapabilitySubsetEvaluator,
	grant,
	inputSource,
	spawnRequest,
} from "./helpers.ts";

describe("agent delegation contract", () => {
	it("sends capability and unknown tool refs through the same subset evaluator", async () => {
		const evaluator = new FakeCapabilitySubsetEvaluator();
		const request = spawnRequest(grant());
		const result = await evaluateSpawnDelegation(request, evaluator, undefined, new Date("2026-07-22T00:00:00.000Z"));
		expect(result.ok).toBe(true);
		expect(evaluator.evaluations).toHaveLength(1);
		expect(evaluator.evaluations[0]?.requestedCapabilities.map((ref) => ref.kind)).toEqual([
			"capability",
			"tool",
		]);
		expect(evaluator.evaluations[0]?.requestedCapabilities[1]).toMatchObject({
			kind: "tool",
			toolKind: "unknown",
		});
	});

	it("rejects extra cwd/env style fields instead of carrying a side channel", () => {
		const request: SpawnAgentRequest & { cwd: string; env: Readonly<Record<string, string>> } = {
			...spawnRequest(grant()),
			cwd: "/shared",
			env: { TOKEN: "secret" },
		};
		const result = validateSpawnAgentRequest(request, new Date("2026-07-22T00:00:00.000Z"));
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("invalid_request");
	});

	it("binds exact tainted input lineage into delegation evaluation", async () => {
		const source = inputSource("delegation-repository");
		const receipt = declassificationReceipt(source);
		const evaluator = new FakeCapabilitySubsetEvaluator();
		const request = spawnRequest(grant(), {
			inputSources: [source],
			declassificationReceipts: [receipt],
		});
		const result = await evaluateSpawnDelegation(
			request,
			evaluator,
			undefined,
			new Date("2026-07-22T00:00:00.000Z"),
		);
		expect(result.ok).toBe(true);
		expect(evaluator.evaluations[0]).toMatchObject({
			inputSources: [{ sourceId: source.sourceId, taintLabels: source.taintLabels }],
			declassificationReceipts: [{ receiptId: receipt.receiptId, sourceDigest: source.sourceDigest }],
		});

		const foreignSource = inputSource("foreign");
		const invalid = validateSpawnAgentRequest(
			{ ...request, declassificationReceipts: [declassificationReceipt(foreignSource)] },
			new Date("2026-07-22T00:00:00.000Z"),
		);
		expect(invalid.ok).toBe(false);
	});

	it("fails closed for an expired parent grant or denied evaluator receipt", async () => {
		const expired = spawnRequest({
			...grant(),
			expiresAt: "2026-07-21T00:00:00.000Z",
		});
		expect(validateSpawnAgentRequest(expired, new Date("2026-07-22T00:00:00.000Z")).ok).toBe(false);

		const evaluator = new FakeCapabilitySubsetEvaluator();
		evaluator.decision = "denied";
		const denied = await evaluateSpawnDelegation(
			spawnRequest(grant()),
			evaluator,
			undefined,
			new Date("2026-07-22T00:00:00.000Z"),
		);
		expect(denied.ok).toBe(false);
		if (!denied.ok) expect(denied.error.code).toBe("delegation_denied");
	});

	it("keeps delegated children non-spawning unless the evaluator explicitly grants it", () => {
		const rootRequest = spawnRequest(grant());
		const childLike = {
			agentId: rootRequest.childAgentId,
			depth: 1,
			delegationReceipt: {
				decision: "allowed" as const,
				childSpawnAllowed: false,
				expiresAt: "2026-07-23T00:00:00.000Z",
			},
		};
		expect(childMaySpawn(childLike as Parameters<typeof childMaySpawn>[0], new Date("2026-07-22T00:00:00.000Z"))).toBe(false);
	});
});
