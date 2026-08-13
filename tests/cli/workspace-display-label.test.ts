import { describe, expect, it } from "vitest";
import { gitWorkspaceDisplayFacts, workspaceDisplayLabel, workspaceDisplayLabelForView } from "../../src/cli/workspace-display-label.ts";

describe("workspace display label", () => {
	it("uses home-relative labels without publishing the absolute home", () => {
		const label = workspaceDisplayLabel("/home/alice/work/RunLedger", "/home/alice");
		expect(label).toBe("~/work/RunLedger");
		expect(label).not.toContain("/home/alice");
		expect(workspaceDisplayLabel("/home/alice", "/home/alice")).toBe("~");
	});

	it("uses only the basename when cwd is outside home", () => {
		expect(workspaceDisplayLabel("/srv/private/RunLedger", "/home/alice")).toBe("RunLedger");
	});

	it("handles Windows drive paths without depending on the test host platform", () => {
		expect(workspaceDisplayLabel("C:\\Users\\Alice\\work\\RunLedger", "C:\\Users\\Alice")).toBe("~/work/RunLedger");
		expect(workspaceDisplayLabel("D:\\private\\RunLedger", "C:\\Users\\Alice")).toBe("RunLedger");
	});

	it("strips terminal controls and bounds the safe label", () => {
		const label = workspaceDisplayLabel(`/srv/private/\u001b]0;owned\u0007${"界".repeat(60)}`, "/home/alice");
		expect(label).not.toContain("\u001b");
		expect(label).not.toContain("\u0007");
		expect(new TextEncoder().encode(label).byteLength).toBeLessThanOrEqual(83);
	});

	it("uses the revalidated Session effective cwd and fails closed for remote-only attachments", () => {
		expect(workspaceDisplayLabelForView({ effectiveCwd: "/home/alice/.runledger/worktrees/s1" }, "/home/alice"))
			.toBe("~/.runledger/worktrees/s1");
		expect(workspaceDisplayLabelForView({ effectiveCwd: undefined }, "/home/alice")).toBeUndefined();
	});

	it("projects only safe Git root and branch labels", async () => {
		const calls: string[][] = [];
		const facts = await gitWorkspaceDisplayFacts("/home/alice/work/RunLedger", {
			run: async (request) => {
				calls.push([...request.arguments]);
				return request.arguments.includes("--show-toplevel")
					? { stdout: "/home/alice/work/RunLedger\n", stderr: "", exitCode: 0, signaled: false }
					: { stdout: "feature/highlight\u001b]0;owned\u0007\n", stderr: "", exitCode: 0, signaled: false };
			},
		});
		expect(facts).toEqual({ projectRootLabel: "RunLedger", branchLabel: "feature/highlight" });
		expect(calls).toEqual([
			["rev-parse", "--show-toplevel"],
			["symbolic-ref", "--quiet", "--short", "HEAD"],
		]);
	});
});
