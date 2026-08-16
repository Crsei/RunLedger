import { describe, expect, it } from "vitest";
import { gitWorkspaceDisplayFacts, workspaceDisplayAbsolutePath, workspaceDisplayAbsolutePathForView } from "../../src/cli/workspace-display-label.ts";

describe("workspace display facts", () => {

	it("projects only the safe Git branch label without a project root label", async () => {
		const calls: string[][] = [];
		const facts = await gitWorkspaceDisplayFacts("/home/alice/work/RunLedger", {
			run: async (request) => {
				calls.push([...request.arguments]);
				return { stdout: "feature/highlight\u001b]0;owned\u0007\n", stderr: "", exitCode: 0, signaled: false };
			},
		});
		expect(facts).toEqual({ branchLabel: "feature/highlight" });
		expect(calls).toEqual([["symbolic-ref", "--quiet", "--short", "HEAD"]]);
	});

	it("keeps the agent runtime absolute path verbatim while stripping terminal controls", () => {
		const label = workspaceDisplayAbsolutePath(`/data2-HDD-SATA-20T/Digital_avatar/haoweiyao/RunLedger\u001b]0;owned\u0007`);
		expect(label).toBe("/data2-HDD-SATA-20T/Digital_avatar/haoweiyao/RunLedger");
	});

	it("bounds the absolute path to the terminal-safe byte limit", () => {
		const label = workspaceDisplayAbsolutePath(`/srv/private/${"界".repeat(60)}`);
		expect(label).not.toContain("\u001b");
		expect(new TextEncoder().encode(label).byteLength).toBeLessThanOrEqual(83);
	});

	it("fails closed when the view has no revalidated effective cwd", () => {
		expect(workspaceDisplayAbsolutePathForView({ effectiveCwd: undefined })).toBeUndefined();
		expect(workspaceDisplayAbsolutePathForView({ effectiveCwd: "/srv/private/RunLedger" })).toBe("/srv/private/RunLedger");
	});
});
