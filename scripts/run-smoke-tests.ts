/** 构建产物 CLI smoke：隔离用户状态，验证无交互命令和可选 TTY 生命周期。 */

import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

interface CandidateEvidence {
	readonly bin: string;
	readonly cli: string;
	readonly manifest: string;
	readonly digests: Readonly<Record<string, string>>;
}

interface CommandEvidence {
	readonly argv: string[];
	readonly exitCode: number | null;
}

interface SmokeEvidence {
	readonly schemaId: "runledger.cli-smoke.v1";
	readonly candidate: CandidateEvidence;
	readonly commands: CommandEvidence[];
	readonly isolation: {
		readonly runledgerDir: "temporary";
		readonly cleanup: "removed";
	};
	readonly tty?: {
		readonly runner: "tmux";
		readonly startup: "observed";
		readonly cleanExit: "observed";
		readonly readyMarkers: readonly string[];
		readonly startupFrameDigest: string;
		readonly launcherPid: number;
		readonly exitCode: 0;
		readonly remainingDescendants: 0;
	};
}

interface CliArguments {
	readonly repoRoot: string;
	readonly withPty: boolean;
}

const CREDENTIAL_ENVIRONMENT_NAMES = [
	"ANTHROPIC_API_KEY",
	"AWS_ACCESS_KEY_ID",
	"AWS_SECRET_ACCESS_KEY",
	"AWS_SESSION_TOKEN",
	"AZURE_OPENAI_API_KEY",
	"DEEPSEEK_API_KEY",
	"GOOGLE_API_KEY",
	"OPENAI_API_KEY",
	"OPENAI_BASE_URL",
	"OPENROUTER_API_KEY",
	"XAI_API_KEY",
	"HTTP_PROXY",
	"HTTPS_PROXY",
	"ALL_PROXY",
	"NO_PROXY",
] as const;

function parseCliArguments(argv: readonly string[]): CliArguments {
	let repoRoot = fileURLToPath(new URL("..", import.meta.url));
	let withPty = false;
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		if (argument === "--with-pty") {
			withPty = true;
			continue;
		}
		if (argument !== "--repo-root") throw new Error(`unknown argument: ${argument}`);
		const value = argv[index + 1];
		if (value === undefined) throw new Error("--repo-root requires a path");
		repoRoot = value;
		index += 1;
	}
	return { repoRoot: resolve(repoRoot), withPty };
}

function displayPath(repoRoot: string, path: string): string {
	const result = relative(repoRoot, path).replaceAll("\\", "/");
	if (result.length === 0 || result.startsWith("../") || result === "..") {
		throw new Error(`candidate path escapes the repository: ${basename(path)}`);
	}
	return result;
}

async function digestFile(path: string): Promise<string> {
	return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function requireRegularFile(path: string, label: string): Promise<void> {
	let details: Awaited<ReturnType<typeof stat>>;
	try {
		details = await stat(path);
	} catch {
		throw new Error(`built ${label} is missing; run npm run build first`);
	}
	if (!details.isFile()) throw new Error(`built ${label} is not a regular file`);
}

async function inspectCandidate(repoRoot: string): Promise<{ binPath: string; evidence: CandidateEvidence }> {
	const binPath = resolve(repoRoot, "bin/runledger.js");
	const cliPath = resolve(repoRoot, "dist/cli/cli.js");
	const manifestPath = resolve(repoRoot, "dist/host-build-manifest.json");
	await Promise.all([
		requireRegularFile(binPath, "bin launcher"),
		requireRegularFile(cliPath, "CLI entrypoint"),
		requireRegularFile(manifestPath, "Host build manifest"),
	]);
	const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { format?: unknown; contentDigest?: unknown };
	if (manifest.format !== "runledger-host-build-current" || typeof manifest.contentDigest !== "object" || manifest.contentDigest === null) {
		throw new Error("built Host manifest is not current-format evidence");
	}
	return {
		binPath,
		evidence: {
			bin: displayPath(repoRoot, binPath),
			cli: displayPath(repoRoot, cliPath),
			manifest: displayPath(repoRoot, manifestPath),
			digests: {
				bin: await digestFile(binPath),
				cli: await digestFile(cliPath),
				manifest: await digestFile(manifestPath),
			},
		},
	};
}

function isolatedEnvironment(runledgerDir: string): NodeJS.ProcessEnv {
	const environment: NodeJS.ProcessEnv = { ...process.env };
	for (const name of Object.keys(environment)) {
		if (name.startsWith("RUNLEDGER_") || name.endsWith("_API_KEY") || name.endsWith("_AUTH_TOKEN")) delete environment[name];
	}
	for (const name of CREDENTIAL_ENVIRONMENT_NAMES) delete environment[name];
	environment.RUNLEDGER_DIR = runledgerDir;
	environment.HOME = runledgerDir;
	environment.XDG_CONFIG_HOME = join(runledgerDir, "config");
	environment.XDG_DATA_HOME = join(runledgerDir, "data");
	return environment;
}

function runCommand(repoRoot: string, binPath: string, args: readonly string[], environment: NodeJS.ProcessEnv): CommandEvidence {
	const result = spawnSync(process.execPath, [binPath, ...args], {
		cwd: repoRoot,
		encoding: "utf8",
		env: environment,
		timeout: 30_000,
	});
	if (result.error !== undefined || result.signal !== null || result.status !== 0) {
		throw new Error(`built CLI ${args.join(" ")} did not exit successfully`);
	}
	return { argv: [...args], exitCode: result.status };
}

function runTmux(repoRoot: string, environment: NodeJS.ProcessEnv, socket: string, args: readonly string[]): string {
	const result = spawnSync("tmux", ["-L", socket, ...args], { cwd: repoRoot, encoding: "utf8", env: environment, timeout: 30_000 });
	if (result.error !== undefined || result.signal !== null || result.status !== 0) {
		throw new Error(`tmux ${args[0] ?? "command"} did not exit successfully`);
	}
	return result.stdout ?? "";
}

function tmuxSessionExists(repoRoot: string, environment: NodeJS.ProcessEnv, socket: string, session: string): boolean {
	const result = spawnSync("tmux", ["-L", socket, "has-session", "-t", session], { cwd: repoRoot, encoding: "utf8", env: environment, timeout: 5_000 });
	return result.error === undefined && result.status === 0;
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return true;
		await delay(100);
	}
	return predicate();
}

