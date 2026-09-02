import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildRunledgerLayout } from "../../src/runtime/contracts/storage-layout.ts";
import { SecuritySettingsPort } from "../../src/security/config/settings-port.ts";

const roots: string[] = [];

afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("SecuritySettingsPort", () => {
	it("atomically updates only settings.security and rejects stale revisions", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-security-settings-"));
		roots.push(root);
		const layout = buildRunledgerLayout(join(root, "home"), "posix");
		await mkdir(layout.home, { recursive: true });
		await writeFile(layout.settings, JSON.stringify({ theme: "catppuccin-mocha", security: { profile: "workspace-write" } }), "utf8");
		const port = new SecuritySettingsPort({ layout, workspaceRoot: "/repo", tempRoot: "/tmp/runledger" });

		const initial = await port.inspect({ scope: "user" });
		expect(initial).toMatchObject({ ok: true, value: { document: { profile: "workspace-write" } } });
		if (!initial.ok) return;
		const updated = await port.update({
			scope: "user",
			expectedSourceDigest: initial.value.sourceDigest,
			document: { profile: "approve-for-me" },
		});
		expect(updated).toMatchObject({ ok: true, value: { document: { profile: "approve-for-me" } } });
		expect(JSON.parse(await readFile(layout.settings, "utf8"))).toEqual({
			theme: "catppuccin-mocha",
			security: { profile: "approve-for-me" },
		});
		const stale = await port.update({
			scope: "user",
			expectedSourceDigest: initial.value.sourceDigest,
			document: { profile: "danger-full-access" },
		});
		expect(stale).toMatchObject({ ok: false, error: { code: "revision_conflict" } });
	});

	it("refuses a workspace profile that would widen its user baseline", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-security-settings-"));
		roots.push(root);
		const layout = buildRunledgerLayout(join(root, "home"), "posix");
		await mkdir(layout.home, { recursive: true });
		await writeFile(layout.settings, JSON.stringify({ security: { profile: "workspace-write" } }), "utf8");
		const port = new SecuritySettingsPort({ layout, workspaceKey: "workspace-1", workspaceRoot: "/repo", tempRoot: "/tmp/runledger" });

		const initial = await port.inspect({ scope: "workspace" });
		if (!initial.ok) throw new Error(initial.error.message);
		const result = await port.update({
			scope: "workspace",
			expectedSourceDigest: initial.value.sourceDigest,
			document: { profile: "danger-full-access" },
		});

		expect(result).toMatchObject({ ok: false, error: { code: "invalid_config" } });
	});

	it("refuses workspace fields that could widen a user baseline despite a narrower selected profile", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-security-settings-"));
		roots.push(root);
		const layout = buildRunledgerLayout(join(root, "home"), "posix");
		await mkdir(layout.home, { recursive: true });
		await writeFile(layout.settings, JSON.stringify({ security: { profile: "danger-full-access" } }), "utf8");
		const port = new SecuritySettingsPort({ layout, workspaceKey: "workspace-1", workspaceRoot: "/repo", tempRoot: "/tmp/runledger" });

		const initial = await port.inspect({ scope: "workspace" });
		if (!initial.ok) throw new Error(initial.error.message);
		const result = await port.update({
			scope: "workspace",
			expectedSourceDigest: initial.value.sourceDigest,
			document: {
				profile: "workspace-write",
				approvalPolicy: "on-request",
				approvalReviewer: "auto-review",
				sandbox: "off",
				network: { mode: "allow", allowedHosts: [] },
				filesystem: { writeRoots: ["/outside/workspace"] },
				profiles: {
					widened: { extends: "workspace-write", network: { mode: "allow", allowedHosts: [] } },
				},
				rules: [{ id: "allow-external", action: "allow", kind: "filesystem", pattern: "/outside/**" }],
				bashAnalyzerMode: "legacy",
			},
		});

		expect(result).toMatchObject({ ok: false, error: { code: "invalid_config" } });
	});

	it("allows a workspace to add deny-only hardening to a narrower built-in profile", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-security-settings-"));
		roots.push(root);
		const layout = buildRunledgerLayout(join(root, "home"), "posix");
		await mkdir(layout.home, { recursive: true });
		await writeFile(layout.settings, JSON.stringify({ security: { profile: "danger-full-access" } }), "utf8");
		const port = new SecuritySettingsPort({ layout, workspaceKey: "workspace-1", workspaceRoot: "/repo", tempRoot: "/tmp/runledger" });

		const initial = await port.inspect({ scope: "workspace" });
		if (!initial.ok) throw new Error(initial.error.message);
		const result = await port.update({
			scope: "workspace",
			expectedSourceDigest: initial.value.sourceDigest,
			document: {
				profile: "workspace-write",
				filesystem: { denyRead: [".env"], denyWrite: ["secrets"], protectedPaths: ["private"] },
				rules: [{ id: "ask-destructive", action: "ask", kind: "shell", pattern: "rm -rf *" }],
			},
		});

		expect(result).toMatchObject({
			ok: true,
			value: {
				document: {
					profile: "workspace-write",
					filesystem: { denyRead: [".env"], denyWrite: ["secrets"], protectedPaths: ["private"] },
				},
			},
		});
	});

	it("keeps managed security settings read-only", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-security-settings-"));
		roots.push(root);
		const layout = buildRunledgerLayout(join(root, "home"), "posix");
		await mkdir(layout.home, { recursive: true });
		const port = new SecuritySettingsPort({
			layout,
			workspaceRoot: "/repo",
			tempRoot: "/tmp/runledger",
			managedReadOnly: true,
		});

		const initial = await port.inspect({ scope: "user" });
		if (!initial.ok) throw new Error(initial.error.message);
		const result = await port.update({
			scope: "user",
			expectedSourceDigest: initial.value.sourceDigest,
			document: { profile: "approve-for-me" },
		});

		expect(result).toMatchObject({ ok: false, error: { code: "policy_denied" } });
	});
});
