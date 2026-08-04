/** Extension 只消费这个最小、可注入的存储端口。 */

export type ExtensionStorageEntryKind = "file" | "directory" | "symlink" | "other";

export interface ExtensionStorageEntry {
	readonly name: string;
	readonly kind: ExtensionStorageEntryKind;
}

export interface ExtensionStorageStat {
	readonly kind: ExtensionStorageEntryKind;
	readonly size: number;
}

export type ExtensionStorageResult<T> =
	| { readonly ok: true; readonly value: T }
	| { readonly ok: false; readonly code: "missing" | "denied" | "oversize" | "io"; readonly message: string };

export interface ExtensionStoragePort {
	realpath(path: string): Promise<ExtensionStorageResult<string>>;
	stat(path: string, options?: { readonly followSymlinks?: boolean }): Promise<ExtensionStorageResult<ExtensionStorageStat>>;
	readDirectory(path: string): Promise<ExtensionStorageResult<readonly ExtensionStorageEntry[]>>;
	readFile(path: string, maxBytes: number): Promise<ExtensionStorageResult<Uint8Array>>;
	writeFileAtomic(path: string, bytes: Uint8Array, options: { readonly fileMode: 0o600; readonly directoryMode: 0o700 }): Promise<ExtensionStorageResult<void>>;
}
