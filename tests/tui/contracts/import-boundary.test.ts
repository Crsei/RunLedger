import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(process.cwd());
const planPath = join(repoRoot, "development-doc/tui/17-passive-data-contract-placeholder-plan.md");

const passiveContractRoots = [
	"src/tui/application",
	"src/tui/presentation",
	"src/tui/timeline",
	"src/tui/commands",
	"src/tui/sessions",
	"src/tui/providers",
	"src/tui/auth",
	"src/tui/models",
	"src/tui/thinking",
	"src/tui/prompts",
	"src/tui/keymap",
	"src/tui/queue",
	"src/tui/approval",
	"src/tui/task-goal",
	"src/tui/goal-plan",
	"src/tui/agents",
	"src/tui/extensions",
	"src/tui/runtime-snapshot",
	"src/tui/security-mode",
	"src/tui/shutdown",
	"src/tui/workspace",
	"src/tui/update",
] as const;

const forbiddenPatterns: readonly [RegExp, string][] = [
	[/@opentui\/core/u, "OpenTUI runtime"],
	[/@earendil-works\/pi-tui/u, "pi-tui runtime"],
	[/from ["']node:/u, "Node builtin"],
	[/from ["'][^"']*storage\//u, "storage adapter"],
	[/execution-env/u, "ExecutionEnv"],
	[/controller-adapter/u, "controller adapter"],
	[/\b(?:fetch|spawn|exec|readFile|writeFile|mkdir|setTimeout)\s*\(/u, "IO/runtime operation"],
];

function listTypeScriptFiles(root: string): string[] {
	try {
		if (statSync(root).isFile()) return [root];
	} catch {
		return [];
	}
	return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
		const path = join(root, entry.name);
		if (entry.isDirectory()) return listTypeScriptFiles(path);
		return entry.isFile() && entry.name.endsWith(".ts") ? [path] : [];
	});
}

describe("passive TUI contract boundary", () => {
	it("has an explicit P0 mapping section covering every contract root", () => {
		const plan = readFileSync(planPath, "utf8");
		expect(plan).toContain("### 4.4 P0 implementation mapping");
		for (const root of passiveContractRoots) {
			expect(plan).toContain("| `" + root.replace("src/tui/", "") + "/");
		}
	});

	it("does not import renderer, IO, storage, execution, or controller runtime", () => {
		const violations: string[] = [];
		for (const root of passiveContractRoots) {
			for (const file of listTypeScriptFiles(join(repoRoot, root))) {
				const source = readFileSync(file, "utf8");
				for (const [pattern, reason] of forbiddenPatterns) {
					if (pattern.test(source)) violations.push(`${file}: ${reason}`);
				}
			}
		}
		expect(violations).toEqual([]);
	});
});
