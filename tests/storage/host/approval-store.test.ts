import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildRunledgerLayout } from "../../../src/runtime/contracts/storage-layout.ts";
import { createRuntimeId, runtimeDigest, type ApprovalReceiptRef } from "../../../src/runtime/contracts/public.ts";
import { JsonApprovalStateStore } from "../../../src/storage/host/approval-store.ts";

function receipt(decisionRevision = 1): ApprovalReceiptRef {
	const body = {
		approvalId: createRuntimeId("approval", "persistent-approval"),
		requestDigest: runtimeDigest("persistent-request"),
		scope: "once" as const,
		decision: "allowed" as const,
		decisionRevision,
		principalId: createRuntimeId("principal", "approver"),
		decidedAt: "2026-08-05T00:00:00.000Z",
		expiresAt: "2026-08-05T00:01:00.000Z",
	};
	return {
		...body,
		receiptId: createRuntimeId("receipt", `approval-${decisionRevision}`),
		receiptDigest: runtimeDigest(body),
	};
}

describe("JsonApprovalStateStore", () => {
	it("survives a host reconstruction and enforces receipt revisions", async () => {
		const home = await mkdtemp(join(tmpdir(), "runledger-approval-store-"));
		try {
			const layout = buildRunledgerLayout(home, "posix");
			const first = new JsonApprovalStateStore({ layout, workspaceStorageKey: `ws-${"a".repeat(64)}` });
			expect(await first.commit(receipt(), 0)).toMatchObject({ ok: true });

			const second = new JsonApprovalStateStore({ layout, workspaceStorageKey: `ws-${"a".repeat(64)}` });
			expect(await second.read(receipt().approvalId)).toEqual(receipt());
			expect(await second.commit(receipt(2), 0)).toMatchObject({ ok: false, error: { code: "approval_stale" } });
			expect(await second.commit(receipt(2), 1)).toMatchObject({ ok: true });
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});
});
