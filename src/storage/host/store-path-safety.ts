/** Host durable-store path containment and symlink checks. */

import { lstat, mkdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export async function ensureContainedHostStoreDirectory(home: string, target: string): Promise<void> {
	const resolvedHome = resolve(home);
	const resolvedTarget = resolve(target);
	const targetRelative = relative(resolvedHome, resolvedTarget);
	if (escapesRoot(targetRelative)) throw new Error("Host store directory containment violation");
	await mkdir(resolvedHome, { recursive: true, mode: 0o700 });
	await assertSafeDirectory(resolvedHome, resolvedHome);
	let current = resolvedHome;
	for (const segment of targetRelative.split(sep).filter((value) => value.length > 0)) {
		current = join(current, segment);
		try {
			await mkdir(current, { mode: 0o700 });
		} catch (error) {
			if (!isAlreadyExists(error)) throw error;
		}
		await assertSafeDirectory(resolvedHome, current);
	}
}

async function assertSafeDirectory(home: string, candidate: string): Promise<void> {
	const info = await lstat(candidate);
	if (info.isSymbolicLink()) throw new Error("Host store ancestor symlink is not allowed");
	if (!info.isDirectory()) throw new Error("Host store ancestor must be a directory");
	const candidateRelative = relative(await realpath(home), await realpath(candidate));
	if (escapesRoot(candidateRelative)) throw new Error("Host store directory containment violation");
}

function escapesRoot(candidateRelative: string): boolean {
	return candidateRelative === ".." || candidateRelative.startsWith(`..${sep}`) || isAbsolute(candidateRelative);
}

function isAlreadyExists(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}
