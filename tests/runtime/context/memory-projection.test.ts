/**
 * MEMORY.md projection 测试 —— 只读投影只含 approved 且未过期/未撤销
 * record，顺序稳定、可重建、digest 确定。
 */

import { describe, expect, it } from "vitest";
import { createRuntimeId, runtimeDigest } from "../../../src/runtime/contracts/public.ts";
import type { MemoryRecord } from "../../../src/runtime/context/memory/types.ts";
import { renderMemoryProjection } from "../../../src/runtime/context/memory/projection.ts";

const NOW = Date.parse("2026-08-05T00:00:00.000Z");

function record(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
	return {
		memoryId: createRuntimeId("memory", "projection-record"),
		scope: "workspace",
		workspaceId: createRuntimeId("workspace", "projection"),
		title: "release rule",
		contentDigest: runtimeDigest("content"),
		contentRef: { subjectKind: "content", digest: runtimeDigest("content"), mediaType: "text/plain", size: 10 },
		revision: 1,
		trust: "approved",
		provenance: {
			sourceKind: "user",
			sourceRef: { subjectKind: "content", digest: runtimeDigest("source"), mediaType: "text/plain", size: 6 },
			sourceDigest: runtimeDigest("source"),
			createdAt: "2026-08-01T00:00:00.000Z",
		},
		approvedAt: "2026-08-02T00:00:00.000Z",
		revocationRevision: 0,
		...overrides,
	};
}

describe("renderMemoryProjection", () => {
	it("renders only approved records with stable ordering and a digest", () => {
		const first = record({ memoryId: createRuntimeId("memory", "b-record"), title: "beta" });
		const second = record({ memoryId: createRuntimeId("memory", "a-record"), title: "alpha" });
		const pending = record({ memoryId: createRuntimeId("memory", "pending-record"), trust: "proposed" });
		const revoked = record({ memoryId: createRuntimeId("memory", "revoked-record"), revocationRevision: 3 });

		const projection = renderMemoryProjection({ records: [first, second, pending, revoked], now: NOW });

		expect(projection.recordCount).toBe(2);
		// 稳定排序：a-record 在 b-record 前。
		expect(projection.text.indexOf("alpha")).toBeLessThan(projection.text.indexOf("beta"));
		expect(projection.text).toContain("# RunLedger Memory");
		expect(projection.text).toContain("## alpha");
		expect(projection.text).not.toContain("pending-record");
		expect(projection.text).not.toContain("revoked-record");
		expect(projection.digest.algorithm).toBe("sha256");
	});

	it("excludes expired records", () => {
		const expired = record({ memoryId: createRuntimeId("memory", "expired"), expiresAt: "2020-01-01T00:00:00.000Z" });
		const projection = renderMemoryProjection({ records: [expired], now: NOW });
		expect(projection.recordCount).toBe(0);
		expect(projection.text).toContain("_No approved memory records._");
	});

	it("is deterministic for the same input", () => {
		const records = [
			record({ memoryId: createRuntimeId("memory", "x"), title: "x" }),
			record({ memoryId: createRuntimeId("memory", "y"), title: "y" }),
		];
		const first = renderMemoryProjection({ records, now: NOW });
		const second = renderMemoryProjection({ records: [...records].reverse(), now: NOW });
		expect(first.text).toBe(second.text);
		expect(first.digest).toEqual(second.digest);
	});
});
