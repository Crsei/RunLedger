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
	AgentRuntimeReleaseReceiptRef,
	AgentRuntimeReleaseRequest,
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

type ChildRuntimeReleaseAttempt =
	| {
			requestDigest: string;
			state: "stop_uncertain";
			writerFence: ReturnType<V3SessionManager["writerFenceReceipt"]>;
	  }
	| {
			requestDigest: string;
			state: "stopped";
			writerFence: ReturnType<V3SessionManager["writerFenceReceipt"]>;
			finalCursor: NonNullable<AgentRuntimeReleaseReceiptRef["finalCursor"]>;
	  };

interface ChildRuntimeReleaseTombstone {
	requestDigest: string;
	receipt: AgentRuntimeReleaseReceiptRef;
}

interface ChildRuntimeReleaseOperation {
	requestDigest: string;
	promise: Promise<AgentResult<AgentRuntimeReleaseReceiptRef>>;
}

interface ChildIsolatedCommandOperation {
	controller: AbortController;
	settled: Promise<void>;
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

function releaseRequestBody(
	request: AgentRuntimeReleaseRequest,
): Omit<AgentRuntimeReleaseRequest, "requestDigest"> {
	const { requestDigest: _requestDigest, ...body } = request;
	return body;
}

function residencyReceiptDigestIsValid(receipt: AgentRuntimeReleaseRequest["previousResidencyReceipt"]): boolean {
	const { receiptDigest, ...body } = receipt;
	return receiptDigest === canonicalDigest(body);
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
const WINDOWS_PROCESS_ISOLATION_UNAVAILABLE = "child process tree isolation is unavailable on Windows without a Job Object";

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

function killIsolatedProcessGroup(child: ReturnType<typeof spawn>): void {
	const pid = child.pid;
	if (
		process.platform !== "win32" &&
		typeof pid === "number" &&
		Number.isSafeInteger(pid) &&
		pid > 1 &&
		pid !== process.pid
	) {
		try {
			process.kill(-pid, "SIGKILL");
			return;
		} catch {
			// group 已退出或尚不可寻址时，仅回退到明确的 child PID，绝不触碰父进程组。
		}
	}
	try {
		child.kill("SIGKILL");
	} catch {
		// spawn error、ESRCH 与并发退出都视为终止已落定。
	}
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
	if (process.platform === "win32") {
		return fail("reference_unavailable", WINDOWS_PROCESS_ISOLATION_UNAVAILABLE);
	}
	return new Promise((resolveResult) => {
		let stdout = "";
		let stderr = "";
		let outputBytes = 0;
		let exceeded = false;
		let timedOut = false;
		let settled = false;
		let killRequested = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let child: ReturnType<typeof spawn>;
		try {
			child = spawn(executable, [...args], {
				cwd,
				env: environment,
				detached: true,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
			});
		} catch {
			resolveResult(fail("launch_failed", "isolated child process could not start", true));
			return;
		}
		const terminate = () => {
			if (killRequested) return;
			killRequested = true;
			killIsolatedProcessGroup(child);
		};
		const stdoutStream = child.stdout;
		const stderrStream = child.stderr;
		if (!stdoutStream || !stderrStream) {
			terminate();
			resolveResult(fail("launch_failed", "isolated child process pipes are unavailable", true));
			return;
		}
		const finish = (result: AgentResult<ChildIsolatedCommandResult>) => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			signal?.removeEventListener("abort", abort);
			resolveResult(result);
		};
		const append = (target: "stdout" | "stderr", chunk: Buffer) => {
			outputBytes += chunk.byteLength;
			if (outputBytes > maxOutputBytes) {
				exceeded = true;
				terminate();
				return;
			}
			if (target === "stdout") stdout += chunk.toString("utf8");
			else stderr += chunk.toString("utf8");
		};
		stdoutStream.on("data", (chunk: Buffer) => append("stdout", chunk));
		stderrStream.on("data", (chunk: Buffer) => append("stderr", chunk));
		child.once("error", () => {
			terminate();
			finish(fail("launch_failed", "isolated child process could not start", true));
		});
		child.once("close", (exitCode, exitSignal) => {
			if (exceeded) return finish(fail("launch_failed", "isolated child process output exceeded its bound"));
			if (timedOut) return finish(fail("launch_failed", "isolated child process exceeded its timeout", true));
			if (signal?.aborted) return finish(fail("reference_unavailable", "isolated child process was aborted", true));
			return finish({ ok: true, value: { exitCode, exitSignal, stdout, stderr } });
		});
		timer = setTimeout(() => {
			timedOut = true;
			terminate();
		}, timeoutMs);
		timer.unref();
		const abort = () => terminate();
		if (signal?.aborted) abort();
		else signal?.addEventListener("abort", abort, { once: true });
	});
}

export class ProductionChildSessionLauncher implements AgentLauncherPort {
	readonly #options: ProductionChildSessionLauncherOptions;
	readonly #clock: () => Date;
	readonly #children = new Map<AgentId, ChildRuntimeRecord>();
	readonly #releaseAttempts = new Map<AgentId, ChildRuntimeReleaseAttempt>();
	readonly #releaseOperations = new Map<AgentId, ChildRuntimeReleaseOperation>();
	readonly #released = new Map<AgentId, ChildRuntimeReleaseTombstone>();
	readonly #isolatedCommands = new Map<AgentId, Set<ChildIsolatedCommandOperation>>();
	readonly #operationDrainWaiters = new Set<() => void>();
	#activeOperations = 0;
	#closed = false;

