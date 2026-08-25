import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildRunledgerLayout, type RunledgerLayout } from "../../src/runtime/contracts/storage-layout.ts";
import { SettingsRuntimeStore } from "../../src/storage/settings-runtime-store.ts";
import { SettingsService } from "../../src/storage/settings-service.ts";

describe("SettingsRuntimeStore", () => {
	let root: string;
	let layout: RunledgerLayout;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "runledger-settings-runtime-"));
		layout = buildRunledgerLayout(join(root, "home"), "posix");
	});

	afterEach(() => rmSync(root, { recursive: true, force: true }));

	it("refreshes live presentation settings while deferring next-turn and startup settings", async () => {
		const service = new SettingsService({ layout });
		const runtime = new SettingsRuntimeStore({ layout });
		await runtime.load();
		const activeTurn = runtime.beginTurn();
		const changes: Array<{ readonly reason: string; readonly applied: readonly string[]; readonly pending: readonly string[] }> = [];
		const unsubscribe = runtime.subscribe((change) => {
			changes.push({ reason: change.reason, applied: change.appliedPaths, pending: change.pendingPaths });
		});

		await service.set("display.showTokenUsage", false);
		await service.set("retry.maxRetries", 3);
		await service.set("startup.quiet", true);
		const reloaded = await runtime.reload();

		expect(activeTurn.display.display?.showTokenUsage).toBe(true);
		expect(activeTurn.retry.maxRetries).toBe(0);
		expect(runtime.current().display.display?.showTokenUsage).toBe(false);
		expect(runtime.current().retry.maxRetries).toBe(0);
		expect(runtime.current().startup.startup?.quiet).toBe(false);
		expect(reloaded.appliedPaths).toContain("display.showTokenUsage");
		expect(reloaded.pendingPaths).toEqual(expect.arrayContaining(["retry.maxRetries", "startup.quiet"]));
		expect(runtime.pending().retry.maxRetries).toBe(3);
		expect(runtime.pending().startup.startup?.quiet).toBe(true);

		const nextTurn = runtime.beginTurn();
		expect(nextTurn.retry.maxRetries).toBe(3);
		expect(nextTurn.startup.startup?.quiet).toBe(false);
		expect(activeTurn.retry.maxRetries).toBe(0);
		expect(changes).toEqual([
			expect.objectContaining({
				reason: "reload",
				applied: ["display.showTokenUsage"],
				pending: expect.arrayContaining(["retry.maxRetries", "startup.quiet"]),
			}),
			expect.objectContaining({ reason: "next-turn", applied: ["retry.maxRetries"], pending: ["startup.quiet"] }),
		]);

		unsubscribe();
	});

	it("exposes an editor port whose writes reload the live runtime snapshot", async () => {
		const runtime = new SettingsRuntimeStore({ layout });
		await runtime.load();
		const changes: SettingsRuntimeChange[] = [];
		runtime.subscribe((change) => changes.push(change));

		const editor = runtime.editorPort();
		await editor.set("display.showTokenUsage", false);

		expect(runtime.current().display.display?.showTokenUsage).toBe(false);
		expect(changes).toHaveLength(1);
		expect(changes[0]?.appliedPaths).toContain("display.showTokenUsage");
	});

	it("applies startup settings only when a new runtime store is loaded", async () => {
		const service = new SettingsService({ layout });
		const runtime = new SettingsRuntimeStore({ layout });
		await runtime.load();
		await service.set("startup.quiet", true);
		await runtime.reload();
		await runtime.beginTurn();

		expect(runtime.current().startup.startup?.quiet).toBe(false);
		const restarted = new SettingsRuntimeStore({ layout });
		await restarted.load();
		expect(restarted.current().startup.startup?.quiet).toBe(true);
	});

	it("uses one service write boundary and reports a stable digest for each adopted snapshot", async () => {
		const runtime = new SettingsRuntimeStore({ layout });
		await runtime.load();
		const firstDigest = runtime.current().digest.digest;
		await runtime.set("display.cacheMissMarker", true);
		expect(runtime.current().display.display?.cacheMissMarker).toBe(true);
		expect(runtime.current().digest.digest).not.toBe(firstDigest);
		expect(runtime.current().diagnostics).toEqual([]);
	});

	it("retains invalid persisted source diagnostics while consumers receive safe defaults", async () => {
		mkdirSync(layout.home, { recursive: true });
		writeFileSync(layout.settings, JSON.stringify({
			retry: { maxRetries: 99 },
			tools: { approvalMode: "unsafe-secret-mode" },
		}), "utf8");
		const runtime = new SettingsRuntimeStore({ layout });

		const snapshot = await runtime.load();

		expect(snapshot.retry.maxRetries).toBe(0);
		expect(snapshot.toolPolicy.approvalMode).toBe("always-ask");
		expect(snapshot.diagnostics).toEqual(expect.arrayContaining([
			expect.objectContaining({ code: "out_of_range", path: "retry.maxRetries", source: "user" }),
			expect.objectContaining({ code: "invalid_value", path: "tools.approvalMode", source: "user" }),
		]));
		expect(JSON.stringify(snapshot.diagnostics)).not.toContain("unsafe-secret-mode");
	});
});
