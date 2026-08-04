/** Runtime Host 验证证据的纯函数与编排入口。 */

import { createHash } from "node:crypto";
import { lstat, readFile, realpath, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { basename, isAbsolute, join, relative, resolve } from "node:path";

export type AuditOutcome = "pass" | "fail" | "unsupported";

export interface CandidateFileDigest {
	readonly path: string;
	readonly sha256: string;
}

export interface CandidateSnapshot {
	readonly head: string;
	readonly branch: string;
	readonly dirty: boolean;
	readonly trackedPatchSha256: string;
	readonly untracked: readonly CandidateFileDigest[];
	readonly candidateDigest: string;
}

export interface AuditGateDefinition {
	readonly id: string;
	readonly command: readonly string[];
	readonly verifier?: true;
}

export const RUNTIME_HOST_AUDIT_GATES: readonly AuditGateDefinition[] = Object.freeze([
	{ id: "focused_host_process", command: ["npx", "vitest", "run", "tests/runtime/host", "tests/storage/host", "tests/cli/multi-client", "tests/runtime/process", "tests/storage/process"] },
	{ id: "focused_tui_process", command: ["bun", "test", "tests/tui/process-overlay.bun.test.ts", "tests/tui/process/process-overlay.bun.test.ts"] },
	{ id: "check", command: ["npm", "run", "check"] },
	{ id: "test", command: ["npm", "test"] },
	{ id: "build", command: ["npm", "run", "build"] },
	{ id: "verify_multi_client_host", command: ["npm", "run", "verify:multi-client-host"], verifier: true },
	{ id: "verify_managed_process_pty", command: ["npm", "run", "verify:managed-process-pty"], verifier: true },
	{ id: "diff_check", command: ["git", "diff", "--check"] },
]);

export interface VerifierSummary {
	readonly outcome: AuditOutcome;
	readonly checks: readonly string[];
}

export interface GateExecutionInput {
	readonly id: string;
	readonly command: readonly string[];
	readonly exitCode: number;
	readonly durationMs: number;
	readonly stdout: Uint8Array;
	readonly stderr: Uint8Array;
	readonly verifier?: VerifierSummary;
}

export interface GateEvidence {
	readonly id: string;
	readonly command: readonly string[];
	readonly outcome: AuditOutcome;
	readonly exitCode: number;
	readonly durationMs: number;
	readonly stdoutSha256: string;
	readonly stderrSha256: string;
	readonly checks?: readonly string[];
}

export interface AuditEnvironment {
	readonly platform: NodeJS.Platform;
	readonly arch: string;
	readonly node: string;
	readonly npm: string;
	readonly bun: string;
}

export interface RuntimeHostAuditManifest {
	readonly format: "runtime-host-audit";
	readonly outcome: AuditOutcome;
	readonly startedAtUtc: string;
	readonly finishedAtUtc: string;
	readonly candidate: CandidateSnapshot;
	readonly candidateEndDigest: string;
	readonly candidateStable: boolean;
	readonly environment: AuditEnvironment;
	readonly gates: readonly GateEvidence[];
	readonly failureCode?: "candidate_changed" | "gate_failed";
}

export interface RuntimeHostAuditOptions {
	readonly repositoryRoot: string;
	readonly outputDirectory: string;
	readonly environment?: AuditEnvironment;
	readonly gates?: readonly AuditGateDefinition[];
}

export interface RuntimeHostAuditResult {
	readonly manifest: RuntimeHostAuditManifest;
	readonly manifestPath: string;
	readonly exitCode: 0 | 1 | 2;
}

export async function collectCandidateSnapshot(repositoryRoot: string): Promise<CandidateSnapshot> {
	const root = resolve(repositoryRoot);
	const [headResult, branchResult, patchResult, untrackedResult, statusResult] = await Promise.all([
		runCapture("git", ["rev-parse", "HEAD"], root),
		runCapture("git", ["branch", "--show-current"], root),
		runCapture("git", ["diff", "--binary", "--no-ext-diff", "HEAD", "--"], root),
		runCapture("git", ["ls-files", "--others", "--exclude-standard", "-z"], root),
		runCapture("git", ["status", "--porcelain=v1", "-z"], root),
	]);
	for (const result of [headResult, branchResult, patchResult, untrackedResult, statusResult]) {
		if (result.exitCode !== 0) throw new Error("candidate_git_inspection_failed");
	}
	const head = headResult.stdout.toString("utf8").trim();
	if (!/^[a-f0-9]{40,64}$/u.test(head)) throw new Error("candidate_head_invalid");
	const untrackedPaths = untrackedResult.stdout.toString("utf8").split("\0").filter((path) => path.length > 0).sort();
	const untracked: CandidateFileDigest[] = [];
	for (const path of untrackedPaths) {
		if (isAbsolute(path) || path === ".." || path.startsWith("../")) throw new Error("candidate_untracked_path_invalid");
		untracked.push({ path, sha256: sha256(await readFile(resolve(root, path))) });
	}
	const body = {
		head,
		trackedPatchSha256: sha256(patchResult.stdout),
		untracked,
	};
	return {
		...body,
		branch: branchResult.stdout.toString("utf8").trim() || "DETACHED",
		dirty: statusResult.stdout.length > 0,
		candidateDigest: sha256(Buffer.from(JSON.stringify(body), "utf8")),
	};
}

export function summarizeGateExecution(input: GateExecutionInput): GateEvidence {
	const outcome = input.verifier?.outcome === "unsupported"
		? "unsupported"
		: input.exitCode === 0 && (input.verifier === undefined || input.verifier.outcome === "pass")
			? "pass"
			: "fail";
	return {
		id: input.id,
		command: sanitizeCommand(input.command),
		outcome,
		exitCode: input.exitCode,
		durationMs: input.durationMs,
		stdoutSha256: sha256(input.stdout),
		stderrSha256: sha256(input.stderr),
		...(input.verifier === undefined ? {} : { checks: [...input.verifier.checks] }),
	};
}

function sanitizeCommand(command: readonly string[]): readonly string[] {
	return command.map((part, index) => {
		if (index === 0) return basename(part);
		if (command[index - 1] === "-e" || command[index - 1] === "-c") return "<redacted-argument>";
		if (part.length > 256 || /[\r\n]/u.test(part) || /(?:^|[=(\s'"`])\/(?:[^\s'"`)]+\/)*[^\s'"`)]+/u.test(part)) return "<redacted-argument>";
		if (/(?:credential|password|token|authorization|api[-_]?key)/iu.test(part)) return "<redacted-argument>";
		return part;
	});
}

export async function runRuntimeHostAudit(options: RuntimeHostAuditOptions): Promise<RuntimeHostAuditResult> {
	const root = await realpath(resolve(options.repositoryRoot));
	const outputDirectory = await validateOutputDirectory(root, options.outputDirectory);
	const startedAtUtc = new Date().toISOString();
	const candidate = await collectCandidateSnapshot(root);
	const environment = options.environment ?? await collectAuditEnvironment(root);
	const gates: GateEvidence[] = [];
	if (environment.platform === "linux") {
		for (const definition of options.gates ?? RUNTIME_HOST_AUDIT_GATES) {
			const started = Date.now();
			const execution = await runCapture(definition.command[0] ?? "", definition.command.slice(1), root);
			const verifier = definition.verifier === true ? parseVerifierSummary(execution.stdout) : undefined;
			gates.push(summarizeGateExecution({
				id: definition.id,
				command: definition.command,
				exitCode: execution.exitCode,
				durationMs: Date.now() - started,
				stdout: execution.stdout,
				stderr: execution.stderr,
				...(verifier === undefined ? {} : { verifier }),
			}));
		}
	}
	const endCandidate = await collectCandidateSnapshot(root);
	const candidateStable = endCandidate.candidateDigest === candidate.candidateDigest;
	const gateFailed = gates.some((gate) => gate.outcome === "fail");
	const gateUnsupported = gates.some((gate) => gate.outcome === "unsupported");
	const outcome: AuditOutcome = environment.platform !== "linux"
		? "unsupported"
		: !candidateStable || gateFailed
			? "fail"
			: gateUnsupported
				? "unsupported"
				: "pass";
	const manifest: RuntimeHostAuditManifest = {
		format: "runtime-host-audit",
		outcome,
		startedAtUtc,
		finishedAtUtc: new Date().toISOString(),
		candidate,
		candidateEndDigest: endCandidate.candidateDigest,
		candidateStable,
		environment,
		gates,
		...(!candidateStable ? { failureCode: "candidate_changed" as const } : gateFailed ? { failureCode: "gate_failed" as const } : {}),
	};
	const manifestPath = join(outputDirectory, "runtime-host-audit-manifest.json");
	await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
	return { manifest, manifestPath, exitCode: outcome === "pass" ? 0 : outcome === "unsupported" ? 2 : 1 };
}

interface CapturedProcess {
	readonly exitCode: number;
	readonly stdout: Buffer;
	readonly stderr: Buffer;
}

function runCapture(command: string, args: readonly string[], cwd: string): Promise<CapturedProcess> {
	return new Promise((resolvePromise, reject) => {
		const child = spawn(command, [...args], { cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
		child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
		child.once("error", reject);
		child.once("close", (code) => resolvePromise({
			exitCode: code ?? 1,
			stdout: Buffer.concat(stdout),
			stderr: Buffer.concat(stderr),
		}));
	});
}

async function validateOutputDirectory(repositoryRoot: string, requested: string): Promise<string> {
	if (!isAbsolute(requested)) throw new Error("audit_output_must_be_absolute");
	const info = await lstat(requested);
	if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("audit_output_must_be_existing_directory");
	const output = await realpath(requested);
	const locator = relative(repositoryRoot, output);
	if (locator === "" || locator === ".." || !locator.startsWith("../")) throw new Error("audit_output_must_be_outside_repository");
	return output;
}

async function collectAuditEnvironment(cwd: string): Promise<AuditEnvironment> {
	const [npm, bun] = await Promise.all([
		runCapture("npm", ["--version"], cwd),
		runCapture("bun", ["--version"], cwd),
	]);
	return {
		platform: process.platform,
		arch: process.arch,
		node: process.version,
		npm: npm.exitCode === 0 ? npm.stdout.toString("utf8").trim() : "unavailable",
		bun: bun.exitCode === 0 ? bun.stdout.toString("utf8").trim() : "unavailable",
	};
}

function parseVerifierSummary(stdout: Buffer): VerifierSummary {
	for (const line of stdout.toString("utf8").trim().split(/\r?\n/u).reverse()) {
		try {
			const parsed = JSON.parse(line) as unknown;
			if (!isRecord(parsed) || !isAuditOutcome(parsed.outcome) || !Array.isArray(parsed.checks) || !parsed.checks.every((check) => typeof check === "string")) continue;
			return { outcome: parsed.outcome, checks: parsed.checks };
		} catch {
			// npm 的前导输出不是 verifier JSON，继续向前查找最后一个结构化结果。
		}
	}
	return { outcome: "fail", checks: [] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAuditOutcome(value: unknown): value is AuditOutcome {
	return value === "pass" || value === "fail" || value === "unsupported";
}

function sha256(value: Uint8Array): string {
	return createHash("sha256").update(value).digest("hex");
}
