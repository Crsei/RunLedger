/**
 * 记录门禁命令的墙钟耗时（默认 `npm run check` 与 `npm test`）。
 *
 * 每次执行以追加方式向 --out（默认 tmp/gate-timings.jsonl，位于 gitignore 的本地
 * 证据目录）写入一条 JSONL 记录，并汇总各门禁的历史耗时，用来比较不同提交、
 * 机器与工作树状态下的真实时间成本。脚本只读取 Git 与工具链版本，不修改仓库状态；
 * 子进程输出直接继承 stdio，长时间运行时可见完整进度。
 *
 * 用法：
 *   npx tsx scripts/record-gate-timings.ts                 # 依次运行 check、test
 *   npx tsx scripts/record-gate-timings.ts test            # 只运行指定 npm script
 *   npx tsx scripts/record-gate-timings.ts --summary       # 只打印历史统计
 *   npx tsx scripts/record-gate-timings.ts --out <path>    # 指定记录文件
 *   npx tsx scripts/record-gate-timings.ts --keep-going    # 某个门禁失败后继续运行其余门禁
 */

import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { arch, cpus, hostname, loadavg, platform } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type GateTimingSchemaVersion = 1;

export const GATE_TIMING_SCHEMA_VERSION: GateTimingSchemaVersion = 1;
export const DEFAULT_GATE_NAMES: readonly string[] = ["check", "test"];
export const DEFAULT_RECORD_PATH = "tmp/gate-timings.jsonl";

export interface GateTimingGitContext {
	readonly branch: string | null;
	readonly commit: string | null;
	readonly dirty: boolean;
}

export interface GateTimingRuntimeContext {
	readonly node: string;
	readonly npm: string | null;
	readonly bun: string | null;
	readonly platform: string;
	readonly arch: string;
	readonly cpuCount: number;
	readonly hostname: string;
	readonly loadAverage: readonly number[];
}

export interface GateTimingContext {
	readonly git: GateTimingGitContext;
	readonly runtime: GateTimingRuntimeContext;
}

/** 一条门禁执行记录；durationMs 为墙钟时间，包含 npm 启动与子进程退出开销。 */
export interface GateTimingRecord {
	readonly schemaVersion: GateTimingSchemaVersion;
	readonly gate: string;
	readonly command: string;
	readonly startedAt: string;
	readonly finishedAt: string;
	readonly durationMs: number;
	readonly exitCode: number | null;
	readonly signal: string | null;
	readonly passed: boolean;
	readonly exitKind: string;
	readonly git: GateTimingGitContext;
	readonly runtime: GateTimingRuntimeContext;
}

export interface GateSummary {
	readonly gate: string;
	readonly runs: number;
	readonly passedRuns: number;
	readonly lastStartedAt: string;
	readonly lastDurationMs: number;
	readonly lastPassed: boolean;
	readonly minDurationMs: number;
	readonly medianDurationMs: number;
	readonly maxDurationMs: number;
}

export interface TimingOptions {
	readonly gates: readonly string[];
	readonly outPath: string;
	readonly summaryOnly: boolean;
	readonly keepGoing: boolean;
}

const USAGE = [
	"usage: record-gate-timings.ts [<npm-script> ...] [--out <path>] [--summary] [--keep-going]",
	`  <npm-script>   要计时并运行的 npm script（默认：${DEFAULT_GATE_NAMES.join(", ")}）`,
	`  --out <path>   记录文件，相对仓库根或绝对路径（默认：${DEFAULT_RECORD_PATH}）`,
	"  --summary      只读取并打印已有记录的统计，不运行门禁",
	"  --keep-going   某个门禁失败后仍继续运行其余门禁",
].join("\n");

const GATE_NAME_PATTERN = /^[A-Za-z0-9:_.-]+$/;

// Windows 上 npm 只有 .cmd 垫片，spawn 不能直接执行。
const NPM_EXECUTABLE = platform() === "win32" ? "npm.cmd" : "npm";

function readCommandOutput(command: string, args: readonly string[], cwd: string): string | null {
	const result = spawnSync(command, [...args], { cwd, encoding: "utf8" });
	if (result.error !== undefined || result.status !== 0) return null;
	const output = result.stdout.trim();
	return output === "" ? null : output;
}

export function collectGateTimingContext(repoRoot: string): GateTimingContext {
	const status = readCommandOutput("git", ["status", "--porcelain"], repoRoot);
	return {
		git: {
			branch: readCommandOutput("git", ["rev-parse", "--abbrev-ref", "HEAD"], repoRoot),
			commit: readCommandOutput("git", ["rev-parse", "HEAD"], repoRoot),
			// 脏工作树会改变 check/test 的实际工作量，因此记录下来以便比较。
			dirty: status !== null && status !== "",
		},
		runtime: {
			node: process.version,
			npm: readCommandOutput(NPM_EXECUTABLE, ["--version"], repoRoot),
			bun: readCommandOutput("bun", ["--version"], repoRoot),
			platform: platform(),
			arch: arch(),
			cpuCount: cpus().length,
			hostname: hostname(),
			loadAverage: loadavg().map((value) => Math.round(value * 100) / 100),
		},
	};
}

