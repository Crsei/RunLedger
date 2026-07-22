/** 有界 child launcher：从私有 Workspace broker 取 cwd，创建独立 durable V3 session。 */

import { spawn } from "node:child_process";
import { mkdir, open, readdir, realpath, rm } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { canonicalDigest } from "../../protocol/v3/canonical-json.ts";
import {
	createRuntimeId,
	isRuntimeId,
	type AgentId,
	type CommandId,
	type ReceiptId,
} from "../../protocol/v3/ids.ts";
import type { RuntimeIdentityContext } from "../../identity/types.ts";
import type { RuntimeFeatureFlags } from "../../runtime-features.ts";
import type { SessionMutationAdmissionGatePort } from "../../lifecycle/mutation-gate.ts";
import { V3SessionManager } from "../../../storage/v3-session-manager.ts";
import { pathWithin } from "../../../worktree/paths.ts";
import { createAgentResidencyReceipt } from "../residency.ts";
import type {
	AgentCancelRequest,
	AgentErrorCode,
	AgentLaunchReceiptRef,
	AgentLaunchRequest,
	AgentLaunchResult,
	AgentLauncherPort,
	AgentResult,
	AgentResumeLaunchRequest,
} from "../types.ts";
import type { GatewayBoundCapabilitySubsetEvaluator } from "./capability-subset.ts";
import type { ProductionAgentWorkspaceAdapter } from "./worktree-workspace.ts";

export interface ProductionChildSessionLauncherOptions {
	workspace: ProductionAgentWorkspaceAdapter;
	capabilitySubset: GatewayBoundCapabilitySubsetEvaluator;
	parentMutationGate: SessionMutationAdmissionGatePort;
	sessionDir: string;
	features: Readonly<RuntimeFeatureFlags>;
	identity: RuntimeIdentityContext;
	maxActiveChildren: number;
	processIsolation?: {
		rootDir: string;
		allowedExecutables: readonly string[];
		maxOutputBytes?: number;
		timeoutMs?: number;
	};
	clock?: () => Date;
}

export interface ChildSessionRuntimeSnapshot {
	agentId: AgentId;
	sessionId: AgentLaunchRequest["sessionId"];
	workspaceId: AgentLaunchRequest["workspaceReceipt"]["workspaceId"];
	runtimeInstanceId: ReturnType<V3SessionManager["runtimeId"]>;
	launchRevision: number;
	eventSequence?: number;
}

export interface ChildIsolatedCommandRequest {
	requestId: CommandId;
	agentId: AgentId;
	sessionId: AgentLaunchRequest["sessionId"];
	workspaceReceipt: AgentLaunchRequest["workspaceReceipt"];
	executable: string;
	arguments: readonly string[];
}

export interface ChildIsolatedCommandResult {
	exitCode: number | null;
	exitSignal: string | null;
	stdout: string;
	stderr: string;
}

interface ChildRuntimeRecord {
	manager: V3SessionManager;
	workspaceId: AgentLaunchRequest["workspaceReceipt"]["workspaceId"];
	launchRevision: number;
	launchRequestDigest: string;
	launchResult: Extract<AgentLaunchResult, { status: "started" }>;
}

function fail<T>(code: AgentErrorCode, message: string, retryable = false): AgentResult<T> {
	return { ok: false, error: { code, message, retryable } };
}

function launchRequestBody(request: AgentLaunchRequest): Omit<AgentLaunchRequest, "requestDigest"> {
	const { requestDigest: _requestDigest, ...body } = request;
	return body;
}

function resumeRequestBody(request: AgentResumeLaunchRequest): Omit<AgentResumeLaunchRequest, "requestDigest"> {
	const { requestDigest: _requestDigest, ...body } = request;
	return body;
}

function cancelRequestBody(request: AgentCancelRequest): Omit<AgentCancelRequest, "requestDigest"> {
	const { requestDigest: _requestDigest, ...body } = request;
	return body;
}

function launchReceiptBody(
	receipt: Omit<AgentLaunchReceiptRef, "receiptDigest">,
): Omit<AgentLaunchReceiptRef, "receiptDigest"> {
	return receipt;
}

const MAX_PROCESS_ARGUMENTS = 128;
const MAX_PROCESS_ARGUMENT_BYTES = 64 * 1024;
const DEFAULT_PROCESS_OUTPUT_BYTES = 1024 * 1024;
const DEFAULT_PROCESS_TIMEOUT_MS = 30_000;

