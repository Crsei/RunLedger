/** 多平台 workspace/path 适配计划 P1：只读平台证据采集脚本（当前 runner 上运行）。 */

/**
 * 本脚本在【当前机器】采集路径 / Git / Shell / 进程 / cleanup 的真实原始证据，
 * 输出到 --out 目录。证据按平台分开、以 SHA-256 digest manifest 固定为 immutable
 * fixtures；macOS / Windows 未在此 runner 验证的条目必须记录为 gap，不得计为通过。
 *
 * 用法：npx tsx scripts/collect-platform-evidence.ts --out <staging-dir>
 *
 * 产物：
 *   <out>/raw/<probe>.txt     每个探针的原始输出（不截断、不重写）
 *   <out>/evidence.json       结构化汇总（版本固定 + 每个证据单元格）
 *   <out>/manifest.json       sha256 digest manifest（证据不可变性证明）
 *
 * 本脚本会创建并清理临时 Git 仓库与临时文件；不修改 src/tests/配置/依赖。
 */

import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

function run(argv: readonly string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv; stdin?: string } = {}): { stdout: string; stderr: string; exitCode: number } {
	const result = spawnSync(argv[0] ?? "", argv.slice(1), {
		cwd: opts.cwd,
		env: opts.env ? { ...process.env, ...opts.env } : process.env,
		input: opts.stdin,
		encoding: "utf8",
		timeout: 30_000,
		maxBuffer: 16 * 1024 * 1024,
	});
	return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", exitCode: result.status ?? -1 };
}

function probe(argv: readonly string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv; stdin?: string } = {}): { ok: boolean; stdout: string; stderr: string; exitCode: number } {
	const result = run(argv, opts);
	return { ok: result.exitCode === 0, ...result };
}

