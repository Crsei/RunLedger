import type { RequestDump, RequestDumpMetadata, RequestDumpResult, RequestDumpView } from "./model-request-snapshots.ts";
import type { SessionDomainResult } from "./session-runtime/domain-router.ts";
import { runtimeDigest } from "./protocol/foundation.ts";

/** CLI/TUI 共用完整读取；失败时不输出半份正文，也不把不同快照拼在一起。 */
export async function readRequestDump(
	view: RequestDumpView,
	query: (payload: Record<string, unknown>) => Promise<SessionDomainResult>,
): Promise<RequestDumpResult> {
	let snapshotId: string | undefined;
	let offset = 0;
	let totalChars: number | undefined;
	let contentDigest: string | undefined;
	let metadata: RequestDumpMetadata | undefined;
	const chunks: string[] = [];
	try {
		for (;;) {
			const result = await query({ view, offset, ...(snapshotId === undefined ? {} : { snapshotId }) });
			if (!result.ok) return { ok: false, code: result.code };
			const page = result.value;
			if (typeof page.snapshotId !== "string" || typeof page.chunk !== "string"
				|| page.offset !== offset || typeof page.totalChars !== "number" || !Number.isSafeInteger(page.totalChars)
				|| page.totalChars < 0 || page.nextOffset !== offset + page.chunk.length || typeof page.complete !== "boolean"
				|| typeof page.contentDigest !== "string" || !isMetadata(page.metadata, view)
				|| (snapshotId !== undefined && (snapshotId !== page.snapshotId || totalChars !== page.totalChars || contentDigest !== page.contentDigest
					|| JSON.stringify(metadata) !== JSON.stringify(page.metadata)))) return { ok: false, code: "malformed_request_dump" };
			snapshotId = page.snapshotId;
			totalChars = page.totalChars;
			contentDigest = page.contentDigest;
			metadata = page.metadata;
			offset += page.chunk.length;
			if (offset > totalChars || page.complete !== (offset === totalChars) || (!page.complete && page.chunk.length === 0)) {
				return { ok: false, code: "malformed_request_dump" };
			}
			chunks.push(page.chunk);
			if (page.complete) {
				const dump: RequestDump = { content: chunks.join(""), metadata };
				if (runtimeDigest(dump.content).digest !== contentDigest) return { ok: false, code: "request_dump_digest_mismatch" };
				return { ok: true, dump };
			}
		}
	} catch {
		return { ok: false, code: "request_dump_read_failed" };
	}
}

function isMetadata(value: unknown, view: RequestDumpView): value is RequestDumpMetadata {
	if (typeof value !== "object" || value === null) return false;
	const meta = value as Record<string, unknown>;
	return meta.view === view && ["provider-input", "assembled-context", "base-prompt"].includes(String(meta.layer))
		&& (meta.mediaType === "application/json" || meta.mediaType === "text/plain")
		&& typeof meta.capturedAtMs === "number" && Number.isFinite(meta.capturedAtMs)
		&& ["assembled", "prepared", "response-received", "completed", "error", "aborted", "base"].includes(String(meta.state));
}

export function requestDumpErrorMessage(code: string): string {
	if (code === "provider_request_unavailable") return "No provider request captured in this owner lifetime. Send a message first; use /dump assembled or /dump base to inspect earlier layers.";
	if (code === "assembled_request_unavailable") return "No assembled request captured in this owner lifetime. Use /dump base to inspect the base prompt.";
	if (code === "provider_system_unavailable") return "The captured provider input has no supported system field. Use /dump to inspect the full request.";
	if (code === "request_dump_snapshot_expired") return "The export snapshot expired. Run /dump again.";
	return code;
}
