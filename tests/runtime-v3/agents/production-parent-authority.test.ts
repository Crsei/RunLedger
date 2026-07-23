import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createProductionChildRuntimeParentAuthority,
} from "../../../src/runtime/agents/integration/production-composition.ts";
import type {
	AgentBudgetReservationRef,
	AgentGraphStoreHead,
	AgentLaunchRequest,
	AgentNode,
	AgentResumeLaunchRequest,
	AgentWorkspaceReceiptRef,
	DelegationReceiptRef,
	ParentCapabilityGrantRef,
} from "../../../src/runtime/agents/types.ts";
import { canonicalDigest } from "../../../src/runtime/protocol/v3/canonical-json.ts";
import { createSessionEventStreamRef } from "../../../src/runtime/protocol/v3/events.ts";
import {
	createRuntimeId,
	type AgentId,
	type SessionId,
} from "../../../src/runtime/protocol/v3/ids.ts";
import type { V3SessionManager } from "../../../src/storage/v3-session-manager.ts";
import {
	declassificationReceipt,
	grant,
	inputSource,
	rootRegistration,
	runtimeFakes,
	spawnRequest,
} from "./helpers.ts";

const NOW = "2026-07-22T00:00:00.000Z";
const EXPIRES_AT = "2026-07-24T00:00:00.000Z";

interface PendingAuthorityFixture {
	rootAgentId: AgentId;
	parentSessionId: SessionId;
	head: AgentGraphStoreHead;
	launchRequest: AgentLaunchRequest;
	manager: V3SessionManager;
}

function managerFor(
	parentSessionId: SessionId,
	closed = false,
): V3SessionManager {
	const authorityId = createRuntimeId(
		"authority",
		"production-parent-authority",
	);
	const tenantId = createRuntimeId(
		"tenant",
		"production-parent-authority",
	);
	const runtimeId = createRuntimeId(
		"runtime",
		"production-parent-authority",
	);
	const fenceBody = {
		authorityId,
		tenantId,
		sessionId: parentSessionId,
		runtimeId,
		stream: createSessionEventStreamRef(
			{
				authorityId,
				tenantId,
				principalId: createRuntimeId(
					"principal",
					"production-parent-authority",
				),
				source: "managed",
				issuedAt: NOW,
			},
			parentSessionId,
		),
		leaseId: createRuntimeId(
			"lease",
			"production-parent-authority",
		),
		writerEpoch: 1,
		fencingTokenDigest: canonicalDigest(
			"production parent authority fence",
		),
		acquiredAt: NOW,
		expiresAt: EXPIRES_AT,
	};
	const receiptDigest = canonicalDigest(fenceBody);
	return {
		isClosed: () => closed,
		sessionId: () => parentSessionId,
		runtimeId: () => runtimeId,
		writerFenceReceipt: () => ({
			...fenceBody,
			receiptId: createRuntimeId(
				"receipt",
				`writer-fence-${receiptDigest.slice(0, 48)}`,
			),
			receiptDigest,
		}),
	} as unknown as V3SessionManager;
}

