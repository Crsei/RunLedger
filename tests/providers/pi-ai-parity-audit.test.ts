import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
	CATALOG_DIGEST_ALGORITHM,
	KNOWN_PI_AI_DELTA_IDS,
	auditPiAiDelta,
	classifyPiAiPath,
	computeCatalogDigest,
	computeCatalogFiles,
	parseAuditArguments,
	runAuditCli,
	sha256Digest,
	type AuditCliIo,
	type PiAiParityManifest,
} from "../../scripts/audit-pi-ai-delta.ts";

interface Fixture {
	root: string;
	upstream: string;
	manifestPath: string;
	baseCommit: string;
	upstreamCommit: string;
	manifest: PiAiParityManifest;
}

const temporaryDirectories: string[] = [];

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function write(path: string, content: string): void {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, content);
}

function git(repository: string, args: readonly string[]): string {
	const result = spawnSync("git", [...args], { cwd: repository, encoding: "utf8", shell: false });
	if (result.error) throw result.error;
	if (result.status !== 0) throw new Error(result.stderr.trim() || `git ${args[0] ?? "<missing>"} failed`);
	return result.stdout.trim();
}

function gitBuffer(repository: string, args: readonly string[]): Buffer {
	const result = spawnSync("git", [...args], { cwd: repository, encoding: null, shell: false });
	if (result.error) throw result.error;
	if (result.status !== 0) {
		const stderr = Buffer.isBuffer(result.stderr) ? result.stderr.toString("utf8").trim() : "";
		throw new Error(stderr || `git ${args[0] ?? "<missing>"} failed`);
	}
	return Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout ?? "");
}

function initializeRepository(repository: string, paths: readonly string[]): string {
	git(repository, ["init", "--quiet"]);
	git(repository, ["config", "user.name", "RunLedger Test"]);
	git(repository, ["config", "user.email", "runledger-test@example.invalid"]);
	git(repository, ["add", "--", ...paths]);
	git(repository, ["commit", "--quiet", "-m", "fixture"]);
	return git(repository, ["rev-parse", "HEAD"]);
}

function sourceMapping(
	upstreamRoot: string,
	localRoot: string,
	upstreamCommit: string,
	upstreamPath: string,
	localPath: string,
): PiAiParityManifest["mappings"][number] {
	const upstreamContent = gitBuffer(upstreamRoot, ["show", `${upstreamCommit}:${upstreamPath}`]);
	const localContent = readFileSync(join(localRoot, localPath));
	return {
		upstreamPath,
		localPath,
		upstreamDigest: sha256Digest(upstreamContent),
		localDigest: sha256Digest(localContent),
		status: sha256Digest(upstreamContent) === sha256Digest(localContent) ? "identical" : "modified",
		category: classifyPiAiPath(upstreamPath),
		decision: "adopt",
		rationale: "The fixture is byte-identical to the fixed upstream blob.",
		evidence: [],
	};
}

