import { describe, expect, it } from "vitest";
import { listNewModulePaths } from "../../scripts/check-modularization-size.ts";

describe("modularization size audit", () => {
	it("reports only modules added by the current worktree relative to HEAD", () => {
		const calls: string[][] = [];
		const paths = listNewModulePaths({
			gitPathLines: (args) => {
				calls.push([...args]);
				return args[0] === "diff"
					? [
						"src/runtime/session-runtime/command-routes.ts",
						"src/api/openai-codex-responses/websocket-frame-stream.ts",
						"src/providers/generated.models.ts",
					]
					: ["src/runtime/session-runtime/command-routes.ts", "tests/not-a-module.ts"];
			},
		});

		expect(paths).toEqual([
			"src/api/openai-codex-responses/websocket-frame-stream.ts",
			"src/runtime/session-runtime/command-routes.ts",
		]);
		expect(paths).not.toContain("src/storage/session-store/owner-store.ts");
		expect(new Set(paths).size).toBe(paths.length);
		expect(calls).toHaveLength(2);
		expect(calls[0]).toContain("--diff-filter=A");
		expect(calls[1]?.slice(0, 3)).toEqual(["ls-files", "--others", "--exclude-standard"]);
	});
});