function exactAbsolutePath(path: string): boolean {
	return isAbsolute(path) && resolve(path) === path && !path.includes("\0");
}

function commandIsBounded(request: ChildIsolatedCommandRequest): boolean {
	return (
		isRuntimeId(request.requestId, "command") &&
		isRuntimeId(request.agentId, "agent") &&
		isRuntimeId(request.sessionId, "session") &&
		exactAbsolutePath(request.executable) &&
		request.arguments.length <= MAX_PROCESS_ARGUMENTS &&
		request.arguments.every((argument) => !argument.includes("\0")) &&
		Buffer.byteLength(request.arguments.join("\0"), "utf8") <= MAX_PROCESS_ARGUMENT_BYTES
	);
}

async function runBoundedProcess(
	executable: string,
	args: readonly string[],
	cwd: string,
	environment: NodeJS.ProcessEnv,
	maxOutputBytes: number,
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<AgentResult<ChildIsolatedCommandResult>> {
	return new Promise((resolveResult) => {
		let stdout = "";
		let stderr = "";
		let outputBytes = 0;
		let exceeded = false;
		let timedOut = false;
		let settled = false;
		const child = spawn(executable, [...args], {
			cwd,
			env: environment,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
		});
		const finish = (result: AgentResult<ChildIsolatedCommandResult>) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal?.removeEventListener("abort", abort);
			resolveResult(result);
		};
		const append = (target: "stdout" | "stderr", chunk: Buffer) => {
			outputBytes += chunk.byteLength;
			if (outputBytes > maxOutputBytes) {
				exceeded = true;
				child.kill("SIGKILL");
				return;
			}
			if (target === "stdout") stdout += chunk.toString("utf8");
			else stderr += chunk.toString("utf8");
		};
		child.stdout.on("data", (chunk: Buffer) => append("stdout", chunk));
		child.stderr.on("data", (chunk: Buffer) => append("stderr", chunk));
		child.once("error", () => finish(fail("launch_failed", "isolated child process could not start", true)));
		child.once("close", (exitCode, exitSignal) => {
			if (exceeded) return finish(fail("launch_failed", "isolated child process output exceeded its bound"));
			if (timedOut) return finish(fail("launch_failed", "isolated child process exceeded its timeout", true));
			if (signal?.aborted) return finish(fail("reference_unavailable", "isolated child process was aborted", true));
			return finish({ ok: true, value: { exitCode, exitSignal, stdout, stderr } });
		});
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGKILL");
		}, timeoutMs);
		timer.unref();
		const abort = () => child.kill("SIGKILL");
		if (signal?.aborted) abort();
		else signal?.addEventListener("abort", abort, { once: true });
	});
}

export class ProductionChildSessionLauncher implements AgentLauncherPort {
	readonly #options: ProductionChildSessionLauncherOptions;
	readonly #clock: () => Date;
	readonly #children = new Map<AgentId, ChildRuntimeRecord>();
	#closed = false;

	public constructor(options: ProductionChildSessionLauncherOptions) {
		if (!Number.isSafeInteger(options.maxActiveChildren) || options.maxActiveChildren < 1) {
			throw new RangeError("production child launcher requires a positive active-child bound");
		}
		if (options.processIsolation) {
			const maxOutputBytes = options.processIsolation.maxOutputBytes ?? DEFAULT_PROCESS_OUTPUT_BYTES;
			const timeoutMs = options.processIsolation.timeoutMs ?? DEFAULT_PROCESS_TIMEOUT_MS;
			if (
				!exactAbsolutePath(options.processIsolation.rootDir) ||
				options.processIsolation.allowedExecutables.length === 0 ||
				new Set(options.processIsolation.allowedExecutables).size !== options.processIsolation.allowedExecutables.length ||
				options.processIsolation.allowedExecutables.some((executable) => !exactAbsolutePath(executable)) ||
				!Number.isSafeInteger(maxOutputBytes) ||
				maxOutputBytes < 1 ||
				!Number.isSafeInteger(timeoutMs) ||
				timeoutMs < 1
			) throw new RangeError("production child process isolation configuration is invalid");
		}
		this.#options = options;
		this.#clock = options.clock ?? (() => new Date());
	}

