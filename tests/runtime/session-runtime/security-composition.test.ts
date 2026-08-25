import * as fs from "node:fs/promises";
import { createHash } from "node:crypto";
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
import type { Shell } from "../../../src/runtime/execution-env.ts";
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
import type { GovernedProcessEnvironment, SessionToolchainProbe, SessionToolchainSnapshot } from "../../../src/security/toolchain.ts";
import type { BashSecurityAnalyzerPort } from "../../../src/security/permission/bash-ast/types.ts";

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
	readonly toolchain?: SessionToolchainSnapshot;
	readonly processEnvironment?: GovernedProcessEnvironment;
	readonly toolchainProbe?: SessionToolchainProbe;
	readonly unrestrictedShell?: Shell;
	readonly bashShadowTelemetry?: { record(record: Record<string, unknown>): Promise<void> };
	readonly bashClassificationAudit?: {
		record(record: Record<string, unknown>): Promise<void>;
		link?(record: Record<string, unknown>): Promise<void>;
	};
	readonly bashAnalyzer?: BashSecurityAnalyzerPort;
	readonly approvalTimeoutMs?: number;
	readonly additionalWorkspaceRoots?: readonly string[];
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
		...(input.toolchain === undefined ? {} : { toolchain: input.toolchain }),
		...(input.processEnvironment === undefined ? {} : { processEnvironment: input.processEnvironment }),
		...(input.toolchainProbe === undefined ? {} : { toolchainProbe: input.toolchainProbe }),
		...(input.unrestrictedShell === undefined ? {} : { unrestrictedShell: input.unrestrictedShell }),
		...(input.bashShadowTelemetry === undefined ? {} : { bashShadowTelemetry: input.bashShadowTelemetry }),
		...(input.bashClassificationAudit === undefined ? {} : { bashClassificationAudit: input.bashClassificationAudit }),
		...(input.bashAnalyzer === undefined ? {} : { bashAnalyzer: input.bashAnalyzer }),
		...(input.approvalTimeoutMs === undefined ? {} : { approvalTimeoutMs: input.approvalTimeoutMs }),
		...(input.additionalWorkspaceRoots === undefined ? {} : { additionalWorkspaceRoots: input.additionalWorkspaceRoots }),
	});
}

function unavailableAnalyzer(): BashSecurityAnalyzerPort {
	return {
		analyze: async (_command, mode) => ({
			mode,
			ast: { kind: "parse-unavailable", reasonCode: "bash_worker_crash" },
		}),
	};
}

