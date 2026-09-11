/**
 * `/dump` 侧车 JSON 的 CLI 组合层实现。
 *
 * TUI 不持有 layout/fs（`interactive-mode.ts` 的既有边界），因此写盘端口在
 * 组合层构造，目录固定为 `RunledgerLayout.tmp/dump`。权限与原子写次序对齐
 * `src/storage/tui-preferences.ts`：0700 目录 → 拒 symlink → realpath 包含性
 * 检查 → `wx`+0600 临时文件 → rename → chmod。
 */

import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { RUNLEDGER_DIRECTORY_MODE, RUNLEDGER_FILE_MODE, type RunledgerLayout } from "../runtime/contracts/storage-layout.ts";
import type { PromptDumpDocument, PromptDumpPort } from "../tui/interactive/types.ts";

const DIRECTORY_NAME = "dump";

export function createCliPromptDumpPort(layout: RunledgerLayout): PromptDumpPort {
	return {
		write: async (document) => {
			const directory = join(layout.tmp, DIRECTORY_NAME);
			const temporary: string[] = [];
			const published: string[] = [];
			let complete = false;
			try {
				await mkdir(directory, { recursive: true, mode: RUNLEDGER_DIRECTORY_MODE });
				const directoryStat = await lstat(directory);
				if (directoryStat.isSymbolicLink()) return { ok: false, code: "prompt_dump_directory_symlink" };
				const canonicalDirectory = await realpath(directory);
				const canonicalHome = await realpath(layout.home);
				if (canonicalDirectory !== join(canonicalHome, "tmp", DIRECTORY_NAME)) {
					return { ok: false, code: "prompt_dump_directory_escapes_home" };
				}
				await chmod(directory, RUNLEDGER_DIRECTORY_MODE);
				const stem = `request-dump-${fileSafeSegment(document.sessionId)}-${Date.now()}-${randomUUID()}`;
				const target = join(directory, `${stem}.${document.metadata.mediaType === "text/plain" ? "txt" : "json"}`);
				const metadataPath = join(directory, `${stem}.metadata.json`);
				const metadata = JSON.stringify({ kind: document.kind, sessionId: document.sessionId, exportedAtMs: Date.now(),
					...document.metadata, contentSha256: createHash("sha256").update(document.content, "utf8").digest("hex"),
					contentBytes: Buffer.byteLength(document.content, "utf8") }, null, 2);
				for (const [path, content] of [[target, document.content], [metadataPath, metadata]] as const) {
					const pending = join(directory, `.request-dump.${randomUUID()}.tmp`);
					temporary.push(pending);
					await writeFile(pending, content, { flag: "wx", mode: RUNLEDGER_FILE_MODE });
					await rename(pending, path);
					published.push(path);
					await chmod(path, RUNLEDGER_FILE_MODE);
				}
				complete = true;
				return { ok: true, path: target, metadataPath };
			} catch {
				return { ok: false, code: "prompt_dump_write_failed" };
			} finally {
				for (const path of [...temporary, ...(complete ? [] : published)]) await unlink(path).catch(() => undefined);
			}
		},
	};
}

/** session id 进文件名前收敛为安全片段，避免路径分隔符与超长名。 */
function fileSafeSegment(value: string): string {
	const safe = value.replace(/[^A-Za-z0-9._-]/gu, "_").slice(0, 64);
	return safe.length === 0 ? "session" : safe;
}
