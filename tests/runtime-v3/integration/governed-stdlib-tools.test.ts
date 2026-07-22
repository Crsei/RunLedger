import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
	ExecutionEnv,
	FileStats,
	FileSystem,
	Shell,
	ShellExecOptions,
	ShellResult,
} from "../../../src/runtime/execution-env.ts";
import type { ToolContext } from "../../../src/runtime/tool-context.ts";
import { createBashTool } from "../../../src/runtime/tools/bash.ts";
import { createEditTool } from "../../../src/runtime/tools/edit.ts";
import { createFindTool } from "../../../src/runtime/tools/find.ts";
import { createGrepTool } from "../../../src/runtime/tools/grep.ts";
import { createStdlibTools } from "../../../src/runtime/tools/index.ts";
import { createLsTool } from "../../../src/runtime/tools/ls.ts";
import { createMultiEditTool } from "../../../src/runtime/tools/multi-edit.ts";
import { createReadTool } from "../../../src/runtime/tools/read.ts";
import { createWriteTool } from "../../../src/runtime/tools/write.ts";

const GOVERNED_CWD = path.resolve("/virtual/runledger-governed");

class MemoryFileSystem implements FileSystem {
	readonly files = new Map<string, Buffer>();
	readonly directories = new Set<string>();
	readonly calls: Array<{ operation: string; target: string }> = [];

	public constructor() {
		this.#addDirectories(GOVERNED_CWD);
	}

	#normalize(target: string): string {
		return path.normalize(target);
	}

	#addDirectories(target: string): void {
		let current = this.#normalize(target);
		while (!this.directories.has(current)) {
			this.directories.add(current);
			const parent = path.dirname(current);
			if (parent === current) break;
			current = parent;
		}
	}

	public seedFile(target: string, content: string): void {
		const normalized = this.#normalize(target);
		this.#addDirectories(path.dirname(normalized));
		this.files.set(normalized, Buffer.from(content, "utf8"));
	}

	public async readFile(target: string): Promise<Buffer> {
		const normalized = this.#normalize(target);
		this.calls.push({ operation: "readFile", target: normalized });
		const value = this.files.get(normalized);
		if (!value) throw new Error(`missing file: ${normalized}`);
		return Buffer.from(value);
	}

	public async writeFile(target: string, data: string | Buffer): Promise<void> {
		const normalized = this.#normalize(target);
		this.calls.push({ operation: "writeFile", target: normalized });
		if (!this.directories.has(path.dirname(normalized))) throw new Error(`missing directory: ${path.dirname(normalized)}`);
		this.files.set(normalized, Buffer.isBuffer(data) ? Buffer.from(data) : Buffer.from(data, "utf8"));
	}

	public async stat(target: string): Promise<FileStats> {
		const normalized = this.#normalize(target);
		this.calls.push({ operation: "stat", target: normalized });
		const file = this.files.get(normalized);
		if (file) return { size: file.byteLength, mtimeMs: 1, isFile: true, isDirectory: false };
		if (this.directories.has(normalized)) return { size: 0, mtimeMs: 1, isFile: false, isDirectory: true };
		throw new Error(`missing path: ${normalized}`);
	}

	public async readdir(target: string): Promise<string[]> {
		const normalized = this.#normalize(target);
		this.calls.push({ operation: "readdir", target: normalized });
		if (!this.directories.has(normalized)) throw new Error(`missing directory: ${normalized}`);
		const entries = new Set<string>();
		for (const file of this.files.keys()) {
			if (path.dirname(file) === normalized) entries.add(path.basename(file));
		}
		for (const directory of this.directories) {
			if (directory !== normalized && path.dirname(directory) === normalized) entries.add(path.basename(directory));
		}
		return [...entries];
	}

	public async mkdir(target: string): Promise<void> {
		const normalized = this.#normalize(target);
		this.calls.push({ operation: "mkdir", target: normalized });
		this.#addDirectories(normalized);
	}

	public async rm(target: string, options?: { recursive?: boolean; force?: boolean }): Promise<void> {
		const normalized = this.#normalize(target);
		this.calls.push({ operation: "rm", target: normalized });
		this.files.delete(normalized);
		if (options?.recursive) {
			for (const file of [...this.files.keys()]) {
				if (file.startsWith(`${normalized}${path.sep}`)) this.files.delete(file);
			}
			for (const directory of [...this.directories]) {
				if (directory === normalized || directory.startsWith(`${normalized}${path.sep}`)) this.directories.delete(directory);
			}
		}
	}
}

