import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface BashAstSecurityBoundaryViolation {
	readonly file: string;
	readonly kind:
		| "duplicate-bash-access-resolver"
		| "ast-legacy-fallback"
		| "ast-failure-not-fail-closed"
		| "hardline-after-ast"
		| "raw-bash-telemetry"
		| "legacy-host-bash-ast";
}

function source(repoRoot: string, relative: string): string {
	return readFileSync(join(repoRoot, relative), "utf8");
}

function balancedBlockAfter(value: string, marker: string): string | undefined {
	const markerIndex = value.indexOf(marker);
	if (markerIndex < 0) return undefined;
	const start = value.indexOf("{", markerIndex + marker.length);
	if (start < 0) return undefined;
	let depth = 0;
	for (let index = start; index < value.length; index += 1) {
		if (value[index] === "{") depth += 1;
		if (value[index] !== "}") continue;
		depth -= 1;
		if (depth === 0) return value.slice(start, index + 1);
	}
	return undefined;
}

export function scanBashAstSecurityBoundaries(
	repoRoot: string,
): readonly BashAstSecurityBoundaryViolation[] {
	const violations: BashAstSecurityBoundaryViolation[] = [];
	const compositionFile = "src/security/session-composition.ts";
	const composition = source(repoRoot, compositionFile);
	if (
		!composition.includes("resolveToolAccessRequestsWithBashAnalyzer") ||
		composition.includes("function bashAccessRequests(")
	) {
		violations.push({ file: compositionFile, kind: "duplicate-bash-access-resolver" });
	}

	const resolverFile = "src/security/permission/access-resolver.ts";
	const resolver = source(repoRoot, resolverFile);
	const asyncResolver = resolver.slice(resolver.indexOf("resolveToolAccessRequestsWithBashAnalyzer"));
	if (asyncResolver.includes("analyzeShellCommand(")) {
		violations.push({ file: resolverFile, kind: "ast-legacy-fallback" });
	}

	const engineFile = "src/security/permission/engine.ts";
	const engine = source(repoRoot, engineFile);
	const hardlineIndex = engine.indexOf("hardlineShellDenialReason");
	const astIndex = engine.indexOf("analyzerMode === \"ast\"");
	if (hardlineIndex < 0 || astIndex < 0 || hardlineIndex > astIndex) {
		violations.push({ file: engineFile, kind: "hardline-after-ast" });
	}
	const failureBlock = balancedBlockAfter(engine, "request.bashAst?.kind !== \"simple\"");
	if (
		failureBlock === undefined ||
		!failureBlock.includes("builtin-shell-ast-failure") ||
		/action:\s*"allow"/u.test(failureBlock)
	) {
		violations.push({ file: engineFile, kind: "ast-failure-not-fail-closed" });
	}

	const classifierFile = "src/security/permission/bash-ast/classifier.ts";
	const classifier = source(repoRoot, classifierFile);
	const telemetryBlock = balancedBlockAfter(classifier, "telemetry?.record(");
	if (
		telemetryBlock === undefined ||
		/(?:rawCommand|argv|environment|\benv\b)\s*:/u.test(telemetryBlock) ||
		/(?:^|[,\n]\s*)command\s*:/u.test(telemetryBlock)
	) {
		violations.push({ file: classifierFile, kind: "raw-bash-telemetry" });
	}

	const legacyHostFile = "src/cli/runtime-host-security.ts";
	if (/bash-ast|BashSecurityAnalyzer/u.test(source(repoRoot, legacyHostFile))) {
		violations.push({ file: legacyHostFile, kind: "legacy-host-bash-ast" });
	}
	return violations;
}
