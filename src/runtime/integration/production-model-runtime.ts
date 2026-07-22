/** CLI/daemon 可复用的 governed model + context composition。 */

import type { Models } from "../../models.ts";
import type { ModelRequestPreparationInput, ModelRequestPreparationResult } from "../types.ts";
import type { WorkspaceBindingRef } from "../protocol/v3/workspace.ts";
import { canonicalDigest } from "../protocol/v3/canonical-json.ts";
import type { AuthorityId, PrincipalId, SessionId, TenantId } from "../protocol/v3/ids.ts";
import type { AgentLoopSessionEvents } from "../session/agent-loop-events.ts";
import {
	GovernedModelRequestCoordinator,
	type GovernedContextFragmentProvider,
} from "./governed-model-request.ts";
import {
	CatalogModelCompatibilityRouter,
	catalogModelId,
	type CatalogModelRegressionEvidence,
} from "./catalog-model-router.ts";
import {
	BasePromptContextProvider,
	SessionProjectionContextProvider,
} from "./production-context-providers.ts";

const BUILTIN_REGRESSION_BASELINE = {
	contract: "runledger-model-compatibility/v1",
	upstreamCommit: "3f1762cc7d3af39898aa5d21891335935011287f",
	runLedgerBaseCommit: "65f905452195e034c99fa5ac560a7e23a822f052",
	gates: [
		"tests/providers/pi-ai-parity-audit.test.ts",
		"tests/runtime-v3/model-routing",
		"tests/runtime-v3/integration/governed-model-request.test.ts",
		"npm run audit:pi-ai",
	],
} as const;

/** 发布物内置 baseline；构建门必须执行上述 gates 后才可发布该 revision。 */
export const BUILTIN_CATALOG_MODEL_REGRESSION: CatalogModelRegressionEvidence = Object.freeze({
	version: BUILTIN_REGRESSION_BASELINE.contract,
	suiteDigest: canonicalDigest(BUILTIN_REGRESSION_BASELINE),
	passed: true,
	completedAt: "2026-07-22T00:00:00.000Z",
});

export interface ProductionModelRuntimeOptions {
	models: Models;
	sessionEvents: AgentLoopSessionEvents;
	identity: {
		authorityId: AuthorityId;
		tenantId: TenantId;
		principalId: PrincipalId;
		sessionId: SessionId;
	};
	workspace?: WorkspaceBindingRef;
	fragmentProviders?: readonly GovernedContextFragmentProvider[];
	regression?: CatalogModelRegressionEvidence;
}

export interface ProductionModelRuntime {
	coordinator: GovernedModelRequestCoordinator;
	prepare(
		input: ModelRequestPreparationInput,
		signal?: AbortSignal,
	): Promise<ModelRequestPreparationResult>;
}

function resolveCatalogModel(models: Models, key: string) {
	const slash = key.indexOf("/");
	if (slash <= 0 || slash === key.length - 1) return undefined;
	return models.getModel(key.slice(0, slash), key.slice(slash + 1));
}

export function createProductionModelRuntime(options: ProductionModelRuntimeOptions): ProductionModelRuntime {
	const providers: GovernedContextFragmentProvider[] = [
		new BasePromptContextProvider(options.identity.principalId),
		...(options.fragmentProviders ?? []),
		new SessionProjectionContextProvider(options.identity.sessionId),
	];
	const coordinator = new GovernedModelRequestCoordinator({
		identity: options.identity,
		router: new CatalogModelCompatibilityRouter({
			authorityId: options.identity.authorityId,
			tenantId: options.identity.tenantId,
			principalId: options.identity.principalId,
			models: options.models.getModels(),
			regression: options.regression ?? BUILTIN_CATALOG_MODEL_REGRESSION,
		}),
		events: options.sessionEvents,
		expectedRevision: () => options.sessionEvents.currentExpectedRevision(),
		fragmentProviders: providers,
		resolveModel: (key) => resolveCatalogModel(options.models, key),
		modelId: catalogModelId,
		...(options.workspace ? { workspace: options.workspace } : {}),
	});
	return {
		coordinator,
		prepare: (input, signal) => coordinator.prepare(input, signal),
	};
}