	public constructor(options: ProductionChildSessionLauncherOptions) {
		if (
			!exactAbsolutePath(options.sessionDir) ||
			!Number.isSafeInteger(options.maxActiveChildren) ||
			options.maxActiveChildren < 1
		) {
			throw new RangeError("production child launcher requires an absolute session root and positive active-child bound");
		}
		if (options.processIsolation) {
			if (process.platform === "win32") {
				throw new RangeError(WINDOWS_PROCESS_ISOLATION_UNAVAILABLE);
			}
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

	#runOperation<T>(
		operation: () => Promise<AgentResult<T>>,
		unavailable: () => AgentResult<T>,
	): Promise<AgentResult<T>> {
		if (this.#closed) return Promise.resolve(unavailable());
		this.#activeOperations += 1;
		return operation().finally(() => {
			this.#activeOperations -= 1;
			if (this.#activeOperations !== 0) return;
			for (const resolveDrain of this.#operationDrainWaiters) resolveDrain();
			this.#operationDrainWaiters.clear();
		});
	}

	#drainOperations(): Promise<void> {
		if (this.#activeOperations === 0) return Promise.resolve();
		return new Promise((resolveDrain) => this.#operationDrainWaiters.add(resolveDrain));
	}

	async #runTrackedIsolatedCommand(
		agentId: AgentId,
		executable: string,
		args: readonly string[],
		cwd: string,
		environment: NodeJS.ProcessEnv,
		maxOutputBytes: number,
		timeoutMs: number,
		callerSignal?: AbortSignal,
	): Promise<AgentResult<ChildIsolatedCommandResult>> {
		const controller = new AbortController();
		const abortFromCaller = () => controller.abort(callerSignal?.reason);
		if (callerSignal?.aborted) abortFromCaller();
		else callerSignal?.addEventListener("abort", abortFromCaller, { once: true });

		let resolveSettled!: () => void;
		const operation: ChildIsolatedCommandOperation = {
			controller,
			settled: new Promise<void>((resolve) => {
				resolveSettled = resolve;
			}),
		};
		const operations = this.#isolatedCommands.get(agentId) ?? new Set<ChildIsolatedCommandOperation>();
		operations.add(operation);
		this.#isolatedCommands.set(agentId, operations);
		try {
			return await runBoundedProcess(
				executable,
				args,
				cwd,
				environment,
				maxOutputBytes,
				timeoutMs,
				controller.signal,
			);
		} finally {
			callerSignal?.removeEventListener("abort", abortFromCaller);
			operations.delete(operation);
			if (operations.size === 0 && this.#isolatedCommands.get(agentId) === operations) {
				this.#isolatedCommands.delete(agentId);
			}
			resolveSettled();
		}
	}

	async #abortAndDrainIsolatedCommands(agentId: AgentId): Promise<void> {
		while (true) {
			const operations = [...(this.#isolatedCommands.get(agentId) ?? [])];
			if (operations.length === 0) return;
			for (const operation of operations) {
				operation.controller.abort("child runtime release requested");
			}
			await Promise.all(operations.map((operation) => operation.settled));
		}
	}

	async #claimDurableSession(sessionId: AgentLaunchRequest["sessionId"]): Promise<AgentResult<string>> {
		try {
			await mkdir(this.#options.sessionDir, { recursive: true, mode: 0o700 });
			const canonicalSessionDir = resolve(await realpath(this.#options.sessionDir));
			if (canonicalSessionDir !== this.#options.sessionDir) {
				return fail("launch_failed", "durable child session root changed identity");
			}
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

	public launch(
		request: AgentLaunchRequest,
		signal?: AbortSignal,
	): Promise<AgentResult<AgentLaunchResult>> {
		return this.#runOperation(
			() => this.#launch(request, signal),
			() => ({ ok: true, value: { status: "unavailable", reasonDigest: canonicalDigest("launcher unavailable"), retryable: true } }),
		);
	}

	async #launch(
		request: AgentLaunchRequest,
		signal?: AbortSignal,
	): Promise<AgentResult<AgentLaunchResult>> {
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
			if (this.#releaseAttempts.has(request.agentId)) {
				return fail("reference_unavailable", "child runtime release is in progress or its outcome is uncertain", true);
			}
			return existing.launchRequestDigest === request.requestDigest && existing.manager.sessionId() === request.sessionId
				? { ok: true, value: structuredClone(existing.launchResult) }
				: fail("launch_failed", "child Agent launch identity is already bound to another runtime");
		}
		if (this.#children.size >= this.#options.maxActiveChildren) {
			return { ok: true, value: { status: "rejected", reasonDigest: canonicalDigest("active child bound reached"), retryable: true } };
		}
		return this.#options.workspace.withValidatedWorkspace<AgentLaunchResult>(
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
						runtimeId: workspace.envelope.ownerRuntimeId,
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

	public resume(
		request: AgentResumeLaunchRequest,
		signal?: AbortSignal,
	): Promise<AgentResult<AgentLaunchResult>> {
		return this.#runOperation(
			() => this.#resume(request, signal),
			() => ({ ok: true, value: { status: "unavailable", reasonDigest: canonicalDigest("launcher unavailable"), retryable: true } }),
		);
	}

	async #resume(
		request: AgentResumeLaunchRequest,
		signal?: AbortSignal,
	): Promise<AgentResult<AgentLaunchResult>> {
		if (signal?.aborted) {
			return { ok: true, value: { status: "unavailable", reasonDigest: canonicalDigest("launcher unavailable"), retryable: true } };
		}
		if (request.requestDigest !== canonicalDigest(resumeRequestBody(request))) {
			return fail("launch_failed", "child resume request digest is invalid");
		}
		if (!this.#options.capabilitySubset.validatesDelegation(request.delegationReceipt)) {
			return fail("resume_denied", "child resume delegation receipt is stale or invalid");
		}
		if (this.#releaseAttempts.has(request.agentId)) {
			return fail("reference_unavailable", "child runtime release is in progress or its outcome is uncertain", true);
		}
		const existing = this.#children.get(request.agentId);
		if (!existing || existing.manager.sessionId() !== request.sessionId || existing.manager.isClosed()) {
			return fail(
				"reference_unavailable",
				"child execution is not resident; this launcher does not claim cross-process worker recovery",
				true,
			);
		}
		return this.#options.workspace.withValidatedWorkspace<AgentLaunchResult>(
			{
				requestId: request.requestId,
				agentId: request.agentId,
				sessionId: request.sessionId,
				receipt: request.workspaceReceipt,
			},
			async () => {
				if (signal?.aborted || this.#closed) {
					return { ok: true, value: { status: "unavailable", reasonDigest: canonicalDigest("launcher unavailable"), retryable: true } };
				}
				if (
					this.#releaseAttempts.has(request.agentId) ||
					this.#children.get(request.agentId) !== existing ||
					existing.manager.isClosed()
				) {
					return fail("reference_unavailable", "child runtime release is in progress or its outcome is uncertain", true);
				}
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
	public runIsolatedCommand(
		request: ChildIsolatedCommandRequest,
		signal?: AbortSignal,
	): Promise<AgentResult<ChildIsolatedCommandResult>> {
		return this.#runOperation(
			() => this.#runIsolatedCommand(request, signal),
			() => fail("reference_unavailable", "child process launcher is unavailable", true),
		);
	}

	async #runIsolatedCommand(
		request: ChildIsolatedCommandRequest,
		signal?: AbortSignal,
	): Promise<AgentResult<ChildIsolatedCommandResult>> {
		if (signal?.aborted) return fail("reference_unavailable", "child process launcher is unavailable", true);
		if (!commandIsBounded(request)) return fail("invalid_request", "isolated child command is malformed or oversized");
		if (process.platform === "win32") {
			return fail("reference_unavailable", WINDOWS_PROCESS_ISOLATION_UNAVAILABLE);
		}
		if (this.#releaseAttempts.has(request.agentId)) {
			return fail("reference_unavailable", "child runtime release is in progress or its outcome is uncertain", true);
		}
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
		if (signal?.aborted) return fail("reference_unavailable", "child process launcher is unavailable", true);
		if (
			this.#releaseAttempts.has(request.agentId) ||
			this.#children.get(request.agentId) !== child ||
			child.manager.isClosed()
		) {
			return fail("reference_unavailable", "child runtime release is in progress or its outcome is uncertain", true);
		}
		return this.#options.workspace.withValidatedWorkspace(
			{
				requestId: request.requestId,
				agentId: request.agentId,
				sessionId: request.sessionId,
				receipt: request.workspaceReceipt,
			},
			async (workspace) => {
				if (signal?.aborted) {
					return fail("reference_unavailable", "child process launcher is unavailable", true);
				}
				if (
					this.#releaseAttempts.has(request.agentId) ||
					this.#children.get(request.agentId) !== child ||
					child.manager.isClosed()
				) {
					return fail("reference_unavailable", "child runtime release is in progress or its outcome is uncertain", true);
				}
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
					if (signal?.aborted) {
						return fail("reference_unavailable", "child process launcher is unavailable", true);
					}
					if (
						this.#releaseAttempts.has(request.agentId) ||
						this.#children.get(request.agentId) !== child ||
						child.manager.isClosed()
					) {
						return fail("reference_unavailable", "child runtime release is in progress or its outcome is uncertain", true);
					}
					const environment: NodeJS.ProcessEnv = {
						RUNLEDGER_CHILD_AGENT_ID: request.agentId,
						RUNLEDGER_CHILD_SESSION_ID: request.sessionId,
						RUNLEDGER_CHILD_WORKSPACE_ID: request.workspaceReceipt.workspaceId,
						TMPDIR: canonicalTemp,
						TMP: canonicalTemp,
						TEMP: canonicalTemp,
					};
					return this.#runTrackedIsolatedCommand(
						request.agentId,
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

	public release(
		request: AgentRuntimeReleaseRequest,
		signal?: AbortSignal,
	): Promise<AgentResult<AgentRuntimeReleaseReceiptRef>> {
		if (request.requestDigest !== canonicalDigest(releaseRequestBody(request))) {
			return Promise.resolve(fail("invalid_request", "child runtime release request digest is invalid"));
		}
		const inFlight = this.#releaseOperations.get(request.agentId);
		if (inFlight) {
			return inFlight.requestDigest === request.requestDigest
				? inFlight.promise
				: Promise.resolve(fail("idempotency_conflict", "child runtime release is already in progress for another request"));
		}
		const released = this.#released.get(request.agentId);
		if (released) {
			return Promise.resolve(released.requestDigest === request.requestDigest && released.receipt.sessionId === request.sessionId
				? { ok: true, value: structuredClone(released.receipt) }
				: fail("idempotency_conflict", "child runtime is already released by another request"));
		}

		let startOperation!: () => void;
		const promise = new Promise<AgentResult<AgentRuntimeReleaseReceiptRef>>((resolveOperation, rejectOperation) => {
			startOperation = () => {
				void this.#runOperation(
					() => this.#release(request, signal),
					() => fail("reference_unavailable", "child runtime release is unavailable", true),
				).then(
					(result) => {
						if (this.#releaseOperations.get(request.agentId)?.promise === promise) {
							this.#releaseOperations.delete(request.agentId);
						}
						resolveOperation(result);
					},
					(cause: unknown) => {
						if (this.#releaseOperations.get(request.agentId)?.promise === promise) {
							this.#releaseOperations.delete(request.agentId);
						}
						rejectOperation(cause);
					},
				);
			};
		});
		this.#releaseOperations.set(request.agentId, {
			requestDigest: request.requestDigest,
			promise,
		});
		startOperation();
		return promise;
	}

	async #release(
		request: AgentRuntimeReleaseRequest,
		signal?: AbortSignal,
	): Promise<AgentResult<AgentRuntimeReleaseReceiptRef>> {
		if (signal?.aborted) {
			return fail("reference_unavailable", "child runtime release is unavailable", true);
		}
		const existing = this.#children.get(request.agentId);
		if (!existing || existing.manager.sessionId() !== request.sessionId) {
			return fail("agent_not_found", "child runtime is not registered");
		}
		if (
			request.launchReceipt.agentId !== request.agentId ||
			request.launchReceipt.sessionId !== request.sessionId ||
			canonicalDigest(request.launchReceipt) !== canonicalDigest(existing.launchResult.launchReceipt) ||
			request.previousResidencyReceipt.agentId !== request.agentId ||
			request.previousResidencyReceipt.sessionId !== request.sessionId ||
			request.previousResidencyReceipt.runtimeInstanceId !== existing.manager.runtimeId() ||
			request.previousResidencyReceipt.revision < existing.launchResult.residencyReceipt.revision ||
			!residencyReceiptDigestIsValid(request.previousResidencyReceipt)
		) {
			return fail("launch_failed", "child runtime release receipts are stale or uncorrelated");
		}

		let attempt = this.#releaseAttempts.get(request.agentId);
		if (attempt && attempt.requestDigest !== request.requestDigest) {
			return fail("idempotency_conflict", "child runtime release is already in progress for another request");
		}
		if (attempt?.state === "stop_uncertain") {
			return fail("reference_unavailable", "child runtime stop outcome is uncertain", true);
		}
		if (!attempt) {
			const writerFence = existing.manager.writerFenceReceipt();
			this.#releaseAttempts.set(request.agentId, {
				requestDigest: request.requestDigest,
				state: "stop_uncertain",
				writerFence,
			});
			await this.#abortAndDrainIsolatedCommands(request.agentId);
			try {
				await existing.manager.requestStop(`delegated Agent runtime ${request.reason}`);
			} catch {
				return fail("reference_unavailable", "child runtime stop failed", true);
			}
			const finalCursor = existing.manager.writer().currentHead();
			if (
				!finalCursor ||
				finalCursor.stream.scope !== "session" ||
				finalCursor.stream.sessionId !== request.sessionId
			) {
				return fail("reference_unavailable", "child runtime stop cursor is unavailable", true);
			}
			attempt = {
				requestDigest: request.requestDigest,
				state: "stopped",
				writerFence,
				finalCursor,
			};
			this.#releaseAttempts.set(request.agentId, attempt);
		}

		try {
			await existing.manager.closeAll();
		} catch {
			return fail("reference_unavailable", "child runtime release failed", true);
		}
		const releasedAt = this.#clock().toISOString();
		const residency = createAgentResidencyReceipt({
			agentId: request.agentId,
			sessionId: request.sessionId,
			runtimeInstanceId: existing.manager.runtimeId(),
			state: "nonresident",
			revision: request.previousResidencyReceipt.revision + 1,
			observedAt: releasedAt,
			reasonDigest: canonicalDigest({
				requestDigest: request.requestDigest,
				reason: request.reason,
				launchReceiptId: request.launchReceipt.receiptId,
			}),
		});
		if (!residency.ok) return residency;
		const body: Omit<AgentRuntimeReleaseReceiptRef, "receiptDigest"> = {
			receiptId: createRuntimeId(
				"receipt",
				`agent-runtime-release-${canonicalDigest({
					requestDigest: request.requestDigest,
					runtimeInstanceId: existing.manager.runtimeId(),
					writerFenceReceiptId: attempt.writerFence.receiptId,
				}).slice(0, 40)}`,
			),
			requestId: request.requestId,
			requestDigest: request.requestDigest,
			agentId: request.agentId,
			sessionId: request.sessionId,
			runtimeInstanceId: existing.manager.runtimeId(),
			launchReceiptId: request.launchReceipt.receiptId,
			launchRevision: request.launchReceipt.launchRevision,
			writerFenceReceiptId: attempt.writerFence.receiptId,
			writerFenceReceiptDigest: attempt.writerFence.receiptDigest,
			finalCursor: attempt.finalCursor,
			residencyReceipt: residency.value,
			releasedAt,
		};
		const receipt: AgentRuntimeReleaseReceiptRef = {
			...body,
			receiptDigest: canonicalDigest(body),
		};
		this.#released.set(request.agentId, {
			requestDigest: request.requestDigest,
			receipt: structuredClone(receipt),
		});
		this.#releaseAttempts.delete(request.agentId);
		if (this.#children.get(request.agentId) === existing) this.#children.delete(request.agentId);
		return { ok: true, value: receipt };
	}

