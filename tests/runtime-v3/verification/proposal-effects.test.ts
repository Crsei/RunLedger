import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalDigest } from "../../../src/runtime/protocol/v3/canonical-json.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/v3/ids.ts";
import { createChangeProposal, createHumanGateRequest, draftPrProviderReceiptDigest, humanGateDecisionDigest } from "../../../src/runtime/verification/change-proposal.ts";
import {
	DurableDraftPrService,
	DurableHumanGateService,
	FileProposalEffectRepository,
	MemoryProposalEffectRepository,
	humanGateOrganizationReceiptDigest,
	type HumanGateOrganizationReceipt,
	type ProposalEffectCanonicalEventPort,
} from "../../../src/runtime/verification/proposal-effects.ts";
import type {
	ChangeProposalRef,
	DraftPrProviderReceipt,
	DraftPrRequest,
	HumanGateDecision,
	HumanGateRequest,
	VerificationCoreResult,
} from "../../../src/runtime/verification/types.ts";

const authorityId = createRuntimeId("authority", "proposal-effects");
const tenantId = createRuntimeId("tenant", "proposal-effects");
const requesterId = createRuntimeId("principal", "proposal-requester");
const builderId = createRuntimeId("principal", "proposal-builder");
const reviewerId = createRuntimeId("principal", "proposal-reviewer");
const organizationId = createRuntimeId("principal", "proposal-organization");
const requestId = createRuntimeId("command", "proposal-effects");
const now = "2026-07-24T00:00:00.000Z";
const roots: string[] = [];

function proposal(): ChangeProposalRef {
	const value = createChangeProposal({
		authorityId,
		tenantId,
		proposalId: createRuntimeId("changeProposal", "proposal-effects"),
		sessionId: createRuntimeId("session", "proposal-effects"),
		createdBy: builderId,
		repositoryId: createRuntimeId("repository", "proposal-effects"),
		workspaceId: createRuntimeId("workspace", "proposal-effects"),
		baseCommit: "base",
		candidateCommit: "candidate",
		candidateBindingDigest: canonicalDigest("candidate-binding"),
		proposalArtifact: {
			authorityId,
			tenantId,
			artifactId: createRuntimeId("artifact", "proposal-effects"),
			storedDigest: canonicalDigest("proposal-artifact"),
			kind: "change_proposal",
			originalSize: 100,
			storedSize: 80,
			mediaType: "application/vnd.runledger.change-proposal+json",
			redaction: "redacted",
			transformReceipt: createRuntimeId("receipt", "proposal-transform"),
			workspaceId: createRuntimeId("workspace", "proposal-effects"),
		},
		verificationReceiptDigests: [canonicalDigest("verification")],
		episodeSeal: {
			authorityId,
			tenantId,
			sealId: createRuntimeId("episodeSeal", "proposal-effects"),
			sealDigest: canonicalDigest("seal"),
			sealRecordDigest: canonicalDigest("seal-record"),
			manifestBodyDigest: canonicalDigest("manifest"),
		},
		createdAt: now,
	});
	if (!value.ok) throw new Error(value.error.message);
	return value.value;
}

function draftRequest(): DraftPrRequest {
	return {
		authorityId,
		tenantId,
		requestId,
		idempotencyKey: createRuntimeId("command", "proposal-effects-idempotency"),
		requestedBy: requesterId,
		providerId: "github-enterprise",
		authorizationReceiptId: createRuntimeId("receipt", "proposal-authorization"),
		authorizationReceiptDigest: canonicalDigest("proposal-authorization"),
		proposal: proposal(),
	};
}

function draftReceipt(request: DraftPrRequest): DraftPrProviderReceipt {
	const body = {
		schemaVersion: 1 as const,
		authorityId,
		tenantId,
		receiptId: createRuntimeId("receipt", "proposal-provider"),
		requestId: request.requestId,
		providerId: request.providerId,
		proposalId: request.proposal.proposalId,
		proposalDigest: request.proposal.proposalDigest,
		sealId: request.proposal.episodeSeal.sealId,
		sealDigest: request.proposal.episodeSeal.sealDigest,
		repositoryId: request.proposal.repositoryId,
		candidateCommit: request.proposal.candidateCommit,
		draft: true as const,
		externalReferenceDigest: canonicalDigest("proposal-external"),
		providerRevision: 1,
		createdAt: now,
	};
	return { ...body, receiptDigest: draftPrProviderReceiptDigest(body) };
}

