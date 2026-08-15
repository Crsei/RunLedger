import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
	CANONICAL_STORAGE_ADAPTER_ALLOWLIST,
	EXECUTION_FINAL_LEAF_ADAPTER_ALLOWLIST,
	BASH_AST_ASSET_ALLOWLIST,
	MANAGED_PROCESS_BACKEND_ALLOWLIST,
	scanExecutionBoundaries,
} from "../../scripts/check-execution-boundaries.ts";

describe("current execution boundary baseline", () => {
	it("has no raw I/O debt in production runtime tools", () => {
		const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
		expect(scanExecutionBoundaries(repoRoot)).toEqual([]);
		expect(CANONICAL_STORAGE_ADAPTER_ALLOWLIST).toEqual([]);
		expect(EXECUTION_FINAL_LEAF_ADAPTER_ALLOWLIST).toEqual([
			"src/security/integration/session-local-leaves.ts",
		]);
		expect(BASH_AST_ASSET_ALLOWLIST).toEqual([
			"src/security/permission/bash-ast/assets.ts",
			"src/security/permission/bash-ast/worker.ts",
		]);
		expect(MANAGED_PROCESS_BACKEND_ALLOWLIST).toEqual([
			"src/cli/linux-peer-attestor.ts",
			"src/cli/runtime-host-production.ts",
			"src/cli/session-git-command.ts",
			"src/storage/process/node-pty-adapter.ts",
			"src/storage/process/process-backend.ts",
			"src/storage/process/supervisor-runner.ts",
		]);
	});

	it("rejects legacy and ungoverned execution paths in multi-agent production files", () => {
		const root = mkdtempSync(join(tmpdir(), "runledger-multi-agent-boundary-"));
		try {
			const agents = join(root, "src/runtime/agents");
			mkdirSync(agents, { recursive: true });
			writeFileSync(join(agents, "domain.ts"), [
				'import { createAnthropicAgent } from "./create-anthropic-agent.ts";',
				"localExecutionEnv();",
				"new AllowAllToolAuthorizationPolicy();",
				"createStdlibTools(cwd);",
			].join("\n"), "utf8");
			const sessionRuntime = join(root, "src/runtime/session-runtime");
			mkdirSync(sessionRuntime, { recursive: true });
			writeFileSync(join(sessionRuntime, "domain.ts"), "createStdlibTools(cwd);", "utf8");
			const violations = scanExecutionBoundaries(root);
			expect(violations).toHaveLength(5);
			expect(violations.every((violation) => violation.kind === "multi-agent-raw-boundary")).toBe(true);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
