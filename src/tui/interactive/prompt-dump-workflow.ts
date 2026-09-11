/**
 * `/dump`：把 assembler 之后的 provider 面系统提示词与工具交给用户。
 *
 * 只读：一次 `session.prompt.inspect` 查询 + 本地渲染；不写 ledger、不改
 * session 事件、不要求 driver。overlay 是主输出，剪贴板与侧车 JSON 是
 * 可选的第二、第三通道（端口缺失或写失败时降级，不影响 overlay）。
 *
 * 显示与复制走终端清洗（控制字符替换），侧车 JSON 保留原始文本。
 */

import type { PromptInspection } from "../../runtime/types.ts";
import type { RuntimeDigest } from "../../runtime/protocol/foundation.ts";
import { querySessionController } from "../adapters/session-domain.ts";
import { unavailableCommandMessage } from "../commands/registry.ts";
import { TranscriptOverlayComponent, type TranscriptOverlayView } from "../transcript-view.ts";
import type { InteractiveModePorts, PromptDumpDocument } from "./types.ts";

export class PromptDumpWorkflow {
	private readonly port: InteractiveModePorts;

	public constructor(port: InteractiveModePorts) {
		this.port = port;
	}

	public async run(arg: string): Promise<void> {
		const port = this.port;
		if (arg.trim().length > 0) {
			port.showNotice("Usage: /dump", "error");
			return;
		}
		const effectId = port.nextEffectId();
		const correlationId = port.nextCorrelationId();
		const result = await querySessionController(port.controller, "session.prompt.inspect", {}, {
			correlationId: `corr-${correlationId}`,
			effectId: `effect-${effectId}`,
		}).catch((error: unknown) => {
			port.showNotice(`/dump failed: ${String(error)}`, "error");
			return undefined;
		});
		if (result === undefined) return;
		if (!result.ok) {
			port.showNotice(result.code === "operation_unavailable"
				? unavailableCommandMessage("/dump")
				: `/dump failed: ${result.code === "prompt_inspect_too_large"
					? "the assembled prompt exceeds the single-frame budget; read it from the session trace artifact instead"
					: result.code}`, "error");
			return;
		}
		const inspection = parsePromptInspection(result.value);
		if (inspection === undefined) {
			port.showNotice("/dump failed: session.prompt.inspect returned a malformed result", "error");
			return;
		}
		const selection = inspection.selection;
		const header: PromptDumpHeader = {
			harnessProfile: port.harnessProfile === undefined ? undefined : `harness ${port.harnessProfile.id}@${port.harnessProfile.version}`,
			permissionProfile: port.permissionProfile,
			provider: selection?.provider,
			model: selection?.model,
			thinkingLevel: selection?.thinkingLevel,
		};
		const text = renderPromptDumpText(inspection, header);
		port.showOverlayModal(makePromptDumpOverlay(text, header, port), { anchor: "center", variant: "transcript" }, "transcript");
		const copied = port.writeClipboard?.(text) ?? false;
		const written = await writeSidecar(port, inspection, header);
		port.showNotice([
			`/dump: ${inspection.source === "assembled" ? `assembled at turn ${inspection.turn ?? "?"}` : "base prompt (no turn yet)"} · ${formatBytes(Buffer.byteLength(text, "utf8"))}`,
			copied ? "Clipboard: OSC 52 sequence written (terminal support varies)." : "Clipboard: unavailable in this terminal; read the overlay or the JSON path.",
			written,
		].join("\n"), "note");
	}
}

export interface PromptDumpHeader {
	readonly harnessProfile?: string;
	readonly permissionProfile?: string;
	readonly provider?: string;
	readonly model?: string;
	readonly thinkingLevel?: string;
}

/** domain 结果 → typed inspection；字段缺失或类型不符时返回 undefined（不猜测）。 */
export function parsePromptInspection(value: Record<string, unknown>): PromptInspection | undefined {
	const systemPrompt = value.systemPrompt;
	const source = value.source;
	if (typeof systemPrompt !== "string" || (source !== "assembled" && source !== "base")) return undefined;
	const digest = parseDigest(value.assembledPromptDigest);
	if (digest === undefined) return undefined;
	const tools = Array.isArray(value.tools)
		? value.tools.flatMap((entry) => {
			if (typeof entry !== "object" || entry === null) return [];
			const record = entry as Record<string, unknown>;
			if (typeof record.name !== "string" || typeof record.description !== "string") return [];
			return [{ name: record.name, description: record.description, parameters: record.parameters }];
		})
		: [];
	const selection = parsePromptSelection(value.selection);
	const basePromptDigest = parseDigest(value.basePromptDigest);
	const compositionDigest = parseDigest(value.compositionDigest);
	return {
		systemPrompt,
		tools,
		...(selection === undefined ? {} : { selection }),
		source,
		...(typeof value.turn === "number" ? { turn: value.turn } : {}),
		...(typeof value.capturedAtMs === "number" ? { capturedAtMs: value.capturedAtMs } : {}),
		assembledPromptDigest: digest,
		...(basePromptDigest === undefined ? {} : { basePromptDigest }),
		...(compositionDigest === undefined ? {} : { compositionDigest }),
	};
}

