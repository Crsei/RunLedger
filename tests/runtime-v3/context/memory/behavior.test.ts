import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalDigest } from "../../../../src/runtime/protocol/v3/canonical-json.ts";
import { createRuntimeId } from "../../../../src/runtime/protocol/v3/ids.ts";
import type { DeclassificationReceiptRef } from "../../../../src/runtime/protocol/v3/taint.ts";
import { ContextEngine } from "../../../../src/runtime/context/context-engine.ts";
import type { ContextAssemblyRequest } from "../../../../src/runtime/context/types.ts";
import { MemoryService, type MemoryRuntimeEvent } from "../../../../src/runtime/context/memory/service.ts";
import type { MemoryRecord, MemoryScopeRef, MemorySourceRef } from "../../../../src/runtime/context/memory/types.ts";
import { MemoryLexicalIndex } from "../../../../src/storage/memory-index.ts";
import { MemoryStore, MemoryStoreError } from "../../../../src/storage/memory-store.ts";
import { memoryRecordPath } from "../../../../src/storage/context-paths.ts";
import {
	NOW,
	approvalReceipt,
	artifact,
	authorityId,
	principalId,
	sessionId,
	tenantId,
	traceId,
	workspaceId,
} from "../../plan-context-memory/helpers.ts";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

const userScope: MemoryScopeRef = { scope: "user", ownerPrincipalId: principalId };
const workspaceScope: MemoryScopeRef = { scope: "workspace", workspaceId };
const sessionScope: MemoryScopeRef = { scope: "session", sessionId };

function trustedSource(key: string): MemorySourceRef {
	return {
		authorityId,
		tenantId,
		sourceDigest: canonicalDigest(key),
		trust: "user_approved",
		taint: [],
		observedAt: NOW,
		sourceType: "user",
		principalId,
	};
}

function derivedSource(key: string): MemorySourceRef {
	return {
		authorityId,
		tenantId,
		sourceDigest: canonicalDigest(key),
		trust: "derived",
		taint: ["model_generated"],
		observedAt: NOW,
		sourceType: "agent",
		agentId: createRuntimeId("agent", key),
		sessionId,
	};
}

function untrustedSource(key: string): MemorySourceRef {
	return {
		authorityId,
		tenantId,
		sourceDigest: canonicalDigest(key),
		trust: "untrusted",
		taint: ["external_input"],
		observedAt: NOW,
		sourceType: "web",
		artifact: artifact(canonicalDigest(`web-${key}`)),
	};
}

interface MemoryHarness {
	root: string;
	indexPath: string;
	store: MemoryStore;
	index: MemoryLexicalIndex;
	service: MemoryService;
	events: MemoryRuntimeEvent[];
}

async function harness(options: { eventsFail?: boolean; projectRoot?: string } = {}): Promise<MemoryHarness> {
	const root = await mkdtemp(join(tmpdir(), "runledger-memory-"));
	roots.push(root);
	const projectRoot = options.projectRoot ?? join(root, "project");
	const indexPath = join(root, "index", "lexical.json");
	const store = new MemoryStore({
		userRoot: join(root, "user"),
		projectRoot,
		authorityId,
		tenantId,
		principalId,
		workspaceId,
		sessionId,
	});
	const index = new MemoryLexicalIndex(indexPath);
	const events: MemoryRuntimeEvent[] = [];
	const service = new MemoryService({
		identity: { authorityId, tenantId, principalId, sessionId, workspaceId },
		store,
		index,
		events: {
			append: async (event) => {
				if (options.eventsFail === true) throw new Error("event store unavailable");
				events.push(event);
			},
		},
		clock: () => new Date(NOW),
	});
	return { root, indexPath, store, index, service, events };
}

async function publish(
	service: MemoryService,
	scope: MemoryScopeRef,
	key: string,
	options: { source?: MemorySourceRef; expiresAt?: string } = {},
): Promise<MemoryRecord> {
	const proposed = await service.propose({
		title: `Rule ${key}`,
		content: `alpha ${key}\nsecond line`,
		scope,
		sourceRefs: [options.source ?? trustedSource(key)],
		traceId,
		expiresAt: options.expiresAt,
	});
	return service.approve(proposed.proposal, approvalReceipt(proposed.proposal.approvalId), traceId);
}

