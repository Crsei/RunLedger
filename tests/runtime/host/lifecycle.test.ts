import { describe, expect, it } from "vitest";
import { RuntimeHostLifecycle } from "../../../src/runtime/host/lifecycle.ts";
import { runtimeDigest } from "../../../src/runtime/protocol/foundation.ts";

describe("R10 Runtime Host lifecycle", () => {
	it("records restart recovery without reattaching by PID", async () => {
		const markers: string[] = [];
		const lifecycle = new RuntimeHostLifecycle({
			hostGeneration: 9,
			artifactMode: "off",
			ports: {
				recoverUnattached: async () => [{ id: "execution_uncertain", state: "uncertain" as const }],
				closeAdmission: async () => {},
				drainTurns: async () => {},
				listProcesses: async () => [],
				flushWriter: async () => {},
				release: async () => {},
				writeRecoveryMarker: async (marker) => { markers.push(marker.phase); },
			},
		});

		await expect(lifecycle.recoverAfterRestart()).resolves.toMatchObject({
			ok: true,
			processes: [{ id: "execution_uncertain", state: "uncertain" }],
		});
		expect(markers).toEqual(["recovery_started", "recovery_completed"]);
	});

	it("closes admission, drains and seals processes, conditionally materializes, then flushes and releases", async () => {
		const calls: string[] = [];
		const lifecycle = new RuntimeHostLifecycle({
			hostGeneration: 7,
			artifactMode: "events_and_artifacts",
			ports: {
				closeAdmission: async () => { calls.push("admission.close"); },
				drainTurns: async () => { calls.push("turns.drain"); },
				listProcesses: async () => [{
					id: "execution_a",
					drain: async () => { calls.push("process.drain"); },
					checkpoint: async () => { calls.push("process.checkpoint"); },
					seal: async () => { calls.push("process.seal"); },
					settle: async () => { calls.push("process.settle"); },
					materializeArtifacts: async () => { calls.push("process.artifact"); },
					evidence: async () => ({
						id: "execution_a",
						outputCheckpoint: { cursor: { sequence: 2, byteOffset: 8 }, size: 8 },
						outputSealDigest: runtimeDigest("sealed-output"),
						settlementEvidenceRef: { subjectKind: "receipt", digest: runtimeDigest("settlement") },
					}),
				}],
				flushWriter: async () => { calls.push("writer.flush"); },
				release: async () => { calls.push("resources.release"); },
				writeRecoveryMarker: async (marker) => { calls.push(`marker:${marker.phase}`); },
			},
		});

		const result = await lifecycle.shutdown();
		expect(result).toMatchObject({ ok: true, state: "closed" });
		expect(calls).toEqual([
			"marker:shutdown_started",
			"admission.close",
			"turns.drain",
			"process.drain",
			"process.checkpoint",
			"process.seal",
			"process.settle",
			"process.artifact",
			"writer.flush",
			"resources.release",
			"marker:shutdown_completed",
			]);
			expect(result.marker.processEvidence).toEqual([expect.objectContaining({
				id: "execution_a",
				outputCheckpoint: { cursor: { sequence: 2, byteOffset: 8 }, size: 8 },
				settlementEvidenceRef: { subjectKind: "receipt", digest: runtimeDigest("settlement") },
			})]);
		await expect(lifecycle.shutdown()).resolves.toEqual(result);
		expect(calls.filter((call) => call === "admission.close")).toHaveLength(1);
	});

	it("does not materialize in events mode and records an incomplete recovery marker after a phase failure", async () => {
		const calls: string[] = [];
		const lifecycle = new RuntimeHostLifecycle({
			hostGeneration: 8,
			artifactMode: "events",
			ports: {
				closeAdmission: async () => { calls.push("admission.close"); },
				drainTurns: async () => { calls.push("turns.drain"); },
				listProcesses: async () => [{
					id: "execution_b",
					drain: async () => { throw new Error("drain failed"); },
					checkpoint: async () => { calls.push("process.checkpoint"); },
					seal: async () => { calls.push("process.seal"); },
					settle: async () => { calls.push("process.settle"); },
					materializeArtifacts: async () => { calls.push("process.artifact"); },
				}],
				flushWriter: async () => { calls.push("writer.flush"); },
				release: async () => { calls.push("resources.release"); },
				writeRecoveryMarker: async (marker) => { calls.push(`marker:${marker.phase}`); },
			},
		});

		const result = await lifecycle.shutdown();
		expect(result).toMatchObject({ ok: false, code: "shutdown_incomplete", state: "closed" });
		expect(calls).not.toContain("process.artifact");
		expect(calls).toContain("marker:shutdown_incomplete");
		expect(calls.at(-1)).toBe("marker:shutdown_incomplete");
	});
});
