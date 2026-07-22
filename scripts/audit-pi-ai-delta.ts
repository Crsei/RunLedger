/**
 * 固定 pi-ai snapshot 与当前 RunLedger provider 层之间的只读一致性审计。
 *
 * 该脚本只读取显式传入的本地 Git checkout、manifest 与当前仓库文件。
 * 不执行 fetch/checkout，不更新 index，也不生成或覆盖任何文件。
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Type, type Static, type TSchema } from "typebox";
import { Check, Errors } from "typebox/value";

export const PI_AI_SOURCE_ROOT = "packages/ai/src";
export const PI_AI_PACKAGE_PATH = "packages/ai";
export const RUNLEDGER_SOURCE_ROOT = "src";
export const CATALOG_DIGEST_ALGORITHM = "sha256-path-digest-v1";

export const PI_AI_PARITY_CATEGORIES = [
	"provider-transport",
	"message-event",
	"auth-storage",
	"catalog-generator",
	"coding-agent-only",
] as const;

export const PI_AI_MAPPING_STATUSES = ["identical", "modified", "missing"] as const;
export const PI_AI_MAPPING_DECISIONS = ["adopt", "reject", "defer", "localize"] as const;
export const PI_AI_DIVERGENCE_DECISIONS = ["reject", "defer", "localize"] as const;
export const PI_AI_VERIFICATION_STATUSES = ["passed", "failed", "not-run"] as const;

export const KNOWN_PI_AI_DELTA_IDS = [
	"qwen-token-plan",
	"tool-result-usage",
	"openai-tool-call-identity",
	"stored-credential-env",
	"model-catalog-cache",
	"overflow-detection",
] as const;

export type PiAiParityCategory = (typeof PI_AI_PARITY_CATEGORIES)[number];
export type PiAiMappingStatus = (typeof PI_AI_MAPPING_STATUSES)[number];
export type PiAiMappingDecision = (typeof PI_AI_MAPPING_DECISIONS)[number];
export type KnownPiAiDeltaId = (typeof KNOWN_PI_AI_DELTA_IDS)[number];

const exact = <T extends Record<string, TSchema>>(properties: T) => Type.Object(properties, { additionalProperties: false });
const nonEmptyString = Type.String({ minLength: 1 });
const digestString = Type.String({ pattern: "^sha256:[0-9a-f]{64}$" });
const commitString = Type.String({ pattern: "^[0-9a-f]{40}$" });
const nonEmptyStrings = Type.Array(nonEmptyString, { minItems: 1, uniqueItems: true });
const evidenceStrings = Type.Array(nonEmptyString, { uniqueItems: true });

const categorySchema = Type.Union(PI_AI_PARITY_CATEGORIES.map((value) => Type.Literal(value)));
const mappingStatusSchema = Type.Union(PI_AI_MAPPING_STATUSES.map((value) => Type.Literal(value)));
const mappingDecisionSchema = Type.Union(PI_AI_MAPPING_DECISIONS.map((value) => Type.Literal(value)));
const divergenceDecisionSchema = Type.Union(PI_AI_DIVERGENCE_DECISIONS.map((value) => Type.Literal(value)));
const verificationStatusSchema = Type.Union(PI_AI_VERIFICATION_STATUSES.map((value) => Type.Literal(value)));
const knownDeltaIdSchema = Type.Union(KNOWN_PI_AI_DELTA_IDS.map((value) => Type.Literal(value)));

export const PiAiFileMappingSchema = exact({
	upstreamPath: nonEmptyString,
	localPath: Type.Union([nonEmptyString, Type.Null()]),
	upstreamDigest: digestString,
	localDigest: Type.Union([digestString, Type.Null()]),
	status: mappingStatusSchema,
	category: categorySchema,
	decision: mappingDecisionSchema,
	rationale: nonEmptyString,
	evidence: evidenceStrings,
});

export const PiAiAppliedDeltaSchema = exact({
	id: knownDeltaIdSchema,
	summary: nonEmptyString,
	upstreamPaths: nonEmptyStrings,
	localPaths: nonEmptyStrings,
	regressionTests: nonEmptyStrings,
});

export const PiAiDecisionSchema = exact({
	id: nonEmptyString,
	deltaId: Type.Optional(knownDeltaIdSchema),
	disposition: divergenceDecisionSchema,
	scope: nonEmptyStrings,
	reason: nonEmptyString,
	evidence: nonEmptyStrings,
});

export const PiAiCatalogFileSchema = exact({
	path: nonEmptyString,
	digest: digestString,
});

export const PiAiTransformationBehaviorSchema = exact({
	id: nonEmptyString,
	summary: nonEmptyString,
	evidence: nonEmptyStrings,
});

export const PiAiVerificationResultSchema = exact({
	command: nonEmptyString,
	status: verificationStatusSchema,
	summary: nonEmptyString,
});

export const PiAiParityManifestSchema = exact({
	schemaVersion: Type.Literal(1),
	upstream: exact({
		repository: nonEmptyString,
		commit: commitString,
		sourceRoot: Type.Literal(PI_AI_SOURCE_ROOT),
		packagePath: Type.Literal(PI_AI_PACKAGE_PATH),
	}),
	runLedger: exact({
		baseCommit: commitString,
		sourceRoot: Type.Literal(RUNLEDGER_SOURCE_ROOT),
	}),
	mappings: Type.Array(PiAiFileMappingSchema, { minItems: 1 }),
	appliedDeltas: Type.Array(PiAiAppliedDeltaSchema),
	decisions: Type.Array(PiAiDecisionSchema, { minItems: 1 }),
	catalog: exact({
		algorithm: Type.Literal(CATALOG_DIGEST_ALGORITHM),
		files: Type.Array(PiAiCatalogFileSchema, { minItems: 1 }),
		digest: digestString,
	}),
	messageEventTransformations: exact({
		summary: nonEmptyString,
		behaviors: Type.Array(PiAiTransformationBehaviorSchema, { minItems: 1 }),
	}),
	verification: exact({
		results: Type.Array(PiAiVerificationResultSchema, { minItems: 1 }),
	}),
	license: exact({
		upstreamFile: nonEmptyString,
		upstreamDigest: digestString,
		upstreamPackageSpdx: nonEmptyString,
		runLedgerPackageFile: nonEmptyString,
		runLedgerPackageSpdx: nonEmptyString,
		conclusion: nonEmptyString,
	}),
});

export type PiAiFileMapping = Static<typeof PiAiFileMappingSchema>;
export type PiAiAppliedDelta = Static<typeof PiAiAppliedDeltaSchema>;
export type PiAiDecision = Static<typeof PiAiDecisionSchema>;
export type PiAiCatalogFile = Static<typeof PiAiCatalogFileSchema>;
export type PiAiParityManifest = Static<typeof PiAiParityManifestSchema>;

export interface PiAiAuditIssue {
	code: string;
	path: string;
	message: string;
}

export interface PiAiAuditResult {
	ok: boolean;
	issues: PiAiAuditIssue[];
	upstreamFileCount: number;
	mappingCount: number;
	catalogFileCount: number;
}

export interface PiAiAuditOptions {
	repoRoot: string;
	manifestPath: string;
	upstreamPath: string;
	commit: string;
	gitRunner?: GitCommandRunner;
}

export interface GitCommandRunner {
	run(repositoryPath: string, args: readonly string[]): Buffer;
}

const ALLOWED_GIT_SUBCOMMANDS = new Set(["rev-parse", "ls-tree", "show"]);

export const localReadOnlyGitRunner: GitCommandRunner = {
	run(repositoryPath, args) {
		const subcommand = args[0];
		if (!subcommand || !ALLOWED_GIT_SUBCOMMANDS.has(subcommand)) {
			throw new Error(`disallowed git subcommand: ${subcommand ?? "<missing>"}`);
		}
		const result = spawnSync("git", [...args], {
			cwd: repositoryPath,
			encoding: null,
			maxBuffer: 64 * 1024 * 1024,
			shell: false,
		});
		if (result.error) throw result.error;
		if (result.status !== 0) {
			const stderr = Buffer.isBuffer(result.stderr) ? result.stderr.toString("utf8").trim() : "";
			throw new Error(stderr || `git ${subcommand} exited with ${result.status ?? "unknown status"}`);
		}
		return Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout ?? "");
	},
};

export function sha256Digest(content: string | Buffer): string {
	return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

export function classifyPiAiPath(upstreamPath: string): PiAiParityCategory {
	const relativePath = upstreamPath.startsWith(`${PI_AI_SOURCE_ROOT}/`)
		? upstreamPath.slice(PI_AI_SOURCE_ROOT.length + 1)
		: upstreamPath;
	if (
		relativePath === "cli.ts" ||
		relativePath === "compat.ts" ||
		relativePath === "env-api-keys.ts" ||
		relativePath === "legacy-api-aliases.ts"
	) {
		return "coding-agent-only";
	}
	if (
		relativePath === "types.ts" ||
		relativePath === "utils/event-stream.ts" ||
		relativePath === "api/transform-messages.ts"
	) {
		return "message-event";
	}
	if (
		relativePath.startsWith("auth/") ||
		relativePath === "compat/extension-oauth-types.ts" ||
		relativePath === "oauth.ts" ||
		relativePath === "bun-oauth.ts" ||
		relativePath === "utils/provider-env.ts"
	) {
		return "auth-storage";
	}
	if (
		relativePath === "models.ts" ||
		relativePath === "models-store.ts" ||
		relativePath === "models.generated.ts" ||
		relativePath === "image-models.ts" ||
		relativePath === "image-models.generated.ts" ||
		relativePath === "images-models.ts" ||
		relativePath === "images.ts" ||
		relativePath === "images-api-registry.ts" ||
		relativePath === "providers/data-json.d.ts" ||
		/^providers\/[^/]+\.models\.ts$/.test(relativePath)
	) {
		return "catalog-generator";
	}
	return "provider-transport";
}

export function discoverGeneratedCatalogPaths(repoRoot: string): string[] {
	const providerRoot = resolve(repoRoot, "src/providers");
	const dataRoot = resolve(providerRoot, "data");
	const providerFiles = existsSync(providerRoot)
		? readdirSync(providerRoot, { withFileTypes: true })
				.filter((entry) => entry.isFile() && entry.name.endsWith(".models.ts"))
				.map((entry) => `src/providers/${entry.name}`)
		: [];
	const dataFiles = existsSync(dataRoot)
		? readdirSync(dataRoot, { withFileTypes: true })
				.filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
				.map((entry) => `src/providers/data/${entry.name}`)
		: [];
	return ["src/image-models.generated.ts", "src/models.generated.ts", ...providerFiles, ...dataFiles].sort((left, right) =>
		left.localeCompare(right),
	);
}

export function computeCatalogFiles(repoRoot: string): PiAiCatalogFile[] {
	return discoverGeneratedCatalogPaths(repoRoot).map((path) => ({
		path,
		digest: sha256Digest(readFileSync(resolve(repoRoot, path))),
	}));
}

export function computeCatalogDigest(files: readonly PiAiCatalogFile[]): string {
	const canonical = [...files]
		.sort((left, right) => left.path.localeCompare(right.path))
		.map((file) => `${file.path}\0${file.digest}\n`)
		.join("");
	return sha256Digest(canonical);
}

function issue(issues: PiAiAuditIssue[], code: string, path: string, message: string): void {
	issues.push({ code, path, message });
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function canonicalRelativePath(path: string): boolean {
	return (
		path.length > 0 &&
		!isAbsolute(path) &&
		!path.includes("\\") &&
		!path.split("/").some((part) => part === "" || part === "." || part === "..")
	);
}

function resolveLocalFile(repoRoot: string, path: string): string | undefined {
	if (!canonicalRelativePath(path)) return undefined;
	const root = realpathSync(repoRoot);
	const candidate = resolve(root, path);
	if (!existsSync(candidate)) return undefined;
	const realCandidate = realpathSync(candidate);
	const relativePath = relative(root, realCandidate);
	if (relativePath === "" || relativePath.startsWith("..") || isAbsolute(relativePath)) return undefined;
	return realCandidate;
}

function gitText(runner: GitCommandRunner, repositoryPath: string, args: readonly string[]): string {
	return runner.run(repositoryPath, args).toString("utf8").trimEnd();
}

function readManifest(manifestPath: string, issues: PiAiAuditIssue[]): PiAiParityManifest | undefined {
	let value: unknown;
	try {
		value = JSON.parse(readFileSync(manifestPath, "utf8")) as unknown;
	} catch (error) {
		issue(issues, "manifest.read", "manifest", errorMessage(error));
		return undefined;
	}
	if (!Check(PiAiParityManifestSchema, value)) {
		for (const schemaError of Errors(PiAiParityManifestSchema, value)) {
			issue(
				issues,
				"manifest.schema",
				`manifest${schemaError.instancePath || ""}`,
				schemaError.message,
			);
		}
		return undefined;
	}
	return value as PiAiParityManifest;
}

function validateUnique(values: readonly string[], code: string, path: string, issues: PiAiAuditIssue[]): void {
	const seen = new Set<string>();
	for (const value of values) {
		if (seen.has(value)) issue(issues, code, path, `duplicate value: ${value}`);
		seen.add(value);
	}
}

function validateSorted(values: readonly string[], code: string, path: string, issues: PiAiAuditIssue[]): void {
	const sorted = [...values].sort((left, right) => left.localeCompare(right));
	if (values.some((value, index) => value !== sorted[index])) {
		issue(issues, code, path, "entries must be sorted lexicographically");
	}
}

function validateLocalReference(
	repoRoot: string,
	path: string,
	issuePath: string,
	issues: PiAiAuditIssue[],
	requiredPrefix?: string,
): void {
	if (!canonicalRelativePath(path) || (requiredPrefix && !path.startsWith(requiredPrefix))) {
		issue(issues, "evidence.local-path", issuePath, `invalid local path: ${path}`);
		return;
	}
	if (!resolveLocalFile(repoRoot, path)) issue(issues, "evidence.missing", issuePath, `missing local evidence: ${path}`);
}

function validateUpstreamReference(
	runner: GitCommandRunner,
	upstreamPath: string,
	commit: string,
	path: string,
	issuePath: string,
	issues: PiAiAuditIssue[],
	cache: Map<string, Buffer>,
): void {
	if (!canonicalRelativePath(path)) {
		issue(issues, "evidence.upstream-path", issuePath, `invalid upstream path: ${path}`);
		return;
	}
	if (cache.has(path)) return;
	try {
		cache.set(path, runner.run(upstreamPath, ["show", `${commit}:${path}`]));
	} catch (error) {
		issue(issues, "evidence.missing", issuePath, `missing upstream evidence ${path}: ${errorMessage(error)}`);
	}
}

function validateEvidenceReference(
	runner: GitCommandRunner,
	repoRoot: string,
	upstreamPath: string,
	commit: string,
	reference: string,
	issuePath: string,
	issues: PiAiAuditIssue[],
	cache: Map<string, Buffer>,
): void {
	if (reference.startsWith("upstream:")) {
		validateUpstreamReference(runner, upstreamPath, commit, reference.slice("upstream:".length), issuePath, issues, cache);
		return;
	}
	const localPath = reference.startsWith("local:") ? reference.slice("local:".length) : reference;
	validateLocalReference(repoRoot, localPath, issuePath, issues);
}

function parsePackageLicense(content: Buffer, issuePath: string, issues: PiAiAuditIssue[]): string | undefined {
	try {
		const value = JSON.parse(content.toString("utf8")) as unknown;
		if (typeof value === "object" && value !== null && "license" in value && typeof value.license === "string") {
			return value.license;
		}
		issue(issues, "license.package", issuePath, "package.json must contain a string license field");
	} catch (error) {
		issue(issues, "license.package", issuePath, errorMessage(error));
	}
	return undefined;
}

function sortedIssues(issues: PiAiAuditIssue[]): PiAiAuditIssue[] {
	return issues.sort(
		(left, right) =>
			left.path.localeCompare(right.path) || left.code.localeCompare(right.code) || left.message.localeCompare(right.message),
	);
}

export function auditPiAiDelta(options: PiAiAuditOptions): PiAiAuditResult {
	const issues: PiAiAuditIssue[] = [];
	const commit = options.commit.toLowerCase();
	if (!/^[0-9a-f]{40}$/.test(commit)) {
		issue(issues, "argument.commit", "--commit", "commit must be exactly 40 hexadecimal characters");
		return { ok: false, issues, upstreamFileCount: 0, mappingCount: 0, catalogFileCount: 0 };
	}

	let repoRoot: string;
	let upstreamPath: string;
	try {
		repoRoot = realpathSync(options.repoRoot);
	} catch (error) {
		issue(issues, "repository.local", "repoRoot", errorMessage(error));
		return { ok: false, issues, upstreamFileCount: 0, mappingCount: 0, catalogFileCount: 0 };
	}
	try {
		upstreamPath = realpathSync(options.upstreamPath);
	} catch (error) {
		issue(issues, "repository.upstream", "--upstream", errorMessage(error));
		return { ok: false, issues, upstreamFileCount: 0, mappingCount: 0, catalogFileCount: 0 };
	}

	const runner = options.gitRunner ?? localReadOnlyGitRunner;
	try {
		const localTopLevel = realpathSync(gitText(runner, repoRoot, ["rev-parse", "--show-toplevel"]));
		if (localTopLevel !== repoRoot) issue(issues, "repository.local-root", "repoRoot", `expected Git root ${localTopLevel}`);
		const upstreamTopLevel = realpathSync(gitText(runner, upstreamPath, ["rev-parse", "--show-toplevel"]));
		if (upstreamTopLevel !== upstreamPath) {
			issue(issues, "repository.upstream-root", "--upstream", `pass the Git root explicitly: ${upstreamTopLevel}`);
		}
		const resolvedCommit = gitText(runner, upstreamPath, ["rev-parse", "--verify", `${commit}^{commit}`]).toLowerCase();
		if (resolvedCommit !== commit) issue(issues, "upstream.commit", "--commit", `resolved to ${resolvedCommit}`);
	} catch (error) {
		issue(issues, "repository.git", "--upstream", errorMessage(error));
		return { ok: false, issues: sortedIssues(issues), upstreamFileCount: 0, mappingCount: 0, catalogFileCount: 0 };
	}

	const manifest = readManifest(options.manifestPath, issues);
	if (!manifest) {
		return { ok: false, issues: sortedIssues(issues), upstreamFileCount: 0, mappingCount: 0, catalogFileCount: 0 };
	}

	if (manifest.upstream.commit !== commit) {
		issue(issues, "manifest.commit", "manifest/upstream/commit", `expected ${commit}, found ${manifest.upstream.commit}`);
	}
	if (manifest.upstream.sourceRoot !== PI_AI_SOURCE_ROOT || manifest.upstream.packagePath !== PI_AI_PACKAGE_PATH) {
		issue(issues, "manifest.upstream-layout", "manifest/upstream", "unexpected pi-ai source/package layout");
	}
	if (manifest.runLedger.sourceRoot !== RUNLEDGER_SOURCE_ROOT) {
		issue(issues, "manifest.local-layout", "manifest/runLedger/sourceRoot", `expected ${RUNLEDGER_SOURCE_ROOT}`);
	}
	try {
		const baseCommit = gitText(runner, repoRoot, [
			"rev-parse",
			"--verify",
			`${manifest.runLedger.baseCommit}^{commit}`,
		]).toLowerCase();
		if (baseCommit !== manifest.runLedger.baseCommit) {
			issue(issues, "manifest.base-commit", "manifest/runLedger/baseCommit", `resolved to ${baseCommit}`);
		}
	} catch (error) {
		issue(issues, "manifest.base-commit", "manifest/runLedger/baseCommit", errorMessage(error));
	}

	let upstreamFiles: string[] = [];
	try {
		upstreamFiles = gitText(runner, upstreamPath, ["ls-tree", "-r", "--name-only", commit, "--", PI_AI_SOURCE_ROOT])
			.split("\n")
			.filter((path) => path.length > 0)
			.sort((left, right) => left.localeCompare(right));
	} catch (error) {
		issue(issues, "upstream.tree", PI_AI_SOURCE_ROOT, errorMessage(error));
	}
	if (upstreamFiles.length === 0) issue(issues, "upstream.tree", PI_AI_SOURCE_ROOT, "source tree is empty");

	const mappingPaths = manifest.mappings.map((mapping) => mapping.upstreamPath);
	validateUnique(mappingPaths, "mapping.duplicate", "manifest/mappings", issues);
	validateSorted(mappingPaths, "mapping.order", "manifest/mappings", issues);
	const mappingPathSet = new Set(mappingPaths);
	const upstreamPathSet = new Set(upstreamFiles);
	for (const path of upstreamFiles) {
		if (!mappingPathSet.has(path)) issue(issues, "mapping.missing", path, "upstream source file has no manifest mapping");
	}
	for (const path of mappingPaths) {
		if (!upstreamPathSet.has(path)) issue(issues, "mapping.extra", path, "mapping does not exist in fixed upstream source tree");
	}

	const upstreamCache = new Map<string, Buffer>();
	const localPaths = manifest.mappings.flatMap((mapping) => (mapping.localPath ? [mapping.localPath] : []));
	validateUnique(localPaths, "mapping.local-duplicate", "manifest/mappings", issues);

	for (const [index, mapping] of manifest.mappings.entries()) {
		const mappingIssuePath = `manifest/mappings/${index}`;
		if (!canonicalRelativePath(mapping.upstreamPath) || !mapping.upstreamPath.startsWith(`${PI_AI_SOURCE_ROOT}/`)) {
			issue(issues, "mapping.upstream-path", mappingIssuePath, `invalid upstream path: ${mapping.upstreamPath}`);
			continue;
		}
		let upstreamContent: Buffer | undefined;
		try {
			upstreamContent = runner.run(upstreamPath, ["show", `${commit}:${mapping.upstreamPath}`]);
			upstreamCache.set(mapping.upstreamPath, upstreamContent);
		} catch (error) {
			issue(issues, "mapping.upstream-read", mapping.upstreamPath, errorMessage(error));
		}
		if (upstreamContent) {
			const upstreamDigest = sha256Digest(upstreamContent);
			if (mapping.upstreamDigest !== upstreamDigest) {
				issue(issues, "mapping.upstream-digest", mapping.upstreamPath, `expected ${upstreamDigest}, found ${mapping.upstreamDigest}`);
			}
		}
		const category = classifyPiAiPath(mapping.upstreamPath);
		if (mapping.category !== category) {
			issue(issues, "mapping.category", mapping.upstreamPath, `expected ${category}, found ${mapping.category}`);
		}

		if (mapping.localPath === null) {
			if (mapping.localDigest !== null) issue(issues, "mapping.local-digest", mapping.upstreamPath, "missing mapping must use null localDigest");
			if (mapping.status !== "missing") issue(issues, "mapping.status", mapping.upstreamPath, "null localPath must use missing status");
			if (mapping.decision !== "reject" && mapping.decision !== "defer") {
				issue(issues, "mapping.decision", mapping.upstreamPath, "missing mapping must be explicitly rejected or deferred");
			}
		} else {
			if (!mapping.localPath.startsWith(`${RUNLEDGER_SOURCE_ROOT}/`)) {
				issue(issues, "mapping.local-path", mapping.upstreamPath, `local mapping must remain under src/: ${mapping.localPath}`);
			}
			const localFile = resolveLocalFile(repoRoot, mapping.localPath);
			if (!localFile) {
				issue(issues, "mapping.local-read", mapping.localPath, "mapped local file is missing or escapes the repository");
			} else if (upstreamContent) {
				const localDigest = sha256Digest(readFileSync(localFile));
				const observedStatus: PiAiMappingStatus = localDigest === sha256Digest(upstreamContent) ? "identical" : "modified";
				if (mapping.localDigest !== localDigest) {
					issue(issues, "mapping.local-digest", mapping.localPath, `expected ${localDigest}, found ${mapping.localDigest ?? "null"}`);
				}
				if (mapping.status !== observedStatus) {
					issue(issues, "mapping.status", mapping.upstreamPath, `expected ${observedStatus}, found ${mapping.status}`);
				}
				if (observedStatus === "identical" && mapping.decision !== "adopt") {
					issue(issues, "mapping.decision", mapping.upstreamPath, "byte-identical mapping must use adopt");
				}
			}
			if (mapping.decision === "reject") {
				issue(issues, "mapping.decision", mapping.upstreamPath, "an existing local mapping cannot use reject");
			}
		}

		if ((mapping.status !== "identical" || mapping.decision !== "adopt") && mapping.evidence.length === 0) {
			issue(issues, "mapping.evidence", mapping.upstreamPath, "intentional divergence requires evidence");
		}
		for (const reference of mapping.evidence) {
			validateEvidenceReference(
				runner,
				repoRoot,
				upstreamPath,
				commit,
				reference,
				`${mappingIssuePath}/evidence`,
				issues,
				upstreamCache,
			);
		}
	}

	const decisionIds = manifest.decisions.map((decision) => decision.id);
	validateUnique(decisionIds, "decision.duplicate", "manifest/decisions", issues);
	for (const [index, decision] of manifest.decisions.entries()) {
		const decisionPath = `manifest/decisions/${index}`;
		for (const scope of decision.scope) {
			if (scope.startsWith("packages/")) {
				validateUpstreamReference(runner, upstreamPath, commit, scope, `${decisionPath}/scope`, issues, upstreamCache);
			} else {
				validateLocalReference(repoRoot, scope, `${decisionPath}/scope`, issues);
			}
		}
		for (const reference of decision.evidence) {
			validateEvidenceReference(
				runner,
				repoRoot,
				upstreamPath,
				commit,
				reference,
				`${decisionPath}/evidence`,
				issues,
				upstreamCache,
			);
		}
	}
	for (const mapping of manifest.mappings) {
		if (mapping.decision === "adopt") continue;
		const covered = manifest.decisions.some(
			(decision) => decision.disposition === mapping.decision && decision.scope.includes(mapping.upstreamPath),
		);
		if (!covered) {
			issue(
				issues,
				"decision.missing",
				mapping.upstreamPath,
				`${mapping.decision} mapping is not covered by a matching top-level decision`,
			);
		}
	}

	const appliedDeltaIds = manifest.appliedDeltas.map((delta) => delta.id);
	validateUnique(appliedDeltaIds, "delta.duplicate", "manifest/appliedDeltas", issues);
	for (const [index, delta] of manifest.appliedDeltas.entries()) {
		const deltaPath = `manifest/appliedDeltas/${index}`;
		for (const path of delta.upstreamPaths) {
			validateUpstreamReference(runner, upstreamPath, commit, path, `${deltaPath}/upstreamPaths`, issues, upstreamCache);
		}
		for (const path of delta.localPaths) validateLocalReference(repoRoot, path, `${deltaPath}/localPaths`, issues);
		for (const path of delta.regressionTests) {
			validateLocalReference(repoRoot, path, `${deltaPath}/regressionTests`, issues, "tests/");
		}
	}
	const coveredDeltaIds = new Set<KnownPiAiDeltaId>(appliedDeltaIds);
	for (const decision of manifest.decisions) {
		if (decision.deltaId) coveredDeltaIds.add(decision.deltaId);
	}
	for (const deltaId of KNOWN_PI_AI_DELTA_IDS) {
		if (!coveredDeltaIds.has(deltaId)) issue(issues, "delta.missing", deltaId, "known upstream delta has no applied or divergence decision");
	}

	let observedCatalogFiles: PiAiCatalogFile[] = [];
	try {
		observedCatalogFiles = computeCatalogFiles(repoRoot);
	} catch (error) {
		issue(issues, "catalog.read", "manifest/catalog", errorMessage(error));
	}
	const catalogPaths = manifest.catalog.files.map((file) => file.path);
	validateUnique(catalogPaths, "catalog.duplicate", "manifest/catalog/files", issues);
	validateSorted(catalogPaths, "catalog.order", "manifest/catalog/files", issues);
	const observedCatalogMap = new Map(observedCatalogFiles.map((file) => [file.path, file.digest]));
	const manifestCatalogMap = new Map(manifest.catalog.files.map((file) => [file.path, file.digest]));
	for (const file of observedCatalogFiles) {
		const manifestDigest = manifestCatalogMap.get(file.path);
		if (!manifestDigest) issue(issues, "catalog.missing", file.path, "generated catalog file is absent from manifest");
		else if (manifestDigest !== file.digest) issue(issues, "catalog.file-digest", file.path, `expected ${file.digest}, found ${manifestDigest}`);
	}
	for (const file of manifest.catalog.files) {
		if (!observedCatalogMap.has(file.path)) issue(issues, "catalog.extra", file.path, "manifest catalog file is not a generator output");
	}
	if (observedCatalogFiles.length > 0) {
		const catalogDigest = computeCatalogDigest(observedCatalogFiles);
		if (manifest.catalog.digest !== catalogDigest) {
			issue(issues, "catalog.digest", "manifest/catalog/digest", `expected ${catalogDigest}, found ${manifest.catalog.digest}`);
		}
	}

	const transformationIds = manifest.messageEventTransformations.behaviors.map((behavior) => behavior.id);
	validateUnique(transformationIds, "transformation.duplicate", "manifest/messageEventTransformations/behaviors", issues);
	for (const [index, behavior] of manifest.messageEventTransformations.behaviors.entries()) {
		for (const reference of behavior.evidence) {
			validateEvidenceReference(
				runner,
				repoRoot,
				upstreamPath,
				commit,
				reference,
				`manifest/messageEventTransformations/behaviors/${index}/evidence`,
				issues,
				upstreamCache,
			);
		}
	}

	const verificationCommands = manifest.verification.results.map((result) => result.command);
	validateUnique(verificationCommands, "verification.duplicate", "manifest/verification/results", issues);
	for (const [index, result] of manifest.verification.results.entries()) {
		if (result.status !== "passed") {
			issue(issues, "verification.incomplete", `manifest/verification/results/${index}`, `${result.command}: ${result.status}`);
		}
	}
	for (const command of ["npm run check", "npm test", "npm run build", "git diff --check"]) {
		if (!verificationCommands.includes(command)) {
			issue(issues, "verification.missing", "manifest/verification/results", `missing required verification command: ${command}`);
		}
	}
	if (!verificationCommands.some((command) => /(?:vitest|npm test).*(?:providers|pi-ai)/i.test(command))) {
		issue(issues, "verification.missing", "manifest/verification/results", "missing focused provider/parity test command");
	}

	try {
		if (!canonicalRelativePath(manifest.license.upstreamFile)) {
			issue(issues, "license.path", "manifest/license/upstreamFile", "invalid upstream license path");
		} else {
			const licenseContent = runner.run(upstreamPath, ["show", `${commit}:${manifest.license.upstreamFile}`]);
			const licenseDigest = sha256Digest(licenseContent);
			if (manifest.license.upstreamDigest !== licenseDigest) {
				issue(issues, "license.digest", "manifest/license/upstreamDigest", `expected ${licenseDigest}, found ${manifest.license.upstreamDigest}`);
			}
			if (!licenseContent.toString("utf8").includes("MIT License")) {
				issue(issues, "license.text", "manifest/license/upstreamFile", "upstream license is not recognizable as MIT");
			}
		}
		const upstreamPackageContent = runner.run(upstreamPath, [
			"show",
			`${commit}:${manifest.upstream.packagePath}/package.json`,
		]);
		const upstreamSpdx = parsePackageLicense(upstreamPackageContent, "upstream package.json", issues);
		if (upstreamSpdx && upstreamSpdx !== manifest.license.upstreamPackageSpdx) {
			issue(issues, "license.spdx", "manifest/license/upstreamPackageSpdx", `expected ${upstreamSpdx}`);
		}
		if (manifest.license.runLedgerPackageFile !== "package.json") {
			issue(issues, "license.path", "manifest/license/runLedgerPackageFile", "expected package.json");
		} else {
			const localPackage = resolveLocalFile(repoRoot, manifest.license.runLedgerPackageFile);
			if (!localPackage) issue(issues, "license.path", "manifest/license/runLedgerPackageFile", "missing local package.json");
			else {
				const localSpdx = parsePackageLicense(readFileSync(localPackage), "local package.json", issues);
				if (localSpdx && localSpdx !== manifest.license.runLedgerPackageSpdx) {
					issue(issues, "license.spdx", "manifest/license/runLedgerPackageSpdx", `expected ${localSpdx}`);
				}
			}
		}
		if (manifest.license.upstreamPackageSpdx !== "MIT" || manifest.license.runLedgerPackageSpdx !== "MIT") {
			issue(issues, "license.conclusion", "manifest/license", "both package licenses must explicitly resolve to MIT");
		}
	} catch (error) {
		issue(issues, "license.read", "manifest/license", errorMessage(error));
	}

	const finalIssues = sortedIssues(issues);
	return {
		ok: finalIssues.length === 0,
		issues: finalIssues,
		upstreamFileCount: upstreamFiles.length,
		mappingCount: manifest.mappings.length,
		catalogFileCount: observedCatalogFiles.length,
	};
}

export interface ParsedAuditArguments {
	help: boolean;
	upstreamPath?: string;
	commit?: string;
	manifestPath?: string;
}

export function parseAuditArguments(argv: readonly string[]): ParsedAuditArguments {
	if (argv.includes("--help") || argv.includes("-h")) return { help: true };
	let upstreamPath: string | undefined;
	let commit: string | undefined;
	let manifestPath: string | undefined;
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		if (argument !== "--upstream" && argument !== "--commit" && argument !== "--manifest") {
			throw new Error(`unknown argument: ${argument ?? "<missing>"}`);
		}
		const value = argv[index + 1];
		if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value`);
		index += 1;
		if (argument === "--upstream") {
			if (upstreamPath) throw new Error("--upstream may only be provided once");
			upstreamPath = value;
		} else if (argument === "--commit") {
			if (commit) throw new Error("--commit may only be provided once");
			commit = value.toLowerCase();
		} else {
			if (manifestPath) throw new Error("--manifest may only be provided once");
			manifestPath = value;
		}
	}
	if (!upstreamPath) throw new Error("--upstream is required");
	if (!commit) throw new Error("--commit is required");
	if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error("--commit must be exactly 40 hexadecimal characters");
	return { help: false, upstreamPath, commit, manifestPath };
}

export interface AuditCliIo {
	log(message: string): void;
	error(message: string): void;
}

export const AUDIT_USAGE =
	"Usage: node --experimental-strip-types scripts/audit-pi-ai-delta.ts --upstream <local-pi-checkout> --commit <40-hex> [--manifest <path>]";

export function runAuditCli(
	argv: readonly string[],
	io: AuditCliIo = console,
	repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), ".."),
): number {
	let parsed: ParsedAuditArguments;
	try {
		parsed = parseAuditArguments(argv);
	} catch (error) {
		io.error(errorMessage(error));
		io.error(AUDIT_USAGE);
		return 2;
	}
	if (parsed.help) {
		io.log(AUDIT_USAGE);
		return 0;
	}
	const upstreamPath = parsed.upstreamPath;
	const commit = parsed.commit;
	if (!upstreamPath || !commit) {
		io.error("internal argument validation failure");
		return 2;
	}
	const result = auditPiAiDelta({
		repoRoot,
		manifestPath: resolve(parsed.manifestPath ?? resolve(repoRoot, "development-doc/providers/pi-ai-parity-manifest.json")),
		upstreamPath: resolve(upstreamPath),
		commit,
	});
	if (!result.ok) {
		for (const auditIssue of result.issues) {
			io.error(`${auditIssue.code} ${auditIssue.path}: ${auditIssue.message}`);
		}
		io.error(`pi-ai parity audit failed with ${result.issues.length} issue(s)`);
		return 1;
	}
	io.log(
		`pi-ai parity audit passed (${result.mappingCount}/${result.upstreamFileCount} upstream files, ${result.catalogFileCount} catalog files)`,
	);
	return 0;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (invokedPath === resolve(fileURLToPath(import.meta.url))) {
	process.exitCode = runAuditCli(process.argv.slice(2));
}
