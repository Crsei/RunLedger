import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { canonicalDigest } from "../runtime/protocol/v3/canonical-json.ts";
import { createRuntimeId } from "../runtime/protocol/v3/ids.ts";
import { conservativeTokenEstimate } from "../runtime/context/token-estimator.ts";
import type { MemoryRecord, MemoryRef, MemorySearchReceipt, MemorySearchRequest, MemorySearchResult } from "../runtime/context/memory/types.ts";

interface LexicalEntry {
	memory: MemoryRef;
	title: string;
	content: string;
	updatedAt: string;
	expiresAt?: string;
	sourceDigest: string;
	tokens: readonly string[];
}

interface LexicalIndexFile {
	schemaVersion: 1;
	entries: readonly LexicalEntry[];
	indexDigest: string;
}

function tokenize(value: string): readonly string[] {
	return [...new Set(value.toLocaleLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? [])].sort();
}

function recordRef(record: MemoryRecord): MemoryRef {
	return {
		schemaVersion: 1,
		authorityId: record.authorityId,
		tenantId: record.tenantId,
		memoryId: record.memoryId,
		scope: record.scope,
		revision: record.revision,
		contentDigest: record.contentDigest,
		status: record.status,
	};
}

function entry(record: MemoryRecord): LexicalEntry {
	return {
		memory: recordRef(record),
		title: record.title,
		content: record.content,
		updatedAt: record.updatedAt,
		...(record.expiresAt === undefined ? {} : { expiresAt: record.expiresAt }),
		sourceDigest: canonicalDigest(record.sourceRefs),
		tokens: tokenize(`${record.title}\n${record.content}`),
	};
}

async function atomicWrite(path: string, body: string): Promise<void> {
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	const temporary = join(dirname(path), `.${createRuntimeId("command")}.tmp`);
	const handle = await open(temporary, "wx", 0o600);
	try { await handle.writeFile(body, "utf8"); await handle.sync(); } finally { await handle.close(); }
	try { await rename(temporary, path); } catch (error) { await unlink(temporary).catch(() => undefined); throw error; }
}

