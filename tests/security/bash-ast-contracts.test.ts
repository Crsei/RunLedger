import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	BASH_AST_COMMAND_MAX_CHARS,
	BASH_AST_DEADLINE_MS,
	BASH_AST_NODE_LIMIT,
	BASH_AST_WORKER_POOL_MAX,
	parseBashAstWorkerResponse,
	precheckBashCommand,
	resolveBashSecurityAnalyzerMode,
} from "../../src/security/permission/bash-ast/index.ts";
import { parseSecurityConfigDocument } from "../../src/security/config/schema.ts";

describe("Bash AST contracts", () => {
	it("freezes the bounded parser constants and failure prechecks", () => {
		expect(BASH_AST_COMMAND_MAX_CHARS).toBe(10_000);
		expect(BASH_AST_DEADLINE_MS).toBe(50);
		expect(BASH_AST_NODE_LIMIT).toBe(50_000);
		expect(BASH_AST_WORKER_POOL_MAX).toBe(2);
		expect(precheckBashCommand("", "a".repeat(64))).toMatchObject({
			kind: "too-complex",
			reasonCode: "bash_empty_command",
		});
		expect(precheckBashCommand("x\u00a0y", "a".repeat(64))).toMatchObject({
			kind: "too-complex",
			reasonCode: "bash_unicode_whitespace",
		});
	});

	it("resolves analyzer modes by strength and source without a downgrade", () => {
		expect(resolveBashSecurityAnalyzerMode({
			user: "ast",
			project: "legacy",
			cli: "legacy",
		})).toMatchObject({ mode: "ast", source: "user" });
		expect(resolveBashSecurityAnalyzerMode({
			user: "legacy",
			project: "shadow",
			cli: "legacy",
			managedMinimum: "ast",
		})).toMatchObject({ mode: "ast", source: "managed" });
	});

	it("accepts the analyzer mode in config and rejects unknown values", () => {
		expect(parseSecurityConfigDocument({ bashAnalyzerMode: "shadow" })).toMatchObject({
			ok: true,
			value: { bashAnalyzerMode: "shadow" },
		});
		expect(parseSecurityConfigDocument({ bashAnalyzerMode: "allow-all" })).toMatchObject({
			ok: false,
			error: { code: "invalid_config" },
		});
	});

	it("rejects malformed worker protocol data instead of widening a result", () => {
		expect(parseBashAstWorkerResponse({
			protocolVersion: 1,
			type: "result",
			requestId: "command_bad",
			result: {
				classification: {
					kind: "parse-unavailable",
					reasonCode: "worker_crash",
					parserDigest: "not-a-digest",
				},
				metrics: { durationBucket: "0-5ms", nodeCountBucket: "0-100", nodeCount: 0 },
			},
		})).toBeUndefined();
	});

	it("bounds worker initialization by the same fixed classification deadline", () => {
		const source = readFileSync(
			join(process.cwd(), "src/security/permission/bash-ast/parser.ts"),
			"utf8",
		);
		expect(source).not.toContain("resolve(false), 5_000");
		expect(source).toContain("this.initialize(BASH_AST_DEADLINE_MS)");
	});
});
