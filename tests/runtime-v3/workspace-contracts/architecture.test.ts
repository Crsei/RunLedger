import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const CONTRACT_FILES = [
	"../../../src/runtime/protocol/v3/workspace.ts",
	"../../../src/runtime/protocol/v3/workspace-events.ts",
	"../../../src/runtime/session/workspace-projection.ts",
	"../../../src/runtime/session/workspace-reducer.ts",
] as const;

function source(relativePath: string): string {
	return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
}

describe("Workspace contract architecture boundary", () => {
	it("does not import filesystem, Git, security, or worktree implementations", () => {
		for (const path of CONTRACT_FILES) {
			const text = source(path);
			const imports = [...text.matchAll(/from\s+["']([^"']+)["']/g)].map((match) => match[1]);
			for (const specifier of imports) {
				expect(specifier, `${path} imports ${specifier}`).not.toMatch(
					/^(?:node:)?(?:fs|path|child_process)$|(?:^|\/)(?:security|worktree)(?:\/|$)|git/i,
				);
			}
			expect(text, path).not.toMatch(/\b(?:readFile|writeFile|realpath|spawn|execFile|git\s+worktree)\s*\(/);
		}
	});

	it("keeps WorkspaceServicePort opaque and behavior-free", () => {
		const text = source("../../../src/runtime/protocol/v3/workspace.ts");
		expect(text).toContain("export interface WorkspaceServicePort");
		expect(text).toContain("Promise<WorkspaceServiceResult>");
		expect(text).not.toMatch(/export class (?:WorkspaceManager|LeaseStore|PathGuard|WorkspaceBroker)/);
	});
});
