import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createCliSessionModelRequestRouterFactory } from "../../src/cli/session-model-router.ts";
import { buildRunledgerLayout } from "../../src/runtime/contracts/storage-layout.ts";
import { runtimeDigest } from "../../src/runtime/protocol/foundation.ts";
import { createRuntimeId } from "../../src/runtime/protocol/ids.ts";
import type { ModelRouteRequest } from "../../src/runtime/model-routing/types.ts";

describe("standard CLI Session model routing composition", () => {
	it("fails closed through the canonical route gate and writes a bounded receipt", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-session-model-router-"));
		try {
			const layout = buildRunledgerLayout(root, "posix");
			const workspaceStorageKey = `ws-${"c".repeat(64)}`;
			const sessionId = createRuntimeId("session", "standard-cli-model-router");
			const factory = await createCliSessionModelRequestRouterFactory({
				layout,
				authorityId: createRuntimeId("authority", "session-owner-runtime"),
				tenantId: createRuntimeId("tenant", "local-user"),
			});
			const router = factory.forSession({ sessionId, workspaceStorageKey });
			const request: ModelRouteRequest = {
				requestId: createRuntimeId("command", "standard-cli-recap"),
				operation: "request",
				requestKind: "idle-recap",
				targetProfileId: "fixture/model",
				contextDigest: runtimeDigest("context"),
				planDigest: runtimeDigest("plan"),
				resourceDigest: runtimeDigest("resources"),
				requiredContextTokens: 100,
				requiredOutputTokens: 128,
				requiresTools: true,
				requiresReasoningReplay: false,
				requiresImages: false,
				traceId: createRuntimeId("trace", "standard-cli-recap"),
			};

			await expect(router.route(request)).resolves.toMatchObject({ outcome: "deny", reasonCode: "manifest_missing" });
			const receiptPath = join(layout.state, "hosts", workspaceStorageKey, "runtime-events", `${sessionId}.jsonl`);
			const receipt = JSON.parse((await readFile(receiptPath, "utf8")).trim()) as Record<string, unknown>;
			expect(receipt).toMatchObject({ type: "model.routed", payload: { requestKind: "idle-recap" } });
			expect(JSON.stringify(receipt)).not.toContain("context");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("is injected by the standard CLI before Session domain assembly", async () => {
		const source = await readFile(join(process.cwd(), "src", "cli", "main.ts"), "utf8");
		expect(source).toContain("createCliSessionModelRequestRouterFactory");
		expect(source).toContain("modelRequestRouter: modelRequestRouters.forSession");
	});
});
