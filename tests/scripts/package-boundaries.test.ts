import { describe, expect, it } from "vitest";
import { scanPackageBoundarySources, readPackageSources, scanWorkspaceBoundarySources, readWorkspaceSources } from "../../scripts/check-package-boundaries.ts";

describe("single-package dependency boundaries", () => {
	it("rejects storage/UI dependencies, internal value barrels and current-contract I/O", () => {
		const problems = scanPackageBoundarySources(new Map([
			["src/auth/oauth/example.ts", 'import { path } from "../../storage/paths.ts";'],
            ["src/storage/preferences.ts", 'import type { Settings } from "../tui/types.ts";'],
			["src/tui/components/view.ts", 'export { Box } from "../index.ts";'],
			["src/contracts/settings.ts", 'import { readFile } from "node:fs";'],
		]));
		expect(problems).toEqual(expect.arrayContaining([
			expect.stringContaining("auth-storage:"), expect.stringContaining("storage-ui:"), expect.stringContaining("internal-barrel:"), expect.stringContaining("contract-dependency:"),
		]));
	});
	it("detects value cycles while allowing erased type-only imports and exports", () => {
		const sources = new Map([
			["src/tui/a.ts", 'import { value } from "./b.ts";'],
			["src/tui/b.ts", 'export { value } from "./a.ts";'],
		]);
		expect(scanPackageBoundarySources(sources)).toEqual([expect.stringContaining("tui-cycle:")]);
		sources.set("src/tui/b.ts", 'export { type Value } from "./a.ts"; import type { Value } from "./index.ts";');
		expect(scanPackageBoundarySources(sources)).toEqual([]);
	});
	it("keeps the current storage/contracts/TUI graph within its boundaries", () => {
		expect(scanPackageBoundarySources(readPackageSources(process.cwd()))).toEqual([]);
	});
	it("rejects deep imports of workspace package sources", () => {
		const problems = scanPackageBoundarySources(new Map([
			["src/web/server.ts", 'import { bounds } from "../../packages/collab-web/src/contracts/index.ts";'],
		]));
		expect(problems).toEqual([expect.stringContaining("deep-package-import:")]);
	});
});

describe("workspace package boundaries", () => {
	it("rejects relative escapes and non-typebox contract dependencies", () => {
		const problems = scanWorkspaceBoundarySources(new Map([
			["packages/collab-web/src/app.ts", 'import { store } from "../../../src/storage/session-store.ts";'],
			["packages/collab-web/src/contracts/common.ts", 'import { join } from "node:path";'],
		]));
		expect(problems).toEqual(expect.arrayContaining([
			expect.stringContaining("package-escape:"), expect.stringContaining("package-contract-dependency:"),
		]));
	});
	it("allows in-package contracts imports and typebox", () => {
		const problems = scanWorkspaceBoundarySources(new Map([
			["packages/collab-web/src/contracts/index.ts", 'export * from "./common.ts";'],
			["packages/collab-web/src/contracts/common.ts", 'import { Type } from "typebox";'],
			["packages/collab-web/src/App.tsx", 'import type { WebSnapshot } from "./contracts/index.ts";'],
		]));
		expect(problems).toEqual([]);
	});
	it("keeps the current workspace packages within their boundaries", () => {
		expect(scanWorkspaceBoundarySources(readWorkspaceSources(process.cwd()))).toEqual([]);
	});
});
