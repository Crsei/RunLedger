/** Sandbox plan 的 digest、路径边界与 final-leaf 验证共用原语。 */

import { isAbsolute, normalize, resolve } from "node:path";
import { canonicalDigest } from "../../runtime/protocol/canonical-json.ts";
import type { RuntimeDigest } from "../../runtime/protocol/foundation.ts";
import type {
	SandboxBackend,
	SandboxDecisionReceipt,
	SandboxDigestInput,
	SandboxError,
	SandboxFailure,
	SandboxLaunchPlan,
	SandboxPrepareRequest,
	SandboxPrepareResult,
	SandboxResolutionState,
	SandboxResult,
} from "./types.ts";

export function digestOf(value: unknown): RuntimeDigest {
	return { algorithm: "sha256", digest: canonicalDigest(value) as RuntimeDigest["digest"] };
}

export function normalizeDigest(value: SandboxDigestInput, field: string): SandboxResult<RuntimeDigest> {
	if (typeof value === "string") {
		if (!/^[a-f0-9]{64}$/u.test(value)) return failure("invalid_request", `${field} must be a sha256 hex digest`);
		return { ok: true, value: { algorithm: "sha256", digest: value as RuntimeDigest["digest"] } };
	}
	if (value.algorithm !== "sha256" || !/^[a-f0-9]{64}$/u.test(value.digest)) {
		return failure("invalid_request", `${field} must be a sha256 digest`);
	}
	return { ok: true, value };
}

