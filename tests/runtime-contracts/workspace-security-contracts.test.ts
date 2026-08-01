import { describe, expect, it } from "vitest";
import { createRuntimeId } from "../../src/runtime/protocol/ids.ts";
import {
	isWorkspaceBindingRef,
	isWorkspaceCheckpointDescriptor,
	isWorkspaceLeaseRef,
	isWorkspaceValidationReceiptRef,
} from "../../src/runtime/protocol/workspace.ts";

const digest = {
	algorithm: "sha256",
	digest: "f".repeat(64),
} as const;

const sourceHead = {
	streamId: createRuntimeId("session", "workspace"),
	sequence: 4,
	eventHash: digest,
} as const;

describe("Workspace exact passive contracts", () => {
	it("stores a cwd digest and bounded external ref instead of an absolute durable path", () => {
		const binding = {
			workspaceId: createRuntimeId("workspace", "fixture"),
			repositoryId: createRuntimeId("repository", "fixture"),
			bindingKind: "managed_worktree",
			effectiveCwdDigest: digest,
			baseCommit: "0".repeat(40),
			headCommit: "1".repeat(40),
			worktreeRef: { subjectKind: "receipt", digest },
		};

		expect(isWorkspaceBindingRef(binding)).toBe(true);
		expect(isWorkspaceBindingRef({ ...binding, effectiveCwd: "/tmp/private" })).toBe(false);
		expect(isWorkspaceBindingRef({ ...binding, branch: "unbounded-copy" })).toBe(false);
	});

	it("binds leases and validation receipts to digests, revisions, and source heads", () => {
		const lease = {
			workspaceId: createRuntimeId("workspace", "fixture"),
			ownerRuntimeId: createRuntimeId("runtime", "fixture"),
			leaseRevision: 2,
			fencingTokenDigest: digest,
			state: "active",
			expiresAt: "2026-08-02T01:00:00.000Z",
		};
		const receipt = {
			receiptId: createRuntimeId("receipt", "workspace"),
			workspaceId: createRuntimeId("workspace", "fixture"),
			envelopeDigest: digest,
			validator: {
				adapterId: "workspace-validator",
				generation: 3,
				configDigest: digest,
			},
			validatedAt: "2026-08-02T00:00:00.000Z",
			outcome: "valid",
			sourceHead,
		};

		expect(isWorkspaceLeaseRef(lease)).toBe(true);
		expect(isWorkspaceLeaseRef({ ...lease, fencingToken: "raw-secret" })).toBe(false);
		expect(isWorkspaceValidationReceiptRef(receipt)).toBe(true);
		expect(isWorkspaceValidationReceiptRef({ ...receipt, validatorId: "legacy" })).toBe(false);
	});

	it("binds checkpoints to the exact event head and optional artifact ref", () => {
		const checkpoint = {
			workspaceId: createRuntimeId("workspace", "fixture"),
			eventHead: sourceHead,
			baseCommit: "0".repeat(40),
			headCommit: "1".repeat(40),
			statusDigest: digest,
			snapshotRef: { subjectKind: "snapshot", digest },
			completeness: "complete",
		};

		expect(isWorkspaceCheckpointDescriptor(checkpoint)).toBe(true);
		expect(isWorkspaceCheckpointDescriptor({ ...checkpoint, eventCursor: "legacy" })).toBe(false);
		expect(isWorkspaceCheckpointDescriptor({ ...checkpoint, completeness: "unknown" })).toBe(false);
	});
});
