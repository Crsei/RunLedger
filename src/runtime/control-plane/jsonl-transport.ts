/** local stdio/socket 的严格 JSONL framing；LF、CRLF 与 EOF final line 均有明确语义。 */

import { TextDecoder } from "node:util";
import { canonicalJson } from "../protocol/v3/canonical-json.ts";
import type { ControlPlaneResult } from "./errors.ts";
import { controlPlaneFailure } from "./errors.ts";
import { errorResponse, requestIdOf, type ControlPlaneResponse } from "./types.ts";

export const DEFAULT_MAX_JSONL_FRAME_BYTES = 1024 * 1024;

export class StrictJsonlFrameParser {
	readonly #maxFrameBytes: number;
	readonly #decoder = new TextDecoder("utf-8", { fatal: true });
	#buffer = "";
	#frameIndex = 0;
	#finished = false;

	public constructor(maxFrameBytes = DEFAULT_MAX_JSONL_FRAME_BYTES) {
		if (!Number.isInteger(maxFrameBytes) || maxFrameBytes < 1) throw new Error("maxFrameBytes must be positive");
		this.#maxFrameBytes = maxFrameBytes;
	}

	public push(chunk: Uint8Array | string): ControlPlaneResult<readonly unknown[]> {
		if (this.#finished) return controlPlaneFailure("malformed_frame", "JSONL parser is already finished");
		let decoded: string;
		try {
			decoded = typeof chunk === "string" ? chunk : this.#decoder.decode(chunk, { stream: true });
		} catch {
			this.#finished = true;
			return controlPlaneFailure("malformed_frame", "JSONL frame is not valid UTF-8", false, { frameIndex: this.#frameIndex });
		}
		this.#buffer += decoded;
		return this.#drainCompleteLines();
	}

	public finish(): ControlPlaneResult<readonly unknown[]> {
		if (this.#finished) return { ok: true, value: [] };
		this.#finished = true;
		try {
			this.#buffer += this.#decoder.decode();
		} catch {
			return controlPlaneFailure("malformed_frame", "JSONL final frame is not valid UTF-8", false, { frameIndex: this.#frameIndex });
		}
		const complete = this.#drainCompleteLines(true);
		if (!complete.ok) return complete;
		if (this.#buffer.length === 0) return complete;
		const final = this.#buffer.endsWith("\r") ? this.#buffer.slice(0, -1) : this.#buffer;
		this.#buffer = "";
		const parsed = this.#parseFrame(final);
		return parsed.ok ? { ok: true, value: [...complete.value, parsed.value] } : parsed;
	}

	#drainCompleteLines(finishing = false): ControlPlaneResult<readonly unknown[]> {
		const frames: unknown[] = [];
		while (true) {
			const newline = this.#buffer.indexOf("\n");
			if (newline < 0) break;
			let line = this.#buffer.slice(0, newline);
			this.#buffer = this.#buffer.slice(newline + 1);
			if (line.endsWith("\r")) line = line.slice(0, -1);
			const parsed = this.#parseFrame(line);
			if (!parsed.ok) return parsed;
			frames.push(parsed.value);
		}
		if (!finishing && Buffer.byteLength(this.#buffer, "utf8") > this.#maxFrameBytes) {
			this.#finished = true;
			return controlPlaneFailure("frame_too_large", "JSONL frame exceeds the configured byte limit", false, {
				frameIndex: this.#frameIndex,
				maxFrameBytes: this.#maxFrameBytes,
			});
		}
		return { ok: true, value: frames };
	}

	#parseFrame(line: string): ControlPlaneResult<unknown> {
		const frameIndex = this.#frameIndex;
		this.#frameIndex += 1;
		const bytes = Buffer.byteLength(line, "utf8");
		if (bytes === 0) {
			this.#finished = true;
			return controlPlaneFailure("malformed_frame", "blank JSONL frames are not allowed", false, { frameIndex });
		}
		if (bytes > this.#maxFrameBytes) {
			this.#finished = true;
			return controlPlaneFailure("frame_too_large", "JSONL frame exceeds the configured byte limit", false, {
				frameIndex,
				maxFrameBytes: this.#maxFrameBytes,
			});
		}
		try {
			return { ok: true, value: JSON.parse(line) as unknown };
		} catch {
			this.#finished = true;
			return controlPlaneFailure("malformed_frame", "JSONL frame is not valid JSON", false, { frameIndex });
		}
	}
}

export interface ControlPlaneFrameDispatcher {
	dispatch(frame: unknown): Promise<ControlPlaneResponse>;
}

export class JsonlControlPlaneAdapter {
	readonly #parser: StrictJsonlFrameParser;
	readonly #dispatcher: ControlPlaneFrameDispatcher;

	public constructor(dispatcher: ControlPlaneFrameDispatcher, maxFrameBytes = DEFAULT_MAX_JSONL_FRAME_BYTES) {
		this.#dispatcher = dispatcher;
		this.#parser = new StrictJsonlFrameParser(maxFrameBytes);
	}

	public async receive(chunk: Uint8Array | string): Promise<readonly string[]> {
		return this.#dispatchParsed(this.#parser.push(chunk));
	}

	public async finish(): Promise<readonly string[]> {
		return this.#dispatchParsed(this.#parser.finish());
	}

	async #dispatchParsed(parsed: ControlPlaneResult<readonly unknown[]>): Promise<readonly string[]> {
		if (!parsed.ok) return [`${canonicalJson(errorResponse(null, parsed.error))}\n`];
		const responses: string[] = [];
		for (const frame of parsed.value) {
			let response: ControlPlaneResponse;
			try {
				response = await this.#dispatcher.dispatch(frame);
			} catch (error) {
				response = errorResponse(requestIdOf(frame), {
					code: "internal_error",
					message: "Control Plane dispatcher failed",
					retryable: false,
					details: { errorName: error instanceof Error ? error.name : "UnknownError" },
				});
			}
			responses.push(`${canonicalJson(response)}\n`);
		}
		return responses;
	}
}

export function parseJsonlDocument(source: Uint8Array | string, maxFrameBytes = DEFAULT_MAX_JSONL_FRAME_BYTES): ControlPlaneResult<readonly unknown[]> {
	const parser = new StrictJsonlFrameParser(maxFrameBytes);
	const first = parser.push(source);
	if (!first.ok) return first;
	const final = parser.finish();
	return final.ok ? { ok: true, value: [...first.value, ...final.value] } : final;
}
