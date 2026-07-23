/** Draft PR 与 HumanGate 的 durable effect authority。 */

import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { withDurableStateLock } from "../durable-state-lock.ts";
import { canonicalDigest, canonicalJson } from "../protocol/v3/canonical-json.ts";
import {
	isRuntimeId,
	type CommandId,
	type PrincipalId,
	type ReceiptId,
} from "../protocol/v3/ids.ts";
import {
	isDraftPrProviderReceipt,
	isHumanGateDecision,
	requestDraftPr,
	resolveHumanGate,
	type EpisodeSealTrustPort,
} from "./change-proposal.ts";
import type { ChangeProposalRepository } from "./change-proposal-repository.ts";
import type {
	ChangeProposalProviderPort,
	DraftPrProviderReceipt,
	DraftPrRequest,
	HumanGateCoordinatorPort,
	HumanGateDecision,
	HumanGateRequest,
	VerificationCoreResult,
} from "./types.ts";

export const PROPOSAL_EFFECT_SCHEMA_VERSION = 1 as const;

export type ProposalEffectState =
	| "request_prepared"
	| "effect_pending"
	| "terminal_pending"
	| "draft_created"
	| "draft_failed"
	| "requested"
	| "decision_pending"
	| "decided"
	| "reconciliation_required";

export interface HumanGateOrganizationReceiptBody {
	schemaVersion: 1;
	authorityId: HumanGateRequest["authorityId"];
	tenantId: HumanGateRequest["tenantId"];
	receiptId: ReceiptId;
	humanGateId: HumanGateRequest["humanGateId"];
	requestId: CommandId;
	policyReceiptId: ReceiptId;
	policyReceiptDigest: string;
	serverScope: "control_plane";
	action: HumanGateRequest["action"];
	outcome: "allowed" | "denied";
	decidedBy: PrincipalId;
	decidedAt: string;
}

export interface HumanGateOrganizationReceipt extends HumanGateOrganizationReceiptBody {
	receiptDigest: string;
}

export type ProposalEffectRecordBody =
	| {
			schemaVersion: typeof PROPOSAL_EFFECT_SCHEMA_VERSION;
			kind: "draft_pr";
			authorityId: DraftPrRequest["authorityId"];
			tenantId: DraftPrRequest["tenantId"];
			requestId: CommandId;
			requestDigest: string;
			state: "request_prepared" | "effect_pending" | "terminal_pending" | "draft_created" | "draft_failed" | "reconciliation_required";
			request: DraftPrRequest;
			revision: number;
			previousRecordDigest: string | null;
			requestedEventDigest?: string;
			terminalEventDigest?: string;
			receipt?: DraftPrProviderReceipt;
			errorDigest?: string;
			updatedAt: string;
	  }
	| {
			schemaVersion: typeof PROPOSAL_EFFECT_SCHEMA_VERSION;
			kind: "human_gate";
			authorityId: HumanGateRequest["authorityId"];
			tenantId: HumanGateRequest["tenantId"];
			requestId: CommandId;
			requestDigest: string;
			state: "requested" | "decision_pending" | "terminal_pending" | "decided" | "reconciliation_required";
			request: HumanGateRequest;
			organizationReceipt: HumanGateOrganizationReceipt;
			revision: number;
			previousRecordDigest: string | null;
			requestedEventDigest?: string;
			terminalEventDigest?: string;
			decision?: HumanGateDecision;
			errorDigest?: string;
			updatedAt: string;
	  };

export type ProposalEffectRecord = ProposalEffectRecordBody & { recordDigest: string };

export interface ProposalEffectRepository {
	load(
		authorityId: ProposalEffectRecord["authorityId"],
		tenantId: ProposalEffectRecord["tenantId"],
		requestId: CommandId,
	): Promise<VerificationCoreResult<ProposalEffectRecord>>;
	prepare(record: ProposalEffectRecord): Promise<VerificationCoreResult<ProposalEffectRecord>>;
	compareAndSet(
		current: ProposalEffectRecord,
		candidate: ProposalEffectRecord,
	): Promise<VerificationCoreResult<ProposalEffectRecord>>;
}

