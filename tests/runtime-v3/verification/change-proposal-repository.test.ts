import { describe, expect, it } from "vitest";
import { canonicalDigest } from "../../../src/runtime/protocol/v3/canonical-json.ts";
import { createSessionEventStreamRef } from "../../../src/runtime/protocol/v3/events.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/v3/ids.ts";
import { EventWriter } from "../../../src/runtime/session/event-writer.ts";
import { MemoryEventStore } from "../../../src/runtime/session/memory-event-store.ts";
import type { WriterFence } from "../../../src/runtime/session/types.ts";
import { createChangeProposal } from "../../../src/runtime/verification/change-proposal.ts";
import { ChangeProposalRepository } from "../../../src/runtime/verification/change-proposal-repository.ts";
import type { ChangeProposalRef } from "../../../src/runtime/verification/types.ts";

const authorityId = createRuntimeId("authority", "proposal-repository");
const tenantId = createRuntimeId("tenant", "proposal-repository");
const principalId = createRuntimeId("principal", "proposal-repository");
const sessionId = createRuntimeId("session", "proposal-repository");
const runtimeId = createRuntimeId("runtime", "proposal-repository");
const stream = createSessionEventStreamRef({ authorityId, tenantId }, sessionId);
const fence: WriterFence = {
	authorityId,
	tenantId,
	stream,
	leaseId: createRuntimeId("lease", "proposal-repository"),
	ownerRuntimeId: runtimeId,
	writerEpoch: 1,
	fencingToken: "proposal-repository-fence",
};

function proposal(
	candidateCommit = "candidate",
	proposalId = createRuntimeId("changeProposal", "proposal-repository"),
): ChangeProposalRef {
	const value = createChangeProposal({
		authorityId,
		tenantId,
		proposalId,
		sessionId,
		createdBy: principalId,
		repositoryId: createRuntimeId("repository", "proposal-repository"),
		workspaceId: createRuntimeId("workspace", "proposal-repository"),
		baseCommit: "base",
		candidateCommit,
		candidateBindingDigest: canonicalDigest({ candidateCommit }),
		proposalArtifact: {
			authorityId,
			tenantId,
			artifactId: createRuntimeId("artifact", "proposal-repository"),
			storedDigest: canonicalDigest("proposal-artifact"),
			kind: "change_proposal",
			originalSize: 100,
			storedSize: 80,
			mediaType: "application/vnd.runledger.change-proposal+json",
			redaction: "redacted",
			transformReceipt: createRuntimeId("receipt", "proposal-transform"),
			workspaceId: createRuntimeId("workspace", "proposal-repository"),
		},
		verificationReceiptDigests: [canonicalDigest("verification")],
		episodeSeal: {
			authorityId,
			tenantId,
			sealId: createRuntimeId("episodeSeal", "proposal-repository"),
			sealDigest: canonicalDigest("seal"),
			sealRecordDigest: canonicalDigest("seal-record"),
			manifestBodyDigest: canonicalDigest("manifest"),
		},
		createdAt: "2026-07-24T00:00:00.000Z",
	});
	if (!value.ok) throw new Error(value.error.message);
	return value.value;
}

async function fixture() {
	const store = new MemoryEventStore({
		authorityId,
		tenantId,
		stream,
		validateFence: () => true,
	});
	const writer = new EventWriter({
		authorityId,
		tenantId,
		stream,
		store,
		fence,
		clock: () => new Date("2026-07-24T00:00:00.000Z"),
	});
	const genesis = await writer.append({
		type: "session.created",
		principalId,
		traceId: createRuntimeId("trace", "proposal-genesis"),
		payload: {
			origin: "test",
			runtimeId,
			featureDigest: canonicalDigest("proposal-features"),
			initialGoalId: createRuntimeId("goal", "proposal-repository"),
			rootAgentId: createRuntimeId("agent", "proposal-repository"),
		},
	});
	if (!genesis.ok) throw new Error(genesis.error.message);
	return { store, writer, head: genesis.value.cursor };
}

describe("ChangeProposal canonical repository", () => {
	it("records the full bounded v3 ref with mandatory durability and restart projection", async () => {
		const { store, writer, head } = await fixture();
		const value = proposal();
		const repository = new ChangeProposalRepository(store, writer);
		const recorded = await repository.record({
			proposal: value,
			expectedRevision: head,
			principalId,
			traceId: createRuntimeId("trace", "proposal-record"),
		});
		if (!recorded.ok) throw new Error(recorded.error.message);
		expect(recorded).toMatchObject({
			ok: true,
			value: {
				disposition: "committed",
				event: { type: "change_proposal.recorded", payload: { proposal: { schemaVersion: 3 } } },
				durableReceipt: { sequence: 1 },
			},
		});

		const reopenedWriter = new EventWriter({
			authorityId,
			tenantId,
			stream,
			store,
			fence,
			initialHead: writer.currentHead(),
		});
		const reopened = new ChangeProposalRepository(store, reopenedWriter);
		expect(await reopened.inspect(value.proposalId)).toEqual({ ok: true, value });
		expect(await reopened.record({
			proposal: value,
			expectedRevision: head,
			principalId,
			traceId: createRuntimeId("trace", "proposal-replay"),
		})).toMatchObject({ ok: true, value: { disposition: "replayed" } });
	});

	it("rejects changed-input reuse and stale expected revisions", async () => {
		const { store, writer, head } = await fixture();
		const repository = new ChangeProposalRepository(store, writer);
		await repository.record({
			proposal: proposal(),
			expectedRevision: head,
			principalId,
			traceId: createRuntimeId("trace", "proposal-record"),
		});
		expect(await repository.record({
			proposal: proposal("changed"),
			expectedRevision: head,
			principalId,
			traceId: createRuntimeId("trace", "proposal-conflict"),
		})).toMatchObject({ ok: false, error: { code: "invalid_event" } });

		expect(await repository.record({
			proposal: proposal("other", createRuntimeId("changeProposal", "proposal-other")),
			expectedRevision: head,
			principalId,
			traceId: createRuntimeId("trace", "proposal-stale"),
		})).toMatchObject({ ok: false, error: { code: "invalid_event" } });
	});
});
