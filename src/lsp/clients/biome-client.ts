/** Biome CLI linter 适配:直接解析 `biome lint --reporter=json` 输出。 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Diagnostic, DiagnosticSeverity, LinterClient, ServerConfig } from "../types.ts";

export type BiomeRunner = (args: string[], cwd: string, resolvedCommand?: string, signal?: AbortSignal) => Promise<{ stdout: string; stderr: string; success: boolean }>;

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
	if (runtime === undefined) throw new Error("Bun.spawn is required for the Biome client");
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
			if (bytes > MAX_CLI_OUTPUT_BYTES) throw new Error("Biome output exceeded 1 MiB");
			text += decoder.decode(value, { stream: true });
		}
	} finally { reader.releaseLock(); }
}

async function runBiomeCli(args: string[], cwd: string, resolvedCommand?: string, signal?: AbortSignal): Promise<{ stdout: string; stderr: string; success: boolean }> {
	const proc = bunRuntime().spawn([resolvedCommand ?? "biome", ...args], { cwd, stdin: "null", stdout: "pipe", stderr: "pipe", ...(signal === undefined ? {} : { signal }) });
	const [stdout, stderr] = await Promise.all([readBounded(proc.stdout), readBounded(proc.stderr)]);
	const exitCode = await proc.exited;
	return { stdout, stderr, success: exitCode === 0 };
}

interface BiomeJsonOutput {
	diagnostics?: Array<{
		severity: string;
		description?: string;
		message?: { message?: string };
		location?: { span?: number[]; path?: { file?: string } };
	}>;
}

function parseSeverity(severity: string): DiagnosticSeverity {
	switch (severity) {
		case "error": return 1;
		case "warning": return 2;
		case "information": return 3;
		default: return 4;
	}
}

/** 单遍把 UTF-8 byte offset 换算为 LSP UTF-16 行列。 */
function offsetsToPositions(source: string, offsets: number[]): Map<number, { line: number; column: number }> {
	const result = new Map<number, { line: number; column: number }>();
	let line = 0;
	let column = 0;
	const sorted = [...offsets].sort((left, right) => left - right);
	let offsetIndex = 0;
	let byteOffset = 0;
	for (const character of source) {
		while (offsetIndex < sorted.length && sorted[offsetIndex] === byteOffset) {
			const offset = sorted[offsetIndex];
			if (offset !== undefined) result.set(offset, { line, column });
			offsetIndex += 1;
		}
		if (offsetIndex === sorted.length) break;
		byteOffset += Buffer.byteLength(character, "utf8");
		if (character === "\n") { line += 1; column = 0; } else column += character.length;
	}
	while (offsetIndex < sorted.length && sorted[offsetIndex] === byteOffset) {
		const offset = sorted[offsetIndex];
		if (offset !== undefined) result.set(offset, { line, column });
		offsetIndex += 1;
	}
	return result;
}

export interface BiomeClientOptions {
	run?: BiomeRunner;
	readFile?: (path: string) => Promise<string>;
}

export class BiomeClient implements LinterClient {
	private readonly config: ServerConfig;
	private readonly cwd: string;
	private readonly run: BiomeRunner;
	private readonly readFile: (path: string) => Promise<string>;

	public static create(config: ServerConfig, cwd: string): BiomeClient {
		return new BiomeClient(config, cwd);
	}

	public constructor(config: ServerConfig, cwd: string, options: BiomeClientOptions = {}) {
		this.config = config;
		this.cwd = cwd;
		this.run = options.run ?? runBiomeCli;
		this.readFile = options.readFile ?? ((filePath) => fs.readFile(filePath, "utf8"));
	}

	public async lint(filePath: string, signal?: AbortSignal): Promise<Diagnostic[]> {
		const result = await this.run(["lint", "--reporter=json", path.relative(this.cwd, filePath)], this.cwd, this.config.resolvedCommand, signal);
		if (!result.stdout) {
			if (!result.success) throw new Error(`Biome failed: ${result.stderr || "no JSON output"}`);
			return [];
		}
		let parsed: BiomeJsonOutput;
		try { parsed = JSON.parse(result.stdout) as BiomeJsonOutput; } catch { throw new Error("Biome returned invalid JSON"); }
		const source = await this.readFile(filePath);
		const diagnostics: Diagnostic[] = [];
		for (const item of parsed.diagnostics ?? []) {
			const [start = 0, end = 0] = item.location?.span ?? [];
			const positions = offsetsToPositions(source, [start, end]);
			const startPos = positions.get(start) ?? { line: 0, column: 0 };
			const endPos = positions.get(end) ?? startPos;
			diagnostics.push({
				range: { start: { line: startPos.line, character: startPos.column }, end: { line: endPos.line, character: endPos.column } },
				severity: parseSeverity(item.severity),
				source: "biome",
				message: item.description ?? item.message?.message ?? "biome diagnostic",
			});
		}
		return diagnostics;
	}
}
