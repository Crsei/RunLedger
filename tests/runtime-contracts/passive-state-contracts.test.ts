import { describe, expect, it } from "vitest";
import {
	RUNTIME_PROJECTION_SCHEMAS,
	isRuntimeProjection,
	isRuntimeSnapshotDescriptor,
} from "../../src/runtime/contracts/passive-state-schemas.ts";
import { createRuntimeId } from "../../src/runtime/protocol/ids.ts";

const digest = {
	algorithm: "sha256",
	digest: "e".repeat(64),
} as const;

const sourceHead = {
	streamId: createRuntimeId("session", "projection"),
	sequence: 7,
	eventHash: digest,
} as const;

describe("Runtime passive state exact contracts", () => {
	it("requires every projection to bind its source head, digest, and completeness", () => {
		const projection = {
			projectionKind: "session",
			sessionId: createRuntimeId("session", "projection"),
			status: "running",
			rootGoalId: createRuntimeId("goal", "projection"),
			rootAgentId: createRuntimeId("agent", "projection"),
			sourceHead,
			projectionDigest: digest,
			builtAt: "2026-08-01T00:00:00.000Z",
			completeness: "complete",
		};

		expect(isRuntimeProjection(projection)).toBe(true);
		expect(isRuntimeProjection({ ...projection, sourceHead: undefined })).toBe(false);
		expect(isRuntimeProjection({ ...projection, authorized: true })).toBe(false);
		expect(Object.keys(RUNTIME_PROJECTION_SCHEMAS)).toEqual(["session", "goal", "task", "queue", "agent_graph"]);
	});

	it("keeps task output as bounded refs instead of inline content", () => {
		const projection = {
			projectionKind: "task",
			sessionId: createRuntimeId("session", "projection"),
			tasks: [{
				taskId: createRuntimeId("task", "one"),
				revision: 2,
				status: "completed",
				priority: "high",
				definitionDigest: digest,
				dependencyIds: [],
				outputRefs: [{ subjectKind: "artifact", digest, mediaType: "text/plain", size: 12 }],
			}],
			sourceHead,
			projectionDigest: digest,
			builtAt: "2026-08-01T00:00:00.000Z",
			completeness: "complete",
		};

		expect(isRuntimeProjection(projection)).toBe(true);
		expect(isRuntimeProjection({
			...projection,
			tasks: [{ ...projection.tasks[0], output: "unbounded secret" }],
		})).toBe(false);
	});

	it("binds snapshots to an event range without claiming independent authority", () => {
		const descriptor = {
			snapshotId: createRuntimeId("snapshot", "projection"),
			snapshotKind: "session_projection",
			sourceRange: {
				stream: {
					scope: "session",
					streamId: createRuntimeId("session", "projection"),
					sessionId: createRuntimeId("session", "projection"),
				},
				startSequence: 0,
				endSequence: 7,
				head: sourceHead,
				rangeDigest: digest,
				complete: true,
			},
			snapshotDigest: digest,
			builtAt: "2026-08-01T00:00:00.000Z",
			completeness: "complete",
		};

		expect(isRuntimeSnapshotDescriptor(descriptor)).toBe(true);
		expect(isRuntimeSnapshotDescriptor({ ...descriptor, grantsCapability: true })).toBe(false);
		expect(isRuntimeSnapshotDescriptor({ ...descriptor, sourceRange: { ...descriptor.sourceRange, complete: false } })).toBe(true);
	});
});