export interface ProposalEffectCanonicalEventPort {
	recordDraftRequested(record: Extract<ProposalEffectRecord, { kind: "draft_pr" }>): Promise<VerificationCoreResult<{ eventDigest: string }>>;
	recordDraftTerminal(record: Extract<ProposalEffectRecord, { kind: "draft_pr" }>): Promise<VerificationCoreResult<{ eventDigest: string }>>;
	recordHumanGateRequested(record: Extract<ProposalEffectRecord, { kind: "human_gate" }>): Promise<VerificationCoreResult<{ eventDigest: string }>>;
	recordHumanGateTerminal(record: Extract<ProposalEffectRecord, { kind: "human_gate" }>): Promise<VerificationCoreResult<{ eventDigest: string }>>;
	recordReconciliationRequired(record: ProposalEffectRecord): Promise<VerificationCoreResult<{ eventDigest: string }>>;
}

export interface DraftPrReconciliationPort {
	reconcile(
		record: Extract<ProposalEffectRecord, { kind: "draft_pr" }>,
		signal?: AbortSignal,
	): Promise<VerificationCoreResult<DraftPrProviderReceipt>>;
}

export interface HumanGateReconciliationPort {
	reconcile(
		record: Extract<ProposalEffectRecord, { kind: "human_gate" }>,
		signal?: AbortSignal,
	): Promise<VerificationCoreResult<HumanGateDecision>>;
}

export interface HumanGateOrganizationPort {
	authorize(
		request: HumanGateRequest,
		signal?: AbortSignal,
	): Promise<VerificationCoreResult<HumanGateOrganizationReceipt>>;
}

function failure<T>(
	code:
		| "invalid_schema"
		| "conflict"
		| "reconciliation_required"
		| "durable_write_failed"
		| "human_gate_required"
		| "provider_unavailable",
	message: string,
	retryable = false,
): VerificationCoreResult<T> {
	return { ok: false, error: { code, message, retryable } };
}

function body(record: ProposalEffectRecord): ProposalEffectRecordBody {
	const { recordDigest: _recordDigest, ...value } = record;
	return value;
}

function withDigest(value: ProposalEffectRecordBody): ProposalEffectRecord {
	return { ...value, recordDigest: canonicalDigest(value) };
}

function keyOf(record: Pick<ProposalEffectRecord, "authorityId" | "tenantId" | "requestId">): string {
	return `${record.authorityId}\u0000${record.tenantId}\u0000${record.requestId}`;
}

function validOrganizationReceipt(
	receipt: HumanGateOrganizationReceipt,
	request?: HumanGateRequest,
): boolean {
	const { receiptDigest: _receiptDigest, ...receiptBody } = receipt;
	return receipt.schemaVersion === 1 &&
		isRuntimeId(receipt.authorityId, "authority") &&
		isRuntimeId(receipt.tenantId, "tenant") &&
		isRuntimeId(receipt.receiptId, "receipt") &&
		isRuntimeId(receipt.humanGateId, "humanGate") &&
		isRuntimeId(receipt.requestId, "command") &&
		isRuntimeId(receipt.policyReceiptId, "receipt") &&
		isRuntimeId(receipt.decidedBy, "principal") &&
		receipt.serverScope === "control_plane" &&
		receipt.outcome !== undefined &&
		/^[a-f0-9]{64}$/.test(receipt.policyReceiptDigest) &&
		receipt.receiptDigest === canonicalDigest(receiptBody) &&
		(!request || (
			receipt.authorityId === request.authorityId &&
			receipt.tenantId === request.tenantId &&
			receipt.humanGateId === request.humanGateId &&
			receipt.requestId === request.requestId &&
			receipt.action === request.action &&
			receipt.decidedBy !== request.requestedBy &&
			receipt.decidedBy !== request.proposal.createdBy
		));
}

