import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const indexSource = readFileSync(join(root, "src/tui/index.ts"), "utf8");
const planSource = readFileSync(join(root, "development-doc/tui/17-passive-data-contract-placeholder-plan.md"), "utf8");
const tick = String.fromCharCode(96);
const quote = String.fromCharCode(34);

const contractModules = [
	"./application/types.ts",
	"./presentation/types.ts",
	"./presentation/tools/types.ts",
	"./timeline/types.ts",
	"./commands/types.ts",
	"./sessions/types.ts",
	"./providers/types.ts",
	"./auth/types.ts",
	"./models/types.ts",
	"./thinking/types.ts",
	"./prompts/types.ts",
	"./keymap/types.ts",
	"./queue/types.ts",
	"./approval/types.ts",
	"./task-goal/types.ts",
	"./goal-plan/types.ts",
	"./agents/types.ts",
	"./extensions/types.ts",
	"./runtime-snapshot/types.ts",
	"./security-mode/types.ts",
	"./shutdown/types.ts",
	"./workspace/types.ts",
	"./update/types.ts",
] as const;

describe("passive contract exports and status", () => {
	it("exports each new contract through a type-only declaration", () => {
		for (const modulePath of contractModules) {
			expect(indexSource).toContain("export type * from " + quote + modulePath + quote);
			expect(indexSource).not.toMatch(new RegExp("export\\s+\\{[^}]*\\}\\s+from\\s+" + quote + modulePath.replaceAll(".", "\\.") + quote, "u"));
		}
		expect(indexSource).toMatch(/export\s+type\s*\{\s*ProcessPassive/u);
	});

	it("documents agent-verified P0-P6 status without claiming human terminal verification", () => {
		for (const phase of ["P0", "P1", "P2", "P3", "P4", "P5", "P6"]) {
			expect(planSource).toContain("| " + phase);
			expect(planSource).toMatch(new RegExp("\\| " + phase + "[^\\n]*\\| " + tick + "agent-verified" + tick, "u"));
		}
		expect(planSource).toContain("OpenTUI production TUI");
		expect(planSource).toContain("未接入");
		const statusRows = planSource.split("\n").filter((line) => /^\| P[0-6] [^|]+ \| `agent-verified`/u.test(line));
		expect(statusRows).toHaveLength(7);
		expect(statusRows.join("\n")).not.toContain("human-verified");
	});

	it("keeps the two-level documentation navigation pointing at the canonical plan", () => {
		for (const relativePath of ["development-doc/00-index.md", "development-doc/tui/00-overview.md"]) {
			const source = readFileSync(join(root, relativePath), "utf8");
			expect(source).toContain("17-passive-data-contract-placeholder-plan.md");
		}
	});
});
