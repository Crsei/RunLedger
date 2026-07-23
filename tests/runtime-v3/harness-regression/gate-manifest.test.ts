import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

interface PackageManifest {
	scripts?: Record<string, string>;
}

interface CoverageAxis {
	axis: string;
	evidence: readonly string[];
	gateTargets: readonly string[];
}

const projectRoot = fileURLToPath(new URL("../../../", import.meta.url));
const gateTargets = [
	"tests/runtime-v3/harness-regression",
	"tests/runtime-v3/integration/production-tool-gateway.test.ts",
	"tests/runtime-v3/lifecycle/production-shutdown-host.test.ts",
	"tests/e2e/daemon-recovery.test.ts",
	"tests/e2e/daemon-stdio.test.ts",
	"tests/e2e/multi-agent-isolation.test.ts",
	"tests/security/credential-broker-adapter.test.ts",
	"tests/security/denial.test.ts",
] as const;

const coverageAxes: readonly CoverageAxis[] = [
	{
		axis: "restart/replay",
		evidence: [
			"tests/e2e/daemon-recovery.test.ts",
			"tests/runtime-v3/integration/production-tool-gateway.test.ts",
		],
		gateTargets: [
			"tests/e2e/daemon-recovery.test.ts",
			"tests/runtime-v3/integration/production-tool-gateway.test.ts",
		],
	},
	{
		axis: "signals",
		evidence: [
			"tests/e2e/daemon-stdio.test.ts",
			"tests/runtime-v3/lifecycle/production-shutdown-host.test.ts",
		],
		gateTargets: [
			"tests/e2e/daemon-stdio.test.ts",
			"tests/runtime-v3/lifecycle/production-shutdown-host.test.ts",
		],
	},
	{
		axis: "sandbox denial",
		evidence: [
			"tests/runtime-v3/integration/production-tool-gateway.test.ts",
			"tests/security/denial.test.ts",
		],
		gateTargets: [
			"tests/runtime-v3/integration/production-tool-gateway.test.ts",
			"tests/security/denial.test.ts",
		],
	},
	{
		axis: "credential leakage",
		evidence: [
			"tests/runtime-v3/harness-regression/core-attack-matrix.test.ts",
			"tests/runtime-v3/integration/production-tool-gateway.test.ts",
			"tests/security/credential-broker-adapter.test.ts",
		],
		gateTargets: [
			"tests/runtime-v3/harness-regression",
			"tests/runtime-v3/integration/production-tool-gateway.test.ts",
			"tests/security/credential-broker-adapter.test.ts",
		],
	},
	{
		axis: "candidate tampering",
		evidence: ["tests/runtime-v3/harness-regression/verification-attack-matrix.test.ts"],
		gateTargets: ["tests/runtime-v3/harness-regression"],
	},
	{
		axis: "multi-agent isolation",
		evidence: [
			"tests/runtime-v3/harness-regression/core-attack-matrix.test.ts",
			"tests/e2e/multi-agent-isolation.test.ts",
		],
		gateTargets: [
			"tests/runtime-v3/harness-regression",
			"tests/e2e/multi-agent-isolation.test.ts",
		],
	},
];

function loadManifest(): PackageManifest {
	return JSON.parse(readFileSync(resolve(projectRoot, "package.json"), "utf8")) as PackageManifest;
}

describe("Harness Regression gate manifest", () => {
	it("runs type and boundary checks before one dedicated Vitest invocation", () => {
		const scripts = loadManifest().scripts;
		expect(scripts?.["pretest:harness-regression"]).toBe("npm run check");
		expect(scripts?.["test:harness-regression"]?.trim().split(/\s+/u)).toEqual([
			"vitest",
			"run",
			...gateTargets,
		]);
	});

	it.each(coverageAxes)("keeps $axis evidence in the dedicated gate", ({ evidence, gateTargets: targets }) => {
		for (const target of targets) expect(gateTargets).toContain(target);
		for (const path of evidence) expect(existsSync(resolve(projectRoot, path)), path).toBe(true);
	});
});
