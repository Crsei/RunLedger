/** Standard Session Owner CLI composition for governed model routing receipts. */

import { createModelRequestReceiptRouter } from "./model-request-receipt-router.ts";
import { loadCanonicalModelCompatibilityRouter } from "./model-compatibility-manifest.ts";
import type { ModelRequestRouter } from "../runtime/interactive-session-controller.ts";
import type { AuthorityId, SessionId, TenantId } from "../runtime/contracts/public.ts";
import type { RunledgerLayout } from "../runtime/contracts/storage-layout.ts";
import { runtimeDigest } from "../runtime/protocol/foundation.ts";
import { createRuntimeId } from "../runtime/protocol/ids.ts";
import { JsonlRuntimeEventStore } from "../storage/runtime-event-store.ts";

export interface CliSessionModelRequestRouterFactory {
	forSession(input: { readonly sessionId: SessionId; readonly workspaceStorageKey: string }): ModelRequestRouter;
}

export async function createCliSessionModelRequestRouterFactory(options: {
	readonly layout: RunledgerLayout;
	readonly authorityId: AuthorityId;
	readonly tenantId: TenantId;
}): Promise<CliSessionModelRequestRouterFactory> {
	const compatibility = await loadCanonicalModelCompatibilityRouter(options.layout);
	const writers = new Map<string, JsonlRuntimeEventStore>();
	const routers = new Map<string, ModelRequestRouter>();
	return {
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
				...(compatibility.ok ? { router: compatibility.router } : { unavailableCode: compatibility.error.code }),
			});
			routers.set(key, router);
			return router;
		},
	};
}
