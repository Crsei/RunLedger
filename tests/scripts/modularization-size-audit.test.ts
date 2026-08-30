import { describe, expect, it } from "vitest";
import { listNewModulePaths } from "../../scripts/check-modularization-size.ts";

describe("modularization size audit", () => {
	it("reports only modules added by the current worktree relative to HEAD", () => {
		const paths = listNewModulePaths();

		expect(paths).toContain("src/runtime/session-runtime/command-routes.ts");
		expect(paths).toContain("src/api/openai-codex-responses/websocket-frame-stream.ts");
		expect(paths).not.toContain("src/storage/session-store/owner-store.ts");
		expect(new Set(paths).size).toBe(paths.length);
	});
});
