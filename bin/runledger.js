#!/usr/bin/env node
/**
 * `runledger` CLI shim —— 通过 `node --import tsx` 跑 src/cli/cli.ts。
 *
 * 原因:
 *   - 本仓库 type:module,bin 不能 require 任何代码;
 *   - 但 tsx 是 devDependency,生产部署需 npm install 后再 npm link -
 *     不出 dist 也能跑(开发期可用)。后期出 dist/cli/cli.js 后可改该 bin
 *     为 `import('../dist/cli/cli.js')`。
 *
 * 策略:`spawnSync('node', ['--import', 'tsx', src/cli/cli.ts, ...args])` 透传 stdio。
 */

import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const cliSrc = resolve(repoRoot, "src", "cli", "cli.ts");

const result = spawnSync(
  process.execPath,
  ["--import", "tsx", cliSrc, ...process.argv.slice(2)],
  { stdio: "inherit" },
);

if (result.status !== null && result.status !== 0) {
  process.exit(result.status);
}
