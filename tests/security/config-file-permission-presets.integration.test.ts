import * as fs from "node:fs/promises";
import { mkdtempSync, readFileSync, type Stats } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { rmSyncRetry } from "../helpers/cleanup.ts";
import { buildRunledgerLayout, workspaceStorageKey } from "../../src/runtime/contracts/storage-layout.ts";
import { createRuntimeId } from "../../src/runtime/protocol/ids.ts";
import type { OwnerFence } from "../../src/runtime/session-owner/types.ts";
import { UnavailableSandboxBackend } from "../../src/security/sandbox/unavailable.ts";
import { createSessionSecurity } from "../../src/security/session-composition.ts";
import type { FileSystemBrokerPort } from "../../src/security/policy-filesystem.ts";

type PermissionPreset = "workspace-write" | "approve-for-me" | "danger-full-access";

let root: string | undefined;

afterEach(() => {
	if (root !== undefined) rmSyncRetry(root);
	root = undefined;
});

function fence(): OwnerFence {
	return {
		sessionId: createRuntimeId("session", "config-file-presets"),
		runtimeId: createRuntimeId("runtime", "config-file-presets"),
		generation: 1,
	};
}

function localBroker(): FileSystemBrokerPort {
	return {
		readFile: (path) => fs.readFile(path),
		writeFile: (path, data) => fs.writeFile(path, data),
		stat: async (path) => toStats(await fs.stat(path)),
		lstat: async (path) => toStats(await fs.lstat(path)),
		realpath: (path) => fs.realpath(path),
		readdir: (path) => fs.readdir(path),
		mkdir: async (path, options) => { await fs.mkdir(path, options); },
		rm: async (path, options) => { await fs.rm(path, options); },
		rename: async (from, to) => { await fs.rename(from, to); },
	};
}

function toStats(value: Stats) {
	return {
		size: value.size,
		mtimeMs: value.mtimeMs,
		isFile: value.isFile(),
		isDirectory: value.isDirectory(),
		isSymbolicLink: value.isSymbolicLink(),
	};
}

async function writeSecurityConfig(path: string, profile: PermissionPreset): Promise<void> {
	await fs.mkdir(dirname(path), { recursive: true });
	await fs.writeFile(path, `${JSON.stringify({ security: { profile } })}\n`, "utf8");
}

async function createConfiguredSecurity(input: {
	readonly userProfile: PermissionPreset;
	readonly projectProfile?: PermissionPreset;
}) {
	root = mkdtempSync(join(tmpdir(), "runledger-config-file-presets-"));
	const workspace = join(root, "workspace");
	const home = join(root, "runledger-home");
	await fs.mkdir(workspace, { recursive: true });
	const layout = buildRunledgerLayout(home, "posix");
	const workspaceId = createRuntimeId("workspace", "config-file-presets");
	const repositoryId = createRuntimeId("repository", "config-file-presets");
	const storageKey = workspaceStorageKey({
		authorityId: createRuntimeId("authority", "session-owner-runtime"),
		tenantId: createRuntimeId("tenant", "local-user"),
		workspaceId,
		repositoryId,
	});
	await writeSecurityConfig(layout.settings, input.userProfile);
	if (input.projectProfile !== undefined) {
		await writeSecurityConfig(join(layout.projects, storageKey, "settings.json"), input.projectProfile);
	}
	const security = await createSessionSecurity({
		layout,
		cwd: workspace,
		fence: fence(),
		workspaceId,
		repositoryId,
		filesystemBroker: localBroker(),
		networkBroker: {
			request: async (request) => ({ status: 200, headers: {}, body: Buffer.from("ok"), finalUrl: request.url }),
		},
		sandboxBackend: new UnavailableSandboxBackend("unknown", "test backend unavailable"),
	});
	return { layout, security, storageKey, workspace };
}

describe("permission presets loaded from canonical settings files", () => {
	it.each([
		["workspace-write", false],
		["approve-for-me", false],
		["danger-full-access", true],
	] as const)("loads the user %s preset and governs the resulting file edit", async (profile, writesOutsideWorkspace) => {
		const configured = await createConfiguredSecurity({ userProfile: profile });
		try {
			const target = writesOutsideWorkspace
				? join(root!, "user-full-access.txt")
				: join(configured.workspace, `${profile}.txt`);
			await configured.security.executionEnv.fs.writeFile(target, profile);

			expect(configured.security.snapshot.profile.name).toBe(profile);
			expect(readFileSync(target, "utf8")).toBe(profile);
			expect(JSON.parse(readFileSync(configured.layout.settings, "utf8"))).toEqual({ security: { profile } });
		} finally {
			await configured.security.close();
		}
	});

	it.each([
		["workspace-write", false],
		["approve-for-me", false],
		["danger-full-access", true],
	] as const)("lets the project settings file select the %s preset within the user baseline", async (profile, writesOutsideWorkspace) => {
		const configured = await createConfiguredSecurity({
			userProfile: "danger-full-access",
			projectProfile: profile,
		});
		try {
			const target = writesOutsideWorkspace
				? join(root!, "project-full-access.txt")
				: join(configured.workspace, `project-${profile}.txt`);
			await configured.security.executionEnv.fs.writeFile(target, profile);

			expect(configured.security.snapshot.profile.name).toBe(profile);
			expect(readFileSync(target, "utf8")).toBe(profile);
			expect(JSON.parse(readFileSync(join(configured.layout.projects, configured.storageKey, "settings.json"), "utf8"))).toEqual({ security: { profile } });
		} finally {
			await configured.security.close();
		}
	});
});
