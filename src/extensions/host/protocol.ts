/**
 * Extension host 协议的编解码与边界校验。
 *
 * 帧是 JSONL：一帧一行，UTF-8。解码器必须处理半包、逐帧字节上限、
 * 深度上限、版本/generation 不匹配、未知 kind 与 schema 不符。
 * 本模块不做任何 I/O：它只把字节流片段变成经过校验的帧，或给出
 * bounded 的失败码。
 */

import { Value } from "typebox/value";
import type { ExtensionHostFrame, ExtensionHostFrameKind } from "../../contracts/extensions/host-protocol.ts";
import {
	EXTENSION_HOST_FRAME_MAX_BYTES,
	EXTENSION_HOST_FRAME_MAX_DEPTH,
	EXTENSION_HOST_FRAME_SCHEMAS,
	EXTENSION_HOST_PROTOCOL_VERSION,
	isExtensionHostFrameKind,
} from "../../contracts/extensions/host-protocol.ts";

export type ExtensionHostProtocolErrorCode =
	| "frame_not_object"
	| "frame_oversize"
	| "frame_too_deep"
	| "frame_invalid_json"
	| "frame_kind_unknown"
	| "frame_schema_invalid"
	| "frame_version_mismatch"
	| "frame_generation_mismatch";

export interface ExtensionHostProtocolError {
	readonly code: ExtensionHostProtocolErrorCode;
	readonly message: string;
	/** 解码器在错误后丢弃的字节数；用于诊断，不含原始帧内容。 */
	readonly droppedBytes?: number;
}

export type ExtensionHostDecodeResult =
	| { readonly ok: true; readonly frame: ExtensionHostFrame }
	| { readonly ok: false; readonly error: ExtensionHostProtocolError };

export interface ExtensionHostFrameDecoderOptions {
	/** 期望的协议版本；缺省为当前版本。 */
	readonly protocolVersion?: number;
	/** 期望的 host generation；给出时不匹配的帧被拒绝。 */
	readonly generation?: number;
	readonly maxFrameBytes?: number;
	readonly maxDepth?: number;
}

function byteLength(value: string): number {
	return Buffer.byteLength(value, "utf8");
}

function depthOf(value: unknown, maxDepth: number): number {
	// 迭代式深度测量：递归会在恶意嵌套上先把调用栈打爆。
	let max = 0;
	const stack: Array<{ readonly value: unknown; readonly depth: number }> = [{ value, depth: 1 }];
	while (stack.length > 0) {
		const current = stack.pop();
		if (current === undefined) break;
		if (current.depth > max) max = current.depth;
		if (max > maxDepth) return max;
		const item = current.value;
		if (typeof item !== "object" || item === null) continue;
		const children = Array.isArray(item) ? item : Object.values(item as Record<string, unknown>);
		for (const child of children) {
			if (typeof child === "object" && child !== null) stack.push({ value: child, depth: current.depth + 1 });
		}
	}
	return max;
}

/** 校验并编码一帧；不追加换行。 */
export function encodeExtensionHostFrame(frame: ExtensionHostFrame, options: { readonly maxFrameBytes?: number } = {}): string {
	const maxFrameBytes = options.maxFrameBytes ?? EXTENSION_HOST_FRAME_MAX_BYTES;
	const kind = frame.kind;
	const schema = EXTENSION_HOST_FRAME_SCHEMAS[kind];
	// `Value.Check` 是类型守卫，失败分支会把 frame 收窄成 never；错误信息因此
	// 必须用先前捕获的 kind，而不是再读 frame.kind。
	if (!Value.Check(schema, frame as unknown)) throw new Error(`extension host frame ${kind} does not match its schema`);
	const line = JSON.stringify(frame);
	if (byteLength(line) > maxFrameBytes) throw new Error(`extension host frame exceeds ${maxFrameBytes} bytes`);
	return line;
}

/**
 * 校验一个已经解析出来的 JSON 值。与 `Value.Check` 的差别在于给出 bounded
 * 错误码而不是布尔值，并把版本/generation 不匹配与结构不合法分开。
 */
