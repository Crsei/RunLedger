/**
 * Extension 扫描诊断与资源预算。
 *
 * TODO(extension-M0/M1): 将错误码与 Runtime resource contract 对齐，补充未知
 * schemaVersion、secret template、symlink escape 和 diagnostic redaction 测试。
 */

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

export interface ExtensionScanLimits {
	maxDepth: number;
	maxFiles: number;
	maxFileBytes: number;
	maxContextChars: number;
	maxStdoutBytes: number;
	maxStderrBytes: number;
}

export const DEFAULT_EXTENSION_SCAN_LIMITS: Readonly<ExtensionScanLimits> = {
	maxDepth: 8,
	maxFiles: 512,
	maxFileBytes: 256 * 1024,
	maxContextChars: 32_000,
	maxStdoutBytes: 64 * 1024,
	maxStderrBytes: 64 * 1024,
};

export function extensionDiagnostic(
	code: string,
	severity: ExtensionDiagnosticSeverity,
	message: string,
	source: string,
	path?: string,
): ExtensionDiagnostic {
	return { code, severity, message, source, ...(path ? { path } : {}) };
}

export function sortExtensionDiagnostics(diagnostics: readonly ExtensionDiagnostic[]): ExtensionDiagnostic[] {
	return [...diagnostics].sort((left, right) =>
		`${left.severity}:${left.code}:${left.path ?? ""}:${left.message}`.localeCompare(
			`${right.severity}:${right.code}:${right.path ?? ""}:${right.message}`,
		),
	);
}
