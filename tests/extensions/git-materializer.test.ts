import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runtimeDigest } from "../../src/runtime/protocol/foundation.ts";
import type { ExecutionHandleRef } from "../../src/runtime/process/types.ts";
import type { OutputCursor } from "../../src/runtime/process/output.ts";
import type { ControlPlaneMutationResult, ControlPlaneOutputResult, ControlPlaneWaitResult } from "../../src/storage/process/control-plane.ts";
import { NodeExtensionDistributionStorage } from "../../src/storage/extensions/distribution-storage.ts";
import { buildGitMaterializeCommand, createManagedGitMaterializer } from "../../src/extensions/plugins/git-materializer.ts";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

function handle(executionId = "execution-git"): ExecutionHandleRef {
	return {
		authorityId: "authority_test" as ExecutionHandleRef["authorityId"],
		tenantId: "tenant_test" as ExecutionHandleRef["tenantId"],
		workspaceId: "workspace_test" as ExecutionHandleRef["workspaceId"],
		sessionId: "session_test" as ExecutionHandleRef["sessionId"],
		hostGeneration: 1,
		sessionGeneration: 1,
		executionId: executionId as ExecutionHandleRef["executionId"],
		attemptId: "attempt_git" as ExecutionHandleRef["attemptId"],
		revision: 1,
		requestDigest: runtimeDigest("git-materializer-test"),
	};
}

/** 只记录 start 参数并返回脚本化输出的受控端口；不产生真实进程。 */
class ScriptedGitProcess {
	readonly starts: Array<{ readonly command: string; readonly cwd: string }> = [];
	readonly stops: string[] = [];
	readonly #exitCode: number;
	readonly #text: string;
	#startFailure: string | undefined;

	public constructor(options: { readonly exitCode?: number; readonly text?: string; readonly startFailure?: string } = {}) {
		this.#exitCode = options.exitCode ?? 0;
		this.#text = options.text ?? "";
		this.#startFailure = options.startFailure;
	}