export function decodeExtensionHostFrame(value: unknown, options: ExtensionHostFrameDecoderOptions = {}): ExtensionHostDecodeResult {
	const protocolVersion = options.protocolVersion ?? EXTENSION_HOST_PROTOCOL_VERSION;
	const maxDepth = options.maxDepth ?? EXTENSION_HOST_FRAME_MAX_DEPTH;
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return { ok: false, error: { code: "frame_not_object", message: "frame must be a JSON object" } };
	}
	if (depthOf(value, maxDepth) > maxDepth) {
		return { ok: false, error: { code: "frame_too_deep", message: `frame nesting exceeds ${maxDepth}` } };
	}
	const record = value as Record<string, unknown>;
	if (!isExtensionHostFrameKind(record.kind)) {
		return { ok: false, error: { code: "frame_kind_unknown", message: "frame kind is not part of protocol version 1" } };
	}
	if (record.protocolVersion !== protocolVersion) {
		return { ok: false, error: { code: "frame_version_mismatch", message: `frame protocolVersion must be ${protocolVersion}` } };
	}
	if (options.generation !== undefined && record.generation !== options.generation) {
		return { ok: false, error: { code: "frame_generation_mismatch", message: "frame generation does not match the active host generation" } };
	}
	const kind: ExtensionHostFrameKind = record.kind;
	if (!Value.Check(EXTENSION_HOST_FRAME_SCHEMAS[kind], value)) {
		return { ok: false, error: { code: "frame_schema_invalid", message: `frame ${kind} does not match its schema` } };
	}
	return { ok: true, frame: value as ExtensionHostFrame };
}

export interface ExtensionHostFrameDecoder {
	/** 追加一段可能不完整的输出，返回本次可解析出的完整帧与首个错误。 */
	push(text: string): { readonly frames: readonly ExtensionHostFrame[]; readonly errors: readonly ExtensionHostProtocolError[] };
	/** 通道结束时的残留字节数；非零表示对端在帧中途断开。 */
	pendingBytes(): number;
}

/**
 * 增量 JSONL 解码器。超限帧被整行丢弃（不半解析），并计入错误；解码器
 * 不因为单帧错误而失效，因为对端仍可能送出后续合法帧——是否继续由
 * supervisor 按 fatal 语义决定。
 */
export function createExtensionHostFrameDecoder(options: ExtensionHostFrameDecoderOptions = {}): ExtensionHostFrameDecoder {
	const maxFrameBytes = options.maxFrameBytes ?? EXTENSION_HOST_FRAME_MAX_BYTES;
	let pending = "";
	return {
		push: (text) => {
			pending += text;
			const frames: ExtensionHostFrame[] = [];
			const errors: ExtensionHostProtocolError[] = [];
			while (true) {
				const newline = pending.indexOf("\n");
				if (newline < 0) {
					if (byteLength(pending) > maxFrameBytes) {
						const dropped = byteLength(pending);
						pending = "";
						errors.push({ code: "frame_oversize", message: `frame exceeds ${maxFrameBytes} bytes`, droppedBytes: dropped });
					}
					return { frames, errors };
				}
				const line = pending.slice(0, newline).replace(/\r$/u, "");
				pending = pending.slice(newline + 1);
				if (line.trim().length === 0) continue;
				if (byteLength(line) > maxFrameBytes) {
					errors.push({ code: "frame_oversize", message: `frame exceeds ${maxFrameBytes} bytes`, droppedBytes: byteLength(line) });
					continue;
				}
				let parsed: unknown;
				try {
					parsed = JSON.parse(line) as unknown;
				} catch {
					errors.push({ code: "frame_invalid_json", message: "frame is not valid JSON", droppedBytes: byteLength(line) });
					continue;
				}
				const decoded = decodeExtensionHostFrame(parsed, options);
				if (decoded.ok) frames.push(decoded.frame);
				else errors.push(decoded.error);
			}
		},
		pendingBytes: () => byteLength(pending),
	};
}