function validRecord(record: ProposalEffectRecord): boolean {
	if (
		record.schemaVersion !== PROPOSAL_EFFECT_SCHEMA_VERSION ||
		!isRuntimeId(record.authorityId, "authority") ||
		!isRuntimeId(record.tenantId, "tenant") ||
		!isRuntimeId(record.requestId, "command") ||
		!/^[a-f0-9]{64}$/.test(record.requestDigest) ||
		!Number.isSafeInteger(record.revision) ||
		record.revision < 1 ||
		(record.previousRecordDigest !== null && !/^[a-f0-9]{64}$/.test(record.previousRecordDigest)) ||
		!Number.isFinite(Date.parse(record.updatedAt)) ||
		!/^[a-f0-9]{64}$/.test(record.recordDigest) ||
		record.recordDigest !== canonicalDigest(body(record))
	) return false;
	if (record.kind === "draft_pr") {
		return record.request.authorityId === record.authorityId &&
			record.request.tenantId === record.tenantId &&
			record.request.requestId === record.requestId &&
			(record.receipt === undefined || isDraftPrProviderReceipt(record.receipt));
	}
	return record.request.authorityId === record.authorityId &&
		record.request.tenantId === record.tenantId &&
		record.request.requestId === record.requestId &&
		validOrganizationReceipt(record.organizationReceipt, record.request) &&
		(record.decision === undefined || isHumanGateDecision(record.decision));
}

const transitions: Readonly<Record<ProposalEffectState, readonly ProposalEffectState[]>> = {
	request_prepared: ["effect_pending", "draft_failed"],
	effect_pending: ["terminal_pending", "draft_failed", "reconciliation_required"],
	terminal_pending: ["draft_created", "decided"],
	draft_created: [],
	draft_failed: [],
	requested: ["decision_pending"],
	decision_pending: ["terminal_pending", "reconciliation_required"],
	decided: [],
	reconciliation_required: ["terminal_pending"],
};

function transition<TRecord extends ProposalEffectRecord>(
	current: TRecord,
	state: TRecord["state"],
	updatedAt: string,
	patch: Partial<ProposalEffectRecordBody>,
): VerificationCoreResult<TRecord> {
	if (!transitions[current.state].includes(state)) {
		return failure("conflict", `invalid proposal effect transition ${current.state} -> ${state}`);
	}
	const candidate = withDigest({
		...body(current),
		...patch,
		state,
		revision: current.revision + 1,
		previousRecordDigest: current.recordDigest,
		updatedAt,
	} as ProposalEffectRecordBody);
	return validRecord(candidate)
		? { ok: true, value: candidate as TRecord }
		: failure("invalid_schema", "proposal effect transition is invalid");
}

export class MemoryProposalEffectRepository implements ProposalEffectRepository {
	readonly #records = new Map<string, ProposalEffectRecord>();

	public async load(
		authorityId: ProposalEffectRecord["authorityId"],
		tenantId: ProposalEffectRecord["tenantId"],
		requestId: CommandId,
	): Promise<VerificationCoreResult<ProposalEffectRecord>> {
		const value = this.#records.get(keyOf({ authorityId, tenantId, requestId }));
		return value ? { ok: true, value: structuredClone(value) } : failure("invalid_schema", "proposal effect record was not found");
	}

	public async prepare(record: ProposalEffectRecord): Promise<VerificationCoreResult<ProposalEffectRecord>> {
		if (!validRecord(record) || record.revision !== 1) return failure("invalid_schema", "proposal effect prepared record is invalid");
		const key = keyOf(record);
		const existing = this.#records.get(key);
		if (existing) {
			return existing.requestDigest === record.requestDigest && existing.kind === record.kind
				? { ok: true, value: structuredClone(existing) }
				: failure("conflict", "proposal effect requestId was reused with changed input");
		}
		this.#records.set(key, structuredClone(record));
		return { ok: true, value: structuredClone(record) };
	}

