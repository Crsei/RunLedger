/** Standard Session Owner CLI composition for governed model routing receipts. */

import { createModelRequestReceiptRouter } from "./model-request-receipt-router.ts";
import { loadCanonicalModelCompatibilityRouter } from "./model-compatibility-manifest.ts";
import type { ModelRequestRouter } from "../runtime/interactive-session-controller.ts";
import type { AuthorityId, SessionId, TenantId } from "../runtime/contracts/public.ts";
import type { RunledgerLayout } from "../runtime/contracts/storage-layout.ts";
import { runtimeDigest } from "../runtime/protocol/foundation.ts";
import { createRuntimeId } from "../runtime/protocol/ids.ts";
import { JsonlRuntimeEventStore } from "../storage/runtime-event-store.ts";
import type { Models } from "../models.ts";
import type { ProviderRequestGate } from "../runtime/agents/child-model-runtime.ts";
import type { RetryPolicy } from "../runtime/retry/policy.ts";
import type { CompactionSummarizer } from "../runtime/types.ts";
import { createProductionSummarizer } from "../runtime/context/compaction/production-summarizer.ts";

export interface CliSessionModelRequestRouterFactory {
	forSession(input: { readonly sessionId: SessionId; readonly workspaceStorageKey: string }): ModelRequestRouter;
	compactionSummarizer(input: {
		readonly models: Models;
		readonly providerGate: ProviderRequestGate;
		readonly retryPolicy: RetryPolicy;
	}): CompactionSummarizer;
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
		compactionSummarizer: ({ models, providerGate, retryPolicy }) => {
			if (!compatibility.ok) return async () => undefined;
			const summarize = createProductionSummarizer({
				models,
				router: compatibility.router,
				providerGate,
				retryPolicy,
			});
			return async (input) => {
				const result = await summarize({
					transcript: JSON.stringify(input.messages),
					focus: input.reason,
					sessionId: input.sessionId,
				});
				return result.ok ? result.summary : undefined;
			};
		},
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
