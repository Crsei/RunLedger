import { describe, expect, it, vi } from "vitest";
import { ControlPlaneCommandBus } from "../../../src/runtime/control-plane/command-bus.ts";
import { controlPlaneFailure } from "../../../src/runtime/control-plane/errors.ts";
import { InMemoryCommandIdempotencyRepository } from "../../../src/runtime/control-plane/idempotency.ts";
import { ControlPlaneQueryService } from "../../../src/runtime/control-plane/query-service.ts";
import { ShutdownCoordinator } from "../../../src/runtime/control-plane/shutdown.ts";
import type {
	ChangeProposalControlPlanePort,
	ChangeProposalInspectQuery,
	ChangeProposalRequestDraftPrCommand,
	ControlPlaneRequestContext,
	HumanGateControlPlanePort,
	HumanGateResolveCommand,
} from "../../../src/runtime/control-plane/types.ts";
import {
	validateControlPlaneCommand,
	validateControlPlaneQuery,
} from "../../../src/runtime/control-plane/types.ts";
import { canonicalDigest } from "../../../src/runtime/protocol/v3/canonical-json.ts";
import { createIdempotencyKey } from "../../../src/runtime/protocol/v3/coordination.ts";
import { createSessionEventStreamRef } from "../../../src/runtime/protocol/v3/events.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/v3/ids.ts";
import {
	createChangeProposal,
	createHumanGateRequest,
	draftPrProviderReceiptDigest,
	humanGateDecisionDigest,
} from "../../../src/runtime/verification/change-proposal.ts";
import {
	RuntimeChangeProposalControlPlaneAdapter,
	RuntimeHumanGateControlPlaneAdapter,
} from "../../../src/runtime/verification/proposal-control-plane.ts";
import type {
	ChangeProposalRef,
	DraftPrProviderReceipt,
	HumanGateDecision,
	HumanGateRequest,
} from "../../../src/runtime/verification/types.ts";

const AUTHORITY_ID = createRuntimeId("authority", "proposal-control");
const TENANT_ID = createRuntimeId("tenant", "proposal-control");
const REQUESTER_ID = createRuntimeId("principal", "proposal-requester");
const BUILDER_ID = createRuntimeId("principal", "proposal-builder");
const REVIEWER_ID = createRuntimeId("principal", "proposal-reviewer");
const SESSION_ID = createRuntimeId("session", "proposal-control");
const PROPOSAL_ID = createRuntimeId("changeProposal", "proposal-control");
const RUNTIME_ID = createRuntimeId("runtime", "proposal-control");
const HANDLE = { handleId: "handle_proposalcontrol01", sessionId: SESSION_ID, generation: 1 } as const;
const HEAD = {
	stream: createSessionEventStreamRef({ authorityId: AUTHORITY_ID, tenantId: TENANT_ID }, SESSION_ID),
	sequence: 9,
	eventHash: "a".repeat(64),
};
const NOW = "2026-07-22T08:00:05.000Z";

const CONTEXT: ControlPlaneRequestContext = {
	peer: {
		kind: "local",
		transport: "jsonl",
		pid: 202,
		uid: 1000,
		principalId: REQUESTER_ID,
		authenticatedVia: "stdio_parent",
	},
	handshake: {
		kind: "handshake_result",
		requestId: "proposal-control-handshake",
		protocol: { major: 1, minor: 0 },
		controlPlaneSchemaVersion: 1,
		runtimeSchemaVersion: 3,
		features: ["session", "change_proposal", "human_gate"],
		serverInstanceId: RUNTIME_ID,
		remoteAccess: "disabled",
		deliveryGuarantee: "at_least_once",
	},
};

function digest(seed: string): string {
	return canonicalDigest({ seed });
}