async function pendingAuthorityFixture(): Promise<PendingAuthorityFixture> {
	const runtime = runtimeFakes();
	runtime.capability.childSpawnAllowed = true;
	const currentGrant = {
		...grant("production-parent-authority-current"),
		expiresAt: EXPIRES_AT,
	};
	const registration = rootRegistration(currentGrant);
	const registered = await runtime.supervisor.registerRoot(registration);
	if (!registered.ok) throw new Error(registered.error.message);
	let launchRequest: AgentLaunchRequest | undefined;
	vi.spyOn(runtime.launcher, "launch").mockImplementation((request) => {
		launchRequest = structuredClone(request);
		return Promise.resolve({
			ok: true,
			value: {
				status: "unavailable",
				reasonDigest: canonicalDigest(
					"hold child at pending authority",
				),
				retryable: true,
			},
		});
	});
	const spawned = await runtime.supervisor.spawn(
		spawnRequest(currentGrant, {
			requestedCapabilities: [],
			inputSources: [],
			declassificationReceipts: [],
		}),
	);
	expect(spawned).toMatchObject({
		ok: false,
		error: { retryable: true },
	});
	const loaded = await runtime.store.load(registration.agentId);
	if (!loaded.ok || !launchRequest) {
		throw new Error("pending production authority fixture is unavailable");
	}
	const manager = managerFor(registration.sessionId);
	const head: AgentGraphStoreHead = {
		...loaded.value,
		cursor: {
			stream: manager.writerFenceReceipt().stream,
			sequence: loaded.value.revision,
			eventId: createRuntimeId(
				"event",
				"production-parent-authority-head",
			),
			eventHash: canonicalDigest({
				parentSessionId: registration.sessionId,
				revision: loaded.value.revision,
			}),
		},
	};
	expect(
		head.projection.nodes.get(launchRequest.agentId),
	).toMatchObject({ state: "pending" });
	return {
		rootAgentId: registration.agentId,
		parentSessionId: registration.sessionId,
		head,
		launchRequest,
		manager,
	};
}

function withNode(
	head: AgentGraphStoreHead,
	agentId: AgentId,
	update: Partial<AgentNode>,
): AgentGraphStoreHead {
	const node = head.projection.nodes.get(agentId);
	if (!node) throw new Error(`graph lacks ${agentId}`);
	const nodes = new Map(head.projection.nodes);
	nodes.set(agentId, { ...node, ...update });
	return {
		...head,
		projection: {
			...head.projection,
			nodes,
		},
	};
}

function authorityFor(
	fixture: PendingAuthorityFixture,
	head = fixture.head,
	manager = fixture.manager,
) {
	return createProductionChildRuntimeParentAuthority({
		manager,
		rootAgentId: fixture.rootAgentId,
		graphStore: {
			load: async () => ({ ok: true, value: head }),
		},
		clock: () => new Date(NOW),
	});
}

function changedLaunch(
	request: AgentLaunchRequest,
	update: Partial<Omit<AgentLaunchRequest, "requestDigest">>,
): AgentLaunchRequest {
	const { requestDigest: _requestDigest, ...body } = request;
	const changed = { ...body, ...update };
	return { ...changed, requestDigest: canonicalDigest(changed) };
}

function resumeRequest(
	request: AgentLaunchRequest,
	update: Partial<Omit<AgentResumeLaunchRequest, "requestDigest">> = {},
): AgentResumeLaunchRequest {
	const body: Omit<AgentResumeLaunchRequest, "requestDigest"> = {
		requestId: createRuntimeId(
			"command",
			"production-parent-authority-resume",
		),
		agentId: request.agentId,
		sessionId: request.sessionId,
		parentAgentId: request.parentAgentId,
		delegationReceipt: request.delegationReceipt,
		workspaceReceipt: request.workspaceReceipt,
		budgetReservation: request.budgetReservation,
		inputSources: request.inputSources,
		declassificationReceipts: request.declassificationReceipts,
		...update,
	};
	return { ...body, requestDigest: canonicalDigest(body) };
}

function refreshedDelegation(
	previous: DelegationReceiptRef,
	grantRef: ParentCapabilityGrantRef,
): DelegationReceiptRef {
	const { receiptDigest: _receiptDigest, ...body } = previous;
	const refreshedBody: Omit<DelegationReceiptRef, "receiptDigest"> = {
		...body,
		receiptId: createRuntimeId(
			"receipt",
			"production-parent-authority-refreshed-delegation",
		),
		parentGrantReceiptId: grantRef.receiptId,
		parentGrantDigest: grantRef.receiptDigest,
		decisionRevision: previous.decisionRevision + 1,
		evaluatedAt: "2026-07-22T00:00:01.000Z",
	};
	return {
		...refreshedBody,
		receiptDigest: canonicalDigest(refreshedBody),
	};
}

