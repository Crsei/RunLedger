/** 扩展扫描、解析与信任复核共用的有界诊断。 */

import type { ResourceId } from "../runtime/protocol/ids.ts";

export type ExtensionDiagnosticSeverity = "info" | "warning" | "error";

export interface ExtensionDiagnostic {
	readonly code: string;
	readonly severity: ExtensionDiagnosticSeverity;
	readonly message: string;
	readonly source: string;
	readonly path?: string;
	readonly resourceId?: ResourceId;
	readonly cause?: string;
}

export interface ExtensionScanLimits {
	readonly maxDepth: number;
	readonly maxAncestorDepth: number;
	readonly maxDiscoveryDepth: number;
	readonly maxFiles: number;
	readonly maxEntries: number;
	readonly maxFileBytes: number;
	readonly maxDirectoryBytes: number;
	readonly maxSkillBodyBytes: number;
	readonly maxDescriptionChars: number;
	readonly maxContextChars: number;
	readonly maxCatalogChars: number;
	readonly maxStdoutBytes: number;
	readonly maxStderrBytes: number;
	readonly maxConcurrentScans: number;
	readonly maxDiagnostics: number;
}

export const DEFAULT_EXTENSION_LIMITS: Readonly<ExtensionScanLimits> = Object.freeze({
	maxDepth: 8,
	maxAncestorDepth: 16,
	maxDiscoveryDepth: 8,
	maxFiles: 512,
	maxEntries: 1_024,
	maxFileBytes: 256 * 1024,
	maxDirectoryBytes: 8 * 1024 * 1024,
	maxSkillBodyBytes: 1024 * 1024,
	maxDescriptionChars: 1_024,
	maxContextChars: 32_000,
	maxCatalogChars: 8_000,
	maxStdoutBytes: 64 * 1024,
	maxStderrBytes: 64 * 1024,
	maxConcurrentScans: 8,
	maxDiagnostics: 1_024,
});

export const DEFAULT_EXTENSION_SCAN_LIMITS = DEFAULT_EXTENSION_LIMITS;

export function extensionDiagnostic(input: ExtensionDiagnostic): ExtensionDiagnostic;
export function extensionDiagnostic(
	code: string,
	severity: ExtensionDiagnosticSeverity,
	message: string,
	source: string,
	path?: string,
): ExtensionDiagnostic;

export function extensionDiagnostic(
	inputOrCode: ExtensionDiagnostic | string,
	severity?: ExtensionDiagnosticSeverity,
	message?: string,
	source?: string,
	path?: string,
): ExtensionDiagnostic {
	if (typeof inputOrCode !== "string") return { ...inputOrCode };
	return {
		code: inputOrCode,
		severity: severity ?? "error",
		message: message ?? inputOrCode,
		source: source ?? "extensions",
		...(path ? { path } : {}),
	};
}

const severityRank: Readonly<Record<ExtensionDiagnosticSeverity, number>> = {
	error: 0,
	warning: 1,
	info: 2,
};

function compareText(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

export function sortExtensionDiagnostics(diagnostics: readonly ExtensionDiagnostic[]): ExtensionDiagnostic[] {
	return [...diagnostics].sort((left, right) => {
		const severity = severityRank[left.severity] - severityRank[right.severity];
		if (severity !== 0) return severity;
		return compareText(
			`${left.code}\u0000${left.path ?? ""}\u0000${left.resourceId ?? ""}\u0000${left.message}`,
			`${right.code}\u0000${right.path ?? ""}\u0000${right.resourceId ?? ""}\u0000${right.message}`,
		);
	});
}

const SECRET_PATTERN = /(authorization|bearer|token|password|secret|api[-_]?key|cookie)/giu;

export function redactDiagnosticText(value: string, knownSecrets: readonly string[] = []): string {
	let result = value.replace(SECRET_PATTERN, "[redacted-key]");
	for (const secret of knownSecrets) {
		if (secret.length >= 4) result = result.split(secret).join("[redacted]");
	}
	return result.slice(0, 2_048);
}

export function boundDiagnostics(
	diagnostics: readonly ExtensionDiagnostic[],
	limit = DEFAULT_EXTENSION_LIMITS.maxDiagnostics,
): ExtensionDiagnostic[] {
	if (limit <= 0) return [];
	const sorted = sortExtensionDiagnostics(diagnostics);
	if (sorted.length <= limit) return sorted;
	return [
		...sorted.slice(0, Math.max(0, limit - 1)),
		extensionDiagnostic({
			code: "extensions.diagnostics_truncated",
			severity: "warning",
			message: `${sorted.length - limit + 1} additional diagnostics were omitted`,
			source: "extensions",
		}),
	];
}