function parsePromptSelection(value: unknown): PromptInspection["selection"] {
	if (typeof value !== "object" || value === null) return undefined;
	const record = value as Record<string, unknown>;
	if (typeof record.thinkingLevel !== "string") return undefined;
	if (record.provider !== undefined && typeof record.provider !== "string") return undefined;
	if (record.model !== undefined && typeof record.model !== "string") return undefined;
	return {
		...(typeof record.provider === "string" ? { provider: record.provider } : {}),
		...(typeof record.model === "string" ? { model: record.model } : {}),
		thinkingLevel: record.thinkingLevel,
	};
}

function parseDigest(value: unknown): RuntimeDigest | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const record = value as Record<string, unknown>;
	if (record.algorithm !== "sha256" || typeof record.digest !== "string" || record.digest.length === 0) return undefined;
	return { algorithm: "sha256", digest: record.digest as RuntimeDigest["digest"] };
}

/** 终端安全清洗：保留换行与制表符，其余控制字符替换为替代字符。 */
export function sanitizeForTerminal(text: string): string {
	return text.replace(/[\x00-\x08\x0b-\x1f\x7f]/gu, "\uFFFD");
}

export function renderPromptDumpText(inspection: PromptInspection, header: PromptDumpHeader): string {
	const lines: string[] = ["## System Prompt", "", sanitizeForTerminal(inspection.systemPrompt), "", "## Configuration", ""];
	if (header.harnessProfile !== undefined) lines.push(`Harness: ${header.harnessProfile}`);
	if (header.permissionProfile !== undefined) lines.push(`Current permissions: ${header.permissionProfile}`);
	lines.push(`Provider: ${header.provider ?? "(none)"}`);
	lines.push(`Model: ${header.model ?? "(none)"}`);
	lines.push(`Thinking: ${header.thinkingLevel ?? "unknown"}`);
	lines.push(`Prompt source: ${inspection.source}${inspection.turn === undefined ? "" : ` · turn ${inspection.turn}`}`);
	if (inspection.capturedAtMs !== undefined) lines.push(`Captured: ${new Date(inspection.capturedAtMs).toISOString()}`);
	lines.push(`Assembled digest: ${shortDigest(inspection.assembledPromptDigest)}`);
	if (inspection.basePromptDigest !== undefined) lines.push(`Base prompt digest: ${shortDigest(inspection.basePromptDigest)}`);
	if (inspection.compositionDigest !== undefined) lines.push(`Harness composition digest: ${shortDigest(inspection.compositionDigest)}`);
	lines.push("", `## Tools (${inspection.tools.length})`);
	if (inspection.tools.length === 0) {
		lines.push("", "(no tools were part of this request)");
	} else {
		lines.push("");
		for (const tool of inspection.tools) {
			lines.push(`- ${tool.name}${tool.description.length === 0 ? "" : ` — ${sanitizeForTerminal(tool.description)}`}`);
		}
	}
	return lines.join("\n");
}

function makePromptDumpOverlay(text: string, header: PromptDumpHeader, port: InteractiveModePorts): TranscriptOverlayComponent {
	const view: TranscriptOverlayView = {
		rows: [{ id: "prompt-dump", kind: "text", content: text }],
		timelineGeneration: 0,
		committedRevision: "prompt-dump",
		activeRevision: "prompt-dump",
		themeGeneration: 0,
	};
	return new TranscriptOverlayComponent(view, {
		title: `Prompt dump · ${header.model ?? "no model"}`,
		closeHint: "Read-only prompt dump · Esc close",
		getViewportHeight: () => Math.max(4, port.ui.terminal.rows - 2),
		theme: port.theme,
		onClose: () => port.closeOverlay(),
	});
}

async function writeSidecar(port: InteractiveModePorts, inspection: PromptInspection, header: PromptDumpHeader): Promise<string> {
	if (port.promptDumpPort === undefined) return "JSON: no dump port in this composition.";
	const document: PromptDumpDocument = {
		kind: "runledger.prompt-dump",
		sessionId: port.getSessionId(),
		capturedAtMs: Date.now(),
		...(port.harnessProfile === undefined ? {} : { harnessProfile: { id: port.harnessProfile.id, version: port.harnessProfile.version } }),
		...(port.permissionProfile === undefined ? {} : { permissionProfile: port.permissionProfile }),
		selection: {
			...(header.provider === undefined ? {} : { provider: header.provider }),
			...(header.model === undefined ? {} : { model: header.model }),
			thinkingLevel: header.thinkingLevel ?? "unknown",
		},
		prompt: inspection,
	};
	const result = await port.promptDumpPort.write(document).catch((error: unknown) => ({ ok: false as const, code: String(error) }));
	return result.ok ? `JSON: ${result.path}` : `JSON: not written (${result.code}).`;
}

function shortDigest(digest: RuntimeDigest): string {
	return `${digest.algorithm}:${digest.digest.slice(0, 16)}`;
}

function formatBytes(bytes: number): string {
	return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KiB`;
}
