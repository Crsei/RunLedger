import { describe, expect, it } from "vitest";
import { canonicalDigest } from "../../../src/runtime/protocol/v3/canonical-json.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/v3/ids.ts";
import { WorkspaceCheckpointCoordinator } from "../../../src/runtime/artifacts/episode-manifest.ts";
import type { LeafActivationPort } from "../../../src/runtime/artifacts/episode-manifest.ts";
import type {
	ArtifactResult,
	CompositeCheckpointRef,
	WorkspaceCheckpointPort,
	WorkspaceCleanupReceipt,
	WorkspaceRewindReceipt,
} from "../../../src/runtime/artifacts/types.ts";
import type { WorkspaceExecutionEnvelope } from "../../../src/runtime/protocol/v3/workspace.ts";
import { DIGEST } from "./helpers.ts";

function fixture() {
	const authorityId = createRuntimeId("authority", "workspace-checkpoint");
	const tenantId = createRuntimeId("tenant", "workspace-checkpoint");
	const workspaceId = createRuntimeId("workspace", "workspace-checkpoint");
	const checkpointId = createRuntimeId("checkpoint", "workspace-checkpoint");
	const targetLeafId = createRuntimeId("leaf", "workspace-checkpoint");
	const checkpoint: CompositeCheckpointRef = {
		authorityId,
		tenantId,
		checkpointId,
		checkpointDigest: DIGEST,
		workspaceId,
		completeness: "complete",
	};
	const envelope: WorkspaceExecutionEnvelope = {
		authorityId,
		tenantId,
		principalId: createRuntimeId("principal", "workspace-checkpoint"),
		sessionId: createRuntimeId("session", "workspace-checkpoint"),
		workspaceId,
		repositoryId: createRuntimeId("repository", "workspace-checkpoint"),
		worktreePath: "/worktrees/runtime",
		branch: "runtime",
		baseCommit: "base",
		agentId: createRuntimeId("agent", "workspace-checkpoint"),
		toolCallId: createRuntimeId("toolCall", "workspace-checkpoint"),
		traceId: createRuntimeId("trace", "workspace-checkpoint"),
		cwd: "/worktrees/runtime",
		ownerRuntimeId: createRuntimeId("runtime", "workspace-checkpoint"),
		leaseRevision: 7,
		fencingToken: "opaque-fence",
	};
	return { authorityId, tenantId, workspaceId, checkpointId, targetLeafId, checkpoint, envelope };
}

function rewindReceipt(
	data: ReturnType<typeof fixture>,
	outcome: WorkspaceRewindReceipt["outcome"],
): WorkspaceRewindReceipt {
	const body = {
		authorityId: data.authorityId,
		tenantId: data.tenantId,
		receiptId: createRuntimeId("receipt", `rewind-${outcome}`),
		checkpointId: data.checkpointId,
		workspaceId: data.workspaceId,
		expectedLeaseRevision: data.envelope.leaseRevision,
		targetLeafId: data.targetLeafId,
		outcome,
	};
	return { ...body, receiptDigest: canonicalDigest(body) };
}

function cleanupReceipt(
	data: ReturnType<typeof fixture>,
	state: WorkspaceCleanupReceipt["state"],
): WorkspaceCleanupReceipt {
	const body = {
		authorityId: data.authorityId,
		tenantId: data.tenantId,
		receiptId: createRuntimeId("receipt", `cleanup-${state}`),
		checkpointId: data.checkpointId,
		workspaceId: data.workspaceId,
		expectedLeaseRevision: data.envelope.leaseRevision,
		state,
	};
	return { ...body, receiptDigest: canonicalDigest(body) };
}

class FakeWorkspacePort implements WorkspaceCheckpointPort {
	rewindResult: WorkspaceRewindReceipt;
	cleanupResult: WorkspaceCleanupReceipt;
	rewindCalls = 0;
	cleanupCalls = 0;

	public constructor(data: ReturnType<typeof fixture>) {
		this.rewindResult = rewindReceipt(data, "applied");
		this.cleanupResult = cleanupReceipt(data, "pending_gc");
	}

	public async rewind(): Promise<ArtifactResult<WorkspaceRewindReceipt>> {
		this.rewindCalls += 1;
		return { ok: true, value: this.rewindResult };
	}

	public async cleanup(): Promise<ArtifactResult<WorkspaceCleanupReceipt>> {
		this.cleanupCalls += 1;
		return { ok: true, value: this.cleanupResult };
	}
}

class FakeLeafActivation implements LeafActivationPort {
	receipts: WorkspaceRewindReceipt[] = [];

	public async activateAfterWorkspaceRewind(receipt: WorkspaceRewindReceipt): Promise<ArtifactResult<void>> {
		this.receipts.push(receipt);
		return { ok: true, value: undefined };
	}
}

describe("workspace checkpoint coordination", () => {
	it("activates a new leaf only after a correlated applied rewind receipt", async () => {
		const data = fixture();
		const workspace = new FakeWorkspacePort(data);
		const activation = new FakeLeafActivation();
		const coordinator = new WorkspaceCheckpointCoordinator(workspace, activation);
		const request = {
			checkpoint: data.checkpoint,
			envelope: data.envelope,
			expectedLeaseRevision: data.envelope.leaseRevision,
			targetLeafId: data.targetLeafId,
		};
		expect(await coordinator.rewind(request)).toMatchObject({ ok: true, value: { outcome: "applied" } });
		expect(activation.receipts).toHaveLength(1);

		workspace.rewindResult = rewindReceipt(data, "interrupted");
		expect(await coordinator.rewind(request)).toMatchObject({ ok: false, error: { code: "durable_write_failed" } });
		expect(activation.receipts).toHaveLength(1);

		workspace.rewindResult = { ...rewindReceipt(data, "applied"), receiptDigest: DIGEST };
		expect(await coordinator.rewind(request)).toMatchObject({ ok: false, error: { code: "corrupted_metadata" } });
		expect(activation.receipts).toHaveLength(1);
	});

	it("rejects stale cleanup fencing before invoking the workspace service and accepts pending-GC receipts", async () => {
		const data = fixture();
		const workspace = new FakeWorkspacePort(data);
		const coordinator = new WorkspaceCheckpointCoordinator(workspace, new FakeLeafActivation());
		expect(await coordinator.cleanup({
			checkpoint: data.checkpoint,
			envelope: data.envelope,
			expectedLeaseRevision: 6,
		})).toMatchObject({ ok: false, error: { code: "fenced" } });
		expect(workspace.cleanupCalls).toBe(0);

		expect(await coordinator.cleanup({
			checkpoint: data.checkpoint,
			envelope: data.envelope,
			expectedLeaseRevision: 7,
		})).toMatchObject({ ok: true, value: { state: "pending_gc" } });
		expect(workspace.cleanupCalls).toBe(1);
	});
});
