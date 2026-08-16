/**
 * 当前格式边界的静态检查。
 *
 * 第一方代码、测试和项目文档不得重新引入代际协议标记或数字 schema
 * 字段。provider/API 目录中的外部协议 URL、模型 ID 和上游资料属于明确
 * allowlist，不受本检查改写。
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative, resolve } from "node:path";

export interface CurrentFormatMarker {
	file: string;
	line: number;
	reason: string;
	text: string;
}

const SCAN_ROOTS = [
	"src",
	"tests",
	"examples",
	"README.md",
	"AGENTS.md",
	"docs",
	"development-doc",
] as const;

/** 外部协议/上游资料中的版本号是输入事实，不是 RunLedger 内部格式。 */
const EXTERNAL_VERSION_ALLOWLIST: readonly RegExp[] = [
	/^src\/(api|auth|providers)\//,
	/^src\/(models|image-models)\.generated\.ts$/,
	/^docs\/pi-architecture\.md$/,
	/^tests\/providers\//,
	/^development-doc\/providers\//,
	// 权威适配计划保留上游版本标签,不属于 RunLedger 运行时代际标记。
	/^development-doc\/plan\/04-lsp-server-adaptation-plan\.md$/,
];

const MARKER_PATTERNS: readonly [RegExp, string][] = [
	[/(?<!stateDiagram-)\b[vV][123]\b/g, "internal generation marker"],
	[/\bschemaVersion\b/g, "numeric schema field"],
	[/\bsessionV3\b/g, "generation feature flag"],
	[/\b(?:RuntimeEventV3|QueueItemV3)\b/g, "generation-specific identifier"],
	[/\bPRODUCTION_FEATURE_REQUIREMENTS_V1\b/g, "generation-specific identifier"],
	[/\b(?:protocol\/v3|runtime-v3)\b/g, "generation-specific path"],
];

function isAllowedExternalFile(relativePath: string): boolean {
	return EXTERNAL_VERSION_ALLOWLIST.some((pattern) => pattern.test(relativePath));
}

function listFiles(root: string): string[] {
	let stat;
	try {
		stat = statSync(root);
	} catch {
		return [];
	}
	if (stat.isFile()) return [root];
	return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
		if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".git") return [];
		const entryPath = join(root, entry.name);
		if (entry.isDirectory()) return listFiles(entryPath);
		return /\.(?:ts|tsx|js|json|md)$/u.test(entry.name) ? [entryPath] : [];
	});
}

export function scanCurrentFormatMarkers(repoRoot: string): CurrentFormatMarker[] {
	const violations: CurrentFormatMarker[] = [];
	for (const scanRoot of SCAN_ROOTS) {
		for (const filePath of listFiles(join(repoRoot, scanRoot))) {
			const relativePath = relative(repoRoot, filePath).replaceAll("\\", "/");
			if (isAllowedExternalFile(relativePath)) continue;
			const lines = readFileSync(filePath, "utf8").split(/\r?\n/u);
			for (let index = 0; index < lines.length; index += 1) {
				const line = lines[index] ?? "";
				for (const [pattern, reason] of MARKER_PATTERNS) {
					pattern.lastIndex = 0;
					if (pattern.test(line)) {
						violations.push({ file: relativePath, line: index + 1, reason, text: line.trim() });
					}
				}
			}
		}
	}
	return violations.sort((left, right) =>
		left.file.localeCompare(right.file) || left.line - right.line || left.reason.localeCompare(right.reason),
	);
}

function run(): void {
	const repoRoot = resolve(process.argv[2] ?? fileURLToPath(new URL("../", import.meta.url)));
	const violations = scanCurrentFormatMarkers(repoRoot);
	if (violations.length > 0) {
		for (const violation of violations) {
			console.error(`${violation.file}:${violation.line}: ${violation.reason}: ${violation.text}`);
		}
		process.exitCode = 1;
		return;
	}
	console.log("current format marker check passed");
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
	run();
}
