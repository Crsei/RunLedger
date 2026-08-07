/** P0 回归:标准 TUI 必须暴露最小可达的 Session recovery 工作流。 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("Session Owner recovery command", () => {
	it("routes /recovery through typed controller recovery methods", () => {
		const source = readFileSync(resolve(process.cwd(), "src", "tui", "interactive-mode.ts"), "utf8");
		expect(source).toContain('{ value: "/recovery"');
		expect(source).toContain('case "recovery":');
		expect(source).toContain("recoveryStatus");
		expect(source).toContain("recoveryAssess");
		expect(source).toContain("recoveryVerify");
		expect(source).toContain("recoveryResume");
	});
});