interface ProcessIdentity {
	readonly pid: number;
	readonly parentPid: number;
	readonly groupPid: number;
	readonly startedAt: string;
}

function processSnapshot(): ProcessIdentity[] {
	const result = spawnSync("ps", ["-eo", "pid=,ppid=,pgid=,stat=,lstart="], { encoding: "utf8", timeout: 5_000 });
	if (result.error !== undefined || result.status !== 0) throw new Error("cannot inspect TUI descendant processes");
	return result.stdout.trim().split("\n").flatMap((line) => {
		const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/.exec(line);
		if (match === null || match[4]?.startsWith("Z")) return [];
		return [{ pid: Number(match[1]), parentPid: Number(match[2]), groupPid: Number(match[3]), startedAt: match[5] ?? "" }];
	});
}

function shellQuote(value: string): string {
	return "'" + value.replaceAll("'", "'\\''") + "'";
}

// Welcome 标题可能被换行 Tip 推出视口；输入区才是稳定的就绪标记。
const READY_MARKERS = ["Message RunLedger"] as const;

async function runTtySmoke(repoRoot: string, binPath: string, environment: NodeJS.ProcessEnv): Promise<NonNullable<SmokeEvidence["tty"]>> {
	const identifier = `runledger-smoke-${process.pid}-${randomUUID().replaceAll("-", "")}`;
	const session = identifier;
	const socket = identifier;
	const descendants = new Map<number, ProcessIdentity>();
	const groups = new Set<number>();
	let launcherPid: number | undefined;
	let frame = "";
	const paneState = (): { dead: boolean; exitCode: number | null } => {
		const state = runTmux(repoRoot, environment, socket, ["display-message", "-p", "-t", session, "#{pane_dead}|#{pane_dead_status}"]).trim().split("|");
		return { dead: state[0] === "1", exitCode: /^\d+$/.test(state[1] ?? "") ? Number(state[1]) : null };
	};
	const observeProcesses = (): ProcessIdentity[] => {
		const snapshot = processSnapshot();
		let discovered = true;
		while (discovered) {
			discovered = false;
			for (const entry of snapshot) {
				if (descendants.get(entry.pid)?.startedAt === entry.startedAt) continue;
				if (entry.pid !== launcherPid && !descendants.has(entry.parentPid) && !groups.has(entry.groupPid)) continue;
				descendants.set(entry.pid, entry);
				groups.add(entry.groupPid);
				discovered = true;
			}
		}
		return snapshot.filter((entry) => descendants.get(entry.pid)?.startedAt === entry.startedAt);
	};
	try {
		// 先固定 remain-on-exit 再启动应用，捕获启动即崩溃的真实退出码；兼容 tmux 2.6。
		runTmux(repoRoot, environment, socket, ["new-session", "-d", "-s", session, "-x", "100", "-y", "30", "-c", repoRoot, "sleep 3600"]);
		runTmux(repoRoot, environment, socket, ["set-window-option", "-t", session, "remain-on-exit", "on"]);
		runTmux(repoRoot, environment, socket, ["respawn-pane", "-k", "-t", session, `exec ${shellQuote(process.execPath)} ${shellQuote(binPath)}`]);
		launcherPid = Number(runTmux(repoRoot, environment, socket, ["display-message", "-p", "-t", session, "#{pane_pid}"]).trim());
		if (!Number.isSafeInteger(launcherPid) || launcherPid <= 0) throw new Error("tmux launcher PID is unavailable");
		const checkStartup = (): boolean => {
			observeProcesses();
			const state = paneState();
			if (state.dead) throw new Error(`TUI exited before ready interaction (exit ${state.exitCode ?? "unknown"})`);
			frame = runTmux(repoRoot, environment, socket, ["capture-pane", "-p", "-t", session]);
			if (/\[runledger\]\s*fatal:|(?:Syntax|Reference|Type)Error:/.test(frame)) throw new Error("TUI startup reported a fatal error");
			return READY_MARKERS.every((marker) => frame.includes(marker));
		};
		if (!await waitFor(checkStartup, 10_000)) throw new Error("tmux TUI did not render the RunLedger ready markers");
		await delay(150);
		if (!checkStartup()) throw new Error("TUI ready frame did not remain available for interaction");
		const startupFrameDigest = createHash("sha256").update(frame).digest("hex");
		runTmux(repoRoot, environment, socket, ["send-keys", "-t", session, "C-d"]);
		const hasExited = (): boolean => { observeProcesses(); return paneState().dead; };
		let stopped = await waitFor(hasExited, 3_000);
		if (!stopped) {
			runTmux(repoRoot, environment, socket, ["send-keys", "-t", session, "Escape", "C-d"]);
			stopped = await waitFor(hasExited, 7_000);
		}
		if (!stopped) throw new Error("tmux TUI did not exit after Ctrl+D");
		const { exitCode } = paneState();
		if (exitCode !== 0) throw new Error(`TUI did not exit cleanly (exit ${exitCode ?? "unknown"})`);
		if (!await waitFor(() => observeProcesses().length === 0, 1_000)) throw new Error("TUI left descendant processes running after exit");
		return { runner: "tmux", startup: "observed", cleanExit: "observed", readyMarkers: READY_MARKERS, startupFrameDigest, launcherPid, exitCode: 0, remainingDescendants: 0 };
	} finally {
		// 负向用例也清理已识别的 detached child；绝不按全局进程名结束任务。
		for (const entry of observeProcesses()) {
			try { process.kill(entry.pid, "SIGKILL"); } catch (error: unknown) {
				if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
			}
		}
		if (tmuxSessionExists(repoRoot, environment, socket, session)) {
			const result = spawnSync("tmux", ["-L", socket, "kill-session", "-t", session], { cwd: repoRoot, encoding: "utf8", env: environment, timeout: 5_000 });
			if (result.error !== undefined || result.status !== 0) throw new Error("tmux cleanup failed");
		}
	}
}