export function pathWithin(root: string, candidate: string): boolean {
	const normalizedRoot = normalize(root);
	const normalizedCandidate = normalize(candidate);
	return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot.endsWith("/") ? normalizedRoot : `${normalizedRoot}/`}`);
}

function validAbsolutePath(value: string): boolean {
	return isAbsolute(value) && !value.includes("\0") && !value.includes("\n") && !value.includes("\r");
}

function normalizedPaths(values: readonly string[], field: string): SandboxResult<readonly string[]> {
	if (values.some((value) => !validAbsolutePath(value))) return failure("path_escape", `${field} must contain absolute paths only`);
	return { ok: true, value: [...new Set(values.map((value) => resolve(value)))].sort() };
}

export interface NormalizedSandboxRequest {
	readonly requested: SandboxPrepareRequest["requested"];
	readonly resolved: SandboxPrepareRequest["requested"];
	readonly policyDigest: RuntimeDigest;
	readonly requestDigest: RuntimeDigest;
	readonly workspaceRoot: string;
	readonly cwd: string;
	readonly readRoots: readonly string[];
	readonly writeRoots: readonly string[];
	readonly denyRead: readonly string[];
	readonly protectedPaths: readonly string[];
	readonly network: SandboxPrepareRequest["network"];
	readonly command: string;
	readonly environment: Readonly<Record<string, string>>;
	readonly timeoutMs: number;
	readonly stdin?: string;
}

export function normalizePrepareRequest(request: SandboxPrepareRequest): SandboxResult<NormalizedSandboxRequest> {
	if (request.command.length === 0) return failure("invalid_request", "sandbox command must not be empty");
	if (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs < 0) return failure("invalid_request", "sandbox timeout must be a non-negative safe integer");
	if (!validAbsolutePath(request.workspace.worktreePath)) return failure("path_escape", "workspace worktree path must be absolute");
	const workspaceRoot = resolve(request.workspace.worktreePath);
	if (!validAbsolutePath(request.cwd)) return failure("path_escape", "sandbox cwd must be absolute");
	const cwd = resolve(request.cwd);
	if (!pathWithin(workspaceRoot, cwd)) return failure("path_escape", "sandbox cwd is outside the workspace root");

	const policyDigest = normalizeDigest(request.policyDigest, "policyDigest");
	if (!policyDigest.ok) return policyDigest;
	const requestDigest = request.requestDigest === undefined
		? { ok: true as const, value: digestOf(requestDigestBody(request)) }
		: normalizeDigest(request.requestDigest, "requestDigest");
	if (!requestDigest.ok) return requestDigest;

	const readRoots = normalizedPaths(request.readRoots, "readRoots");
	if (!readRoots.ok) return readRoots;
	const writeRoots = normalizedPaths(request.writeRoots, "writeRoots");
	if (!writeRoots.ok) return writeRoots;
	const denyRead = normalizedPaths(request.denyRead, "denyRead");
	if (!denyRead.ok) return denyRead;
	const denyWrite = normalizedPaths(request.denyWrite, "denyWrite");
	if (!denyWrite.ok) return denyWrite;
	const providedProtected = normalizedPaths(request.protectedPaths, "protectedPaths");
	if (!providedProtected.ok) return providedProtected;

	if (writeRoots.value.some((root) => !pathWithin(workspaceRoot, root))) {
		return failure("path_escape", "sandbox writable roots must be contained by the workspace root");
	}
	if (request.resolved === "off" && request.requested !== "off") {
		return failure("invalid_request", "a restrictive request cannot resolve to builtin-none/off");
	}
	const resolved = request.resolved ?? request.requested;
	// protectedPaths 由 Security snapshot/Host composition 提供。不要在这里
	// 合成可能不存在的 mount source；Linux bwrap 的 --ro-bind 对缺失 source
	// 会在 final leaf 之后直接失败。denyWrite 仍然视为同等 protected path。
	const protectedPaths = [...new Set([
		...providedProtected.value,
		...denyWrite.value,
	])].sort();
	const environment = Object.fromEntries(Object.entries(request.environment).sort(([left], [right]) => left.localeCompare(right)));
	return {
		ok: true,
		value: {
			requested: request.requested,
			resolved,
			policyDigest: policyDigest.value,
			requestDigest: requestDigest.value,
			workspaceRoot,
			cwd,
			readRoots: [...new Set([workspaceRoot, ...readRoots.value])].sort(),
			writeRoots: writeRoots.value,
			denyRead: denyRead.value,
			protectedPaths,
			network: request.network,
			command: request.command,
			environment,
			timeoutMs: request.timeoutMs,
			...(request.stdin === undefined ? {} : { stdin: request.stdin }),
		},
	};
}

function requestDigestBody(request: SandboxPrepareRequest): Record<string, unknown> {
	return {
		requested: request.requested,
		resolved: request.resolved ?? request.requested,
		policyDigest: request.policyDigest,
		workspace: request.workspace,
		readRoots: request.readRoots,
		writeRoots: request.writeRoots,
		denyRead: request.denyRead,
		denyWrite: request.denyWrite,
		protectedPaths: request.protectedPaths,
		network: request.network,
		command: request.command,
		cwd: request.cwd,
		environment: request.environment,
		timeoutMs: request.timeoutMs,
		...(request.stdin === undefined ? {} : { stdin: request.stdin }),
	};
}

export function createResolutionState(
	backendId: string,
	requested: NormalizedSandboxRequest["requested"],
	resolved: NormalizedSandboxRequest["resolved"],
	effective: NormalizedSandboxRequest["resolved"],
	enforcement: SandboxResolutionState["enforcement"],
	reason?: string,
): SandboxResolutionState {
	return {
		backendId,
		requested,
		resolved,
		effective,
		enforcement,
		...(reason === undefined ? {} : { reason }),
	};
}

export function makeFailure(
	code: SandboxError["code"],
	message: string,
	state?: SandboxResolutionState,
	): SandboxFailure {
	return {
		ok: false,
		error: {
			code,
			message,
			retryable: false,
			...(state === undefined ? {} : { state }),
		},
	};
}

export const failure = makeFailure;

function planBody(plan: SandboxLaunchPlan): Omit<SandboxLaunchPlan, "planDigest"> {
	const { planDigest: _planDigest, ...body } = plan;
	return body;
}

export function launchPlanDigest(plan: SandboxLaunchPlan): RuntimeDigest {
	return digestOf(planBody(plan));
}

function finalLeafBody(plan: SandboxLaunchPlan): Record<string, unknown> {
	return {
		backendId: plan.backendId,
		program: plan.program,
		arguments: plan.arguments,
		cwd: plan.cwd,
		environment: plan.environment,
		requestDigest: plan.requestDigest,
		planDigest: plan.planDigest,
	};
}

function receiptDigest(receipt: Omit<SandboxDecisionReceipt, "receiptDigest">): RuntimeDigest {
	return digestOf(receipt);
}

export function createDecisionReceipt(
	plan: SandboxLaunchPlan,
	decision: SandboxDecisionReceipt["decision"],
	requestDigest: RuntimeDigest,
	error?: SandboxError,
): SandboxDecisionReceipt {
	const body = {
		backendId: plan.backendId,
		requested: plan.requested,
		resolved: plan.resolved,
		effective: plan.effective,
		enforcement: plan.enforcement,
		...(plan.reason === undefined ? {} : { reason: plan.reason }),
		decision,
		policyDigest: plan.policyDigest,
		requestDigest,
		planDigest: plan.planDigest,
		finalLeafDigest: digestOf(finalLeafBody(plan)),
		...(error === undefined ? {} : { error }),
	};
	return { ...body, receiptDigest: receiptDigest(body) };
}

export function validateFinalLeaf(
	plan: SandboxLaunchPlan,
	requestDigest: SandboxDigestInput,
	backend: SandboxBackend,
): SandboxDecisionReceipt {
	const normalizedRequestDigest = normalizeDigest(requestDigest, "requestDigest");
	if (!normalizedRequestDigest.ok) {
		return createDecisionReceipt(plan, "deny", plan.requestDigest, normalizedRequestDigest.error);
	}
	if (plan.backendId !== "builtin-none" && plan.backendId !== backend.backendId) {
		const error = makeFailure("plan_tampered", "launch plan backend does not belong to this backend").error;
		return createDecisionReceipt(plan, "deny", normalizedRequestDigest.value, error);
	}
	if (plan.requestDigest.digest !== normalizedRequestDigest.value.digest) {
		const error = makeFailure("request_digest_mismatch", "final leaf request digest does not match the prepared plan").error;
		return createDecisionReceipt(plan, "deny", normalizedRequestDigest.value, error);
	}
	if (launchPlanDigest(plan).digest !== plan.planDigest.digest) {
		const error = makeFailure("plan_tampered", "launch plan digest does not match its immutable body").error;
		return createDecisionReceipt(plan, "deny", normalizedRequestDigest.value, error);
	}
	return createDecisionReceipt(plan, plan.enforcement === "off" ? "off" : "allow", normalizedRequestDigest.value);
}

export function makePlan(
	state: SandboxResolutionState,
	request: NormalizedSandboxRequest,
	program: string,
	argumentsList: readonly string[],
): SandboxLaunchPlan {
	const body = {
		...state,
		policyDigest: request.policyDigest,
		requestDigest: request.requestDigest,
		program,
		arguments: [...argumentsList],
		command: request.command,
		cwd: request.cwd,
		environment: request.environment,
		timeoutMs: request.timeoutMs,
		workspaceRoot: request.workspaceRoot,
		readRoots: request.readRoots,
		writeRoots: request.resolved === "read-only" ? [] : request.writeRoots,
		denyRead: request.denyRead,
		protectedPaths: request.protectedPaths,
		network: request.network,
		...(request.stdin === undefined ? {} : { stdin: request.stdin }),
	};
	const plan = { ...body, planDigest: digestOf(body) };
	return plan;
}

export function offPlan(request: NormalizedSandboxRequest, shellProgram: string): SandboxLaunchPlan {
	return makePlan(
		createResolutionState("builtin-none", request.requested, "off", "off", "off", "explicit builtin-none/off request"),
		request,
		shellProgram,
		["-lc", request.command],
	);
}

export function unavailableState(
	backendId: string,
	request: NormalizedSandboxRequest,
	message: string,
): SandboxResolutionState {
	return createResolutionState(backendId, request.requested, request.resolved, request.resolved, "unavailable", message);
}

export function unavailableResult(
	backendId: string,
	request: NormalizedSandboxRequest,
	message: string,
): SandboxPrepareResult {
	const state = unavailableState(backendId, request, message);
	return makeFailure("sandbox_unavailable", message, state);
}

export function pathForSubpath(value: string): string {
	return resolve(value);
}