	async #claimDurableSession(sessionId: AgentLaunchRequest["sessionId"]): Promise<AgentResult<string>> {
		try {
			await mkdir(this.#options.sessionDir, { recursive: true, mode: 0o700 });
			const entries = await readdir(this.#options.sessionDir, { withFileTypes: true });
			if (entries.some((entry) => entry.isFile() && entry.name.endsWith(`_${sessionId}.jsonl`))) {
				return fail("launch_failed", "durable child session already exists and requires explicit worker recovery");
			}
			const claimPath = join(this.#options.sessionDir, `.${sessionId}.launch-claim`);
			const claim = await open(claimPath, "wx", 0o600);
			try {
				await claim.writeFile(JSON.stringify({ schemaVersion: 1, sessionId }));
				await claim.sync();
			} finally {
				await claim.close();
			}
			return { ok: true, value: claimPath };
		} catch (cause) {
			const code = (cause as NodeJS.ErrnoException).code;
			return code === "EEXIST"
				? fail("launch_failed", "durable child session launch is already claimed")
				: fail("reference_unavailable", "durable child session claim is unavailable", true);
		}
	}

	async #isolatedProcessRoot(): Promise<AgentResult<string>> {
		const configured = this.#options.processIsolation;
		if (!configured) return fail("reference_unavailable", "child process isolation is not configured");
		try {
			await mkdir(configured.rootDir, { recursive: true, mode: 0o700 });
			const canonical = resolve(await realpath(configured.rootDir));
			return canonical === configured.rootDir
				? { ok: true, value: canonical }
				: fail("launch_failed", "child process isolation root changed identity");
		} catch {
			return fail("reference_unavailable", "child process isolation root is unavailable", true);
		}
	}

	#createStartedResult(
		request: Pick<AgentLaunchRequest, "agentId" | "sessionId">,
		manager: V3SessionManager,
		revision: number,
	): AgentResult<Extract<AgentLaunchResult, { status: "started" }>> {
		const launchedAt = this.#clock().toISOString();
		const launchBody: Omit<AgentLaunchReceiptRef, "receiptDigest"> = {
			receiptId: createRuntimeId(
				"receipt",
				`agent-launch-${canonicalDigest({
					agentId: request.agentId,
					sessionId: request.sessionId,
					runtimeId: manager.runtimeId(),
					revision,
				}).slice(0, 48)}`,
			),
			agentId: request.agentId,
			sessionId: request.sessionId,
			launchRevision: revision,
			launchedAt,
		};
		const residency = createAgentResidencyReceipt({
			agentId: request.agentId,
			sessionId: request.sessionId,
			runtimeInstanceId: manager.runtimeId(),
			state: "resident",
			revision,
			observedAt: launchedAt,
		});
		if (!residency.ok) return residency;
		return {
			ok: true,
			value: {
				status: "started",
				launchReceipt: {
					...launchBody,
					receiptDigest: canonicalDigest(launchReceiptBody(launchBody)),
				},
				residencyReceipt: residency.value,
			},
		};
	}

