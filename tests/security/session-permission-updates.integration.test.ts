import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runtimeDigest } from "../../src/runtime/protocol/foundation.ts";
import { activePermissionsFixture } from "../helpers/active-permissions.ts";

const fixtures: Array<Awaited<ReturnType<typeof activePermissionsFixture>>> = [];
afterEach(async () => { for (const fixture of fixtures.splice(0)) await fixture.close(); });
async function setup(...args: Parameters<typeof activePermissionsFixture>) { const value = await activePermissionsFixture(...args); fixtures.push(value); return value; }

describe("permissions applied to the active Session", () => {
	it("applies Full Access to the existing execution ports without recreating the Session", async () => {
		const fixture = await setup();
		const originalSnapshot = fixture.security.snapshot;
		const filesystem = fixture.security.executionEnv.fs;
		expect(await fixture.apply("danger-full-access")).toMatchObject({ ok: true, value: { securityRevision: 2, effectiveProfile: "danger-full-access" } });
		expect(originalSnapshot.profile.name).toBe("workspace-write");
		expect(fixture.security.snapshot.policyDigest).not.toEqual(originalSnapshot.policyDigest);
		const target = join(fixture.root, "outside.txt");
		await filesystem.writeFile(target, "immediate");
		expect(await readFile(target, "utf8")).toBe("immediate");
		expect(fixture.prompts).toHaveLength(0);
	});

	it("retires the pending shell prompt and executes the original operation once under Full Access", async () => {
		const fixture = await setup();
		const command = 'for d in one two; do [ -d "$d" ] && echo yes || echo no; done';
		const running = fixture.security.executionEnv.shell.exec(command);
		await vi.waitFor(() => expect(fixture.prompts).toHaveLength(1));
		expect(fixture.shellExec).not.toHaveBeenCalled();
		expect(await fixture.apply("danger-full-access")).toMatchObject({ ok: true });
		await expect(running).resolves.toMatchObject({ exitCode: 0 });
		expect(fixture.prompts[0]!.signal?.aborted).toBe(true);
		expect(fixture.audit.superseded).toHaveBeenCalledTimes(1);
		fixture.allow(0);
		expect(fixture.shellExec).toHaveBeenCalledTimes(1);
		expect(fixture.prompts).toHaveLength(1);
	});

	it("re-evaluates pending filesystem and network approvals, then enforces a tighter preset", async () => {
		const fixture = await setup();
		const target = join(fixture.root, "pending.txt");
		const writing = fixture.security.executionEnv.fs.writeFile(target, "approved by preset");
		const request = { url: "https://example.invalid/fixture", method: "GET", headers: {}, maxBytes: 1024 };
		const fetching = fixture.security.executionEnv.network!.request(request);
		await vi.waitFor(() => expect(fixture.prompts).toHaveLength(2));
		expect(await fixture.apply("danger-full-access")).toMatchObject({ ok: true });
		await writing;
		await expect(fetching).resolves.toMatchObject({ status: 200 });
		expect(fixture.networkRequest).toHaveBeenCalledTimes(1);
		expect(await fixture.apply("workspace-write")).toMatchObject({ ok: true, value: { securityRevision: 3 } });
		const blockedWrite = fixture.security.executionEnv.fs.writeFile(join(fixture.root, "denied.txt"), "no").catch((error: unknown) => error);
		const blockedFetch = fixture.security.executionEnv.network!.request(request).catch((error: unknown) => error);
		await vi.waitFor(() => expect(fixture.prompts).toHaveLength(4));
		fixture.allow(2, "deny"); fixture.allow(3, "deny");
		expect(await blockedWrite).toMatchObject({ code: "policy_denied" });
		expect(await blockedFetch).toMatchObject({ code: "policy_denied" });
		expect(fixture.networkRequest).toHaveBeenCalledTimes(1);
		await expect(readFile(join(fixture.root, "denied.txt"))).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("does not replay an explicitly cancelled operation after the preset changes", async () => {
		const fixture = await setup();
		const running = fixture.security.executionEnv.shell.exec("for x in a; do echo x; done").catch((error: unknown) => error);
		await vi.waitFor(() => expect(fixture.prompts).toHaveLength(1));
		fixture.allow(0, "cancel");
		expect(await running).toMatchObject({ code: "approval_cancelled" });
		expect(await fixture.apply("danger-full-access")).toMatchObject({ ok: true });
		expect(fixture.shellExec).not.toHaveBeenCalled();
	});

	it("keeps system destructive commands behind an exact prompt in Full Access", async () => {
		const fixture = await setup();
		expect(await fixture.apply("danger-full-access")).toMatchObject({ ok: true });
		const running = fixture.security.executionEnv.shell.exec("reboot").catch((error: unknown) => error);
		await vi.waitFor(() => expect(fixture.prompts).toHaveLength(1));
		expect(fixture.prompts[0]!.prompt.requiresExplicitConfirmation).toBe(true);
		fixture.allow(0, "deny");
		await running;
		expect(fixture.shellExec).not.toHaveBeenCalled();
	});

	it("does not reuse a session approval after switching away and back", async () => {
		const fixture = await setup();
		const command = "for x in a; do echo x; done";
		const first = fixture.security.executionEnv.shell.exec(command);
		await vi.waitFor(() => expect(fixture.prompts).toHaveLength(1));
		fixture.allow(0, "allow-session");
		await first;
		await fixture.apply("danger-full-access");
		await fixture.apply("workspace-write");
		const second = fixture.security.executionEnv.shell.exec(command).catch((error: unknown) => error);
		await vi.waitFor(() => expect(fixture.prompts).toHaveLength(2));
		fixture.allow(1, "deny");
		await second;
		expect(fixture.shellExec).toHaveBeenCalledTimes(1);
	});

	it("waits only for managed spawn admission, then invalidates previously prepared execution", async () => {
		const fixture = await setup({ profile: "danger-full-access" });
		const prepared = await fixture.security.managedProcess.prepare({ commandId: "command-admit", command: "echo fixture", cwd: fixture.cwd, timeoutMs: 1000, backend: "pipe", executionMode: "foreground", requestDigest: runtimeDigest("fixture") });
		if (!prepared.ok) throw new Error(prepared.error.code);
		const admitted = prepared.value.acquireAdmission!();
		if (!admitted.ok) throw new Error(admitted.error.code);
		let applied = false;
		const updating = fixture.apply("workspace-write").then((result) => { applied = true; return result; });
		await vi.waitFor(() => expect(fixture.update).not.toHaveBeenCalled());
		expect(applied).toBe(false);
		expect(await prepared.value.validateFinalLeaf()).toMatchObject({ ok: true });
		admitted.value();
		expect(await updating).toMatchObject({ ok: true });
		expect(prepared.value.acquireAdmission!()).toMatchObject({ ok: false, error: { code: "security_policy_changed" } });
		expect(await prepared.value.validateFinalLeaf()).toMatchObject({ ok: false, error: { code: "security_policy_changed" } });
	});
});

describe("permission scope boundaries", () => {
	it("pins existing child scopes and allows a new root or child scope to use the applied preset", async () => {
		const fixture = await setup();
		const child = fixture.security.capturePermissionScope();
		const pending = child(() => fixture.security.executionEnv.fs.writeFile(join(fixture.root, "child.txt"), "must not run")).catch((error: unknown) => error);
		await vi.waitFor(() => expect(fixture.prompts).toHaveLength(1));
		expect(await fixture.apply("danger-full-access")).toMatchObject({ ok: true });
		expect(await pending).toMatchObject({ code: "security_policy_changed" });
		await expect(readFile(join(fixture.root, "child.txt"))).rejects.toMatchObject({ code: "ENOENT" });
		await expect(child(() => fixture.security.executionEnv.fs.readFile(join(fixture.cwd, "missing")))).rejects.toMatchObject({ code: "security_policy_changed" });
		await fixture.security.executionEnv.fs.writeFile(join(fixture.root, "root.txt"), "root");
		const fresh = fixture.security.capturePermissionScope();
		expect((await fresh(() => fixture.security.executionEnv.fs.readFile(join(fixture.root, "root.txt")))).toString()).toBe("root");
	});

	it("re-authorizes a pending managed process before issuing its prepared execution", async () => {
		const fixture = await setup();
		const pending = fixture.security.managedProcess.prepare({ commandId: "pending-managed", command: "for x in a; do echo x; done", cwd: fixture.cwd, timeoutMs: 1000, backend: "pipe", executionMode: "foreground", requestDigest: runtimeDigest("managed-pending") });
		await vi.waitFor(() => expect(fixture.prompts).toHaveLength(1));
		await fixture.apply("danger-full-access");
		const prepared = await pending;
		expect(prepared.ok).toBe(true);
		if (!prepared.ok) throw new Error(prepared.error.code);
		expect(await prepared.value.validateFinalLeaf()).toMatchObject({ ok: true });
		expect(fixture.audit.superseded).toHaveBeenCalledTimes(1);
		await prepared.value.complete();
	});
});