function proposal(
	proposalId = PROPOSAL_ID,
	sessionId = SESSION_ID,
): ChangeProposalRef {
	const created = createChangeProposal({
		authorityId: AUTHORITY_ID,
		tenantId: TENANT_ID,
		proposalId,
		sessionId,
		createdBy: BUILDER_ID,
		repositoryId: createRuntimeId("repository", "proposal-control"),
		workspaceId: createRuntimeId("workspace", "proposal-control"),
		baseCommit: "base-commit",
		candidateCommit: "candidate-commit",
		candidateBindingDigest: digest("candidate-binding"),
		proposalArtifact: {
			authorityId: AUTHORITY_ID,
			tenantId: TENANT_ID,
			artifactId: createRuntimeId("artifact", "proposal-control"),
			storedDigest: digest("proposal-artifact"),
			kind: "change_proposal",
			originalSize: 128,
			storedSize: 96,
			mediaType: "application/vnd.runledger.change-proposal+json",
			redaction: "redacted",
			transformReceipt: createRuntimeId("receipt", "proposal-transform"),
			workspaceId: createRuntimeId("workspace", "proposal-control"),
		},
		verificationReceiptDigests: [digest("verification")],
		episodeSeal: {
			authorityId: AUTHORITY_ID,
			tenantId: TENANT_ID,
			sealId: createRuntimeId("episodeSeal", "proposal-control"),
			sealDigest: digest("episode-seal"),
			sealRecordDigest: digest("episode-seal-record"),
			manifestBodyDigest: digest("manifest-body"),
		},
		createdAt: NOW,
	});
	if (!created.ok) throw new Error(created.error.message);
	return created.value;
}

function draftCommand(value = proposal()): ChangeProposalRequestDraftPrCommand {
	return {
		kind: "command",
		type: "changeProposal:requestDraftPr",
		commandId: createRuntimeId("command", "request-draft-pr"),
		idempotencyKey: createIdempotencyKey("request-draft-pr-idempotency"),
		authorityId: AUTHORITY_ID,
		tenantId: TENANT_ID,
		principalId: REQUESTER_ID,
		expectedSessionRevision: HEAD,
		expectedTurnId: null,
		sessionHandle: HANDLE,
		payload: {
			sessionId: SESSION_ID,
			providerId: "github-enterprise",
			authorizationReceiptId: createRuntimeId("receipt", "draft-pr-authorization"),
			authorizationReceiptDigest: digest("draft-pr-authorization"),
			proposal: value,
		},
	};
}

function draftReceipt(
	command: ChangeProposalRequestDraftPrCommand,
	overrides: Partial<Omit<DraftPrProviderReceipt, "receiptDigest">> = {},
): DraftPrProviderReceipt {
	const body: Omit<DraftPrProviderReceipt, "receiptDigest"> = {
		schemaVersion: 1,
		authorityId: command.authorityId,
		tenantId: command.tenantId,
		receiptId: createRuntimeId("receipt", "draft-pr-provider"),
		requestId: command.commandId,
		providerId: command.payload.providerId,
		proposalId: command.payload.proposal.proposalId,
		proposalDigest: command.payload.proposal.proposalDigest,
		sealId: command.payload.proposal.episodeSeal.sealId,
		sealDigest: command.payload.proposal.episodeSeal.sealDigest,
		repositoryId: command.payload.proposal.repositoryId,
		candidateCommit: command.payload.proposal.candidateCommit,
		draft: true,
		externalReferenceDigest: digest("draft-pr-external-reference"),
		providerRevision: 1,
		createdAt: NOW,
		...overrides,
	};
	return { ...body, receiptDigest: draftPrProviderReceiptDigest(body) };
}

function humanRequest(commandId: HumanGateResolveCommand["commandId"]): HumanGateRequest {
	const created = createHumanGateRequest({
		authorityId: AUTHORITY_ID,
		tenantId: TENANT_ID,
		humanGateId: createRuntimeId("humanGate", "proposal-control"),
		requestId: commandId,
		requestedBy: REQUESTER_ID,
		action: "merge",
		proposal: proposal(),
		requestedAt: NOW,
	});
	if (!created.ok) throw new Error(created.error.message);
	return created.value;
}

