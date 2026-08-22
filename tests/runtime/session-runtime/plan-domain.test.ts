import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
import { SettingsResolver } from "../../../src/storage/settings-resolver.ts";
import { builtinModels } from "../../../src/providers/all.ts";
import type { SessionDomainPort } from "../../../src/runtime/session-runtime/session-runtime.ts";

const noPromptTestSecurity = [{
	source: "cli" as const,
	read: async () => ({ status: "available" as const, text: JSON.stringify({ profile: "danger-full-access" }) }),
}];

describe("SessionRuntime Plan domain", () => {
	it("carries shellPath from the immutable runtime snapshot into the embedded process domain", async () => {
		const root = mkdtempSync(resolve(tmpdir(), "runledger-session-settings-shell-"));
		const home = resolve(root, "home");
		const shellPath = resolve(root, "configured-shell");
		mkdirSync(home, { recursive: true, mode: 0o700 });
		writeFileSync(shellPath, "#!/bin/sh\nprintf embedded-settings-shell\\n\n", { mode: 0o700 });
		const layout = buildRunledgerLayout(home, "posix");
		const db = openSessionDatabase(layout.database);
		installSessionStoreSchema(db);
		const store = new SessionStore(db);
		const ownerStore = new OwnerStore(db);
		const sessionId = createRuntimeId("session", "embedded-settings-shell");
		store.createSession({
			sessionId,
			workspaceId: createRuntimeId("workspace", "embedded-settings-shell"),
			repositoryId: createRuntimeId("repository", "embedded-settings-shell"),
			settingsDigest: "d".repeat(64),
		});
		const settings = await loadProjectSettings({ layout });
		const runtimeSettings = new SettingsResolver({ user: { shellPath } }).effectiveRuntimeSnapshot();
		const models = builtinModels({ credentials: AuthStorage.create(layout) });
		await models.refresh({ allowNetwork: false });
		let embedded: Awaited<ReturnType<typeof createEmbeddedSessionRuntime>> | undefined;
		try {
			embedded = await createEmbeddedSessionRuntime({
				sessionId,
				store,
				ownerStore,
				domain: {
					cwd: root,
					layout,
					settings,
					runtimeSettings,
					models,
					securitySources: noPromptTestSecurity,
				},
			});
			const domain = (embedded.runtime as unknown as { readonly domain?: SessionDomainPort }).domain;
			const process = domain?.process;
			expect(process).toBeDefined();
			if (process === undefined) return;
			const started = await process.mutate("session.process.start", {
				command: "printf ignored",
				cwd: root,
				timeoutMs: 5_000,
				backend: "pipe",
				executionMode: "background",
			}, {
				correlationId: "correlation-embedded-settings-shell",
				effectId: "effect-embedded-settings-shell",
				expectedRevision: 0,
			});
			expect(started).toMatchObject({ ok: true });
			if (!started.ok) return;
			const executionId = String(started.value.executionId);
			let output = "";
			for (let attempt = 0; attempt < 100 && !output.includes("embedded-settings-shell"); attempt += 1) {
				const page = await process.query("session.process.output", {
					executionId,
					cursor: { sequence: 0, byteOffset: 0 },
					maxBytes: 1_024,
				}, {
					correlationId: `correlation-embedded-settings-shell-output-${attempt}`,
					effectId: `effect-embedded-settings-shell-output-${attempt}`,
				});
				if (page.ok) output = String(page.value.text ?? "");
				if (!output.includes("embedded-settings-shell")) await new Promise((resolve) => setTimeout(resolve, 10));
			}
			expect(output).toContain("embedded-settings-shell");
		} finally {
			await embedded?.handle.close().catch(() => undefined);
			await embedded?.runtime?.shutdownAfterLastAttachment("paused");
			db.close();
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("carries workspace additional directories into the Session Security roots", async () => {
		const root = mkdtempSync(resolve(tmpdir(), "runledger-session-settings-roots-"));
		const home = resolve(root, "home");
		const additional = resolve(root, "shared");
		mkdirSync(home, { recursive: true, mode: 0o700 });
		mkdirSync(additional, { recursive: true });
		const layout = buildRunledgerLayout(home, "posix");
		const db = openSessionDatabase(layout.database);
		installSessionStoreSchema(db);
		const store = new SessionStore(db);
		const ownerStore = new OwnerStore(db);
		const sessionId = createRuntimeId("session", "embedded-settings-roots");
		store.createSession({
			sessionId,
			workspaceId: createRuntimeId("workspace", "embedded-settings-roots"),
			repositoryId: createRuntimeId("repository", "embedded-settings-roots"),
			settingsDigest: "d".repeat(64),
		});
		const settings = await loadProjectSettings({ layout });
		const runtimeSettings = new SettingsResolver({
			user: {},
			workspace: { workspace: { additionalDirectories: ["shared"] } },
		}).effectiveRuntimeSnapshot();
		const models = builtinModels({ credentials: AuthStorage.create(layout) });
		await models.refresh({ allowNetwork: false });
		let embedded: Awaited<ReturnType<typeof createEmbeddedSessionRuntime>> | undefined;
		let controller: SessionInteractiveController | undefined;
		try {
			embedded = await createEmbeddedSessionRuntime({
				sessionId,
				store,
				ownerStore,
				domain: { cwd: root, layout, settings, runtimeSettings, models, securitySources: noPromptTestSecurity },
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
			const result = await controller.querySessionDomain("session.security.inspect", {}, {
				correlationId: "correlation-settings-roots",
				effectId: "effect-settings-roots",
			});
			expect(result).toMatchObject({ ok: true, value: { workspaceRootCount: 2 } });
		} finally {
			controller?.dispose();
			await embedded?.handle.close().catch(() => undefined);
			await embedded?.runtime?.shutdownAfterLastAttachment("paused");
			db.close();
			rmSync(root, { recursive: true, force: true });
		}
	});

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
		const runtimeSettings = new SettingsResolver({ user: { retry: { maxRetries: 2 } } }).effectiveRuntimeSnapshot();
		const models = builtinModels({ credentials: AuthStorage.create(layout) });
		await models.refresh({ allowNetwork: false });
		let embedded: Awaited<ReturnType<typeof createEmbeddedSessionRuntime>> | undefined;
		let controller: SessionInteractiveController | undefined;
		try {
			embedded = await createEmbeddedSessionRuntime({
				sessionId,
				store,
				ownerStore,
				domain: {
					cwd: root,
					layout,
					settings,
					runtimeSettings,
					retryPolicy: { ...runtimeSettings.retry, maxRetries: 9 },
					models,
					securitySources: noPromptTestSecurity,
				},
			});
			expect(embedded.runtime?.runtimeSettingsSnapshot()).toBe(runtimeSettings);
			expect(embedded.runtime?.runtimeSettingsSnapshot()?.retry.maxRetries).toBe(2);
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

	it("disables only the Plan projection while preserving Security and governed process execution", async () => {
		const root = mkdtempSync(resolve(tmpdir(), "runledger-session-plan-disabled-"));
		const home = resolve(root, "home");
		mkdirSync(home, { recursive: true, mode: 0o700 });
		const layout = buildRunledgerLayout(home, "posix");
		const db = openSessionDatabase(layout.database);
		installSessionStoreSchema(db);
		const store = new SessionStore(db);
		const ownerStore = new OwnerStore(db);
		const sessionId = createRuntimeId("session", "production-plan-disabled");
		store.createSession({
			sessionId,
			workspaceId: createRuntimeId("workspace", "production-plan-disabled"),
			repositoryId: createRuntimeId("repository", "production-plan-disabled"),
			settingsDigest: "d".repeat(64),
		});
		const settings = await loadProjectSettings({ layout });
		const runtimeSettings = new SettingsResolver({ user: { plan: { enabled: false } } }).effectiveRuntimeSnapshot();
		const models = builtinModels({ credentials: AuthStorage.create(layout) });
		await models.refresh({ allowNetwork: false });
		let embedded: Awaited<ReturnType<typeof createEmbeddedSessionRuntime>> | undefined;
		let controller: SessionInteractiveController | undefined;
		try {
			embedded = await createEmbeddedSessionRuntime({
				sessionId,
				store,
				ownerStore,
				domain: { cwd: root, layout, settings, runtimeSettings, models, securitySources: noPromptTestSecurity },
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

			expect(controller.supports("plan.inspect")).toBe(false);
			expect(await controller.querySessionDomain("plan.inspect", {}, {
			correlationId: "correlation-plan-disabled",
			effectId: "effect-plan-disabled",
		})).toMatchObject({ ok: false, code: "operation_unavailable" });
			expect(await controller.querySessionDomain("session.security.inspect", {}, {
			correlationId: "correlation-plan-disabled-security",
			effectId: "effect-plan-disabled-security",
		})).toMatchObject({ ok: true, value: { workspaceRootCount: 1 } });

			const domain = (embedded.runtime as unknown as { readonly domain?: SessionDomainPort }).domain;
			const process = domain?.process;
			expect(process).toBeDefined();
			if (process === undefined) return;
			const started = await process.mutate("session.process.start", {
				command: "printf plan-setting-process",
				cwd: root,
				timeoutMs: 5_000,
				backend: "pipe",
				executionMode: "background",
			}, {
				correlationId: "correlation-plan-disabled-process",
				effectId: "effect-plan-disabled-process",
				expectedRevision: 0,
			});
			expect(started).toMatchObject({ ok: true });
		} finally {
			controller?.dispose();
			await embedded?.handle.close().catch(() => undefined);
			await embedded?.runtime?.shutdownAfterLastAttachment("paused");
			db.close();
			rmSync(root, { recursive: true, force: true });
		}
	});
});
