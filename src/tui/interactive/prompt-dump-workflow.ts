import { REQUEST_DUMP_VIEWS, type RequestDumpView } from "../../runtime/model-request-snapshots.ts";
import { readRequestDump, requestDumpErrorMessage } from "../../runtime/request-dump-reader.ts";
import { querySessionController } from "../adapters/session-domain.ts";
import { TranscriptOverlayComponent } from "../transcript-view.ts";
import type { InteractiveModePorts } from "./types.ts";

/** 原始正文交给文件和剪贴板；终端预览是独立的安全投影。 */
export class PromptDumpWorkflow {
	private readonly port: InteractiveModePorts;

	public constructor(port: InteractiveModePorts) {
		this.port = port;
	}

	public async run(arg: string): Promise<void> {
		const port = this.port;
		const view = arg.trim() || "request";
		if (!REQUEST_DUMP_VIEWS.includes(view as RequestDumpView)) {
			port.showNotice("Usage: /dump [request|system|assembled|base]", "error");
			return;
		}
		const sessionId = port.getSessionId();
		const controller = port.controller;
		const correlationId = `corr-${port.nextCorrelationId()}`;
		const result = await readRequestDump(view as RequestDumpView, (payload) => querySessionController(
			controller, "session.request.inspect", payload, { correlationId, effectId: `effect-${port.nextEffectId()}` },
		));
		if (port.quitting || port.getSessionId() !== sessionId || port.controller !== controller) return;
		if (!result.ok) {
			port.showNotice(`/dump: ${requestDumpErrorMessage(result.code)}`, "error");
			return;
		}
		const { content, metadata } = result.dump;
		// 大请求完整导出；预览有明确边界，避免阻塞终端布局。
		const previewLimit = 64 * 1024;
		const preview = sanitizeForTerminal(content.slice(0, previewLimit));
		const previewHint = content.length > previewLimit ? " · preview limited to 64 Ki characters; file contains full content" : "";
		port.showOverlayModal(new TranscriptOverlayComponent({
			rows: [{ id: "request-dump", kind: "text", content: preview }],
			timelineGeneration: 0, committedRevision: "request-dump", activeRevision: "request-dump", themeGeneration: 0,
		}, {
			title: sanitizeForTerminal(`Dump ${view} · ${metadata.model ?? metadata.layer} · ${metadata.state}`),
			closeHint: `Read-only preview${previewHint} · Esc close`,
			getViewportHeight: () => Math.max(4, port.ui.terminal.rows - 2), theme: port.theme, onClose: () => port.closeOverlay(),
		}), { anchor: "center", variant: "transcript" }, "transcript");
		let copied = false;
		try { copied = port.writeClipboard?.(content) ?? false; } catch { /* 文件出口仍可用。 */ }
		let written = "File: unavailable in this composition.";
		if (port.promptDumpPort !== undefined) {
			const saved = await port.promptDumpPort.write({ kind: "runledger.request-dump", sessionId, ...result.dump })
				.catch(() => ({ ok: false as const, code: "request_dump_write_failed" }));
			written = saved.ok ? `File: ${saved.path}${saved.metadataPath === undefined ? "" : `\nMetadata: ${saved.metadataPath}`}` : `File: not written (${saved.code}).`;
		}
		if (port.quitting || port.getSessionId() !== sessionId || port.controller !== controller) return;
		port.showNotice(sanitizeForTerminal([
			`/dump ${view}: ${metadata.layer} · ${metadata.state} · ${Buffer.byteLength(content, "utf8")} B`,
			`Request: ${metadata.requestId ?? "none"} · Captured: ${new Date(metadata.capturedAtMs).toISOString()}`,
			...(metadata.latestAttemptId !== undefined && metadata.latestAttemptId !== metadata.requestId
				? [`Latest attempt: ${metadata.latestAttemptId} · ${metadata.latestAttemptState ?? "unknown"}; it has no captured provider input.`] : []),
			copied ? "Clipboard: raw content written as OSC 52 (terminal support varies)." : "Clipboard: unavailable; use the exported file.",
			written,
		].join("\n")), "note");
	}
}

export function sanitizeForTerminal(text: string): string {
	return text.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/gu, "\uFFFD");
}
