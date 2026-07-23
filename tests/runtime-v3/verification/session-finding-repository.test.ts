import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ArtifactRef } from "../../../src/runtime/protocol/v3/capability.ts";
import { canonicalDigest } from "../../../src/runtime/protocol/v3/canonical-json.ts";
import { createRuntimeId, type ArtifactId } from "../../../src/runtime/protocol/v3/ids.ts";
import {
	SessionFindingRepository,
	type FindingSnapshotArtifactPort,
} from "../../../src/runtime/verification/session-finding-repository.ts";
import type { VerificationFinding } from "../../../src/runtime/verification/types.ts";
import { DEFAULT_RUNTIME_FEATURES } from "../../../src/runtime/runtime-features.ts";
import { V3SessionManager } from "../../../src/storage/v3-session-manager.ts";
import { digest } from "../orchestrator/helpers.ts";

const roots: string[] = [];
const managers: V3SessionManager[] = [];

afterEach(async () => {
	await Promise.all(managers.splice(0).map((manager) => manager.closeAll().catch(() => undefined)));
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

class MemoryFindingSnapshots implements FindingSnapshotArtifactPort {
	public readonly values = new Map<ArtifactId, VerificationFinding>();

	public async write(finding: VerificationFinding) {
		const artifactId = createRuntimeId("artifact", `finding-${canonicalDigest(finding).slice(0, 48)}`);
		this.values.set(artifactId, structuredClone(finding));
		const reference: ArtifactRef = {
			authorityId: finding.authorityId,
			tenantId: finding.tenantId,
			artifactId,
			storedDigest: canonicalDigest(finding),
			kind: "session_report",
			originalSize: 1,
			storedSize: 1,
			mediaType: "application/vnd.runledger.verification-finding+json",
			redaction: "redacted",
			transformReceipt: createRuntimeId("receipt", `finding-${finding.revision}`),
		};
		return { ok: true as const, value: reference };
	}

	public async read(artifactId: ArtifactId) {
		return { ok: true as const, value: structuredClone(this.values.get(artifactId)) };
	}
}

describe("SessionFindingRepository", () => {
	it("rebuilds each Finding only from canonical events and immutable Artifact snapshots", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-finding-repository-"));
		roots.push(root);
		const manager = await V3SessionManager.create({
			cwd: root,
			sessionDir: join(root, "sessions"),
			features: DEFAULT_RUNTIME_FEATURES,
		});
		managers.push(manager);
		const snapshots = new MemoryFindingSnapshots();
		const identity = manager.identity();
		const repository = new SessionFindingRepository({
			writer: manager.writer(),
			store: manager.eventStore(),
			principalId: identity.principalId,
			snapshots,
		});
		const finding: VerificationFinding = {
			authorityId: identity.authorityId,
			tenantId: identity.tenantId,
			findingId: createRuntimeId("finding", "durable"),
			verificationId: createRuntimeId("verification", "durable"),
			gateDigest: digest("1"),
			baseCommit: "base",
			candidateCommit: "candidate",
			source: "security_review",
			state: "detected",
			severity: "high",
			policyClass: "security",
			summaryDigest: digest("2"),
			evidenceArtifactIds: [createRuntimeId("artifact", "finding-evidence")],
			confirmation: "candidate",
			revision: 0,
		};
		const head = manager.writer().currentHead();
		if (!head) throw new Error("fixture has no event head");
			const recorded = await repository.record(finding, head);
			if (!recorded.ok) throw new Error(`${recorded.error.code}: ${recorded.error.message}`);
			expect(recorded.ok && recorded.value.state).toBe("detected");
		const nextHead = manager.writer().currentHead();
		if (!nextHead) throw new Error("fixture lost its event head");
		const drafted = { ...finding, state: "drafted" as const, revision: 1 };
		expect((await repository.record(drafted, nextHead)).ok).toBe(true);
		const reopened = new SessionFindingRepository({
			writer: manager.writer(),
			store: manager.eventStore(),
			principalId: identity.principalId,
			snapshots,
		});
		const loaded = await reopened.load();
		expect(loaded.ok && loaded.value).toEqual([drafted]);
		const snapshotId = [...snapshots.values.keys()].find(
			(artifactId) => snapshots.values.get(artifactId)?.revision === 1,
		);
		if (!snapshotId) throw new Error("drafted snapshot missing");
		snapshots.values.set(snapshotId, { ...drafted, candidateCommit: "tampered" });
		expect((await reopened.load()).ok).toBe(false);
	});
});
