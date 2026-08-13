/**
 * P1：Discovery Provider 的 execution-boundary 静态检查。
 *
 * provider 只产出 observation，不得 import/持有 TrustStore、ExtensionStateStore、
 * Gateway、MCP client、process handle（02 计划 §5）；检查规则见
 * scripts/check-execution-boundaries.ts#findProviderExecutionPortViolations。
 */

import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { findProviderExecutionPortViolations, scanExecutionBoundaries } from "../../../scripts/check-execution-boundaries.ts";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

describe("provider execution boundary", () => {
	it("has no provider-execution-port violations in the current repository", () => {
		const violations = scanExecutionBoundaries(repoRoot);
		expect(violations.filter((violation) => violation.kind === "provider-execution-port")).toEqual([]);
	});

	it("flags a provider importing TrustStore or ExtensionStateStore", () => {
		const source = [
			'import { TrustStore } from "../trust/trust-store.ts";',
			'import { ExtensionStateStore } from "../state-store.ts";',
			"export const observation = { providerId: \"runledger-user\" };",
		].join("\n");
		expect(findProviderExecutionPortViolations("src/extensions/skills/providers/runledger.ts", source)).toEqual([
			{ file: "src/extensions/skills/providers/runledger.ts", kind: "provider-execution-port" },
		]);
	});

	it("flags a provider importing MCP, gateway, session-runtime, or child_process", () => {
		const source = [
			'import { McpConnectionManager } from "../mcp/connection-manager.ts";',
			'import { createMcpExecutionEnvFetch } from "../mcp/sdk-factory.ts";',
			'import { runHookPipeline } from "../hooks/pipeline.ts";',
			'import { AttemptPort } from "../../runtime/session-runtime/attempt-gateway.ts";',
			'import { spawn } from "node:child_process";',
		].join("\n");
		const violations = findProviderExecutionPortViolations("src/extensions/skills/providers/plugin-contributions.ts", source);
		expect(violations.length).toBeGreaterThanOrEqual(2);
		expect(violations.every((violation) => violation.kind === "provider-execution-port")).toBe(true);
	});

	it("allows providers to import skill schema, diagnostics, and protocol id types", () => {
		const source = [
			'import type { SkillDescriptor, SkillTrustBinding } from "../types.ts";',
			'import type { SkillDiscoveryObservation } from "../registry.ts";',
			'import { extensionDiagnostic } from "../../diagnostics.ts";',
			'import type { ExtensionSourceRoot } from "../../types.ts";',
			'import type { ResourceIdentity } from "../../../runtime/resources/types.ts";',
		].join("\n");
		expect(findProviderExecutionPortViolations("src/extensions/skills/providers/runledger.ts", source)).toEqual([]);
	});

	it("ignores non-provider files entirely", () => {
		const source = 'import { TrustStore } from "../trust/trust-store.ts";';
		expect(findProviderExecutionPortViolations("src/extensions/manager.ts", source)).toEqual([]);
	});
});
