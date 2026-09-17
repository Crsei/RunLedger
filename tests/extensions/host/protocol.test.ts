import { describe, expect, it } from "vitest";
import {
	createExtensionHostFrameDecoder,
	decodeExtensionHostFrame,
	encodeExtensionHostFrame,
} from "../../../src/extensions/host/protocol.ts";
import type { ExtensionHostFrame } from "../../../src/contracts/extensions/host-protocol.ts";
import { EXTENSION_HOST_FRAME_MAX_BYTES, EXTENSION_HOST_PROTOCOL_VERSION } from "../../../src/contracts/extensions/host-protocol.ts";
import { EXTENSION_DEFAULT_HOST_LIMITS } from "../../../src/contracts/extensions/registry.ts";

const digest = "a".repeat(64);

function eventFrame(overrides: Partial<Extract<ExtensionHostFrame, { kind: "event" }>> = {}): Extract<ExtensionHostFrame, { kind: "event" }> {
	return {
		protocolVersion: EXTENSION_HOST_PROTOCOL_VERSION,
		generation: 4,
		frameId: "frame-1",
		kind: "event",
		requestId: "event-1",
		name: "PreToolUse",
		cancelable: true,
		payload: { toolName: "bash" },
		deadlineMs: 1_000,
		...overrides,
	};
}

describe("extension host protocol codec", () => {
	it("round-trips a valid frame and rejects schema violations on encode", () => {
		const line = encodeExtensionHostFrame(eventFrame());
		expect(decodeExtensionHostFrame(JSON.parse(line) as unknown)).toEqual({ ok: true, frame: eventFrame() });
		expect(() => encodeExtensionHostFrame({ ...eventFrame(), deadlineMs: 0 } as unknown as ExtensionHostFrame)).toThrow(/does not match its schema/u);
	});

	it("refuses frames that exceed the byte bound even when the schema accepts them", () => {
		const frame = eventFrame({ payload: { blob: "x".repeat(EXTENSION_HOST_FRAME_MAX_BYTES) } });
		expect(() => encodeExtensionHostFrame(frame)).toThrow(/exceeds/u);
		// 字节上限属于流式编解码边界；编码器按 UTF-8 字节数而不是字符数计算。
		const wide = eventFrame({ payload: { note: "中".repeat(20) } });
		expect(Buffer.byteLength(encodeExtensionHostFrame(wide), "utf8")).toBeGreaterThan(60);
		expect(() => encodeExtensionHostFrame(wide, { maxFrameBytes: 60 })).toThrow(/exceeds 60 bytes/u);
	});

	it("separates version, generation, kind and schema failures", () => {
		expect(decodeExtensionHostFrame({ ...eventFrame(), protocolVersion: 2 })).toEqual({
			ok: false,
			error: { code: "frame_version_mismatch", message: "frame protocolVersion must be 1" },
		});
		expect(decodeExtensionHostFrame(eventFrame({ generation: 9 }), { generation: 4 })).toEqual({
			ok: false,
			error: { code: "frame_generation_mismatch", message: "frame generation does not match the active host generation" },
		});
		expect(decodeExtensionHostFrame({ ...eventFrame(), kind: "intent" })).toEqual({
			ok: false,
			error: { code: "frame_kind_unknown", message: "frame kind is not part of protocol version 1" },
		});
		expect(decodeExtensionHostFrame({ ...eventFrame(), requestId: "bad id with spaces" })).toEqual({
			ok: false,
			error: { code: "frame_schema_invalid", message: "frame event does not match its schema" },
		});
		expect(decodeExtensionHostFrame("nope")).toEqual({ ok: false, error: { code: "frame_not_object", message: "frame must be a JSON object" } });
	});

	it("rejects deeply nested payloads instead of recursing", () => {
		let nested: Record<string, unknown> = { leaf: true };
		for (let index = 0; index < 40; index += 1) nested = { child: nested };
		const decoded = decodeExtensionHostFrame(eventFrame({ payload: nested }));
		expect(decoded.ok).toBe(false);
		if (!decoded.ok) expect(decoded.error.code).toBe("frame_too_deep");
	});

	it("reassembles half packets and reports malformed lines without losing later frames", () => {
		const decoder = createExtensionHostFrameDecoder({ generation: 4 });
		const line = encodeExtensionHostFrame(eventFrame());
		const split = Math.floor(line.length / 2);
		expect(decoder.push(line.slice(0, split))).toEqual({ frames: [], errors: [] });
		const rest = `${line.slice(split)}\n{"broken":\n${line}\n`;
		const decoded = decoder.push(rest);
		expect(decoded.frames).toHaveLength(2);
		expect(decoded.errors).toEqual([{ code: "frame_invalid_json", message: "frame is not valid JSON", droppedBytes: 10 }]);
		expect(decoder.pendingBytes()).toBe(0);
	});

	it("drops an oversize line entirely and keeps decoding", () => {
		const valid = encodeExtensionHostFrame(eventFrame());
		const decoder = createExtensionHostFrameDecoder({ generation: 4, maxFrameBytes: valid.length + 16 });
		const oversize = `{"kind":"event","padding":"${"x".repeat(512)}"}`;
		const decoded = decoder.push(`${oversize}\n${valid}\n`);
		expect(decoded.frames).toHaveLength(1);
		expect(decoded.errors).toHaveLength(1);
		expect(decoded.errors[0]?.code).toBe("frame_oversize");
	});

	it("keeps the frozen protocol version and default limits documented", () => {
		expect(EXTENSION_HOST_PROTOCOL_VERSION).toBe(1);
		expect(EXTENSION_DEFAULT_HOST_LIMITS.handlerTimeoutMs).toBe(30_000);
		expect(EXTENSION_DEFAULT_HOST_LIMITS.shutdownTimeoutMs).toBe(2_000);
	});
});
