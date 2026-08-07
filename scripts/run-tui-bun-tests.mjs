/**
 * test:tui-native 的跨平台入口。
 *
 * npm script 里 `bun test tests/tui/*.bun.test.ts` 依赖 shell 展开通配符,
 * Windows cmd 不展开会导致 "no test files matched"。这里在 Node 里展开
 * glob 后显式把文件列表传给 bun,Linux/macOS/Windows 行为一致。
 */

import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const tuiDir = join(repoRoot, "tests", "tui");
const files = readdirSync(tuiDir)
	.filter((name) => name.endsWith(".bun.test.ts"))
	.sort()
	.map((name) => join(tuiDir, name));

if (files.length === 0) {
	console.error("no *.bun.test.ts found under tests/tui");
	process.exit(1);
}

const result = spawnSync("bun", ["test", ...files], { stdio: "inherit", shell: false });
process.exit(result.status ?? 1);
