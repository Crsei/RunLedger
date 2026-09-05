/** 协议进程的诊断视图：有限尾部、跨 chunk 清洗，不改变原始私有 output evidence。 */

import { stripVTControlCharacters } from "node:util";
import { clipUtf8Output, PROCESS_OUTPUT_BOUNDS } from "./output.ts";

const MAX_DIAGNOSTIC_BYTES = 8192;
const MAX_LINE_BYTES = 2048;

/** live 让协议 stdout 持续前进；terminal 只追到固定 head，并保留硬页数上限。 */
export const STDERR_DRAIN_BOUNDS = Object.freeze({
	livePages: 4,
	terminalPages: Math.ceil(PROCESS_OUTPUT_BOUNDS.maxDurableOutputBytes / PROCESS_OUTPUT_BOUNDS.maxPageBytes) + 1,
});

function sanitize(text: string): string {
	return stripVTControlCharacters(text)
		.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/gu, "")
		.replace(/(bearer\s+)[^\s]+/giu, "$1[REDACTED]")
		.replace(/((?:api[_-]?key|token|secret|password)["']?\s*[=:]\s*)(["'])(?:\\.|(?!\2)[^\\\r\n])*(\2)?/giu, "$1$2[REDACTED]$3")
		.replace(/((?:api[_-]?key|token|secret|password)["']?\s*[=:]\s*["']?)[^\s,;"']+/giu, "$1[REDACTED]")
		.replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/giu, "$1[REDACTED]@");
}

function tail(text: string): string {
	const bytes = Buffer.from(text, "utf8");
	if (bytes.length <= MAX_DIAGNOSTIC_BYTES) return text;
	let start = bytes.length - MAX_DIAGNOSTIC_BYTES;
	while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start += 1;
	return bytes.subarray(start).toString("utf8");
}

export class StderrDiagnostics {
	private text = "";
	private pending = "";
	private droppingLine = false;

	append(chunk: string): void {
		for (const segment of chunk.match(/[^\n]*\n|[^\n]+$/gu) ?? []) {
			const complete = segment.endsWith("\n");
			if (!this.droppingLine) {
				const clipped = clipUtf8Output(this.pending + segment, MAX_LINE_BYTES);
				if (clipped.truncated) {
					// 超长行整体隐藏，避免剪掉 credential 前缀后泄露其后缀。
					this.pending = "";
					this.droppingLine = true;
					this.text = tail(this.text + "[diagnostic line truncated]\n");
				} else this.pending = clipped.text;
			}
			if (complete) {
				if (!this.droppingLine) this.text = tail(this.text + sanitize(this.pending));
				this.pending = "";
				this.droppingLine = false;
			}
		}
	}

	peek(): string {
		return tail(this.text + sanitize(this.pending));
	}
}