class RecordingShell implements Shell {
	readonly calls: Array<{ command: string; options?: ShellExecOptions }> = [];

	public async exec(command: string, options?: ShellExecOptions): Promise<ShellResult> {
		this.calls.push({ command, options });
		if (command === "rg --version" || command === "fd --version") {
			return { stdout: "available", stderr: "", exitCode: 0 };
		}
		if (command.startsWith("rg ")) {
			return { stdout: `${GOVERNED_CWD}/search.txt:needle`, stderr: "", exitCode: 0 };
		}
		if (command.startsWith("fd ")) {
			return { stdout: `${GOVERNED_CWD}/result.ts`, stderr: "", exitCode: 0 };
		}
		return { stdout: "governed-shell\n", stderr: "", exitCode: 0 };
	}
}

function toolContext(fs: FileSystem, shell: Shell, cwd = GOVERNED_CWD): ToolContext {
	const env: ExecutionEnv = { fs, shell, cwd };
	return {
		cwd,
		env,
		envVars: { RUNLEDGER_GOVERNED_TEST: "1" },
		signal: new AbortController().signal,
		sessionId: "session_governed-stdlib",
		toolCallId: "toolCall_governed-stdlib",
	};
}

function text(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content[0]?.text ?? "";
}

const cleanupRoots: string[] = [];

