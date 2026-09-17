/**
 * `read` 的归档分支。
 *
 * 对应上游 `tools/read-archive.ts`（194 行）。解码器是 `src/websource/internal/ar/**`
 * （自 oh-my-pi `packages/utils/src/ar/**` 移植，纯 TS）。
 *
 * 与上游的差异：
 * - 上游直接 `openArchive(path)`（内部用 `Bun.file` 读盘）；这里要求调用方先经
 *   governed fs 读入字节，本模块只处理内存字节，不触碰文件系统；
 * - 上游的「后缀名模糊匹配」（`findSuffixMatchCached`）依赖全仓文件索引，属另一
 *   子系统，本移植不做：只按字面路径判定；
 * - 上游把行选择器的应用放在内部（`buildInMemorySelectorResult`）；这里只产出
 *   正文，行选择器由 `read.ts` 既有的同一套管线统一施加。
 */

import {
	type ArchiveReader,
	archiveFormatFromPath,
	formatArchiveEntryLines,
	openArchive,
	parseArchivePathCandidates,
	sniffArchiveFormat,
} from "../../websource/internal/ar/index.ts";
import { ArchiveError } from "../../websource/internal/ar/error.ts";

/** 单成员可读出的最大字节数（超出即视为二进制/过大，给出提示而不是硬塞给模型）。 */
const MAX_MEMBER_BYTES = 1_000_000;

export interface ArchiveReadTarget {
	/** 归档文件自身的路径（未解析的原始形式，交给调用方按 cwd 解析）。 */
	readonly archivePath: string;
	/** `:` 之后的成员路径；空串表示归档根。 */
	readonly subPath: string;
}

export interface ArchiveReadResult {
	readonly text: string;
	/** 产生方式：目录清单 / 成员正文 / 二进制提示。 */
	readonly method: "archive-list" | "archive-member" | "archive-binary";
}

/**
 * 判定 `rawPath` 是否是归档读取，并切出「归档文件」与「成员路径」。
 *
 * 复用上游 `parseArchivePathCandidates` 的切分规则：以归档扩展名为界，其后的
 * `:sub/path` 为成员路径。这同时解决了 `read.ts` 的选择器歧义——`a.zip:inner`
 * 必须在行选择器解析**之前**判定，否则 `inner` 会被当成选择器语法。
 *
 * 返回 `null` 表示不是归档读取（调用方继续走文本路径）。
 */
export function parseArchiveReadTarget(rawPath: string): ArchiveReadTarget | null {
	for (const candidate of parseArchivePathCandidates(rawPath)) {
		if (archiveFormatFromPath(candidate.archivePath) === undefined) continue;
		// `archivePath === rawPath` 时 subPath 恒为空（上游同款判断）。
		return { archivePath: candidate.archivePath, subPath: candidate.archivePath === rawPath ? "" : candidate.subPath };
	}
	return null;
}

/**
 * 字节是否是受支持的归档容器。
 *
 * 与 `parseArchiveReadTarget` 的「路径形状」判定配对使用：形状命中但嗅探失败时
 * 调用方回落到文本路径，避免把一个恰好叫 `x.zip` 的文本文件当作归档报错。
 */
export function looksLikeArchiveBytes(bytes: Uint8Array): boolean {
	return sniffArchiveFormatSafe(bytes) !== undefined;
}

/**
 * 渲染归档内容。
 *
 * `bytes` 由调用方经 governed fs 读入；`subPath` 为空时列根目录。
 */
export async function readArchiveBytes(bytes: Uint8Array, subPath: string): Promise<ArchiveReadResult> {
	const format = sniffFormat(bytes);
	const archive = await openArchive({ bytes, format });

	if (subPath.length === 0) return { text: renderListing(archive, ""), method: "archive-list" };

	const node = archive.getNode(subPath);
	if (node === undefined) {
		throw new ArchiveError(`Path '${subPath}' not found inside archive`);
	}
	if (node.isDirectory) return { text: renderListing(archive, subPath), method: "archive-list" };

	if (node.size > MAX_MEMBER_BYTES) {
		return {
			text: `[归档成员 '${subPath}' 为 ${node.size} 字节，超过单成员上限 ${MAX_MEMBER_BYTES}；请用 bash 解出后再读]`,
			method: "archive-binary",
		};
	}
	const entry = await archive.readFile(subPath);
	const text = decodeUtf8(entry.bytes);
	if (text === undefined) {
		return {
			text: `[归档成员 '${subPath}' 不是文本（${entry.bytes.byteLength} 字节），未内联]`,
			method: "archive-binary",
		};
	}
	return { text, method: "archive-member" };
}

/** 按内容嗅探格式；`openArchive` 需要显式 format（本移植不允许传路径让它自行推导）。 */
function sniffFormat(bytes: Uint8Array) {
	const format = sniffArchiveFormatSafe(bytes);
	if (format !== undefined) return format;
	throw new ArchiveError("Unsupported or unrecognized archive format");
}

function sniffArchiveFormatSafe(bytes: Uint8Array) {
	try {
		return sniffArchiveFormat(bytes);
	} catch {
		return undefined;
	}
}

function renderListing(archive: ArchiveReader, subPath: string): string {
	const entries = listEntries(archive, subPath);
	const lines = formatArchiveEntryLines(entries);
	return lines.length > 0 ? lines.join("\n") : "(empty archive directory)";
}

function listEntries(archive: ArchiveReader, subPath: string) {
	const prefix = subPath.length === 0 ? "" : `${subPath.replace(/\/+$/u, "")}/`;
	const seen = new Map<string, { readonly name: string; readonly path: string; readonly isDirectory: boolean; readonly size: number }>();
	for (const entry of archive.indexEntries()) {
		if (entry.path === subPath || entry.path.length === 0) continue;
		if (!entry.path.startsWith(prefix)) continue;
		const rest = entry.path.slice(prefix.length);
		if (rest.length === 0) continue;
		const slash = rest.indexOf("/");
		const name = slash === -1 ? rest : `${rest.slice(0, slash)}/`;
		if (seen.has(name)) continue;
		seen.set(name, {
			name,
			path: slash === -1 ? entry.path : `${prefix}${rest.slice(0, slash)}`,
			isDirectory: slash !== -1 || entry.isDirectory,
			size: slash === -1 && !entry.isDirectory ? entry.size : 0,
		});
	}
	return [...seen.values()].sort((left, right) => left.name.localeCompare(right.name));
}

/** UTF-8 严格解码；含 NUL 或非法序列时返回 `undefined`（表示非文本）。 */
function decodeUtf8(bytes: Uint8Array): string | undefined {
	if (bytes.includes(0)) return undefined;
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		return undefined;
	}
}
