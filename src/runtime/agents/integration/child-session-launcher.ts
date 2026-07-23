/** 有界 child launcher：从私有 Workspace broker 取 cwd，创建独立 durable V3 session。 */

import { spawn } from "node:child_process";
import { mkdir, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { canonicalDigest } from "../../protocol/v3/canonical-json.ts";
import {
	createRuntimeId,
	isRuntimeId,
	type AgentId,
	type CommandId,
	type ReceiptId,
	type RuntimeInstanceId,
	type SessionId,
} from "../../protocol/v3/ids.ts";
import type { EventCursor } from "../../protocol/v3/events.ts";
import type { RuntimeIdentityContext } from "../../identity/types.ts";
import type { RuntimeFeatureFlags } from "../../runtime-features.ts";
import type { SessionMutationAdmissionGatePort } from "../../lifecycle/mutation-gate.ts";
import { readAllRuntimeEvents } from "../../session/snapshot.ts";
import { V3SessionManager } from "../../../storage/v3-session-manager.ts";
import { buildSessionFileName } from "../../../storage/path-utils.ts";
import { pathWithin } from "../../../worktree/paths.ts";
import {
	classifyChildRuntimeColdRecord,
	createChildRuntimeActivationEvidence,
	createClaimedChildRuntimeAuthorityRecord,
	createCreatingChildRuntimeAuthorityRecord,
	createProvisionalChildRuntimeAuthorityRecord,
	createQuarantinedChildRuntimeAuthorityRecord,
	createReleasedChildRuntimeAuthorityRecord,
	createReleasePendingChildRuntimeAuthorityRecord,
	createResumedChildRuntimeAuthorityRecord,
	createResidentChildRuntimeAuthorityRecord,
	type ChildRuntimeAuthorityRecord,
	type ChildRuntimeAuthorityStorePort,
	type ChildRuntimeActivationEvidence,
	type ChildRuntimeLaunchActivationEvidence,
	type ChildRuntimeResumeActivationEvidence,
	type ChildRuntimeWriterFenceReceipt,
	type ReleasePendingChildRuntimeAuthorityRecord,
	type ResidentChildRuntimeAuthorityRecord,
} from "../child-runtime-authority.ts";
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
	AgentRuntimeActivationHandle,
	AgentRuntimeActivationPort,
	AgentRuntimeActivationReceiptRef,
	AgentRuntimeActivationRequest,
	AgentRuntimeReleaseReceiptRef,
	AgentRuntimeReleaseRequest,
} from "../types.ts";
import type { GatewayBoundCapabilitySubsetEvaluator } from "./capability-subset.ts";
import {
	HeadlessChildRuntimeHost,
	type HeadlessChildRuntimeFactoryPort,
} from "./headless-child-runtime.ts";
import type { ProductionAgentWorkspaceAdapter } from "./worktree-workspace.ts";

export interface ProductionChildSessionLauncherOptions {
	workspace: ProductionAgentWorkspaceAdapter;
	capabilitySubset: GatewayBoundCapabilitySubsetEvaluator;
	parentMutationGate: SessionMutationAdmissionGatePort;
	sessionDir: string;
	features: Readonly<RuntimeFeatureFlags>;
	identity: RuntimeIdentityContext;
	maxActiveChildren: number;
	authorityStore: ChildRuntimeAuthorityStorePort;
	parentAuthority: ChildRuntimeParentAuthorityPort;
	runtimeFactory?: HeadlessChildRuntimeFactoryPort;
	processIsolation?: {
		rootDir: string;
		allowedExecutables: readonly string[];
		maxOutputBytes?: number;
		timeoutMs?: number;
	};
	clock?: () => Date;
}

export interface ChildRuntimeParentAuthorityEvidence {
	parentSessionId: SessionId;
	ownerParentRuntimeId: RuntimeInstanceId;
	parentGraphRevision: number;
	parentGraphCursor: EventCursor;
	parentNodeDigest: string;
	ownerParentWriterFence: ChildRuntimeWriterFenceReceipt;
}

