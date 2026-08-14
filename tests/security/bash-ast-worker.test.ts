import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
	BashSecurityAnalyzer,
	BASH_GRAMMAR_WASM_SHA256,
	parseBashAstWorkerResponse,
	resolveBashAstAssets,
	TREE_SITTER_RUNTIME_WASM_SHA256,
	type BashShadowTelemetryRecord,
} from "../../src/security/permission/bash-ast/index.ts";
import { BashAstWorkerPool } from "../../src/security/permission/bash-ast/parser.ts";

describe("Bash AST WASM worker", () => {
	it("locates and verifies the two fixed WASM assets", async () => {
		const assets = await resolveBashAstAssets();
		expect(assets).toBeDefined();
		if (!assets) return;
		await expect(readFile(assets.grammarWasm).then((body) =>
			createHash("sha256").update(body).digest("hex")
		)).resolves.toBe(BASH_GRAMMAR_WASM_SHA256);
		await expect(readFile(assets.runtimeWasm).then((body) =>
			createHash("sha256").update(body).digest("hex")
		)).resolves.toBe(TREE_SITTER_RUNTIME_WASM_SHA256);
	});

	it("uses the same verified locator for source, dist, and packed layouts", async () => {
		const sourceUrl = pathToFileURL(resolve(
			"src/security/permission/bash-ast/assets.ts",
		)).href;
		const distUrl = pathToFileURL(resolve(
			"dist/security/permission/bash-ast/assets.js",
		)).href;
		await expect(resolveBashAstAssets(sourceUrl)).resolves.toBeDefined();
		await expect(resolveBashAstAssets(distUrl)).resolves.toBeDefined();

		const fakeRoot = await mkdtemp(join(tmpdir(), "runledger-bash-assets-"));
		try {
			await mkdir(join(fakeRoot, "assets/tree-sitter"), { recursive: true });
			await writeFile(
				join(fakeRoot, "assets/tree-sitter/web-tree-sitter.wasm"),
				"wrong-runtime",
			);
			await writeFile(
				join(fakeRoot, "assets/tree-sitter/tree-sitter-bash.wasm"),
				"wrong-grammar",
			);
			const packedUrl = pathToFileURL(join(
				fakeRoot,
				"dist/security/permission/bash-ast/assets.js",
			)).href;
			await expect(resolveBashAstAssets(packedUrl)).resolves.toBeUndefined();
		} finally {
			await rm(fakeRoot, { recursive: true, force: true });
		}
	});

	it("classifies every pipeline/list segment and redirect", async () => {
		const pool = new BashAstWorkerPool(1);
		try {
			const result = await pool.classify(
				"git status && cat input.txt | rg needle > output.txt",
			);
			expect(result.classification).toMatchObject({
				kind: "simple",
				commands: [
					{ executable: "git", arguments: ["status"], redirects: [] },
					{ executable: "cat", arguments: ["input.txt"], redirects: [] },
					{
						executable: "rg",
						arguments: ["needle"],
						redirects: [{ operation: "write", path: "output.txt" }],
					},
				],
			});
			expect(result.metrics.nodeCount).toBeGreaterThan(0);
			expect(result.metrics.nodeCount).toBeLessThanOrEqual(50_000);
		} finally {
			await pool.close();
		}
	});

	it("terminates a deadline worker and classifies the next request on a fresh worker", async () => {
		const pool = new BashAstWorkerPool(1);
		try {
			// 保持在 10,000 字符 precheck 上限内，以最大 token 序列稳定进入 parse deadline。
			await expect(pool.classify(
				"a ".repeat(4_999),
			)).resolves.toMatchObject({
				classification: {
					kind: "too-complex",
					reasonCode: "bash_parse_deadline",
				},
			});
			await expect(pool.classify("pwd")).resolves.toMatchObject({
				classification: {
					kind: "simple",
					commands: [{ executable: "pwd" }],
				},
			});
		} finally {
			await pool.close();
		}
	});

	it("drains a deterministic property corpus before closing every worker", async () => {
		const pool = new BashAstWorkerPool(2);
		await expect(pool.initialize()).resolves.toBe(true);
		const corpus = Array.from({ length: 128 }, (_, index) => {
			switch (index % 4) {
				case 0:
					return { command: `printf value_${index}`, kind: "simple" as const };
				case 1:
					return {
						command: `git status | rg value_${index}`,
						kind: "simple" as const,
					};
				case 2:
					return {
						command: `echo $(printf ${index})`,
						kind: "too-complex" as const,
					};
				default:
					return {
						command: `cat /proc/${index}/environ`,
						kind: "too-complex" as const,
					};
			}
		});
		const pending = corpus.map((item) => pool.classify(item.command));
		const closing = pool.close();
		const results = await Promise.all(pending);
		await closing;
		expect(results).toHaveLength(corpus.length);
		for (const [index, result] of results.entries()) {
			expect(result.classification.kind, corpus[index]?.command).toBe(
				corpus[index]?.kind,
			);
		}
		await expect(pool.classify("pwd")).resolves.toMatchObject({
			classification: {
				kind: "parse-unavailable",
				reasonCode: "bash_worker_pool_closed",
			},
		});
	});

	it.each([
		["echo $(id)", "bash_dynamic_word"],
		["eval 'git status'", "bash_reinterpreting_builtin"],
		["printf -v target value", "bash_indirect_variable_printf"],
		["cat /proc/self/environ", "bash_process_environment_read"],
		["jq -L modules . input.json", "bash_jq_dynamic_execution"],
		["timeout --unknown 1 git status", "bash_wrapper_invalid"],
	] as const)("fails closed for %s", async (command, reasonCode) => {
		const pool = new BashAstWorkerPool(1);
		try {
			await expect(pool.classify(command)).resolves.toMatchObject({
				classification: { kind: "too-complex", reasonCode },
			});
		} finally {
			await pool.close();
		}
	});

	it("rejects malformed or unbounded worker results at the protocol boundary", () => {
		expect(parseBashAstWorkerResponse({
			protocolVersion: 2,
			type: "ready",
		})).toBeUndefined();
		expect(parseBashAstWorkerResponse({
			protocolVersion: 1,
			type: "result",
			requestId: "request",
			result: {
				classification: {
					kind: "simple",
					commands: [],
					parserDigest: "a".repeat(64),
				},
				metrics: {
					durationBucket: "0-5ms",
					nodeCountBucket: "0-100",
					nodeCount: 0,
				},
			},
		})).toBeUndefined();
		expect(parseBashAstWorkerResponse({
			protocolVersion: 1,
			type: "result",
			requestId: "request",
			result: {
				classification: {
					kind: "parse-unavailable",
					reasonCode: "x".repeat(2_049),
				},
				metrics: {
					durationBucket: "unavailable",
					nodeCountBucket: "unavailable",
					nodeCount: 0,
				},
			},
		})).toBeUndefined();
	});

	it("redacts shadow telemetry and ignores telemetry sink failure", async () => {
		const records: BashShadowTelemetryRecord[] = [];
		const analyzer = new BashSecurityAnalyzer({
			telemetrySalt: "test-only-salt",
			telemetry: {
				record: async (record) => {
					records.push(record);
				},
			},
		});
		const command = "printf credential-sentinel";
		try {
			await expect(analyzer.analyze(command, "shadow")).resolves.toMatchObject({
				mode: "shadow",
				legacyKind: "known",
			});
			expect(records).toHaveLength(1);
			expect(JSON.stringify(records[0])).not.toContain(command);
			expect(records[0]).not.toHaveProperty("argv");
			expect(records[0]).not.toHaveProperty("env");
		} finally {
			await analyzer.close();
		}

		const rejecting = new BashSecurityAnalyzer({
			telemetry: {
				record: async () => {
					throw new Error("telemetry offline");
				},
			},
		});
		try {
			await expect(rejecting.analyze("git status", "shadow")).resolves
				.toMatchObject({ mode: "shadow", legacyKind: "known" });
		} finally {
			await rejecting.close();
		}
	});
});