function refreshedWorkspace(
	previous: AgentWorkspaceReceiptRef,
): AgentWorkspaceReceiptRef {
	const { receiptDigest: _receiptDigest, ...body } = previous;
	const refreshedBody: Omit<AgentWorkspaceReceiptRef, "receiptDigest"> = {
		...body,
		receiptId: createRuntimeId(
			"receipt",
			"production-parent-authority-refreshed-workspace",
		),
		bindingRevision: previous.bindingRevision + 1,
		leaseRevision: (previous.leaseRevision ?? 0) + 1,
		issuedAt: "2026-07-22T00:00:01.000Z",
	};
	return {
		...refreshedBody,
		receiptDigest: canonicalDigest(refreshedBody),
	};
}

function refreshedBudget(
	previous: AgentBudgetReservationRef,
): AgentBudgetReservationRef {
	return {
		reservationId: createRuntimeId(
			"budgetReservation",
			"production-parent-authority-refreshed-budget",
		),
		operationId: createRuntimeId(
			"command",
			"production-parent-authority-refreshed-budget",
		),
		requestDigest: canonicalDigest(previous),
	};
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("production child parent authority resolver", () => {
	it("accepts only an exact pending launch under a current running parent", async () => {
		const fixture = await pendingAuthorityFixture();
		const exact = authorityFor(fixture);
		expect(
			await exact.resolve({
				activationType: "launch",
				request: fixture.launchRequest,
			}),
		).toMatchObject({
			ok: true,
			value: {
				parentSessionId: fixture.parentSessionId,
				parentGraphRevision: fixture.head.revision,
				parentGraphCursor: fixture.head.cursor,
			},
		});

		const parent = fixture.head.projection.nodes.get(
			fixture.rootAgentId,
		);
		if (!parent?.capabilityGrant) {
			throw new Error("parent authority is unavailable");
		}
		const nonRunning = withNode(
			fixture.head,
			fixture.rootAgentId,
			{ state: "paused" },
		);
		expect(
			await authorityFor(fixture, nonRunning).resolve({
				activationType: "launch",
				request: fixture.launchRequest,
			}),
		).toMatchObject({
			ok: false,
			error: { code: "invalid_graph" },
		});
		const oldGrant = withNode(
			fixture.head,
			fixture.rootAgentId,
			{
				capabilityGrant: {
					...parent.capabilityGrant,
					receiptId: createRuntimeId(
						"receipt",
						"production-parent-authority-new-grant",
					),
					receiptDigest: canonicalDigest(
						"production parent authority new grant",
					),
					decisionRevision:
						parent.capabilityGrant.decisionRevision + 1,
				},
			},
		);
		expect(
			await authorityFor(fixture, oldGrant).resolve({
				activationType: "launch",
				request: fixture.launchRequest,
			}),
		).toMatchObject({
			ok: false,
			error: { code: "invalid_graph" },
		});
	});

	it.each([
		{
			label: "role",
			change: (request: AgentLaunchRequest) =>
				changedLaunch(request, { role: "review" }),
		},
		{
			label: "objective",
			change: (request: AgentLaunchRequest) =>
				changedLaunch(request, {
					objective: "unauthorized changed objective",
				}),
		},
		{
			label: "input lineage",
			change: (request: AgentLaunchRequest) => {
				const source = inputSource(
					"production-parent-authority-drift",
				);
				return changedLaunch(request, {
					inputSources: [source],
					declassificationReceipts: [
						declassificationReceipt(source),
					],
				});
			},
		},
	])("rejects launch $label drift even with a valid self digest", async ({ change }) => {
		const fixture = await pendingAuthorityFixture();
		expect(
			await authorityFor(fixture).resolve({
				activationType: "launch",
				request: change(fixture.launchRequest),
			}),
		).toMatchObject({
			ok: false,
			error: { code: "invalid_graph" },
		});
	});

	it.each(["paused", "partial"] as const)(
		"accepts refreshed %s resume evidence and rejects stale or drifted receipts",
		async (resumableState) => {
		const fixture = await pendingAuthorityFixture();
		const parent = fixture.head.projection.nodes.get(
			fixture.rootAgentId,
		);
		if (!parent?.capabilityGrant) {
			throw new Error("parent authority is unavailable");
		}
		const refreshedGrant: ParentCapabilityGrantRef = {
			...parent.capabilityGrant,
			receiptId: createRuntimeId(
				"receipt",
				"production-parent-authority-resume-grant",
			),
			receiptDigest: canonicalDigest(
				"production parent authority resume grant",
			),
			decisionRevision: parent.capabilityGrant.decisionRevision + 1,
			expiresAt: EXPIRES_AT,
		};
		const delegation = refreshedDelegation(
			fixture.launchRequest.delegationReceipt,
			refreshedGrant,
		);
		const workspace = refreshedWorkspace(
			fixture.launchRequest.workspaceReceipt,
		);
		const budget = refreshedBudget(
			fixture.launchRequest.budgetReservation,
		);
		let resumedHead = withNode(
			fixture.head,
			fixture.rootAgentId,
			{ capabilityGrant: refreshedGrant },
		);
		resumedHead = withNode(
			resumedHead,
			fixture.launchRequest.agentId,
			{
				state: resumableState,
				delegationReceipt: delegation,
				workspaceReceipt: workspace,
				budgetReservation: budget,
			},
		);
		const exact = resumeRequest(fixture.launchRequest, {
			delegationReceipt: delegation,
			workspaceReceipt: workspace,
			budgetReservation: budget,
		});
		expect(
			await authorityFor(fixture, resumedHead).resolve({
				activationType: "resume",
				request: exact,
			}),
		).toMatchObject({ ok: true });

		const stale = resumeRequest(fixture.launchRequest);
		expect(
			await authorityFor(fixture, resumedHead).resolve({
				activationType: "resume",
				request: stale,
			}),
		).toMatchObject({
			ok: false,
			error: { code: "invalid_graph" },
		});
		for (const drift of [
			resumeRequest(fixture.launchRequest, {
				delegationReceipt: delegation,
				workspaceReceipt: fixture.launchRequest.workspaceReceipt,
				budgetReservation: budget,
			}),
			resumeRequest(fixture.launchRequest, {
				delegationReceipt: delegation,
				workspaceReceipt: workspace,
				budgetReservation:
					fixture.launchRequest.budgetReservation,
			}),
			resumeRequest(fixture.launchRequest, {
				delegationReceipt: delegation,
				workspaceReceipt: workspace,
				budgetReservation: budget,
				inputSources: [
					inputSource(
						"production-parent-authority-resume-drift",
					),
				],
			}),
		]) {
			expect(
				await authorityFor(fixture, resumedHead).resolve({
					activationType: "resume",
					request: drift,
				}),
			).toMatchObject({
				ok: false,
				error: { code: "invalid_graph" },
			});
		}
		},
	);

	it("rejects resume from a running child and fails before graph reads when the manager is closed", async () => {
		const fixture = await pendingAuthorityFixture();
		const runningHead = withNode(
			fixture.head,
			fixture.launchRequest.agentId,
			{ state: "running" },
		);
		expect(
			await authorityFor(fixture, runningHead).resolve({
				activationType: "resume",
				request: resumeRequest(fixture.launchRequest),
			}),
		).toMatchObject({
			ok: false,
			error: { code: "invalid_graph" },
		});
		const load = vi.fn(async () => ({
			ok: true as const,
			value: fixture.head,
		}));
		const closed = createProductionChildRuntimeParentAuthority({
			manager: managerFor(fixture.parentSessionId, true),
			rootAgentId: fixture.rootAgentId,
			graphStore: { load },
			clock: () => new Date(NOW),
		});
		expect(
			await closed.resolve({
				activationType: "launch",
				request: fixture.launchRequest,
			}),
		).toMatchObject({
			ok: false,
			error: {
				code: "reference_unavailable",
				retryable: true,
			},
		});
		expect(load).not.toHaveBeenCalled();
	});
});
