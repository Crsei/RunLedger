import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthorityRuntimeGenerationCoordinator } from "../../../src/daemon/authority-runtime-generation.ts";
import {
	createProductionAdapterEvidence,
	createProductionCompositionReceipt,
	type ProductionCompositionReceipt,
} from "../../../src/daemon/production-composition.ts";
import { V3SessionRuntimeFactoryAdapter } from "../../../src/daemon/v3-session-adapters.ts";
import type { RuntimeGenerationTransitionContext } from "../../../src/runtime/control-plane/session-registry.ts";
import { createLocalIdentityContext } from "../../../src/runtime/identity/local-principal.ts";
import { canonicalDigest } from "../../../src/runtime/protocol/v3/canonical-json.ts";
import { createRuntimeId, type RuntimeInstanceId } from "../../../src/runtime/protocol/v3/ids.ts";
import { DEFAULT_RUNTIME_FEATURES, type RuntimeFeatureFlags } from "../../../src/runtime/runtime-features.ts";
import { AuthorityRuntimeManager } from "../../../src/storage/authority-runtime-manager.ts";
import { V3SessionManager } from "../../../src/storage/v3-session-manager.ts";

const FEATURES: RuntimeFeatureFlags = { ...DEFAULT_RUNTIME_FEATURES, sessionV3: true };
const roots: string[] = [];
const authorityManagers: AuthorityRuntimeManager[] = [];
const sessionManagers: V3SessionManager[] = [];

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function value<T>(result: { ok: true; value: T } | { ok: false; error: { message: string } }): T {
	if (!result.ok) throw new Error(result.error.message);
	return result.value;
}

async function temporaryRoot(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "runledger-authority-generation-"));
	roots.push(root);
	return root;
}

async function rawFencingToken(manager: V3SessionManager): Promise<string> {
	const source = await readFile(join(manager.stateDirectory(), "writer-lease.json"), "utf8");
	const parsed = JSON.parse(source) as unknown;
	if (!isRecord(parsed) || !isRecord(parsed.record) || typeof parsed.record.fencingToken !== "string") {
		throw new Error("fixture writer lease does not contain a raw fencing token");
	}
	return parsed.record.fencingToken;
}

function baseComposition(
	authority: AuthorityRuntimeManager,
	now: Date,
): ProductionCompositionReceipt {
	const issuedAt = new Date(now.getTime() - 1_000).toISOString();
	const expiresAt = new Date(now.getTime() + 30 * 60_000).toISOString();
	const daemonEvidence = createProductionAdapterEvidence({
		kind: "daemon_core",
		adapterId: "runledger.authority-generation.daemon",
		implementationId: "src/daemon/authority-runtime-generation.ts",
		implementationDigest: canonicalDigest({ module: "authority-runtime-generation", version: 1 }),
		configDigest: canonicalDigest({ authorityId: authority.identity().authorityId }),
		generation: 1,
		health: "healthy",
		features: ["health"],
		probe: {
			status: "passed",
			checkedAt: issuedAt,
			expiresAt,
			evidenceDigest: canonicalDigest({ probe: "authority-generation" }),
		},
		trust: {
			status: "trusted",
			issuerId: "runledger.production.trust",
			issuedAt,
			expiresAt,
			evidenceDigest: canonicalDigest({ trust: "authority-generation" }),
		},
	});
	const created = createProductionCompositionReceipt({
		authorityId: authority.identity().authorityId,
		tenantId: authority.identity().tenantId,
		serverInstanceId: authority.runtimeId(),
		issuerId: "runledger.authority-generation",
		runtimeGeneration: 1,
		issuedAt,
		expiresAt,
		adapters: [daemonEvidence],
	});
	return value(created);
}

function expectedCandidateComposition(
	base: ProductionCompositionReceipt,
	runtimeId: RuntimeInstanceId,
	generation: number,
): ProductionCompositionReceipt {
	return value(createProductionCompositionReceipt({
		authorityId: base.authorityId,
		tenantId: base.tenantId,
		serverInstanceId: runtimeId,
		issuerId: base.issuerId,
		runtimeGeneration: generation,
		issuedAt: base.issuedAt,
		expiresAt: base.expiresAt,
		managedPolicyRef: base.managedPolicyRef,
		effectiveRequirements: base.featureRequirements,
		adapters: base.adapters.map((adapter) => ({ ...adapter, generation })),
	}));
}

async function openAuthority(root: string, now: Date, seed: string): Promise<AuthorityRuntimeManager> {
	const manager = await AuthorityRuntimeManager.open({
		cwd: root,
		identity: createLocalIdentityContext(now),
		runtimeId: createRuntimeId("runtime", `authority-${seed}`),
		clock: () => now,
		leaseDurationMs: 60_000,
	});
	authorityManagers.push(manager);
	return manager;
}

