import { standardHarnessProfileRef } from "../../../src/runtime/harness-profiles/index.ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as sessionDomain from "../../../src/runtime/session-runtime/domain.ts";
import { buildRunledgerLayout } from "../../../src/runtime/contracts/storage-layout.ts";
import { createRuntimeId, type WorkspaceId } from "../../../src/runtime/protocol/ids.ts";
import type { OwnerFence } from "../../../src/runtime/session-owner/types.ts";
import { createSessionSecurity, type SessionSecurityConfigSource } from "../../../src/security/session-composition.ts";
import type { SessionProcessDomainPort } from "../../../src/runtime/session-runtime/session-runtime.ts";
import { IS_WINDOWS } from "../../helpers/platform.ts";
import type { AttemptPort } from "../../../src/runtime/session-runtime/attempt-gateway.ts";
import type { TraceRecorderFactory } from "../../../src/runtime/trace/composition.ts";
import { createBashTool } from "../../../src/runtime/tools/bash.ts";
import { openSessionDatabase, type SessionDatabase } from "../../../src/storage/session-store/database.ts";
import { installSessionStoreSchema } from "../../../src/storage/session-store/schema.ts";
import { SessionStore } from "../../../src/storage/session-store/session-store.ts";
import { createGovernedLspSpawner } from "../../../src/runtime/session-runtime/lsp-composition.ts";

import { MemoryApprovalStateStore } from "../../../src/security/permission/approval-coordinator.ts";
import type { PermissionPromptResponse } from "../../../src/security/types.ts";

let root: string;
const stores = new Map<string, { readonly db: SessionDatabase; readonly store: SessionStore }>();

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "runledger-session-process-"));
});

afterEach(async () => {
	for (const value of stores.values()) value.db.close();
	stores.clear();
	await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
});

function ownedStore(layout: ReturnType<typeof buildRunledgerLayout>, fence: OwnerFence, workspaceId: WorkspaceId): SessionStore {
	let value = stores.get(layout.database);
	if (value === undefined) {
		const db = openSessionDatabase(layout.database);
		installSessionStoreSchema(db);
		value = { db, store: new SessionStore(db) };
		stores.set(layout.database, value);
	}
	if (value.store.getSession(fence.sessionId) === undefined) {
		value.store.createSession({
			sessionId: fence.sessionId,
			workspaceId,
			repositoryId: createRuntimeId("repository", `process-${fence.sessionId.slice(-24)}`),
			harnessProfile: standardHarnessProfileRef(),
			settingsDigest: "d".repeat(64),
		});
	}
	value.db.runSync(
		`INSERT INTO session_owners (session_id, runtime_id, generation, state, updated_at_ms)
		 VALUES (?, ?, ?, 'running', 1)
		 ON CONFLICT(session_id) DO UPDATE SET runtime_id = excluded.runtime_id, generation = excluded.generation, state = 'running'`,
		[fence.sessionId, fence.runtimeId, fence.generation],
	);
	return value.store;
}

function securitySource(): SessionSecurityConfigSource {
	return {
		source: "cli",
		read: async () => ({
			status: "available",
			text: JSON.stringify({ profile: "danger-full-access", approvalPolicy: "never", sandbox: "off" }),
		}),
	};
}