	public async compareAndSet(
		current: ProposalEffectRecord,
		candidate: ProposalEffectRecord,
	): Promise<VerificationCoreResult<ProposalEffectRecord>> {
		if (!validRecord(current) || !validRecord(candidate)) return failure("invalid_schema", "proposal effect CAS record is invalid");
		const key = keyOf(current);
		const stored = this.#records.get(key);
		if (!stored || stored.recordDigest !== current.recordDigest || candidate.previousRecordDigest !== current.recordDigest) {
			return failure("conflict", "proposal effect CAS expectation is stale");
		}
		this.#records.set(key, structuredClone(candidate));
		return { ok: true, value: structuredClone(candidate) };
	}
}

export class FileProposalEffectRepository implements ProposalEffectRepository {
	readonly #root: string;

	public constructor(root: string) {
		this.#root = resolve(root);
	}

	#path(scope: Pick<ProposalEffectRecord, "authorityId" | "tenantId" | "requestId">): string {
		return join(
			this.#root,
			canonicalDigest({ authorityId: scope.authorityId, tenantId: scope.tenantId }),
			`${canonicalDigest({ requestId: scope.requestId })}.json`,
		);
	}

	async #read(path: string): Promise<VerificationCoreResult<ProposalEffectRecord | undefined>> {
		try {
			const bytes = await readFile(path);
			if (bytes.byteLength > 16 * 1024 * 1024) return failure("durable_write_failed", "proposal effect record exceeds limit");
			const value: unknown = JSON.parse(bytes.toString("utf8"));
			return typeof value === "object" && value !== null && validRecord(value as ProposalEffectRecord)
				? { ok: true, value: value as ProposalEffectRecord }
				: failure("durable_write_failed", "proposal effect record failed integrity validation");
		} catch (error) {
			if (error instanceof SyntaxError) return failure("durable_write_failed", "proposal effect record is not valid JSON");
			const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
			return code === "ENOENT"
				? { ok: true, value: undefined }
				: failure("durable_write_failed", "proposal effect record could not be read", true);
		}
	}

	async #write(path: string, record: ProposalEffectRecord): Promise<VerificationCoreResult<ProposalEffectRecord>> {
		const directory = dirname(path);
		const temporary = `${path}.${canonicalDigest({ digest: record.recordDigest, nonce: crypto.randomUUID() })}.tmp`;
		let handle: Awaited<ReturnType<typeof open>> | undefined;
		try {
			await mkdir(directory, { recursive: true, mode: 0o700 });
			handle = await open(temporary, "wx", 0o600);
			await handle.writeFile(canonicalJson(record), "utf8");
			await handle.sync();
			await handle.close();
			handle = undefined;
			await rename(temporary, path);
			const directoryHandle = await open(directory, "r");
			try {
				await directoryHandle.sync();
			} finally {
				await directoryHandle.close();
			}
			return { ok: true, value: record };
		} catch {
			if (handle) await handle.close().catch(() => undefined);
			await unlink(temporary).catch(() => undefined);
			return failure("durable_write_failed", "proposal effect record could not be published", true);
		}
	}

	public async load(
		authorityId: ProposalEffectRecord["authorityId"],
		tenantId: ProposalEffectRecord["tenantId"],
		requestId: CommandId,
	): Promise<VerificationCoreResult<ProposalEffectRecord>> {
		const value = await this.#read(this.#path({ authorityId, tenantId, requestId }));
		return value.ok && value.value ? { ok: true, value: value.value } :
			value.ok ? failure("invalid_schema", "proposal effect record was not found") : value;
	}

	public async prepare(record: ProposalEffectRecord): Promise<VerificationCoreResult<ProposalEffectRecord>> {
		if (!validRecord(record) || record.revision !== 1) return failure("invalid_schema", "proposal effect prepared record is invalid");
		const path = this.#path(record);
		try {
			return await withDurableStateLock(path, async () => {
				const existing = await this.#read(path);
				if (!existing.ok) return existing;
				if (existing.value) {
					return existing.value.requestDigest === record.requestDigest && existing.value.kind === record.kind
						? { ok: true, value: existing.value }
						: failure("conflict", "proposal effect requestId was reused with changed input");
				}
				return this.#write(path, record);
			});
		} catch {
			return failure("durable_write_failed", "proposal effect state lock is unavailable", true);
		}
	}

	public async compareAndSet(
		current: ProposalEffectRecord,
		candidate: ProposalEffectRecord,
	): Promise<VerificationCoreResult<ProposalEffectRecord>> {
		if (!validRecord(current) || !validRecord(candidate)) return failure("invalid_schema", "proposal effect CAS record is invalid");
		const path = this.#path(current);
		try {
			return await withDurableStateLock(path, async () => {
				const stored = await this.#read(path);
				if (!stored.ok || !stored.value || stored.value.recordDigest !== current.recordDigest ||
					candidate.previousRecordDigest !== current.recordDigest) {
					return failure("conflict", "proposal effect CAS expectation is stale");
				}
				return this.#write(path, candidate);
			});
		} catch {
			return failure("durable_write_failed", "proposal effect state lock is unavailable", true);
		}
	}
}

