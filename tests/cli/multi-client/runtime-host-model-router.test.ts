import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildRunledgerLayout } from "../../../src/runtime/contracts/storage-layout.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/ids.ts";
import { runtimeDigest } from "../../../src/runtime/protocol/foundation.ts";
import type { ModelRouteDecision, ModelRouteRequest } from "../../../src/runtime/model-routing/types.ts";
import { JsonlRuntimeEventStore } from "../../../src/storage/host/runtime-event-store.ts";
import { createHostModelRequestRouter } from "../../../src/cli/runtime-host-model-router.ts";

const sessionId = createRuntimeId("session", "host-model-router-test");
const request = (suffix: string): ModelRouteRequest => ({
	requestId: createRuntimeId("command", `host-model-router-${suffix}`),
	operation: "request",
	targetProfileId: "fixture/model",
	contextDigest: runtimeDigest(`context-${suffix}`),
	planDigest: runtimeDigest("plan"),
	resourceDigest: runtimeDigest("resources"),
	requiredContextTokens: 10,
	requiredOutputTokens: 20,
	requiresTools: false,
	requiresReasoningReplay: false,
	requiresImages: false,
	traceId: createRuntimeId("trace", `host-model-router-${suffix}`),
});

function decision(input: ModelRouteRequest, outcome: ModelRouteDecision["outcome"]): ModelRouteDecision {
	return {
		requestId: input.requestId,
		outcome,
		targetProviderId: "fixture",
		targetModelId: "model",
		targetProfileId: input.targetProfileId,
		manifestDigest: runtimeDigest("manifest"),
		reasonCode: outcome === "compatible" ? "compatible" : "profile_unknown",
		diagnostics: [],
		decisionDigest: runtimeDigest({ requestId: input.requestId, outcome }),
	};
}

describe("Host model request router", () => {
	it("records the route decision in the canonical Runtime writer and deduplicates retries", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-host-model-router-"));
		try {
			const layout = buildRunledgerLayout(root, "posix");
			const writer = new JsonlRuntimeEventStore({ layout, workspaceStorageKey: `ws-${"a".repeat(64)}` });
			const routed = createHostModelRequestRouter({
				authorityId: createRuntimeId("authority", "host-model-router"),
				tenantId: createRuntimeId("tenant", "host-model-router"),
				principalId: createRuntimeId("principal", "host-model-router"),
				sessionId,
				writer,
				router: { route: (input) => decision(input, "compatible") },
			});

			await expect(routed.route(request("one"))).resolves.toMatchObject({ outcome: "compatible" });
			await expect(routed.route(request("one"))).resolves.toMatchObject({ outcome: "compatible" });
			const events = await writer.read(sessionId);
			expect(events).toHaveLength(1);
			expect(events[0]).toMatchObject({ type: "model.routed", payload: { effect: "committed", metadataDigest: runtimeDigest({ requestId: request("one").requestId, outcome: "compatible" }) } });
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("persists only the bounded request kind as route evidence", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-host-model-router-kind-"));
		try {
			const layout = buildRunledgerLayout(root, "posix");
			const writer = new JsonlRuntimeEventStore({ layout, workspaceStorageKey: `ws-${"b".repeat(64)}` });
			const routed = createHostModelRequestRouter({
				authorityId: createRuntimeId("authority", "host-model-router-kind"),
				tenantId: createRuntimeId("tenant", "host-model-router-kind"),
				principalId: createRuntimeId("principal", "host-model-router-kind"),
				sessionId,
				writer,
				router: { route: (input) => decision(input, "compatible") },
			});
			const routeResult = await routed.route({ ...request("recap"), requestKind: "idle-recap" });
			expect(routeResult).toMatchObject({ outcome: "compatible" });
			const events = await writer.read(sessionId);
			expect(events[0]).toMatchObject({ type: "model.routed", payload: { requestKind: "idle-recap" } });
			expect(JSON.stringify(events[0])).not.toContain("rawPrompt");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
