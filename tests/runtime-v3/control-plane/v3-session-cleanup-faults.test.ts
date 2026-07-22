import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	DirectoryV3SessionLocator,
	V3SessionRuntimeFactoryAdapter,
	type V3CandidateAuthorityBindingPort,
} from "../../../src/daemon/v3-session-adapters.ts";
import {
	controlPlaneFailure,
	isControlPlaneError,
} from "../../../src/runtime/control-plane/errors.ts";
import type { EventCursor } from "../../../src/runtime/protocol/v3/events.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/v3/ids.ts";
import type { RuntimeIdentityContext } from "../../../src/runtime/identity/types.ts";
import { DEFAULT_RUNTIME_FEATURES, type RuntimeFeatureFlags } from "../../../src/runtime/runtime-features.ts";
import { GovernedV3SessionRuntime } from "../../../src/storage/v3-runtime-adapter.ts";
import { V3SessionManager } from "../../../src/storage/v3-session-manager.ts";

const IDENTITY: RuntimeIdentityContext = {
	authorityId: createRuntimeId("authority", "cleanup-faults"),
	tenantId: createRuntimeId("tenant", "cleanup-faults"),
	principalId: createRuntimeId("principal", "cleanup-faults"),
	source: "managed",
	issuedAt: "2026-07-23T00:00:00.000Z",
};
const FEATURES: RuntimeFeatureFlags = { ...DEFAULT_RUNTIME_FEATURES, sessionV3: true };
const roots: string[] = [];
const managers = new Set<V3SessionManager>();

function namedError(name: string, message: string): Error {
	const error = new Error(message);
	error.name = name;
	return error;
}

function failingAuthority(failure: Error): V3CandidateAuthorityBindingPort {
	return {
		bind: async () => controlPlaneFailure(
			"adapter_contract_violation",
			"injected candidate authority failure",
			false,
			{ errorName: failure.name },
		),
	};
}

function factory(root: string, candidateAuthority?: V3CandidateAuthorityBindingPort): V3SessionRuntimeFactoryAdapter {
	const sessionDir = join(root, "sessions");
	return new V3SessionRuntimeFactoryAdapter({
		cwd: root,
		sessionDir,
		features: FEATURES,
		identity: IDENTITY,
		locator: new DirectoryV3SessionLocator({ cwd: root, sessionDir }),
		...(candidateAuthority ? { candidateAuthority } : {}),
	});
}

function failAfterActualClose(manager: V3SessionManager, failure: Error): void {
	const close = manager.closeAll.bind(manager);
	vi.spyOn(manager, "closeAll").mockImplementation(async () => {
		await close();
		throw failure;
	});
}

async function closedSession(root: string): Promise<{
	filePath: string;
	sessionId: ReturnType<V3SessionManager["sessionId"]>;
	cursor: EventCursor;
}> {
	const manager = await V3SessionManager.create({
		cwd: root,
		sessionDir: join(root, "sessions"),
		features: FEATURES,
		identity: IDENTITY,
	});
	const cursor = manager.writer().currentHead();
	if (!cursor) throw new Error("cleanup fault fixture has no durable cursor");
	const result = { filePath: manager.filePath(), sessionId: manager.sessionId(), cursor };
	await manager.closeAll();
	return result;
}

afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.allSettled([...managers].map((manager) => manager.closeAll()));
	managers.clear();
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("V3 session factory cleanup faults", () => {
	it.each(["resume", "fork"] as const)(
		"keeps governed-open AggregateError evidence bounded during %s",
		async (operation) => {
			const root = await mkdtemp(join(tmpdir(), `runledger-v3-${operation}-open-aggregate-`));
			roots.push(root);
			const session = await closedSession(root);
			const primary = namedError(`Injected${operation}OpenPrimaryError`, "governed open failed");
			const cleanup = namedError(`Injected${operation}OpenCleanupError`, "governed open writer close failed");
			vi.spyOn(GovernedV3SessionRuntime, "open").mockRejectedValue(new AggregateError(
				[primary, cleanup],
				"governed open and cleanup failed",
			));

			const sessions = factory(root);
			const result = operation === "resume"
				? await sessions.resume(session.sessionId)
				: await sessions.fork(session.sessionId, session.cursor, "continue_existing_goal");

			expect(result).toMatchObject({
				ok: false,
				error: {
					retryable: false,
					details: {
						errorName: "AggregateError",
						aggregateErrorCount: 2,
						primaryErrorName: primary.name,
						cleanupErrorCount: 1,
						cleanupOperations: "session_writer_close",
						cleanupErrorNames: cleanup.name,
					},
				},
				effect: "uncertain",
			});
			if (result.ok) throw new Error("aggregate cleanup fixture unexpectedly succeeded");
			expect(isControlPlaneError(result.error)).toBe(true);
			expect(String(result.error.details?.primaryErrorName).length).toBeLessThanOrEqual(128);
			expect(String(result.error.details?.cleanupErrorNames).length).toBeLessThanOrEqual(512);
		},
	);

	it("keeps both candidate-authority and writer-close failures visible during start", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-v3-start-cleanup-fault-"));
		roots.push(root);
		const primary = namedError("InjectedStartAuthorityError", "candidate authority bind failed");
		const cleanup = namedError("InjectedStartCleanupError", "new session writer close failed");
		const realCreate = V3SessionManager.create.bind(V3SessionManager);
		let created: V3SessionManager | undefined;
		vi.spyOn(V3SessionManager, "create").mockImplementation(async (...args) => {
			created = await realCreate(...args);
			managers.add(created);
			failAfterActualClose(created, cleanup);
			return created;
		});

		const result = await factory(root, failingAuthority(primary)).start();
		const visible = JSON.stringify(result);

		expect(result.ok).toBe(false);
		expect(visible).toContain(primary.name);
		expect(visible).toContain(cleanup.name);
		expect(created?.isClosed()).toBe(true);
	});

	it("marks a durably created start as uncertain when candidate binding fails before transfer", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-v3-start-correlation-"));
		roots.push(root);
		const primary = namedError("InjectedStartBindingError", "candidate authority bind failed");
		const realCreate = V3SessionManager.create.bind(V3SessionManager);
		let created: V3SessionManager | undefined;
		vi.spyOn(V3SessionManager, "create").mockImplementation(async (...args) => {
			created = await realCreate(...args);
			managers.add(created);
			return created;
		});

		const result = await factory(root, failingAuthority(primary)).start();

		expect(result).toMatchObject({
			ok: false,
			error: {
				retryable: false,
				details: { sessionId: created?.sessionId() },
			},
			effect: "uncertain",
		});
		expect(created?.isClosed()).toBe(true);
	});

	it("keeps both candidate-authority and writer-close failures visible during resume", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-v3-resume-cleanup-fault-"));
		roots.push(root);
		const session = await closedSession(root);
		const primary = namedError("InjectedResumeAuthorityError", "candidate authority bind failed");
		const cleanup = namedError("InjectedResumeCleanupError", "resumed session writer close failed");
		const realOpen = V3SessionManager.open.bind(V3SessionManager);
		let opened: V3SessionManager | undefined;
		vi.spyOn(V3SessionManager, "open").mockImplementation(async (...args) => {
			opened = await realOpen(...args);
			managers.add(opened);
			failAfterActualClose(opened, cleanup);
			return opened;
		});

		const result = await factory(root, failingAuthority(primary)).resume(session.sessionId);
		const visible = JSON.stringify(result);

		expect(result.ok).toBe(false);
		expect(visible).toContain(primary.name);
		expect(visible).toContain(cleanup.name);
		expect(opened?.isClosed()).toBe(true);
	});

	it("keeps both replay and durable-child close failures visible during fork", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-v3-fork-cleanup-fault-"));
		roots.push(root);
		const session = await closedSession(root);
		const primary = namedError("InjectedForkReplayError", "fork parent replay failed");
		const cleanup = namedError("InjectedForkCleanupError", "durable child writer close failed");
		const realCreate = V3SessionManager.create.bind(V3SessionManager);
		let child: V3SessionManager | undefined;
		vi.spyOn(V3SessionManager, "create").mockImplementation(async (...args) => {
			child = await realCreate(...args);
			managers.add(child);
			failAfterActualClose(child, cleanup);
			return child;
		});
		vi.spyOn(V3SessionManager.prototype, "replayMessages").mockRejectedValueOnce(primary);

		const result = await factory(root).fork(
			session.sessionId,
			session.cursor,
			"continue_existing_goal",
		);
		const visible = JSON.stringify(result);

		expect(result.ok).toBe(false);
		expect(visible).toContain(primary.name);
		expect(visible).toContain(cleanup.name);
		expect(child?.writer().currentHead()).toBeDefined();
		expect(child?.isClosed()).toBe(true);
	});

	it("keeps a durable child correlation when fork binding fails and cleanup succeeds", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-v3-fork-correlation-"));
		roots.push(root);
		const session = await closedSession(root);
		const primary = namedError("InjectedForkBindingError", "candidate authority bind failed");
		const realCreate = V3SessionManager.create.bind(V3SessionManager);
		let child: V3SessionManager | undefined;
		vi.spyOn(V3SessionManager, "create").mockImplementation(async (...args) => {
			child = await realCreate(...args);
			managers.add(child);
			return child;
		});

		const result = await factory(root, failingAuthority(primary)).fork(
			session.sessionId,
			session.cursor,
			"continue_existing_goal",
		);

		expect(result).toMatchObject({
			ok: false,
			error: {
				retryable: false,
				details: { childSessionId: child?.sessionId() },
			},
			effect: "uncertain",
		});
		expect(child?.writer().currentHead()).toBeDefined();
		expect(child?.isClosed()).toBe(true);
	});

	it.each([false, true])(
		"closes an untransferred child when governed parent cleanup fails (child close fails=%s)",
		async (childCloseFails) => {
			const root = await mkdtemp(join(tmpdir(), "runledger-v3-fork-parent-cleanup-fault-"));
			roots.push(root);
			const session = await closedSession(root);
			const parentCleanup = namedError("InjectedForkParentCleanupError", "governed parent close failed");
			const childCleanup = namedError("InjectedForkChildCleanupError", "untransferred child close failed");
			const realOpen = V3SessionManager.open.bind(V3SessionManager);
			vi.spyOn(V3SessionManager, "open").mockImplementation(async (...args) => {
				const parent = await realOpen(...args);
				managers.add(parent);
				failAfterActualClose(parent, parentCleanup);
				return parent;
			});
			const realCreate = V3SessionManager.create.bind(V3SessionManager);
			let child: V3SessionManager | undefined;
			vi.spyOn(V3SessionManager, "create").mockImplementation(async (...args) => {
				child = await realCreate(...args);
				managers.add(child);
				if (childCloseFails) failAfterActualClose(child, childCleanup);
				return child;
			});

			const sessions = factory(root);
			const result = await sessions.fork(
				session.sessionId,
				session.cursor,
				"continue_existing_goal",
			);
			const expectedErrorNames = childCloseFails
				? `${parentCleanup.name},${childCleanup.name}`
				: parentCleanup.name;
			const expectedOperations = childCloseFails
				? "fork_parent_close,fork_child_close"
				: "fork_parent_close";

			expect(result).toMatchObject({
				ok: false,
				error: {
					code: "recovery_required",
					details: {
						childSessionId: child?.sessionId(),
						cleanupFailed: true,
						cleanupErrorCount: childCloseFails ? 2 : 1,
						cleanupOperations: expectedOperations,
						cleanupErrorNames: expectedErrorNames,
					},
				},
				effect: "uncertain",
			});
			expect(child?.writer().currentHead()).toBeDefined();
			expect(child?.isClosed()).toBe(true);
		const childSessionId = child?.sessionId();
		if (childSessionId) expect(sessions.activeRuntime(childSessionId)).toBeUndefined();
		},
	);
});
