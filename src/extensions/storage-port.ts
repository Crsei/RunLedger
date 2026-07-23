/**
 * Extension 只消费这个最小 storage port；Node/fs adapter 由串行 composition
 * root 通过受限 storage/Gateway 边界提供。
 */

export type ExtensionStorageEntryKind = "file" | "directory" | "symlink" | "other";

export interface ExtensionStorageEntry {
	name: string;
	kind: ExtensionStorageEntryKind;
}

export interface ExtensionStorageStat {
	kind: ExtensionStorageEntryKind;
	size: number;
}

export type ExtensionStorageResult<T> =
	| { ok: true; value: T }
	| { ok: false; code: "missing" | "denied" | "oversize" | "io"; message: string };

export interface ExtensionStoragePort {
	realpath(path: string): Promise<ExtensionStorageResult<string>>;
	stat(path: string, options?: { followSymlinks?: boolean }): Promise<ExtensionStorageResult<ExtensionStorageStat>>;
	readDirectory(path: string): Promise<ExtensionStorageResult<readonly ExtensionStorageEntry[]>>;
	readFile(path: string, maxBytes: number): Promise<ExtensionStorageResult<Uint8Array>>;
	writeFileAtomic(path: string, bytes: Uint8Array, options: { fileMode: 0o600; directoryMode: 0o700 }): Promise<ExtensionStorageResult<void>>;
}
