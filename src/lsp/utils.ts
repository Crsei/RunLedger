/** LSP 工具函数 —— URI 转换 / 语言 id 推断 / 符号列解析 / 偏移换算。 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Position } from "./types.ts";

export function fileToUri(filePath: string): string {
	return pathToFileURL(path.resolve(filePath)).href;
}

export function uriToFilePath(uri: string): string {
	const url = new URL(uri);
	if (url.protocol !== "file:") throw new Error(`Unsupported URI protocol: ${url.protocol}`);
	const windowsPath = /^\/[A-Za-z]:\//u.test(url.pathname) || (url.hostname.length > 0 && url.hostname !== "localhost");
	return fileURLToPath(url, { windows: windowsPath });
}

const EXTENSION_LANGUAGE_IDS: Record<string, string> = {
	".ts": "typescript", ".tsx": "typescriptreact", ".js": "javascript", ".jsx": "javascriptreact",
	".mjs": "javascript", ".cjs": "javascript", ".json": "json", ".jsonc": "jsonc",
	".py": "python", ".pyi": "python", ".rs": "rust", ".go": "go",
	".c": "c", ".h": "c", ".cpp": "cpp", ".hpp": "cpp", ".cc": "cpp", ".m": "objective-c", ".mm": "objective-cpp",
	".html": "html", ".htm": "html", ".css": "css", ".scss": "scss", ".less": "less",
	".vue": "vue", ".svelte": "svelte", ".astro": "astro",
	".yaml": "yaml", ".yml": "yaml", ".md": "markdown", ".markdown": "markdown",
	".sh": "shellscript", ".bash": "shellscript", ".zsh": "shellscript",
};

export function detectLanguageId(filePath: string): string {
	return EXTENSION_LANGUAGE_IDS[path.extname(filePath)] ?? "plaintext";
}

/**
 * 解析 line(1 起始)上 symbol 的列位置。
 * 精确匹配 → 忽略大小写匹配 → `name#N` 出现次选择器(N 从 1 计)。
 * 只扫描目标行;找不到 throw(不静默回退首列)。
 */
export function resolveSymbolColumn(filePath: string, line: number, symbol?: string): Position {
	const text = fs.readFileSync(filePath, "utf8");
	return resolveSymbolColumnInText(text, filePath, line, symbol);
}

/** 已由 governed filesystem 读取正文时使用，避免再次直读宿主文件系统。 */
export function resolveSymbolColumnInText(text: string, filePath: string, line: number, symbol?: string): Position {
	const lines = text.split("\n");
	if (line < 1 || line > lines.length) throw new Error(`line ${line} out of range in ${filePath}`);
	const target = lines[line - 1];
	if (target === undefined) throw new Error(`line ${line} out of range in ${filePath}`);
	if (!symbol) return { line: line - 1, character: target.length - target.trimStart().length };

	const hashIndex = symbol.lastIndexOf("#");
	const base = hashIndex > 0 ? symbol.slice(0, hashIndex) : symbol;
	const occurrence = hashIndex > 0 ? Number(symbol.slice(hashIndex + 1)) : 1;
	if (base.length === 0 || !Number.isInteger(occurrence) || occurrence < 1) {
		throw new Error(`invalid symbol occurrence selector: ${symbol}`);
	}

	let seen = 0;
	let index = target.indexOf(base);
	while (index !== -1) {
		seen += 1;
		if (seen === occurrence) return { line: line - 1, character: index };
		index = target.indexOf(base, index + base.length);
	}

	const lower = target.toLowerCase();
	const lowerBase = base.toLowerCase();
	let lowerIndex = lower.indexOf(lowerBase);
	let seenLower = 0;
	while (lowerIndex !== -1) {
		seenLower += 1;
		if (seenLower === occurrence) return { line: line - 1, character: lowerIndex };
		lowerIndex = lower.indexOf(lowerBase, lowerIndex + lowerBase.length);
	}
	throw new Error(`symbol "${base}" not found on line ${line} of ${filePath}`);
}

/** 文本偏移 → LSP 位置(0 起始行,UTF-16 码元列)。 */
export function positionAt(text: string, offset: number): Position {
	let line = 0;
	let character = 0;
	for (let i = 0; i < offset && i < text.length; i += 1) {
		if (text[i] === "\n") { line += 1; character = 0; }
		else character += 1;
	}
	return { line, character };
}

/** LSP 位置 → 文本偏移。 */
export function offsetAt(text: string, position: Position): number {
	const lines = text.split("\n");
	let offset = 0;
	for (let i = 0; i < position.line; i += 1) offset += (lines[i]?.length ?? 0) + 1;
	return offset + position.character;
}
