import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { activePermissionsFixture } from "../../helpers/active-permissions.ts";
import { createSessionSecurity } from "../../../src/security/session-composition.ts";
import { createSessionPermissionUpdater, recoverPermissionUpdates } from "../../../src/runtime/session-runtime/security-update.ts";
import { nextPermissionRevision } from "../../../src/runtime/session-runtime/security-update-journal.ts";

const fixtures: Array<Awaited<ReturnType<typeof activePermissionsFixture>>> = [];
afterEach(async () => { for (const fixture of fixtures.splice(0)) await fixture.close(); });
async function setup() { const value = await activePermissionsFixture(); fixtures.push(value); return value; }

describe("Session permission update persistence and recovery", () => {
	it("rejects stale snapshots and source digests without changing effective or saved permissions", async () => {
		const fixture = await setup();
		const stale = await fixture.request("danger-full-access");
		expect(await fixture.apply("approve-for-me")).toMatchObject({ ok: true });
		expect(await fixture.updater.apply(stale.payload, stale.context)).toMatchObject({ ok: false, status: "stale" });
		expect(fixture.security.snapshot.profile.name).toBe("approve-for-me");
		expect(fixture.update).toHaveBeenCalledTimes(1);
	});

	it("replays an identical apply receipt without saving or increasing the revision again", async () => {
		const fixture = await setup();
		const input = await fixture.request("danger-full-access");
		expect(await fixture.updater.apply(input.payload, input.context)).toMatchObject({ ok: true });
		expect(await fixture.updater.apply(input.payload, input.context)).toMatchObject({ ok: true, value: { appliedRevision: 2 } });
		expect(fixture.update).toHaveBeenCalledTimes(1);
		expect(fixture.records.map((record) => record.stage)).toEqual(["prepared", "applied"]);
		expect(await fixture.updater.apply({ ...input.payload, document: { profile: "workspace-write" } }, input.context)).toMatchObject({ ok: false, code: "permission_update_binding_changed" });
	});

	it("keeps the old version usable when saving fails before changing the configuration", async () => {
		const fixture = await setup();
		fixture.update.mockResolvedValueOnce({ ok: false, error: { code: "settings_unavailable", message: "injected failure", retryable: false } });
		expect(await fixture.apply("danger-full-access")).toMatchObject({ ok: false, code: "settings_unavailable" });
		expect(fixture.security.snapshot.profile.name).toBe("workspace-write");
		expect(fixture.records.map((record) => record.stage)).toEqual(["prepared", "rejected"]);
		const target = join(fixture.cwd, "still-writable.txt");
		await fixture.security.executionEnv.fs.writeFile(target, "old policy remains usable");
		expect(await readFile(target, "utf8")).toContain("old policy");
	});

	it("blocks execution after an applied-event failure and recovers the saved candidate on a new owner", async () => {
		const fixture = await setup();
		fixture.append.mockImplementation((record) => { if (record.stage === "applied") throw new Error("injected journal failure"); fixture.records.push(record); });
		expect(await fixture.apply("danger-full-access")).toMatchObject({ ok: false, code: "permissions_saved_not_applied", status: "recovery_required" });
		expect(fixture.security.snapshot.profile.name).toBe("workspace-write");
		await expect(fixture.security.executionEnv.fs.writeFile(join(fixture.cwd, "blocked.txt"), "no")).rejects.toMatchObject({ code: "security_update_failed" });
		const resumed = await createSessionSecurity({ ...fixture.securityOptions, initialSecurityRevision: nextPermissionRevision(fixture.journal) });
		try {
			await recoverPermissionUpdates({ security: resumed, settings: fixture.settings, journal: fixture.journal });
			expect(resumed.snapshot).toMatchObject({ securityRevision: 3, profile: { name: "danger-full-access" } });
			expect(fixture.records.at(-1)?.stage).toBe("recovered");
			await resumed.executionEnv.fs.writeFile(join(fixture.root, "recovered.txt"), "after recovery");
		} finally { await resumed.close(); }
	});

	it("detects a save that changed the file before returning an error", async () => {
		const fixture = await setup();
		fixture.update.mockImplementationOnce(async (input) => {
			await fixture.settings.update(input);
			return { ok: false, error: { code: "settings_unavailable", message: "post-rename failure", retryable: false } };
		});
		expect(await fixture.apply("danger-full-access")).toMatchObject({ ok: false, code: "permissions_saved_not_applied" });
		expect(fixture.records.at(-1)?.stage).toBe("prepared");
		await expect(fixture.security.executionEnv.shell.exec("echo blocked")).rejects.toMatchObject({ code: "security_update_failed" });
		expect(fixture.shellExec).not.toHaveBeenCalled();
	});

	it("rejects conflicting recovery configuration instead of overwriting it", async () => {
		const fixture = await setup();
		fixture.append.mockImplementation((record) => { if (record.stage === "applied") throw new Error("injected journal failure"); fixture.records.push(record); });
		await fixture.apply("danger-full-access");
		await writeFile(fixture.layout.settings, JSON.stringify({ security: { profile: "approve-for-me" } }));
		const resumed = await createSessionSecurity({ ...fixture.securityOptions, initialSecurityRevision: nextPermissionRevision(fixture.journal) });
		try {
			await expect(recoverPermissionUpdates({ security: resumed, settings: fixture.settings, journal: fixture.journal })).rejects.toThrow("security source conflict");
			expect(JSON.parse(await readFile(fixture.layout.settings, "utf8"))).toEqual({ security: { profile: "approve-for-me" } });
		} finally { await resumed.close(); }
	});

	it("does not bypass a workspace preset restriction when applying Full Access", async () => {
		const fixture = await setup();
		const project = join(fixture.layout.projects, fixture.security.workspaceStorageKey);
		await mkdir(project, { recursive: true });
		await writeFile(join(project, "settings.json"), JSON.stringify({ security: { profile: "workspace-write" } }));
		expect(await fixture.apply("danger-full-access")).toMatchObject({ ok: false, status: "denied", code: "policy_denied" });
		expect(fixture.update).not.toHaveBeenCalled();
		expect(fixture.security.snapshot.profile.name).toBe("workspace-write");
	});

	it("rejects overlapping updates while a configuration write is outstanding", async () => {
		const fixture = await setup();
		let release!: () => void;
		const barrier = new Promise<void>((resolve) => { release = resolve; });
		fixture.update.mockImplementationOnce(async (input) => { await barrier; return fixture.settings.update(input); });
		const first = fixture.apply("danger-full-access");
		await vi.waitFor(() => expect(fixture.update).toHaveBeenCalledTimes(1));
		expect(await fixture.apply("approve-for-me")).toMatchObject({ ok: false, code: "security_update_in_progress" });
		release();
		expect(await first).toMatchObject({ ok: true });
		expect(fixture.security.snapshot.securityRevision).toBe(2);
	});
});