function humanRequest(): HumanGateRequest {
	const value = createHumanGateRequest({
		authorityId,
		tenantId,
		humanGateId: createRuntimeId("humanGate", "proposal-effects"),
		requestId,
		requestedBy: requesterId,
		action: "merge",
		proposal: proposal(),
		requestedAt: now,
	});
	if (!value.ok) throw new Error(value.error.message);
	return value.value;
}

function humanDecision(request: HumanGateRequest, decidedBy = reviewerId): HumanGateDecision {
	const body = {
		schemaVersion: 1 as const,
		authorityId,
		tenantId,
		humanGateId: request.humanGateId,
		requestId: request.requestId,
		proposalId: request.proposal.proposalId,
		proposalDigest: request.proposal.proposalDigest,
		action: request.action,
		decision: "approved" as const,
		decisionAuthority: "human" as const,
		decidedBy,
		receiptId: createRuntimeId("receipt", `proposal-decision-${decidedBy}`),
		decisionReasonDigest: canonicalDigest("proposal-decision"),
		decidedAt: now,
	};
	return { ...body, receiptDigest: humanGateDecisionDigest(body) };
}

function organizationReceipt(request: HumanGateRequest): HumanGateOrganizationReceipt {
	const body = {
		schemaVersion: 1 as const,
		authorityId,
		tenantId,
		receiptId: createRuntimeId("receipt", "proposal-organization"),
		humanGateId: request.humanGateId,
		requestId: request.requestId,
		policyReceiptId: createRuntimeId("receipt", "proposal-policy"),
		policyReceiptDigest: canonicalDigest("proposal-policy"),
		serverScope: "control_plane" as const,
		action: request.action,
		outcome: "allowed" as const,
		decidedBy: organizationId,
		decidedAt: now,
	};
	return { ...body, receiptDigest: humanGateOrganizationReceiptDigest(body) };
}

class Events implements ProposalEffectCanonicalEventPort {
	public draftRequested = 0;
	public draftTerminal = 0;
	public humanRequested = 0;
	public humanTerminal = 0;
	public reconciliations = 0;
	public failDraftTerminalOnce = false;

	private ok(seed: string): VerificationCoreResult<{ eventDigest: string }> {
		return { ok: true, value: { eventDigest: canonicalDigest(seed) } };
	}

	public async recordDraftRequested() {
		this.draftRequested += 1;
		return this.ok("draft-requested");
	}

	public async recordDraftTerminal() {
		this.draftTerminal += 1;
		if (this.failDraftTerminalOnce) {
			this.failDraftTerminalOnce = false;
			return {
				ok: false as const,
				error: { code: "durable_write_failed" as const, message: "event ack lost", retryable: true },
			};
		}
		return this.ok("draft-terminal");
	}

	public async recordHumanGateRequested() {
		this.humanRequested += 1;
		return this.ok("human-requested");
	}

	public async recordHumanGateTerminal() {
		this.humanTerminal += 1;
		return this.ok("human-terminal");
	}