	public cancel(
		request: AgentCancelRequest,
		signal?: AbortSignal,
	): Promise<AgentResult<ReceiptId>> {
		return this.#runOperation(
			() => this.#cancel(request, signal),
			() => fail("reference_unavailable", "child runtime cancellation is unavailable", true),
		);
	}

	async #cancel(
		request: AgentCancelRequest,
		signal?: AbortSignal,
	): Promise<AgentResult<ReceiptId>> {
		if (request.requestDigest !== canonicalDigest(cancelRequestBody(request))) {
			return fail("launch_failed", "child cancel request digest is invalid");
		}
		if (signal?.aborted) return fail("reference_unavailable", "child runtime cancellation is unavailable", true);
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

	/**
	 * Production composition 的 fail-closed shutdown 原语。检查与 closed latch 在同一
	 * 同步调用栈内完成，避免先观察 snapshots、再被并发 spawn 插入 resident child。
	 */
	public async closeIfIdle(): Promise<void> {
		const reopenOnFailure = !this.#closed;
		this.#closed = true;
		await this.#drainOperations();
		if (this.#children.size > 0) {
			if (reopenOnFailure) this.#closed = false;
			throw new Error(
				`production Agent supervisor close requires governed terminal cleanup for ${this.#children.size} active child runtime(s)`,
			);
		}
	}

	public async close(): Promise<void> {
		this.#closed = true;
		await this.#drainOperations();
		const children = [...this.#children.entries()];
		const closed = await Promise.allSettled(children.map(([, child]) => child.manager.closeAll()));
		const errors: unknown[] = [];
		for (const [index, result] of closed.entries()) {
			const [agentId, child] = children[index]!;
			if (result.status === "fulfilled") {
				if (this.#children.get(agentId) === child) this.#children.delete(agentId);
			} else {
				errors.push(result.reason);
			}
		}
		if (errors.length > 0) throw new AggregateError(errors, "production child launcher close failed");
	}
}
