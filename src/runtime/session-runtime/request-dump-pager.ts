import { REQUEST_DUMP_VIEWS, type RequestDump, type RequestDumpResult, type RequestDumpView } from "../model-request-snapshots.ts";
import { runtimeDigest } from "../protocol/foundation.ts";

// UTF-16 单位；即使每字符 JSON 转义为六字节也低于协议单帧预算。
export const REQUEST_DUMP_CHUNK_CHARS = 16 * 1024;
const MAX_PINNED_EXPORTS = 4;

/** 分页绑定同一份正文与元数据；后续请求更新不会改变正在读取的导出。 */
export class RequestDumpPager {
	private readonly exports = new Map<string, { dump: RequestDump; contentDigest: string }>();
	private readonly inspect: (view: RequestDumpView) => RequestDumpResult;

	constructor(inspect: (view: RequestDumpView) => RequestDumpResult) {
		this.inspect = inspect;
	}

	read(payload: Record<string, unknown>): { ok: true; value: Record<string, unknown> } | { ok: false; code: string } {
		const view = payload.view ?? "request";
		const offset = payload.offset ?? 0;
		if (!REQUEST_DUMP_VIEWS.includes(view as RequestDumpView) || typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0) {
			return { ok: false, code: "invalid_request_dump_page" };
		}
		if (payload.snapshotId !== undefined && typeof payload.snapshotId !== "string") return { ok: false, code: "invalid_request_dump_page" };
		let snapshotId = payload.snapshotId as string | undefined;
		let entry: { dump: RequestDump; contentDigest: string } | undefined;
		if (snapshotId === undefined) {
			if (offset !== 0) return { ok: false, code: "request_dump_snapshot_required" };
			const result = this.inspect(view as RequestDumpView);
			if (!result.ok) return result;
			const dump: RequestDump = { content: result.dump.content, metadata: Object.freeze({ ...result.dump.metadata }) };
			entry = { dump, contentDigest: runtimeDigest(dump.content).digest };
			snapshotId = runtimeDigest({ contentDigest: entry.contentDigest, metadata: dump.metadata }).digest;
			this.exports.delete(snapshotId);
			this.exports.set(snapshotId, entry);
			while (this.exports.size > MAX_PINNED_EXPORTS) this.exports.delete(this.exports.keys().next().value!);
		} else entry = this.exports.get(snapshotId);
		if (entry === undefined) return { ok: false, code: "request_dump_snapshot_expired" };
		const { dump, contentDigest } = entry;
		if (dump.metadata.view !== view || offset > dump.content.length) return { ok: false, code: "invalid_request_dump_page" };
		const chunk = dump.content.slice(offset, offset + REQUEST_DUMP_CHUNK_CHARS);
		const nextOffset = offset + chunk.length;
		return { ok: true, value: { snapshotId, offset, nextOffset, totalChars: dump.content.length,
			complete: nextOffset === dump.content.length, chunk, metadata: dump.metadata,
			contentDigest } };
	}
}