function draftReceiptMatches(record: Extract<ProposalEffectRecord, { kind: "draft_pr" }>, receipt: DraftPrProviderReceipt): boolean {
	return isDraftPrProviderReceipt(receipt) &&
		receipt.authorityId === record.authorityId &&
		receipt.tenantId === record.tenantId &&
		receipt.requestId === record.requestId &&
		receipt.providerId === record.request.providerId &&
		receipt.proposalId === record.request.proposal.proposalId &&
		receipt.proposalDigest === record.request.proposal.proposalDigest &&
		receipt.sealId === record.request.proposal.episodeSeal.sealId &&
		receipt.sealDigest === record.request.proposal.episodeSeal.sealDigest;
}

function humanDecisionMatches(record: Extract<ProposalEffectRecord, { kind: "human_gate" }>, decision: HumanGateDecision): boolean {
	return isHumanGateDecision(decision) &&
		decision.authorityId === record.authorityId &&
		decision.tenantId === record.tenantId &&
		decision.requestId === record.requestId &&
		decision.humanGateId === record.request.humanGateId &&
		decision.proposalId === record.request.proposal.proposalId &&
		decision.proposalDigest === record.request.proposal.proposalDigest &&
		decision.action === record.request.action &&
		decision.decidedBy !== record.request.requestedBy &&
		decision.decidedBy !== record.request.proposal.createdBy;
}

export class DurableDraftPrService {
	readonly #repository: ProposalEffectRepository;
	readonly #proposals: Pick<ChangeProposalRepository, "inspect">;
	readonly #provider: ChangeProposalProviderPort;
	readonly #sealTrust: EpisodeSealTrustPort;
	readonly #events: ProposalEffectCanonicalEventPort;
	readonly #reconciliation?: DraftPrReconciliationPort;
	readonly #clock: () => Date;

	public constructor(options: {
		repository: ProposalEffectRepository;
		proposals: Pick<ChangeProposalRepository, "inspect">;
		provider: ChangeProposalProviderPort;
		sealTrust: EpisodeSealTrustPort;
		events: ProposalEffectCanonicalEventPort;
		reconciliation?: DraftPrReconciliationPort;
		clock?: () => Date;
	}) {
		this.#repository = options.repository;
		this.#proposals = options.proposals;
		this.#provider = options.provider;
		this.#sealTrust = options.sealTrust;
		this.#events = options.events;
		this.#reconciliation = options.reconciliation;
		this.#clock = options.clock ?? (() => new Date());
	}

