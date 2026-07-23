/** extensions-state.json 的 0600 原子状态存储。 */

import type { ExtensionStateDocument } from "./types.ts";
import type { ExtensionStoragePort } from "./storage-port.ts";

interface LoadedState {
	document: ExtensionStateDocument;
	unknown: Readonly<Record<string, unknown>>;
}

const emptyState = (): ExtensionStateDocument => ({ schemaVersion: 1, revision: 0, resources: {} });

function parseState(value: unknown): LoadedState | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	if (record.schemaVersion !== 1 || !Number.isSafeInteger(record.revision) || typeof record.resources !== "object" || record.resources === null || Array.isArray(record.resources)) return undefined;
	const resources: Record<string, { enabled: boolean; updatedAt: string }> = {};
	for (const [key, item] of Object.entries(record.resources as Record<string, unknown>)) {
		if (typeof item !== "object" || item === null || Array.isArray(item)) return undefined;
		const entry = item as Record<string, unknown>;
		if (typeof entry.enabled !== "boolean" || typeof entry.updatedAt !== "string") return undefined;
		resources[key] = { enabled: entry.enabled, updatedAt: entry.updatedAt };
	}
	const { schemaVersion: _schemaVersion, revision: _revision, resources: _resources, ...unknown } = record;
	return { document: { schemaVersion: 1, revision: record.revision as number, resources }, unknown };
}

export class ExtensionStateStore {
	readonly #path: string;
	readonly #storage: ExtensionStoragePort;
	#unknown: Readonly<Record<string, unknown>> = {};

	public constructor(path: string, storage: ExtensionStoragePort) {
		this.#path = path;
		this.#storage = storage;
	}

	public async load(): Promise<ExtensionStateDocument> {
		try {
			const read = await this.#storage.readFile(this.#path, 1024 * 1024);
			if (!read.ok) return emptyState();
			const parsed = parseState(JSON.parse(Buffer.from(read.value).toString("utf8")));
			if (!parsed) return emptyState();
			this.#unknown = parsed.unknown;
			return parsed.document;
		} catch {
			return emptyState();
		}
	}

	public async setEnabled(resourceId: string, enabled: boolean, at = new Date()): Promise<ExtensionStateDocument> {
		const current = await this.load();
		const next: ExtensionStateDocument = {
			schemaVersion: 1,
			revision: current.revision + 1,
			resources: { ...current.resources, [resourceId]: { enabled, updatedAt: at.toISOString() } },
		};
		await this.save(next);
		return next;
	}

	public async save(document: ExtensionStateDocument): Promise<void> {
		const written = await this.#storage.writeFileAtomic(this.#path, Buffer.from(`${JSON.stringify({ ...this.#unknown, ...document }, null, 2)}\n`), { fileMode: 0o600, directoryMode: 0o700 });
		if (!written.ok) throw new Error(written.message);
	}
}