	public async start(input: { readonly command: string; readonly cwd: string }): Promise<{ readonly ok: true; readonly handle: ExecutionHandleRef; readonly summary: { readonly state: string } } | { readonly ok: false; readonly code: string }> {
		if (this.#startFailure !== undefined) return { ok: false, code: this.#startFailure };
		this.starts.push({ command: input.command, cwd: input.cwd });
		return { ok: true, handle: handle(), summary: { state: "running" } };
	}

	public async processOutput(_handle: ExecutionHandleRef, cursor: OutputCursor, maxBytes: number): Promise<ControlPlaneOutputResult> {
		const text = cursor.byteOffset === 0 ? this.#text.slice(0, maxBytes) : "";
		const next: OutputCursor = { sequence: cursor.sequence + 1, byteOffset: cursor.byteOffset + text.length };
		return { ok: true, page: { handle: handle(), startCursor: cursor, endCursor: next, nextCursor: next, text, truncated: false }, head: next };
	}

	public async processWait(): Promise<ControlPlaneWaitResult> {
		return {
			ok: true,
			outcome: "terminal",
			summary: {
				handle: handle(),
				state: this.#exitCode === 0 ? "completed" : "failed",
				outputCursor: { sequence: 1, byteOffset: this.#text.length },
				outputSize: this.#text.length,
				capabilities: { canWrite: false, canEof: false, canResize: false, canStop: true, canReadOutput: true },
				terminal: { state: this.#exitCode === 0 ? "completed" : "failed", exitCode: this.#exitCode, evidenceRef: { subjectKind: "content", digest: runtimeDigest("git") } },
			},
			nextCursor: { sequence: 1, byteOffset: this.#text.length },
		};
	}

	public async stop(_handle: ExecutionHandleRef, _actor: "driver" | "observer", signal?: NodeJS.Signals): Promise<ControlPlaneMutationResult> {
		this.stops.push(signal ?? "SIGTERM");
		return { ok: true, operation: "stop", receiptDigest: runtimeDigest("stop"), summary: { handle: handle(), state: "killed", outputCursor: { sequence: 1, byteOffset: 0 }, outputSize: 0, capabilities: { canWrite: false, canEof: false, canResize: false, canStop: false, canReadOutput: true } } };
	}

	public async write(): Promise<ControlPlaneMutationResult> { return { ok: false, code: "mutation_rejected" }; }
	public async resize(): Promise<ControlPlaneMutationResult> { return { ok: false, code: "mutation_rejected" }; }
}

async function fixture() {
	const base = await mkdtemp(join(tmpdir(), "runledger-git-mat-"));
	roots.push(base);
	const home = join(base, "home");
	await mkdir(home, { recursive: true });
	const storage = new NodeExtensionDistributionStorage({ runledgerHome: home });
	return { base, home, storage };
}

describe("managed git materializer", () => {
	it("builds pinned, quoted git command lines", () => {
		const plain = buildGitMaterializeCommand({ kind: "git", url: "https://github.com/o/r.git" }, "/tmp/wt");
		expect(plain).toContain("git clone --depth 1 --single-branch");
		expect(plain).toContain("'https://github.com/o/r.git'");
		expect(plain).toContain("GIT_TERMINAL_PROMPT=0");

		const ref = buildGitMaterializeCommand({ kind: "git", url: "https://github.com/o/r.git", ref: "main" }, "/tmp/wt");
		expect(ref).toContain("--branch 'main'");

		// 有 sha 时必须 fetch + detach，避免拿到已经前进的分支头。
		const sha = buildGitMaterializeCommand({ kind: "git", url: "https://github.com/o/r.git", sha: "abcdef1234" }, "/tmp/wt");
		expect(sha).toContain("git init");
		expect(sha).toContain("git fetch --depth 1 origin 'abcdef1234'");
		expect(sha).toContain("git checkout --detach FETCH_HEAD");
	});

	it("rejects non-https urls, unsafe refs and escaping subdirs before starting a process", async () => {
		const env = await fixture();
		const port = new ScriptedGitProcess();
		const materializer = createManagedGitMaterializer({ managedProcess: port, storage: env.storage, cwd: env.home });
		const cases = [
			{ kind: "git" as const, url: "http://github.com/o/r.git" },
			{ kind: "git" as const, url: "https://github.com/o/r.git", ref: "main; rm -rf /" },
			{ kind: "git" as const, url: "https://github.com/o/r.git", sha: "NOTHEX" },
			{ kind: "git" as const, url: "https://github.com/o/r.git", subdir: "../escape" },
		];
		for (const source of cases) {
			const result = await materializer.materialize({ source, destination: join(env.home, "dst") });
			expect(result.ok, JSON.stringify(source)).toBe(false);
			if (!result.ok) expect(result.code).toBe("source_invalid");
		}
		expect(port.starts).toEqual([]);
	});

	it("surfaces a governed rejection instead of falling back to a local guess", async () => {
		const env = await fixture();
		const materializer = createManagedGitMaterializer({
			managedProcess: new ScriptedGitProcess({ startFailure: "permission_denied" }),
			storage: env.storage,
			cwd: env.home,
		});
		await expect(materializer.materialize({ source: { kind: "git", url: "https://github.com/o/r.git" }, destination: join(env.home, "dst") }))
			.resolves.toEqual({ ok: false, code: "governed_process_rejected", message: "governed git process was rejected: permission_denied" });
	});

	it("reports a non-zero git exit as a failure", async () => {
		const env = await fixture();
		const materializer = createManagedGitMaterializer({ managedProcess: new ScriptedGitProcess({ exitCode: 128 }), storage: env.storage, cwd: env.home });
		const result = await materializer.materialize({ source: { kind: "git", url: "https://github.com/o/r.git" }, destination: join(env.home, "dst") });
		expect(result).toEqual({ ok: false, code: "git_failed", message: "git exited with code 128" });
	});

	it("stops the process and fails when output exceeds the bound", async () => {
		const env = await fixture();
		const port = new ScriptedGitProcess({ text: "x".repeat(4_096) });
		const materializer = createManagedGitMaterializer({ managedProcess: port, storage: env.storage, cwd: env.home, maxOutputBytes: 1_024 });
		const result = await materializer.materialize({ source: { kind: "git", url: "https://github.com/o/r.git" }, destination: join(env.home, "dst") });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.code).toBe("output_oversize");
		expect(port.stops).toContain("SIGTERM");
	});

	it("isolates a git-subdir into the destination through the governed storage adapter", async () => {
		const env = await fixture();
		const destination = join(env.home, "staging");
		const worktree = `${destination}.worktree`;
		// 模拟 clone 结果：subdir 内有包内容。
		await mkdir(join(worktree, "packages", "alpha"), { recursive: true });
		await writeFile(join(worktree, "packages", "alpha", "package.json"), JSON.stringify({ name: "alpha" }), "utf8");
		await writeFile(join(worktree, "README.md"), "root", "utf8");
		const port = new ScriptedGitProcess();
		const materializer = createManagedGitMaterializer({ managedProcess: port, storage: env.storage, cwd: env.home });
		const result = await materializer.materialize({
			source: { kind: "git", url: "https://github.com/o/r.git", subdir: "packages/alpha" },
			destination,
		});
		expect(result).toEqual({ ok: true });
		const read = await env.storage.readFile(join(destination, "package.json"), 1_024);
		expect(read.ok).toBe(true);
		// 临时 worktree 已清理。
		expect((await env.storage.stat(worktree, { followSymlinks: false })).ok).toBe(false);
	});
});