export function runTimedGate(gate: string, repoRoot: string, context: GateTimingContext): GateTimingRecord {
	const startedAt = new Date();
	const startedNs = process.hrtime.bigint();
	const result = spawnSync(NPM_EXECUTABLE, ["run", gate], { cwd: repoRoot, stdio: "inherit" });
	const durationMs = Math.round(Number(process.hrtime.bigint() - startedNs) / 1e4) / 100;
	const finishedAt = new Date();
	if (result.error !== undefined) {
		throw new Error(`failed to start npm run ${gate}: ${result.error.message}`);
	}
	const signal = result.signal ?? null;
	return {
		schemaVersion: GATE_TIMING_SCHEMA_VERSION,
		gate,
		command: `npm run ${gate}`,
		startedAt: startedAt.toISOString(),
		finishedAt: finishedAt.toISOString(),
		durationMs,
		exitCode: result.status,
		signal,
		passed: result.status === 0 && signal === null,
		exitKind: signal !== null ? `signal:${signal}` : result.status === 0 ? "ok" : "nonzero_exit",
		git: context.git,
		runtime: context.runtime,
	};
}

function isGateTimingRecord(value: unknown): value is GateTimingRecord {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Partial<GateTimingRecord>;
	return (
		typeof candidate.gate === "string" &&
		typeof candidate.durationMs === "number" &&
		Number.isFinite(candidate.durationMs) &&
		typeof candidate.startedAt === "string" &&
		typeof candidate.passed === "boolean"
	);
}

/** 逐行解析 JSONL；文件不存在视为空历史，损坏行跳过并告警，避免一条坏记录毁掉整个统计。 */
export function readGateTimingRecords(recordPath: string): readonly GateTimingRecord[] {
	let text: string;
	try {
		text = readFileSync(recordPath, "utf8");
	} catch (error) {
		// 首次运行尚无记录文件，视为空历史。
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return [];
		throw error;
	}
	const records: GateTimingRecord[] = [];
	text.split("\n").forEach((line, index) => {
		const trimmed = line.trim();
		if (trimmed === "") return;
		let parsed: unknown;
		try {
			parsed = JSON.parse(trimmed);
		} catch {
			process.stderr.write(`skip malformed record at ${recordPath}:${index + 1}\n`);
			return;
		}
		if (!isGateTimingRecord(parsed)) {
			process.stderr.write(`skip malformed record at ${recordPath}:${index + 1}\n`);
			return;
		}
		records.push(parsed);
	});
	return records;
}

export function appendGateTimingRecord(recordPath: string, record: GateTimingRecord): void {
	mkdirSync(dirname(recordPath), { recursive: true });
	appendFileSync(recordPath, `${JSON.stringify(record)}\n`, "utf8");
}

