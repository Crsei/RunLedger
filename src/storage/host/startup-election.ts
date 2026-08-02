/** Launcher-only startup election; Host writer/session lock remains the final fence. */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import lockfile from "proper-lockfile";

export type StartupElectionResult =
	| { readonly ok: true; readonly release: () => Promise<void> }
	| { readonly ok: false; readonly code: "startup_election_lost" };

export async function acquireStartupElection(targetPath: string): Promise<StartupElectionResult> {
	await mkdir(dirname(targetPath), { recursive: true, mode: 0o700 });
	await writeFile(targetPath, "runledger startup election\n", { encoding: "utf8", flag: "a", mode: 0o600 });
	try {
		const releaseLock = await lockfile.lock(targetPath, {
			retries: 0,
			stale: 10_000,
			realpath: false,
			lockfilePath: `${targetPath}.lock`,
		});
		return {
			ok: true,
			release: async () => {
				await releaseLock();
			},
		};
	} catch {
		return { ok: false, code: "startup_election_lost" };
	}
}
