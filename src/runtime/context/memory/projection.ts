/**
 * MEMORY.md projection —— approved MemoryRecord 的可重建人类可读投影。
 *
 * canonical truth 是 typed MemoryRecord + event receipt；本文件只生成
 * 只读文本投影，不承担 metadata 真源、不做双向解析、不写入 memory store。
 * 投影只包含 approved 且未过期/未撤销的 record，顺序按 memoryId 稳定排序。
 */

import { runtimeDigest } from "../../protocol/foundation.ts";
import type { MemoryRecord } from "./types.ts";

export interface MemoryProjectionInput {
	readonly records: readonly MemoryRecord[];
	readonly now?: number;
}

export interface MemoryProjection {
	readonly text: string;
	readonly digest: ReturnType<typeof runtimeDigest>;
	readonly recordCount: number;
}

const HEADER = "# RunLedger Memory\n\n> 只读投影：canonical truth 是 typed MemoryRecord 与事件 receipt。\n";

export function renderMemoryProjection(input: MemoryProjectionInput): MemoryProjection {
	const now = input.now ?? Date.now();
	const approved = [...input.records]
		.filter((record) =>
			record.trust === "approved" &&
			(record.expiresAt === undefined || Date.parse(record.expiresAt) > now) &&
			record.revocationRevision === 0,
		)
		.sort((left, right) => left.memoryId.localeCompare(right.memoryId));
	const sections: string[] = [HEADER];
	if (approved.length === 0) {
		sections.push("_No approved memory records._\n");
	} else {
		for (const record of approved) {
			const scopeLine = record.scope === "user"
				? "scope: user"
				: record.scope === "session"
					? `scope: session (${record.sessionId ?? "unknown"})`
					: `scope: workspace (${record.workspaceId ?? "unknown"})`;
			sections.push(`## ${record.title}`);
			sections.push(`- ${scopeLine}`);
			sections.push(`- memory: ${record.memoryId}`);
			sections.push(`- revision: ${record.revision}`);
			sections.push(`- content digest: ${record.contentDigest.digest}`);
			if (record.approvedAt !== undefined) sections.push(`- approved at: ${record.approvedAt}`);
			if (record.expiresAt !== undefined) sections.push(`- expires at: ${record.expiresAt}`);
			sections.push("");
		}
	}
	const text = `${sections.join("\n")}\n`;
	return {
		text,
		digest: runtimeDigest(text),
		recordCount: approved.length,
	};
}

/** 只读稳定排序 key —— 供投影与可重建 lexical index 复用。 */
export function memoryIndexKey(record: MemoryRecord): string {
	return record.memoryId;
}