function createFixture(): Fixture {
	const container = mkdtempSync(join(tmpdir(), "runledger-pi-ai-audit-"));
	temporaryDirectories.push(container);
	const root = join(container, "runledger");
	const upstream = join(container, "pi");
	mkdirSync(root, { recursive: true });
	mkdirSync(upstream, { recursive: true });

	const sharedTypes = "export interface ToolResultMessage { usage?: { totalTokens: number } }\n";
	const sharedProvider = "export const providerId = \"fixture\";\n";
	write(join(upstream, "LICENSE"), "MIT License\n\nCopyright (c) RunLedger fixture\n");
	write(join(upstream, "packages/ai/package.json"), '{"name":"fixture-pi-ai","license":"MIT"}\n');
	write(join(upstream, "packages/ai/src/types.ts"), sharedTypes);
	write(join(upstream, "packages/ai/src/providers/fixture.ts"), sharedProvider);
	const upstreamCommit = initializeRepository(upstream, ["LICENSE", "packages"]);

	write(join(root, "package.json"), '{"name":"fixture-runledger","license":"MIT"}\n');
	write(join(root, "src/types.ts"), sharedTypes);
	write(join(root, "src/providers/fixture.ts"), sharedProvider);
	write(join(root, "src/providers/fixture.models.ts"), "export const FIXTURE_MODELS = {};\n");
	write(join(root, "src/providers/data/fixture.json"), "{}\n");
	write(join(root, "src/models.generated.ts"), "export const MODELS = {};\n");
	write(join(root, "src/image-models.generated.ts"), "export const IMAGE_MODELS = {};\n");
	write(join(root, "scripts/generate-models.ts"), "export {};\n");
	write(join(root, "tests/providers/pi-ai-parity-audit.test.ts"), "export {};\n");
	const baseCommit = initializeRepository(root, ["package.json", "scripts", "src", "tests"]);

	const mappings = [
		sourceMapping(upstream, root, upstreamCommit, "packages/ai/src/providers/fixture.ts", "src/providers/fixture.ts"),
		sourceMapping(upstream, root, upstreamCommit, "packages/ai/src/types.ts", "src/types.ts"),
	].sort((left, right) => left.upstreamPath.localeCompare(right.upstreamPath));
	const catalogFiles = computeCatalogFiles(root);
	const regressionTest = "tests/providers/pi-ai-parity-audit.test.ts";
	const manifest: PiAiParityManifest = {
		schemaVersion: 1,
		upstream: {
			repository: "fixture/pi",
			commit: upstreamCommit,
			sourceRoot: "packages/ai/src",
			packagePath: "packages/ai",
		},
		runLedger: { baseCommit, sourceRoot: "src" },
		mappings,
		appliedDeltas: KNOWN_PI_AI_DELTA_IDS.map((id) => ({
			id,
			summary: `Fixture coverage for ${id}.`,
			upstreamPaths: ["packages/ai/src/types.ts"],
			localPaths: ["src/types.ts"],
			regressionTests: [regressionTest],
		})),
		decisions: [
			{
				id: "fixture-generator-layout",
				disposition: "localize",
				scope: ["scripts/generate-models.ts"],
				reason: "The fixture keeps its generator local.",
				evidence: [regressionTest],
			},
		],
		catalog: {
			algorithm: CATALOG_DIGEST_ALGORITHM,
			files: catalogFiles,
			digest: computeCatalogDigest(catalogFiles),
		},
		messageEventTransformations: {
			summary: "The fixture preserves ToolResult messages byte-for-byte.",
			behaviors: [
				{
					id: "tool-result-round-trip",
					summary: "ToolResult usage survives the fixture transformation.",
					evidence: [regressionTest],
				},
			],
		},
		verification: {
			results: [
				{ command: "npx vitest run tests/providers/pi-ai-parity-audit.test.ts", status: "passed", summary: "Focused parity tests passed." },
				{ command: "npm run check", status: "passed", summary: "Type and boundary checks passed." },
				{ command: "npm test", status: "passed", summary: "Full test suite passed." },
				{ command: "npm run build", status: "passed", summary: "Production build passed." },
				{ command: "git diff --check", status: "passed", summary: "Whitespace validation passed." },
			],
		},
		license: {
			upstreamFile: "LICENSE",
			upstreamDigest: sha256Digest(readFileSync(join(upstream, "LICENSE"))),
			upstreamPackageSpdx: "MIT",
			runLedgerPackageFile: "package.json",
			runLedgerPackageSpdx: "MIT",
			conclusion: "The fixed upstream and RunLedger package both declare MIT.",
		},
	};
	const manifestPath = join(root, "development-doc/providers/pi-ai-parity-manifest.json");
	write(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
	return { root, upstream, manifestPath, baseCommit, upstreamCommit, manifest };
}

function runFixtureAudit(fixture: Fixture) {
	return auditPiAiDelta({
		repoRoot: fixture.root,
		manifestPath: fixture.manifestPath,
		upstreamPath: fixture.upstream,
		commit: fixture.upstreamCommit,
	});
}

describe("pi-ai parity audit arguments", () => {
	it("requires an explicit upstream checkout and full commit", () => {
		expect(() => parseAuditArguments([])).toThrow("--upstream is required");
		expect(() => parseAuditArguments(["--upstream", "/tmp/pi"])).toThrow("--commit is required");
		expect(() => parseAuditArguments(["--upstream", "/tmp/pi", "--commit", "abc123"])).toThrow(
			"exactly 40 hexadecimal characters",
		);
		expect(
			parseAuditArguments(["--upstream", "/tmp/pi", "--commit", "A".repeat(40), "--manifest", "/tmp/manifest.json"]),
		).toEqual({
			help: false,
			upstreamPath: "/tmp/pi",
			commit: "a".repeat(40),
			manifestPath: "/tmp/manifest.json",
		});
	});

	it("returns a usage error without performing an audit", () => {
		const errors: string[] = [];
		const io: AuditCliIo = { log: () => undefined, error: (message) => errors.push(message) };
		expect(runAuditCli(["--commit", "0".repeat(40)], io, "/does/not/matter")).toBe(2);
		expect(errors.join("\n")).toContain("--upstream is required");
	});
});

describe("pi-ai parity manifest audit", () => {
	it("recomputes every digest without changing either checkout", () => {
		const fixture = createFixture();
		const localStatusBefore = git(fixture.root, ["status", "--porcelain"]);
		const upstreamStatusBefore = git(fixture.upstream, ["status", "--porcelain"]);

		const result = runFixtureAudit(fixture);

		expect(result).toMatchObject({ ok: true, upstreamFileCount: 2, mappingCount: 2, catalogFileCount: 4 });
		expect(result.issues).toEqual([]);
		expect(git(fixture.root, ["status", "--porcelain"])).toBe(localStatusBefore);
		expect(git(fixture.upstream, ["status", "--porcelain"])).toBe(upstreamStatusBefore);
	});

	it("fails when a mapped local file drifts", () => {
		const fixture = createFixture();
		write(join(fixture.root, "src/types.ts"), "export interface ToolResultMessage { changed: true }\n");

		const result = runFixtureAudit(fixture);

		expect(result.ok).toBe(false);
		expect(result.issues.map((entry) => entry.code)).toContain("mapping.local-digest");
		expect(result.issues.map((entry) => entry.code)).toContain("mapping.status");
	});

	it("keeps the recorded pre-change base valid after the parity work is committed", () => {
		const fixture = createFixture();
		git(fixture.root, ["commit", "--allow-empty", "--quiet", "-m", "advance fixture head"]);

		const result = runFixtureAudit(fixture);

		expect(result.ok).toBe(true);
		expect(result.issues).toEqual([]);
	});

	it("fails when the manifest omits a fixed upstream source file", () => {
		const fixture = createFixture();
		fixture.manifest.mappings = fixture.manifest.mappings.filter(
			(mapping) => mapping.upstreamPath !== "packages/ai/src/providers/fixture.ts",
		);
		write(fixture.manifestPath, `${JSON.stringify(fixture.manifest, null, 2)}\n`);

		const result = runFixtureAudit(fixture);

		expect(result.ok).toBe(false);
		expect(result.issues).toContainEqual(
			expect.objectContaining({ code: "mapping.missing", path: "packages/ai/src/providers/fixture.ts" }),
		);
	});

	it("fails closed when required decision evidence is missing", () => {
		const fixture = createFixture();
		fixture.manifest.decisions[0]!.evidence = ["tests/providers/missing-evidence.test.ts"];
		write(fixture.manifestPath, `${JSON.stringify(fixture.manifest, null, 2)}\n`);

		const result = runFixtureAudit(fixture);

		expect(result.ok).toBe(false);
		expect(result.issues).toContainEqual(expect.objectContaining({ code: "evidence.missing" }));
	});

	it("classifies the OAuth compatibility bridge separately from rejected coding-agent facades", () => {
		expect(classifyPiAiPath("packages/ai/src/compat/extension-oauth-types.ts")).toBe("auth-storage");
		expect(classifyPiAiPath("packages/ai/src/compat.ts")).toBe("coding-agent-only");
		expect(classifyPiAiPath("packages/ai/src/cli.ts")).toBe("coding-agent-only");
	});
});