function humanCommand(): HumanGateResolveCommand {
	const commandId = createRuntimeId("command", "resolve-human-gate");
	return {
		kind: "command",
		type: "humanGate:resolve",
		commandId,
		idempotencyKey: createIdempotencyKey("resolve-human-gate-idempotency"),
		authorityId: AUTHORITY_ID,
		tenantId: TENANT_ID,
		principalId: REQUESTER_ID,
		expectedSessionRevision: HEAD,
		expectedTurnId: null,
		sessionHandle: HANDLE,
		payload: { sessionId: SESSION_ID, request: humanRequest(commandId) },
	};
}

function humanDecision(
	request: HumanGateRequest,
	decidedBy = REVIEWER_ID,
): HumanGateDecision {
	const body: Omit<HumanGateDecision, "receiptDigest"> = {
		schemaVersion: 1,
		authorityId: request.authorityId,
		tenantId: request.tenantId,
		humanGateId: request.humanGateId,
		requestId: request.requestId,
		proposalId: request.proposal.proposalId,
		proposalDigest: request.proposal.proposalDigest,
		action: request.action,
		decision: "approved",
		decisionAuthority: "human",
		decidedBy,
		receiptId: createRuntimeId("receipt", `human-decision-${decidedBy}`),
		decisionReasonDigest: digest("human-decision-reason"),
		decidedAt: NOW,
	};
	return { ...body, receiptDigest: humanGateDecisionDigest(body) };
}

function bus(options: {
	changeProposals?: ChangeProposalControlPlanePort;
	humanGates?: HumanGateControlPlanePort;
} = {}) {
	return new ControlPlaneCommandBus({
		idempotency: new InMemoryCommandIdempotencyRepository(),
		stateGuard: { validate: async () => ({ ok: true, value: undefined }) },
		executor: { execute: async () => controlPlaneFailure("unsupported_feature", "fixture") },
		prompts: {
			preflight: async () => controlPlaneFailure("unsupported_feature", "fixture"),
			enqueueDurable: async () => controlPlaneFailure("unsupported_feature", "fixture"),
		},
		approvals: { resolve: async () => controlPlaneFailure("unsupported_feature", "fixture") },
		...(options.changeProposals ? { changeProposals: options.changeProposals } : {}),
		...(options.humanGates ? { humanGates: options.humanGates } : {}),
		shutdown: new ShutdownCoordinator(),
	});
}

function proposalQuery(proposalId = PROPOSAL_ID): ChangeProposalInspectQuery {
	return {
		kind: "query",
		type: "changeProposal:inspect",
		queryId: "proposal-inspect",
		authorityId: AUTHORITY_ID,
		tenantId: TENANT_ID,
		principalId: REQUESTER_ID,
		payload: { sessionId: SESSION_ID, sessionHandle: HANDLE, proposalId },
	};
}

