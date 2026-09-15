import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { TestInventoryEntry } from "../../scripts/test-inventory.ts";
import { buildTestBucketPlan, filterTestEntriesByPaths } from "../../scripts/run-test-buckets.ts";

const ENTRIES: readonly TestInventoryEntry[] = [
	{ path: "tests/utils/pure.test.ts", runner: "vitest", executionBucket: "fast", collected: null, defaultLocal: true, prCi: true, nightly: false },
	{ path: "tests/auth/kimi-code-oauth.test.ts", runner: "vitest", executionBucket: "singleton", collected: null, defaultLocal: true, prCi: true, nightly: false },
	{ path: "tests/runtime/session-owner.test.ts", runner: "vitest", executionBucket: "runtime", collected: null, defaultLocal: true, prCi: true, nightly: false },
	{ path: "tests/security/policy.test.ts", runner: "vitest", executionBucket: "security-storage", collected: null, defaultLocal: true, prCi: true, nightly: false },
	{ path: "tests/integration/socket-e2e.test.ts", runner: "vitest", executionBucket: "integration", collected: null, defaultLocal: true, prCi: true, nightly: false },
	{ path: "tests/tui/layout.bun.test.ts", runner: "bun", executionBucket: "tui-native", collected: null, defaultLocal: true, prCi: true, nightly: false },
	{ path: "native/syntax-highlighter/src/lib.rs", runner: "cargo", executionBucket: "rust-native", collected: null, defaultLocal: false, prCi: true, nightly: false },
];
const TEST_EXECUTION_EVIDENCE_SCHEMA_ID = ["runledger", "test-execution-evidence", "v" + "2"].join(".");

