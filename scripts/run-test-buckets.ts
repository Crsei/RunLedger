/**
 * Canonical test bucket 编排器。
 *
 * 它只消费 test-inventory 的路径归属，并以 argv 数组启动子 runner；不把 glob
 * 交给 shell。资源敏感 bucket 顺序执行，避免 singleton、SQLite、process 与
 * OpenTUI native heap 互相污染。
 */

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { inspectTestInventory, type ExecutionBucket, type TestInventoryEntry, type TestRunner } from "./test-inventory.ts";

export type TestBucketMode = "local" | "all";

export interface TestBucketPlanOptions {
	readonly mode: TestBucketMode;
	readonly repoRoot: string;
	readonly bucket?: ExecutionBucket;
}

export interface TestBucketChunk {
	readonly command: string;
	readonly args: readonly string[];
	readonly files: readonly string[];
}

export interface TestBucketPlan {
	readonly bucket: ExecutionBucket;
	readonly runner: TestRunner;
	readonly concurrency: number;
	readonly watchdogMs: number;
	readonly files: readonly string[];
	readonly chunks: readonly TestBucketChunk[];
}

interface BucketConfiguration {
	readonly bucket: ExecutionBucket;
	readonly runner: TestRunner;
	readonly concurrency: number;
	readonly chunkSize: number;
	readonly watchdogMs: number;
	readonly vitestArguments?: readonly string[];
}

const VITEST_ENTRYPOINT = "./node_modules/vitest/vitest.mjs";

const BUCKET_CONFIGURATIONS: readonly BucketConfiguration[] = [
	{ bucket: "fast", runner: "vitest", concurrency: 4, chunkSize: 80, watchdogMs: 180_000, vitestArguments: ["--maxWorkers=4", "--minWorkers=1"] },
	{
		bucket: "singleton",
		runner: "vitest",
		concurrency: 1,
		chunkSize: 1,
		watchdogMs: 90_000,
		vitestArguments: ["--no-file-parallelism", "--pool=forks", "--poolOptions.forks.singleFork"],
	},
	{ bucket: "runtime", runner: "vitest", concurrency: 2, chunkSize: 12, watchdogMs: 180_000, vitestArguments: ["--maxWorkers=2", "--minWorkers=1"] },
	{ bucket: "security-storage", runner: "vitest", concurrency: 1, chunkSize: 8, watchdogMs: 240_000, vitestArguments: ["--no-file-parallelism"] },
	{ bucket: "integration", runner: "vitest", concurrency: 1, chunkSize: 4, watchdogMs: 300_000, vitestArguments: ["--no-file-parallelism"] },
	{ bucket: "tui-native", runner: "bun", concurrency: 1, chunkSize: 6, watchdogMs: 120_000 },
	{ bucket: "rust-native", runner: "cargo", concurrency: 1, chunkSize: 1, watchdogMs: 180_000 },
	{ bucket: "smoke", runner: "vitest", concurrency: 1, chunkSize: 1, watchdogMs: 120_000, vitestArguments: ["--no-file-parallelism", "--pool=forks", "--poolOptions.forks.singleFork"] },
];

function partition<T>(values: readonly T[], size: number): readonly (readonly T[])[] {
	const chunks: T[][] = [];
	for (let index = 0; index < values.length; index += size) chunks.push([...values.slice(index, index + size)]);
	return chunks;
}

function buildChunk(configuration: BucketConfiguration, files: readonly string[], repoRoot: string): TestBucketChunk {
	if (configuration.runner === "vitest") {
		return {
			command: process.execPath,
			args: [VITEST_ENTRYPOINT, "run", ...(configuration.vitestArguments ?? []), ...files],
			files,
		};
	}
	if (configuration.runner === "bun") {
		return { command: "bun", args: ["test", ...files], files };
	}
	return {
		command: "cargo",
		args: ["test", "--locked", "--manifest-path", `${resolve(repoRoot)}/native/syntax-highlighter/Cargo.toml`],
		files,
	};
}

function selectedEntries(entries: readonly TestInventoryEntry[], mode: TestBucketMode): readonly TestInventoryEntry[] {
	return entries.filter((entry) => mode === "all" || entry.defaultLocal);
}

