import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createEmbeddedSessionRuntime } from "../../../src/cli/embedded-session-runtime.ts";
import { SessionInteractiveController } from "../../../src/cli/session-interactive-controller.ts";
import { buildRunledgerLayout } from "../../../src/runtime/contracts/storage-layout.ts";
import { isValidPlanModeState } from "../../../src/runtime/modes/plan/reducer.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/ids.ts";
import { AuthStorage } from "../../../src/storage/auth-storage.ts";
import { openSessionDatabase } from "../../../src/storage/session-store/database.ts";
import { OwnerStore } from "../../../src/storage/session-store/owner-store.ts";
import { installSessionStoreSchema } from "../../../src/storage/session-store/schema.ts";
import { SessionStore } from "../../../src/storage/session-store/session-store.ts";
import { loadProjectSettings } from "../../../src/storage/settings-manager.ts";
import { builtinModels } from "../../../src/providers/all.ts";

const noPromptTestSecurity = [{
	source: "cli" as const,
	read: async () => ({ status: "available" as const, text: JSON.stringify({ profile: "danger-full-access" }) }),
}];

describe("SessionRuntime Plan domain", () => {
	it("negotiates plan.inspect and returns the Session-owned hash-chain projection", async () => {
		const root = mkdtempSync(resolve(tmpdir(), "runledger-session-plan-"));
		const home = resolve(root, "home");
		mkdirSync(home, { recursive: true, mode: 0o700 });
		const layout = buildRunledgerLayout(home, "posix");
		const db = openSessionDatabase(layout.database);
		installSessionStoreSchema(db);
		const store = new SessionStore(db);
		const ownerStore = new OwnerStore(db);
		const sessionId = createRuntimeId("session", "production-plan");
		const workspaceId = createRuntimeId("workspace", "production-plan");
		const repositoryId = createRuntimeId("repository", "production-plan");
		store.createSession({ sessionId, workspaceId, repositoryId, settingsDigest: "d".repeat(64) });
		const settings = await loadProjectSettings({ layout });
		const models = builtinModels({ credentials: AuthStorage.create(layout) });
		await models.refresh({ allowNetwork: false });
		let embedded: Awaited<ReturnType<typeof createEmbeddedSessionRuntime>> | undefined;
		let controller: SessionInteractiveController | undefined;
		try {
			embedded = await createEmbeddedSessionRuntime({
				sessionId,
				store,
				ownerStore,
				domain: { cwd: root, layout, settings, models, securitySources: noPromptTestSecurity },
			});
			controller = new SessionInteractiveController(embedded.handle, {
				sessionId,
				messages: [],
				warnings: [],
				auditEntries: [],
				selection: { thinkingLevel: "off" },
				toolCount: 0,
				eventCursor: 0,
				driverRevision: 0,
				agentRuns: [],
			});

			expect(controller.supports("plan.inspect")).toBe(true);
			const result = await controller.querySessionDomain("plan.inspect", {}, {
				correlationId: "correlation-plan-inspect",
				effectId: "effect-plan-inspect",
			});
			expect(result.ok).toBe(true);
			if (!result.ok) return;
			const state = result.value.state;
			expect(isValidPlanModeState(state)).toBe(true);
			expect(result.value).toMatchObject({ repositoryId, state: { sessionId, status: "inactive", revision: 0 } });
			const events = store.replaySessionEvents(sessionId);
			const durableHead = events.at(-1);
			expect(state).toMatchObject({
				sourceHead: {
					streamId: sessionId,
					sequence: durableHead?.sequence ?? 0,
					eventHash: { algorithm: "sha256", digest: durableHead?.currentEventHash },
				},
			});
		} finally {
			controller?.dispose();
			await embedded?.handle.close().catch(() => undefined);
			await embedded?.runtime?.shutdownAfterLastAttachment("paused");
			db.close();
			rmSync(root, { recursive: true, force: true });
		}
	});
});