describe("ChangeProposal and HumanGate Control Plane", () => {
	it("enforces exact command/query schemas and embedded correlation", () => {
		const draft = draftCommand();
		const human = humanCommand();
		const inspect = proposalQuery();
		expect(validateControlPlaneCommand(draft).ok).toBe(true);
		expect(validateControlPlaneCommand(human).ok).toBe(true);
		expect(validateControlPlaneQuery(inspect).ok).toBe(true);
		expect(validateControlPlaneCommand({ ...draft, credentials: "must-not-enter-control-plane" })).toMatchObject({ ok: false });
		expect(validateControlPlaneCommand({
			...human,
			payload: { ...human.payload, request: { ...human.payload.request, generatedByRuntime: true } },
		})).toMatchObject({ ok: false });
		expect(validateControlPlaneQuery({ ...inspect, payload: { ...inspect.payload, cached: true } })).toMatchObject({ ok: false });
	});

	it("routes exact mutations to injected external adapters without creating a decision", async () => {
		const draft = draftCommand();
		const receipt = draftReceipt(draft);
		const human = humanCommand();
		const decision = humanDecision(human.payload.request);
		const changeProposals: ChangeProposalControlPlanePort = {
			inspect: vi.fn(async () => ({ ok: true, value: { type: "changeProposal:inspect", proposal: draft.payload.proposal } })),
			requestDraftPr: vi.fn(async () => ({
				ok: true,
				value: { type: "changeProposal:requestDraftPr", receipt },
			})),
		};
		const humanGates: HumanGateControlPlanePort = {
			resolve: vi.fn(async () => ({ ok: true, value: { type: "humanGate:resolve", decision } })),
		};
		const commands = bus({ changeProposals, humanGates });

		expect(await commands.execute(draft, CONTEXT)).toMatchObject({
			ok: true,
			value: { result: { type: "changeProposal:requestDraftPr", receipt } },
		});
		expect(await commands.execute(human, CONTEXT)).toMatchObject({
			ok: true,
			value: { result: { type: "humanGate:resolve", decision } },
		});
		expect(changeProposals.requestDraftPr).toHaveBeenCalledWith(draft, CONTEXT);
		expect(humanGates.resolve).toHaveBeenCalledWith(human, CONTEXT);
		expect(decision.decidedBy).toBe(REVIEWER_ID);
	});

	it("rejects mismatched Draft PR receipts and requester self-approval", async () => {
		const draft = draftCommand();
		const wrongReceipt = draftReceipt(draft, {
			proposalId: createRuntimeId("changeProposal", "other-proposal"),
		});
		const wrongDraftBus = bus({
			changeProposals: {
				inspect: async () => controlPlaneFailure("unsupported_feature", "fixture"),
				requestDraftPr: async () => ({
					ok: true,
					value: { type: "changeProposal:requestDraftPr", receipt: wrongReceipt },
				}),
			},
		});
		expect(await wrongDraftBus.execute(draft, CONTEXT)).toMatchObject({
			ok: false,
			error: { code: "adapter_contract_violation" },
			effect: "uncertain",
		});

		const human = humanCommand();
		const selfApproval = humanDecision(human.payload.request, REQUESTER_ID);
		const selfApprovalBus = bus({
			humanGates: {
				resolve: async () => ({ ok: true, value: { type: "humanGate:resolve", decision: selfApproval } }),
			},
		});
		expect(await selfApprovalBus.execute(human, CONTEXT)).toMatchObject({
			ok: false,
			error: { code: "adapter_contract_violation" },
			effect: "uncertain",
		});
	});

	it("fails closed when mutation adapters are absent", async () => {
		expect(await bus().execute(draftCommand(), CONTEXT)).toMatchObject({
			ok: false,
			error: { code: "unsupported_feature" },
			effect: "none",
		});
		expect(await bus().execute(humanCommand(), CONTEXT)).toMatchObject({
			ok: false,
			error: { code: "unsupported_feature" },
			effect: "none",
		});
	});

	it("validates inspected proposal scope and returns unsupported when no repository is wired", async () => {
		const expected = proposal();
		const inspect = vi.fn(async () => ({
			ok: true as const,
			value: { type: "changeProposal:inspect" as const, proposal: expected },
		}));
		const service = new ControlPlaneQueryService({
			handles: { validate: () => ({ ok: true, value: undefined }) },
			executor: { execute: (request, context) => request.type === "changeProposal:inspect"
				? inspect(request, context)
				: Promise.resolve(controlPlaneFailure("unsupported_feature", "fixture")) },
		});
		expect(await service.execute(proposalQuery(), CONTEXT)).toMatchObject({
			ok: true,
			value: { result: { type: "changeProposal:inspect", proposal: expected } },
		});
		expect(inspect).toHaveBeenCalledWith(proposalQuery(), CONTEXT);

		const mismatched = proposal(createRuntimeId("changeProposal", "other-proposal"));
		const invalidService = new ControlPlaneQueryService({
			handles: { validate: () => ({ ok: true, value: undefined }) },
			executor: { execute: async () => ({
				ok: true,
				value: { type: "changeProposal:inspect", proposal: mismatched },
			}) },
		});
		expect(await invalidService.execute(proposalQuery(), CONTEXT)).toMatchObject({
			ok: false,
			error: { code: "adapter_contract_violation" },
		});

		const absentService = new ControlPlaneQueryService({
			handles: { validate: () => ({ ok: true, value: undefined }) },
			executor: { execute: async () => controlPlaneFailure("unsupported_feature", "repository is not wired") },
		});
		expect(await absentService.execute(proposalQuery(), CONTEXT)).toMatchObject({
			ok: false,
			error: { code: "unsupported_feature" },
		});
	});

	it("binds Control Plane proposal and HumanGate requests to the durable Phase 11 services", async () => {
		const draft = draftCommand();
		const receipt = draftReceipt(draft);
		const inspect = vi.fn(async () => ({ ok: true as const, value: draft.payload.proposal }));
		const requestDraft = vi.fn(async () => ({ ok: true as const, value: receipt }));
		const proposals = new RuntimeChangeProposalControlPlaneAdapter({
			repository: { inspect },
			drafts: { request: requestDraft },
		});

		expect(await proposals.inspect(proposalQuery(), CONTEXT)).toEqual({
			ok: true,
			value: { type: "changeProposal:inspect", proposal: draft.payload.proposal },
		});
		expect(await proposals.requestDraftPr(draft, CONTEXT)).toEqual({
			ok: true,
			value: { type: "changeProposal:requestDraftPr", receipt },
		});
		expect(inspect).toHaveBeenCalledWith(PROPOSAL_ID);
		expect(requestDraft).toHaveBeenCalledWith({
			authorityId: AUTHORITY_ID,
			tenantId: TENANT_ID,
			requestId: draft.commandId,
			idempotencyKey: draft.commandId,
			requestedBy: REQUESTER_ID,
			providerId: draft.payload.providerId,
			authorizationReceiptId: draft.payload.authorizationReceiptId,
			authorizationReceiptDigest: draft.payload.authorizationReceiptDigest,
			proposal: draft.payload.proposal,
		});

		const human = humanCommand();
		const decision = humanDecision(human.payload.request);
		const resolve = vi.fn(async () => ({ ok: true as const, value: decision }));
		const humanGates = new RuntimeHumanGateControlPlaneAdapter({ resolve });
		expect(await humanGates.resolve(human, CONTEXT)).toEqual({
			ok: true,
			value: { type: "humanGate:resolve", decision },
		});
		expect(resolve).toHaveBeenCalledWith(human.payload.request);
	});

	it("fails closed on mismatched Phase 11 adapter scope and preserves uncertain effects", async () => {
		const draft = draftCommand();
		const request = vi.fn(async () => ({
			ok: false as const,
			error: {
				code: "reconciliation_required" as const,
				message: "provider outcome is unknown",
				retryable: false,
			},
		}));
		const proposals = new RuntimeChangeProposalControlPlaneAdapter({
			repository: {
				inspect: async () => ({ ok: true, value: draft.payload.proposal }),
			},
			drafts: { request },
		});
		expect(await proposals.requestDraftPr(draft, CONTEXT)).toMatchObject({
			ok: false,
			error: { code: "recovery_required" },
			effect: "uncertain",
		});

		const wrongPeer = {
			...CONTEXT,
			peer: { ...CONTEXT.peer, principalId: REVIEWER_ID },
		};
		expect(await proposals.requestDraftPr(draft, wrongPeer)).toMatchObject({
			ok: false,
			error: { code: "unauthorized_peer" },
			effect: "none",
		});
		expect(request).toHaveBeenCalledTimes(1);
	});
});
