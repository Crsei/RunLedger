import { mkdir, open, readFile, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { canonicalDigest } from "../runtime/protocol/v3/canonical-json.ts";
import type { SessionId } from "../runtime/protocol/v3/ids.ts";

export interface SessionExtractionLease {
	release(): Promise<void>;
}

/** open(wx) 提供跨进程一次性 lease；过期 lease 只由显式维护流程清理。 */
export async function acquireSessionExtractionLease(options: {
	path: string;
	sessionId: SessionId;
	owner: string;
	now: Date;
	ttlMs: number;
}): Promise<SessionExtractionLease | undefined> {
	await mkdir(dirname(options.path), { recursive: true, mode: 0o700 });
	let handle;
	try {
		handle = await open(options.path, "wx", 0o600);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") return undefined;
		throw error;
	}
	const body = {
		sessionId: options.sessionId,
		owner: options.owner.slice(0, 128),
		acquiredAt: options.now.toISOString(),
		expiresAt: new Date(options.now.getTime() + Math.max(1_000, options.ttlMs)).toISOString(),
	};
	try {
		await handle.writeFile(`${JSON.stringify(body)}\n`, "utf8");
		await handle.sync();
	} finally {
		await handle.close();
	}
	let released = false;
	return {
		release: async () => {
			if (released) return;
			released = true;
			const current = await readFile(options.path, "utf8").catch(() => "");
			if (canonicalDigest(current) === canonicalDigest(`${JSON.stringify(body)}\n`)) {
				await unlink(options.path).catch(() => undefined);
			}
		},
	};
}