describe("S4 Session managed process composition", () => {
	it.each(["exec", "start"] as const)("cancels approval before %s can spawn a process", async (method) => {
		const layout = buildRunledgerLayout(join(root, "home"), "posix");
		await mkdir(layout.home, { recursive: true });
		const fence: OwnerFence = { sessionId: createRuntimeId("session", "approval-abort"), runtimeId: createRuntimeId("runtime", "approval-abort"), generation: 1 };
		const workspaceId = createRuntimeId("workspace", "approval-abort");
		let cancelPrompt: (() => void) | undefined;
		let promptSignal: AbortSignal | undefined;
		const security = await createSessionSecurity({
			layout, cwd: root, fence, workspaceId, repositoryId: createRuntimeId("repository", "approval-abort"),
			securitySources: [{ source: "cli", read: async () => ({ status: "available", text: JSON.stringify({ profile: "workspace-write", approvalPolicy: "on-request", sandbox: "off" }) }) }],
			approvalPorts: {
				stateStore: new MemoryApprovalStateStore(),
				audit: { requested: async () => undefined, decided: async () => undefined, revoked: async () => undefined },
				prompter: { request: async (_prompt, signal) => {
					promptSignal = signal;
					return new Promise<PermissionPromptResponse>((resolve) => {
						cancelPrompt = () => resolve({ decision: "cancel", decidedBy: createRuntimeId("principal", "fixture") });
						signal?.addEventListener("abort", cancelPrompt, { once: true });
					});
				} },
			},
		});
		const process = sessionDomain.createSessionProcessComposition({ layout, store: ownedStore(layout, fence, workspaceId), cwd: root, fence, workspaceId, security: security.managedProcess });
		const abort = new AbortController();
		const run = process.toolClient()[method]({ command: "printf forbidden > never-created", cwd: root, timeoutMs: 5_000, signal: abort.signal })
			.then((result) => result, (error: unknown) => error);
		try {
			await vi.waitFor(() => expect(cancelPrompt).toBeTypeOf("function"));
			abort.abort();
			await vi.waitFor(() => expect(promptSignal?.aborted).toBe(true), { timeout: 500 });
			const result = await run;
			if (method === "start") expect(result).toMatchObject({ ok: false, code: "approval_cancelled" });
			else expect(result).toMatchObject({ code: "approval_cancelled", message: expect.stringContaining("command was not run") });
			expect(existsSync(join(root, "never-created"))).toBe(false);
			const listed = await process.query("session.process.list", {}, { correlationId: "list", effectId: "list" });
			expect(listed).toMatchObject({ ok: true, value: { items: [] } });
		} finally {
			cancelPrompt?.();
			await run;
			await process.shutdown("paused");
			await security.close();
		}
	});

	it("preserves protocol stdout and sanitized stderr through the Session security and process composition", { skip: IS_WINDOWS }, async () => {
		const layout = buildRunledgerLayout(join(root, "home"), "posix");
		await mkdir(layout.home, { recursive: true });
		const fence: OwnerFence = { sessionId: createRuntimeId("session", "protocol-streams"), runtimeId: createRuntimeId("runtime", "protocol-streams"), generation: 1 };
		const workspaceId = createRuntimeId("workspace", "protocol-streams");
		const security = await createSessionSecurity({ layout, cwd: root, fence, workspaceId, repositoryId: createRuntimeId("repository", "protocol-streams"), securitySources: [securitySource()] });
		const composition = sessionDomain.createSessionProcessComposition({ layout, store: ownedStore(layout, fence, workspaceId), cwd: root, fence, workspaceId, security: security.managedProcess });
		try {
			const transport = await createGovernedLspSpawner(composition.toolClient()).spawn(globalThis.process.execPath, ["-e", "process.stderr.write('session config failed password=private-value\\n');process.stdout.write('Content-Length: 2\\r\\n\\r\\n{}');process.exitCode=7"], root);
			const stdout = new Response(transport.stdout).text();
			expect(await transport.exited).toBe(7);
			expect(await stdout).toBe("Content-Length: 2\r\n\r\n{}");
			expect(transport.peekStderr()).toContain("session config failed password=[REDACTED]");
			expect(transport.peekStderr()).not.toContain("private-value");
		} finally {
			await composition.shutdown("detached");
		}
	});

	it("preserves a typed approval expiry through foreground Bash", async () => {
		const layout = buildRunledgerLayout(join(root, "home"), "posix");
		await mkdir(layout.home, { recursive: true });
		const fence: OwnerFence = {
			sessionId: createRuntimeId("session", "process-foreground-approval-expired"),
			runtimeId: createRuntimeId("runtime", "process-foreground-approval-expired"),
			generation: 1,
		};
		const workspaceId = createRuntimeId("workspace", "process-foreground-approval-expired");
		const process = sessionDomain.createSessionProcessComposition({
			layout,
			store: ownedStore(layout, fence, workspaceId),
			cwd: root,
			fence,
			workspaceId,
			security: {
				prepare: async () => ({
					ok: false,
					error: { code: "approval_expired", message: "approval expired", retryable: false },
				}),
			},
		});
		const bash = createBashTool(root, { managedProcess: process.toolClient() });

		const result = await bash.execute("toolCall_session_foreground_expired", {
			command: "printf never",
			timeout: 5_000,
		});

		expect(result).toMatchObject({ isError: true, details: { errorCode: "approval_expired" } });
	});

	it("executes foreground Bash through the Session-owned process facade", async () => {
		const layout = buildRunledgerLayout(join(root, "home"), "posix");
		await mkdir(layout.home, { recursive: true });
		const fence: OwnerFence = {
			sessionId: createRuntimeId("session", "process-foreground"),
			runtimeId: createRuntimeId("runtime", "process-foreground"),
			generation: 1,
		};
		const workspaceId = createRuntimeId("workspace", "process-foreground");
		const security = await createSessionSecurity({
			layout,
			cwd: root,
			fence,
			workspaceId,
			repositoryId: createRuntimeId("repository", "process-foreground"),
			securitySources: [securitySource()],
		});
		const process = sessionDomain.createSessionProcessComposition({
			layout,
			store: ownedStore(layout, fence, workspaceId),
			cwd: root,
			fence,
			workspaceId,
			security: security.managedProcess,
		});
		const bash = createBashTool(root, { managedProcess: process.toolClient() });
		const result = await bash.execute("toolCall_session_foreground", {
			command: "node -e \"process.stdin.setEncoding('utf8');let value='';process.stdin.on('data',chunk=>value+=chunk);process.stdin.on('end',()=>process.stdout.write('session-foreground:'+value.trim()+'\\\\n'))\"",
			stdin: "input-ok\\n",
			timeout: 5_000,
		});

		expect(result.isError, JSON.stringify(result)).not.toBe(true);
		expect(result.details).toMatchObject({ exitCode: 0 });
		expect(result.content).toEqual([{ type: "text", text: expect.stringContaining("session-foreground:input-ok") }]);
		expect(JSON.stringify(result)).not.toContain("foreground process facade unavailable");
	});

	it("settles a foreground Bash timeout through the Session-owned process facade", async () => {
		const layout = buildRunledgerLayout(join(root, "home"), "posix");
		await mkdir(layout.home, { recursive: true });
		const fence: OwnerFence = {
			sessionId: createRuntimeId("session", "process-foreground-timeout"),
			runtimeId: createRuntimeId("runtime", "process-foreground-timeout"),
			generation: 1,
		};
		const workspaceId = createRuntimeId("workspace", "process-foreground-timeout");
		const security = await createSessionSecurity({
			layout,
			cwd: root,
			fence,
			workspaceId,
			repositoryId: createRuntimeId("repository", "process-foreground-timeout"),
			securitySources: [securitySource()],
		});
		const process = sessionDomain.createSessionProcessComposition({
			layout,
			store: ownedStore(layout, fence, workspaceId),
			cwd: root,
			fence,
			workspaceId,
			security: security.managedProcess,
		});
		const result = await process.toolClient().exec({
			command: "node -e \"setTimeout(() => {}, 10000)\"",
			cwd: root,
			timeoutMs: 60,
			maxOutputChars: 1_024,
		});

		expect(result).toMatchObject({ signaled: true });
		expect(result.exitCode).not.toBe(0);
	});

	it("runs a real pipe and exposes bounded output through the Session process domain", async () => {
		const layout = buildRunledgerLayout(join(root, "home"), "posix");
		await mkdir(layout.home, { recursive: true });
		const fence: OwnerFence = {
			sessionId: createRuntimeId("session", "process-pipe"),
			runtimeId: createRuntimeId("runtime", "process-pipe"),
			generation: 4,
		};
		const workspaceId = createRuntimeId("workspace", "process-pipe");
		const security = await createSessionSecurity({
			layout,
			cwd: root,
			fence,
			workspaceId,
			repositoryId: createRuntimeId("repository", "process-pipe"),
			securitySources: [securitySource()],
		});
		const factory = (sessionDomain as typeof sessionDomain & {
			createSessionProcessComposition?: (input: Record<string, unknown>) => SessionProcessDomainPort;
		}).createSessionProcessComposition;
		expect(factory).toBeTypeOf("function");
		if (factory === undefined) return;
		const process = factory({
			layout,
			store: ownedStore(layout, fence, workspaceId),
			cwd: root,
			fence,
			workspaceId,
			repositoryId: createRuntimeId("repository", "process-pipe"),
			security: security.managedProcess,
		});

		const started = await process.mutate("session.process.start", {
			command: "printf 'session-managed-output\\n'",
			cwd: root,
			timeoutMs: 5_000,
			backend: "pipe",
			executionMode: "background",
		}, {
			correlationId: "correlation_process_pipe",
			effectId: "effect_process_pipe",
			expectedRevision: 0,
		});
		expect(started, JSON.stringify(started)).toMatchObject({ ok: true, status: "ok", operation: "session.process.start" });
		if (!started.ok) return;
		const executionId = String(started.value.executionId);

		let outputText = "";
		for (let attempt = 0; attempt < 100 && !outputText.includes("session-managed-output"); attempt += 1) {
			const output = await process.query("session.process.output", {
				executionId,
				cursor: { sequence: 0, byteOffset: 0 },
				maxBytes: 1_024,
			}, { correlationId: `correlation_output_${attempt}`, effectId: `effect_output_${attempt}` });
			if (output.ok) outputText = String(output.value.text ?? "");
			if (!outputText.includes("session-managed-output")) await new Promise((resolve) => setTimeout(resolve, 10));
		}
		expect(outputText).toContain("session-managed-output");
	});

	it("replays only the Security-authorized command display receipt after cold restart", async () => {
		const layout = buildRunledgerLayout(join(root, "home"), "posix");
		await mkdir(layout.home, { recursive: true });
		const fence: OwnerFence = {
			sessionId: createRuntimeId("session", "process-command-display"),
			runtimeId: createRuntimeId("runtime", "process-command-display"),
			generation: 1,
		};
		const workspaceId = createRuntimeId("workspace", "process-command-display");
		const security = await createSessionSecurity({
			layout,
			cwd: root,
			fence,
			workspaceId,
			repositoryId: createRuntimeId("repository", "process-command-display"),
			securitySources: [securitySource()],
		});
		const store = ownedStore(layout, fence, workspaceId);
		const first = sessionDomain.createSessionProcessComposition({ layout, store, cwd: root, fence, workspaceId, security: security.managedProcess });
		const started = await first.mutate("session.process.start", {
			command: "API_TOKEN=supersecret printf 'display-authority\\n'",
			cwd: root,
			timeoutMs: 5_000,
			backend: "pipe",
			executionMode: "background",
		}, { correlationId: "correlation_command_display", effectId: "effect_command_display", expectedRevision: 0 });
		expect(started).toMatchObject({
			ok: true,
			value: {
				commandDisplay: {
					authority: "spawned",
					label: "API_TOKEN=[redacted] printf 'display-authority\\n'",
					receiptDigest: { algorithm: "sha256", digest: expect.stringMatching(/^[a-f0-9]{64}$/u) },
				},
			},
		});
		expect(JSON.stringify(started)).not.toContain("supersecret");
		await first.shutdown("paused");

		const restarted = sessionDomain.createSessionProcessComposition({ layout, store, cwd: root, fence, workspaceId, security: security.managedProcess });
		const listed = await restarted.query("session.process.list", {}, {
			correlationId: "correlation_command_display_list",
			effectId: "effect_command_display_list",
		});
		expect(listed).toMatchObject({
			ok: true,
			value: { items: [expect.objectContaining({ commandDisplay: expect.objectContaining({ authority: "spawned", label: "API_TOKEN=[redacted] printf 'display-authority\\n'" }) })] },
		});
		expect(JSON.stringify(listed)).not.toContain("supersecret");
		await restarted.shutdown("paused");
	});

	it.skipIf(IS_WINDOWS)("runs a real PTY with resize, stdin, output cursor, and terminal completion", async () => {
		const layout = buildRunledgerLayout(join(root, "home"), "posix");
		await mkdir(layout.home, { recursive: true });
		const fence: OwnerFence = {
			sessionId: createRuntimeId("session", "process-pty"),
			runtimeId: createRuntimeId("runtime", "process-pty"),
			generation: 5,
		};
		const workspaceId = createRuntimeId("workspace", "process-pty");
		const security = await createSessionSecurity({
			layout,
			cwd: root,
			fence,
			workspaceId,
			repositoryId: createRuntimeId("repository", "process-pty"),
			securitySources: [securitySource()],
		});
		const process = sessionDomain.createSessionProcessComposition({
			layout,
			store: ownedStore(layout, fence, workspaceId),
			cwd: root,
			fence,
			workspaceId,
			security: security.managedProcess,
		});
		const started = await process.mutate("session.process.start", {
			command: "node -e \"process.stdin.setEncoding('utf8');process.stdin.once('data',d=>{process.stdout.write('pty:'+d);process.exit(0)})\"",
			cwd: root,
			timeoutMs: 5_000,
			backend: "pty",
			executionMode: "background",
		}, {
			correlationId: "correlation_process_pty",
			effectId: "effect_process_pty",
			expectedRevision: 0,
		});
		expect(started, JSON.stringify(started)).toMatchObject({ ok: true, status: "ok" });
		if (!started.ok) return;
		const executionId = String(started.value.executionId);
		const revision = started.domainRevision;

		const resized = await process.mutate("session.process.resize", { executionId, columns: 100, rows: 30 }, {
			correlationId: "correlation_process_resize",
			effectId: "effect_process_resize",
			expectedRevision: revision,
		});
		expect(resized).toMatchObject({ ok: true, status: "ok" });
		if (!resized.ok) return;
		await expect(process.mutate("session.process.stdin", { executionId, input: "hello-pty\n" }, {
			correlationId: "correlation_process_stdin",
			effectId: "effect_process_stdin",
			expectedRevision: resized.domainRevision,
		})).resolves.toMatchObject({ ok: true, status: "ok" });
		await expect(process.query("session.process.wait", { executionId, timeoutMs: 5_000 }, {
			correlationId: "correlation_process_wait",
			effectId: "effect_process_wait",
		})).resolves.toMatchObject({ ok: true, status: "ok", value: { outcome: "terminal" } });
		const output = await process.query("session.process.output", {
			executionId,
			cursor: { sequence: 0, byteOffset: 0 },
			maxBytes: 4_096,
		}, { correlationId: "correlation_process_pty_output", effectId: "effect_process_pty_output" });
		expect(output).toMatchObject({ ok: true, value: { text: expect.stringContaining("pty:hello-pty") } });
	});

	it("isolates process capacity between SessionRuntime compositions", async () => {
		const layout = buildRunledgerLayout(join(root, "home"), "posix");
		await mkdir(layout.home, { recursive: true });
		const create = async (seed: string) => {
			const fence: OwnerFence = {
				sessionId: createRuntimeId("session", seed),
				runtimeId: createRuntimeId("runtime", seed),
				generation: 1,
			};
			const workspaceId = createRuntimeId("workspace", seed);
			const security = await createSessionSecurity({
				layout,
				cwd: root,
				fence,
				workspaceId,
				repositoryId: createRuntimeId("repository", seed),
				securitySources: [securitySource()],
			});
			return sessionDomain.createSessionProcessComposition({
				layout,
				store: ownedStore(layout, fence, workspaceId),
				cwd: root,
				fence,
				workspaceId,
				security: security.managedProcess,
				maxProcessesPerSession: 1,
			} as Parameters<typeof sessionDomain.createSessionProcessComposition>[0]);
		};
		const first = await create("capacity-a");
		const second = await create("capacity-b");
		const start = (process: typeof first, seed: string, expectedRevision: number) => process.mutate("session.process.start", {
			command: "node -e \"setTimeout(()=>{},30000)\"",
			cwd: root,
			timeoutMs: 30_000,
			backend: "pipe",
			executionMode: "background",
		}, {
			correlationId: `correlation_${seed}`,
			effectId: `effect_${seed}`,
			expectedRevision,
		});
		const firstStarted = await start(first, "capacity_a_1", 0);
		expect(firstStarted).toMatchObject({ ok: true });
		if (!firstStarted.ok) return;
		const firstRejected = await start(first, "capacity_a_2", firstStarted.domainRevision);
		expect(firstRejected).toMatchObject({ ok: false, code: "session_process_capacity_exceeded" });
		const secondStarted = await start(second, "capacity_b_1", 0);
		expect(secondStarted).toMatchObject({ ok: true });

		await first.mutate("session.process.stop", { executionId: firstStarted.value.executionId }, {
			correlationId: "correlation_capacity_a_stop",
			effectId: "effect_capacity_a_stop",
			expectedRevision: firstStarted.domainRevision,
		});
		if (secondStarted.ok) {
			await second.mutate("session.process.stop", { executionId: secondStarted.value.executionId }, {
				correlationId: "correlation_capacity_b_stop",
				effectId: "effect_capacity_b_stop",
				expectedRevision: secondStarted.domainRevision,
			});
		}
	});

	it("advances one Session process domain revision across different handles and mutations", async () => {
		const layout = buildRunledgerLayout(join(root, "home"), "posix");
		await mkdir(layout.home, { recursive: true });
		const fence: OwnerFence = {
			sessionId: createRuntimeId("session", "process-domain-revision"),
			runtimeId: createRuntimeId("runtime", "process-domain-revision"),
			generation: 1,
		};
		const workspaceId = createRuntimeId("workspace", "process-domain-revision");
		const security = await createSessionSecurity({
			layout,
			cwd: root,
			fence,
			workspaceId,
			repositoryId: createRuntimeId("repository", "process-domain-revision"),
			securitySources: [securitySource()],
		});
		const store = ownedStore(layout, fence, workspaceId);
		const process = sessionDomain.createSessionProcessComposition({ layout, store, cwd: root, fence, workspaceId, security: security.managedProcess });
		const start = (seed: string, expectedRevision: number) => process.mutate("session.process.start", {
			command: "node -e \"setTimeout(()=>{},30000)\"",
			cwd: root,
			timeoutMs: 30_000,
			backend: "pipe",
			executionMode: "background",
		}, { correlationId: `correlation_${seed}`, effectId: `effect_${seed}`, expectedRevision });

		const first = await start("domain_revision_first", 0);
		expect(first).toMatchObject({ ok: true });
		if (!first.ok) return;
		const second = await start("domain_revision_second", first.domainRevision);
		expect(second).toMatchObject({ ok: true });
		if (!second.ok) return;
		expect(second.domainRevision).toBeGreaterThan(first.domainRevision);
		const stopped = await process.mutate("session.process.stop", { executionId: first.value.executionId }, {
			correlationId: "correlation_domain_revision_stop",
			effectId: "effect_domain_revision_stop",
			expectedRevision: second.domainRevision,
		});
		expect(stopped).toMatchObject({ ok: true });
		if (!stopped.ok) return;
		expect(stopped.domainRevision).toBeGreaterThan(second.domainRevision);
		await process.shutdown("paused");

		const restarted = sessionDomain.createSessionProcessComposition({ layout, store, cwd: root, fence, workspaceId, security: security.managedProcess });
		const restored = await restarted.query("session.process.list", {}, {
			correlationId: "correlation_domain_revision_restored",
			effectId: "effect_domain_revision_restored",
		});
		expect(restored).toMatchObject({ ok: true, domainRevision: stopped.domainRevision });
		await restarted.shutdown("paused");
	});

	it("keeps a process_spawn attempt unresolved until automatic terminal settlement", async () => {
		const layout = buildRunledgerLayout(join(root, "home"), "posix");
		await mkdir(layout.home, { recursive: true });
		const fence: OwnerFence = {
			sessionId: createRuntimeId("session", "process-attempt"),
			runtimeId: createRuntimeId("runtime", "process-attempt"),
			generation: 3,
		};
		const workspaceId = createRuntimeId("workspace", "process-attempt");
		const security = await createSessionSecurity({
			layout,
			cwd: root,
			fence,
			workspaceId,
			repositoryId: createRuntimeId("repository", "process-attempt"),
			securitySources: [securitySource()],
		});
		const settlements: string[] = [];
		const attemptPort: AttemptPort = {
			beginAttempt: (effectClass) => {
				expect(effectClass).toBe("process_spawn");
				return {
					attemptId: createRuntimeId("attempt", "session-process-attempt"),
					commandId: createRuntimeId("command", "session-process-attempt"),
				};
			},
			settleAttempt: (_attemptId, outcome) => {
				settlements.push(outcome);
				return { ok: true };
			},
		};
		const process = sessionDomain.createSessionProcessComposition({
			layout,
			store: ownedStore(layout, fence, workspaceId),
			cwd: root,
			fence,
			workspaceId,
			security: security.managedProcess,
			attemptPort: () => attemptPort,
		} as Parameters<typeof sessionDomain.createSessionProcessComposition>[0]);
		const started = await process.mutate("session.process.start", {
			command: "printf 'attempt-settled\\n'",
			cwd: root,
			timeoutMs: 5_000,
			backend: "pipe",
			executionMode: "background",
		}, { correlationId: "correlation_attempt", effectId: "effect_attempt", expectedRevision: 0 });
		expect(started).toMatchObject({ ok: true });
		if (!started.ok) return;
		for (let poll = 0; poll < 100 && settlements.length === 0; poll += 1) {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		expect(settlements).toEqual(["committed"]);
	});

	it("materializes terminal process output into the Session-bound Trace recorder", async () => {
		const layout = buildRunledgerLayout(join(root, "home"), "posix");
		await mkdir(layout.home, { recursive: true });
		const fence: OwnerFence = {
			sessionId: createRuntimeId("session", "process-trace"),
			runtimeId: createRuntimeId("runtime", "process-trace"),
			generation: 6,
		};
		const workspaceId = createRuntimeId("workspace", "process-trace");
		const security = await createSessionSecurity({
			layout,
			cwd: root,
			fence,
			workspaceId,
			repositoryId: createRuntimeId("repository", "process-trace"),
			securitySources: [securitySource()],
		});
		const recorded: Record<string, unknown>[] = [];
		const lifecycle: string[] = [];
		const factory: TraceRecorderFactory = {
			create: async (input) => ({
				traceId: input.traceId ?? createRuntimeId("trace", "process-trace"),
				recordManagedProcessOutput: async (value: Record<string, unknown>) => {
					recorded.push(value);
					lifecycle.push("output");
				},
				finishRun: async (value: { readonly phase: string }) => { lifecycle.push(`terminal:${value.phase}`); },
			} as never),
		};
		const process = sessionDomain.createSessionProcessComposition({
			layout,
			store: ownedStore(layout, fence, workspaceId),
			cwd: root,
			fence,
			workspaceId,
			security: security.managedProcess,
			recordingMode: "events",
			recordingFailurePolicy: "fail_closed",
			traceRecorderFactory: factory,
		} as Parameters<typeof sessionDomain.createSessionProcessComposition>[0]);
		const started = await process.mutate("session.process.start", {
			command: "printf 'trace-process-output\\n'",
			cwd: root,
			timeoutMs: 5_000,
			backend: "pipe",
			executionMode: "background",
		}, { correlationId: "correlation_trace", effectId: "effect_trace", expectedRevision: 0 });
		expect(started).toMatchObject({ ok: true });
		for (let poll = 0; poll < 100 && lifecycle.length < 2; poll += 1) {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		expect(recorded).toEqual([
			expect.objectContaining({
				mode: "events",
				outputContent: expect.objectContaining({ storage: "digest_only", size: expect.any(Number) }),
			}),
		]);
		expect(lifecycle).toEqual(["output", "terminal:finished"]);
	});

	it("marks a failed managed process trace as failed with certain outcome", async () => {
		const layout = buildRunledgerLayout(join(root, "home"), "posix");
		await mkdir(layout.home, { recursive: true });
		const fence: OwnerFence = {
			sessionId: createRuntimeId("session", "process-trace-failed"),
			runtimeId: createRuntimeId("runtime", "process-trace-failed"),
			generation: 1,
		};
		const workspaceId = createRuntimeId("workspace", "process-trace-failed");
		const security = await createSessionSecurity({
			layout,
			cwd: root,
			fence,
			workspaceId,
			repositoryId: createRuntimeId("repository", "process-trace-failed"),
			securitySources: [securitySource()],
		});
		const terminals: unknown[] = [];
		const process = sessionDomain.createSessionProcessComposition({
			layout,
			store: ownedStore(layout, fence, workspaceId),
			cwd: root,
			fence,
			workspaceId,
			security: security.managedProcess,
			recordingMode: "events",
			recordingFailurePolicy: "fail_closed",
			traceRecorderFactory: {
				create: async () => ({
					traceId: createRuntimeId("trace", "process-trace-failed"),
					recordManagedProcessOutput: async () => undefined,
					finishRun: async (value: unknown) => { terminals.push(value); },
				} as never),
			},
		});
		const started = await process.mutate("session.process.start", {
			command: "node -e \"process.exit(7)\"",
			cwd: root,
			timeoutMs: 5_000,
			backend: "pipe",
			executionMode: "background",
		}, { correlationId: "correlation_trace_failed", effectId: "effect_trace_failed", expectedRevision: 0 });
		expect(started).toMatchObject({ ok: true });
		if (!started.ok) return;
		await expect(process.query("session.process.wait", {
			executionId: started.value.executionId,
			timeoutMs: 5_000,
		}, { correlationId: "correlation_trace_failed_wait", effectId: "effect_trace_failed_wait" })).resolves.toMatchObject({
			ok: true,
			value: { outcome: "terminal", summary: { state: "failed" } },
		});
		expect(terminals).toEqual([{
			phase: "failed",
			error: { code: "process_failed", message: "managed process failed", outcomeCertain: true },
		}]);
	});

	it("uses the owner-fenced Session Event Store as process truth without Host fields", async () => {
		const layout = buildRunledgerLayout(join(root, "home"), "posix");
		await mkdir(layout.home, { recursive: true });
		const db = openSessionDatabase(layout.database);
		installSessionStoreSchema(db);
		const store = new SessionStore(db);
		const fence: OwnerFence = {
			sessionId: createRuntimeId("session", "process-event-store"),
			runtimeId: createRuntimeId("runtime", "process-event-store"),
			generation: 2,
		};
		const workspaceId = createRuntimeId("workspace", "process-event-store");
		store.createSession({
			sessionId: fence.sessionId,
			workspaceId,
			repositoryId: createRuntimeId("repository", "process-event-store"),
			harnessProfile: standardHarnessProfileRef(),
			settingsDigest: "d".repeat(64),
		});
		store.database().runSync(
			"INSERT INTO session_owners (session_id, runtime_id, generation, state, updated_at_ms) VALUES (?, ?, ?, 'running', 1)",
			[fence.sessionId, fence.runtimeId, fence.generation],
		);
		const security = await createSessionSecurity({
			layout,
			cwd: root,
			fence,
			workspaceId,
			repositoryId: createRuntimeId("repository", "process-event-store"),
			securitySources: [securitySource()],
		});
		const process = sessionDomain.createSessionProcessComposition({
			layout,
			cwd: root,
			fence,
			workspaceId,
			store,
			security: security.managedProcess,
		} as Parameters<typeof sessionDomain.createSessionProcessComposition>[0]);
		try {
			const started = await process.mutate("session.process.start", {
				command: "node -e \"setTimeout(()=>{},30000)\"",
				cwd: root,
				timeoutMs: 30_000,
				backend: "pipe",
				executionMode: "background",
			}, { correlationId: "correlation_event_store", effectId: "effect_event_store", expectedRevision: 0 });
			expect(started).toMatchObject({ ok: true });
			await process.shutdown("paused");
			const events = store.replaySessionEvents(fence.sessionId).filter((event) => event.eventType.startsWith("process."));
			expect(events.length).toBeGreaterThan(0);
			expect(events).toContainEqual(expect.objectContaining({
				eventType: "process.domain_revision_committed",
				payloadJson: expect.stringContaining('"revision":1'),
			}));
			for (const event of events) {
				expect(event.ownerGeneration).toBe(fence.generation);
				expect(event.payloadJson).not.toContain("hostGeneration");
				expect(event.payloadJson).not.toContain("authorityId");
				expect(event.payloadJson).not.toContain("tenantId");
				expect(event.payloadJson).not.toContain("workspaceId");
			}
		} finally {
			await process.shutdown("paused");
			db.close();
		}
	});

	it("reports recovery_required and preserves the spawn attempt when revision durability is uncertain", async () => {
		const layout = buildRunledgerLayout(join(root, "home"), "posix");
		await mkdir(layout.home, { recursive: true });
		const fence: OwnerFence = {
			sessionId: createRuntimeId("session", "process-revision-uncertain"),
			runtimeId: createRuntimeId("runtime", "process-revision-uncertain"),
			generation: 1,
		};
		const workspaceId = createRuntimeId("workspace", "process-revision-uncertain");
		const store = ownedStore(layout, fence, workspaceId);
		const appendEvent = store.appendEvent.bind(store);
		vi.spyOn(store, "appendEvent").mockImplementation((ownerFence, input) => {
			if (input.eventType === "process.domain_revision_committed") throw new Error("revision store unavailable");
			return appendEvent(ownerFence, input);
		});
		const security = await createSessionSecurity({
			layout,
			cwd: root,
			fence,
			workspaceId,
			repositoryId: createRuntimeId("repository", "process-revision-uncertain"),
			securitySources: [securitySource()],
		});
		const settlements: string[] = [];
		const attemptPort: AttemptPort = {
			beginAttempt: () => ({
				attemptId: createRuntimeId("attempt", "process-revision-uncertain"),
				commandId: createRuntimeId("command", "process-revision-uncertain"),
			}),
			settleAttempt: (_attemptId, outcome) => {
				settlements.push(outcome);
				return { ok: true };
			},
		};
		const process = sessionDomain.createSessionProcessComposition({
			layout,
			store,
			cwd: root,
			fence,
			workspaceId,
			security: security.managedProcess,
			attemptPort: () => attemptPort,
		} as Parameters<typeof sessionDomain.createSessionProcessComposition>[0]);
		const started = await process.mutate("session.process.start", {
			command: "node -e \"setTimeout(()=>{},30000)\"",
			cwd: root,
			timeoutMs: 30_000,
			backend: "pipe",
			executionMode: "background",
		}, {
			correlationId: "correlation_revision_uncertain",
			effectId: "effect_revision_uncertain",
			expectedRevision: 0,
		});
		expect(started).toMatchObject({
			ok: false,
			status: "recovery_required",
			code: "process_domain_revision_commit_uncertain",
		});
		expect(settlements).toEqual([]);
		vi.restoreAllMocks();
		await process.shutdown("paused");
	});

	it("marks an unattached prior-generation process uncertain without reattaching or respawning", async () => {
		const layout = buildRunledgerLayout(join(root, "home"), "posix");
		await mkdir(layout.home, { recursive: true });
		const sessionId = createRuntimeId("session", "process-takeover");
		const workspaceId = createRuntimeId("workspace", "process-takeover");
		const traceEvents: Array<{ readonly traceId: string; readonly event: string; readonly value?: unknown }> = [];
		const traceRecorderFactory: TraceRecorderFactory = {
			create: async (input) => ({
				traceId: input.traceId ?? createRuntimeId("trace", "process-takeover"),
				recordManagedProcessOutput: async () => {
					traceEvents.push({ traceId: String(input.traceId), event: "output" });
				},
				finishRun: async (value: unknown) => {
					traceEvents.push({ traceId: String(input.traceId), event: "terminal", value });
				},
			} as never),
		};
		const create = async (generation: number) => {
			const fence: OwnerFence = { sessionId, runtimeId: createRuntimeId("runtime", `process-takeover-${generation}`), generation };
			const security = await createSessionSecurity({
				layout,
				cwd: root,
				fence,
				workspaceId,
				repositoryId: createRuntimeId("repository", "process-takeover"),
				securitySources: [securitySource()],
			});
			return sessionDomain.createSessionProcessComposition({
				layout,
				store: ownedStore(layout, fence, workspaceId),
				cwd: root,
				fence,
				workspaceId,
				security: security.managedProcess,
				recordingMode: "events",
				recordingFailurePolicy: "fail_closed",
				traceRecorderFactory,
			});
		};
		const first = await create(1);
		const started = await first.mutate("session.process.start", {
			command: "node -e \"process.stdout.write('takeover-output\\nfixture-pid:'+process.pid+'\\n');setTimeout(()=>{},30000)\"",
			cwd: root,
			timeoutMs: 30_000,
			backend: "pipe",
			executionMode: "background",
		}, {
			correlationId: "correlation_process_takeover",
			effectId: "effect_process_takeover",
			expectedRevision: 0,
		});
		expect(started).toMatchObject({ ok: true });
		if (!started.ok) return;
		const second = await create(2);
		const recover = (second as typeof second & { recoverUnattached?: () => Promise<readonly unknown[]> }).recoverUnattached;
		expect(recover).toBeTypeOf("function");
		if (recover === undefined) return;
		await expect(recover.call(second)).resolves.toEqual([
			expect.objectContaining({ ok: true, summary: expect.objectContaining({ state: "uncertain" }) }),
		]);
		expect(traceEvents.map((event) => event.event)).toEqual(["output", "terminal"]);
		expect(traceEvents[1]?.value).toEqual({
			phase: "interrupted",
			error: {
				code: "process_uncertain",
				message: "managed process outcome is uncertain",
				outcomeCertain: false,
			},
		});
		expect(new Set(traceEvents.map((event) => event.traceId)).size).toBe(1);
		const list = await second.query("session.process.list", {}, {
			correlationId: "correlation_process_takeover_list",
			effectId: "effect_process_takeover_list",
		});
		expect(list).toMatchObject({ ok: true, value: { items: [expect.objectContaining({ state: "uncertain" })] } });
		let recoveredOutput = "";
		for (let attempt = 0; attempt < 100 && !recoveredOutput.includes("takeover-output"); attempt += 1) {
			const output = await second.query("session.process.output", {
				executionId: started.value.executionId,
				cursor: { sequence: 0, byteOffset: 0 },
				maxBytes: 4_096,
			}, { correlationId: `correlation_takeover_output_${attempt}`, effectId: `effect_takeover_output_${attempt}` });
			if (output.ok) recoveredOutput = String(output.value.text ?? "");
			if (!recoveredOutput.includes("takeover-output")) await new Promise((resolve) => setTimeout(resolve, 10));
		}
		expect(recoveredOutput).toContain("takeover-output");

		const stoppedByOldOwner = await first.mutate("session.process.stop", { executionId: started.value.executionId }, {
			correlationId: "correlation_process_takeover_stop",
			effectId: "effect_process_takeover_stop",
			expectedRevision: started.domainRevision,
		});
		expect(stoppedByOldOwner.ok).toBe(false);
		// 旧 owner 已失去 authority；测试负责清理自身启动的 fixture，不能假设 stop 生效。
		const fixturePid = Number(/^fixture-pid:(\d+)$/mu.exec(recoveredOutput)?.[1]);
		expect(Number.isSafeInteger(fixturePid) && fixturePid > 0).toBe(true);
		globalThis.process.kill(fixturePid, "SIGTERM");
		let exited = false;
		for (let attempt = 0; attempt < 100 && !exited; attempt += 1) {
			try { globalThis.process.kill(fixturePid, 0); }
			catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
				exited = true;
			}
			if (!exited) await new Promise((resolve) => setTimeout(resolve, 10));
		}
		expect(exited).toBe(true);
	});

	it("settles live processes during last-attachment shutdown", async () => {
		const layout = buildRunledgerLayout(join(root, "home"), "posix");
		await mkdir(layout.home, { recursive: true });
		const fence: OwnerFence = {
			sessionId: createRuntimeId("session", "process-shutdown"),
			runtimeId: createRuntimeId("runtime", "process-shutdown"),
			generation: 1,
		};
		const workspaceId = createRuntimeId("workspace", "process-shutdown");
		const security = await createSessionSecurity({
			layout,
			cwd: root,
			fence,
			workspaceId,
			repositoryId: createRuntimeId("repository", "process-shutdown"),
			securitySources: [securitySource()],
		});
		const terminals: unknown[] = [];
		const process = sessionDomain.createSessionProcessComposition({
			layout,
			store: ownedStore(layout, fence, workspaceId),
			cwd: root,
			fence,
			workspaceId,
			security: security.managedProcess,
			recordingMode: "events",
			recordingFailurePolicy: "fail_closed",
			traceRecorderFactory: {
				create: async () => ({
					traceId: createRuntimeId("trace", "process-shutdown"),
					recordManagedProcessOutput: async () => undefined,
					finishRun: async (value: unknown) => { terminals.push(value); },
				} as never),
			},
		});
		const started = await process.mutate("session.process.start", {
			command: "node -e \"setTimeout(()=>{},30000)\"",
			cwd: root,
			timeoutMs: 30_000,
			backend: "pipe",
			executionMode: "background",
		}, { correlationId: "correlation_shutdown", effectId: "effect_shutdown", expectedRevision: 0 });
		expect(started).toMatchObject({ ok: true });
		if (!started.ok) return;
		const shutdown = (process as typeof process & { shutdown?: (reason: "paused") => Promise<void> }).shutdown;
		expect(shutdown).toBeTypeOf("function");
		if (shutdown === undefined) return;
		await expect(shutdown.call(process, "paused")).resolves.toBeUndefined();
		const list = await process.query("session.process.list", {}, { correlationId: "correlation_shutdown_list", effectId: "effect_shutdown_list" });
		expect(list).toMatchObject({ ok: true, value: { items: [expect.objectContaining({ state: "killed" })] } });
		expect(terminals).toEqual([{
			phase: "interrupted",
			error: { code: "process_killed", message: "managed process was killed", outcomeCertain: true },
		}]);
	});

	it("validates the output cursor before the process lookup", async () => {
		const layout = buildRunledgerLayout(join(root, "home"), "posix");
		await mkdir(layout.home, { recursive: true });
		const fence: OwnerFence = {
			sessionId: createRuntimeId("session", "process-cursor-boundary"),
			runtimeId: createRuntimeId("runtime", "process-cursor-boundary"),
			generation: 1,
		};
		const workspaceId = createRuntimeId("workspace", "process-cursor-boundary");
		const security = await createSessionSecurity({
			layout,
			cwd: root,
			fence,
			workspaceId,
			repositoryId: createRuntimeId("repository", "process-cursor-boundary"),
			securitySources: [securitySource()],
		});
		const process = sessionDomain.createSessionProcessComposition({
			layout,
			store: ownedStore(layout, fence, workspaceId),
			cwd: root,
			fence,
			workspaceId,
			security: security.managedProcess,
		});
		const missingExecutionId = createRuntimeId("execution", "missing");

		// 非法 cursor 必须先于 executionId lookup 被拒绝。
		const invalidCursor = await process.query("session.process.output", {
			executionId: missingExecutionId,
			cursor: { sequence: -1, byteOffset: 0 },
			maxBytes: 1_024,
		}, { correlationId: "correlation_cursor_invalid", effectId: "effect_cursor_invalid" });
		expect(invalidCursor).toMatchObject({ ok: false, status: "failed", code: "invalid_process_output_request" });

		// 合法 cursor + 未知 executionId → unavailable,而不是校验错误。
		const unknownProcess = await process.query("session.process.output", {
			executionId: missingExecutionId,
			cursor: { sequence: 0, byteOffset: 0 },
			maxBytes: 1_024,
		}, { correlationId: "correlation_cursor_unknown", effectId: "effect_cursor_unknown" });
		expect(unknownProcess).toMatchObject({ ok: false, status: "unavailable", code: "process_not_found" });
		await security.close();
	});

	it("rejects a non-start mutation with a stale domain revision without applying it", async () => {
		const layout = buildRunledgerLayout(join(root, "home"), "posix");
		await mkdir(layout.home, { recursive: true });
		const fence: OwnerFence = {
			sessionId: createRuntimeId("session", "process-stale-stop"),
			runtimeId: createRuntimeId("runtime", "process-stale-stop"),
			generation: 1,
		};
		const workspaceId = createRuntimeId("workspace", "process-stale-stop");
		const security = await createSessionSecurity({
			layout,
			cwd: root,
			fence,
			workspaceId,
			repositoryId: createRuntimeId("repository", "process-stale-stop"),
			securitySources: [securitySource()],
		});
		const process = sessionDomain.createSessionProcessComposition({
			layout,
			store: ownedStore(layout, fence, workspaceId),
			cwd: root,
			fence,
			workspaceId,
			security: security.managedProcess,
		});
		const started = await process.mutate("session.process.start", {
			command: "node -e \"setTimeout(()=>{},30000)\"",
			cwd: root,
			timeoutMs: 30_000,
			backend: "pipe",
			executionMode: "background",
		}, {
			correlationId: "correlation_stale_start",
			effectId: "effect_stale_start",
			expectedRevision: 0,
		});
		expect(started, JSON.stringify(started)).toMatchObject({ ok: true, status: "ok" });
		if (!started.ok) return;
		const executionId = String(started.value.executionId);

		const stale = await process.mutate("session.process.stop", { executionId }, {
			correlationId: "correlation_stale_stop",
			effectId: "effect_stale_stop",
			expectedRevision: 999,
		});
		expect(stale).toMatchObject({ ok: false, status: "stale", code: "domain_revision_conflict" });
		expect(stale).toHaveProperty("currentRevision", expect.any(Number));

		// stale stop 未生效:进程仍存在且未到达 terminal。
		const listed = await process.query("session.process.list", {}, { correlationId: "correlation_stale_list", effectId: "effect_stale_list" });
		expect(listed.ok).toBe(true);
		if (!listed.ok || !("items" in listed.value)) throw new Error("process list failed");
		const listedItems = listed.value.items;
		expect(Array.isArray(listedItems)).toBe(true);
		if (!Array.isArray(listedItems) || listedItems.length === 0) throw new Error("expected one live process");
		expect(listedItems[0]?.terminal).toBeUndefined();

		const stopped = await process.mutate("session.process.stop", { executionId }, {
			correlationId: "correlation_fresh_stop",
			effectId: "effect_fresh_stop",
			expectedRevision: 1,
		});
		expect(stopped, JSON.stringify(stopped)).toMatchObject({ ok: true, status: "ok" });
		await security.close();
	});
});
