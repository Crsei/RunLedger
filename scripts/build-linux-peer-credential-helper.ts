/** Build the tiny Linux SO_PEERCRED probe used by the production Host attestor. */

import { chmod, mkdir, rename, stat, unlink } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";

function runCompiler(source: string, output: string): Promise<void> {
	return new Promise((resolveRun, rejectRun) => {
		const child = spawn("cc", [
			"-std=c11",
			"-O2",
			"-fstack-protector-strong",
			"-D_FORTIFY_SOURCE=2",
			"-Wall",
			"-Wextra",
			"-Werror",
			source,
			"-o",
			output,
		], { stdio: ["ignore", "inherit", "inherit"] });
		child.once("error", rejectRun);
		child.once("exit", (code, signal) => {
			if (code === 0) resolveRun();
			else rejectRun(new Error(`Linux peer credential helper compiler failed: ${signal ?? code ?? "unknown"}`));
		});
	});
}

export async function buildLinuxPeerCredentialHelper(
	output = resolve("dist/native/runledger-linux-peer-credential"),
): Promise<void> {
	if (process.platform !== "linux") return;
	const source = resolve("native/linux-peer-credential.c");
	await mkdir(dirname(output), { recursive: true, mode: 0o700 });
	const temporary = `${output}.partial-${process.pid}`;
	await unlink(temporary).catch(() => undefined);
	try {
		await runCompiler(source, temporary);
		await chmod(temporary, 0o700);
		const metadata = await stat(temporary);
		if (!metadata.isFile() || metadata.size < 1_024) throw new Error("Linux peer credential helper output is invalid");
		await rename(temporary, output);
	} finally {
		await unlink(temporary).catch(() => undefined);
	}
}

if (import.meta.url === `file://${process.argv[1]}`) {
	await buildLinuxPeerCredentialHelper();
}
