import { describe, expect, it } from "vitest";
import { derivePlanTitle, planExportCandidates, planExportFileName } from "../../../../src/runtime/modes/plan/title.ts";

describe("plan artifact naming", () => {
	it("derives the title from the first level-one heading and falls back to the session title", () => {
		expect(derivePlanTitle({ content: "preamble\n\n# Split request handler\n\nbody" })).toBe("Split request handler");
		// 二级 heading 不是标题来源。
		expect(derivePlanTitle({ content: "## Only a subsection", sessionTitle: "Session name" })).toBe("Session name");
		expect(derivePlanTitle({ content: "no headings at all" })).toBe("Plan");
		expect(derivePlanTitle({ content: "#    ", sessionTitle: "Session name" })).toBe("Session name");
	});

	it("collapses whitespace and bounds a long heading", () => {
		expect(derivePlanTitle({ content: "#  多个   空格\t标题 " })).toBe("多个 空格 标题");
		const long = derivePlanTitle({ content: `# ${"a".repeat(300)}` });
		expect(long.length).toBe(120);
	});

	it("builds an upper-case export filename and keeps CJK characters", () => {
		expect(planExportFileName("Split PyO3 methods")).toBe("SPLIT_PYO3_METHODS_PLAN.md");
		expect(planExportFileName("认证存储迁移")).toBe("认证存储迁移_PLAN.md");
		// 标题已以 PLAN 结尾时不重复追加。
		expect(planExportFileName("auth plan")).toBe("AUTH_PLAN.md");
		expect(planExportFileName("")).toBe("PLAN.md");
		expect(planExportFileName("  ---  ")).toBe("PLAN.md");
	});

	it("truncates an over-long stem at a word boundary", () => {
		const name = planExportFileName("Alpha Beta Gamma Delta Epsilon Zeta Eta Theta Iota Kappa");
		expect(name.length).toBeLessThanOrEqual(40);
		expect(name.endsWith("_PLAN.md")).toBe(true);
		expect(name).not.toContain("__");
	});

	it("produces collision-avoiding candidates that keep the extension", () => {
		expect(planExportCandidates("AUTH_PLAN.md", 3)).toEqual(["AUTH_PLAN.md", "AUTH_PLAN-1.md", "AUTH_PLAN-2.md"]);
	});
});