export interface ChildRuntimeParentAuthorityPort {
	readonly parentSessionId: SessionId;
	resolve(
		activation:
			| {
					activationType: "launch";
					request: AgentLaunchRequest;
			  }
			| {
					activationType: "resume";
					request: AgentResumeLaunchRequest;
			  },
	): Promise<AgentResult<ChildRuntimeParentAuthorityEvidence>>;
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
	host?: HeadlessChildRuntimeHost;
	workspaceId: AgentLaunchRequest["workspaceReceipt"]["workspaceId"];
	launchRevision: number;
	launchRequestDigest: string;
	launchResult: Extract<AgentLaunchResult, { status: "started" }>;
	authority:
		| ResidentChildRuntimeAuthorityRecord
		| ReleasePendingChildRuntimeAuthorityRecord;
	activation?: {
		requestDigest: string;
		handle: AgentRuntimeActivationHandle;
	};
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

interface ChildRuntimeActivationOperation {
	requestDigest: string;
	promise: Promise<AgentResult<AgentRuntimeActivationHandle>>;
}

interface ChildRuntimeReleaseOperation {
	requestDigest: string;
	promise: Promise<AgentResult<AgentRuntimeReleaseReceiptRef>>;
}

interface ChildRuntimeLaunchOperation {
	requestDigest: string;
	promise: Promise<AgentResult<AgentLaunchResult>>;
}

interface ChildRuntimeResumeOperation {
	requestDigest: string;
	promise: Promise<AgentResult<AgentLaunchResult>>;
}

interface ChildIsolatedCommandOperation {
	controller: AbortController;
	settled: Promise<void>;
}

interface ChildRuntimeQuarantineAdditionalEvidence {
	provisionalEvidence?: {
		launchReceipt: AgentLaunchReceiptRef;
		residencyReceipt: Extract<
			AgentLaunchResult,
			{ status: "started" }
		>["residencyReceipt"];
		childWriterFence: ChildRuntimeWriterFenceReceipt;
	};
	genesisCursor?: EventCursor;
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

function activationRequestBody(
	request: AgentRuntimeActivationRequest,
): Omit<AgentRuntimeActivationRequest, "requestDigest"> {
	const { requestDigest: _requestDigest, ...body } = request;
	return body;
}

function activationEvidence(
	activationType: "launch",
	request: AgentLaunchRequest,
	parent: ChildRuntimeParentAuthorityEvidence,
): ChildRuntimeLaunchActivationEvidence;
function activationEvidence(
	activationType: "resume",
	request: AgentResumeLaunchRequest,
	parent: ChildRuntimeParentAuthorityEvidence,
): ChildRuntimeResumeActivationEvidence;
function activationEvidence(
	activationType: ChildRuntimeActivationEvidence["activationType"],
	request: AgentLaunchRequest | AgentResumeLaunchRequest,
	parent: ChildRuntimeParentAuthorityEvidence,
): ChildRuntimeActivationEvidence {
	return createChildRuntimeActivationEvidence({
		activationType,
		requestId: request.requestId,
		requestDigest: request.requestDigest,
		parentGraphRevision: parent.parentGraphRevision,
		parentGraphCursor: parent.parentGraphCursor,
		parentNodeDigest: parent.parentNodeDigest,
		delegationReceiptDigest: request.delegationReceipt.receiptDigest,
		workspaceReceiptDigest: request.workspaceReceipt.receiptDigest,
		budgetReservationDigest: canonicalDigest(request.budgetReservation),
		ownerParentWriterFence: parent.ownerParentWriterFence,
	});
}

function writerFenceIdentityMatches(
	previous: ChildRuntimeWriterFenceReceipt,
	current: ChildRuntimeWriterFenceReceipt,
): boolean {
	return (
		previous.authorityId === current.authorityId &&
		previous.tenantId === current.tenantId &&
		previous.sessionId === current.sessionId &&
		previous.runtimeId === current.runtimeId &&
		canonicalDigest(previous.stream) === canonicalDigest(current.stream) &&
		previous.leaseId === current.leaseId &&
		previous.writerEpoch === current.writerEpoch &&
		previous.fencingTokenDigest === current.fencingTokenDigest &&
		previous.acquiredAt === current.acquiredAt &&
		Date.parse(current.expiresAt) >= Date.parse(previous.expiresAt)
	);
}

function parentAuthorityRevalidates(
	previous: ChildRuntimeParentAuthorityEvidence,
	current: ChildRuntimeParentAuthorityEvidence,
): boolean {
	return (
		previous.parentSessionId === current.parentSessionId &&
		previous.ownerParentRuntimeId === current.ownerParentRuntimeId &&
		previous.parentGraphRevision === current.parentGraphRevision &&
		canonicalDigest(previous.parentGraphCursor) ===
			canonicalDigest(current.parentGraphCursor) &&
		previous.parentNodeDigest === current.parentNodeDigest &&
		writerFenceIdentityMatches(
			previous.ownerParentWriterFence,
			current.ownerParentWriterFence,
		)
	);
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

export class ProductionChildSessionLauncher
	implements AgentLauncherPort, AgentRuntimeActivationPort
{
	readonly #options: ProductionChildSessionLauncherOptions;
	readonly #clock: () => Date;
	readonly #children = new Map<AgentId, ChildRuntimeRecord>();
	readonly #launchOperations = new Map<AgentId, ChildRuntimeLaunchOperation>();
	readonly #launchReservations = new Set<AgentId>();
	readonly #resumeOperations = new Map<AgentId, ChildRuntimeResumeOperation>();
	readonly #activationOperations = new Map<
		AgentId,
		ChildRuntimeActivationOperation
	>();
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
			options.maxActiveChildren < 1 ||
			!isRuntimeId(options.parentAuthority.parentSessionId, "session")
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

	async #interruptAndDrainHost(
		child: ChildRuntimeRecord,
	): Promise<AgentResult<void>> {
		if (!child.host) return { ok: true, value: undefined };
		try {
			child.host.interrupt();
			await child.host.drain();
			return { ok: true, value: undefined };
		} catch {
			return fail(
				"reference_unavailable",
				"headless child runtime drain outcome is uncertain",
				true,
			);
		}
	}

	async #readAuthority(
		agentId: AgentId,
	): Promise<AgentResult<ChildRuntimeAuthorityRecord | undefined>> {
		try {
			return {
				ok: true,
				value: await this.#options.authorityStore.read(agentId),
			};
		} catch {
			return fail(
				"reference_unavailable",
				"child runtime authority record is unavailable",
				true,
			);
		}
	}

