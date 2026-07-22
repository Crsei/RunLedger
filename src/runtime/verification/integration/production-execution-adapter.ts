/** Production Verification 的 typed invocation 物化与 sandbox 结果捕获。 */

import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { Check } from "typebox/value";
import type { Static } from "typebox";
import type {
	SandboxExecutionReceiptRef,
	SandboxExecutorPort,
	SandboxExecutorRequest,
	SandboxExecutorResult,
	SecurityPortCancelRequest,
	SecurityPortCancelResult,
} from "../../protocol/v3/capability.ts";
import { canonicalDigest } from "../../protocol/v3/canonical-json.ts";
import { createRuntimeId, parseRuntimeId } from "../../protocol/v3/ids.ts";
import type { WorkspaceExecutionEnvelope } from "../../protocol/v3/workspace.ts";
import type { ArtifactRef } from "../../protocol/v3/capability.ts";
import type { ArtifactEvidenceReceipt, CandidateIdentity, GateManifest, TrustedBaselineReceipt, VerificationCoreResult, VerificationExecutionEvidence, VerificationInvocation, VerificationRunnerIdentity } from "../types.ts";
import { isTrustedBaselineReceipt } from "../baseline.ts";
import { VerificationInvocationSchema } from "../evidence.ts";
import { isGateManifest, isSafeGateRelativePath } from "../gate-loader.ts";
import { isVerificationInvocationCorrelated } from "../runner.ts";
import { pathWithin } from "../../../security/policy-filesystem.ts";
import {
	RuntimeSandboxExecutorAdapter,
	type RuntimeSandboxContextPort,
	type RuntimeSandboxInvocation,
} from "../../../security/integration/runtime-sandbox-adapter.ts";
import type {
	SandboxBackend,
	SandboxLaunchPlan,
	SandboxPrepareRequest,
	SandboxProcessResult,
} from "../../../security/sandbox/types.ts";

const DEFAULT_MAX_TRUSTED_FILE_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_CAPTURED_OUTPUT_BYTES = 512 * 1024;
const ENVIRONMENT_NAME = /^[A-Z_][A-Z0-9_]*$/u;

function failure<T>(
	code: "invalid_schema" | "invalid_digest" | "scope_mismatch" | "baseline_unavailable" | "workspace_invalid" | "sandbox_unavailable" | "evidence_unavailable",
	message: string,
	retryable = false,
): VerificationCoreResult<T> {
	return { ok: false, error: { code, message, retryable } };
}

function errorCode(cause: unknown): string | undefined {
	return cause instanceof Error && "code" in cause ? String(cause.code) : undefined;
}

function sameCanonical(left: unknown, right: unknown): boolean {
	try {
		return canonicalDigest(left) === canonicalDigest(right);
	} catch {
		return false;
	}
}

function sha256(content: Uint8Array): string {
	return createHash("sha256").update(content).digest("hex");
}

export interface TrustedVerificationExecutionContext {
	manifest: GateManifest;
	baseline: TrustedBaselineReceipt;
	candidate: CandidateIdentity;
	candidateEnvelope: WorkspaceExecutionEnvelope;
	/** readonly checkout 的 canonical root，必须与 baseline receipt 一致。 */
	baselineRoot: string;
	/** Runtime 管理并已纳入 sandbox write roots 的 canonical output root。 */
	artifactOutputRoot: string;
	/** trusted_runner 环境值的权威来源；candidate 不能覆盖。 */
	trustedEnvironment: Readonly<Record<string, string>>;
}

export interface TrustedVerificationExecutionResolveRequest {
	request: SandboxExecutorRequest;
	invocation: VerificationInvocation;
}

export interface TrustedVerificationExecutionResolverPort {
	resolve(
		request: TrustedVerificationExecutionResolveRequest,
	): Promise<VerificationCoreResult<TrustedVerificationExecutionContext>>;
}

export interface VerificationCommandMaterializerPort {
	materialize(executable: string, arguments_: readonly string[]): VerificationCoreResult<string>;
}