afterEach(async () => {
	for (const root of cleanupRoots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("governed stdlib ToolContext boundary", () => {
	it("marks the migrated production tools as ToolContext-bound", () => {
		const registry = createStdlibTools("/closure-only");
		for (const name of ["read", "write", "edit", "MultiEdit", "bash", "grep", "find", "ls"]) {
			expect(registry.get(name)?.governedExecution, name).toBe("tool-context");
		}
	});

	it("uses only context.env.fs and context.cwd for governed filesystem tools", async () => {
		const fs = new MemoryFileSystem();
		const shell = new RecordingShell();
		const context = toolContext(fs, shell);
		fs.seedFile(path.join(GOVERNED_CWD, "read.txt"), "governed read");
		fs.seedFile(path.join(GOVERNED_CWD, "edit.txt"), "before edit\n");
		fs.seedFile(path.join(GOVERNED_CWD, "multi.txt"), "before multi\n");
		fs.seedFile(path.join(GOVERNED_CWD, "list", "file.txt"), "listed");
		await fs.mkdir(path.join(GOVERNED_CWD, "list", "subdir"));

		let readLegacyCalls = 0;
		const read = createReadTool(GOVERNED_CWD, {
			operations: {
				access: async () => { readLegacyCalls += 1; },
				stat: async () => { readLegacyCalls += 1; return { mtimeMs: 1 }; },
				readFile: async () => { readLegacyCalls += 1; return Buffer.from("closure cache"); },
			},
		});
		// 先填充 legacy cache；governed cache 必须按 ExecutionEnv 隔离。
		expect(text(await read.execute("legacy-read", { path: "read.txt", lineNumbers: false }))).toContain("closure cache");
		const legacyCallsBeforeGoverned = readLegacyCalls;
		expect(text(await read.execute("read", { path: "read.txt", lineNumbers: false }, undefined, undefined, context))).toContain("governed read");
		expect(readLegacyCalls).toBe(legacyCallsBeforeGoverned);

		let closureFsCalls = 0;
		const closureFailure = async (): Promise<never> => {
			closureFsCalls += 1;
			throw new Error("closure filesystem must not be used");
		};
		const write = createWriteTool("/closure-only", {
			operations: { mkdir: closureFailure, writeFile: closureFailure },
		});
		await write.execute("write", { path: "nested/out.txt", content: "governed write" }, undefined, undefined, context);

		const edit = createEditTool("/closure-only", {
			operations: { access: closureFailure, readFile: closureFailure, writeFile: closureFailure },
		});
		await edit.execute("edit", {
			path: "edit.txt",
			edits: [{ oldText: "before edit", newText: "after edit" }],
		}, undefined, undefined, context);

		const multiEdit = createMultiEditTool("/closure-only");
		await multiEdit.execute("multi", {
			filePath: "multi.txt",
			edits: [{ oldString: "before multi", newString: "after multi" }],
		}, undefined, undefined, context);

		const ls = createLsTool("/closure-only", {
			operations: { exists: closureFailure, stat: closureFailure, readdir: closureFailure },
		});
		const listed = await ls.execute("ls", { path: "list" }, undefined, undefined, context);

		expect(closureFsCalls).toBe(0);
		expect((await fs.readFile(path.join(GOVERNED_CWD, "nested", "out.txt"))).toString("utf8")).toBe("governed write");
		expect((await fs.readFile(path.join(GOVERNED_CWD, "edit.txt"))).toString("utf8")).toBe("after edit\n");
		expect((await fs.readFile(path.join(GOVERNED_CWD, "multi.txt"))).toString("utf8")).toBe("after multi\n");
		expect(text(listed)).toContain("file.txt");
		expect(text(listed)).toContain("subdir/");
		expect(fs.calls.every((call) => call.target === GOVERNED_CWD || call.target.startsWith(`${GOVERNED_CWD}${path.sep}`))).toBe(true);
	});

	it("uses only context.env.shell, context.cwd, context envVars, and context signal", async () => {
		const fs = new MemoryFileSystem();
		const shell = new RecordingShell();
		const context = toolContext(fs, shell);
		let closureShellCalls = 0;
		const closureShell: Shell = {
			exec: async () => {
				closureShellCalls += 1;
				throw new Error("closure shell must not be used");
			},
		};
		const bash = createBashTool("/closure-only", { operations: closureShell });
		const grep = createGrepTool("/closure-only", { shell: closureShell });
		const find = createFindTool("/closure-only", { shell: closureShell });

		expect(text(await bash.execute("bash", { command: "echo governed" }, undefined, undefined, context))).toContain("governed-shell");
		expect(text(await grep.execute("grep", { pattern: "needle", path: "." }, undefined, undefined, context))).toContain("needle");
		expect(text(await find.execute("find", { pattern: "*.ts", path: "." }, undefined, undefined, context))).toContain("result.ts");
		expect(closureShellCalls).toBe(0);
		expect(shell.calls.length).toBe(5);
		for (const call of shell.calls) {
			expect(call.options?.cwd).toBe(GOVERNED_CWD);
			expect(call.options?.env).toEqual(context.envVars);
			expect(call.options?.signal).toBe(context.signal);
		}
	});

	it("does not fall back to a closure shell when governed context is malformed", async () => {
		const fs = new MemoryFileSystem();
		const context = toolContext(fs, new RecordingShell());
		const malformedContext = {
			...context,
			env: { ...context.env, shell: undefined },
		} as unknown as ToolContext;
		let closureShellCalls = 0;
		const closureShell: Shell = {
			exec: async () => {
				closureShellCalls += 1;
				return { stdout: "legacy fallback", stderr: "", exitCode: 0 };
			},
		};

		const bashResult = await createBashTool("/closure-only", { operations: closureShell }).execute(
			"bash",
			{ command: "echo governed" },
			undefined,
			undefined,
			malformedContext,
		);
		expect(bashResult).toMatchObject({ isError: true, details: { exitCode: 127 } });
		expect(text(bashResult)).not.toContain("legacy fallback");
		await expect(
			createGrepTool("/closure-only", { shell: closureShell }).execute(
				"grep",
				{ pattern: "needle", path: "." },
				undefined,
				undefined,
				malformedContext,
			),
		).rejects.toThrow();
		await expect(
			createFindTool("/closure-only", { shell: closureShell }).execute(
				"find",
				{ pattern: "*.ts", path: "." },
				undefined,
				undefined,
				malformedContext,
			),
		).rejects.toThrow();
		expect(closureShellCalls).toBe(0);
	});

	it("fails closed for background bash without touching shell or raw local log files", async () => {
		const realRoot = await mkdtemp(path.join(tmpdir(), "runledger-governed-background-"));
		cleanupRoots.push(realRoot);
		const fs = new MemoryFileSystem();
		const shell = new RecordingShell();
		let closureShellCalls = 0;
		const tool = createBashTool("/closure-only", {
			operations: {
				exec: async () => {
					closureShellCalls += 1;
					return { stdout: "", stderr: "", exitCode: 0 };
				},
			},
		});
		const result = await tool.execute(
			"background",
			{ command: "exit 0", run_in_background: true },
			undefined,
			undefined,
			toolContext(fs, shell, realRoot),
		);
		expect(result).toMatchObject({ isError: true, details: { exitCode: 126 } });
		expect(text(result)).toContain("governed ToolContext");
		expect(shell.calls).toHaveLength(0);
		expect(closureShellCalls).toBe(0);
		await expect(access(path.join(realRoot, "tmp"))).rejects.toThrow();
	});
});