function encodeCursor(value: { offset: number; indexDigest: string; queryDigest: string }): string {
	return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decodeCursor(value: string | undefined, indexDigest: string, queryDigest: string): number {
	if (value === undefined) return 0;
	try {
		const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as { offset?: unknown; indexDigest?: unknown; queryDigest?: unknown };
		if (!Number.isSafeInteger(parsed.offset) || (parsed.offset as number) < 0 || parsed.indexDigest !== indexDigest || parsed.queryDigest !== queryDigest) return 0;
		return parsed.offset as number;
	} catch {
		return 0;
	}
}

function snippet(content: string, queryTokens: readonly string[], maxChars: number): { text: string; lineStart: number; lineEnd: number } {
	const lines = content.split(/\r?\n/);
	const match = lines.findIndex((line) => queryTokens.some((token) => line.toLocaleLowerCase().includes(token)));
	const start = Math.max(0, match < 0 ? 0 : match);
	const selected: string[] = [];
	let chars = 0;
	for (let index = start; index < lines.length; index += 1) {
		const next = lines[index] ?? "";
		if (chars + next.length + (selected.length > 0 ? 1 : 0) > maxChars) break;
		selected.push(next);
		chars += next.length + (selected.length > 1 ? 1 : 0);
	}
	return { text: selected.join("\n"), lineStart: start + 1, lineEnd: start + Math.max(1, selected.length) };
}

function scopeKey(scope: MemoryRef["scope"]): string {
	return JSON.stringify(scope);
}

export class MemoryLexicalIndex {
	readonly #path: string;

	public constructor(path: string) {
		this.#path = path;
	}

	public async rebuild(records: readonly MemoryRecord[]): Promise<LexicalIndexFile> {
		const entries = records
			.filter((record) => record.status === "approved")
			.map(entry)
			.sort((left, right) => left.memory.memoryId.localeCompare(right.memory.memoryId));
		const indexDigest = canonicalDigest(entries);
		const index: LexicalIndexFile = { schemaVersion: 1, entries, indexDigest };
		await atomicWrite(this.#path, `${JSON.stringify(index)}\n`);
		return index;
	}

	private async load(records: readonly MemoryRecord[]): Promise<{ index: LexicalIndexFile; rebuilt: boolean }> {
		try {
			const value = JSON.parse(await readFile(this.#path, "utf8")) as LexicalIndexFile;
			if (value.schemaVersion !== 1 || !Array.isArray(value.entries) || value.indexDigest !== canonicalDigest(value.entries)) {
				throw new Error("invalid lexical index");
			}
			const canonicalRecordDigest = canonicalDigest(records.filter((record) => record.status === "approved").map(entry).sort((left, right) => left.memory.memoryId.localeCompare(right.memory.memoryId)));
			if (canonicalRecordDigest !== value.indexDigest) throw new Error("stale lexical index");
			return { index: value, rebuilt: false };
		} catch {
			return { index: await this.rebuild(records), rebuilt: true };
		}
	}

	public async search(request: MemorySearchRequest, records: readonly MemoryRecord[], now: Date): Promise<MemorySearchReceipt> {
		const { index, rebuilt } = await this.load(records);
		const requestedScopes = new Set(request.scopes.map(scopeKey));
		const queryTokens = tokenize(request.query);
		const normalizedQuery = request.query.toLocaleLowerCase();
		const candidates = index.entries
			.filter((item) => requestedScopes.has(scopeKey(item.memory.scope)))
			.map((item) => {
				const stale = item.expiresAt !== undefined && Date.parse(item.expiresAt) <= now.getTime();
				const overlap = queryTokens.filter((token) => item.tokens.includes(token)).length;
				const phrase = `${item.title}\n${item.content}`.toLocaleLowerCase().includes(normalizedQuery) ? 1 : 0;
				const score = Math.min(1, queryTokens.length === 0 ? 0 : overlap / queryTokens.length * 0.8 + phrase * 0.2);
				return { item, stale, score };
			})
			.filter((candidate) => candidate.score > 0 && (request.includeStale || !candidate.stale))
			.sort((left, right) => right.score - left.score || right.item.updatedAt.localeCompare(left.item.updatedAt) || left.item.memory.memoryId.localeCompare(right.item.memory.memoryId));
		const offset = decodeCursor(request.cursor, index.indexDigest, request.queryDigest);
		const results: MemorySearchResult[] = [];
		let tokens = 0;
		let cursor = offset;
		for (; cursor < candidates.length && results.length < request.maxResults; cursor += 1) {
			const candidate = candidates[cursor];
			if (candidate === undefined) break;
			const excerpt = snippet(candidate.item.content, queryTokens, request.maxSnippetChars);
			const estimate = conservativeTokenEstimate(excerpt.text);
			if (tokens + estimate > request.maxTotalTokens) break;
			tokens += estimate;
			results.push({
				memory: candidate.item.memory,
				score: candidate.score,
				stale: candidate.stale,
				snippet: excerpt.text,
				lineStart: excerpt.lineStart,
				lineEnd: excerpt.lineEnd,
				sourceDigest: candidate.item.sourceDigest,
			});
		}
		const receiptSeed = canonicalDigest({ requestId: request.requestId, indexDigest: index.indexDigest, results, offset });
		return {
			schemaVersion: 1,
			authorityId: request.authorityId,
			tenantId: request.tenantId,
			principalId: request.principalId,
			requestId: request.requestId,
			receiptId: createRuntimeId("receipt", `memory-search-${receiptSeed.slice(0, 40)}`),
			queryDigest: request.queryDigest,
			mode: "lexical",
			indexDigest: index.indexDigest,
			results,
			...(cursor < candidates.length ? { nextCursor: encodeCursor({ offset: cursor, indexDigest: index.indexDigest, queryDigest: request.queryDigest }) } : {}),
			diagnostics: rebuilt ? ["lexical_index_rebuilt"] : [],
			searchedAt: now.toISOString(),
		};
	}
}
