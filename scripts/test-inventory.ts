/**
 * 测试文件与 runner 归属的唯一库存。
 *
 * 规则由显式路径模式决定，不从源码关键字推测测试资源属性。Bun 归属覆盖
 * tests 下的全部 eligible 文件，runner 修改必须同步更新此处唯一规则源。
 */

import { readdir, readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type TestRunner = "vitest" | "bun" | "cargo" | "verification";

export type ExecutionBucket =
	| "fast"
	| "singleton"
	| "runtime"
	| "security-storage"
	| "integration"
	| "tui-native"
	| "rust-native"
	| "smoke";

export interface TestDiscoveryRule {
	readonly id: string;
	readonly runner: TestRunner;
	readonly include: readonly string[];
	readonly exclude?: readonly string[];
	readonly executionBucket: ExecutionBucket;
	readonly capabilityLabels?: readonly string[];
	readonly platforms?: readonly string[];
	readonly defaultLocal?: boolean;
	readonly prCi?: boolean;
	readonly nightly?: boolean;
}

export interface TestInventoryEntry {
	readonly path: string;
	readonly runner: TestRunner;
	readonly executionBucket: ExecutionBucket;
	readonly collected: number | null;
	readonly defaultLocal: boolean;
	readonly prCi: boolean;
	readonly nightly: boolean;
}

export type TestInventoryDiagnosticCode =
	| "unowned_test_file"
	| "overlapping_runner_ownership"
	| "empty_test_glob";

export interface TestInventoryDiagnostic {
	readonly code: TestInventoryDiagnosticCode;
	readonly path: string;
	readonly rules: readonly string[];
}

export interface TestInventoryReport {
	readonly schemaId: "runledger.test-inventory";
	readonly entries: readonly TestInventoryEntry[];
	readonly diagnostics: readonly TestInventoryDiagnostic[];
	readonly ok: boolean;
}

export interface InspectTestInventoryOptions {
	readonly rules?: readonly TestDiscoveryRule[];
	readonly bucketRules?: readonly TestExecutionBucketRule[];
	readonly collectedByFile?: Readonly<Record<string, number>>;
}

export interface TestExecutionBucketRule {
	readonly id: string;
	readonly executionBucket: ExecutionBucket;
	readonly include: readonly string[];
	readonly exclude?: readonly string[];
}

/** 测试 fixture/worker 是 runner 输入的辅助资源，不能被后缀误收集。 */
export const TEST_FILE_EXCLUSIONS: readonly string[] = [
	"tests/fixtures/**/*.test.ts",
	"tests/**/fixtures/**/*.test.ts",
	"tests/**/__fixtures__/**/*.test.ts",
];

/**
 * 这一规则集是默认 local runner 的唯一文件归属。Bun runner 必须递归接收
 * 每个 eligible *.bun.test.ts 文件，不能只扫描 tests/tui 顶层目录。
 */
export const DEFAULT_TEST_DISCOVERY_RULES: readonly TestDiscoveryRule[] = [
	{
		id: "vitest-built-cli-smoke",
		runner: "vitest",
		include: ["tests/scripts/run-smoke-tests.test.ts"],
		executionBucket: "smoke",
		defaultLocal: false,
		prCi: true,
	},
	{
		id: "vitest-default",
		runner: "vitest",
		include: ["tests/**/*.test.ts"],
		exclude: ["tests/**/*.bun.test.ts", "tests/scripts/run-smoke-tests.test.ts"],
		executionBucket: "fast",
		defaultLocal: true,
		prCi: true,
	},
	{
		id: "bun-tui-native",
		runner: "bun",
		include: ["tests/**/*.bun.test.ts"],
		exclude: TEST_FILE_EXCLUSIONS,
		executionBucket: "tui-native",
		capabilityLabels: ["native"],
		defaultLocal: true,
		prCi: true,
	},
	{
		id: "cargo-syntax-highlighter",
		runner: "cargo",
		include: ["native/syntax-highlighter/src/lib.rs"],
		executionBucket: "rust-native",
		capabilityLabels: ["native"],
		prCi: true,
	},
];

/**
 * Bucket 规则先匹配精确 singleton override，再匹配需要真实资源的目录。未命中
 * 的 Vitest 文件使用 runner 规则上的 fast fallback；Bun/Cargo 保持各自 native
 * bucket。override 的顺序是公开、可审计的，而不是由源码内容或文件执行耗时猜测。
 */
export const DEFAULT_TEST_EXECUTION_BUCKET_RULES: readonly TestExecutionBucketRule[] = [
	{
		id: "singleton-global-state",
		executionBucket: "singleton",
		include: [
			"tests/api/fetch-proxy-injection.test.ts",
			"tests/auth/kimi-code-oauth.test.ts",
			"tests/providers/kilo.test.ts",
			"tests/scripts/model-generation-entrypoint.test.ts",
			"tests/storage/paths.test.ts",
			"tests/utils/fetch-provider-proxy.test.ts",
			"tests/runtime/multi-agent/child-runtime.test.ts",
			"tests/runtime/session-runtime/session-execution-environment.test.ts",
			"tests/tui/opentui-streaming.test.ts",
		],
	},
	{
		id: "integration-real-io",
		executionBucket: "integration",
		include: [
			"tests/integration/**/*.test.ts",
			"tests/**/*e2e.test.ts",
			"tests/cli/multi-client/**/*.test.ts",
            "tests/cli/launcher.test.ts",
			"tests/extensions/integration/**/*.test.ts",
		],
	},
	{
		id: "security-storage-isolated-root",
		executionBucket: "security-storage",
		include: [
			"tests/auth-gateway/**/*.test.ts",
			"tests/security/**/*.test.ts",
			"tests/storage/**/*.test.ts",
			"tests/workspace/**/*.test.ts",
			"tests/worktree/**/*.test.ts",
		],
	},
	{
		id: "runtime-session",
		executionBucket: "runtime",
		include: [
			"tests/runtime/**/*.test.ts",
			"tests/runtime-contracts/**/*.test.ts",
		],
	},
];

interface CandidateFile {
	readonly path: string;
}

function normalizePath(path: string): string {
	return path.replaceAll("\\", "/");
}

async function listFiles(root: string): Promise<string[]> {
	const entries = await readdir(root, { withFileTypes: true });
	const files = await Promise.all(entries.map(async (entry) => {
		const entryPath = `${root}/${entry.name}`;
		if (entry.isDirectory()) return listFiles(entryPath);
		return entry.isFile() ? [entryPath] : [];
	}));
	return files.flat();
}

async function listFilesIfPresent(root: string): Promise<string[]> {
	try {
		return await listFiles(root);
	} catch (error: unknown) {
		if (isMissingPathError(error)) return [];
		throw error;
	}
}

function isMissingPathError(error: unknown): error is NodeJS.ErrnoException {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function matchesSegment(value: string, pattern: string): boolean {
	const source = pattern
		.split("*")
		.map((part) => part.replace(/[|\\{}()[\]^$+?.]/g, "\\$&"))
		.join(".*");
	return new RegExp(`^${source}$`).test(value);
}

function matchesGlobSegments(pathSegments: readonly string[], patternSegments: readonly string[], pathIndex = 0, patternIndex = 0): boolean {
	if (patternIndex === patternSegments.length) return pathIndex === pathSegments.length;
	const pattern = patternSegments[patternIndex];
	if (pattern === "**") {
		return matchesGlobSegments(pathSegments, patternSegments, pathIndex, patternIndex + 1)
			|| (pathIndex < pathSegments.length && matchesGlobSegments(pathSegments, patternSegments, pathIndex + 1, patternIndex));
	}
	return pathIndex < pathSegments.length
		&& matchesSegment(pathSegments[pathIndex], pattern)
		&& matchesGlobSegments(pathSegments, patternSegments, pathIndex + 1, patternIndex + 1);
}

export function matchesTestGlob(path: string, pattern: string): boolean {
	return matchesGlobSegments(
		normalizePath(path).split("/").filter(Boolean),
		normalizePath(pattern).split("/").filter(Boolean),
	);
}

function ruleIncludesPath(rule: TestDiscoveryRule, path: string): boolean {
	return rule.include.some((pattern) => matchesTestGlob(path, pattern));
}

function ruleOwnsPath(rule: TestDiscoveryRule, path: string): boolean {
	return ruleIncludesPath(rule, path) && !(rule.exclude?.some((pattern) => matchesTestGlob(path, pattern)) ?? false);
}

function bucketRuleOwnsPath(rule: TestExecutionBucketRule, path: string): boolean {
	return rule.include.some((pattern) => matchesTestGlob(path, pattern))
		&& !(rule.exclude?.some((pattern) => matchesTestGlob(path, pattern)) ?? false);
}

function resolveExecutionBucket(rule: TestDiscoveryRule, path: string, bucketRules: readonly TestExecutionBucketRule[]): ExecutionBucket {
	return bucketRules.find((bucketRule) => bucketRuleOwnsPath(bucketRule, path))?.executionBucket ?? rule.executionBucket;
}

function isExcludedTestFile(path: string): boolean {
	return TEST_FILE_EXCLUSIONS.some((pattern) => matchesTestGlob(path, pattern));
}

async function discoverCandidateFiles(repoRoot: string): Promise<CandidateFile[]> {
	const testFiles = await listFilesIfPresent(`${repoRoot}/tests`);
	const rustFiles = await listFilesIfPresent(`${repoRoot}/native/syntax-highlighter/src`);
	const rustTestFiles = await Promise.all(rustFiles
		.filter((path) => path.endsWith(".rs"))
		.map(async (path) => ({ path, source: await readFile(path, "utf8") })));
	const candidates = [
		...testFiles
			.filter((path) => path.endsWith(".test.ts"))
			.map((path) => normalizePath(relative(repoRoot, path)))
			.filter((path) => !isExcludedTestFile(path))
			.map((path) => ({ path })),
		...rustTestFiles
			.filter(({ source }) => source.includes("#[test]"))
			.map(({ path }) => ({ path: normalizePath(relative(repoRoot, path)) })),
	];
	return candidates.sort((left, right) => left.path.localeCompare(right.path));
}

function compareDiagnostics(left: TestInventoryDiagnostic, right: TestInventoryDiagnostic): number {
	return left.path.localeCompare(right.path)
		|| left.code.localeCompare(right.code)
		|| left.rules.join("\u0000").localeCompare(right.rules.join("\u0000"));
}

export async function inspectTestInventory(repoRoot: string, options: InspectTestInventoryOptions = {}): Promise<TestInventoryReport> {
	const rules = options.rules ?? DEFAULT_TEST_DISCOVERY_RULES;
	const bucketRules = options.bucketRules ?? DEFAULT_TEST_EXECUTION_BUCKET_RULES;
	const candidates = await discoverCandidateFiles(resolve(repoRoot));
	const diagnostics: TestInventoryDiagnostic[] = [];
	const entries: TestInventoryEntry[] = [];

	for (const rule of rules) {
		for (const pattern of rule.include) {
			if (!candidates.some((candidate) => matchesTestGlob(candidate.path, pattern))) {
				diagnostics.push({ code: "empty_test_glob", path: pattern, rules: [rule.id] });
			}
		}
	}

	for (const candidate of candidates) {
		const matchingRules = rules.filter((rule) => ruleOwnsPath(rule, candidate.path));
		if (matchingRules.length === 0) {
			diagnostics.push({ code: "unowned_test_file", path: candidate.path, rules: [] });
			continue;
		}
		if (matchingRules.length > 1) {
			diagnostics.push({
				code: "overlapping_runner_ownership",
				path: candidate.path,
				rules: matchingRules.map((rule) => rule.id).sort(),
			});
			continue;
		}
		const rule = matchingRules[0];
		entries.push({
			path: candidate.path,
			runner: rule.runner,
			executionBucket: resolveExecutionBucket(rule, candidate.path, bucketRules),
			collected: options.collectedByFile?.[candidate.path] ?? null,
			defaultLocal: rule.defaultLocal === true,
			prCi: rule.prCi === true,
			nightly: rule.nightly === true,
		});
	}

	entries.sort((left, right) => left.path.localeCompare(right.path));
	diagnostics.sort(compareDiagnostics);
	return {
		schemaId: "runledger.test-inventory",
		entries,
		diagnostics,
		ok: diagnostics.length === 0,
	};
}

interface CliArguments {
	readonly check: boolean;
	readonly format: "json" | "text";
	readonly repoRoot: string;
}

function parseCliArguments(argv: readonly string[]): CliArguments {
	let check = false;
	let format: "json" | "text" = "text";
	let repoRoot = fileURLToPath(new URL("..", import.meta.url));
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		if (argument === "--check") {
			check = true;
			continue;
		}
		if (argument === "--format") {
			const value = argv[index + 1];
			if (value !== "json" && value !== "text") throw new Error("--format must be json or text");
			format = value;
			index += 1;
			continue;
		}
		if (argument === "--root") {
			const value = argv[index + 1];
			if (value === undefined) throw new Error("--root requires a path");
			repoRoot = value;
			index += 1;
			continue;
		}
		throw new Error(`unknown argument: ${argument}`);
	}
	return { check, format, repoRoot: resolve(repoRoot) };
}

function printTextReport(report: TestInventoryReport): void {
	for (const diagnostic of report.diagnostics) {
		console.error(`${diagnostic.code}: ${diagnostic.path}${diagnostic.rules.length > 0 ? ` (${diagnostic.rules.join(", ")})` : ""}`);
	}
	console.log(`test inventory: ${report.entries.length} owned files, ${report.diagnostics.length} diagnostics`);
}

async function run(): Promise<void> {
	const arguments_ = parseCliArguments(process.argv.slice(2));
	const report = await inspectTestInventory(arguments_.repoRoot);
	if (arguments_.format === "json") {
		console.log(JSON.stringify(report, null, 2));
	} else {
		printTextReport(report);
	}
	if (arguments_.check && !report.ok) process.exitCode = 1;
}

if (process.argv[1]?.endsWith("test-inventory.ts")) {
	run().catch((error: unknown) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	});
}