	async #set(
		current: Extract<ProposalEffectRecord, { kind: "draft_pr" }>,
		state: Extract<ProposalEffectRecord, { kind: "draft_pr" }>["state"],
		patch: Partial<ProposalEffectRecordBody> = {},
	): Promise<VerificationCoreResult<Extract<ProposalEffectRecord, { kind: "draft_pr" }>>> {
		const candidate = transition(current, state, this.#clock().toISOString(), patch);
		if (!candidate.ok) return candidate;
		const stored = await this.#repository.compareAndSet(current, candidate.value);
		return stored.ok ? { ok: true, value: stored.value as Extract<ProposalEffectRecord, { kind: "draft_pr" }> } : stored;
	}

	async #terminal(
		record: Extract<ProposalEffectRecord, { kind: "draft_pr" }>,
	): Promise<VerificationCoreResult<DraftPrProviderReceipt>> {
		if (!record.receipt) return failure("reconciliation_required", "draft terminal receipt is missing");
		const event = await this.#events.recordDraftTerminal(record);
		if (!event.ok) return event;
		const completed = await this.#set(record, "draft_created", { terminalEventDigest: event.value.eventDigest });
		return completed.ok ? { ok: true, value: record.receipt } : completed;
	}

	public async request(
		request: DraftPrRequest,
		signal?: AbortSignal,
	): Promise<VerificationCoreResult<DraftPrProviderReceipt>> {
		const proposal = await this.#proposals.inspect(request.proposal.proposalId);
		if (!proposal.ok || proposal.value.proposalDigest !== request.proposal.proposalDigest) {
			return failure("invalid_schema", "Draft PR requires its recorded ChangeProposal");
		}
		const requestDigest = canonicalDigest(request);
		const initial = withDigest({
			schemaVersion: 1,
			kind: "draft_pr",
			authorityId: request.authorityId,
			tenantId: request.tenantId,
			requestId: request.requestId,
			requestDigest,
			state: "request_prepared",
			request,
			revision: 1,
			previousRecordDigest: null,
			updatedAt: this.#clock().toISOString(),
		}) as Extract<ProposalEffectRecord, { kind: "draft_pr" }>;
		const prepared = await this.#repository.prepare(initial);
		if (!prepared.ok) return prepared;
		let record = prepared.value as Extract<ProposalEffectRecord, { kind: "draft_pr" }>;
		if (record.requestDigest !== requestDigest || record.kind !== "draft_pr") {
			return failure("conflict", "Draft PR requestId was reused");
		}
		if (record.state === "draft_created" && record.receipt) return { ok: true, value: record.receipt };
		if (record.state === "terminal_pending") return this.#terminal(record);
		if (record.state === "effect_pending" || record.state === "reconciliation_required") {
			return failure("reconciliation_required", "Draft PR provider outcome requires reconciliation");
		}
		if (record.state === "draft_failed") return failure("provider_unavailable", "Draft PR previously failed");
		const requested = await this.#events.recordDraftRequested(record);
		if (!requested.ok) return requested;
		const pending = await this.#set(record, "effect_pending", { requestedEventDigest: requested.value.eventDigest });
		if (!pending.ok) return pending;
		record = pending.value;
		const created = await requestDraftPr(request, this.#provider, this.#sealTrust, signal);
		if (!created.ok) {
			if (created.error.code !== "provider_unavailable") {
				const failed = await this.#set(record, "draft_failed", { errorDigest: canonicalDigest(created.error) });
				return failed.ok ? created : failed;
			}
			const reconciled = await this.#set(record, "reconciliation_required", { errorDigest: canonicalDigest(created.error) });
			if (reconciled.ok) await this.#events.recordReconciliationRequired(reconciled.value);
			return failure("reconciliation_required", "Draft PR provider outcome is unknown");
		}
		const terminal = await this.#set(record, "terminal_pending", { receipt: created.value });
		return terminal.ok ? this.#terminal(terminal.value) : terminal;
	}

	public async reconcile(
		authorityId: DraftPrRequest["authorityId"],
		tenantId: DraftPrRequest["tenantId"],
		requestId: CommandId,
		signal?: AbortSignal,
	): Promise<VerificationCoreResult<DraftPrProviderReceipt>> {
		if (!this.#reconciliation) return failure("reconciliation_required", "Draft PR reconciliation port is unavailable");
		const loaded = await this.#repository.load(authorityId, tenantId, requestId);
		if (!loaded.ok || loaded.value.kind !== "draft_pr") return loaded as VerificationCoreResult<DraftPrProviderReceipt>;
		const record = loaded.value;
		if (record.state !== "reconciliation_required" && record.state !== "effect_pending") {
			return failure("conflict", "Draft PR record is not awaiting reconciliation");
		}
		const receipt = await this.#reconciliation.reconcile(record, signal);
		if (!receipt.ok) return receipt;
		if (!draftReceiptMatches(record, receipt.value)) {
			return failure("reconciliation_required", "Draft PR reconciliation receipt is uncorrelated");
		}
		const terminal = await this.#set(record, "terminal_pending", { receipt: receipt.value });
		return terminal.ok ? this.#terminal(terminal.value) : terminal;
	}
}

export function humanGateOrganizationReceiptDigest(body: HumanGateOrganizationReceiptBody): string {
	return canonicalDigest(body);
}

export class DurableHumanGateService {
	readonly #repository: ProposalEffectRepository;
	readonly #coordinator: HumanGateCoordinatorPort;
	readonly #organization: HumanGateOrganizationPort;
	readonly #sealTrust: EpisodeSealTrustPort;
	readonly #events: ProposalEffectCanonicalEventPort;
	readonly #reconciliation?: HumanGateReconciliationPort;
	readonly #clock: () => Date;

	public constructor(options: {
		repository: ProposalEffectRepository;
		coordinator: HumanGateCoordinatorPort;
		organization: HumanGateOrganizationPort;
		sealTrust: EpisodeSealTrustPort;
		events: ProposalEffectCanonicalEventPort;
		reconciliation?: HumanGateReconciliationPort;
		clock?: () => Date;
	}) {
		this.#repository = options.repository;
		this.#coordinator = options.coordinator;
		this.#organization = options.organization;
		this.#sealTrust = options.sealTrust;
		this.#events = options.events;
		this.#reconciliation = options.reconciliation;
		this.#clock = options.clock ?? (() => new Date());
	}

	async #set(
		current: Extract<ProposalEffectRecord, { kind: "human_gate" }>,
		state: Extract<ProposalEffectRecord, { kind: "human_gate" }>["state"],
		patch: Partial<ProposalEffectRecordBody> = {},
	): Promise<VerificationCoreResult<Extract<ProposalEffectRecord, { kind: "human_gate" }>>> {
		const candidate = transition(current, state, this.#clock().toISOString(), patch);
		if (!candidate.ok) return candidate;
		const stored = await this.#repository.compareAndSet(current, candidate.value);
		return stored.ok ? { ok: true, value: stored.value as Extract<ProposalEffectRecord, { kind: "human_gate" }> } : stored;
	}

	async #terminal(
		record: Extract<ProposalEffectRecord, { kind: "human_gate" }>,
	): Promise<VerificationCoreResult<HumanGateDecision>> {
		if (!record.decision) return failure("reconciliation_required", "HumanGate terminal decision is missing");
		const event = await this.#events.recordHumanGateTerminal(record);
		if (!event.ok) return event;
		const completed = await this.#set(record, "decided", { terminalEventDigest: event.value.eventDigest });
		return completed.ok ? { ok: true, value: record.decision } : completed;
	}

	public async resolve(
		request: HumanGateRequest,
		signal?: AbortSignal,
	): Promise<VerificationCoreResult<HumanGateDecision>> {
		const existing = await this.#repository.load(request.authorityId, request.tenantId, request.requestId);
		if (existing.ok) {
			if (
				existing.value.kind !== "human_gate" ||
				canonicalDigest(existing.value.request) !== canonicalDigest(request)
			) return failure("conflict", "HumanGate requestId was reused");
			return this.#continue(existing.value, signal);
		}
		if (existing.error.code !== "invalid_schema") return existing;
		let organization: VerificationCoreResult<HumanGateOrganizationReceipt>;
		try {
			organization = await this.#organization.authorize(request, signal);
		} catch {
			return failure("human_gate_required", "HumanGate organization policy receipt is unavailable");
		}
		if (!organization.ok || !validOrganizationReceipt(organization.value, request) ||
			organization.value.outcome !== "allowed") {
			return failure("human_gate_required", "HumanGate organization policy receipt is missing or denied");
		}
		const requestDigest = canonicalDigest({ request, organizationReceipt: organization.value });
		const initial = withDigest({
			schemaVersion: 1,
			kind: "human_gate",
			authorityId: request.authorityId,
			tenantId: request.tenantId,
			requestId: request.requestId,
			requestDigest,
			state: "requested",
			request,
			organizationReceipt: organization.value,
			revision: 1,
			previousRecordDigest: null,
			updatedAt: this.#clock().toISOString(),
		}) as Extract<ProposalEffectRecord, { kind: "human_gate" }>;
		const prepared = await this.#repository.prepare(initial);
		if (!prepared.ok || prepared.value.kind !== "human_gate") return prepared as VerificationCoreResult<HumanGateDecision>;
		return this.#continue(prepared.value, signal);
	}

	async #continue(
		initial: Extract<ProposalEffectRecord, { kind: "human_gate" }>,
		signal?: AbortSignal,
	): Promise<VerificationCoreResult<HumanGateDecision>> {
		let record = initial;
		const request = record.request;
		const requestDigest = canonicalDigest({ request, organizationReceipt: record.organizationReceipt });
		if (record.requestDigest !== requestDigest) return failure("conflict", "HumanGate requestId was reused");
		if (record.state === "decided" && record.decision) return { ok: true, value: record.decision };
		if (record.state === "terminal_pending") return this.#terminal(record);
		if (record.state === "decision_pending" || record.state === "reconciliation_required") {
			return failure("reconciliation_required", "HumanGate decision outcome requires reconciliation");
		}
		const requested = await this.#events.recordHumanGateRequested(record);
		if (!requested.ok) return requested;
		const pending = await this.#set(record, "decision_pending", { requestedEventDigest: requested.value.eventDigest });
		if (!pending.ok) return pending;
		record = pending.value;
		const decision = await resolveHumanGate(request, this.#coordinator, this.#sealTrust, signal);
		if (!decision.ok) {
			const reconciled = await this.#set(record, "reconciliation_required", { errorDigest: canonicalDigest(decision.error) });
			if (reconciled.ok) await this.#events.recordReconciliationRequired(reconciled.value);
			return failure("reconciliation_required", "HumanGate coordinator outcome is unknown");
		}
		if (!humanDecisionMatches(record, decision.value)) {
			return failure("human_gate_required", "HumanGate decision is uncorrelated");
		}
		const terminal = await this.#set(record, "terminal_pending", { decision: decision.value });
		return terminal.ok ? this.#terminal(terminal.value) : terminal;
	}

	public async reconcile(
		authorityId: HumanGateRequest["authorityId"],
		tenantId: HumanGateRequest["tenantId"],
		requestId: CommandId,
		signal?: AbortSignal,
	): Promise<VerificationCoreResult<HumanGateDecision>> {
		if (!this.#reconciliation) {
			return failure("reconciliation_required", "HumanGate reconciliation port is unavailable");
		}
		const loaded = await this.#repository.load(authorityId, tenantId, requestId);
		if (!loaded.ok || loaded.value.kind !== "human_gate") {
			return loaded as VerificationCoreResult<HumanGateDecision>;
		}
		const record = loaded.value;
		if (record.state !== "reconciliation_required" && record.state !== "decision_pending") {
			return failure("conflict", "HumanGate record is not awaiting reconciliation");
		}
		const decision = await this.#reconciliation.reconcile(record, signal);
		if (!decision.ok) return decision;
		if (!humanDecisionMatches(record, decision.value)) {
			return failure("reconciliation_required", "HumanGate reconciliation decision is uncorrelated");
		}
		const terminal = await this.#set(record, "terminal_pending", { decision: decision.value });
		return terminal.ok ? this.#terminal(terminal.value) : terminal;
	}
}