export async function runBuiltCliSmoke(options: CliArguments): Promise<SmokeEvidence> {
	const { binPath, evidence: candidate } = await inspectCandidate(options.repoRoot);
	const isolatedHome = await mkdtemp(join(tmpdir(), "runledger-cli-smoke-"));
	try {
		const environment = isolatedEnvironment(isolatedHome);
		const commands = [
			runCommand(options.repoRoot, binPath, ["--version"], environment),
			runCommand(options.repoRoot, binPath, ["--help"], environment),
		];
		const tty = options.withPty ? await runTtySmoke(options.repoRoot, binPath, environment) : undefined;
		return {
			schemaId: "runledger.cli-smoke.v1",
			candidate,
			commands,
			isolation: { runledgerDir: "temporary", cleanup: "removed" },
			...(tty === undefined ? {} : { tty }),
		};
	} finally {
		await rm(isolatedHome, { recursive: true, force: true });
	}
}

const invokedPath = process.argv[1] === undefined ? undefined : resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
	try {
		const evidence = await runBuiltCliSmoke(parseCliArguments(process.argv.slice(2)));
		process.stdout.write(`${JSON.stringify(evidence)}\n`);
	} catch (error: unknown) {
		process.stderr.write(`[runledger] CLI smoke failed: ${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	}
}
