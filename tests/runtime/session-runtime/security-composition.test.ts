import * as fs from "node:fs/promises";
import { rmSyncRetry, rmRetry } from "../../helpers/cleanup.ts";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildRunledgerLayout } from "../../../src/runtime/contracts/storage-layout.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/ids.ts";
import { runtimeDigest } from "../../../src/runtime/protocol/foundation.ts";
import type { OwnerFence } from "../../../src/runtime/session-owner/types.ts";
import type { FileSystemBrokerPort } from "../../../src/security/policy-filesystem.ts";
import type { NetworkBrokerPort } from "../../../src/security/policy-network.ts";
import { MemoryApprovalStateStore, type ApprovalAuditPort } from "../../../src/security/permission/approval-coordinator.ts";
import type { PermissionPrompter } from "../../../src/security/types.ts";
import { UnavailableSandboxBackend } from "../../../src/security/sandbox/unavailable.ts";
import {
	HostProcessFinalLeafAdapter,
	ProcessFinalLeafAdapter,
} from "../../../src/security/integration/runtime-gateway-adapter.ts";
import {
	GovernedToolAuthorizationPolicy,
	HostGovernedToolAuthorizationPolicy,
} from "../../../src/security/integration/runtime-tool-authorization.ts";
import {
	createSessionSecurity,
	type SessionProcessLeaf,
	type SessionSecurityConfigSource,
} from "../../../src/security/session-composition.ts";

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "runledger-session-security-"));
});

afterEach(() => {
	rmSyncRetry(root);
});

function fence(): OwnerFence {
	return {
		sessionId: createRuntimeId("session", "security"),
		runtimeId: createRuntimeId("runtime", "security"),
		generation: 7,
	};
}

function source(document: Record<string, unknown>): SessionSecurityConfigSource {
	return {
		source: "cli",
		read: async () => ({ status: "available", text: JSON.stringify(document) }),
	};
}

function filesystemBroker(onWrite: () => void): FileSystemBrokerPort {
	return {
		readFile: (path) => fs.readFile(path),
		writeFile: async (path, data) => {
			onWrite();
			await fs.writeFile(path, data);
		},
		stat: async (path) => toStats(await fs.stat(path)),
		lstat: async (path) => toStats(await fs.lstat(path)),
		realpath: (path) => fs.realpath(path),
		readdir: (path) => fs.readdir(path),
		mkdir: async (path, options) => { await fs.mkdir(path, options); },
		rm: async (path, options) => { await fs.rm(path, options); },
		rename: async (from, to) => { await fs.rename(from, to); },
	};
}

function toStats(value: Awaited<ReturnType<typeof fs.stat>>) {
	return {
		size: value.size,
		mtimeMs: value.mtimeMs,
		isFile: value.isFile(),
		isDirectory: value.isDirectory(),
		isSymbolicLink: value.isSymbolicLink(),
	};
}

async function composition(input: {
	readonly document: Record<string, unknown>;
	readonly onWrite?: () => void;
	readonly networkBroker?: NetworkBrokerPort;
	readonly processLeaf?: SessionProcessLeaf;
	readonly approvalPorts?: {
		readonly prompter: PermissionPrompter;
		readonly stateStore: MemoryApprovalStateStore;
		readonly audit: ApprovalAuditPort;
	};
}) {
	const home = join(root, "home");
	await fs.mkdir(home, { recursive: true });
	return createSessionSecurity({
		layout: buildRunledgerLayout(home, "posix"),
		cwd: root,
		fence: fence(),
		workspaceId: createRuntimeId("workspace", "security"),
		repositoryId: createRuntimeId("repository", "security"),
		securitySources: [source(input.document)],
		filesystemBroker: filesystemBroker(input.onWrite ?? (() => undefined)),
		networkBroker: input.networkBroker ?? {
			request: async () => ({ status: 200, headers: {}, body: Buffer.from("ok"), finalUrl: "https://example.com/" }),
		},
		sandboxBackend: new UnavailableSandboxBackend("unknown", "test backend unavailable"),
		...(input.processLeaf === undefined ? {} : { processLeaf: input.processLeaf }),
		...(input.approvalPorts === undefined ? {} : { approvalPorts: input.approvalPorts }),
	});
}