	public async launch(
		request: AgentLaunchRequest,
		signal?: AbortSignal,
	): Promise<AgentResult<AgentLaunchResult>> {
		if (this.#closed) {
			return { ok: true, value: { status: "unavailable", reasonDigest: canonicalDigest("launcher unavailable"), retryable: true } };
		}
		if (request.requestDigest !== canonicalDigest(launchRequestBody(request))) {
			return fail("launch_failed", "child launch request digest is invalid");
		}
		if (!this.#options.capabilitySubset.validatesDelegation(request.delegationReceipt)) {
			return fail("delegation_denied", "child launch delegation receipt is stale or invalid");
		}
		if (signal?.aborted) {
			return fail("reference_unavailable", "parent session child-spawn admission is unavailable");
		}
		try {
			const admitted = await this.#options.parentMutationGate.revalidate({
				kind: "child_spawn",
				correlationId: request.requestId,
			}, signal);
			if (!admitted.ok || signal?.aborted || this.#closed) {
				return fail("reference_unavailable", "parent session child-spawn admission is unavailable");
			}
		} catch {
			return fail("reference_unavailable", "parent session child-spawn admission is unavailable");
		}
		const existing = this.#children.get(request.agentId);
		if (existing) {
			return existing.launchRequestDigest === request.requestDigest && existing.manager.sessionId() === request.sessionId
				? { ok: true, value: structuredClone(existing.launchResult) }
				: fail("launch_failed", "child Agent launch identity is already bound to another runtime");
		}
		if (this.#children.size >= this.#options.maxActiveChildren) {
			return { ok: true, value: { status: "rejected", reasonDigest: canonicalDigest("active child bound reached"), retryable: true } };
		}
		return this.#options.workspace.withValidatedWorkspace(
			{
				requestId: request.requestId,
				agentId: request.agentId,
				sessionId: request.sessionId,
				receipt: request.workspaceReceipt,
			},
			async (workspace) => {
				if (signal?.aborted || this.#closed) {
					return fail("reference_unavailable", "parent session child-spawn admission is unavailable");
				}
				const claim = await this.#claimDurableSession(request.sessionId);
				if (!claim.ok) return claim;
				if (signal?.aborted || this.#closed) {
					try {
						await rm(claim.value, { force: true });
						return fail("reference_unavailable", "parent session child-spawn admission is unavailable");
					} catch {
						return fail("reference_unavailable", "child launch claim cleanup is uncertain");
					}
				}
				let manager: V3SessionManager;
				try {
					manager = await V3SessionManager.create({
						cwd: workspace.envelope.cwd,
						sessionDir: this.#options.sessionDir,
						identity: this.#options.identity,
						sessionId: request.sessionId,
						features: this.#options.features,
						lineage: {
							goalId: createRuntimeId(
								"goal",
								`delegated-${canonicalDigest({ parentAgentId: request.parentAgentId, agentId: request.agentId }).slice(0, 40)}`,
							),
							agentId: request.agentId,
						},
					});
				} catch {
					await rm(claim.value, { force: true });
					return fail("launch_failed", "durable child V3 session could not be created", true);
				}
				if (signal?.aborted || this.#closed) {
					const cleanup = await Promise.allSettled([
						manager.closeAll(),
						rm(claim.value, { force: true }),
					]);
					return cleanup.some((result) => result.status === "rejected")
						? fail("reference_unavailable", "child session creation lost admission and cleanup is uncertain")
						: fail("reference_unavailable", "child session creation lost admission and requires explicit recovery");
				}
				const started = this.#createStartedResult(request, manager, 1);
				if (!started.ok) {
					await manager.closeAll();
					await rm(claim.value, { force: true });
					return started;
				}
				this.#children.set(request.agentId, {
					manager,
					workspaceId: request.workspaceReceipt.workspaceId,
					launchRevision: 1,
					launchRequestDigest: request.requestDigest,
					launchResult: structuredClone(started.value),
				});
				return { ok: true, value: started.value };
			},
		);
	}

	public async resume(
		request: AgentResumeLaunchRequest,
		signal?: AbortSignal,
	): Promise<AgentResult<AgentLaunchResult>> {
		if (this.#closed || signal?.aborted) {
			return { ok: true, value: { status: "unavailable", reasonDigest: canonicalDigest("launcher unavailable"), retryable: true } };
		}
		if (request.requestDigest !== canonicalDigest(resumeRequestBody(request))) {
			return fail("launch_failed", "child resume request digest is invalid");
		}
		if (!this.#options.capabilitySubset.validatesDelegation(request.delegationReceipt)) {
			return fail("resume_denied", "child resume delegation receipt is stale or invalid");
		}
		const existing = this.#children.get(request.agentId);
		if (!existing || existing.manager.sessionId() !== request.sessionId || existing.manager.isClosed()) {
			return fail(
				"reference_unavailable",
				"child execution is not resident; this launcher does not claim cross-process worker recovery",
				true,
			);
		}
		return this.#options.workspace.withValidatedWorkspace(
			{
				requestId: request.requestId,
				agentId: request.agentId,
				sessionId: request.sessionId,
				receipt: request.workspaceReceipt,
			},
			async () => {
				const revision = existing.launchRevision + 1;
				const started = this.#createStartedResult(request, existing.manager, revision);
				if (!started.ok) return started;
				existing.launchRevision = revision;
				existing.launchResult = structuredClone(started.value);
				return { ok: true, value: started.value };
			},
		);
	}

	/**
	 * E2E/worker adapter 共用的最小进程边界：只运行 allowlist executable，cwd 固定为
	 * 已验证 child worktree，环境从空集构造，并给每次 invocation 独立 TMPDIR。
	 */
	public async runIsolatedCommand(
		request: ChildIsolatedCommandRequest,
		signal?: AbortSignal,
	): Promise<AgentResult<ChildIsolatedCommandResult>> {
		if (this.#closed || signal?.aborted) return fail("reference_unavailable", "child process launcher is unavailable", true);
		if (!commandIsBounded(request)) return fail("invalid_request", "isolated child command is malformed or oversized");
		const child = this.#children.get(request.agentId);
		if (
			!child ||
			child.manager.isClosed() ||
			child.manager.sessionId() !== request.sessionId ||
			child.workspaceId !== request.workspaceReceipt.workspaceId
		) return fail("reference_unavailable", "isolated child execution is not resident", true);
		const processIsolation = this.#options.processIsolation;
		if (!processIsolation || !processIsolation.allowedExecutables.includes(request.executable)) {
			return fail("delegation_denied", "isolated child executable is not allowlisted");
		}
		const isolationRoot = await this.#isolatedProcessRoot();
		if (!isolationRoot.ok) return isolationRoot;
		return this.#options.workspace.withValidatedWorkspace(
			{
				requestId: request.requestId,
				agentId: request.agentId,
				sessionId: request.sessionId,
				receipt: request.workspaceReceipt,
			},
			async (workspace) => {
				if (
					pathWithin(workspace.envelope.worktreePath, isolationRoot.value) ||
					pathWithin(isolationRoot.value, workspace.envelope.worktreePath)
				) return fail("launch_failed", "child TMPDIR must be disjoint from its writable worktree");
				const invocationTemp = join(
					isolationRoot.value,
					canonicalDigest({
						agentId: request.agentId,
						sessionId: request.sessionId,
						requestId: request.requestId,
					}).slice(0, 48),
				);
				try {
					await mkdir(invocationTemp, { recursive: false, mode: 0o700 });
					const canonicalTemp = resolve(await realpath(invocationTemp));
					if (canonicalTemp !== invocationTemp || !pathWithin(isolationRoot.value, canonicalTemp)) {
						return fail("launch_failed", "child TMPDIR escaped its isolation root");
					}
					const environment: NodeJS.ProcessEnv = {
						RUNLEDGER_CHILD_AGENT_ID: request.agentId,
						RUNLEDGER_CHILD_SESSION_ID: request.sessionId,
						RUNLEDGER_CHILD_WORKSPACE_ID: request.workspaceReceipt.workspaceId,
						TMPDIR: canonicalTemp,
						TMP: canonicalTemp,
						TEMP: canonicalTemp,
					};
					return runBoundedProcess(
						request.executable,
						request.arguments,
						workspace.envelope.cwd,
						environment,
						processIsolation.maxOutputBytes ?? DEFAULT_PROCESS_OUTPUT_BYTES,
						processIsolation.timeoutMs ?? DEFAULT_PROCESS_TIMEOUT_MS,
						signal,
					);
				} catch {
					return fail("reference_unavailable", "child invocation TMPDIR could not be created", true);
				}
			},
		);
	}

	public async cancel(
		request: AgentCancelRequest,
		_signal?: AbortSignal,
	): Promise<AgentResult<ReceiptId>> {
		if (request.requestDigest !== canonicalDigest(cancelRequestBody(request))) {
			return fail("launch_failed", "child cancel request digest is invalid");
		}
		const existing = this.#children.get(request.agentId);
		if (!existing || existing.manager.sessionId() !== request.sessionId) {
			return fail("agent_not_found", "child runtime is not registered");
		}
		try {
			await existing.manager.requestStop("parent cancelled delegated Agent");
			await existing.manager.closeAll();
			this.#children.delete(request.agentId);
			return { ok: true, value: createRuntimeId("receipt", `agent-cancel-${canonicalDigest(request).slice(0, 48)}`) };
		} catch {
			return fail("reference_unavailable", "child runtime cancellation failed", true);
		}
	}

	public snapshots(): readonly ChildSessionRuntimeSnapshot[] {
		return [...this.#children.entries()].map(([agentId, child]) => ({
			agentId,
			sessionId: child.manager.sessionId(),
			workspaceId: child.workspaceId,
			runtimeInstanceId: child.manager.runtimeId(),
			launchRevision: child.launchRevision,
			...(child.manager.writer().currentHead()
				? { eventSequence: child.manager.writer().currentHead()!.sequence }
				: {}),
		}));
	}

	public async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		const children = [...this.#children.values()];
		this.#children.clear();
		await Promise.all(children.map((child) => child.manager.closeAll()));
	}
}
