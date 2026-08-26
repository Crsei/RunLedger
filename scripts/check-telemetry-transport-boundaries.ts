/** 检查 production telemetry channel literal 必须存在于 M1 transport inventory。 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import {
	LOCAL_TELEMETRY_INSTRUMENTATION_EVIDENCE,
	LOCAL_TELEMETRY_TRANSPORTS,
	createProductionTransportCoverageRegistry,
	type LocalTelemetryInstrumentationEvidence,
} from "../src/runtime/telemetry/local/coverage.ts";

const CHANNEL_LITERAL = /(?:channel|telemetryChannel)\s*:\s*["']([^"']+)["']/gu;

function files(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const full = join(dir, name);
		return statSync(full).isDirectory() ? files(full) : full.endsWith(".ts") ? [full] : [];
	});
}

const TELEMETRY_BOUNDARY_PATHS = [
	"src/runtime/telemetry/local",
	"src/runtime/execution-env.ts",
	"src/runtime/tools/web-fetch.ts",
	"src/extensions/mcp/sdk-factory.ts",
	"src/utils/provider-fetch-context.ts",
	"src/utils/fetch-provider-proxy.ts",
	"src/api/openai-codex-responses.ts",
] as const;

export function findTelemetryTransportBoundaryViolations(repoRoot = resolve(".")): readonly string[] {
	const known = new Set<string>(LOCAL_TELEMETRY_TRANSPORTS);
	const violations: string[] = [];
	const scanFiles = TELEMETRY_BOUNDARY_PATHS.flatMap((path) => {
		const full = join(repoRoot, path);
		return statSync(full).isDirectory() ? files(full) : [full];
	});
	for (const file of scanFiles) {
		const source = readFileSync(file, "utf8");
		for (const match of source.matchAll(CHANNEL_LITERAL)) {
			const value = match[1];
			if (value !== undefined && !known.has(value)) violations.push(`${relative(repoRoot, file)}: ${value}`);
		}
	}
	return [...violations, ...findTelemetryInstrumentationViolations(repoRoot)];
}

export function findTelemetryInstrumentationViolations(
	repoRoot = resolve("."),
	evidence: readonly LocalTelemetryInstrumentationEvidence[] = LOCAL_TELEMETRY_INSTRUMENTATION_EVIDENCE,
): readonly string[] {
	const registry = createProductionTransportCoverageRegistry();
	const violations: string[] = [];
	for (const item of evidence) {
		if (registry.get(item.transport)?.state !== "measured") continue;
		const filePath = join(repoRoot, item.file);
		let source: string;
		try {
			source = readFileSync(filePath, "utf8");
		} catch {
			violations.push(`${item.file}: ${item.transport} is declared measured but evidence file is unavailable`);
			continue;
		}
		if (!source.includes(item.marker)) {
			violations.push(`${item.file}: ${item.transport} is declared measured but marker ${item.marker} is missing`);
		}
	}
	if (evidence === LOCAL_TELEMETRY_INSTRUMENTATION_EVIDENCE) {
		for (const entry of registry.snapshot()) {
			if (entry.state === "measured" && !evidence.some((item) => item.transport === entry.transport)) {
				violations.push(`${entry.transport}: declared measured without instrumentation evidence`);
			}
		}
	}
	return violations;
}

function main(): void {
	const violations = findTelemetryTransportBoundaryViolations();
	if (violations.length > 0) {
		for (const violation of violations) console.error(`[telemetry-transport-boundary] undeclared ${violation}`);
		process.exitCode = 1;
		return;
	}
	console.log("telemetry transport boundary check passed");
}

if (process.argv[1]?.endsWith("check-telemetry-transport-boundaries.ts")) main();