describe("session-scoped Security/ExecutionGateway composition", () => {
	it("exposes session-neutral security names while retaining legacy Host aliases", () => {
		expect(ProcessFinalLeafAdapter).toBe(HostProcessFinalLeafAdapter);
		expect(GovernedToolAuthorizationPolicy).toBe(HostGovernedToolAuthorizationPolicy);
	});

	it("production SessionDomain consumes governed env and policy without raw local fallback", () => {
		const source = readFileSync(join(process.cwd(), "src/runtime/session-runtime/domain.ts"), "utf8");
		expect(source).toContain("createSessionSecurity");
		expect(source).toContain("authorizationPolicy: security.authorizationPolicy");
		expect(source).not.toContain("localExecutionEnv");
	});

	it("binds production Trace recording to the Session owner generation", () => {
		const domainSource = readFileSync(join(process.cwd(), "src/runtime/session-runtime/domain.ts"), "utf8");
		const mainSource = readFileSync(join(process.cwd(), "src/cli/main.ts"), "utf8");
		expect(mainSource).toContain("composeCliTraceRecorderFactory(layout, settings)");
		expect(mainSource).toContain("traceRecorderFactory");
		expect(domainSource).toContain("ownerGeneration: fence.generation");
	});

	it("routes standard CLI worktree flags through the Session worktree composition", () => {
		const mainSource = readFileSync(join(process.cwd(), "src/cli/main.ts"), "utf8");
		expect(mainSource).toContain("createSessionWorkspaceFactory");
		expect(mainSource).toContain("layout.worktrees");
		expect(mainSource).toContain("args.noWorktree");
		expect(mainSource).not.toContain("HostWorkspaceBindingService");
	});

	it("wires durable approval reverse requests and read-only security inspection into production", () => {
		const embeddedSource = readFileSync(join(process.cwd(), "src/cli/embedded-session-runtime.ts"), "utf8");
		const domainSource = readFileSync(join(process.cwd(), "src/runtime/session-runtime/domain.ts"), "utf8");
		const mainSource = readFileSync(join(process.cwd(), "src/cli/main.ts"), "utf8");
		expect(embeddedSource).toContain("createSessionApprovalPorts");
		expect(domainSource).toContain("approvalPorts: options.approvalPorts");
		expect(domainSource).toContain('"session.security.inspect"');
		expect(domainSource).toContain('"session.approval.reverse"');
		expect(mainSource).toContain("handleSessionReverseRequest");
	});

	it("wires network review amendments and request_permissions grants through the resident Session Host", async () => {
		let prompts = 0;
		let writes = 0;
		const security = await composition({
			document: {
				approvalPolicy: "on-request",
				sandbox: "off",
				network: { mode: "review", allowedHosts: [] },
			},
			onWrite: () => { writes += 1; },
			networkBroker: {
				request: async (request) => ({ status: 200, headers: {}, body: Buffer.from("ok"), finalUrl: request.url }),
			},
			approvalPorts: {
				prompter: {
					request: async (prompt) => {
						prompts += 1;
						return prompt.toolName === "request_permissions"
							? { decision: "allow-once", decidedBy: createRuntimeId("principal", "security-approver") }
							: { decision: "allow-with-network-rule", host: "api.example", protocol: "https", port: 8443, decidedBy: createRuntimeId("principal", "security-approver") };
					},
				},
				stateStore: new MemoryApprovalStateStore(),
				audit: { requested: async () => {}, decided: async () => {}, revoked: async () => {} },
			},
		});
		await expect(security.executionEnv.network!.request({ url: "https://api.example:8443/data", method: "GET", headers: {}, maxBytes: 1024 })).resolves.toMatchObject({ status: 200 });
		await expect(security.executionEnv.network!.request({ url: "https://api.example:8443/next", method: "GET", headers: {}, maxBytes: 1024 })).resolves.toMatchObject({ status: 200 });
		expect(prompts).toBe(1);

		const path = join(root, "granted.txt");
		const grant = await security.permissionRequester.request({
			toolCallId: "toolCall_request-permissions-production",
			scope: "session",
			permissions: { filesystem: [{ path, access: "write" }] },
		});
		expect(grant).toMatchObject({ ok: true, value: { scope: "session" } });
		await security.executionEnv.fs.writeFile(path, "granted");
		expect(writes).toBe(1);
		expect(prompts).toBe(2);
	});

	it("composes the managed process domain and tools inside the owned SessionRuntime", () => {
		const domainSource = readFileSync(join(process.cwd(), "src/runtime/session-runtime/domain.ts"), "utf8");
		const embeddedSource = readFileSync(join(process.cwd(), "src/cli/embedded-session-runtime.ts"), "utf8");
		const mainSource = readFileSync(join(process.cwd(), "src/cli/main.ts"), "utf8");
		expect(domainSource).toContain("const process = createSessionProcessComposition");
		expect(domainSource).toContain("process.toolClient()");
		expect(domainSource).toContain("process,");
		expect(embeddedSource).toContain("await domain?.process?.recoverUnattached?.()");
		expect(mainSource).toContain("createSessionProcessOverlayClient(controller)");
		expect(mainSource).toContain("processOverlayController: view.processOverlayController");
	});

	it("rejects a read-only write before the filesystem broker mutates", async () => {
		let writeCalls = 0;
		const security = await composition({
			document: { profile: "read-only", approvalPolicy: "never" },
			onWrite: () => { writeCalls += 1; },
		});

		await expect(security.executionEnv.fs.writeFile(join(root, "blocked.txt"), "blocked"))
			.rejects.toThrow(/denied|allowed roots|policy/u);
		expect(writeCalls).toBe(0);
	});

	it("exposes a Session-scoped managed-process security final leaf", async () => {
		const security = await composition({
			document: { profile: "danger-full-access", approvalPolicy: "never", sandbox: "off" },
		});

		const managedProcess = (security as typeof security & {
			managedProcess?: {
				prepare(input: {
					readonly commandId: string;
					readonly command: string;
					readonly cwd: string;
					readonly timeoutMs: number;
					readonly backend: "pipe" | "pty";
					readonly executionMode: "foreground" | "background";
					readonly requestDigest: ReturnType<typeof runtimeDigest>;
				}): Promise<{ readonly ok: boolean }>;
			};
		}).managedProcess;
		expect(managedProcess).toBeDefined();
		if (managedProcess === undefined) return;
		await expect(managedProcess.prepare({
			commandId: "command_session_process_security",
			command: "printf managed",
			cwd: root,
			timeoutMs: 5_000,
			backend: "pipe",
			executionMode: "background",
			requestDigest: runtimeDigest({ command: "printf managed", cwd: root }),
		})).resolves.toMatchObject({ ok: true });
	});

	it("uses the injected Session durable approval ports for an on-request write", async () => {
		let prompts = 0;
		const approvalPorts = {
			prompter: {
				request: async () => {
					prompts += 1;
					return { decision: "allow-once" as const, decidedBy: createRuntimeId("principal", "session-driver") };
				},
			},
			stateStore: new MemoryApprovalStateStore(),
			audit: {
				requested: async () => undefined,
				decided: async () => undefined,
				revoked: async () => undefined,
			},
		};
		const security = await composition({
			document: { profile: "workspace-write", approvalPolicy: "on-request", sandbox: "off" },
			approvalPorts,
		});
		const target = join(root, "approved.txt");

		await expect(security.executionEnv.fs.writeFile(target, "approved")).resolves.toBeUndefined();
		expect(prompts).toBe(1);
		expect(readFileSync(target, "utf8")).toBe("approved");
	});

	it("rejects network deny before the network broker or fetch leaf", async () => {
		let networkCalls = 0;
		const security = await composition({
			document: { profile: "danger-full-access", network: { mode: "deny", allowedHosts: [] } },
			networkBroker: {
				request: async () => {
					networkCalls += 1;
					return { status: 200, headers: {}, body: Buffer.from("ok"), finalUrl: "https://example.com/" };
				},
			},
		});

		await expect(security.executionEnv.network!.request({
			url: "https://example.com/",
			method: "GET",
			headers: {},
			maxBytes: 1024,
		})).rejects.toThrow(/network|denied|policy/u);
		expect(networkCalls).toBe(0);
	});

	it("rejects an unavailable strict sandbox before process spawn", async () => {
		let processCalls = 0;
		const processLeaf: SessionProcessLeaf = {
			execute: async () => {
				processCalls += 1;
				return { stdout: "", stderr: "", exitCode: 0 };
			},
		};
		const security = await composition({
			document: { profile: "danger-full-access", sandbox: "strict" },
			processLeaf,
		});

		await expect(security.executionEnv.shell.exec("printf blocked"))
			.rejects.toThrow(/sandbox|unavailable|denied/u);
		expect(processCalls).toBe(0);
	});
});