describe("session-scoped Security/ExecutionGateway composition", () => {
	it("includes canonical additional workspace roots in governed reads and writes", async () => {
		const additionalRoot = join(root, "additional");
		const outside = await fs.mkdtemp(join(tmpdir(), "runledger-session-security-outside-"));
		await fs.mkdir(additionalRoot, { recursive: true });
		const security = await composition({
			document: { profile: "workspace-write", approvalPolicy: "on-request", sandbox: "off" },
			additionalWorkspaceRoots: [additionalRoot],
			approvalPorts: {
				prompter: { request: async () => ({ decision: "allow-once" as const, decidedBy: createRuntimeId("principal", "additional-root-approver") }) },
				stateStore: new MemoryApprovalStateStore(),
				audit: { requested: async () => undefined, decided: async () => undefined, revoked: async () => undefined },
			},
		});
		try {
			expect(security.snapshot.filesystem.readRoots).toContain(additionalRoot);
			expect(security.snapshot.filesystem.writeRoots).toContain(additionalRoot);
			await expect(security.executionEnv.fs.writeFile(join(additionalRoot, "allowed.txt"), "allowed")).resolves.toBeUndefined();
			await expect(security.executionEnv.fs.writeFile(join(outside, "blocked.txt"), "blocked")).rejects.toThrow(/outside allowed roots|policy/iu);
		} finally {
			await security.close();
			await fs.rm(outside, { recursive: true, force: true });
		}
	});

	it("routes AST classification through the Session shell and closes its worker pool", async () => {
		const security = await composition({
			document: {
				profile: "danger-full-access",
				approvalPolicy: "never",
				sandbox: "off",
				bashAnalyzerMode: "ast",
			},
			unrestrictedShell: {
				exec: async () => ({ stdout: "ast", stderr: "", exitCode: 0 }),
			},
		});
		try {
			await expect(security.executionEnv.shell.exec("printf ast")).resolves.toMatchObject({
				stdout: "ast",
				exitCode: 0,
			});
		} finally {
			await security.close();
		}
		expect(await security.bashAnalyzer.status()).toMatchObject({ workerHealth: "closed" });
	});

	it("wires redacted AST classification into the Session Gateway audit port", async () => {
		const records: Record<string, unknown>[] = [];
		const links: Record<string, unknown>[] = [];
		const security = await composition({
			document: { profile: "danger-full-access", approvalPolicy: "never", sandbox: "off", bashAnalyzerMode: "ast" },
			unrestrictedShell: { exec: async () => ({ stdout: "audited", stderr: "", exitCode: 0 }) },
			bashClassificationAudit: {
				record: async (record) => { records.push(record); },
				link: async (record) => { links.push(record); },
			},
		});
		try {
			await expect(security.executionEnv.shell.exec("printf audit-sentinel")).resolves.toMatchObject({ stdout: "audited" });
		} finally {
			await security.close();
		}
		expect(records).toHaveLength(1);
		expect(records[0]).toMatchObject({ mode: "ast", classification: "simple", authorizationOutcome: "allow" });
		expect(links).toHaveLength(1);
		expect(links[0]).toMatchObject({
			requestDigest: records[0]?.requestDigest,
			constraintSnapshotDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
		});
		expect(JSON.stringify(records)).not.toContain("audit-sentinel");
	});

	it("keeps shadow telemetry redacted and non-authoritative", async () => {
		const records: Record<string, unknown>[] = [];
		const security = await composition({
			document: {
				profile: "danger-full-access",
				approvalPolicy: "never",
				sandbox: "off",
				bashAnalyzerMode: "shadow",
			},
			unrestrictedShell: {
				exec: async () => ({ stdout: "shadow", stderr: "", exitCode: 0 }),
			},
			bashShadowTelemetry: {
				record: async (record) => { records.push(record); },
			},
		});
		try {
			await security.executionEnv.shell.exec("printf secret-command");
		} finally {
			await security.close();
		}
		expect(records).toHaveLength(1);
		expect(records[0]).toMatchObject({ mode: "shadow", astKind: "simple" });
		expect(JSON.stringify(records)).not.toContain("secret-command");
	});

	it("routes an AST-dangerous shell through approval and never executes after cancellation", async () => {
		let shellCalls = 0;
		const security = await composition({
			document: {
				profile: "danger-full-access",
				approvalPolicy: "on-request",
				sandbox: "off",
				bashAnalyzerMode: "ast",
			},
			unrestrictedShell: {
				exec: async () => {
					shellCalls += 1;
					return { stdout: "executed", stderr: "", exitCode: 0 };
				},
			},
			approvalPorts: {
				prompter: {
					request: async () => ({
						decision: "cancel" as const,
						decidedBy: createRuntimeId("principal", "ast-canceller"),
					}),
				},
				stateStore: new MemoryApprovalStateStore(),
				audit: {
					requested: async () => undefined,
					decided: async () => undefined,
					revoked: async () => undefined,
				},
			},
		});
		try {
			await expect(security.executionEnv.shell.exec("rm -f safe-file"))
				.rejects.toMatchObject({ code: "approval_cancelled" });
		} finally {
			await security.close();
		}
		expect(shellCalls).toBe(0);
	});

	it("headless composition denies an AST-too-complex shell before the process leaf", async () => {
		let shellCalls = 0;
		const security = await composition({
			document: {
				profile: "danger-full-access",
				approvalPolicy: "on-request",
				sandbox: "off",
				bashAnalyzerMode: "ast",
			},
			unrestrictedShell: {
				exec: async () => {
					shellCalls += 1;
					return { stdout: "executed", stderr: "", exitCode: 0 };
				},
			},
		});
		try {
			await expect(security.executionEnv.shell.exec("printf\u00a0unsafe"))
				.rejects.toMatchObject({ code: "policy_denied" });
		} finally {
			await security.close();
		}
		expect(shellCalls).toBe(0);
	});

	it("headless production composition denies an injected AST parse-unavailable result", async () => {
		let shellCalls = 0;
		const security = await composition({
			document: {
				profile: "danger-full-access",
				approvalPolicy: "on-request",
				sandbox: "off",
				bashAnalyzerMode: "ast",
			},
			bashAnalyzer: unavailableAnalyzer(),
			unrestrictedShell: {
				exec: async () => {
					shellCalls += 1;
					return { stdout: "executed", stderr: "", exitCode: 0 };
				},
			},
		});
		try {
			await expect(security.executionEnv.shell.exec("printf unavailable"))
				.rejects.toMatchObject({ code: "policy_denied" });
		} finally {
			await security.close();
		}
		expect(shellCalls).toBe(0);
	});

	it.each([
		["on-request", undefined],
		["untrusted", undefined],
		["granular", {
			sandboxApproval: true,
			rules: true,
			skillApproval: true,
			requestPermissions: true,
			mcpElicitations: true,
		}],
	] as const)("allows an interactive approval for AST parse-unavailable under %s", async (approvalPolicy, granularApproval) => {
		let shellCalls = 0;
		const security = await composition({
			document: {
				profile: "danger-full-access",
				approvalPolicy,
				sandbox: "off",
				bashAnalyzerMode: "ast",
				...(granularApproval === undefined ? {} : { granularApproval }),
			},
			bashAnalyzer: unavailableAnalyzer(),
			unrestrictedShell: {
				exec: async () => {
					shellCalls += 1;
					return { stdout: "approved", stderr: "", exitCode: 0 };
				},
			},
			approvalPorts: {
				prompter: {
					request: async () => ({
						decision: "allow-once" as const,
						decidedBy: createRuntimeId("principal", `ast-${approvalPolicy}`),
					}),
				},
				stateStore: new MemoryApprovalStateStore(),
				audit: {
					requested: async () => undefined,
					decided: async () => undefined,
					revoked: async () => undefined,
				},
			},
		});
		try {
			await expect(security.executionEnv.shell.exec("printf approved-unavailable"))
				.resolves.toMatchObject({ stdout: "approved" });
		} finally {
			await security.close();
		}
		expect(shellCalls).toBe(1);
	});

	it("denies AST parse-unavailable when granular rules approval is disabled", async () => {
		let prompts = 0;
		const security = await composition({
			document: {
				profile: "danger-full-access",
				approvalPolicy: "granular",
				granularApproval: {
					sandboxApproval: true,
					rules: false,
					skillApproval: true,
					requestPermissions: true,
					mcpElicitations: true,
				},
				sandbox: "off",
				bashAnalyzerMode: "ast",
			},
			bashAnalyzer: unavailableAnalyzer(),
			approvalPorts: {
				prompter: {
					request: async () => {
						prompts += 1;
						return { decision: "allow-once" as const, decidedBy: createRuntimeId("principal", "unexpected") };
					},
				},
				stateStore: new MemoryApprovalStateStore(),
				audit: {
					requested: async () => undefined,
					decided: async () => undefined,
					revoked: async () => undefined,
				},
			},
		});
		try {
			await expect(security.executionEnv.shell.exec("printf denied-unavailable"))
				.rejects.toMatchObject({ code: "policy_denied" });
		} finally {
			await security.close();
		}
		expect(prompts).toBe(0);
	});

	it("expires an AST approval through the production shell path", async () => {
		let shellCalls = 0;
		const security = await composition({
			document: {
				profile: "danger-full-access",
				approvalPolicy: "on-request",
				sandbox: "off",
				bashAnalyzerMode: "ast",
			},
			approvalTimeoutMs: 1,
			unrestrictedShell: {
				exec: async () => {
					shellCalls += 1;
					return { stdout: "executed", stderr: "", exitCode: 0 };
				},
			},
			approvalPorts: {
				prompter: {
					request: async (_prompt, signal) => new Promise((_, reject) => {
						signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
					}),
				},
				stateStore: new MemoryApprovalStateStore(),
				audit: {
					requested: async () => undefined,
					decided: async () => undefined,
					revoked: async () => undefined,
				},
			},
		});
		const controller = new AbortController();
		const abortTimer = setTimeout(() => controller.abort(), 50);
		try {
			await expect(security.executionEnv.shell.exec("rm -f safe-file", { signal: controller.signal }))
				.rejects.toMatchObject({ code: "approval_expired" });
		} finally {
			clearTimeout(abortTimer);
			await security.close();
		}
		expect(shellCalls).toBe(0);
	});

	it("keeps two Session-owned worker pools isolated when one Session closes", async () => {
		const first = await composition({
			document: { profile: "danger-full-access", approvalPolicy: "never", sandbox: "off", bashAnalyzerMode: "ast" },
			unrestrictedShell: { exec: async () => ({ stdout: "first", stderr: "", exitCode: 0 }) },
		});
		const second = await composition({
			document: { profile: "danger-full-access", approvalPolicy: "never", sandbox: "off", bashAnalyzerMode: "ast" },
			unrestrictedShell: { exec: async () => ({ stdout: "second", stderr: "", exitCode: 0 }) },
		});
		try {
			await first.close();
			await expect(second.executionEnv.shell.exec("printf isolated")).resolves.toMatchObject({ stdout: "second" });
			expect(await first.bashAnalyzer.status?.()).toMatchObject({ workerHealth: "closed" });
			expect(await second.bashAnalyzer.status?.()).toMatchObject({ workerHealth: "ready" });
		} finally {
			await second.close();
		}
	});

	it("exposes session-neutral security names while retaining legacy Host aliases", () => {
		expect(ProcessFinalLeafAdapter).toBe(HostProcessFinalLeafAdapter);
		expect(GovernedToolAuthorizationPolicy).toBe(HostGovernedToolAuthorizationPolicy);
	});

	it("production SessionDomain consumes governed env and policy without raw local fallback", () => {
		const source = readFileSync(join(process.cwd(), "src/runtime/session-runtime/domain.ts"), "utf8");
		const securitySource = readFileSync(join(process.cwd(), "src/security/session-composition.ts"), "utf8");
		expect(source).toContain("createSessionSecurity");
		expect(source).toContain("resolveSessionToolchainSnapshot");
		expect(source).toContain("buildGovernedProcessEnvironment");
		expect(source).toContain("toolchain:");
		expect(source).toContain("processEnvironment:");
		expect(source).toContain("authorizationPolicy: security.authorizationPolicy");
		expect(source).toContain("security.close()");
		expect(source).toContain("bashAnalyzerMode: security.snapshot.bashAnalyzer?.mode");
		expect(source).toContain("bashClassificationAudit: options.bashClassificationAudit");
		expect(source).toContain("createSessionBashClassificationAudit");
		expect(source).not.toContain("localExecutionEnv");
		expect(securitySource).toContain("resolveToolAccessRequestsWithBashAnalyzer");
		expect(securitySource).not.toContain("function bashAccessRequests(");
		expect(securitySource).toContain("await bashAnalyzer.initialize?.()");
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

	it("allows a governed LSP command with its stderr sink under danger-full-access", async () => {
		const security = await composition({
			document: { profile: "danger-full-access", approvalPolicy: "never", sandbox: "off" },
		});
		try {
			await expect(security.managedProcess.prepare({
				commandId: "command_session_lsp_typescript",
				command: `${root}/node_modules/.bin/typescript-language-server --stdio 2>/dev/null`,
				cwd: root,
				timeoutMs: 86_400_000,
				backend: "pipe",
				executionMode: "background",
				requestDigest: runtimeDigest("session-lsp-typescript"),
			})).resolves.toMatchObject({ ok: true });
		} finally {
			await security.close();
		}
	});

	it("allows the governed LSP command with its stderr sink in AST mode", async () => {
		const security = await composition({
			document: { profile: "danger-full-access", approvalPolicy: "never", sandbox: "off", bashAnalyzerMode: "ast" },
		});
		try {
			await expect(security.managedProcess.prepare({
				commandId: "command_session_lsp_typescript_ast",
				command: `${root}/node_modules/.bin/typescript-language-server --stdio 2>/dev/null`,
				cwd: root,
				timeoutMs: 86_400_000,
				backend: "pipe",
				executionMode: "background",
				requestDigest: runtimeDigest("session-lsp-typescript-ast"),
			})).resolves.toMatchObject({ ok: true });
		} finally {
			await security.close();
		}
	});

	it("carries AST classification into the managed-process authorization path", async () => {
		const security = await composition({
			document: { profile: "danger-full-access", approvalPolicy: "never", sandbox: "off", bashAnalyzerMode: "ast" },
		});
		try {
			await expect(security.managedProcess.prepare({
				commandId: "command_session_process_ast",
				command: "printf managed-ast",
				cwd: root,
				timeoutMs: 5_000,
				backend: "pipe",
				executionMode: "background",
				requestDigest: runtimeDigest({ command: "printf managed-ast", cwd: root }),
			})).resolves.toMatchObject({ ok: true });
		} finally {
			await security.close();
		}
	});

	it("uses the attested immutable launch plan even when sandbox is off", async () => {
		const identity = {
			device: 1,
			inode: 1,
			size: 1,
			mtimeMs: 1,
			contentDigest: runtimeDigest("binary"),
		};
		const body = {
			node: { launchPath: "/runtime/bin/node", canonicalPath: "/runtime/bin/node", version: "22.23.1", identity },
			npm: { launchPath: "/runtime/bin/npm", canonicalPath: "/runtime/lib/npm-cli.js", version: "10.9.8", identity: { ...identity, inode: 2 } },
			bun: { launchPath: "/runtime/bin/bun", canonicalPath: "/runtime/bin/bun", version: "1.3.14", identity: { ...identity, inode: 3 } },
			packageBinDirectory: join(root, "node_modules", ".bin"),
			packageRoot: root,
		};
		const toolchain: SessionToolchainSnapshot = { ...body, snapshotDigest: runtimeDigest(body) };
		const privateRoot = join(root, "home", "tmp", "governed-process");
		const environment = {
			HOME: join(privateRoot, "home"),
			TMPDIR: join(privateRoot, "tmp"),
			XDG_CACHE_HOME: join(privateRoot, "cache"),
			npm_config_cache: join(privateRoot, "npm-cache"),
			USER: "runledger",
			LOGNAME: "runledger",
			SHELL: "/bin/sh",
			PATH: `${body.packageBinDirectory}:/runtime/bin:/usr/bin:/bin`,
		};
		const processEnvironment: GovernedProcessEnvironment = {
			environment,
			environmentDigest: runtimeDigest(environment),
			privateRoot,
		};
		const security = await composition({
			document: { profile: "danger-full-access", approvalPolicy: "never", sandbox: "off" },
			toolchain,
			processEnvironment,
		});
		const prepared = await security.managedProcess.prepare({
			commandId: "command_attested_off",
			command: "node -v",
			cwd: root,
			timeoutMs: 5_000,
			backend: "pipe",
			executionMode: "background",
			requestDigest: runtimeDigest("attested-off"),
		});
		expect(prepared).toMatchObject({
			ok: true,
			value: {
				launchPlan: {
					enforcement: "off",
					environment,
				},
				toolchainSnapshotDigest: toolchain.snapshotDigest,
				environmentDigest: processEnvironment.environmentDigest,
			},
		});
		if (!prepared.ok) return;
		expect(prepared.value.requestDigest).toMatchObject({ algorithm: "sha256", digest: expect.stringMatching(/^[a-f0-9]{64}$/u) });
		expect(JSON.stringify(prepared.value.launchPlan)).not.toContain("process.env");
		for (const directory of [privateRoot, environment.HOME, environment.TMPDIR, environment.XDG_CACHE_HOME, environment.npm_config_cache]) {
			const info = await fs.lstat(directory);
			expect(info.isDirectory()).toBe(true);
			expect(info.isSymbolicLink()).toBe(false);
			expect(info.mode & 0o777).toBe(0o700);
		}
	});

	it("routes sandbox-off governed shell execution through the immutable launch plan", async () => {
		const bytes = Buffer.from("binary");
		const identity = {
			device: 1,
			inode: 1,
			size: bytes.length,
			mtimeMs: 1,
			contentDigest: { algorithm: "sha256" as const, digest: createHash("sha256").update(bytes).digest("hex") as SessionToolchainSnapshot["node"]["identity"]["contentDigest"]["digest"] },
		};
		const body = {
			node: { launchPath: "/runtime/bin/node", canonicalPath: "/runtime/bin/node", version: "22.23.1", identity },
			npm: { launchPath: "/runtime/bin/npm", canonicalPath: "/runtime/lib/npm-cli.js", version: "10.9.8", identity },
			bun: { launchPath: "/runtime/bin/bun", canonicalPath: "/runtime/bin/bun", version: "1.3.14", identity },
			packageBinDirectory: join(root, "node_modules", ".bin"),
			packageRoot: root,
		};
		const toolchain: SessionToolchainSnapshot = { ...body, snapshotDigest: runtimeDigest(body) };
		const privateRoot = join(root, "home", "tmp", "shell-environment");
		const environment = {
			HOME: join(privateRoot, "home"), TMPDIR: join(privateRoot, "tmp"), XDG_CACHE_HOME: join(privateRoot, "cache"), npm_config_cache: join(privateRoot, "npm-cache"),
			USER: "runledger", LOGNAME: "runledger", SHELL: "/bin/sh", PATH: `${body.packageBinDirectory}:/runtime/bin:/usr/bin:/bin`,
		};
		const processEnvironment: GovernedProcessEnvironment = { environment, environmentDigest: runtimeDigest(environment), privateRoot };
		let leafPlan: Parameters<SessionProcessLeaf["execute"]>[0] | undefined;
		let unrestrictedCalls = 0;
		const toolchainProbe: SessionToolchainProbe = {
			which: async () => undefined,
			realpath: async (path) => path === "/runtime/bin/npm" ? "/runtime/lib/npm-cli.js" : path,
			readFile: async () => bytes,
			stat: async () => ({ device: 1, inode: 1, size: bytes.length, mtimeMs: 1 }),
			run: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
		};
		const security = await composition({
			document: { profile: "danger-full-access", approvalPolicy: "never", sandbox: "off" },
			toolchain,
			processEnvironment,
			toolchainProbe,
			processLeaf: { execute: async (plan) => { leafPlan = plan; return { stdout: "v22.23.1", stderr: "", exitCode: 0 }; } },
			unrestrictedShell: { exec: async () => { unrestrictedCalls += 1; return { stdout: "ambient", stderr: "", exitCode: 0 }; } },
		});
		await expect(security.executionEnv.shell.exec("node --version")).resolves.toMatchObject({ stdout: "v22.23.1", exitCode: 0 });
		expect(leafPlan?.environment).toEqual(environment);
		expect(unrestrictedCalls).toBe(0);
	});

	it("rejects executable identity drift before the sandbox-off process leaf", async () => {
		const bytes = Buffer.from("binary");
		const contentDigest = { algorithm: "sha256" as const, digest: createHash("sha256").update(bytes).digest("hex") as SessionToolchainSnapshot["node"]["identity"]["contentDigest"]["digest"] };
		const identity = { device: 1, inode: 1, size: bytes.length, mtimeMs: 1, contentDigest };
		const body = {
			node: { launchPath: "/runtime/bin/node", canonicalPath: "/runtime/bin/node", version: "22.23.1", identity },
			npm: { launchPath: "/runtime/bin/npm", canonicalPath: "/runtime/lib/npm-cli.js", version: "10.9.8", identity },
			bun: { launchPath: "/runtime/bin/bun", canonicalPath: "/runtime/bin/bun", version: "1.3.14", identity },
			packageBinDirectory: join(root, "node_modules", ".bin"),
			packageRoot: root,
		};
		const toolchain: SessionToolchainSnapshot = { ...body, snapshotDigest: runtimeDigest(body) };
		const privateRoot = join(root, "home", "tmp", "identity-drift");
		const environment = {
			HOME: join(privateRoot, "home"), TMPDIR: join(privateRoot, "tmp"), XDG_CACHE_HOME: join(privateRoot, "cache"), npm_config_cache: join(privateRoot, "npm-cache"),
			USER: "runledger", LOGNAME: "runledger", SHELL: "/bin/sh", PATH: `${body.packageBinDirectory}:/runtime/bin:/usr/bin:/bin`,
		};
		let leafCalls = 0;
		const security = await composition({
			document: { profile: "danger-full-access", approvalPolicy: "never", sandbox: "off" },
			toolchain,
			processEnvironment: { environment, environmentDigest: runtimeDigest(environment), privateRoot },
			toolchainProbe: {
				which: async () => undefined,
				realpath: async (path) => path === "/runtime/bin/npm" ? "/runtime/lib/npm-cli.js" : path,
				readFile: async () => bytes,
				stat: async () => ({ device: 1, inode: 99, size: bytes.length, mtimeMs: 1 }),
				run: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
			},
			processLeaf: { execute: async () => { leafCalls += 1; return { stdout: "", stderr: "", exitCode: 0 }; } },
		});
		await expect(security.executionEnv.shell.exec("node --version")).rejects.toThrow("toolchain executable identity changed");
		expect(leafCalls).toBe(0);
	});

	it("rejects reserved or secret per-command environment overrides before the process leaf", async () => {
		const bytes = Buffer.from("binary");
		const contentDigest = { algorithm: "sha256" as const, digest: createHash("sha256").update(bytes).digest("hex") as SessionToolchainSnapshot["node"]["identity"]["contentDigest"]["digest"] };
		const identity = { device: 1, inode: 1, size: bytes.length, mtimeMs: 1, contentDigest };
		const body = {
			node: { launchPath: "/runtime/bin/node", canonicalPath: "/runtime/bin/node", version: "22.23.1", identity },
			npm: { launchPath: "/runtime/bin/npm", canonicalPath: "/runtime/lib/npm-cli.js", version: "10.9.8", identity },
			bun: { launchPath: "/runtime/bin/bun", canonicalPath: "/runtime/bin/bun", version: "1.3.14", identity },
			packageBinDirectory: join(root, "node_modules", ".bin"),
			packageRoot: root,
		};
		const toolchain: SessionToolchainSnapshot = { ...body, snapshotDigest: runtimeDigest(body) };
		const privateRoot = join(root, "home", "tmp", "override-rejection");
		const environment = {
			HOME: join(privateRoot, "home"), TMPDIR: join(privateRoot, "tmp"), XDG_CACHE_HOME: join(privateRoot, "cache"), npm_config_cache: join(privateRoot, "npm-cache"),
			USER: "runledger", LOGNAME: "runledger", SHELL: "/bin/sh", PATH: `${body.packageBinDirectory}:/runtime/bin:/usr/bin:/bin`,
		};
		let leafCalls = 0;
		const security = await composition({
			document: { profile: "danger-full-access", approvalPolicy: "never", sandbox: "off" },
			toolchain,
			processEnvironment: { environment, environmentDigest: runtimeDigest(environment), privateRoot },
			toolchainProbe: {
				which: async () => undefined,
				realpath: async (path) => path === "/runtime/bin/npm" ? "/runtime/lib/npm-cli.js" : path,
				readFile: async () => bytes,
				stat: async () => ({ device: 1, inode: 1, size: bytes.length, mtimeMs: 1 }),
				run: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
			},
			processLeaf: { execute: async () => { leafCalls += 1; return { stdout: "", stderr: "", exitCode: 0 }; } },
		});
		await expect(security.executionEnv.shell.exec("printf blocked", { env: { HOME: "/escape" } })).rejects.toMatchObject({ code: "invalid_request" });
		await expect(security.executionEnv.shell.exec("printf blocked", { env: { SERVICE_TOKEN: "secret" } })).rejects.toMatchObject({ code: "invalid_request" });
		expect(leafCalls).toBe(0);
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