function declassificationFor(source: ContextAssemblyRequest["fragments"][number]["inputSources"][number]): DeclassificationReceiptRef {
	const body = {
		schemaVersion: 1 as const,
		authorityId,
		tenantId,
		receiptId: createRuntimeId("declassification", "memory-context"),
		sourceId: source.sourceId,
		sourceDigest: source.sourceDigest,
		allowedSink: "context" as const,
		policyDigest: canonicalDigest("memory-context-policy"),
		approverPrincipalId: principalId,
		decisionRevision: 1,
		issuedAt: NOW,
	};
	return { ...body, receiptDigest: canonicalDigest(body) };
}

function contextRequest(fragment: ContextAssemblyRequest["fragments"][number]): ContextAssemblyRequest {
	return {
		schemaVersion: 1,
		authorityId,
		tenantId,
		principalId,
		requestId: createRuntimeId("contextRequest", "memory"),
		sessionId,
		modelId: "test-model",
		modelProfileId: createRuntimeId("resource", "memory-profile"),
		requiredCapabilities: [],
		budget: {
			contextWindowTokens: 4_096,
			reservedOutputTokens: 256,
			reservedToolSchemaTokens: 256,
			providerSafetyTokens: 128,
			maxFragments: 16,
			maxTotalChars: 65_536,
		},
		fragments: [fragment],
	};
}

