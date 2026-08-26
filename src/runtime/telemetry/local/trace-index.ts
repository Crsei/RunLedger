import { lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { canonicalJson } from "../../protocol/canonical-json.ts";
import { isRuntimeId, type SessionId, type TraceId } from "../../protocol/ids.ts";
import {
	RUNLEDGER_DIRECTORY_MODE,
	RUNLEDGER_FILE_MODE,
	type RunledgerLayout,
} from "../../contracts/storage-layout.ts";

const INDEX_FORMAT = "runledger.telemetry.session-trace-index";
const INDEX_VERSION = 1;

export interface SessionTraceIndexEntry {
	readonly format: typeof INDEX_FORMAT;
	readonly version: typeof INDEX_VERSION;
	readonly sessionId: SessionId;
	readonly traceId: TraceId;
	readonly eventRelativeLocator: string;
}

export interface IndexedTraceFile {
	readonly traceId: TraceId;
	readonly filePath: string;
}

export class SessionTraceIndexError extends Error {
	public constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "SessionTraceIndexError";
	}
}

/** 写入按 Session 分片的派生 locator；文件可删除重建，不承载 telemetry truth。 */
export async function writeSessionTraceIndex(
	layout: RunledgerLayout,
	entry: SessionTraceIndexEntry,
): Promise<void> {
	assertEntry(entry, entry.sessionId, entry.traceId, layout);
	const directory = indexDirectory(layout, entry.sessionId);
	const target = path.join(directory, `${entry.traceId}.json`);
	await assertNoSymlinkComponents(layout.home, directory);
	await mkdir(directory, { recursive: true, mode: RUNLEDGER_DIRECTORY_MODE });
	await assertNoSymlinkComponents(layout.home, target);
	const encoded = `${canonicalJson(entry)}\n`;
	try {
		await writeFile(target, encoded, { encoding: "utf8", flag: "wx", mode: RUNLEDGER_FILE_MODE });
	} catch (error) {
		if (!isAlreadyExists(error)) throw new SessionTraceIndexError("could not write Session trace index", { cause: error });
		let existing: string;
		try {
			existing = await readFile(target, "utf8");
		} catch (readError) {
			throw new SessionTraceIndexError("could not verify existing Session trace index", { cause: readError });
		}
		if (existing !== encoded) throw new SessionTraceIndexError("Session trace index conflicts with an existing entry");
	}
}

/** 读取单个 Session 的有界派生目录；缺失返回 undefined，损坏由调用方安全回退扫描。 */
export async function readSessionTraceIndex(
	layout: RunledgerLayout,
	sessionId: SessionId,
): Promise<readonly IndexedTraceFile[] | undefined> {
	const directory = indexDirectory(layout, sessionId);
	let entries;
	try {
		const info = await lstat(directory);
		if (info.isSymbolicLink() || !info.isDirectory()) throw new SessionTraceIndexError("Session trace index directory is not a safe directory");
		entries = await readdir(directory, { withFileTypes: true });
	} catch (error) {
		if (isNotFound(error)) return undefined;
		if (error instanceof SessionTraceIndexError) throw error;
		throw new SessionTraceIndexError("could not read Session trace index directory", { cause: error });
	}
	if (entries.length > 1_024) throw new SessionTraceIndexError("Session trace index exceeds the bounded entry limit");
	const result: IndexedTraceFile[] = [];
	for (const directoryEntry of entries) {
		if (!directoryEntry.isFile() || !directoryEntry.name.endsWith(".json")) throw new SessionTraceIndexError("Session trace index contains an unsupported entry");
		const target = path.join(directory, directoryEntry.name);
		const info = await lstat(target);
		if (info.isSymbolicLink()) throw new SessionTraceIndexError("Session trace index contains a symbolic link");
		let value: unknown;
		try {
			value = JSON.parse(await readFile(target, "utf8"));
		} catch (error) {
			throw new SessionTraceIndexError("Session trace index entry is not valid JSON", { cause: error });
		}
		const traceId = path.basename(directoryEntry.name, ".json") as TraceId;
		assertEntry(value, sessionId, traceId, layout);
		result.push({ traceId, filePath: resolveEventLocator(layout, (value as SessionTraceIndexEntry).eventRelativeLocator) });
	}
	result.sort((left, right) => left.traceId.localeCompare(right.traceId));
	return result;
}

function indexDirectory(layout: RunledgerLayout, sessionId: SessionId): string {
	if (!isRuntimeId(sessionId, "session")) throw new SessionTraceIndexError("Session trace index requires a valid Session ID");
	return path.join(layout.projections, "telemetry", "session-traces", sessionId);
}

function assertEntry(value: unknown, sessionId: SessionId, traceId: TraceId, layout: RunledgerLayout): asserts value is SessionTraceIndexEntry {
	if (typeof value !== "object" || value === null) throw new SessionTraceIndexError("Session trace index entry must be an object");
	const entry = value as Partial<SessionTraceIndexEntry>;
	if (
		entry.format !== INDEX_FORMAT || entry.version !== INDEX_VERSION ||
		entry.sessionId !== sessionId || entry.traceId !== traceId ||
		!isRuntimeId(entry.sessionId, "session") || !isRuntimeId(entry.traceId, "trace") ||
		typeof entry.eventRelativeLocator !== "string" ||
		Object.keys(entry).sort().join(",") !== "eventRelativeLocator,format,sessionId,traceId,version"
	) {
		throw new SessionTraceIndexError("Session trace index entry failed validation");
	}
	const resolved = resolveEventLocator(layout, entry.eventRelativeLocator);
	if (path.basename(resolved) !== `${traceId}.jsonl`) throw new SessionTraceIndexError("Session trace index locator does not match its Trace ID");
}

function resolveEventLocator(layout: RunledgerLayout, locator: string): string {
	if (path.isAbsolute(locator) || locator.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
		throw new SessionTraceIndexError("Session trace index locator is not a safe relative path");
	}
	const target = path.resolve(layout.home, ...locator.split("/"));
	const relative = path.relative(layout.events, target);
	if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
		throw new SessionTraceIndexError("Session trace index locator escapes the Event Store");
	}
	return target;
}

async function assertNoSymlinkComponents(home: string, target: string): Promise<void> {
	const relative = path.relative(home, target);
	if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new SessionTraceIndexError("Session trace index escapes RunLedger home");
	let current = home;
	for (const component of relative.split(path.sep)) {
		current = path.join(current, component);
		try {
			if ((await lstat(current)).isSymbolicLink()) throw new SessionTraceIndexError("Session trace index path contains a symbolic link");
		} catch (error) {
			if (isNotFound(error)) continue;
			throw error;
		}
	}
}

function isNotFound(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && (error as { readonly code?: unknown }).code === "ENOENT";
}

function isAlreadyExists(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && (error as { readonly code?: unknown }).code === "EEXIST";
}
