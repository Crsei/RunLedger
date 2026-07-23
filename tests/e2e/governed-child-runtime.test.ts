import { afterEach, describe, expect, it, vi } from "vitest";
import {
	GOVERNED_CHILD_EXACT_USAGE,
	createGovernedChildRuntimeFixture,
	type GovernedChildRuntimeFixture,
} from "./helpers/governed-child-runtime-fixture.ts";

const fixtures: GovernedChildRuntimeFixture[] = [];

afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(
		fixtures
			.splice(0)
			.map((fixture) => fixture.cleanup()),
	);
});

describe("governed child runtime E2E", () => {
	it("runs two durable turns around one governed echo and replays exact completion cleanup evidence", async () => {
		vi.spyOn(Date, "now").mockReturnValue(
			Date.parse("2026-07-23T00:00:00.000Z"),
		);
		const fixture =
			await createGovernedChildRuntimeFixture();
		fixtures.push(fixture);

		const spawned =
			await fixture.composition.supervisor.spawn(
				fixture.spawnRequest,
			);
		if (!spawned.ok) {
			throw new Error(spawned.error.message);
		}
		expect(spawned.value.node).toMatchObject({
			agentId: fixture.spawnRequest.childAgentId,
			sessionId: fixture.spawnRequest.childSessionId,
			state: "running",
		});

		const secondContext =
			await fixture.runtimeFactory.waitUntilAttestationBarrier();
		const projection =
			await fixture.attestBeforeSecondRound();
		expect(fixture.runtimeFactory.providerCalls()).toBe(2);
		expect(fixture.runtimeFactory.gateway().counts()).toEqual({
			authorize: 1,
			start: 1,
			execute: 1,
		});
		expect(fixture.runtimeFactory.artifactCalls()).toBe(1);
		expect(
			secondContext.messages.filter(
				(message) => message.role === "toolResult",
			),
		).toHaveLength(1);
		expect(JSON.stringify(secondContext)).toContain(
			projection.artifactRef.artifactId,
		);
		fixture.runtimeFactory.releaseSecondRound();

		const completed =
			await fixture.composition.supervisor.waitForRuntimeCompletion(
				fixture.spawnRequest.childAgentId,
				10_000,
			);
		if (!completed.ok) {
			throw new Error(completed.error.message);
		}
		const runtimeCompletion =
			await fixture.runtimeFactory.completion();
		if (!runtimeCompletion.ok) {
			throw new Error(runtimeCompletion.error.message);
		}
		expect(runtimeCompletion.value).toMatchObject({
			outcome: "completed",
			usage: GOVERNED_CHILD_EXACT_USAGE,
		});
		expect(runtimeCompletion.value.turnIds).toHaveLength(2);
		expect(
			new Set(runtimeCompletion.value.turnIds).size,
		).toBe(2);
		const completedNode = completed.value.nodes.get(
			fixture.spawnRequest.childAgentId,
		);
		expect(completedNode).toMatchObject({
			state: "completed",
			turnsUsed: 2,
			turnIds: runtimeCompletion.value.turnIds,
			cursor: runtimeCompletion.value.finalCursor,
			terminal: {
				outcome: "completed",
				usage: GOVERNED_CHILD_EXACT_USAGE,
			},
			artifacts: [
				{
					logicalName: "echo-output",
					artifact: {
						artifactId:
							projection.artifactRef.artifactId,
					},
					integrity: "valid",
					verification: "verified",
				},
			],
		});
		expect(
			completed.value.cleanups.get(
				fixture.spawnRequest.childAgentId,
			),
		).toMatchObject({
			kind: "started",
			completionReceipt: { kind: "started" },
		});

		expect(fixture.cleanupOrder).toEqual([
			"runtime",
			"Workspace",
			"Budget",
		]);
		expect(fixture.composition.childSnapshots()).toEqual([]);
		const authority = await fixture.authorityStore.list();
		expect(authority).toEqual([
			expect.objectContaining({
				agentId: fixture.spawnRequest.childAgentId,
				sessionId:
					fixture.spawnRequest.childSessionId,
				state: "released",
				releaseReceipt: expect.objectContaining({
					finalCursor: expect.objectContaining({
						stream:
							runtimeCompletion.value
								.finalCursor.stream,
						sequence:
							runtimeCompletion.value
								.finalCursor.sequence +
							2,
					}),
				}),
			}),
		]);

		const childReplay =
			await fixture.replayChildEvents();
		if (!childReplay.ok) {
			throw new Error(childReplay.error.message);
		}
		const replayedTurnIds = childReplay.value
			.filter(
				(event) =>
					event.type === "turn.finished" ||
					event.type === "turn.failed" ||
					event.type === "turn.interrupted",
			)
			.map((event) => event.payload.turnId);
		expect(replayedTurnIds).toEqual(
			runtimeCompletion.value.turnIds,
		);
		const cursorEvent = childReplay.value.find(
			(event) =>
				event.sequence ===
				runtimeCompletion.value.finalCursor.sequence,
		);
		expect(cursorEvent).toMatchObject({
			eventId:
				runtimeCompletion.value.finalCursor.eventId,
			currentEventHash:
				runtimeCompletion.value.finalCursor.eventHash,
		});
		expect(
			childReplay.value.slice(-2).map((event) => event.type),
		).toEqual([
			"session.stop_requested",
			"session.stopped",
		]);

		const parentReplay =
			await fixture.replayParentGraph();
		if (!parentReplay.ok) {
			throw new Error(parentReplay.error.message);
		}
		expect(
			parentReplay.value.projection.nodes.get(
				fixture.spawnRequest.childAgentId,
			),
		).toEqual(completedNode);
		expect(
			parentReplay.value.projection.cleanups.get(
				fixture.spawnRequest.childAgentId,
			),
		).toEqual(
			completed.value.cleanups.get(
				fixture.spawnRequest.childAgentId,
			),
		);
	}, 20_000);
});
