/** SwiftLint CLI linter 适配:`swiftlint lint --reporter json` 输出换算为 LSP Diagnostic。 */
import type { Diagnostic, DiagnosticSeverity, LinterClient, ServerConfig } from "../types.ts";

export type SwiftLintRunner = (args: string[], cwd: string, resolvedCommand?: string, signal?: AbortSignal) => Promise<{ stdout: string; stderr: string; success: boolean }>;

const MAX_CLI_OUTPUT_BYTES = 1024 * 1024;

interface BunCliProcess {
	stdout: ReadableStream<Uint8Array>;
	stderr: ReadableStream<Uint8Array>;
	exited: Promise<number>;
}

interface BunRuntime {
	spawn(command: string[], options: {
		cwd: string;
		stdin: "null";
		stdout: "pipe";
		stderr: "pipe";
		signal?: AbortSignal;
	}): BunCliProcess;
}

function bunRuntime(): BunRuntime {
	const runtime = (globalThis as typeof globalThis & { Bun?: BunRuntime }).Bun;
	if (runtime === undefined) throw new Error("Bun.spawn is required for the SwiftLint client");
	return runtime;
}

async function readBounded(stream: ReadableStream<Uint8Array>): Promise<string> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let bytes = 0;
	let text = "";
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) return text + decoder.decode();
			bytes += value.byteLength;
			if (bytes > MAX_CLI_OUTPUT_BYTES) throw new Error("SwiftLint output exceeded 1 MiB");
			text += decoder.decode(value, { stream: true });
		}
	} finally { reader.releaseLock(); }
}

async function runSwiftLintCli(args: string[], cwd: string, resolvedCommand?: string, signal?: AbortSignal): Promise<{ stdout: string; stderr: string; success: boolean }> {
	const proc = bunRuntime().spawn([resolvedCommand ?? "swiftlint", ...args], { cwd, stdin: "null", stdout: "pipe", stderr: "pipe", ...(signal === undefined ? {} : { signal }) });
	const [stdout, stderr] = await Promise.all([readBounded(proc.stdout), readBounded(proc.stderr)]);
	const exitCode = await proc.exited;
	return { stdout, stderr, success: exitCode === 0 || exitCode === 2 };
}

function parseSeverity(severity: string): DiagnosticSeverity {
	switch (severity) {
		case "Error": return 1;
		case "Warning": return 2;
		default: return 3;
	}
}

interface SwiftLintOutputItem {
	file?: string;
	line?: number;
	character?: number;
	severity?: string;
	reason?: string;
	rule_id?: string;
}

export interface SwiftLintClientOptions {
	run?: SwiftLintRunner;
}

export class SwiftLintClient implements LinterClient {
	private readonly config: ServerConfig;
	private readonly cwd: string;
	private readonly run: SwiftLintRunner;

	public static create(config: ServerConfig, cwd: string): SwiftLintClient {
		return new SwiftLintClient(config, cwd);
	}

	public constructor(config: ServerConfig, cwd: string, options: SwiftLintClientOptions = {}) {
		this.config = config;
		this.cwd = cwd;
		this.run = options.run ?? runSwiftLintCli;
	}

	public async lint(filePath: string, signal?: AbortSignal): Promise<Diagnostic[]> {
		const result = await this.run(["lint", "--reporter", "json", "--path", filePath], this.cwd, this.config.resolvedCommand, signal);
		if (!result.stdout) {
			if (!result.success) throw new Error(`SwiftLint failed: ${result.stderr || "no JSON output"}`);
			return [];
		}
		let items: SwiftLintOutputItem[];
		try { items = JSON.parse(result.stdout) as SwiftLintOutputItem[]; } catch { throw new Error("SwiftLint returned invalid JSON"); }
		return items.map((item) => {
			const line = Math.max((item.line ?? 1) - 1, 0);
			const character = Math.max((item.character ?? 1) - 1, 0);
			return {
				range: { start: { line, character }, end: { line, character } },
				severity: parseSeverity(item.severity ?? "Warning"),
				source: "swiftlint",
				message: item.reason ?? item.rule_id ?? "swiftlint diagnostic",
			};
		});
	}
}
