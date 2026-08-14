import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

interface BoundaryModule {
	scanBashAstSecurityBoundaries(repoRoot: string): readonly {
		readonly file: string;
		readonly kind: string;
	}[];
}

async function loadModule(): Promise<BoundaryModule | undefined> {
	const path = join(process.cwd(), "scripts/bash-ast-security-boundaries.ts");
	expect(existsSync(path), "Bash AST security boundary scanner must exist").toBe(true);
	if (!existsSync(path)) return undefined;
	const specifier = "../../scripts/bash-ast-security-boundaries.ts";
	return await import(specifier) as BoundaryModule;
}

async function fixture(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "runledger-bash-boundary-"));
	roots.push(root);
	const files: Readonly<Record<string, string>> = {
		"src/security/permission/access-resolver.ts": `
export async function resolveToolAccessRequestsWithBashAnalyzer() {
  const analysis = await analyzer.analyze(command, mode);
  return analysis.mode === "ast" ? analysis.ast : analysis.legacyKind;
}`,
		"src/security/session-composition.ts": `
import { resolveToolAccessRequestsWithBashAnalyzer } from "./permission/access-resolver.ts";
const requests = await resolveToolAccessRequestsWithBashAnalyzer("bash", { command }, cwd, mode, analyzer);`,
		"src/security/permission/engine.ts": `
const hardlineReason = hardlineShellDenialReason(request.command);
if (hardlineReason) return { action: "deny" };
if (analyzerMode === "ast") {
  if (request.bashAst?.kind !== "simple") return { action: "ask", matchedRuleIds: ["builtin-shell-ast-failure"] };
  return { action: "allow" };
}`,
		"src/security/permission/bash-ast/classifier.ts": `
await telemetry?.record({ commandDigest, mode: "shadow", astKind });`,
		"src/cli/runtime-host-security.ts": "export const legacyHost = true;",
	};
	for (const [relative, source] of Object.entries(files)) {
		const path = join(root, relative);
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, source, "utf8");
	}
	return root;
}

describe("Bash AST structural security boundaries", () => {
	it("accepts the canonical classifier and fail-closed ordering", async () => {
		const module = await loadModule();
		if (module === undefined) return;
		expect(module.scanBashAstSecurityBoundaries(await fixture())).toEqual([]);
	});

	it("rejects a private production access-request classifier", async () => {
		const module = await loadModule();
		if (module === undefined) return;
		const root = await fixture();
		await writeFile(join(root, "src/security/session-composition.ts"), "async function bashAccessRequests() {}", "utf8");
		expect(module.scanBashAstSecurityBoundaries(root)).toContainEqual({
			file: "src/security/session-composition.ts",
			kind: "duplicate-bash-access-resolver",
		});
	});

	it("rejects AST failure allow or hardline ordering drift", async () => {
		const module = await loadModule();
		if (module === undefined) return;
		const root = await fixture();
		await writeFile(join(root, "src/security/permission/engine.ts"), `
if (analyzerMode === "ast") {
  if (request.bashAst?.kind !== "simple") return { action: "allow", matchedRuleIds: ["builtin-shell-ast-failure"] };
}
const hardlineReason = hardlineShellDenialReason(request.command);`, "utf8");
		const kinds = module.scanBashAstSecurityBoundaries(root).map((item) => item.kind);
		expect(kinds).toContain("ast-failure-not-fail-closed");
		expect(kinds).toContain("hardline-after-ast");
	});

	it("rejects raw command fields in shadow telemetry", async () => {
		const module = await loadModule();
		if (module === undefined) return;
		const root = await fixture();
		await writeFile(join(root, "src/security/permission/bash-ast/classifier.ts"), `
await telemetry?.record({ commandDigest, rawCommand: command, mode: "shadow" });`, "utf8");
		expect(module.scanBashAstSecurityBoundaries(root)).toContainEqual({
			file: "src/security/permission/bash-ast/classifier.ts",
			kind: "raw-bash-telemetry",
		});
	});
});