	async #advanceAuthority<T extends ChildRuntimeAuthorityRecord>(
		previous: ChildRuntimeAuthorityRecord,
		next: T,
		stage: string,
	): Promise<AgentResult<T>> {
		try {
			const advanced = await this.#options.authorityStore.compareAndSwap(
				previous.agentId,
				previous.revision,
				previous.recordDigest,
				next,
			);
			if (advanced === "applied" || advanced === "replay") {
				return { ok: true, value: next };
			}
		} catch {
			// after-commit acknowledgement loss 只能由 exact read-back 消歧。
		}
		const observed = await this.#readAuthority(previous.agentId);
		if (
			observed.ok &&
			observed.value?.recordDigest === next.recordDigest
		) {
			return { ok: true, value: next };
		}
		return fail(
			"reference_unavailable",
			`child runtime authority ${stage} is conflicting or uncertain`,
			true,
		);
	}

	async #quarantineAuthority(
		previous: ChildRuntimeAuthorityRecord,
		reason: string,
		additionalEvidence: ChildRuntimeQuarantineAdditionalEvidence = {},
	): Promise<boolean> {
		if (previous.state === "released" || previous.state === "quarantined") {
			return false;
		}
		let quarantined;
		try {
			quarantined = createQuarantinedChildRuntimeAuthorityRecord({
				previous,
				reason,
				evidenceDigest: canonicalDigest({
					agentId: previous.agentId,
					previousRecordDigest: previous.recordDigest,
					reason,
					...additionalEvidence,
				}),
				...additionalEvidence,
				updatedAt: this.#clock().toISOString(),
			});
		} catch {
			return false;
		}
		const advanced = await this.#advanceAuthority(
			previous,
			quarantined,
			"quarantine",
		);
		return advanced.ok;
	}

	async #closeAndQuarantineUnregisteredManager(
		manager: V3SessionManager,
		previous: ChildRuntimeAuthorityRecord,
		reason: string,
		additionalEvidence: ChildRuntimeQuarantineAdditionalEvidence = {},
	): Promise<boolean> {
		const closed = await manager
			.closeAll()
			.then(() => true, () => false);
		const quarantined = await this.#quarantineAuthority(
			previous,
			reason,
			additionalEvidence,
		);
		return closed && quarantined;
	}

	#coldLaunch(
		record: ChildRuntimeAuthorityRecord,
		request: AgentLaunchRequest,
	): AgentResult<AgentLaunchResult> {
		if (
			record.sessionId !== request.sessionId ||
			record.launchRequestId !== request.requestId ||
			record.launchRequestDigest !== request.requestDigest
		) {
			return fail(
				"idempotency_conflict",
				"child Agent launch identity is already bound to another durable authority record",
			);
		}
		return fail(
			"reference_unavailable",
			record.state === "released"
				? "child runtime is already durably released"
				: `cold child runtime authority is ${record.state} and requires explicit reconciliation`,
			record.state !== "released",
		);
	}

	#coldRelease(
		record: ChildRuntimeAuthorityRecord,
		request: AgentRuntimeReleaseRequest,
	): AgentResult<AgentRuntimeReleaseReceiptRef> {
		if (
			record.agentId !== request.agentId ||
			record.sessionId !== request.sessionId
		) {
			return fail(
				"idempotency_conflict",
				"child runtime authority belongs to another release identity",
			);
		}
		const classified = classifyChildRuntimeColdRecord(record);
		if (classified.kind === "replay_released") {
			return classified.receipt.requestId === request.requestId &&
				classified.receipt.requestDigest === request.requestDigest
				? { ok: true, value: structuredClone(classified.receipt) }
				: fail(
						"idempotency_conflict",
						"child runtime is already released by another request",
					);
		}
		if (
			record.state === "release_pending" &&
			record.releaseRequest.requestDigest !== request.requestDigest
		) {
			return fail(
				"idempotency_conflict",
				"child runtime release is already claimed by another request",
			);
		}
		return fail(
			"reference_unavailable",
			`cold child runtime authority is ${record.state} and cannot be taken over automatically`,
			true,
		);
	}

	async #auditColdAuthority<T>(
		audit: (records: readonly ChildRuntimeAuthorityRecord[]) => T,
	): Promise<AgentResult<T>> {
		try {
			return await this.#options.authorityStore.withExclusiveRootAudit(
				(records) => {
					if (
						records.some(
							(record) =>
								record.authorityId !==
									this.#options.identity.authorityId ||
								record.tenantId !==
									this.#options.identity.tenantId ||
								record.parentSessionId !==
									this.#options.parentAuthority.parentSessionId,
						)
					) {
						return fail(
							"launch_failed",
							"child runtime authority root contains a foreign scope",
						);
					}
					return { ok: true, value: audit(records) };
				},
			);
		} catch {
			return fail(
				"reference_unavailable",
				"child runtime authority startup scan is unavailable",
				true,
			);
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
		if (request.requestDigest !== canonicalDigest(launchRequestBody(request))) {
			return Promise.resolve(
				fail("launch_failed", "child launch request digest is invalid"),
			);
		}
		if (this.#closed) {
			return Promise.resolve({
				ok: true,
				value: {
					status: "unavailable",
					reasonDigest: canonicalDigest("launcher unavailable"),
					retryable: true,
				},
			});
		}
		const inFlight = this.#launchOperations.get(request.agentId);
		if (inFlight) {
			return inFlight.requestDigest === request.requestDigest
				? inFlight.promise
				: Promise.resolve(
						fail(
							"idempotency_conflict",
							"child Agent launch is already in progress for another request",
						),
					);
		}
		const reserved = !this.#children.has(request.agentId);
		if (
			reserved &&
			this.#children.size + this.#launchReservations.size >=
				this.#options.maxActiveChildren
		) {
			return Promise.resolve({
				ok: true,
				value: {
					status: "rejected",
					reasonDigest: canonicalDigest("active child bound reached"),
					retryable: true,
				},
			});
		}
		if (reserved) this.#launchReservations.add(request.agentId);
		const operation = this.#runOperation<AgentLaunchResult>(
			() => this.#launch(request, signal),
			() => ({ ok: true, value: { status: "unavailable", reasonDigest: canonicalDigest("launcher unavailable"), retryable: true } }),
		);
		let coordinated: Promise<AgentResult<AgentLaunchResult>>;
		coordinated = operation.finally(() => {
			if (
				this.#launchOperations.get(request.agentId)?.promise ===
				coordinated
			) {
				this.#launchOperations.delete(request.agentId);
			}
			if (reserved) this.#launchReservations.delete(request.agentId);
		});
		this.#launchOperations.set(request.agentId, {
			requestDigest: request.requestDigest,
			promise: coordinated,
		});
		return coordinated;
	}

	async #launch(
		request: AgentLaunchRequest,
		signal?: AbortSignal,
	): Promise<AgentResult<AgentLaunchResult>> {
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
					const currentAuthority = await this.#readAuthority(request.agentId);
					if (!currentAuthority.ok) return currentAuthority;
					if (currentAuthority.value) {
						return this.#coldLaunch(currentAuthority.value, request);
					}
						let parentAuthority: AgentResult<ChildRuntimeParentAuthorityEvidence>;
						try {
							parentAuthority =
								await this.#options.parentAuthority.resolve({
									activationType: "launch",
									request,
								});
						} catch {
						return fail(
							"reference_unavailable",
							"parent graph authority evidence is unavailable",
							true,
						);
					}
					if (!parentAuthority.ok) return parentAuthority;
					if (
						parentAuthority.value.parentSessionId !==
							this.#options.parentAuthority.parentSessionId ||
						parentAuthority.value.ownerParentWriterFence.authorityId !==
							this.#options.identity.authorityId ||
						parentAuthority.value.ownerParentWriterFence.tenantId !==
							this.#options.identity.tenantId
					) {
						return fail(
							"launch_failed",
							"parent graph authority evidence is outside the launcher scope",
						);
						}
						try {
							await mkdir(this.#options.sessionDir, {
								recursive: true,
								mode: 0o700,
							});
							if (
								resolve(await realpath(this.#options.sessionDir)) !==
								this.#options.sessionDir
							) {
								throw new Error(
									"durable child session root changed identity",
								);
							}
						} catch {
							return fail(
								"reference_unavailable",
								"durable child session root is unavailable",
								true,
							);
						}
						const sessionFilePath = join(
							this.#options.sessionDir,
							buildSessionFileName(
								this.#clock(),
								request.sessionId,
							),
						);
						let claimed;
						try {
							const launchActivation = activationEvidence(
								"launch",
								request,
								parentAuthority.value,
							);
							claimed = createClaimedChildRuntimeAuthorityRecord({
								revision: 1,
								authorityId: this.#options.identity.authorityId,
								tenantId: this.#options.identity.tenantId,
								principalId: this.#options.identity.principalId,
								parentSessionId: parentAuthority.value.parentSessionId,
								parentAgentId: request.parentAgentId,
								agentId: request.agentId,
								sessionId: request.sessionId,
							workspaceId: request.workspaceReceipt.workspaceId,
							runtimeInstanceId:
								workspace.envelope.ownerRuntimeId,
								sessionFilePath,
								launchRequestId: request.requestId,
								launchRequestDigest: request.requestDigest,
								artifactContractDigest:
									request.artifactContract.contractDigest,
								ownerParentRuntimeId:
									parentAuthority.value.ownerParentRuntimeId,
								initialActivationEvidence: launchActivation,
								activationEvidence: launchActivation,
								updatedAt: this.#clock().toISOString(),
							});
					} catch {
						return fail(
							"launch_failed",
							"child runtime authority claim evidence is invalid",
						);
					}
						let began:
							| "applied"
							| "replay"
							| "conflict"
							| undefined;
						try {
							began =
								await this.#options.authorityStore.begin(claimed);
						} catch {
							// after-commit acknowledgement loss 只能由 attempt token + exact readback 消歧。
						}
						const observedClaim = await this.#readAuthority(
							request.agentId,
						);
						const ownsClaim =
							began !== "conflict" &&
							observedClaim.ok &&
							observedClaim.value?.state === "claimed" &&
							observedClaim.value.claimAttemptId ===
								claimed.claimAttemptId &&
							observedClaim.value.recordDigest ===
								claimed.recordDigest;
						if (!ownsClaim) {
							if (
								began === "conflict" &&
								observedClaim.ok &&
								observedClaim.value
							) {
								return this.#coldLaunch(
									observedClaim.value,
									request,
								);
							}
							return fail(
								"reference_unavailable",
								"child runtime authority claim is conflicting or uncertain",
								true,
							);
						}
					if (signal?.aborted || this.#closed) {
						const quarantined = await this.#quarantineAuthority(
							claimed,
							"launch_admission_lost_before_create",
						);
						return quarantined
							? fail(
									"reference_unavailable",
									"parent session child-spawn admission is unavailable",
								)
							: fail(
									"reference_unavailable",
									"child launch claim cleanup is uncertain",
									true,
								);
					}
						let revalidatedParent: AgentResult<ChildRuntimeParentAuthorityEvidence>;
						try {
							revalidatedParent =
								await this.#options.parentAuthority.resolve({
									activationType: "launch",
									request,
								});
						} catch {
							revalidatedParent = fail(
								"reference_unavailable",
								"parent graph authority revalidation is unavailable",
								true,
							);
						}
						if (
							!revalidatedParent.ok ||
							!parentAuthorityRevalidates(
								parentAuthority.value,
								revalidatedParent.value,
							)
						) {
							await this.#quarantineAuthority(
								claimed,
								"parent_authority_changed_before_create",
							);
							return fail(
								"reference_unavailable",
								"parent graph authority changed before child create",
								true,
							);
						}
						const createStartedAt = this.#clock().toISOString();
						let creating;
						try {
							creating =
								createCreatingChildRuntimeAuthorityRecord({
									previous: claimed,
									createStartedAt,
									updatedAt: createStartedAt,
								});
						} catch {
							await this.#quarantineAuthority(
								claimed,
								"create_boundary_invalid",
							);
							return fail(
								"launch_failed",
								"child runtime create boundary is invalid",
							);
						}
						const createAuthorized = await this.#advanceAuthority(
							claimed,
							creating,
							"create boundary",
						);
						if (!createAuthorized.ok) return createAuthorized;
						if (signal?.aborted || this.#closed) {
							const quarantined = await this.#quarantineAuthority(
								creating,
								"launch_admission_lost_before_create",
							);
							return quarantined
								? fail(
										"reference_unavailable",
										"parent session child-spawn admission is unavailable",
									)
								: fail(
										"reference_unavailable",
										"child create boundary cleanup is uncertain",
										true,
									);
						}
						let manager: V3SessionManager;
						try {
							manager = await V3SessionManager.create({
								cwd: workspace.envelope.cwd,
								sessionDir: this.#options.sessionDir,
								filePath: creating.sessionFilePath,
								identity: this.#options.identity,
								sessionId: request.sessionId,
								runtimeId: workspace.envelope.ownerRuntimeId,
								features: this.#options.features,
								writeGenesis: false,
								lineage: {
									goalId: createRuntimeId(
										"goal",
										`delegated-${canonicalDigest({ parentAgentId: request.parentAgentId, agentId: request.agentId }).slice(0, 40)}`,
									),
									agentId: request.agentId,
								},
							});
						} catch {
							const quarantined = await this.#quarantineAuthority(
								creating,
								"session_create_failed",
							);
							return quarantined
								? fail(
										"launch_failed",
										"durable child V3 session could not be created",
										true,
									)
								: fail(
										"reference_unavailable",
										"durable child V3 session create outcome is uncertain",
										true,
									);
						}
							const started = this.#createStartedResult(request, manager, 1);
							if (!started.ok) {
								const recovered =
									await this.#closeAndQuarantineUnregisteredManager(
								manager,
									creating,
									"launch_receipt_invalid",
								);
								return recovered
									? started
									: fail(
											"reference_unavailable",
											"invalid child launch receipt cleanup is uncertain",
											true,
										);
							}
						let provisional;
						try {
							provisional =
								createProvisionalChildRuntimeAuthorityRecord({
									previous: creating,
									launchReceipt: started.value.launchReceipt,
									residencyReceipt:
										started.value.residencyReceipt,
									childWriterFence:
										manager.writerFenceReceipt(),
									updatedAt: this.#clock().toISOString(),
								});
							} catch {
								const recovered =
									await this.#closeAndQuarantineUnregisteredManager(
								manager,
									creating,
									"provisional_evidence_invalid",
								);
								return recovered
									? fail(
											"launch_failed",
											"child runtime provisional evidence is invalid",
										)
									: fail(
											"reference_unavailable",
											"invalid child provisional evidence cleanup is uncertain",
											true,
										);
						}
						const provisioned = await this.#advanceAuthority(
							creating,
							provisional,
							"provisional activation",
						);
						if (!provisioned.ok) {
							await this.#quarantineAuthority(
								creating,
								"provisional_activation_failed",
								{
									provisionalEvidence: {
										launchReceipt:
											provisional.launchReceipt,
										residencyReceipt:
											provisional.residencyReceipt,
										childWriterFence:
											provisional.childWriterFence,
									},
								},
							);
							await manager.closeAll().catch(() => undefined);
							return provisioned;
						}
						let genesisWriteFailed = false;
						let durableGenesisCursor: EventCursor | undefined;
						try {
							await manager.sessionEvents().ensureInitialized();
						} catch {
							genesisWriteFailed = true;
						}
						for (
							let attempt = 0;
							attempt < 2 && !durableGenesisCursor;
							attempt += 1
						) {
							try {
								const flushed =
									await manager.flushCurrentHead();
								if (flushed.ok) {
									durableGenesisCursor =
										flushed.value.cursor;
								} else {
									genesisWriteFailed = true;
								}
							} catch {
								genesisWriteFailed = true;
							}
						}
						let genesisCursor: EventCursor | undefined;
						try {
							const replay = await readAllRuntimeEvents(
								manager.eventStore(),
							);
							const event =
								replay.ok && replay.value.length === 1
									? replay.value[0]
									: undefined;
							const head = manager.writer().currentHead();
							if (
								event?.type === "session.created" &&
								event.sequence === 0 &&
								event.stream.scope === "session" &&
								event.stream.sessionId === request.sessionId &&
								head?.sequence === 0 &&
								head.stream.scope === "session" &&
								head.stream.sessionId === request.sessionId &&
								durableGenesisCursor?.eventId ===
									event.eventId &&
								durableGenesisCursor.eventHash ===
									event.currentEventHash &&
								durableGenesisCursor.sequence === 0 &&
								head.eventId === event.eventId &&
								head.eventHash === event.currentEventHash
							) {
								genesisCursor = head;
							}
						} catch {
							// exact replay 失败时不能把 writer 内存 head 当 durable genesis。
						}
						if (!genesisCursor) {
							await this.#closeAndQuarantineUnregisteredManager(
								manager,
								provisional,
								genesisWriteFailed
									? "genesis_write_failed"
									: "genesis_cursor_unavailable",
							);
							return fail(
								"reference_unavailable",
								"child runtime genesis cursor is unavailable",
								true,
							);
						}
						let host: HeadlessChildRuntimeHost | undefined;
						if (this.#options.runtimeFactory) {
							let prepared;
							try {
								prepared =
									await this.#options.runtimeFactory.prepare({
										manager,
										request,
										workspace,
									});
							} catch {
								prepared = fail<HeadlessChildRuntimeHost>(
									"reference_unavailable",
									"headless child runtime preparation is unavailable",
									true,
								);
							}
							if (
								!prepared.ok ||
								!(
									prepared.value instanceof
									HeadlessChildRuntimeHost
								)
							) {
								const recovered =
									await this.#closeAndQuarantineUnregisteredManager(
										manager,
										provisional,
										"headless_runtime_prepare_failed",
										{ genesisCursor },
									);
								if (!recovered) {
									return fail(
										"reference_unavailable",
										"invalid headless child runtime preparation cleanup is uncertain",
										true,
									);
								}
								return prepared.ok
									? fail(
											"launch_failed",
											"headless child runtime factory returned an invalid host",
										)
									: prepared;
							}
							try {
								await prepared.value.prepare();
							} catch {
								const recovered =
									await this.#closeAndQuarantineUnregisteredManager(
										manager,
										provisional,
										"headless_runtime_prepare_failed",
										{ genesisCursor },
									);
								return recovered
									? fail(
											"reference_unavailable",
											"headless child runtime preparation failed",
											true,
										)
									: fail(
											"reference_unavailable",
											"headless child runtime preparation cleanup is uncertain",
											true,
										);
							}
							host = prepared.value;
						}
						let resident;
						try {
							resident =
								createResidentChildRuntimeAuthorityRecord({
									previous: provisional,
									genesisCursor,
									updatedAt: this.#clock().toISOString(),
								});
						} catch {
							const recovered =
								await this.#closeAndQuarantineUnregisteredManager(
									manager,
									provisional,
									"resident_evidence_invalid",
									{ genesisCursor },
								);
							return recovered
								? fail(
										"launch_failed",
										"child runtime resident evidence is invalid",
									)
								: fail(
										"reference_unavailable",
										"invalid child resident evidence cleanup is uncertain",
										true,
									);
						}
						const activated = await this.#advanceAuthority(
							provisional,
							resident,
							"resident activation",
						);
						if (!activated.ok) {
							await manager.closeAll().catch(() => undefined);
							const observed = await this.#readAuthority(
								request.agentId,
							);
							if (
								observed.ok &&
								observed.value?.state === "provisional" &&
								observed.value.recordDigest ===
									provisional.recordDigest
							) {
								await this.#quarantineAuthority(
									provisional,
									"resident_activation_failed",
									{ genesisCursor },
								);
							}
							return activated;
						}
						if (signal?.aborted || this.#closed) {
							const closed = await manager
								.closeAll()
								.then(() => true, () => false);
							const quarantined =
								await this.#quarantineAuthority(
									resident,
									closed
										? "launch_admission_lost_after_resident"
										: "launch_admission_lost_close_uncertain",
								);
							return closed && quarantined
								? fail(
										"reference_unavailable",
										"child session creation lost admission and requires explicit recovery",
									)
								: fail(
										"reference_unavailable",
										"child session creation lost admission and cleanup is uncertain",
										true,
									);
						}
						this.#children.set(request.agentId, {
							manager,
							...(host ? { host } : {}),
							workspaceId:
								request.workspaceReceipt.workspaceId,
							launchRevision: 1,
							launchRequestDigest: request.requestDigest,
							launchResult: structuredClone(started.value),
							authority: resident,
						});
						return { ok: true, value: started.value };
				},
			);
	}

	public resume(
		request: AgentResumeLaunchRequest,
		signal?: AbortSignal,
	): Promise<AgentResult<AgentLaunchResult>> {
		if (request.requestDigest !== canonicalDigest(resumeRequestBody(request))) {
			return Promise.resolve(
				fail("launch_failed", "child resume request digest is invalid"),
			);
		}
		if (this.#closed) {
			return Promise.resolve({
				ok: true,
				value: {
					status: "unavailable",
					reasonDigest: canonicalDigest("launcher unavailable"),
					retryable: true,
				},
			});
		}
		const inFlight = this.#resumeOperations.get(request.agentId);
		if (inFlight) {
			return inFlight.requestDigest === request.requestDigest
				? inFlight.promise
				: Promise.resolve(
						fail(
							"idempotency_conflict",
							"child Agent resume is already in progress for another request",
						),
					);
		}
		const operation = this.#runOperation<AgentLaunchResult>(
			() => this.#resume(request, signal),
			() => ({ ok: true, value: { status: "unavailable", reasonDigest: canonicalDigest("launcher unavailable"), retryable: true } }),
		);
		let coordinated: Promise<AgentResult<AgentLaunchResult>>;
		coordinated = operation.finally(() => {
			if (
				this.#resumeOperations.get(request.agentId)?.promise ===
				coordinated
			) {
				this.#resumeOperations.delete(request.agentId);
			}
		});
		this.#resumeOperations.set(request.agentId, {
			requestDigest: request.requestDigest,
			promise: coordinated,
		});
		return coordinated;
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
			try {
				const admitted =
					await this.#options.parentMutationGate.revalidate(
						{
							kind: "child_spawn",
							correlationId: request.requestId,
						},
						signal,
					);
				if (!admitted.ok || signal?.aborted || this.#closed) {
					return fail(
						"reference_unavailable",
						"parent session child-resume admission is unavailable",
						true,
					);
				}
			} catch {
				return fail(
					"reference_unavailable",
					"parent session child-resume admission is unavailable",
					true,
				);
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
					if (existing.authority.state !== "resident") {
						return fail(
							"reference_unavailable",
							"child runtime release is in progress or its outcome is uncertain",
							true,
						);
					}
					const durable = await this.#readAuthority(request.agentId);
					if (
						!durable.ok ||
						durable.value?.state !== "resident" ||
						durable.value.recordDigest !==
							existing.authority.recordDigest
					) {
						return fail(
							"reference_unavailable",
							"resident child runtime authority is missing or changed",
							true,
						);
					}
					let parentAuthority: AgentResult<ChildRuntimeParentAuthorityEvidence>;
					try {
						parentAuthority =
							await this.#options.parentAuthority.resolve({
								activationType: "resume",
								request,
							});
					} catch {
						return fail(
							"reference_unavailable",
							"parent graph resume authority evidence is unavailable",
							true,
						);
					}
					if (!parentAuthority.ok) return parentAuthority;
					if (
						parentAuthority.value.parentSessionId !==
							this.#options.parentAuthority.parentSessionId ||
						parentAuthority.value.ownerParentRuntimeId !==
							existing.authority.ownerParentRuntimeId
					) {
						return fail(
							"resume_denied",
							"parent graph resume authority is outside the launcher scope",
						);
					}
					const currentActivation =
						existing.authority.activationEvidence;
					if (currentActivation.requestId === request.requestId) {
						return currentActivation.requestDigest ===
							request.requestDigest
							? {
									ok: true,
									value: structuredClone(
										existing.launchResult,
									),
								}
							: fail(
									"idempotency_conflict",
									"child resume request identity conflicts with durable activation",
								);
					}
					const revision = existing.launchRevision + 1;
					const started = this.#createStartedResult(
						request,
						existing.manager,
						revision,
					);
					if (!started.ok) return started;
					let resumedAuthority;
					try {
						const latestActivation =
							activationEvidence(
								"resume",
								request,
								parentAuthority.value,
							);
						resumedAuthority =
							createResumedChildRuntimeAuthorityRecord({
								previous: existing.authority,
								activationEvidence: latestActivation,
								launchReceipt:
									started.value.launchReceipt,
								residencyReceipt:
									started.value.residencyReceipt,
								childWriterFence:
									existing.manager.writerFenceReceipt(),
								updatedAt: this.#clock().toISOString(),
							});
					} catch {
						return fail(
							"launch_failed",
							"child runtime resume authority evidence is invalid",
						);
					}
					const persisted = await this.#advanceAuthority(
						existing.authority,
						resumedAuthority,
						"resume activation",
					);
					if (!persisted.ok) return persisted;
					existing.authority = resumedAuthority;
					existing.launchRevision = revision;
					existing.launchResult = structuredClone(started.value);
					return { ok: true, value: started.value };
			},
		);
	}

	public activate(
		request: AgentRuntimeActivationRequest,
		signal?: AbortSignal,
	): Promise<AgentResult<AgentRuntimeActivationHandle>> {
		if (
			request.requestDigest !==
				canonicalDigest(activationRequestBody(request))
		) {
			return Promise.resolve(
				fail(
					"invalid_request",
					"child runtime activation request digest is invalid",
				),
			);
		}
		const inFlight = this.#activationOperations.get(request.agentId);
		if (inFlight) {
			return inFlight.requestDigest === request.requestDigest
				? inFlight.promise
				: Promise.resolve(
						fail(
							"idempotency_conflict",
							"child runtime activation is already in progress for another graph head",
						),
					);
		}
		const operation = this.#runOperation(
			() => this.#activate(request, signal),
			() =>
				fail(
					"reference_unavailable",
					"child runtime activation is unavailable",
					true,
				),
		);
		this.#activationOperations.set(request.agentId, {
			requestDigest: request.requestDigest,
			promise: operation,
		});
		const clear = () => {
			if (
				this.#activationOperations.get(request.agentId)?.promise ===
				operation
			) {
				this.#activationOperations.delete(request.agentId);
			}
		};
		void operation.then(clear, clear);
		return operation;
	}

	async #activate(
		request: AgentRuntimeActivationRequest,
		signal?: AbortSignal,
	): Promise<AgentResult<AgentRuntimeActivationHandle>> {
		if (signal?.aborted || this.#closed) {
			return fail(
				"reference_unavailable",
				"child runtime activation was aborted",
				true,
			);
		}
		const child = this.#children.get(request.agentId);
		if (
			!this.#options.runtimeFactory ||
			!child?.host ||
			child.manager.isClosed() ||
			child.manager.sessionId() !== request.sessionId
		) {
			return fail(
				"reference_unavailable",
				"prepared headless child runtime is unavailable",
				true,
			);
		}
		const previous = child.activation;
		if (previous) {
			return previous.requestDigest === request.requestDigest
				? { ok: true, value: previous.handle }
				: fail(
						"idempotency_conflict",
						"child runtime is already activated by another graph head",
					);
		}
		if (
			this.#releaseAttempts.has(request.agentId) ||
			child.authority.state !== "resident" ||
			canonicalDigest(request.launchReceipt) !==
				canonicalDigest(child.launchResult.launchReceipt) ||
			canonicalDigest(request.residencyReceipt) !==
				canonicalDigest(
					child.launchResult.residencyReceipt,
				) ||
			request.residencyReceipt.state !== "resident" ||
			request.residencyReceipt.runtimeInstanceId !==
				child.manager.runtimeId() ||
			!Number.isSafeInteger(request.parentGraphRevision) ||
			request.parentGraphRevision < 1 ||
			request.parentGraphCursor.stream.scope !== "session" ||
			request.parentGraphCursor.stream.sessionId !==
				this.#options.parentAuthority.parentSessionId ||
			!/^[a-f0-9]{64}$/u.test(request.childNodeDigest)
		) {
			return fail(
				"launch_failed",
				"child runtime activation evidence is stale or uncorrelated",
			);
		}

		try {
			await child.host.activate(signal);
		} catch {
			return fail(
				"reference_unavailable",
				"headless child runtime activation outcome is uncertain",
				true,
			);
		}
		const activatedAt = this.#clock().toISOString();
		const body: Omit<
			AgentRuntimeActivationReceiptRef,
			"receiptDigest"
		> = {
			receiptId: createRuntimeId(
				"receipt",
				`agent-runtime-activation-${canonicalDigest({
					requestDigest: request.requestDigest,
					runtimeInstanceId: child.manager.runtimeId(),
				}).slice(0, 40)}`,
			),
			requestId: request.requestId,
			requestDigest: request.requestDigest,
			agentId: request.agentId,
			sessionId: request.sessionId,
			launchReceiptId: request.launchReceipt.receiptId,
			launchRevision: request.launchReceipt.launchRevision,
			residencyReceiptId: request.residencyReceipt.receiptId,
			parentGraphRevision: request.parentGraphRevision,
			parentGraphCursor: structuredClone(
				request.parentGraphCursor,
			),
			childNodeDigest: request.childNodeDigest,
			activatedAt,
		};
		const handle: AgentRuntimeActivationHandle = {
			receipt: {
				...body,
				receiptDigest: canonicalDigest(body),
			},
			completion: child.host.completion(),
		};
		child.activation = {
			requestDigest: request.requestDigest,
			handle,
		};
		return { ok: true, value: handle };
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
		const activating = this.#activationOperations.get(request.agentId);
		if (activating) {
			await activating.promise.catch(() => undefined);
			if (signal?.aborted) {
				return fail(
					"reference_unavailable",
					"child runtime release is unavailable",
					true,
				);
			}
		}
		const authority = await this.#readAuthority(request.agentId);
		if (!authority.ok) return authority;
		if (authority.value?.state === "released") {
			return this.#coldRelease(authority.value, request);
		}
		const existing = this.#children.get(request.agentId);
		if (!existing || existing.manager.sessionId() !== request.sessionId) {
			return authority.value
				? this.#coldRelease(authority.value, request)
				: fail("agent_not_found", "child runtime is not registered");
		}
		if (
			!authority.value ||
			authority.value.recordDigest !== existing.authority.recordDigest
		) {
			return fail(
				"reference_unavailable",
				"resident child runtime authority is missing or changed",
				true,
			);
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
			let pending: ReleasePendingChildRuntimeAuthorityRecord;
			if (existing.authority.state === "release_pending") {
				if (
					existing.authority.releaseRequest.requestDigest !==
					request.requestDigest
				) {
					return fail(
						"idempotency_conflict",
						"child runtime release is already claimed by another request",
					);
				}
				pending = existing.authority;
			} else {
				try {
					pending =
						createReleasePendingChildRuntimeAuthorityRecord({
							previous: existing.authority,
							releaseRequest: request,
							preStopWriterFence:
								existing.manager.writerFenceReceipt(),
							updatedAt: this.#clock().toISOString(),
						});
				} catch {
					return fail(
						"launch_failed",
						"child runtime release authority evidence is invalid",
					);
				}
				const persisted = await this.#advanceAuthority(
					existing.authority,
					pending,
					"release intent",
				);
				if (!persisted.ok) return persisted;
				existing.authority = pending;
			}
			const writerFence = pending.preStopWriterFence;
			this.#releaseAttempts.set(request.agentId, {
				requestDigest: request.requestDigest,
				state: "stop_uncertain",
				writerFence,
			});
			const drainedHost =
				await this.#interruptAndDrainHost(existing);
			if (!drainedHost.ok) return drainedHost;
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
		let writerLeaseReleasedEvidence;
		try {
			writerLeaseReleasedEvidence =
				existing.manager.writerLeaseReleasedEvidence();
		} catch {
			return fail(
				"reference_unavailable",
				"child writer lease release evidence is unavailable",
				true,
			);
		}
		const releasedAt = writerLeaseReleasedEvidence.releasedAt;
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
		const pending = existing.authority;
		if (pending.state !== "release_pending") {
			return fail(
				"reference_unavailable",
				"child runtime release intent vanished before completion",
				true,
			);
		}
		let releasedAuthority;
		try {
			releasedAuthority =
				createReleasedChildRuntimeAuthorityRecord({
					previous: pending,
					releaseReceipt: receipt,
					writerLeaseReleasedEvidence,
					updatedAt: releasedAt,
				});
		} catch {
			return fail(
				"launch_failed",
				"child runtime released authority evidence is invalid",
			);
		}
		const persisted = await this.#advanceAuthority(
			pending,
			releasedAuthority,
			"release completion",
		);
		if (!persisted.ok) return persisted;
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
		const body: Omit<AgentRuntimeReleaseRequest, "requestDigest"> = {
			requestId: request.requestId,
			agentId: request.agentId,
			sessionId: request.sessionId,
			launchReceipt: existing.launchResult.launchReceipt,
			previousResidencyReceipt:
				existing.launchResult.residencyReceipt,
			reason: "stopped",
		};
		const released = await this.release(
			{ ...body, requestDigest: canonicalDigest(body) },
			signal,
		);
		return released.ok
			? { ok: true, value: released.value.receiptId }
			: released;
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

	/** Startup 只接受可 cold replay 的 released authority；任何 partial/resident 状态先恢复再暴露。 */
	public async auditAuthority(): Promise<void> {
		const audited = await this.#auditColdAuthority(
			(records) =>
				records.filter((record) => record.state !== "released").length,
		);
		if (!audited.ok) {
			throw new Error(
				`production child runtime authority audit failed: ${audited.error.code}`,
			);
		}
		if (audited.value > 0) {
			throw new Error(
				`production child runtime authority audit requires explicit recovery for ${audited.value} cold partial or resident runtime(s)`,
			);
		}
	}

	/**
	 * Production composition 的 fail-closed shutdown 原语。closed latch + operation
	 * drain 固定本地视图，cold/local 空判断在 authority root 排他 fence 内完成。
	 */
	public async closeIfIdle(): Promise<void> {
		const reopenOnFailure = !this.#closed;
		this.#closed = true;
		await this.#drainOperations();
		const cold = await this.#auditColdAuthority((records) => ({
			activeChildren: this.#children.size,
			partialChildren: records.filter(
				(record) => record.state !== "released",
			).length,
		}));
		if (
			!cold.ok ||
			cold.value.activeChildren > 0 ||
			cold.value.partialChildren > 0
		) {
			if (reopenOnFailure) this.#closed = false;
			if (!cold.ok) {
				throw new Error(
					`production Agent supervisor close could not audit child runtime authority: ${cold.error.code}`,
				);
			}
			throw new Error(
				`production Agent supervisor close requires governed terminal cleanup for ${Math.max(cold.value.activeChildren, cold.value.partialChildren)} active or cold-partial child runtime(s)`,
			);
		}
	}

	public async close(): Promise<void> {
		this.#closed = true;
		await this.#drainOperations();
		const children = [...this.#children.entries()];
		const closed = await Promise.allSettled(
			children.map(async ([agentId, child]) => {
				const quarantined = await this.#quarantineAuthority(
					child.authority,
					"launcher_forced_close",
				);
				if (!quarantined) {
					throw new Error(
						"child runtime authority quarantine failed before forced close",
					);
				}
				const drainedHost =
					await this.#interruptAndDrainHost(child);
				if (!drainedHost.ok) {
					throw new Error(drainedHost.error.message);
				}
				await this.#abortAndDrainIsolatedCommands(agentId);
				await child.manager.closeAll();
			}),
		);
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