describe("permission update exception boundaries", () => {
	it("fails closed instead of leaving waiters hanging when attempt admission throws", async () => {
		const fixture = await setup();
		const updater = createSessionPermissionUpdater({ generation: 1, security: fixture.security, settings: fixture.settingsPort, journal: fixture.journal, attemptPort: () => ({
			beginAttempt: () => { throw new Error("owner lost"); }, settleAttempt: () => ({ ok: true }),
		}) });
		const input = await fixture.request("danger-full-access");
		expect(await updater.apply(input.payload, input.context)).toMatchObject({ ok: false, status: "recovery_required" });
		expect(fixture.security.applicationState).toBe("recovery_required");
		await expect(fixture.security.executionEnv.fs.readFile(join(fixture.cwd, "anything"))).rejects.toMatchObject({ code: "security_update_failed" });
		expect(fixture.update).not.toHaveBeenCalled();
	});

	it("reports partial persistence when a writer throws after the rename", async () => {
		const fixture = await setup();
		fixture.update.mockImplementationOnce(async (input) => { await fixture.settings.update(input); throw new Error("post-rename error"); });
		expect(await fixture.apply("danger-full-access")).toMatchObject({ ok: false, code: "permissions_saved_not_applied" });
		expect(fixture.security.applicationState).toBe("recovery_required");
	});
});
