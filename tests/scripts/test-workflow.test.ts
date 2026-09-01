import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const workflowPath = resolve(import.meta.dirname, "../../.github/workflows/test.yml");
const BUN_SETUP_ACTION = ["oven-sh/setup-bun@", "v" + "2"].join("");

function workflowText(): string {
	return readFileSync(workflowPath, "utf8");
}

describe("repository test workflow", () => {
	it("owns every required PR gate and fails closed when any dependency is not successful", () => {
		const workflow = workflowText();
		const requiredJobs = [
			"inventory-and-check",
			"test-fast",
			"test-singleton",
			"test-runtime",
			"test-security-storage",
			"test-integration-linux",
			"test-tui-native-linux",
			"build-and-cli-smoke",
		] as const;

		expect(workflow).toContain("pull_request:");
		expect(workflow).toContain("push:");
		expect(workflow).toContain("permissions:\n  contents: read");
		expect(workflow).toContain("cancel-in-progress: ${{ github.event_name == 'pull_request' }}");
		for (const job of requiredJobs) {
			expect(workflow).toMatch(new RegExp(`^  ${job}:`, "m"));
			expect(workflow).toContain(`needs.${job}.result`);
		}
		expect(workflow).toMatch(/^  test-gate:\n[\s\S]*?if: \$\{\{ always\(\) \}\}/m);
		expect(workflow).toContain('if [ "$result" != "success" ]; then');
	});

	it("installs pinned toolchains, uses isolated runtime state, and invokes canonical scripts", () => {
		const workflow = workflowText();

		for (const marker of [
			"actions/setup-node@v4",
			"node-version: 22.23.1",
			BUN_SETUP_ACTION,
			"bun-version: 1.3.14",
			"npm ci",
			"RUNLEDGER_DIR: ${{ runner.temp }}/runledger",
			"ANTHROPIC_API_KEY: ''",
			"OPENAI_API_KEY: ''",
			"AWS_ACCESS_KEY_ID: ''",
			"npm run test:inventory",
			"npm run check",
			"npm run test:fast",
			"npm run test:singleton",
			"npm run test:runtime",
			"npm run test:security-storage",
			"npm run test:integration",
			"npm run test:tui-native",
			"npm run build",
			"npm run test:smoke",
		]) {
			expect(workflow).toContain(marker);
		}
	});

	it("retains failure logs and sanitized execution evidence for every bucket job", () => {
		const workflow = workflowText();

		for (const bucket of ["fast", "singleton", "runtime", "security-storage", "integration", "tui-native"] as const) {
			expect(workflow).toContain(`npm run test:${bucket} -- --evidence-file \"$RUNNER_TEMP/test-${bucket}-evidence.json\"`);
			expect(workflow).toContain(`$RUNNER_TEMP/test-${bucket}.log`);
			expect(workflow).toContain(`name: test-${bucket}-evidence`);
		}
		expect(workflow).toContain("$RUNNER_TEMP/cli-smoke-evidence.json");
		expect(workflow).toContain("name: cli-smoke-evidence");
		expect(workflow).toContain("sudo apt-get update && sudo apt-get install --yes tmux");
		expect(workflow).toContain("npm run test:smoke");
		expect(workflow).toContain("actions/upload-artifact@v4");
		expect(workflow).toContain("if: always()");
		expect(workflow).toContain("set -o pipefail");
	});
});