async function openCoordinator(
	authority: AuthorityRuntimeManager,
	now: Date,
	base: ProductionCompositionReceipt,
): Promise<AuthorityRuntimeGenerationCoordinator> {
	const coordinator = value(await AuthorityRuntimeGenerationCoordinator.open(authority, () => now));
	value(coordinator.bindBaseComposition(base));
	return coordinator;
}

async function createCandidate(
	root: string,
	authority: AuthorityRuntimeManager,
	seed: string,
): Promise<V3SessionManager> {
	const manager = await V3SessionManager.create({
		cwd: root,
		sessionDir: join(root, "sessions"),
		features: FEATURES,
		identity: authority.identity(),
		runtimeId: createRuntimeId("runtime", `candidate-${seed}`),
		sessionId: createRuntimeId("session", `candidate-${seed}`),
	});
	sessionManagers.push(manager);
	return manager;
}

afterEach(async () => {
	vi.restoreAllMocks();
	for (const manager of sessionManagers.splice(0).reverse()) {
		if (!manager.isClosed()) await manager.closeAll();
	}
	for (const manager of authorityManagers.splice(0).reverse()) {
		if (!manager.isClosed()) await manager.close();
	}
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("AuthorityRuntimeGenerationCoordinator", () => {
	it("durably performs generation 1 prepare-fence-activate without exporting the raw writer token", async () => {
		const root = await temporaryRoot();
		const now = new Date();
		const authority = await openAuthority(root, now, "initial");
		const base = baseComposition(authority, now);
		const coordinator = await openCoordinator(authority, now, base);
		const candidate = await createCandidate(root, authority, "initial");
		const rawToken = await rawFencingToken(candidate);
		const safeReceipt = candidate.writerFenceReceipt();
		expect(safeReceipt).not.toHaveProperty("fencingToken");
		expect(safeReceipt.fencingTokenDigest).toMatch(/^[a-f0-9]{64}$/u);
		expect(JSON.stringify(safeReceipt)).not.toContain(rawToken);

		const binding = value(await coordinator.bind(candidate));
		const context: RuntimeGenerationTransitionContext = {
			sessionId: candidate.sessionId(),
			recovery: "new",
			previous: null,
			candidate: binding,
		};
		expect(binding).toMatchObject({ runtimeId: candidate.runtimeId(), generation: 1 });
		const prepared = value(await coordinator.prepare(context));
		expect(prepared).toMatchObject({ candidateRuntimeId: candidate.runtimeId(), candidateGeneration: 1 });
		const fencing = value(await coordinator.rotateWriterFence({ ...context, prepared }));
		expect(Object.keys(fencing).sort()).toEqual([
			"candidateGeneration",
			"candidateRuntimeId",
			"receiptDigest",
			"receiptId",
		]);
		expect(JSON.stringify(fencing)).not.toContain(rawToken);
		const activated = value(await coordinator.activate({ ...context, prepared, fencing }));
		expect(activated).toMatchObject({
			activeRuntimeId: candidate.runtimeId(),
			activeGeneration: 1,
		});
		expect(activated.durableCursor.sequence).toBeGreaterThan(prepared.durableCursor.sequence);
		expect(coordinator.currentGeneration()).toBe(1);

		const replay = value(await authority.runtimeGenerations().replay());
		expect(replay.events.map((event) => event.type)).toEqual([
			"runtime.replacement_prepared",
			"runtime.generation_activated",
		]);
		expect(replay.projection?.active).toMatchObject({
			runtimeId: candidate.runtimeId(),
			generation: 1,
			status: "active",
		});
		expect(await readFile(authority.eventFilePath(), "utf8")).not.toContain(rawToken);
	});

	it("replays the active generation after authority restart and allocates only generation 2", async () => {
		const root = await temporaryRoot();
		const now = new Date();
		const firstAuthority = await openAuthority(root, now, "restart-first");
		const base = baseComposition(firstAuthority, now);
		const firstCoordinator = await openCoordinator(firstAuthority, now, base);
		const firstCandidate = await createCandidate(root, firstAuthority, "restart-first");
		const firstBinding = value(await firstCoordinator.bind(firstCandidate));
		const firstContext: RuntimeGenerationTransitionContext = {
			sessionId: firstCandidate.sessionId(),
			recovery: "new",
			previous: null,
			candidate: firstBinding,
		};
		const firstPrepared = value(await firstCoordinator.prepare(firstContext));
		const firstFencing = value(await firstCoordinator.rotateWriterFence({ ...firstContext, prepared: firstPrepared }));
		value(await firstCoordinator.activate({ ...firstContext, prepared: firstPrepared, fencing: firstFencing }));
		await firstCandidate.closeAll();
		await firstAuthority.close();

		const restartedAt = new Date(now.getTime() + 1_000);
		const secondAuthority = await openAuthority(root, restartedAt, "restart-second");
		const secondCoordinator = await openCoordinator(secondAuthority, restartedAt, base);
		expect(secondCoordinator.currentGeneration()).toBe(1);
		const secondCandidate = await createCandidate(root, secondAuthority, "restart-second");
		const secondBinding = value(await secondCoordinator.bind(secondCandidate));
		expect(secondBinding).toMatchObject({
			runtimeId: secondCandidate.runtimeId(),
			generation: 2,
		});
		const secondContext: RuntimeGenerationTransitionContext = {
			sessionId: secondCandidate.sessionId(),
			recovery: "new",
			previous: firstBinding,
			candidate: secondBinding,
		};
		const secondPrepared = value(await secondCoordinator.prepare(secondContext));
		const secondFencing = value(await secondCoordinator.rotateWriterFence({
			...secondContext,
			prepared: secondPrepared,
		}));
		value(await secondCoordinator.activate({
			...secondContext,
			prepared: secondPrepared,
			fencing: secondFencing,
		}));
		expect(secondCoordinator.currentGeneration()).toBe(2);
		expect(value(await secondAuthority.runtimeGenerations().replay()).projection?.active).toMatchObject({
			runtimeId: secondCandidate.runtimeId(),
			generation: 2,
		});
	});

	it("fails closed when the prepared candidate writer is stale or its receipt changes", async () => {
		for (const fault of ["stale", "changed"] as const) {
			const root = await temporaryRoot();
			const now = new Date();
			const authority = await openAuthority(root, now, `fence-${fault}`);
			const coordinator = await openCoordinator(authority, now, baseComposition(authority, now));
			const candidate = await createCandidate(root, authority, `fence-${fault}`);
			const binding = value(await coordinator.bind(candidate));
			const context: RuntimeGenerationTransitionContext = {
				sessionId: candidate.sessionId(),
				recovery: "new",
				previous: null,
				candidate: binding,
			};
			const prepared = value(await coordinator.prepare(context));
			if (fault === "stale") {
				await candidate.closeAll();
			} else {
				const original = candidate.writerFenceReceipt();
				vi.spyOn(candidate, "writerFenceReceipt").mockReturnValue({
					...original,
					receiptDigest: canonicalDigest({ fault: "changed", receiptId: original.receiptId }),
				});
			}
			expect(await coordinator.rotateWriterFence({ ...context, prepared })).toMatchObject({
				ok: false,
				error: { code: "recovery_required" },
			});
			await authority.close();
		}
	});

	it("binds factory candidates to a composition receipt scoped to their runtime identity and generation", async () => {
		const root = await temporaryRoot();
		const now = new Date();
		const authority = await openAuthority(root, now, "factory");
		const base = baseComposition(authority, now);
		const coordinator = await openCoordinator(authority, now, base);
		const factory = new V3SessionRuntimeFactoryAdapter({
			cwd: root,
			sessionDir: join(root, "sessions"),
			features: FEATURES,
			identity: authority.identity(),
			candidateAuthority: coordinator,
		});
		const started = value(await factory.start());
		const managed = factory.activeRuntime(started.sessionId);
		if (!managed?.authorityBinding) throw new Error("factory candidate did not expose authority binding");
		sessionManagers.push(managed.manager());
		const binding = managed.authorityBinding();
		const expected = expectedCandidateComposition(base, managed.manager().runtimeId(), 1);
		expect(binding).toMatchObject({
			runtimeId: managed.manager().runtimeId(),
			generation: 1,
			compositionReceiptId: expected.receiptId,
			compositionDigest: expected.receiptDigest,
		});
		expect(binding.runtimeId).not.toBe(base.serverInstanceId);
		const fencing = managed.manager().writerFenceReceipt();
		expect(binding.fencingIntentDigest).toBe(canonicalDigest({
			runtimeId: managed.manager().runtimeId(),
			generation: 1,
			fencingReceiptId: fencing.receiptId,
			fencingReceiptDigest: fencing.receiptDigest,
		}));
		expect(fencing).toMatchObject({
			authorityId: authority.identity().authorityId,
			tenantId: authority.identity().tenantId,
			runtimeId: binding.runtimeId,
		});
	});
});