	public async recordReconciliationRequired() {
		this.reconciliations += 1;
		return this.ok("reconciliation");
	}
}

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("durable proposal and human gate effects", () => {
	it("repairs Draft PR terminal event ack loss without creating a second draft", async () => {
		const repository = new MemoryProposalEffectRepository();
		const events = new Events();
		events.failDraftTerminalOnce = true;
		let providerCalls = 0;
		const request = draftRequest();
		const service = new DurableDraftPrService({
			repository,
			proposals: { inspect: async () => ({ ok: true, value: request.proposal }) },
			provider: {
				createDraft: async () => {
					providerCalls += 1;
					return { ok: true, value: draftReceipt(request) };
				},
			},
			sealTrust: { verify: async () => true },
			events,
			clock: () => new Date(now),
		});
		expect(await service.request(request)).toMatchObject({
			ok: false,
			error: { code: "durable_write_failed" },
		});
		expect(await repository.load(authorityId, tenantId, requestId))
			.toMatchObject({ ok: true, value: { state: "terminal_pending", receipt: { draft: true } } });
		expect(await service.request(request)).toMatchObject({ ok: true, value: { draft: true } });
		expect(providerCalls).toBe(1);
		expect(events.draftTerminal).toBe(2);
	});

	it("never auto-retries an unknown provider outcome and requires correlated reconciliation", async () => {
		const repository = new MemoryProposalEffectRepository();
		const events = new Events();
		let calls = 0;
		const request = draftRequest();
		const service = new DurableDraftPrService({
			repository,
			proposals: { inspect: async () => ({ ok: true, value: request.proposal }) },
			provider: {
				createDraft: async () => {
					calls += 1;
					throw new Error("ack lost");
				},
			},
			sealTrust: { verify: async () => true },
			events,
			clock: () => new Date(now),
		});
		expect(await service.request(request)).toMatchObject({
			ok: false,
			error: { code: "reconciliation_required" },
		});
		expect(await service.request(request)).toMatchObject({
			ok: false,
			error: { code: "reconciliation_required" },
		});
		expect(calls).toBe(1);
		expect(events.reconciliations).toBe(1);
	});

	it("requires server-scoped organization evidence and requester/builder separation", async () => {
		const request = humanRequest();
		const events = new Events();
		const repository = new MemoryProposalEffectRepository();
		let organizationCalls = 0;
		let coordinatorCalls = 0;
		const service = new DurableHumanGateService({
			repository,
			organization: {
				authorize: async () => {
					organizationCalls += 1;
					return { ok: true, value: organizationReceipt(request) };
				},
			},
			coordinator: {
				request: async () => ({ ok: true, value: undefined }),
				resolve: async () => {
					coordinatorCalls += 1;
					return { ok: true, value: humanDecision(request) };
				},
			},
			sealTrust: { verify: async () => true },
			events,
			clock: () => new Date(now),
		});
		expect(await service.resolve(request)).toMatchObject({
			ok: true,
			value: { decision: "approved", decidedBy: reviewerId },
		});
		expect(await repository.load(authorityId, tenantId, requestId))
			.toMatchObject({ ok: true, value: { state: "decided", organizationReceipt: { serverScope: "control_plane" } } });
		expect(await service.resolve(request)).toMatchObject({ ok: true, value: { decision: "approved" } });
		expect(organizationCalls).toBe(1);
		expect(coordinatorCalls).toBe(1);

		const selfApproved = new DurableHumanGateService({
			repository: new MemoryProposalEffectRepository(),
			organization: { authorize: async () => ({ ok: true, value: organizationReceipt(request) }) },
			coordinator: {
				request: async () => ({ ok: true, value: undefined }),
				resolve: async () => ({ ok: true, value: humanDecision(request, requesterId) }),
			},
			sealTrust: { verify: async () => true },
			events: new Events(),
			clock: () => new Date(now),
		});
		expect(await selfApproved.resolve(request)).toMatchObject({
			ok: false,
			error: { code: "reconciliation_required" },
		});
	});

	it("replays a 0600 file effect authority and fails closed on corrupt records", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-proposal-effects-"));
		roots.push(root);
		const request = draftRequest();
		let providerCalls = 0;
		const createService = (repository: FileProposalEffectRepository) => new DurableDraftPrService({
			repository,
			proposals: { inspect: async () => ({ ok: true, value: request.proposal }) },
			provider: {
				createDraft: async () => {
					providerCalls += 1;
					return { ok: true, value: draftReceipt(request) };
				},
			},
			sealTrust: { verify: async () => true },
			events: new Events(),
			clock: () => new Date(now),
		});
		expect(await createService(new FileProposalEffectRepository(root)).request(request))
			.toMatchObject({ ok: true, value: { draft: true } });
		expect(await createService(new FileProposalEffectRepository(root)).request(request))
			.toMatchObject({ ok: true, value: { draft: true } });
		expect(providerCalls).toBe(1);
		const scope = (await readdir(root))[0]!;
		const file = join(root, scope, (await readdir(join(root, scope)))[0]!);
		expect((await stat(file)).mode & 0o777).toBe(0o600);
		const original = await readFile(file, "utf8");
		await writeFile(file, `${original.slice(0, -1)}x`, { mode: 0o600 });
		expect(await new FileProposalEffectRepository(root).load(authorityId, tenantId, requestId))
			.toMatchObject({ ok: false, error: { code: "durable_write_failed" } });
	});
});