const temporaryDirectories: string[] = [];

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("test bucket runner", () => {
	it("partitions local files into disjoint bucket plans with a single-worker singleton command", () => {
		const plan = buildTestBucketPlan(ENTRIES, { mode: "local", repoRoot: "/repo" });

		expect(plan.map((bucket) => bucket.bucket)).toEqual([
			"fast",
			"singleton",
			"runtime",
			"security-storage",
			"integration",
			"tui-native",
		]);
		expect(plan.flatMap((bucket) => bucket.files).sort()).toEqual(ENTRIES.filter((entry) => entry.defaultLocal).map((entry) => entry.path).sort());
		expect(plan.find((bucket) => bucket.bucket === "singleton")).toMatchObject({
			concurrency: 1,
			chunks: [{ args: expect.arrayContaining(["--no-file-parallelism", "--poolOptions.forks.singleFork"]) }],
		});
		expect(plan.find((bucket) => bucket.bucket === "fast")).toMatchObject({
			concurrency: 4,
			chunks: [{ args: expect.arrayContaining(["--maxWorkers=4", "--minWorkers=1"]) }],
		});
		expect(plan.find((bucket) => bucket.bucket === "runtime")).toMatchObject({
			concurrency: 2,
			chunks: [{ args: expect.arrayContaining(["--maxWorkers=2", "--minWorkers=1"]) }],
		});
	});

	it("keeps the Rust native command out of local mode but includes it in all mode", () => {
		expect(buildTestBucketPlan(ENTRIES, { mode: "local", repoRoot: "/repo" }).some((bucket) => bucket.bucket === "rust-native")).toBe(false);
		const rustNative = buildTestBucketPlan(ENTRIES, { mode: "all", repoRoot: "/repo" })
			.find((bucket) => bucket.bucket === "rust-native");
		expect(rustNative).toMatchObject({
			bucket: "rust-native",
			files: ["native/syntax-highlighter/src/lib.rs"],
			chunks: [{ command: "cargo", args: ["test", "--locked", "--manifest-path", "/repo/native/syntax-highlighter/Cargo.toml"] }],
		});
	});

	it("splits an integration bucket into bounded serial chunks without shell glob arguments", () => {
		const entries = [
			...ENTRIES.filter((entry) => entry.executionBucket !== "integration"),
			...Array.from({ length: 5 }, (_, index): TestInventoryEntry => ({
				path: `tests/integration/case-${index}.test.ts`,
				runner: "vitest",
				executionBucket: "integration",
				collected: null,
				defaultLocal: true,
				prCi: true,
				nightly: false,
			})),
		];

		const integration = buildTestBucketPlan(entries, { mode: "local", repoRoot: "/repo" })
			.find((bucket) => bucket.bucket === "integration");

		expect(integration).toMatchObject({
			concurrency: 1,
			chunks: [
				{ args: expect.arrayContaining(["tests/integration/case-0.test.ts", "tests/integration/case-3.test.ts", "--no-file-parallelism"]) },
				{ args: expect.arrayContaining(["tests/integration/case-4.test.ts", "--no-file-parallelism"]) },
			],
		});
	});

	it("selects changed or focused test paths with normalized separators and never infers source impact", () => {
		expect(filterTestEntriesByPaths(ENTRIES, [
			"src/runtime/agent.ts",
			"tests\\runtime\\session-owner.test.ts",
			"tests/tui/layout.bun.test.ts",
		])).toEqual([
			ENTRIES[2],
			ENTRIES[5],
		]);
		expect(filterTestEntriesByPaths(ENTRIES, ["src/runtime/agent.ts"])).toEqual([]);
	});

	it("fails closed when a changed-since revision contains no inventory test path", () => {
		const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
		const result = spawnSync(process.execPath, [
			"--import",
			"tsx",
			"scripts/run-test-buckets.ts",
			"--bucket",
			"fast",
			"--changed-since",
			"HEAD",
			"--dry-run",
		], { cwd: repoRoot, encoding: "utf8" });

		expect(result.status).toBe(1);
		expect(result.stderr).toContain("no inventory test files selected");
	});

	it("writes a plan-only evidence manifest for a selected dry-run", () => {
		const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
		const temporaryDirectory = mkdtempSync(join(tmpdir(), "runledger-test-evidence-"));
		temporaryDirectories.push(temporaryDirectory);
		const evidenceFile = join(temporaryDirectory, "evidence.json");
		const result = spawnSync(process.execPath, [
			"--import",
			"tsx",
			"scripts/run-test-buckets.ts",
			"--bucket",
			"fast",
			"--file",
			"tests/scripts/run-test-buckets.test.ts",
			"--dry-run",
			"--evidence-file",
			evidenceFile,
		], { cwd: repoRoot, encoding: "utf8" });

		expect(result.status).toBe(0);
		const evidence = JSON.parse(readFileSync(evidenceFile, "utf8")) as {
			schemaId: string;
			executionMode: "plan";
			commit: string;
			dirtyDigest: string;
			cwdDigest: string;
			bucket: string[];
			commandArgv: Array<{ command: string; args: string[] }>;
			files: { discovered: number; selected: number; collected: null };
			process: { exitCode: number; signal: null; timeoutKind: null };
			cleanup: { childProcesses: "not_applicable"; descendants: "not_applicable"; sockets: "not_applicable"; tempRoots: "not_applicable"; status: "not_applicable" };
		};
		expect(evidence).toMatchObject({
			schemaId: TEST_EXECUTION_EVIDENCE_SCHEMA_ID,
			executionMode: "plan",
			commit: expect.stringMatching(/^[a-f0-9]{40}$/),
			dirtyDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
			cwdDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
			bucket: ["fast"],
			files: { discovered: expect.any(Number), selected: 1, collected: null },
			process: { exitCode: 0, signal: null, timeoutKind: null },
			cleanup: { childProcesses: "not_applicable", descendants: "not_applicable", sockets: "not_applicable", tempRoots: "not_applicable", status: "not_applicable" },
		});
		expect(evidence.commandArgv).toEqual([
			{ command: process.execPath, args: expect.arrayContaining(["run", "tests/scripts/run-test-buckets.test.ts"]) },
		]);
	});

	it("records verified cleanup only after an executed runner exits", () => {
		const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
		const temporaryDirectory = mkdtempSync(join(tmpdir(), "runledger-test-evidence-executed-"));
		temporaryDirectories.push(temporaryDirectory);
		const evidenceFile = join(temporaryDirectory, "evidence.json");
		const result = spawnSync(process.execPath, [
			"--import",
			"tsx",
			"scripts/run-test-buckets.ts",
			"--bucket",
			"fast",
			"--file",
			"tests/scripts/test-inventory.test.ts",
			"--evidence-file",
			evidenceFile,
		], { cwd: repoRoot, encoding: "utf8", timeout: 30_000 });

		expect(result.status).toBe(0);
		const evidence = JSON.parse(readFileSync(evidenceFile, "utf8")) as {
			schemaId: string;
			executionMode: "executed";
			cleanup: { childProcesses: "verified"; descendants: "verified"; sockets: "verified"; tempRoots: "verified"; status: "verified" };
		};
		expect(evidence).toMatchObject({
			schemaId: TEST_EXECUTION_EVIDENCE_SCHEMA_ID,
			executionMode: "executed",
			chunks: [expect.objectContaining({ bucket: "fast", files: ["tests/scripts/test-inventory.test.ts"], failureKind: null, durationMs: expect.any(Number) })],
			cleanup: { childProcesses: "verified", descendants: "verified", sockets: "verified", tempRoots: "verified", status: "verified" },
		});
	});

	// Unix socket leak 的创建/回收由被选中的 probe test 完成，Windows 不把
	// Named Pipe 误报为 filesystem socket verification。
	(process.platform === "win32" ? it.skip : it)("fails the executed gate when a test leaves a socket in its isolated root", () => {
		const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
		const temporaryDirectory = mkdtempSync(join(tmpdir(), "runledger-test-evidence-socket-"));
		temporaryDirectories.push(temporaryDirectory);
		const evidenceFile = join(temporaryDirectory, "evidence.json");
		const result = spawnSync(process.execPath, [
			"--import",
			"tsx",
			"scripts/run-test-buckets.ts",
			"--bucket",
			"fast",
			"--file",
			"tests/scripts/test-runner-cleanup-probe.test.ts",
			"--evidence-file",
			evidenceFile,
		], {
			cwd: repoRoot,
			encoding: "utf8",
			timeout: 30_000,
			env: { ...process.env, RUNLEDGER_TEST_CLEANUP_PROBE: "socket" },
		});

		expect(result.status).toBe(1);
		const evidence = JSON.parse(readFileSync(evidenceFile, "utf8")) as {
			executionMode: "executed";
			process: { exitCode: number };
			cleanup: { sockets: "failed"; status: "failed" };
		};
		expect(evidence).toMatchObject({
			executionMode: "executed",
			process: { exitCode: 1 },
			cleanup: { sockets: "failed", status: "failed" },
		});
	});

	it("publishes a bounded watchdog budget for each resource-sensitive chunk", () => {
		const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
		const result = spawnSync(process.execPath, [
			"--import",
			"tsx",
			"scripts/run-test-buckets.ts",
			"--bucket",
			"integration",
			"--file",
			"tests/integration/multi-agent-bounded.test.ts",
			"--dry-run",
		], { cwd: repoRoot, encoding: "utf8" });

		expect(result.status).toBe(0);
		const plan = JSON.parse(result.stdout) as Array<{ bucket: string; watchdogMs: number; chunks: unknown[] }>;
		expect(plan).toEqual([
			expect.objectContaining({ bucket: "integration", watchdogMs: expect.any(Number), chunks: expect.any(Array) }),
		]);
		expect(plan[0].watchdogMs).toBeGreaterThanOrEqual(60_000);
	});
});
