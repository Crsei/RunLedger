import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createEmbeddedSessionRuntime } from "../../../src/cli/embedded-session-runtime.ts";
import { claimDriver, fetchDomainSnapshot, pauseIfLastAttachment } from "../../../src/cli/main.ts";
import { SessionInteractiveController } from "../../../src/cli/session-interactive-controller.ts";
import { builtinModels } from "../../../src/providers/all.ts";
import { buildRunledgerLayout } from "../../../src/runtime/contracts/storage-layout.ts";
import { standardHarnessProfileRef } from "../../../src/runtime/harness-profiles/index.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/ids.ts";
import type { ExecutionEnv } from "../../../src/runtime/execution-env.ts";
import type { SessionDomainPort } from "../../../src/runtime/session-runtime/session-runtime.ts";
import { AuthStorage } from "../../../src/storage/auth-storage.ts";
import { openSessionDatabase } from "../../../src/storage/session-store/database.ts";
import { OwnerStore } from "../../../src/storage/session-store/owner-store.ts";
import { installSessionStoreSchema } from "../../../src/storage/session-store/schema.ts";
import { SessionStore } from "../../../src/storage/session-store/session-store.ts";
import { applySystemPermissionPreset } from "../../../src/tui/permissions/preset-selection.ts";

describe("active permissions through the production Session Owner transport", () => {
	it("keeps permission events unique across Sessions sharing request counters and replays existing receipts", async () => {
		const root = mkdtempSync(join(tmpdir(), "runledger-permission-shared-home-"));
		const home = join(root, "home"); const cwd = join(root, "workspace"); mkdirSync(home); mkdirSync(cwd);
		const layout = buildRunledgerLayout(home, "posix");
		const db = openSessionDatabase(layout.database); installSessionStoreSchema(db);
		const store = new SessionStore(db); const ownerStore = new OwnerStore(db);
		const models = builtinModels({ credentials: AuthStorage.inMemory() }); await models.refresh({ allowNetwork: false });
		const ids = new Set<string>();
		const append = store.appendEvent.bind(store);
		let legacy = true;
		// 第一份记录模拟升级前的 event ID；保留历史记录，再验证新版会话互不冲突。
		vi.spyOn(store, "appendEvent").mockImplementation((fence, input) => {
			if (legacy && input.eventType === "session.security.update") {
				const record = JSON.parse(input.payloadJson) as { updateId: string; stage: string };
				return append(fence, { ...input, eventId: createRuntimeId("event", `permission-${record.updateId}-${record.stage}`) });
			}
			return append(fence, input);
		});
		try {
			for (const name of ["legacy", "first", "second"]) {
				legacy = name === "legacy";
				writeFileSync(layout.settings, "{}");
				const sessionId = createRuntimeId("session", `permission-${name}`);
				store.createSession({ sessionId, workspaceId: createRuntimeId("workspace", "shared"), repositoryId: createRuntimeId("repository", "shared"), settingsDigest: "d".repeat(64), harnessProfile: standardHarnessProfileRef() });
				const options = { sessionId, store, ownerStore, domain: { cwd, layout, models, settings: { autoTitle: false } } };
				let embedded: Awaited<ReturnType<typeof createEmbeddedSessionRuntime>> | undefined;
				let client: SessionInteractiveController | undefined;
				try {
					embedded = await createEmbeddedSessionRuntime(options);
					client = new SessionInteractiveController(embedded.handle, await fetchDomainSnapshot(embedded));
					await claimDriver(embedded, client);
					const saved = await client.querySessionDomain("security.settings.inspect", { scope: "user" }, { correlationId: "corr-3", effectId: "effect-3" });
					const effective = await client.querySessionDomain("session.security.inspect", {}, { correlationId: "corr-4", effectId: "effect-4" });
					if (!saved.ok || !effective.ok) throw new Error("permission inspection failed");
					expect(effective.value).toMatchObject({ profile: "workspace-write", securityRevision: 1 });
					const payload = { scope: "user", expectedSourceDigest: saved.value.sourceDigest, expectedSecurityRevision: 1, document: applySystemPermissionPreset({}, "danger-full-access") };
					const context = { correlationId: "corr-5", effectId: "effect-5", expectedRevision: saved.domainRevision };
					for (let replay = 0; replay < 2; replay += 1) {
						expect(await client.commandSessionDomain("session.security.apply", payload, context), name).toMatchObject({ ok: true, value: { appliedRevision: 2, securityRevision: 2, effectiveProfile: "danger-full-access" } });
					}
					expect(JSON.parse(readFileSync(layout.settings, "utf8"))).toMatchObject({ security: { profile: "danger-full-access" } });
					const events = store.replaySessionEvents(sessionId).filter((event) => event.eventType === "session.security.update");
					expect(events.map((event) => JSON.parse(event.payloadJson).stage)).toEqual(["prepared", "applied"]);
					for (const event of events) { expect(ids.has(event.eventId)).toBe(false); ids.add(event.eventId); }
					client.dispose(); client = undefined; await embedded.handle.close(); await pauseIfLastAttachment(embedded, true, true);
					embedded = await createEmbeddedSessionRuntime(options);
					client = new SessionInteractiveController(embedded.handle, await fetchDomainSnapshot(embedded));
					expect(await client.querySessionDomain("session.security.inspect", {}, { correlationId: "resume", effectId: "resume" })).toMatchObject({ ok: true, value: { profile: "danger-full-access", securityRevision: 3 } });
				} finally {
					client?.dispose(); await embedded?.handle.close().catch(() => undefined); await embedded?.runtime?.shutdownAfterLastAttachment("paused");
				}
			}
			expect(ids.size).toBe(6);
		} finally { db.close(); rmSync(root, { recursive: true, force: true }); }
	}, 30_000);

	it("applies through the driver, supersedes a reverse request, publishes the profile, and resumes monotonically", async () => {
		const root = mkdtempSync(join(tmpdir(), "runledger-permission-owner-"));
		const home = join(root, "home"); const cwd = join(root, "workspace"); mkdirSync(home); mkdirSync(cwd);
		const layout = buildRunledgerLayout(home, "posix");
		writeFileSync(layout.settings, JSON.stringify({ security: { profile: "workspace-write" } }));
		const db = openSessionDatabase(layout.database); installSessionStoreSchema(db);
		const store = new SessionStore(db); const ownerStore = new OwnerStore(db);
		const sessionId = createRuntimeId("session", "permission-owner");
		store.createSession({ sessionId, workspaceId: createRuntimeId("workspace", "permission-owner"), repositoryId: createRuntimeId("repository", "permission-owner"), settingsDigest: "d".repeat(64), harnessProfile: standardHarnessProfileRef() });
		const models = builtinModels({ credentials: AuthStorage.create(layout) }); await models.refresh({ allowNetwork: false });
		const pending: AbortSignal[] = [];
		const options = { sessionId, store, ownerStore,
			reverseRequestHandler: async (_frame: unknown, signal: AbortSignal): Promise<Record<string, unknown>> => {
				pending.push(signal);
				return new Promise((resolve) => { signal.addEventListener("abort", () => resolve({ ok: false, code: "approval_aborted" }), { once: true }); });
			},
			domain: { cwd, layout, models, settings: { autoTitle: false }, securitySources: [{ source: "cli" as const, read: async () => ({ status: "available" as const, text: JSON.stringify({ sandbox: "off" }) }) }] },
		};
		let embedded: Awaited<ReturnType<typeof createEmbeddedSessionRuntime>> | undefined;
		let client: SessionInteractiveController | undefined;
		try {
			embedded = await createEmbeddedSessionRuntime(options);
			client = new SessionInteractiveController(embedded.handle, await fetchDomainSnapshot(embedded));
			const saved = await client.querySessionDomain("security.settings.inspect", { scope: "user" }, { correlationId: "inspect", effectId: "inspect" });
			if (!saved.ok) throw new Error(saved.code);
			const payload = { scope: "user", expectedSourceDigest: saved.value.sourceDigest, expectedSecurityRevision: 1, document: { profile: "danger-full-access" } };
			expect(await client.commandSessionDomain("session.security.apply", payload, { correlationId: "observer", effectId: "observer", expectedRevision: saved.domainRevision })).toMatchObject({ ok: false, code: "driver_required" });
			await claimDriver(embedded, client);
			await client.resumeEvents();
			const profiles: string[] = [];
			client.subscribePermissionProfile((profile) => profiles.push(profile));
			const domain = (embedded.runtime as unknown as { domain: SessionDomainPort }).domain;
			const controller = domain.controller as typeof domain.controller & { executionEnv: ExecutionEnv };
			const target = join(root, "outside.txt");
			vi.spyOn(controller, "prompt").mockImplementationOnce(async () => {
				await controller.executionEnv.fs.writeFile(target, "exactly once");
			});
			const writing = client.prompt("controlled tool execution without a provider");
			await vi.waitFor(() => expect(pending).toHaveLength(1));
			expect(await client.querySessionDomain("session.security.inspect", {}, { correlationId: "during-prompt", effectId: "during-prompt" })).toMatchObject({ ok: true, value: { securityRevision: 1 } });
			expect(await client.commandSessionDomain("session.security.apply", payload, { correlationId: "stale", effectId: "stale", expectedRevision: saved.domainRevision + 1 })).toMatchObject({ ok: false });
			expect(await client.commandSessionDomain("session.security.apply", payload, { correlationId: "apply", effectId: "apply", expectedRevision: saved.domainRevision })).toMatchObject({ ok: true, value: { securityRevision: 2, effectiveProfile: "danger-full-access" } });
			await writing;
			expect(readFileSync(target, "utf8")).toBe("exactly once");
			await vi.waitFor(() => expect(pending[0]!.aborted).toBe(true));
			await vi.waitFor(() => expect(profiles).toEqual(["workspace-write", "danger-full-access"]));
			const events = store.replaySessionEvents(sessionId);
			expect(events.filter((event) => event.eventType === "approval.superseded")).toHaveLength(1);
			expect(events.filter((event) => event.eventType === "session.security.update").map((event) => JSON.parse(event.payloadJson).stage)).toEqual(["prepared", "applied"]);
			client.dispose(); client = undefined; await embedded.handle.close(); await pauseIfLastAttachment(embedded, true, true);
			embedded = await createEmbeddedSessionRuntime(options);
			client = new SessionInteractiveController(embedded.handle, await fetchDomainSnapshot(embedded));
			expect(await client.querySessionDomain("session.security.inspect", {}, { correlationId: "resumed", effectId: "resumed" })).toMatchObject({ ok: true, value: { profile: "danger-full-access", securityRevision: 3 } });
		} finally {
			client?.dispose(); await embedded?.handle.close().catch(() => undefined); await embedded?.runtime?.shutdownAfterLastAttachment("paused"); db.close(); rmSync(root, { recursive: true, force: true });
		}
	}, 20_000);
});
