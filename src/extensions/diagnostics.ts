/** 扩展加载、校验和运行的唯一诊断事实源。 */

import type { ResourceId } from "../runtime/protocol/v3/ids.ts";

export type ExtensionDiagnosticSeverity = "info" | "warning" | "error";

export interface ExtensionDiagnostic {
	code: string;
	severity: ExtensionDiagnosticSeverity;
	message: string;
	source: string;
	path?: string;
	resourceId?: ResourceId;
	cause?: string;
}

export interface ExtensionLimits {
	maxAncestorDepth: number;
	maxDiscoveryDepth: number;
	maxFiles: number;
	maxFileBytes: number;
	maxDirectoryBytes: number;
	maxConfigBytes: number;
	maxSkillBodyBytes: number;
	maxSkillDescriptionChars: number;
	maxCatalogChars: number;
	maxHookInputBytes: number;
	maxStdoutBytes: number;
	maxStderrBytes: number;
	maxMcpResultBytes: number;
	maxConcurrentScans: number;
	maxConcurrentMcpStarts: number;
	maxDiagnostics: number;
}

export const DEFAULT_EXTENSION_LIMITS: Readonly<ExtensionLimits> = Object.freeze({
	maxAncestorDepth: 16,
	maxDiscoveryDepth: 8,
	maxFiles: 512,
	maxFileBytes: 256 * 1024,
	maxDirectoryBytes: 8 * 1024 * 1024,
	maxConfigBytes: 1024 * 1024,
	maxSkillBodyBytes: 1024 * 1024,
	maxSkillDescriptionChars: 1024,
	maxCatalogChars: 8_000,
	maxHookInputBytes: 256 * 1024,
	maxStdoutBytes: 64 * 1024,
	maxStderrBytes: 64 * 1024,
	maxMcpResultBytes: 256 * 1024,
	maxConcurrentScans: 8,
	maxConcurrentMcpStarts: 4,
	maxDiagnostics: 1_024,
});

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

export function sortExtensionDiagnostics(diagnostics: readonly ExtensionDiagnostic[]): ExtensionDiagnostic[] {
	return [...diagnostics].sort((left, right) => {
		const severity = severityRank[left.severity] - severityRank[right.severity];
		if (severity !== 0) return severity;
		return `${left.code}\u0000${left.path ?? ""}\u0000${left.resourceId ?? ""}\u0000${left.message}`.localeCompare(
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

/** 旧测试使用的兼容别名；新代码统一使用 DEFAULT_EXTENSION_LIMITS。 */
export const DEFAULT_EXTENSION_SCAN_LIMITS = DEFAULT_EXTENSION_LIMITS;
