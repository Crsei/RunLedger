import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";
import { buildRunledgerLayout } from "../../src/runtime/contracts/storage-layout.ts";
import { createRuntimeId } from "../../src/runtime/protocol/ids.ts";
import { createSecuritySettingsResourceDomain } from "../../src/runtime/session-runtime/security-settings-domain.ts";
import { createSessionPermissionUpdater } from "../../src/runtime/session-runtime/security-update.ts";
import type { PermissionUpdateRecord } from "../../src/runtime/session-runtime/security-update-journal.ts";
import { createSessionSecurity, type SessionSecurityCompositionOptions } from "../../src/security/session-composition.ts";
import { MemoryApprovalStateStore } from "../../src/security/permission/approval-coordinator.ts";
import { LinuxBwrapBackend } from "../../src/security/sandbox/linux-bwrap.ts";
import type { BuiltinPermissionPresetId } from "../../src/security/config/presets.ts";
import type { PermissionPrompt, PermissionPromptResponse, SecurityConfigDocument } from "../../src/security/types.ts";
import { SecuritySettingsPort } from "../../src/storage/security-settings-port.ts";
import { applySystemPermissionPreset } from "../../src/tui/permissions/preset-selection.ts";
import { rmSyncRetry } from "./cleanup.ts";

export async function activePermissionsFixture(options: { readonly profile?: BuiltinPermissionPresetId; readonly document?: SecurityConfigDocument } = {}) {
	const root = await mkdtemp(join(tmpdir(), "runledger-active-permissions-"));
	const cwd = join(root, "workspace");
	const layout = buildRunledgerLayout(join(root, "home"), "posix");
	await mkdir(cwd);
	await mkdir(layout.home, { recursive: true });
	await writeFile(layout.settings, JSON.stringify({ security: options.document ?? { profile: options.profile ?? "workspace-write" } }));
	const prompts: Array<{ readonly prompt: PermissionPrompt; readonly signal: AbortSignal | undefined; readonly resolve: (response: PermissionPromptResponse) => void }> = [];
	const records: PermissionUpdateRecord[] = [];
	const audit = { requested: vi.fn(async () => undefined), decided: vi.fn(async () => undefined), revoked: vi.fn(async () => undefined), superseded: vi.fn(async () => undefined) };
	const shellExec = vi.fn(async () => ({ stdout: "executed", stderr: "", exitCode: 0 }));
	const networkRequest = vi.fn(async (request: { url: string }) => ({ status: 200, headers: {}, body: Buffer.from("ok"), finalUrl: request.url }));
	const securityOptions: SessionSecurityCompositionOptions = {
		layout, cwd,
		workspaceId: createRuntimeId("workspace", "active-permissions"),
		repositoryId: createRuntimeId("repository", "active-permissions"),
		fence: { sessionId: createRuntimeId("session", "active-permissions"), runtimeId: createRuntimeId("runtime", "active-permissions"), generation: 1 },
		// 仅使用既有 backend 的确定性 plan/probe；fixture 不执行 bwrap 或真实命令。
		sandboxBackend: new LinuxBwrapBackend({ which: async () => "/fixture/bwrap" }),
		securitySources: [{ source: "cli", read: async () => ({ status: "available", text: JSON.stringify({ sandbox: "off" }) }) }],
		unrestrictedShell: { exec: shellExec }, networkBroker: { request: networkRequest },
		approvalPorts: {
			stateStore: new MemoryApprovalStateStore(), audit,
			prompter: { request: (prompt, signal) => new Promise((resolve) => { prompts.push({ prompt, signal, resolve }); }) },
		},
	};
	const security = await createSessionSecurity(securityOptions);
	const settings = new SecuritySettingsPort({ layout, workspaceKey: security.workspaceStorageKey, workspaceRoot: cwd, tempRoot: layout.tmp });
	const update = vi.fn(settings.update.bind(settings));
	const settingsPort = { inspect: settings.inspect.bind(settings), update };
	const append = vi.fn((record: PermissionUpdateRecord) => { records.push(record); });
	const journal = { records: () => records, append };
	const updater = createSessionPermissionUpdater({ generation: 1, security, settings: settingsPort, journal });
	const domain = createSecuritySettingsResourceDomain({ generation: 1, settings: settingsPort, permissionUpdater: updater });
	let sequence = 0;
	async function request(profile: BuiltinPermissionPresetId) {
		const before = await settings.inspect({ scope: "user" });
		if (!before.ok) throw new Error(before.error.code);
		const id = `apply-${++sequence}`;
		return {
			payload: { scope: "user", expectedSourceDigest: before.value.sourceDigest, expectedSecurityRevision: security.snapshot.securityRevision!, document: applySystemPermissionPreset(before.value.document, profile) },
			context: { expectedRevision: 1, correlationId: id, effectId: id },
		};
	}
	return {
		root, cwd, layout, security, securityOptions, settings, settingsPort, update, prompts, records, journal, append, domain, updater, audit, shellExec, networkRequest, request,
		apply: async (profile: BuiltinPermissionPresetId) => { const input = await request(profile); return domain.mutate!("session.security.apply", input.payload, input.context); },
		allow: (index: number, decision: "allow-once" | "allow-session" | "deny" | "cancel" = "allow-once") => prompts[index]!.resolve({ decision, decidedBy: createRuntimeId("principal", "permission-test") }),
		close: async () => {
			await security.close();
			for (const entry of prompts) entry.resolve({ decision: "cancel", decidedBy: createRuntimeId("principal", "permission-test") });
			rmSyncRetry(root);
		},
	};
}
