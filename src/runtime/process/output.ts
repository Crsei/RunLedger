/** Managed process 输出 cursor 与 UTF-8 bounded page contract。 */

export const PROCESS_OUTPUT_BOUNDS = Object.freeze({
	maxPageBytes: 64 * 1024,
	maxLiveRingBytes: 2 * 1024 * 1024,
	maxDurableOutputBytes: 64 * 1024 * 1024,
	maxInputFrameBytes: 64 * 1024,
});

export interface OutputCursor {
	readonly sequence: number;
	readonly byteOffset: number;
}

export interface ClippedUtf8Output {
	readonly text: string;
	readonly byteLength: number;
	readonly truncated: boolean;
}

export function clipUtf8Output(value: string, maxBytes: number = PROCESS_OUTPUT_BOUNDS.maxPageBytes): ClippedUtf8Output {
	if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error("maxBytes must be a non-negative safe integer");
	let byteLength = 0;
	let text = "";
	for (const codePoint of value) {
		const codePointBytes = Buffer.byteLength(codePoint, "utf8");
		if (byteLength + codePointBytes > maxBytes) {
			return { text, byteLength, truncated: true };
		}
		text += codePoint;
		byteLength += codePointBytes;
	}
	return { text, byteLength, truncated: false };
}

export function isOutputCursorValid(cursor: OutputCursor, head: OutputCursor): boolean {
	return (
		Number.isSafeInteger(cursor.sequence) &&
		cursor.sequence >= 0 &&
		Number.isSafeInteger(cursor.byteOffset) &&
		cursor.byteOffset >= 0 &&
		Number.isSafeInteger(head.sequence) &&
		head.sequence >= 0 &&
		Number.isSafeInteger(head.byteOffset) &&
		head.byteOffset >= 0 &&
		(cursor.sequence < head.sequence || (cursor.sequence === head.sequence && cursor.byteOffset <= head.byteOffset))
	);
}
