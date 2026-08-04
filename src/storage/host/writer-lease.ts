/** Workspace-scoped Host writer lease used by connect-or-spawn admission. */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import lockfile from "proper-lockfile";
import { hostStateRelativeLocator, type RunledgerLayout } from "../../runtime/contracts/storage-layout.ts";

export type HostWriterLeaseResult =
	| { readonly ok: true; readonly release: () => Promise<void> }
	| { readonly ok: false; readonly code: "host_writer_lease_lost" };

export function hostWriterLeasePath(layout: RunledgerLayout, workspaceStorageKey: string): string {
	return join(layout.home, hostStateRelativeLocator(workspaceStorageKey), "writer-lease");
}

export async function acquireHostWriterLease(
	layout: RunledgerLayout,
	workspaceStorageKey: string,
): Promise<HostWriterLeaseResult> {
	const path = hostWriterLeasePath(layout, workspaceStorageKey);
	try {
		await mkdir(dirname(path), { recursive: true, mode: 0o700 });
		await writeFile(path, "runledger host writer lease\n", { encoding: "utf8", flag: "a", mode: 0o600 });
		const releaseLock = await lockfile.lock(path, {
			retries: 0,
			stale: 10_000,
			realpath: false,
			lockfilePath: `${path}.lock`,
		});
		return {
			ok: true,
			release: async () => {
				await releaseLock();
			},
		};
	} catch {
		return { ok: false, code: "host_writer_lease_lost" };
	}
}

export async function isHostWriterLeaseActive(
	layout: RunledgerLayout,
	workspaceStorageKey: string,
): Promise<boolean> {
	try {
		return await lockfile.check(hostWriterLeasePath(layout, workspaceStorageKey), { realpath: false });
	} catch {
		return false;
	}
}
