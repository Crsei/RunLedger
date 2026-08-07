/** Durable workspace-scoped Host generation allocator. */

import { randomUUID } from "node:crypto";
import { lstat, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { RunledgerLayout } from "../../runtime/contracts/storage-layout.ts";
import { hostStateRelativeLocator } from "../../runtime/contracts/storage-layout.ts";
import { ensureContainedHostStoreDirectory } from "./store-path-safety.ts";

export class HostGenerationStore {
	private readonly path: string;
	private readonly layout: RunledgerLayout;

	public constructor(layout: RunledgerLayout, workspaceStorageKey: string) {
		this.layout = layout;
		this.path = join(layout.home, hostStateRelativeLocator(workspaceStorageKey), "generation.json");
	}

	/** Caller serializes allocation through the workspace startup election. */
	public async allocate(): Promise<number> {
		const current = await this.read();
		const next = current + 1;
		if (!Number.isSafeInteger(next) || next < 1) throw new Error("host_generation_exhausted");
		await ensureContainedHostStoreDirectory(this.layout.home, dirname(this.path));
		await assertRegularOrMissing(this.path);
		const staging = `${this.path}.${randomUUID()}.tmp`;
		try {
			await writeFile(staging, `${JSON.stringify({ version: 1, generation: next })}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
			const handle = await open(staging, "r+");
			try { await handle.sync(); } finally { await handle.close(); }
			await ensureContainedHostStoreDirectory(this.layout.home, dirname(this.path));
			await assertRegularOrMissing(this.path);
			await rename(staging, this.path);
		} finally {
			await unlink(staging).catch(() => undefined);
		}
		return next;
	}

	public async current(): Promise<number> {
		return this.read();
	}

	private async read(): Promise<number> {
		let content: string;
		try {
			await ensureContainedHostStoreDirectory(this.layout.home, dirname(this.path));
			await assertRegularOrMissing(this.path);
			content = await readFile(this.path, "utf8");
		} catch (error) {
			if (isNotFound(error)) return 0;
			throw error;
		}
		let parsed: unknown;
		try { parsed = JSON.parse(content) as unknown; } catch { throw new Error("host_generation_store_invalid"); }
		if (!isRecord(parsed) || parsed.version !== 1 || !Number.isSafeInteger(parsed.generation) || (parsed.generation as number) < 1) {
			throw new Error("host_generation_store_invalid");
		}
		return parsed.generation as number;
	}
}

function isNotFound(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function assertRegularOrMissing(path: string): Promise<void> {
	try {
		const info = await lstat(path);
		if (info.isSymbolicLink()) throw new Error("Host generation symlink is not allowed");
		if (!info.isFile()) throw new Error("Host generation must be a regular file");
	} catch (error) {
		if (!isNotFound(error)) throw error;
	}
}
