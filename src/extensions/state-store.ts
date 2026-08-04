/** extensions-state.json 的 0600 原子状态存储。 */

import type { ExtensionStateDocument, ExtensionStateEntry } from "./types.ts";
import type { ExtensionStoragePort } from "./storage-port.ts";

const emptyState = (): ExtensionStateDocument => ({ revision: 0, resources: {} });

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseState(value: unknown): ExtensionStateDocument | undefined {
	if (!isRecord(value) || typeof value.revision !== "number" || !Number.isSafeInteger(value.revision) || value.revision < 0 || !isRecord(value.resources)) return undefined;
	const resources: Record<string, ExtensionStateEntry> = {};
	for (const [key, item] of Object.entries(value.resources)) {
		if (!isRecord(item) || typeof item.enabled !== "boolean" || typeof item.updatedAt !== "string") return undefined;
		resources[key] = { enabled: item.enabled, updatedAt: item.updatedAt };
	}
	return { revision: value.revision, resources };
}

export class ExtensionStateStore {
	readonly #path: string;
	readonly #storage: ExtensionStoragePort;
	#unknown: Readonly<Record<string, unknown>> = {};
	#loadError: string | undefined;

	public constructor(path: string, storage: ExtensionStoragePort) {
		this.#path = path;
		this.#storage = storage;
	}

	public async load(): Promise<ExtensionStateDocument> {
		const read = await this.#storage.readFile(this.#path, 1024 * 1024);
		if (!read.ok) {
			this.#loadError = read.code === "missing" ? undefined : read.message;
			return emptyState();
		}
		try {
			const parsedValue: unknown = JSON.parse(Buffer.from(read.value).toString("utf8"));
			const parsed = parseState(parsedValue);
			if (!parsed || !isRecord(parsedValue)) {
				this.#loadError = "extensions-state.json failed schema validation";
				return emptyState();
			}
			const { revision: _revision, resources: _resources, ...unknown } = parsedValue;
			this.#unknown = unknown;
			this.#loadError = undefined;
			return parsed;
		} catch {
			this.#loadError = "extensions-state.json is invalid JSON";
			return emptyState();
		}
	}

	public loadError(): string | undefined {
		return this.#loadError;
	}

	public async setEnabled(resourceId: string, enabled: boolean, at = new Date()): Promise<ExtensionStateDocument> {
		const current = await this.load();
		const next: ExtensionStateDocument = {
			revision: current.revision + 1,
			resources: { ...current.resources, [resourceId]: { enabled, updatedAt: at.toISOString() } },
		};
		await this.save(next);
		return next;
	}

	public async save(document: ExtensionStateDocument): Promise<void> {
		const written = await this.#storage.writeFileAtomic(this.#path, Buffer.from(`${JSON.stringify({ ...this.#unknown, ...document }, null, 2)}\n`, "utf8"), { fileMode: 0o600, directoryMode: 0o700 });
		if (!written.ok) throw new Error(written.message);
	}
}
