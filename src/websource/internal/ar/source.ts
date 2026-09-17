import { LRUCache } from "../lru.ts";
import { ArchiveError } from "./error.ts";

/**
 * A byte window into an archive — file-backed (lazy, ranged reads) or
 * in-memory. Format readers index through this so ZIP/ASAR/RAR payloads are
 * only read when a member is actually extracted.
 */
export interface ByteSource {
	readonly size: number;
	read(start: number, end: number): Promise<Uint8Array>;
}

/** Reject a nonsensical `[start, end)` range before any read. */
export function assertValidRange(start: number, end: number): void {
	if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start) {
		throw new ArchiveError("Invalid archive range");
	}
}

/** Read an exact in-memory range, throwing (not clamping) when it runs past the buffer. */
export function readMemoryRange(buffer: Uint8Array, start: number, end: number): Uint8Array {
	assertValidRange(start, end);
	if (end > buffer.byteLength) {
		throw new ArchiveError("Invalid archive: truncated data");
	}
	return buffer.subarray(start, end);
}

/** Wrap borrowed bytes as a {@link ByteSource}. */
export function memoryByteSource(buffer: Uint8Array): ByteSource {
	return {
		size: buffer.byteLength,
		async read(start, end) {
			return readMemoryRange(buffer, start, end);
		},
	};
}

/** Materialize an entire {@link ByteSource}; use only under a limits check. */
export async function readAllBytes(source: ByteSource): Promise<Uint8Array> {
	return source.read(0, source.size);
}