function posixQuote(value: string): string | undefined {
	if (value.includes("\0")) return undefined;
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** Linux/macOS backend 最终都经 /bin/sh -lc；每个 argv 必须独立 quote。 */
export class PosixVerificationCommandMaterializer implements VerificationCommandMaterializerPort {
	public materialize(executable: string, arguments_: readonly string[]): VerificationCoreResult<string> {
		if (!isAbsolute(executable) || arguments_.length > 256) {
			return failure("invalid_schema", "verification command contains an invalid executable or too many arguments");
		}
		const values = [executable, ...arguments_];
		if (values.some((value) => value.length > 16_384)) {
			return failure("invalid_schema", "verification command argument exceeds the bounded size");
		}
		const quoted = values.map(posixQuote);
		if (quoted.some((value) => value === undefined)) {
			return failure("invalid_schema", "verification command contains NUL");
		}
		return { ok: true, value: (quoted as string[]).join(" ") };
	}
}

export interface VerificationExpectedOutputPath {
	name: string;
	path: string;
}

export interface VerificationExecutionRecord {
	requestId: VerificationInvocation["requestId"];
	invocationDigest: string;
	status: "completed" | "unavailable";
	reason?: string;
	invocation: VerificationInvocation;
	manifest: GateManifest;
	baseline: TrustedBaselineReceipt;
	candidateEnvelope: WorkspaceExecutionEnvelope;
	artifactOutputRoot: string;
	expectedOutputPaths: readonly VerificationExpectedOutputPath[];
	materializedInvocation: RuntimeSandboxInvocation;
	materializedInvocationDigest: string;
	innerSandboxReceipt: SandboxExecutionReceiptRef;
	sandboxReceipt: SandboxExecutionReceiptRef;
	processResult?: SandboxProcessResult;
	startedAt: string;
	finishedAt: string;
}

export interface VerificationEvidenceCaptureRecord {
	requestId: VerificationInvocation["requestId"];
	invocationDigest: string;
	stdoutArtifact: ArtifactRef;
	stderrArtifact: ArtifactRef;
	artifacts: readonly ArtifactEvidenceReceipt[];
	evidence: VerificationExecutionEvidence;
}

export interface VerificationExecutionRecordStorePort {
	preflight(): Promise<VerificationCoreResult<void>>;
	recordExecution(record: VerificationExecutionRecord): Promise<VerificationCoreResult<void>>;
	resolveExecution(
		requestId: VerificationInvocation["requestId"],
		invocationDigest: string,
	): Promise<VerificationCoreResult<VerificationExecutionRecord | undefined>>;
	recordEvidence(capture: VerificationEvidenceCaptureRecord): Promise<VerificationCoreResult<void>>;
	resolveEvidence(
		requestId: VerificationInvocation["requestId"],
		invocationDigest: string,
	): Promise<VerificationCoreResult<VerificationEvidenceCaptureRecord | undefined>>;
}

/** 测试与单进程 composition 可用；生产部署应替换为 durable store。 */
export class MemoryVerificationExecutionRecordStore implements VerificationExecutionRecordStorePort {
	readonly #executions = new Map<string, VerificationExecutionRecord>();
	readonly #evidence = new Map<string, VerificationEvidenceCaptureRecord>();

	#key(requestId: VerificationInvocation["requestId"], invocationDigest: string): string {
		return `${requestId}/${invocationDigest}`;
	}

	public preflight(): Promise<VerificationCoreResult<void>> {
		return Promise.resolve({ ok: true, value: undefined });
	}

	public recordExecution(record: VerificationExecutionRecord): Promise<VerificationCoreResult<void>> {
		const key = this.#key(record.requestId, record.invocationDigest);
		const existing = this.#executions.get(key);
		if (existing && !sameCanonical(existing, record)) {
			return Promise.resolve(failure("evidence_unavailable", "verification execution record conflicts with an existing record"));
		}
		this.#executions.set(key, record);
		return Promise.resolve({ ok: true, value: undefined });
	}

	public resolveExecution(
		requestId: VerificationInvocation["requestId"],
		invocationDigest: string,
	): Promise<VerificationCoreResult<VerificationExecutionRecord | undefined>> {
		return Promise.resolve({ ok: true, value: this.#executions.get(this.#key(requestId, invocationDigest)) });
	}

	public recordEvidence(capture: VerificationEvidenceCaptureRecord): Promise<VerificationCoreResult<void>> {
		const key = this.#key(capture.requestId, capture.invocationDigest);
		if (!this.#executions.has(key)) {
			return Promise.resolve(failure("evidence_unavailable", "verification evidence has no execution record"));
		}
		const existing = this.#evidence.get(key);
		if (existing && !sameCanonical(existing, capture)) {
			return Promise.resolve(failure("evidence_unavailable", "verification evidence conflicts with an existing capture"));
		}
		this.#evidence.set(key, capture);
		return Promise.resolve({ ok: true, value: undefined });
	}

	public resolveEvidence(
		requestId: VerificationInvocation["requestId"],
		invocationDigest: string,
	): Promise<VerificationCoreResult<VerificationEvidenceCaptureRecord | undefined>> {
		return Promise.resolve({ ok: true, value: this.#evidence.get(this.#key(requestId, invocationDigest)) });
	}
}

interface MutableSandboxCapture {
	prepareCalls: number;
	spawnCalls: number;
	plan?: SandboxLaunchPlan;
	processResult?: SandboxProcessResult;
}

class CapturingSandboxBackend implements SandboxBackend {
	readonly #delegate: SandboxBackend;
	readonly #context = new AsyncLocalStorage<MutableSandboxCapture>();

	public constructor(delegate: SandboxBackend) {
		this.#delegate = delegate;
	}

	public run<T>(capture: MutableSandboxCapture, callback: () => Promise<T>): Promise<T> {
		return this.#context.run(capture, callback);
	}

	public probe(): ReturnType<SandboxBackend["probe"]> {
		return this.#delegate.probe();
	}

	public async prepare(request: SandboxPrepareRequest): ReturnType<SandboxBackend["prepare"]> {
		const capture = this.#context.getStore();
		if (capture) capture.prepareCalls += 1;
		const result = await this.#delegate.prepare(request);
		if (capture && result.ok) capture.plan = result.value;
		return result;
	}

	public async spawn(plan: SandboxLaunchPlan, signal?: AbortSignal): ReturnType<SandboxBackend["spawn"]> {
		const capture = this.#context.getStore();
		if (capture) capture.spawnCalls += 1;
		const result = await this.#delegate.spawn(plan, signal);
		if (capture && result.ok) capture.processResult = result.value;
		return result;
	}
}

interface ValidatedPath {
	path: string;
	stats: Stats;
}

async function canonicalDirectory(path: string, label: string): Promise<VerificationCoreResult<string>> {
	if (!isAbsolute(path) || resolve(path) !== path || path.includes("\0")) {
		return failure("invalid_schema", `${label} is not an absolute canonical path`);
	}
	try {
		const [canonical, stats] = await Promise.all([realpath(path), lstat(path)]);
		if (resolve(canonical) !== path || !stats.isDirectory() || stats.isSymbolicLink()) {
			return failure("workspace_invalid", `${label} is not a canonical non-symlink directory`);
		}
		return { ok: true, value: path };
	} catch {
		return failure("workspace_invalid", `${label} is unavailable`, true);
	}
}

async function existingPathWithin(
	root: string,
	relativePath: string,
	label: string,
): Promise<VerificationCoreResult<ValidatedPath>> {
	if (!isSafeGateRelativePath(relativePath)) return failure("invalid_schema", `${label} is not a safe relative path`);
	const lexical = resolve(root, relativePath);
	if (!pathWithin(root, lexical)) return failure("scope_mismatch", `${label} escapes its trusted root`);
	try {
		const [canonical, stats] = await Promise.all([realpath(lexical), lstat(lexical)]);
		if (resolve(canonical) !== lexical || !pathWithin(root, canonical) || stats.isSymbolicLink()) {
			return failure("scope_mismatch", `${label} resolves through a symlink or escapes its trusted root`);
		}
		return { ok: true, value: { path: lexical, stats } };
	} catch {
		return failure("workspace_invalid", `${label} is unavailable`, true);
	}
}

async function trustedFile(
	root: string,
	relativePath: string,
	expectedDigest: string,
	label: string,
	maxBytes: number,
	requireExecutable = false,
): Promise<VerificationCoreResult<string>> {
	const resolved = await existingPathWithin(root, relativePath, label);
	if (!resolved.ok) return resolved;
	const { path, stats } = resolved.value;
	if (!stats.isFile() || stats.size > maxBytes || (requireExecutable && (Number(stats.mode) & 0o111) === 0)) {
		return failure("baseline_unavailable", `${label} is not a bounded regular executable/file`);
	}
	let content: Uint8Array;
	try {
		content = await readFile(path);
	} catch {
		return failure("baseline_unavailable", `${label} cannot be read`, true);
	}
	if (content.byteLength !== stats.size || sha256(content) !== expectedDigest) {
		return failure("invalid_digest", `${label} digest does not match the trusted GateManifest`);
	}
	return { ok: true, value: path };
}

function decodeVerificationInvocation(value: unknown): VerificationInvocation | undefined {
	if (!Check(VerificationInvocationSchema, value)) return undefined;
	const decoded = value as Static<typeof VerificationInvocationSchema>;
	const requestId = parseRuntimeId("command", decoded.requestId);
	const verificationId = parseRuntimeId("verification", decoded.verificationId);
	const authorityId = parseRuntimeId("authority", decoded.candidate.authorityId);
	const tenantId = parseRuntimeId("tenant", decoded.candidate.tenantId);
	const repositoryId = parseRuntimeId("repository", decoded.candidate.repositoryId);
	const workspaceId = parseRuntimeId("workspace", decoded.candidate.workspaceId);
	if (!requestId || !verificationId || !authorityId || !tenantId || !repositoryId || !workspaceId) return undefined;
	return {
		...decoded,
		requestId,
		verificationId,
		candidate: {
			...decoded.candidate,
			authorityId,
			tenantId,
			repositoryId,
			workspaceId,
		},
	};
}

function environmentFor(
	invocation: VerificationInvocation,
	context: TrustedVerificationExecutionContext,
): VerificationCoreResult<Readonly<Record<string, string>>> {
	if (!sameCanonical(invocation.environmentAllowlist, context.manifest.environment.allowlist)) {
		return failure("scope_mismatch", "verification environment allowlist differs from the trusted GateManifest");
	}
	const expected = new Map<string, string>();
	for (const entry of context.manifest.environment.values) {
		const value = entry.source === "fixed" ? entry.value : context.trustedEnvironment[entry.name];
		if (value === undefined) return failure("baseline_unavailable", `trusted environment value is unavailable: ${entry.name}`);
		expected.set(entry.name, value);
	}
	if (invocation.environment.length !== expected.size) {
		return failure("scope_mismatch", "verification environment does not contain the exact trusted values");
	}
	const output: Record<string, string> = {};
	for (const entry of invocation.environment) {
		if (
			!ENVIRONMENT_NAME.test(entry.name) ||
			entry.value.includes("\0") ||
			entry.value.length > 16_384 ||
			output[entry.name] !== undefined ||
			expected.get(entry.name) !== entry.value
		) return failure("scope_mismatch", `verification environment value is not trusted: ${entry.name}`);
		output[entry.name] = entry.value;
	}
	return { ok: true, value: Object.freeze(output) };
}

function invocationMatchesContext(
	request: SandboxExecutorRequest,
	invocation: VerificationInvocation,
	context: TrustedVerificationExecutionContext,
): boolean {
	const { manifest, baseline, candidate, candidateEnvelope: envelope } = context;
	return (
		isGateManifest(manifest) &&
		isTrustedBaselineReceipt(baseline) &&
		isVerificationInvocationCorrelated(invocation, manifest, baseline) &&
		sameCanonical(invocation.candidate, candidate) &&
		sameCanonical(invocation.executable, manifest.executable) &&
		sameCanonical(invocation.arguments, manifest.arguments) &&
		sameCanonical(invocation.cwd, manifest.cwd) &&
		sameCanonical(invocation.baseConfiguration, manifest.baseConfiguration) &&
		sameCanonical(invocation.dependencyPolicy, manifest.dependencyPolicy) &&
		sameCanonical(invocation.secretScanPolicy, manifest.secretScanPolicy) &&
		sameCanonical(invocation.network, manifest.network) &&
		sameCanonical(invocation.sandbox, manifest.sandbox) &&
		invocation.timeoutMs === manifest.timeoutMs &&
		sameCanonical(invocation.expectedExitCodes, manifest.expectedExitCodes) &&
		sameCanonical(invocation.expectedArtifacts, manifest.expectedArtifacts) &&
		request.authorityId === candidate.authorityId &&
		request.tenantId === candidate.tenantId &&
		request.principalId === envelope.principalId &&
		request.requestId === invocation.requestId &&
		request.invocationDigest === invocation.invocationDigest &&
		request.profile.authorityId === request.authorityId &&
		request.profile.tenantId === request.tenantId &&
		request.profile.requested === manifest.sandbox.profile &&
		request.profile.policyDigest === manifest.sandbox.policyDigest &&
		envelope.authorityId === candidate.authorityId &&
		envelope.tenantId === candidate.tenantId &&
		envelope.repositoryId === candidate.repositoryId &&
		envelope.workspaceId === candidate.workspaceId &&
		envelope.baseCommit === candidate.baseCommit &&
		baseline.authorityId === candidate.authorityId &&
		baseline.tenantId === candidate.tenantId &&
		baseline.repositoryId === candidate.repositoryId &&
		baseline.baseCommit === candidate.baseCommit &&
		baseline.workspaceId !== candidate.workspaceId &&
		baseline.bindingDigest !== candidate.bindingDigest
	);
}

function unavailableReceipt(
	request: SandboxExecutorRequest,
	reason: string,
	backendId = "production-verification-adapter",
): SandboxExecutionReceiptRef {
	return {
		authorityId: request.authorityId,
		tenantId: request.tenantId,
		principalId: request.principalId,
		receiptId: createRuntimeId(
			"receipt",
			`verification-sandbox-unavailable-${canonicalDigest({ requestId: request.requestId, invocationDigest: request.invocationDigest, reason }).slice(0, 40)}`,
		),
		requestId: request.requestId,
		profileId: request.profile.profileId,
		requested: request.profile.requested,
		resolved: request.profile.requested,
		policyDigest: request.profile.policyDigest,
		backendId,
		effectiveEnforcement: "unavailable",
		invocationDigest: request.invocationDigest,
		reasonDigest: canonicalDigest(reason),
	};
}

function outerReceipt(
	request: SandboxExecutorRequest,
	inner: SandboxExecutionReceiptRef,
	processResult: SandboxProcessResult,
): SandboxExecutionReceiptRef {
	const body = {
		authorityId: request.authorityId,
		tenantId: request.tenantId,
		principalId: request.principalId,
		receiptId: createRuntimeId(
			"receipt",
			`verification-sandbox-${canonicalDigest({ requestId: request.requestId, inner, processResult }).slice(0, 48)}`,
		),
		requestId: request.requestId,
		profileId: request.profile.profileId,
		requested: inner.requested,
		resolved: inner.resolved,
		policyDigest: request.profile.policyDigest,
		backendId: inner.backendId,
		effectiveEnforcement: inner.effectiveEnforcement,
		invocationDigest: request.invocationDigest,
	};
	return inner.effectiveEnforcement === "degraded" || inner.effectiveEnforcement === "unavailable"
		? { ...body, effectiveEnforcement: inner.effectiveEnforcement, reasonDigest: inner.reasonDigest ?? canonicalDigest("sandbox enforcement unavailable") }
		: body;
}

function backendLaunchIsUncertain(plan: SandboxLaunchPlan | undefined, result: SandboxProcessResult | undefined): boolean {
	if (!plan || !result || result.exitCode === 0) return false;
	if (plan.backendId === "linux-bwrap" && /^bwrap:/imu.test(result.stderr)) return true;
	if (plan.backendId === "macos-seatbelt" && /^(?:sandbox-exec|seatbelt):/imu.test(result.stderr)) return true;
	return false;
}

export interface ProductionVerificationSandboxExecutorAdapterOptions {
	backend: SandboxBackend;
	sandboxContext: RuntimeSandboxContextPort;
	resolver: TrustedVerificationExecutionResolverPort;
	records: VerificationExecutionRecordStorePort;
	materializer?: VerificationCommandMaterializerPort;
	maxTrustedFileBytes?: number;
	maxCapturedOutputBytes?: number;
	clock?: () => Date;
}

interface MaterializedExecution {
	invocation: RuntimeSandboxInvocation;
	outputRoot: string;
	outputPaths: readonly VerificationExpectedOutputPath[];
}

export class ProductionVerificationSandboxExecutorAdapter implements SandboxExecutorPort {
	readonly #resolver: TrustedVerificationExecutionResolverPort;
	readonly #records: VerificationExecutionRecordStorePort;
	readonly #materializer: VerificationCommandMaterializerPort;
	readonly #maxTrustedFileBytes: number;
	readonly #maxCapturedOutputBytes: number;
	readonly #clock: () => Date;
	readonly #capturingBackend: CapturingSandboxBackend;
	readonly #inner: RuntimeSandboxExecutorAdapter;
	readonly #terminal = new Map<SandboxExecutorRequest["requestId"], { invocationDigest: string; result: SandboxExecutorResult }>();

	public constructor(options: ProductionVerificationSandboxExecutorAdapterOptions) {
		this.#resolver = options.resolver;
		this.#records = options.records;
		this.#materializer = options.materializer ?? new PosixVerificationCommandMaterializer();
		this.#maxTrustedFileBytes = options.maxTrustedFileBytes ?? DEFAULT_MAX_TRUSTED_FILE_BYTES;
		this.#maxCapturedOutputBytes = options.maxCapturedOutputBytes ?? DEFAULT_MAX_CAPTURED_OUTPUT_BYTES;
		this.#clock = options.clock ?? (() => new Date());
		this.#capturingBackend = new CapturingSandboxBackend(options.backend);
		this.#inner = new RuntimeSandboxExecutorAdapter(this.#capturingBackend, options.sandboxContext);
	}

	#finish(request: SandboxExecutorRequest, receipt: SandboxExecutionReceiptRef): SandboxExecutorResult {
		const result: SandboxExecutorResult = {
			authorityId: request.authorityId,
			tenantId: request.tenantId,
			principalId: request.principalId,
			requestId: request.requestId,
			resolutionReceiptId: createRuntimeId(
				"receipt",
				`verification-resolution-${canonicalDigest({ requestId: request.requestId, resolutionDigest: request.resolutionDigest }).slice(0, 48)}`,
			),
			executionReceipt: receipt,
		};
		this.#terminal.set(request.requestId, { invocationDigest: request.invocationDigest, result });
		return result;
	}

	async #materialize(
		request: SandboxExecutorRequest,
		invocation: VerificationInvocation,
		context: TrustedVerificationExecutionContext,
	): Promise<VerificationCoreResult<MaterializedExecution>> {
		const baselineRoot = await canonicalDirectory(context.baselineRoot, "trusted baseline root");
		if (!baselineRoot.ok) return baselineRoot;
		const candidateRoot = await canonicalDirectory(context.candidateEnvelope.worktreePath, "candidate workspace root");
		if (!candidateRoot.ok) return candidateRoot;
		const outputRoot = await canonicalDirectory(context.artifactOutputRoot, "verification Artifact output root");
		if (!outputRoot.ok) return outputRoot;
		if (
			baselineRoot.value !== context.baseline.protectedRoot ||
			pathWithin(candidateRoot.value, baselineRoot.value) ||
			pathWithin(baselineRoot.value, candidateRoot.value) ||
			pathWithin(candidateRoot.value, outputRoot.value) ||
			pathWithin(outputRoot.value, candidateRoot.value) ||
			pathWithin(baselineRoot.value, outputRoot.value) ||
			pathWithin(outputRoot.value, baselineRoot.value)
		) return failure("scope_mismatch", "baseline, candidate, and Artifact output roots are not independent");

		const executable = await trustedFile(
			baselineRoot.value,
			invocation.executable.path,
			invocation.executable.digest,
			"trusted verification executable",
			this.#maxTrustedFileBytes,
			true,
		);
		if (!executable.ok) return executable;
		for (const configuration of invocation.baseConfiguration) {
			const checked = await trustedFile(
				baselineRoot.value,
				configuration.path,
				configuration.digest,
				`trusted base configuration ${configuration.path}`,
				this.#maxTrustedFileBytes,
			);
			if (!checked.ok) return checked;
		}
		const lockfile = invocation.dependencyPolicy;
		if (lockfile.lockfileSource === "trusted_baseline" && lockfile.lockfilePath && lockfile.lockfileDigest) {
			const checked = await trustedFile(
				baselineRoot.value,
				lockfile.lockfilePath,
				lockfile.lockfileDigest,
				"trusted dependency lockfile",
				this.#maxTrustedFileBytes,
			);
			if (!checked.ok) return checked;
		}
		if (lockfile.lockfileSource === "candidate_pinned" && lockfile.lockfilePath && lockfile.lockfileDigest) {
			const checked = await trustedFile(
				candidateRoot.value,
				lockfile.lockfilePath,
				lockfile.lockfileDigest,
				"pinned candidate dependency lockfile",
				this.#maxTrustedFileBytes,
			);
			if (!checked.ok) return checked;
		}

		const cwd = await existingPathWithin(candidateRoot.value, invocation.cwd.relativePath, "verification cwd");
		if (!cwd.ok) return cwd;
		if (!cwd.value.stats.isDirectory() || cwd.value.path !== context.candidateEnvelope.cwd) {
			return failure("scope_mismatch", "verification cwd does not match the validated candidate envelope");
		}
		const outputPaths: VerificationExpectedOutputPath[] = [];
		const arguments_: string[] = [];
		for (const argument of invocation.arguments) {
			if (argument.kind === "literal") {
				arguments_.push(argument.value);
				continue;
			}
			if (argument.kind === "candidate_path") {
				const checked = await existingPathWithin(candidateRoot.value, argument.relativePath, "candidate argument path");
				if (!checked.ok) return checked;
				arguments_.push(checked.value.path);
				continue;
			}
			if (argument.kind === "baseline_path") {
				const checked = await existingPathWithin(baselineRoot.value, argument.relativePath, "trusted baseline argument path");
				if (!checked.ok) return checked;
				if (!checked.value.stats.isFile()) return failure("baseline_unavailable", "trusted baseline argument is not a regular file");
				arguments_.push(checked.value.path);
				continue;
			}
			const expectedIndex = invocation.expectedArtifacts.findIndex((entry) => entry.name === argument.name);
			if (expectedIndex < 0) return failure("invalid_schema", `Artifact output is undeclared: ${argument.name}`);
			const path = resolve(
				outputRoot.value,
				`verification-${invocation.invocationDigest.slice(0, 24)}-${String(expectedIndex).padStart(4, "0")}.out`,
			);
			if (!pathWithin(outputRoot.value, path)) return failure("scope_mismatch", "Artifact output path escaped its root");
			try {
				await lstat(path);
				return failure("evidence_unavailable", `Artifact output path already exists: ${argument.name}`);
			} catch (cause) {
				if (errorCode(cause) !== "ENOENT") return failure("evidence_unavailable", `Artifact output path cannot be reserved: ${argument.name}`, true);
			}
			if (outputPaths.some((entry) => entry.name === argument.name)) {
				return failure("invalid_schema", `Artifact output argument is duplicated: ${argument.name}`);
			}
			outputPaths.push({ name: argument.name, path });
			arguments_.push(path);
		}
		for (const expected of invocation.expectedArtifacts) {
			if (expected.required && !outputPaths.some((entry) => entry.name === expected.name)) {
				return failure("invalid_schema", `required Artifact has no output argument: ${expected.name}`);
			}
		}
		const environment = environmentFor(invocation, context);
		if (!environment.ok) return environment;
		const command = this.#materializer.materialize(executable.value, arguments_);
		if (!command.ok) return command;
		return {
			ok: true,
			value: {
				invocation: {
					command: command.value,
					cwd: cwd.value.path,
					environment: environment.value,
					timeoutMs: invocation.timeoutMs,
				},
				outputRoot: outputRoot.value,
				outputPaths,
			},
		};
	}

	public async execute(request: SandboxExecutorRequest, signal?: AbortSignal): Promise<SandboxExecutorResult> {
		const terminal = this.#terminal.get(request.requestId);
		if (terminal) {
			return terminal.invocationDigest === request.invocationDigest
				? terminal.result
				: {
					authorityId: request.authorityId,
					tenantId: request.tenantId,
					principalId: request.principalId,
					requestId: request.requestId,
					resolutionReceiptId: terminal.result.resolutionReceiptId,
					executionReceipt: unavailableReceipt(request, "request id was reused with another invocation"),
				};
		}
		const invocation = decodeVerificationInvocation(request.opaqueInvocation);
		if (!invocation) {
			return this.#finish(request, unavailableReceipt(request, "typed verification invocation schema is invalid"));
		}
		let context: VerificationCoreResult<TrustedVerificationExecutionContext>;
		try {
			context = await this.#resolver.resolve({ request, invocation });
		} catch {
			return this.#finish(request, unavailableReceipt(request, "trusted verification execution context is unavailable"));
		}
		if (!context.ok) return this.#finish(request, unavailableReceipt(request, context.error.message));
		if (!invocationMatchesContext(request, invocation, context.value)) {
			return this.#finish(request, unavailableReceipt(request, "typed verification invocation correlation failed"));
		}
		const materialized = await this.#materialize(request, invocation, context.value);
		if (!materialized.ok) return this.#finish(request, unavailableReceipt(request, materialized.error.message));
		const materializedDigest = canonicalDigest(materialized.value.invocation);
		const capture: MutableSandboxCapture = { prepareCalls: 0, spawnCalls: 0 };
		const startedAt = this.#clock().toISOString();
		let innerResult: SandboxExecutorResult;
		try {
			innerResult = await this.#capturingBackend.run(capture, () => this.#inner.execute(
				{
					...request,
					invocationDigest: materializedDigest,
					opaqueInvocation: materialized.value.invocation,
				},
				signal,
			));
		} catch {
			return this.#finish(request, unavailableReceipt(request, "sandbox execution failed unexpectedly"));
		}
		const finishedAt = this.#clock().toISOString();
		const innerReceipt = innerResult.executionReceipt;
		const processResult = capture.processResult;
		const correlatedInner =
			innerResult.requestId === request.requestId &&
			innerReceipt.requestId === request.requestId &&
			innerReceipt.invocationDigest === materializedDigest &&
			innerReceipt.policyDigest === request.profile.policyDigest;
		const successfulCapture =
			correlatedInner &&
			capture.prepareCalls === 1 &&
			capture.spawnCalls === 1 &&
			capture.plan !== undefined &&
			processResult !== undefined &&
			Number.isInteger(processResult.exitCode) &&
			processResult.exitCode >= 0 &&
			processResult.exitCode <= 255 &&
			Buffer.byteLength(processResult.stdout, "utf8") < this.#maxCapturedOutputBytes &&
			Buffer.byteLength(processResult.stderr, "utf8") < this.#maxCapturedOutputBytes &&
			!processResult.signaled &&
			!processResult.denied &&
			!backendLaunchIsUncertain(capture.plan, processResult) &&
			innerReceipt.effectiveEnforcement !== "unavailable" &&
			(!invocation.sandbox.requireEnforced || innerReceipt.effectiveEnforcement === "enforced");
		if (!successfulCapture || !processResult) {
			return this.#finish(request, unavailableReceipt(
				request,
				"sandbox execution result or enforcement could not be captured with certainty",
				innerReceipt.backendId,
			));
		}
		const receipt = outerReceipt(request, innerReceipt, processResult);
		const record: VerificationExecutionRecord = {
			requestId: request.requestId,
			invocationDigest: invocation.invocationDigest,
			status: "completed",
			invocation,
			manifest: context.value.manifest,
			baseline: context.value.baseline,
			candidateEnvelope: context.value.candidateEnvelope,
			artifactOutputRoot: materialized.value.outputRoot,
			expectedOutputPaths: materialized.value.outputPaths,
			materializedInvocation: materialized.value.invocation,
			materializedInvocationDigest: materializedDigest,
			innerSandboxReceipt: innerReceipt,
			sandboxReceipt: receipt,
			processResult,
			startedAt,
			finishedAt,
		};
		let recorded: VerificationCoreResult<void>;
		try {
			recorded = await this.#records.recordExecution(record);
		} catch {
			return this.#finish(request, unavailableReceipt(request, "verification execution record store is unavailable"));
		}
		if (!recorded.ok) return this.#finish(request, unavailableReceipt(request, recorded.error.message));
		return this.#finish(request, receipt);
	}

	public async cancel(request: SecurityPortCancelRequest): Promise<SecurityPortCancelResult> {
		const terminal = this.#terminal.get(request.requestId);
		if (terminal) {
			return { ...request, status: "already_terminal", receiptId: terminal.result.executionReceipt.receiptId };
		}
		return this.#inner.cancel(request);
	}
}
