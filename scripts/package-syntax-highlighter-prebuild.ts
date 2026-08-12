/** CI 把单一 runner-native addon 装配为 target-specific optional npm package。 */

import { createHash } from "node:crypto";
import { copyFile, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const target = process.argv[2];
if (target === undefined || !/^(?:linux-(?:x64|arm64)-(?:gnu|musl)|darwin-(?:x64|arm64)|win32-(?:x64|arm64)-msvc)$/u.test(target)) {
	throw new Error("syntax prebuild target is invalid");
}
const directory = resolve(`npm/syntax-highlighter-${target}`);
const source = resolve("dist/native/runledger-syntax-highlighter.node");
const destination = resolve(directory, "runledger-syntax-highlighter.node");
await copyFile(source, destination);
const bytes = await readFile(destination);
const digest = createHash("sha256").update(bytes).digest("hex");
await writeFile(resolve(directory, "checksums.json"), `${JSON.stringify({ algorithm: "sha256", files: { "runledger-syntax-highlighter.node": digest } }, null, 2)}\n`);
await copyFile(resolve("development-doc/tui/23-codex-syntax-highlighting-license-manifest.md"), resolve(directory, "NOTICE.md"));
const acknowledgement = spawnSync("cargo", [
	"run", "--quiet", "--locked", "--manifest-path", resolve("native/syntax-highlighter/Cargo.toml"), "--bin", "generate-acknowledgements",
], { encoding: "utf8", shell: false });
if (acknowledgement.status !== 0) throw new Error(acknowledgement.stderr || "generate-acknowledgements failed");
await writeFile(resolve(directory, "THIRD_PARTY_NOTICES.md"), acknowledgement.stdout);