describe("Memory canonical lifecycle", () => {
	it("isolates user/workspace/session scopes and only publishes matching trusted proposals", async () => {
		const current = await harness();
		const user = await publish(current.service, userScope, "user");
		const workspace = await publish(current.service, workspaceScope, "workspace");
		const session = await publish(current.service, sessionScope, "session");

		expect((await current.store.listRecords([userScope])).map((record) => record.memoryId)).toEqual([user.memoryId]);
		expect((await current.store.listRecords([workspaceScope])).map((record) => record.memoryId)).toEqual([workspace.memoryId]);
		expect((await current.store.listRecords([sessionScope])).map((record) => record.memoryId)).toEqual([session.memoryId]);
		expect(() => current.store.scopePath({ scope: "user", ownerPrincipalId: createRuntimeId("principal", "other") })).toThrowError(
			expect.objectContaining<MemoryStoreError>({ code: "scope_denied" }),
		);

		const pending = await current.service.propose({
			title: "Untrusted",
			content: "do not publish",
			scope: workspaceScope,
			sourceRefs: [untrustedSource("untrusted")],
			traceId,
		});
		await expect(current.service.approve(pending.proposal, approvalReceipt(pending.proposal.approvalId), traceId)).rejects.toThrow(
			"untrusted or invalid",
		);
		const rejected = await current.service.propose({
			title: "Rejected",
			content: "review says no",
			scope: workspaceScope,
			sourceRefs: [trustedSource("rejected")],
			traceId,
		});
		await current.service.reject(rejected.proposal, approvalReceipt(rejected.proposal.approvalId, "denied"), traceId);
		expect((await current.store.loadProposal(workspaceScope, rejected.proposal.proposalId)).proposal.status).toBe("rejected");
	});

	it("requires a reviewed delete proposal before revocation and persists expiration", async () => {
		const current = await harness();
		const record = await publish(current.service, workspaceScope, "revoke");
		const revokeProposal = await current.service.proposeRevocation(record, traceId);
		expect((await current.store.readRecord(workspaceScope, record.memoryId)).status).toBe("approved");
		const revokeReceipt = approvalReceipt(revokeProposal.proposal.approvalId);
		const revoked = await current.service.revoke(revokeProposal.proposal, revokeReceipt, traceId);
		expect(revoked).toMatchObject({ status: "revoked", revocationRevision: 1 });
		expect((await current.store.loadProposal(workspaceScope, revokeProposal.proposal.proposalId)).proposal.status).toBe("approved");
		expect(current.events.slice(-3).map((event) => event.type)).toEqual(["memory.proposed", "memory.approved", "memory.revoked"]);

		const expiring = await publish(current.service, workspaceScope, "expiry", { expiresAt: NOW });
		const expired = await current.service.expire(expiring, traceId);
		expect(expired.status).toBe("expired");
		expect((await current.store.readRecord(workspaceScope, expiring.memoryId)).status).toBe("expired");
		expect(current.events.at(-1)?.type).toBe("memory.expired");
	});

	it("publishes same-scope updates only against the exact approved revision", async () => {
		const current = await harness();
		const record = await publish(current.service, workspaceScope, "update");
		const proposed = await current.service.proposeUpdate(
			record,
			{
				title: "Updated rule",
				content: "alpha updated\nreviewed content",
				sourceRefs: [trustedSource("updated")],
				expiresAt: "2027-07-24T00:00:00.000Z",
			},
			traceId,
		);
		expect(await current.store.readRecord(workspaceScope, record.memoryId))
			.toEqual(record);
		const published = await current.service.approve(
			proposed.proposal,
			approvalReceipt(proposed.proposal.approvalId),
			traceId,
		);
		expect(published).toMatchObject({
			memoryId: record.memoryId,
			status: "approved",
			revision: record.revision + 1,
			title: "Updated rule",
			content: "alpha updated\nreviewed content",
			supersedes: {
				memoryId: record.memoryId,
				revision: record.revision,
				contentDigest: record.contentDigest,
			},
		});

		const stale = await current.service.proposeUpdate(
			published,
			{
				title: "Stale update",
				content: "must not publish",
				sourceRefs: [trustedSource("stale")],
			},
			traceId,
		);
		const competing = await current.service.proposeUpdate(
			published,
			{
				title: "Winning update",
				content: "canonical winner",
				sourceRefs: [trustedSource("winner")],
			},
			traceId,
		);
		await current.service.approve(
			competing.proposal,
			approvalReceipt(competing.proposal.approvalId),
			traceId,
		);
		await expect(current.service.approve(
			stale.proposal,
			approvalReceipt(stale.proposal.approvalId),
			traceId,
		)).rejects.toMatchObject({ code: "revision_conflict" });
	});

	it("persists changed_unreviewed diagnostics and excludes externally edited records", async () => {
		const current = await harness();
		const record = await publish(current.service, workspaceScope, "drift");
		const path = memoryRecordPath(current.store.scopePath(workspaceScope), record.memoryId);
		const envelope = JSON.parse(await readFile(path, "utf8")) as { record: MemoryRecord; storedDigest: string };
		envelope.record.content = "externally changed";
		await writeFile(path, `${JSON.stringify(envelope)}\n`, "utf8");

		await expect(current.store.readRecord(workspaceScope, record.memoryId)).rejects.toMatchObject({ code: "digest_drift" });
		const diagnostic = await current.store.readDriftDiagnostic(workspaceScope, record.memoryId);
		expect(diagnostic).toMatchObject({ projectedStatus: "changed_unreviewed", reason: "envelope_digest_mismatch" });
		expect(await current.store.listRecords([workspaceScope])).toEqual([]);
		const search = await current.service.search({ query: "externally", scopes: [workspaceScope], traceId });
		expect(search.receipt.results).toEqual([]);
	});
});