function normalizeRepoRelativePath(path: string): string {
	return path.replaceAll("\\", "/").replace(/^\.\//, "");
}

/**
 * changed-since/focused 模式只选择已有测试路径；对 src 变动不臆测影响范围，
 * 防止“没有选到测试”被误报为完整回归。
 */
export function filterTestEntriesByPaths(entries: readonly TestInventoryEntry[], paths: readonly string[]): readonly TestInventoryEntry[] {
	const selectedPaths = new Set(paths.map(normalizeRepoRelativePath));
	return entries.filter((entry) => selectedPaths.has(entry.path));
}

export function buildTestBucketPlan(entries: readonly TestInventoryEntry[], options: TestBucketPlanOptions): readonly TestBucketPlan[] {
	const selected = selectedEntries(entries, options.mode);
	const duplicatePaths = selected
		.map((entry) => entry.path)
		.filter((path, index, paths) => paths.indexOf(path) !== index);
	if (duplicatePaths.length > 0) throw new Error(`duplicate inventory paths: ${[...new Set(duplicatePaths)].sort().join(", ")}`);

	return BUCKET_CONFIGURATIONS.flatMap((configuration) => {
		if (options.bucket !== undefined && options.bucket !== configuration.bucket) return [];
		const files = selected
			.filter((entry) => entry.executionBucket === configuration.bucket)
			.map((entry) => entry.path)
			.sort();
		if (files.length === 0) return [];
		const unexpectedRunner = selected.find((entry) => entry.executionBucket === configuration.bucket && entry.runner !== configuration.runner);
		if (unexpectedRunner !== undefined) {
			throw new Error(`${configuration.bucket} cannot run ${unexpectedRunner.runner}: ${unexpectedRunner.path}`);
		}
		const chunks = configuration.runner === "cargo"
			? [buildChunk(configuration, files, options.repoRoot)]
			: partition(files, configuration.chunkSize).map((chunk) => buildChunk(configuration, chunk, options.repoRoot));
		return [{
			bucket: configuration.bucket,
			runner: configuration.runner,
			concurrency: configuration.concurrency,
			watchdogMs: configuration.watchdogMs,
			files,
			chunks,
		}];
	});
}

function sanitizedTestEnvironment(runledgerDir: string): NodeJS.ProcessEnv {
	const environment: NodeJS.ProcessEnv = { ...process.env };
	for (const key of Object.keys(environment)) {
		if (
			key === "RUNLEDGER_DIR"
			|| /(?:API[_-]?KEY|AUTH[_-]?TOKEN|ACCESS[_-]?TOKEN|SECRET|CREDENTIAL|AWS_|AZURE_|GOOGLE_APPLICATION_CREDENTIALS|OPENAI_|ANTHROPIC_)/i.test(key)
		) {
			delete environment[key];
		}
	}
	environment.RUNLEDGER_DIR = runledgerDir;
	environment.HOME = runledgerDir;
	environment.XDG_CONFIG_HOME = join(runledgerDir, "config");
	environment.XDG_DATA_HOME = join(runledgerDir, "data");
	return environment;
}

interface CliArguments {
	readonly mode: TestBucketMode;
	readonly bucket?: ExecutionBucket;
	readonly dryRun: boolean;
	readonly listFiles: boolean;
	readonly changedSince?: string;
	readonly files: readonly string[];
	readonly evidenceFile?: string;
}

function parseBucket(value: string): ExecutionBucket {
	const bucket = BUCKET_CONFIGURATIONS.find((configuration) => configuration.bucket === value)?.bucket;
	if (bucket === undefined) throw new Error(`unknown test bucket: ${value}`);
	return bucket;
}

function parseCliArguments(argv: readonly string[]): CliArguments {
	let mode: TestBucketMode = "local";
	let bucket: ExecutionBucket | undefined;
	let dryRun = false;
	let listFiles = false;
	let changedSince: string | undefined;
	let evidenceFile: string | undefined;
	const files: string[] = [];
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		if (argument === "--mode") {
			const value = argv[index + 1];
			if (value !== "local" && value !== "all") throw new Error("--mode must be local or all");
			mode = value;
			index += 1;
			continue;
		}
		if (argument === "--bucket") {
			const value = argv[index + 1];
			if (value === undefined) throw new Error("--bucket requires a value");
			bucket = parseBucket(value);
			index += 1;
			continue;
		}
		if (argument === "--dry-run") {
			dryRun = true;
			continue;
		}
		if (argument === "--list-files") {
			listFiles = true;
			continue;
		}
		if (argument === "--changed-since") {
			const value = argv[index + 1];
			if (value === undefined) throw new Error("--changed-since requires a Git revision");
			changedSince = value;
			index += 1;
			continue;
		}
		if (argument === "--file") {
			const value = argv[index + 1];
			if (value === undefined) throw new Error("--file requires a test path");
			files.push(value);
			index += 1;
			continue;
		}
		if (argument === "--evidence-file") {
			const value = argv[index + 1];
			if (value === undefined) throw new Error("--evidence-file requires a path");
			evidenceFile = value;
			index += 1;
			continue;
		}
		throw new Error(`unknown argument: ${argument}`);
	}
	return { mode, bucket, dryRun, listFiles, changedSince, files, evidenceFile };
}