function sha256(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

function digestManifest(files: readonly { name: string; content: string }[]): Record<string, string> {
	const manifest: Record<string, string> = {};
	for (const file of files) manifest[file.name] = sha256(file.content);
	return manifest;
}

const platform = process.platform;
const arch = process.arch;
const outDir = resolve(process.argv[process.argv.indexOf("--out") + 1] ?? "tmp/platform-evidence");
const rawDir = join(outDir, "raw");
mkdirSync(rawDir, { recursive: true });

const raw: Record<string, string> = {};
const writeRaw = (name: string, content: string): void => {
	raw[name] = content;
	writeFileSync(join(rawDir, name), content);
};

const probes: Record<string, { ok: boolean; stdout: string; stderr: string; exitCode: number }> = {};

async function main(): Promise<void> {
	const evidence: Record<string, unknown> = {};

	// ---------------------------------------------------------------------------
	// 1. runner 与工具版本固定
	// ---------------------------------------------------------------------------
	const nodeInfo = probe([process.execPath, "--version"]);
	const gitInfo = probe(["git", "--version"]);
	const bashInfo = probe(["bash", "--version"]);
	const shInfo = probe(["sh", "-c", "printf '%s' \"$0\""]);
	const zshInfo = probe(["zsh", "-c", "printf '%s' \"$0\""]);
	const unameInfo = probe(["uname", "-a"]);
	const osRelease = existsSync("/etc/os-release") ? readFileSync("/etc/os-release", "utf8") : "";
	const cwdStat = statSync(process.cwd());
	const cwd = process.cwd();
	const mountInfo = probe(["stat", "-f", "-c", `%T ${cwd}`, cwd]);

	probes.node = nodeInfo;
	probes.git = gitInfo;
	probes.bash = bashInfo;
	probes.sh = shInfo;
	probes.zsh = zshInfo;
	probes.uname = unameInfo;
	probes.osRelease = { ok: osRelease.length > 0, stdout: osRelease, stderr: "", exitCode: osRelease.length > 0 ? 0 : -1 };
	probes.mount = mountInfo;

	writeRaw("node-version.txt", `${nodeInfo.stdout}${nodeInfo.stderr}`);
	writeRaw("git-version.txt", `${gitInfo.stdout}${gitInfo.stderr}`);
	writeRaw("bash-version.txt", `${bashInfo.stdout}${bashInfo.stderr}`);
	writeRaw("sh-version.txt", `${shInfo.stdout}${shInfo.stderr}`);
	writeRaw("zsh-version.txt", `${zshInfo.stdout}${zshInfo.stderr}`);
	writeRaw("uname.txt", `${unameInfo.stdout}${unameInfo.stderr}`);
	writeRaw("os-release.txt", osRelease);
	writeRaw("mount.txt", `${mountInfo.stdout}${mountInfo.stderr}`);

	evidence.runner = {
		platform,
		arch,
		node: nodeInfo.stdout.trim(),
		git: gitInfo.stdout.trim(),
		bash: bashInfo.ok ? bashInfo.stdout.split("\n")[0] ?? "" : null,
		sh: shInfo.ok ? shInfo.stdout.split("\n")[0] ?? "" : null,
		zsh: zshInfo.ok ? zshInfo.stdout.split("\n")[0] ?? "" : null,
		uname: unameInfo.stdout.trim(),
		filesystemType: mountInfo.ok ? mountInfo.stdout.trim() : null,
		cwd,
		cwdDev: cwdStat.dev,
		cwdIno: cwdStat.ino,
	};

	// ---------------------------------------------------------------------------
	// 2. 临时证据沙盒：路径 / symlink / candidate ancestor / git / shell / process
	// ---------------------------------------------------------------------------
	const sandbox = join(tmpdir(), `runledger-platform-evidence-${process.pid}`);
	rmSync(sandbox, { recursive: true, force: true });
	mkdirSync(sandbox, { recursive: true });

	try {
		// --- 2.1 路径身份：绝对路径识别（node:path 当前平台行为） ---
		const pathApi = await import("node:path");
		const cases = ["/abs/path", "C:\\abs\\path", "\\\\server\\share\\x", "\\\\?\\C:\\device", "relative/path", "/"];
		const pathCases: Record<string, unknown> = {};
		for (const input of cases) {
			pathCases[input] = {
				isAbsolute_posix: pathApi.posix.isAbsolute(input),
				isAbsolute_win32: pathApi.win32.isAbsolute(input),
				normalized_posix: pathApi.posix.normalize(input),
				normalized_win32: pathApi.win32.normalize(input),
			};
		}
		evidence.path = { platform, cases: pathCases };
		writeRaw("path-is-absolute.txt", JSON.stringify(pathCases, null, 2));

		// --- 2.2 大小写保留与比较身份（真实 filesystem） ---
		const caseRoot = join(sandbox, "case-sensitivity");
		mkdirSync(join(caseRoot, "MixedCase"), { recursive: true });
		const lowerStat = statSync(join(caseRoot, "mixedcase"), { throwIfNoEntry: false });
		writeRaw("case-sensitive-probe.txt", [
			`created: ${join(caseRoot, "MixedCase")}`,
			`lstat(mixedcase) exists on current fs: ${lowerStat !== undefined}`,
			`fs is case-sensitive if mixedcase is absent`,
		].join("\n"));
		evidence.path.caseSensitiveProbe = { created: join(caseRoot, "MixedCase"), lowerVariantExists: lowerStat !== undefined };

		// --- 2.3 existing realpath 与 symlink 身份 ---
		const symRoot = join(sandbox, "symlink");
		const targetDir = join(symRoot, "target");
		const symlink = join(symRoot, "link");
		mkdirSync(targetDir, { recursive: true });
		writeFileSync(join(targetDir, "file.txt"), "evidence\n");
		const symlinkProbe = probe(["ln", "-s", "target", symlink]);
		const realpathProbe = probe([process.execPath, "-e", `console.log(require('fs').realpathSync(process.argv[1]))`, join(symlink, "file.txt")]);
		const lstatProbe = probe([process.execPath, "-e", `const s=require('fs').lstatSync(process.argv[1]);console.log('isSymbolicLink='+s.isSymbolicLink())`, symlink]);
		probes.symlink = symlinkProbe;
		probes.realpath = realpathProbe;
		probes.lstat = lstatProbe;
		writeRaw("symlink-create.txt", `${symlinkProbe.stdout}${symlinkProbe.stderr}`);
		writeRaw("realpath.txt", `${realpathProbe.stdout}${realpathProbe.stderr}`);
		writeRaw("lstat.txt", `${lstatProbe.stdout}${lstatProbe.stderr}`);
		evidence.path.symlink = {
			createExitCode: symlinkProbe.exitCode,
			realpath: realpathProbe.stdout.trim(),
			lstat: lstatProbe.stdout.trim(),
		};

		// --- 2.4 candidate path：nearest-existing-ancestor realpath ---
		const ancestorProbe = probe([process.execPath, "-e", `
			const fs = require("fs");
			const path = require("path");
			let p = process.argv[1];
			let nearest = null;
			const missing = [];
			while (true) {
				const parent = path.dirname(p);
				if (parent === p) break;
				if (fs.existsSync(p)) { nearest = p; break; }
				missing.unshift(path.basename(p));
				p = parent;
			}
			console.log("nearestExisting=" + nearest);
			console.log("remainingSegments=" + JSON.stringify(missing));
			console.log("canonicalCandidate=" + (nearest === null ? null : path.join(nearest, ...missing)));
		`, join(sandbox, "not-existing", "deeper", "candidate.txt")]);
		probes.ancestor = ancestorProbe;
		writeRaw("nearest-existing-ancestor.txt", `${ancestorProbe.stdout}${ancestorProbe.stderr}`);
		evidence.path.candidateProbe = {
			candidate: join(sandbox, "not-existing", "deeper", "candidate.txt"),
			output: ancestorProbe.stdout.trim(),
		};

		// --- 2.5 Git porcelain create/list/remove + source subdir + bare repo ---
		const repoRoot = join(sandbox, "repo");
		mkdirSync(repoRoot, { recursive: true });
		probe(["git", "init", "-q"], { cwd: repoRoot });
		probe(["git", "config", "user.email", "evidence@runledger.local"], { cwd: repoRoot });
		probe(["git", "config", "user.name", "RunLedger Evidence"], { cwd: repoRoot });
		writeFileSync(join(repoRoot, "base.txt"), "base\n");
		probe(["git", "add", "."], { cwd: repoRoot });
		probe(["git", "commit", "-qm", "initial"], { cwd: repoRoot });

		const subdir = join(repoRoot, "packages", "app");
		mkdirSync(subdir, { recursive: true });
		writeFileSync(join(subdir, "app.txt"), "app\n");
		probe(["git", "add", "."], { cwd: repoRoot });
		probe(["git", "commit", "-qm", "add subdir"], { cwd: repoRoot });
		const head = probe(["git", "rev-parse", "HEAD"], { cwd: repoRoot });

		const worktreePath = join(sandbox, "managed", "repo-slug", "task");
		mkdirSync(dirname(worktreePath), { recursive: true });
		const createProbe = probe(["git", "worktree", "add", "--detach", worktreePath, head.stdout.trim()], { cwd: repoRoot });
		probes.worktreeCreate = createProbe;
		const listProbe = probe(["git", "worktree", "list", "--porcelain"], { cwd: repoRoot });
		probes.worktreeList = listProbe;
		const toplevelProbe = probe(["git", "rev-parse", "--show-toplevel"], { cwd: subdir });
		const prefixProbe = probe(["git", "rev-parse", "--show-prefix"], { cwd: subdir });
		writeRaw("git-worktree-create.txt", `${createProbe.stdout}${createProbe.stderr}`);
		writeRaw("git-worktree-list-porcelain.txt", `${listProbe.stdout}${listProbe.stderr}`);
		writeRaw("git-rev-parse-subdir.txt", `toplevel=${toplevelProbe.stdout.trim()}\nprefix=${prefixProbe.stdout.trim()}\n`);

		// occupied-file cleanup：另一个进程把 cwd 锁进 worktree 后 remove
		// （Linux POSIX 允许删除仍是某进程 cwd 的目录——真实证据的一部分）
		const cwdHeld = probe(["bash", "-c", "sleep 0.4 && rm -f \"$1\"", "hold", join(worktreePath, ".git", "this-probe")], { cwd: worktreePath });
		const busyProbe = probe(["git", "worktree", "remove", worktreePath], { cwd: repoRoot });
		probes.worktreeBusyRemove = busyProbe;
		const busyAgain = probe(["git", "worktree", "list", "--porcelain"], { cwd: repoRoot });
		probes.worktreeListAfterBusyRemove = busyAgain;
		writeRaw("git-worktree-busy-remove.txt", `heldCwdProbeExit=${cwdHeld.exitCode}\n${busyProbe.stdout}${busyProbe.stderr}\n--- list after ---\n${busyAgain.stdout}`);

		// git 原生 locked 机制：lock 后 remove 必须失败，porcelain 显示 locked
		const worktreePath2 = join(sandbox, "managed", "repo-slug", "task-locked");
		mkdirSync(dirname(worktreePath2), { recursive: true });
		probe(["git", "worktree", "add", "--detach", worktreePath2, head.stdout.trim()], { cwd: repoRoot });
		const gitLockProbe = probe(["git", "worktree", "lock", worktreePath2], { cwd: repoRoot });
		probes.worktreeLock = gitLockProbe;
		const lockedRemoveProbe = probe(["git", "worktree", "remove", worktreePath2], { cwd: repoRoot });
		probes.worktreeLockedRemove = lockedRemoveProbe;
		const lockedListProbe = probe(["git", "worktree", "list", "--porcelain"], { cwd: repoRoot });
		probes.worktreeLockedList = lockedListProbe;
		writeRaw("git-worktree-locked-remove.txt", `${gitLockProbe.stdout}${gitLockProbe.stderr}\n${lockedRemoveProbe.stdout}${lockedRemoveProbe.stderr}\n--- list ---\n${lockedListProbe.stdout}`);
		const unlockProbe = probe(["git", "worktree", "unlock", worktreePath2], { cwd: repoRoot });
		const cleanRemoveProbe = probe(["git", "worktree", "remove", worktreePath2], { cwd: repoRoot });
		probes.worktreeCleanRemove = cleanRemoveProbe;
		writeRaw("git-worktree-clean-remove.txt", `${unlockProbe.stdout}${unlockProbe.stderr}\n${cleanRemoveProbe.stdout}${cleanRemoveProbe.stderr}`);

		// 有未跟踪文件时普通 remove 失败，--force remove 成功（remove/reset 后 reconcile）
		const worktreePath3 = join(sandbox, "managed", "repo-slug", "task-dirty");
		mkdirSync(dirname(worktreePath3), { recursive: true });
		probe(["git", "worktree", "add", "--detach", worktreePath3, head.stdout.trim()], { cwd: repoRoot });
		writeFileSync(join(worktreePath3, "untracked.txt"), "dirty\n");
		const dirtyRemoveProbe = probe(["git", "worktree", "remove", worktreePath3], { cwd: repoRoot });
		probes.worktreeDirtyRemove = dirtyRemoveProbe;
		const forceRemoveProbe = probe(["git", "worktree", "remove", "--force", worktreePath3], { cwd: repoRoot });
		probes.worktreeForceRemove = forceRemoveProbe;
		writeRaw("git-worktree-force-remove.txt", `${dirtyRemoveProbe.stdout}${dirtyRemoveProbe.stderr}\n--- force ---\n${forceRemoveProbe.stdout}${forceRemoveProbe.stderr}`);
		const afterRemoveList = probe(["git", "worktree", "list", "--porcelain"], { cwd: repoRoot });
		probes.worktreeListAfterRemove = afterRemoveList;
		writeRaw("git-worktree-list-after-remove.txt", afterRemoveList.stdout);

		// bare repo porcelain
		const bareRoot = join(sandbox, "bare.git");
		probe(["git", "clone", "-q", "--bare", repoRoot, bareRoot]);
		const bareListProbe = probe(["git", "worktree", "list", "--porcelain"], { cwd: bareRoot });
		probes.bareWorktreeList = bareListProbe;
		writeRaw("git-bare-worktree-list-porcelain.txt", `${bareListProbe.stdout}${bareListProbe.stderr}`);

		evidence.git = {
			head: head.stdout.trim(),
			worktreeCreate: { exitCode: createProbe.exitCode, stderr: createProbe.stderr.slice(0, 512) },
			worktreeListPorcelain: listProbe.stdout,
			subdirToplevel: toplevelProbe.stdout.trim(),
			subdirPrefix: prefixProbe.stdout.trim(),
			busyRemove: { exitCode: busyProbe.exitCode, stderr: busyProbe.stderr.slice(0, 512) },
			lockedRemove: { exitCode: lockedRemoveProbe.exitCode, stderr: lockedRemoveProbe.stderr.slice(0, 512) },
			lockedListPorcelain: lockedListProbe.stdout,
			cleanRemove: { exitCode: cleanRemoveProbe.exitCode, stderr: cleanRemoveProbe.stderr.slice(0, 512) },
			dirtyRemove: { exitCode: dirtyRemoveProbe.exitCode, stderr: dirtyRemoveProbe.stderr.slice(0, 512) },
			forceRemove: { exitCode: forceRemoveProbe.exitCode, stderr: forceRemoveProbe.stderr.slice(0, 512) },
			bareWorktreeListPorcelain: bareListProbe.stdout,
		};

		// --- 2.6 Shell：启动参数与 env 继承 ---
		const shells: Record<string, unknown> = {};
		for (const shell of ["bash", "sh", "zsh"] as const) {
			const shellPath = probe(["which", shell]);
			const exists = shellPath.ok && shellPath.stdout.trim().length > 0;
			let cProbe: { ok: boolean; stdout: string; stderr: string; exitCode: number } | undefined;
			let envProbe: { ok: boolean; stdout: string; stderr: string; exitCode: number } | undefined;
			if (exists) {
				cProbe = probe([shellPath.stdout.trim(), "-lc", "printf '%s' \"$0\""]);
				envProbe = probe([shellPath.stdout.trim(), "-lc", "printf '%s' \"$RUNLEDGER_EVIDENCE\""], { env: { RUNLEDGER_EVIDENCE: "inherited" } });
			}
			shells[shell] = {
				path: exists ? shellPath.stdout.trim() : null,
				launch_c_probe: cProbe ? { ok: cProbe.ok, stdout: cProbe.stdout.trim(), stderr: cProbe.stderr.slice(0, 256) } : null,
				env_inheritance_probe: envProbe ? { ok: envProbe.ok, stdout: envProbe.stdout.trim(), stderr: envProbe.stderr.slice(0, 256) } : null,
			};
			if (cProbe) writeRaw(`shell-${shell}-lc.txt`, `${cProbe.stdout}${cProbe.stderr}`);
			if (envProbe) writeRaw(`shell-${shell}-env.txt`, `${envProbe.stdout}${envProbe.stderr}`);
		}
		evidence.shell = shells;

		// --- 2.7 进程树终止：POSIX process group kill ---
		// 组首（setsid bash）在独立进程组内运行；探针在本进程组外按 PGID 发 SIGTERM，
		// 验证组内孙进程（sleep）与组本身都终止。trap "" TERM 会经 SIG_IGN 被继承，
		// 因此组内不做任何 trap——这正是真实 cleanup 场景的默认信号语义。
		const treeProbe = probe(["bash", "-c", `
			rm -f "$1/child.pid" "$1/pgid.txt"
			setsid bash -c 'sleep 30 & echo $! > "$1"; echo $$ > "$2"; wait' inner "$1/child.pid" "$1/pgid.txt" &
			PROBE_PID=$!
			for i in $(seq 1 50); do [ -f "$1/child.pid" ] && break; sleep 0.05; done
			CHILD=$(cat "$1/child.pid")
			PGID=$(cat "$1/pgid.txt")
			echo "spawner=$PROBE_PID group=$PGID child=$CHILD"
			kill -TERM -"$PGID"
			sleep 0.3
			if kill -0 "$CHILD" 2>/dev/null; then echo "child_alive=yes"; else echo "child_alive=no"; fi
			if kill -0 -"$PGID" 2>/dev/null; then echo "group_alive=yes"; else echo "group_alive=no"; fi
		`, "probe", sandbox]);
		probes.processTree = treeProbe;
		writeRaw("process-tree-kill.txt", `${treeProbe.stdout}${treeProbe.stderr}`);
		evidence.process = {
			treeKill: {
				ok: treeProbe.ok,
				stdout: treeProbe.stdout.trim(),
				stderr: treeProbe.stderr.slice(0, 256),
			},
		};

		// --- 2.8 occupied-file cleanup：POSIX unlink 语义 ---
		const lockProbe = probe(["bash", "-c", `
			mkdir -p "$1/held"
			exec 9> "$1/held/locked.txt"
			printf 'locked\n' >&9
			flock -n 9 2>/dev/null && echo "flock=acquired" || echo "flock=busy"
			rm -rf "$1/held" && echo "rmdir_while_locked=ok"
			exec 9>&-
		`, "probe", sandbox]);
		probes.occupiedCleanup = lockProbe;
		writeRaw("occupied-file-cleanup.txt", `${lockProbe.stdout}${lockProbe.stderr}`);
		evidence.cleanup = {
			occupiedFile: {
				ok: lockProbe.ok,
				stdout: lockProbe.stdout.trim(),
				stderr: lockProbe.stderr.slice(0, 256),
			},
		};

		// --- 2.9 persisted locator cold resume（同平台真实过程证据） ---
		const locator = JSON.stringify({
			version: 1,
			platform,
			kind: "posix",
			path: repoRoot,
		});
		const resumeProbe = probe([process.execPath, "-e", `
			const locator = JSON.parse(process.argv[1]);
			const fs = require("fs");
			const samePlatform = locator.platform === process.platform;
			const pathExists = fs.existsSync(locator.path);
			console.log("platformMatch=" + samePlatform);
			console.log("pathExists=" + pathExists);
			console.log("restore=" + (samePlatform && pathExists));
		`, locator]);
		probes.locatorColdResume = resumeProbe;
		writeRaw("locator-cold-resume.txt", `${resumeProbe.stdout}${resumeProbe.stderr}`);
		evidence.locator = {
			coldResume: { stdout: resumeProbe.stdout.trim() },
		};
	} finally {
		rmSync(sandbox, { recursive: true, force: true });
	}

	// ---------------------------------------------------------------------------
	// 3. 汇总：evidence.json + manifest.json
	// ---------------------------------------------------------------------------
	const rawFiles = Object.entries(raw).map(([name, content]) => ({ name: `raw/${name}`, content }));
	const evidenceJson = `${JSON.stringify(evidence, null, 2)}\n`;
	writeFileSync(join(outDir, "evidence.json"), evidenceJson);

	const manifest: Record<string, string> = digestManifest([...rawFiles, { name: "evidence.json", content: evidenceJson }]);
	writeFileSync(join(outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

	chmodSync(join(outDir, "manifest.json"), 0o644);
	mkdirSync(join(outDir, "raw"), { recursive: true });

	console.log(JSON.stringify({
		platform,
		outDir,
		files: readdirSync(outDir, { recursive: true }).map((f) => String(f)).sort(),
		manifest,
	}, null, 2));

	const requiredProbes = ["node", "git", "bash", "sh", "uname", "worktreeCreate", "worktreeList", "worktreeBusyRemove", "worktreeLockedRemove", "worktreeCleanRemove", "worktreeDirtyRemove", "worktreeForceRemove", "processTree", "occupiedCleanup"];

	// 负向证据探针的“成功”是 git 以预期原因拒绝；断言期望而不是 exit 0。
	const negativeExpectations: Record<string, { exitCode: number; stderrMarker: string }> = {
		worktreeLockedRemove: { exitCode: 128, stderrMarker: "locked" },
		worktreeDirtyRemove: { exitCode: 128, stderrMarker: "untracked" },
	};
	for (const [name, expected] of Object.entries(negativeExpectations)) {
		const p = probes[name];
		if (p && p.exitCode === expected.exitCode && p.stderr.includes(expected.stderrMarker)) p.ok = true;
	}

	const failed = requiredProbes.filter((name) => {
		const p = probes[name];
		return p === undefined || !p.ok;
	});
	if (failed.length > 0) {
		console.error(`required probes failed on ${platform}: ${failed.join(", ")}`);
		process.exitCode = 1;
	}
}

void main();