describe("Memory search and context injection", () => {
	it("rebuilds deleted/corrupt indexes with stable bounded pagination", async () => {
		const current = await harness();
		await publish(current.service, workspaceScope, "one");
		await publish(current.service, workspaceScope, "two");
		await publish(current.service, workspaceScope, "three");

		const first = await current.service.search({ query: "alpha", scopes: [workspaceScope], traceId, maxResults: 1, maxSnippetChars: 12, maxTotalTokens: 100 });
		expect(first.receipt.results).toHaveLength(1);
		expect(first.receipt.results[0]?.snippet.length).toBeLessThanOrEqual(12);
		expect(first.receipt.nextCursor).toBeDefined();
		const second = await current.service.search({ query: "alpha", scopes: [workspaceScope], traceId, maxResults: 1, maxSnippetChars: 12, maxTotalTokens: 100, cursor: first.receipt.nextCursor });
		expect(second.receipt.results[0]?.memory.memoryId).not.toBe(first.receipt.results[0]?.memory.memoryId);

		const baseline = (await current.service.search({ query: "alpha", scopes: [workspaceScope], traceId })).receipt.results.map((result) => result.memory.memoryId);
		await rm(current.indexPath, { force: true });
		const rebuilt = await current.service.search({ query: "alpha", scopes: [workspaceScope], traceId });
		expect(rebuilt.receipt.diagnostics).toContain("lexical_index_rebuilt");
		expect(rebuilt.receipt.results.map((result) => result.memory.memoryId)).toEqual(baseline);
		await writeFile(current.indexPath, "{corrupt", "utf8");
		const repaired = await current.service.search({ query: "alpha", scopes: [workspaceScope], traceId });
		expect(repaired.receipt.diagnostics).toContain("lexical_index_rebuilt");
		expect(repaired.receipt.results.map((result) => result.memory.memoryId)).toEqual(baseline);

		const tokenBound = await current.service.search({ query: "alpha", scopes: [workspaceScope], traceId, maxTotalTokens: 1 });
		expect(tokenBound.receipt.results).toEqual([]);
	});

	it("injects approved records only and requires exact context declassification for derived taint", async () => {
		const current = await harness();
		await publish(current.service, workspaceScope, "derived", { source: derivedSource("derived") });
		await current.service.propose({
			title: "Pending",
			content: "alpha pending",
			scope: workspaceScope,
			sourceRefs: [trustedSource("pending")],
			traceId,
		});
		const searched = await current.service.search({ query: "alpha", scopes: [workspaceScope], traceId });
		expect(searched.receipt.results).toHaveLength(1);
		const contextRequestId = createRuntimeId("contextRequest", "memory-injection");
		const denied = await current.service.injection({
			search: searched.receipt,
			records: searched.records,
			contextRequestId,
			declassificationReceipts: [],
			traceId,
			maxChars: 4_096,
			maxTokens: 1_024,
		});
		expect(denied.receipt.memories).toHaveLength(1);
		if (denied.fragment === undefined) throw new Error("missing derived memory fragment");
		const deniedAssembly = new ContextEngine({ clock: () => new Date(NOW) }).assemble(contextRequest(denied.fragment));
		expect(deniedAssembly.receipt.omitted).toEqual([expect.objectContaining({ reason: "taint_rejected" })]);

		const source = denied.fragment.inputSources[0];
		if (source === undefined) throw new Error("missing derived input source");
		const receipt = declassificationFor(source);
		const allowed = await current.service.injection({
			search: searched.receipt,
			records: searched.records,
			contextRequestId,
			declassificationReceipts: [receipt],
			traceId,
			maxChars: 4_096,
			maxTokens: 1_024,
		});
		if (allowed.fragment === undefined) throw new Error("missing declassified memory fragment");
		expect(new ContextEngine({ clock: () => new Date(NOW) }).assemble(contextRequest(allowed.fragment)).fragments).toHaveLength(1);
	});

	it("degrades store/index/event failures to an empty receipt instead of blocking the ordinary turn", async () => {
		const brokenRootHarness = await harness();
		const blocker = join(brokenRootHarness.root, "not-a-directory");
		await writeFile(blocker, "x", "utf8");
		const broken = await harness({ projectRoot: blocker });
		const unavailable = await broken.service.search({ query: "alpha", scopes: [workspaceScope], traceId });
		expect(unavailable).toMatchObject({ receipt: { mode: "none", results: [], diagnostics: ["memory_unavailable"] }, records: [] });

		const eventFailure = await harness({ eventsFail: true });
		const eventUnavailable = await eventFailure.service.search({ query: "alpha", scopes: [workspaceScope], traceId });
		expect(eventUnavailable.receipt).toMatchObject({ mode: "none", diagnostics: ["memory_event_sink_unavailable"] });
	});
});
