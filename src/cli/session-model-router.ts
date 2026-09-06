/** Standard Session Owner CLI composition for governed model routing receipts. */

import { createModelRequestReceiptRouter } from "./model-request-receipt-router.ts";
import { createCatalogModelRouter } from "../runtime/model-routing/catalog-router.ts";
import type { Models } from "../models.ts";
import type { ModelRequestRouter } from "../runtime/interactive-session-controller.ts";
import type { AuthorityId, SessionId, TenantId } from "../runtime/contracts/public.ts";
import type { RunledgerLayout } from "../runtime/contracts/storage-layout.ts";
import { runtimeDigest } from "../runtime/protocol/foundation.ts";
import { createRuntimeId } from "../runtime/protocol/ids.ts";
import { JsonlRuntimeEventStore } from "../storage/runtime-event-store.ts";
import type { Api, Model } from "../types.ts";

export interface CliSessionModelRequestRouterFactory {
	forSession(input: { readonly sessionId: SessionId; readonly workspaceStorageKey: string }): ModelRequestRouter;
	isModelSelectable(model: Model<Api>): boolean;
}

export async function createCliSessionModelRequestRouterFactory(options: {
	readonly layout: RunledgerLayout;
	readonly authorityId: AuthorityId;
	readonly tenantId: TenantId;
	readonly models: Models;
}): Promise<CliSessionModelRequestRouterFactory> {
	const catalogRouter = createCatalogModelRouter(options.models);
	const writers = new Map<string, JsonlRuntimeEventStore>();
	const routers = new Map<string, ModelRequestRouter>();
	return {
		isModelSelectable: (model) => options.models.getModel(model.provider, model.id) !== undefined,
		forSession: ({ sessionId, workspaceStorageKey }) => {
			const key = `${workspaceStorageKey}:${sessionId}`;
			const prior = routers.get(key);
			if (prior !== undefined) return prior;
			let writer = writers.get(workspaceStorageKey);
			if (writer === undefined) {
				writer = new JsonlRuntimeEventStore({ layout: options.layout, workspaceStorageKey });
				writers.set(workspaceStorageKey, writer);
			}
			const router = createModelRequestReceiptRouter({
				authorityId: options.authorityId,
				tenantId: options.tenantId,
				principalId: createRuntimeId("principal", `session-model-${runtimeDigest(workspaceStorageKey).digest.slice(0, 48)}`),
				sessionId,
				writer,
				router: catalogRouter,
			});
			routers.set(key, router);
			return router;
		},
	};
}