function median(sorted: readonly number[]): number {
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function summarizeGateTimings(records: readonly GateTimingRecord[]): readonly GateSummary[] {
	const byGate = new Map<string, GateTimingRecord[]>();
	for (const record of records) {
		const existing = byGate.get(record.gate);
		if (existing === undefined) byGate.set(record.gate, [record]);
		else existing.push(record);
	}
	const summaries: GateSummary[] = [];
	for (const [gate, gateRecords] of byGate) {
		const ordered = [...gateRecords].sort((left, right) => left.startedAt.localeCompare(right.startedAt));
		const last = ordered[ordered.length - 1];
		const passed = ordered.filter((record) => record.passed);
		// 失败运行通常提前中断，耗时不可比，分位数只取通过运行的样本。
		const durations = passed.map((record) => record.durationMs).sort((left, right) => left - right);
		summaries.push({
			gate,
			runs: ordered.length,
			passedRuns: passed.length,
			lastStartedAt: last.startedAt,
			lastDurationMs: last.durationMs,
			lastPassed: last.passed,
			minDurationMs: durations.length === 0 ? 0 : durations[0],
			medianDurationMs: durations.length === 0 ? 0 : median(durations),
			maxDurationMs: durations.length === 0 ? 0 : durations[durations.length - 1],
		});
	}
	return summaries.sort((left, right) => left.gate.localeCompare(right.gate));
}

export function formatDuration(durationMs: number): string {
	if (durationMs < 1000) return `${Math.round(durationMs)}ms`;
	const totalSeconds = durationMs / 1000;
	if (totalSeconds < 60) return `${totalSeconds.toFixed(1)}s`;
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = (totalSeconds - minutes * 60).toFixed(1).padStart(4, "0");
	if (minutes < 60) return `${minutes}m ${seconds}s`;
	return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m ${seconds}s`;
}

export function renderGateTimingSummary(summaries: readonly GateSummary[]): string {
	if (summaries.length === 0) return "no gate timing records yet";
	const header = ["gate", "runs", "pass", "last", "median(pass)", "min(pass)", "max(pass)", "last started"];
	const rows = summaries.map((summary) => [
		summary.gate,
		String(summary.runs),
		String(summary.passedRuns),
		`${formatDuration(summary.lastDurationMs)}${summary.lastPassed ? "" : "*"}`,
		summary.passedRuns === 0 ? "-" : formatDuration(summary.medianDurationMs),
		summary.passedRuns === 0 ? "-" : formatDuration(summary.minDurationMs),
		summary.passedRuns === 0 ? "-" : formatDuration(summary.maxDurationMs),
		summary.lastStartedAt,
	]);
	const widths = header.map((title, index) => Math.max(title.length, ...rows.map((row) => row[index].length)));
	const render = (row: readonly string[]): string =>
		row.map((cell, index) => (index === row.length - 1 ? cell : cell.padEnd(widths[index]))).join("  ").trimEnd();
	const lines = [render(header), ...rows.map(render)];
	if (summaries.some((summary) => !summary.lastPassed)) lines.push("* last run did not pass");
	return lines.join("\n");
}

export function parseTimingOptions(argv: readonly string[]): TimingOptions | string {
	const gates: string[] = [];
	let outPath = DEFAULT_RECORD_PATH;
	let summaryOnly = false;
	let keepGoing = false;
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		if (argument === "--summary") {
			summaryOnly = true;
		} else if (argument === "--keep-going") {
			keepGoing = true;
		} else if (argument === "--out") {
			const value = argv[index + 1];
			if (value === undefined || value.startsWith("--")) return "--out requires a path";
			outPath = value;
			index += 1;
		} else if (argument.startsWith("--")) {
			return `unknown option ${argument}`;
		} else {
			if (!GATE_NAME_PATTERN.test(argument)) return `invalid npm script name ${argument}`;
			gates.push(argument);
		}
	}
	return { gates: gates.length === 0 ? [...DEFAULT_GATE_NAMES] : gates, outPath, summaryOnly, keepGoing };
}

function readPackageScripts(repoRoot: string): Readonly<Record<string, string>> {
	const parsed = JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf8")) as { scripts?: Record<string, string> };
	return parsed.scripts ?? {};
}

function validateGates(gates: readonly string[], scripts: Readonly<Record<string, string>>): string | null {
	const missing = gates.filter((gate) => scripts[gate] === undefined);
	if (missing.length === 0) return null;
	const available = Object.keys(scripts).filter((name) => GATE_NAME_PATTERN.test(name)).sort();
	return `unknown npm script${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}\navailable: ${available.join(", ")}`;
}

export async function main(argv: readonly string[]): Promise<number> {
	if (argv.includes("--help") || argv.includes("-h")) {
		process.stdout.write(`${USAGE}\n`);
		return 0;
	}
	const parsed = parseTimingOptions(argv);
	if (typeof parsed === "string") {
		process.stderr.write(`${parsed}\n${USAGE}\n`);
		return 2;
	}
	const repoRoot = fileURLToPath(new URL("..", import.meta.url));
	const recordPath = resolve(repoRoot, parsed.outPath);
	const existing = readGateTimingRecords(recordPath);

	if (parsed.summaryOnly) {
		process.stdout.write(`${renderGateTimingSummary(summarizeGateTimings(existing))}\n`);
		process.stdout.write(`records: ${recordPath} (${existing.length} entries)\n`);
		return 0;
	}

	const scripts = readPackageScripts(repoRoot);
	const gateError = validateGates(parsed.gates, scripts);
	if (gateError !== null) {
		process.stderr.write(`${gateError}\n`);
		return 2;
	}

	const context = collectGateTimingContext(repoRoot);
	const executed: GateTimingRecord[] = [];
	let failed = false;
	for (const gate of parsed.gates) {
		process.stdout.write(`\n=== npm run ${gate} @ ${new Date().toISOString()} ===\n`);
		const record = runTimedGate(gate, repoRoot, context);
		executed.push(record);
		appendGateTimingRecord(recordPath, record);
		process.stdout.write(
			`=== ${gate}: ${formatDuration(record.durationMs)} (${record.exitKind}${record.exitCode === null ? "" : `, exit ${record.exitCode}`}) ===\n`,
		);
		if (!record.passed) {
			failed = true;
			if (!parsed.keepGoing) {
				process.stderr.write(`${gate} failed; stopping before remaining gates (use --keep-going to continue)\n`);
				break;
			}
		}
	}

	process.stdout.write(`\nrecords: ${recordPath}\n`);
	process.stdout.write(`${renderGateTimingSummary(summarizeGateTimings([...existing, ...executed]))}\n`);
	return failed ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
	main(process.argv.slice(2)).then((exitCode) => {
		process.exitCode = exitCode;
	}).catch((error: unknown) => {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	});
}
