import { formatBytes } from "../../scrapers/format.ts";
import { UTF8_DECODER } from "./bytes.ts";
import { ArchiveError } from "./error.ts";
import { type ArchiveLimits, assertInMemorySize, DEFAULT_ARCHIVE_LIMITS } from "./limits.ts";
import { normalizeArchiveLookupPath } from "./paths.ts";
import { ArchiveReader } from "./reader.ts";
import { ARCHIVE_EXTENSION_ALTERNATION, formatReaderFor } from "./registry.ts";
import { type ByteSource, memoryByteSource } from "./source.ts";
import type {
	ArchiveDirectoryEntry,
	ArchiveFormat,
	ArchiveMemberContent,
	ArchivePathCandidate,
	ArchiveSource,
	FormatReadOptions,
} from "./types.ts";

const ENCODER = new TextEncoder();

/** Options accepted by every archive-opening entry point. */
export interface OpenArchiveOptions {
	/** Override individual resource ceilings; unset fields keep defaults. */
	limits?: Partial<ArchiveLimits>;
}

interface ResolvedArchiveSource {
	source: ByteSource;
	format: ArchiveFormat;
	archivePath?: string;
}

/**
 * Resolve the caller-supplied archive source.
 *
 * 与上游的差异：这里只接受**已读入的字节**或显式 `ByteSource`。上游允许传
 * 文件路径（`fileByteSource` 用 `Bun.file`）与 HTTP 范围读，那两条都是绕过
 * RunLedger 受治 I/O 的旁路；本移植要求调用方先经 governed fs 读入，
 * 因此路径形式被显式拒绝而不是静默降级。
 */
function resolveSource(input: ArchiveSource): ResolvedArchiveSource {
	if (typeof input === "string") {
		throw new ArchiveError("Archive path input is not supported; read the bytes through governed I/O first");
	}
	if ("bytes" in input) {
		return { source: memoryByteSource(input.bytes), format: input.format };
	}
	if ("source" in input) {
		return { source: input.source, format: input.format, archivePath: input.path };
	}
	throw new ArchiveError("Archive path input is not supported; read the bytes through governed I/O first");
}

/**
 * Open an archive for browsing and member reads. File- and source-backed
 * containers with random-access layouts (ZIP, ASAR, RAR, 7z, ISO, CAB) index
 * lazily; stream containers (tar family, cpio, ar) buffer once under limits.
 */
export async function openArchive(input: ArchiveSource, options: OpenArchiveOptions = {}): Promise<ArchiveReader> {
	const { source, format, archivePath } = resolveSource(input);
	const limits = { ...DEFAULT_ARCHIVE_LIMITS, ...options.limits };
	const readOptions: FormatReadOptions = { limits, archivePath };
	const entries = await formatReaderFor(format)(source, readOptions);
	return new ArchiveReader(format, entries, limits);
}

/**
 * Split an `archive.ext:inner/path` reference into every plausible
 * `{ archivePath, subPath }` pair, longest archive prefix first. A path may
 * contain more than one archive extension, so each candidate is a guess at
 * where the archive ends and the member portion begins.
 */
export function parseArchivePathCandidates(filePath: string): ArchivePathCandidate[] {
	const normalized = filePath.replace(/\\/g, "/");
	const pattern = new RegExp(`\\.(?:${ARCHIVE_EXTENSION_ALTERNATION})(?=(?::|$))`, "gi");
	const seen = new Set<string>();
	const candidates: ArchivePathCandidate[] = [];

	let match: RegExpExecArray | null;
	while (true) {
		match = pattern.exec(normalized);
		if (match === null) {
			break;
		}
		const end = match.index + match[0].length;
		const archivePath = filePath.slice(0, end);
		const subPath = normalized.slice(end).replace(/^:+/, "");
		const key = `${archivePath}\0${subPath}`;
		if (seen.has(key)) continue;
		seen.add(key);
		candidates.push({ archivePath, subPath });
	}

	return candidates.sort((left, right) => right.archivePath.length - left.archivePath.length);
}

/** Render directory entries one per line: `name/` for dirs, `name (size)` for files. */
export function formatArchiveEntryLines(entries: readonly ArchiveDirectoryEntry[]): string[] {
	return entries.map(entry => {
		if (entry.isDirectory) return `${entry.name}/`;

		const sizeSuffix = entry.size > 0 ? ` (${formatBytes(entry.size)})` : "";
		return `${entry.name}${sizeSuffix}`;
	});
}

/** Render the top-level entries of an in-memory archive as one line each. */
export async function listArchiveRoot(
	bytes: Uint8Array,
	format: ArchiveFormat,
	opts: { limit?: number } = {},
): Promise<string> {
	const archive = await openArchive({ bytes, format });
	const entries = archive.listDirectory("");
	const limitedEntries = opts.limit !== undefined && opts.limit > 0 ? entries.slice(0, opts.limit) : entries;
	const lines = formatArchiveEntryLines(limitedEntries);
	return lines.length > 0 ? lines.join("\n") : "(empty archive directory)";
}

/**
 * Fully materialize every file member into a `path → bytes` map. Use this
 * for whole-archive rewrite; browsing and single-member reads should use
 * {@link openArchive} so payloads remain lazy. Total extracted bytes are
 * bounded by `limits.maxInMemorySize`.
 */
export async function readArchiveEntries(
	input: ArchiveSource,
	options: OpenArchiveOptions = {},
): Promise<Map<string, Uint8Array>> {
	const archive = await openArchive(input, options);
	const entries = new Map<string, Uint8Array>();
	let total = 0;
	for (const entry of archive.indexEntries()) {
		if (entry.isDirectory) continue;
		// Whole-archive materialization flattens file aliases; dangling or
		// unresolved links are unreadable and throw, matching the reader.
		const file = await archive.readFile(entry.path);
		entries.set(entry.path, file.bytes);
		total += file.bytes.byteLength;
		assertInMemorySize(total, archive.limits);
	}
	return entries;
}

/** Convert member content for packing: strings become UTF-8 bytes. */
export async function memberContentToBytes(content: ArchiveMemberContent): Promise<Uint8Array> {
	if (typeof content === "string") return ENCODER.encode(content);
	if (content instanceof Uint8Array) return content;
	return new Uint8Array(await content.arrayBuffer());
}

/** Read one materialized member as UTF-8 text, or `undefined` when absent. */
export function archiveEntryText(entries: ReadonlyMap<string, Uint8Array>, entryPath: string): string | undefined {
	const bytes = entries.get(entryPath);
	return bytes ? UTF8_DECODER.decode(bytes) : undefined;
}