function readChangedPaths(repoRoot: string, revision: string): readonly string[] {
	const output = execFileSync("git", ["diff", "--name-only", "--diff-filter=ACMR", `${revision}...HEAD`], {
		cwd: repoRoot,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	return output.split(/\r?\n/).filter(Boolean).map(normalizeRepoRelativePath);
}

function resolveFocusedPaths(repoRoot: string, paths: readonly string[]): readonly string[] {
	return paths.map((path) => normalizeRepoRelativePath(isAbsolute(path) ? relative(repoRoot, path) : path));
}

function printPlan(plan: readonly TestBucketPlan[], listFiles: boolean): void {
	const output = plan.map((bucket) => ({
		bucket: bucket.bucket,
		runner: bucket.runner,
		concurrency: bucket.concurrency,
		watchdogMs: bucket.watchdogMs,
		fileCount: bucket.files.length,
		files: listFiles ? bucket.files : undefined,
		chunks: bucket.chunks.map((chunk) => ({ command: chunk.command, args: chunk.args, fileCount: chunk.files.length })),
	}));
	console.log(JSON.stringify(output, null, 2));
}

type ExecutionMode = "plan" | "executed";
type CleanupVerification = "verified" | "failed" | "unknown" | "not_applicable";

interface CleanupEvidence {
	readonly childProcesses: CleanupVerification;
	readonly descendants: CleanupVerification;
	readonly sockets: CleanupVerification;
	readonly tempRoots: CleanupVerification;
	readonly status: CleanupVerification;
}

interface TestExecutionEvidence {
	readonly schemaId: "runledger.test-execution-evidence.v2";
	readonly executionMode: ExecutionMode;
	readonly commit: string;
	readonly dirtyPaths: readonly string[];
	readonly dirtyDigest: string;
	readonly cwdDigest: string;
	readonly runnerVersions: Readonly<Record<"node" | "bun" | "npm" | "rustc" | "cargo", string>>;
	readonly bucket: readonly ExecutionBucket[];
	readonly commandArgv: readonly { readonly command: string; readonly args: readonly string[] }[];
	readonly startedAt: string;
	readonly finishedAt: string;
	readonly durationMs: number;
	readonly files: { readonly discovered: number; readonly selected: number; readonly collected: null };
	readonly tests: { readonly collected: null; readonly passed: null; readonly failed: null; readonly skipped: null; readonly todo: null };
	readonly process: { readonly exitCode: number; readonly signal: string | null; readonly timeoutKind: "watchdog" | null };
	readonly platform: { readonly os: string; readonly arch: string; readonly libc: "unavailable" };
	readonly artifacts: { readonly buildManifestDigest: null; readonly logDigest: null };
	readonly cleanup: CleanupEvidence;
}

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function commandVersion(command: string, args: readonly string[]): string {
	try {
		return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || "unavailable";
	} catch {
		return "unavailable";
	}
}

function currentCommit(repoRoot: string): string {
	const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
	if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error("cannot determine current Git commit for test evidence");
	return commit;
}

function currentDirtyPaths(repoRoot: string): readonly string[] {
	const output = execFileSync("git", ["status", "--porcelain=v1", "-z"], { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
	const records = output.split("\0").filter(Boolean);
	const paths: string[] = [];
	for (let index = 0; index < records.length; index += 1) {
		const record = records[index];
		if (record.length < 4) continue;
		paths.push(normalizeRepoRelativePath(record.slice(3)));
		if (record.startsWith("R") || record.startsWith("C")) {
			const previousPath = records[index + 1];
			if (previousPath !== undefined) paths.push(normalizeRepoRelativePath(previousPath));
			index += 1;
		}
	}
	return [...new Set(paths)].sort();
}

async function writeExecutionEvidence(path: string, evidence: TestExecutionEvidence): Promise<void> {
	const target = resolve(path);
	await mkdir(dirname(target), { recursive: true });
	await writeFile(target, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
}

function plannedCleanupEvidence(): CleanupEvidence {
	return {
		childProcesses: "not_applicable",
		descendants: "not_applicable",
		sockets: "not_applicable",
		tempRoots: "not_applicable",
		status: "not_applicable",
	};
}

async function executedCleanupEvidence(root: string, processGroups: readonly number[], processGroupsSupported: boolean, childProcesses: CleanupVerification): Promise<CleanupEvidence> {
	let descendants: CleanupVerification = processGroupsSupported ? "verified" : "unknown";
	if (processGroupsSupported) {
		for (const processGroup of processGroups) {
			try {
				process.kill(-processGroup, 0);
				descendants = "failed";
				break;
			} catch (error) {
				if (!(error instanceof Error) || !("code" in error) || error.code !== "ESRCH") {
					descendants = "unknown";
					break;
				}
			}
		}
	}
	let sockets: CleanupVerification = process.platform === "win32" ? "not_applicable" : "verified";
	try {
		if (process.platform !== "win32" && await containsSocket(root)) sockets = "failed";
	} catch {
		sockets = "unknown";
	}
	let tempRoots: CleanupVerification = "verified";
	try {
		await rm(root, { recursive: true, force: false });
		try {
			await lstat(root);
			tempRoots = "failed";
		} catch (error) {
			if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") tempRoots = "unknown";
		}
	} catch {
		tempRoots = "failed";
	}
	const fields = [childProcesses, descendants, sockets, tempRoots];
	const status: CleanupVerification = fields.includes("failed")
		? "failed"
		: fields.includes("unknown")
			? "unknown"
			: fields.every((field) => field === "not_applicable")
				? "not_applicable"
				: "verified";
	return { childProcesses, descendants, sockets, tempRoots, status };
}

async function containsSocket(root: string): Promise<boolean> {
	const entries = await readdir(root, { withFileTypes: true });
	for (const entry of entries) {
		const path = join(root, entry.name);
		if (entry.isSocket()) return true;
		if (entry.isDirectory() && await containsSocket(path)) return true;
	}
	return false;
}

async function run(): Promise<void> {
	const arguments_ = parseCliArguments(process.argv.slice(2));
	const repoRoot = fileURLToPath(new URL("..", import.meta.url));
	const inventory = await inspectTestInventory(repoRoot);
	if (!inventory.ok) {
		for (const diagnostic of inventory.diagnostics) console.error(`${diagnostic.code}: ${diagnostic.path}`);
		process.exitCode = 1;
		return;
	}
	const requestedPaths = [
		...(arguments_.changedSince === undefined ? [] : readChangedPaths(repoRoot, arguments_.changedSince)),
		...resolveFocusedPaths(repoRoot, arguments_.files),
	];
	const hasPathSelection = arguments_.changedSince !== undefined || arguments_.files.length > 0;
	const entries = hasPathSelection ? filterTestEntriesByPaths(inventory.entries, requestedPaths) : inventory.entries;
	if (hasPathSelection && entries.length === 0) {
		throw new Error("no inventory test files selected; run a bucket or npm test for source-only changes");
	}
	const plan = buildTestBucketPlan(entries, { mode: arguments_.mode, repoRoot, bucket: arguments_.bucket });
	if (arguments_.bucket !== undefined && plan.length === 0) throw new Error(`bucket has no eligible files: ${arguments_.bucket}`);
	const executionMode: ExecutionMode = arguments_.dryRun || arguments_.listFiles ? "plan" : "executed";
	const startedAt = new Date().toISOString();
	const startedAtMs = Date.now();
	let exitCode = 0;
	let signal: string | null = null;
	let timeoutKind: "watchdog" | null = null;
	let cleanup = plannedCleanupEvidence();
	let isolatedHome: string | undefined;
	const processGroups: number[] = [];
	let childProcesses: CleanupVerification = "not_applicable";
	const processGroupsSupported = process.platform !== "win32";
	try {
		if (arguments_.dryRun || arguments_.listFiles) {
			printPlan(plan, arguments_.listFiles);
		} else {
			isolatedHome = await mkdtemp(join(tmpdir(), "runledger-test-runner-"));
			childProcesses = "verified";
			for (const bucket of plan) {
				for (const chunk of bucket.chunks) {
					console.log(`[${bucket.bucket}] ${chunk.command} ${chunk.args.join(" ")}`);
					const result = spawnSync(chunk.command, chunk.args, {
						cwd: repoRoot,
						env: sanitizedTestEnvironment(isolatedHome),
						stdio: "inherit",
						shell: false,
						detached: processGroupsSupported,
						timeout: bucket.watchdogMs,
					});
					if (result.pid === undefined) {
						childProcesses = "unknown";
					} else if (processGroupsSupported) {
						processGroups.push(result.pid);
					}
					signal = result.signal;
					if (result.error !== undefined) {
						exitCode = 1;
						if ((result.error as NodeJS.ErrnoException).code === "ETIMEDOUT") timeoutKind = "watchdog";
						throw result.error;
					}
					if (result.status !== 0) {
						exitCode = result.status ?? 1;
						process.exitCode = exitCode;
						return;
					}
				}
			}
		}
	} finally {
		if (isolatedHome !== undefined) {
			cleanup = await executedCleanupEvidence(isolatedHome, processGroups, processGroupsSupported, childProcesses);
			if (cleanup.status !== "verified") {
				exitCode = exitCode === 0 ? 1 : exitCode;
				process.exitCode = exitCode;
			}
		}
		if (arguments_.evidenceFile !== undefined) {
			const dirtyPaths = currentDirtyPaths(repoRoot);
			const evidence: TestExecutionEvidence = {
				schemaId: "runledger.test-execution-evidence.v2",
				executionMode,
				commit: currentCommit(repoRoot),
				dirtyPaths,
				dirtyDigest: sha256(dirtyPaths.join("\n")),
				cwdDigest: sha256(repoRoot),
				runnerVersions: {
					node: process.version,
					bun: commandVersion("bun", ["--version"]),
					npm: commandVersion("npm", ["--version"]),
					rustc: commandVersion("rustc", ["--version"]),
					cargo: commandVersion("cargo", ["--version"]),
				},
				bucket: plan.map((bucket) => bucket.bucket),
				commandArgv: plan.flatMap((bucket) => bucket.chunks.map((chunk) => ({ command: chunk.command, args: [...chunk.args] }))),
				startedAt,
				finishedAt: new Date().toISOString(),
				durationMs: Date.now() - startedAtMs,
				files: { discovered: inventory.entries.length, selected: entries.length, collected: null },
				tests: { collected: null, passed: null, failed: null, skipped: null, todo: null },
				process: { exitCode, signal, timeoutKind },
				platform: { os: process.platform, arch: process.arch, libc: "unavailable" },
				artifacts: { buildManifestDigest: null, logDigest: null },
				cleanup,
			};
			await writeExecutionEvidence(arguments_.evidenceFile, evidence);
		}
	}
}

if (process.argv[1]?.endsWith("run-test-buckets.ts")) {
	run().catch((error: unknown) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	});
}
