import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createCliGovernedInteractiveController } from "../../src/cli/interactive-control-plane.ts";
import {
	createProductionAdapterEvidence,
	createProductionCompositionReceipt,
	validateProductionCompositionReceipt,
	type ValidatedProductionComposition,
} from "../../src/daemon/production-composition.ts";
import type { InteractiveSessionController } from "../../src/runtime/interactive-session-controller.ts";
import { canonicalDigest } from "../../src/runtime/protocol/v3/canonical-json.ts";
import { createRuntimeId, type RuntimeInstanceId } from "../../src/runtime/protocol/v3/ids.ts";
import { DEFAULT_RUNTIME_FEATURES } from "../../src/runtime/runtime-features.ts";
import { AuthorityRuntimeManager } from "../../src/storage/authority-runtime-manager.ts";
import { V3SessionManager } from "../../src/storage/v3-session-manager.ts";

const roots: string[] = [];
const managers: V3SessionManager[] = [];
const authorityManagers: AuthorityRuntimeManager[] = [];

afterEach(async () => {
	await Promise.all(authorityManagers.splice(0).map((manager) => manager.close().catch(() => undefined)));
	await Promise.all(managers.splice(0).map((manager) => manager.closeAll().catch(() => undefined)));
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
	const cwd = await mkdtemp(join(tmpdir(), "runledger-cli-control-plane-"));
	roots.push(cwd);
	const manager = await V3SessionManager.create({
		cwd,
		sessionDir: join(cwd, "sessions"),
		features: { ...DEFAULT_RUNTIME_FEATURES, sessionV3: true },
	});
	managers.push(manager);
	const authorityRuntime = await AuthorityRuntimeManager.open({
		cwd,
		identity: manager.identity(),
		runtimeId: manager.runtimeId(),
	});
	authorityManagers.push(authorityRuntime);
	const controller = { sessionId: manager.sessionId() } as InteractiveSessionController;
	return { manager, authorityRuntime, controller };
}

function evidence(
	manager: V3SessionManager,
	includeQueue: boolean,
	serverInstanceId: RuntimeInstanceId = manager.runtimeId(),
): ValidatedProductionComposition {
	const identity = manager.identity();
	const issuedAt = new Date().toISOString();
	const expiresAt = new Date(Date.parse(issuedAt) + 5 * 60 * 1_000).toISOString();
	const adapterExpiresAt = new Date(Date.parse(issuedAt) + 10 * 60 * 1_000).toISOString();
	const adapter = (
		kind: Parameters<typeof createProductionAdapterEvidence>[0]["kind"],
		features: Parameters<typeof createProductionAdapterEvidence>[0]["features"],
	) => createProductionAdapterEvidence({
		kind,
		adapterId: `runledger.cli.${kind}`,
		implementationId: `src/cli/interactive-control-plane.ts#${kind}`,
		implementationDigest: canonicalDigest({ kind, contract: "cli-interactive" }),
		configDigest: canonicalDigest({ kind, sessionId: manager.sessionId() }),
		generation: 1,
		health: "healthy",
		features,
		probe: {
			status: "passed",
			checkedAt: issuedAt,
			expiresAt: adapterExpiresAt,
			evidenceDigest: canonicalDigest({ kind, status: "passed" }),
		},
		trust: {
			status: "trusted",
			issuerId: "runledger.cli.trust",
			issuedAt,
			expiresAt: adapterExpiresAt,
			evidenceDigest: canonicalDigest({ kind, trust: "production" }),
		},
	});
	const adapters = [
		adapter("event_store", ["session", "turn", "queue"]),
		adapter("model_provider", ["turn"]),
		adapter("session_reader", ["session"]),
		adapter("session_writer", includeQueue ? ["session", "turn", "queue"] : ["session", "turn"]),
		adapter("workspace", ["session", "turn"]),
		adapter("capability_gateway", ["session", "turn"]),
		adapter("approval", ["approval", "turn"]),
		adapter("sandbox", ["session", "turn"]),
		adapter("artifact", ["session", "turn"]),
		adapter("artifact_key_provider", ["turn"]),
		adapter("resource_catalog", ["turn"]),
		adapter("resource_invoker", ["turn"]),
		adapter("verifier_registry", ["session", "turn"]),
	];
	const scope = {
		authorityId: identity.authorityId,
		tenantId: identity.tenantId,
		serverInstanceId,
	};
	const receipt = createProductionCompositionReceipt({
		...scope,
		issuerId: "runledger.cli.interactive-evidence",
		runtimeGeneration: 1,
		issuedAt,
		expiresAt,
		adapters,
	});
	if (!receipt.ok) throw new Error(receipt.error.message);
	const validated = validateProductionCompositionReceipt(receipt.value, scope);
	if (!validated.ok) throw new Error(validated.error.message);
	return validated.value;
}

describe("CLI governed interactive composition", () => {
	it("rejects rollout-like evidence that does not prove the queue adapter", async () => {
		const setup = await fixture();
		await expect(createCliGovernedInteractiveController({
			...setup,
			featureEvidence: evidence(setup.manager, false),
		})).rejects.toMatchObject({ code: "unsupported_feature" });
	});

	it("accepts only correlated production evidence for turn and queue", async () => {
		const setup = await fixture();
		const controller = await createCliGovernedInteractiveController({
			...setup,
			featureEvidence: evidence(setup.manager, true),
		});
		expect(controller.sessionId).toBe(setup.manager.sessionId());
		await expect(access(join(setup.manager.stateDirectory(), "control-plane", "commands.jsonl"))).rejects.toMatchObject({
			code: "ENOENT",
		});

		const mismatched = evidence(setup.manager, true, createRuntimeId("runtime", "other"));
		await expect(createCliGovernedInteractiveController({
			...setup,
			featureEvidence: mismatched,
		})).rejects.toMatchObject({ code: "adapter_contract_violation" });
	});
});
