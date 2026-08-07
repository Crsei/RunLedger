#!/usr/bin/env node
/**
 * RunLedger npm bin launcher。
 *
 * 旧实现是 POSIX shell 脚本(`#!/bin/sh` + `exec bun ...`),Linux/macOS 上
 * npm 会创建指向它的符号链接由 shell 执行;但 Windows 上 npm 的 .cmd shim
 * 直接用 `node` 运行 bin 目标,shell 脚本被 node 当 JS 解析直接 SyntaxError。
 *
 * 统一改为 Node launcher:定位 package 目录(import.meta.url 已解析真实路径,
 * 兼容 npm link)→ 校验 bun 可用 → spawn `bun dist/cli/cli.js` 并把退出码
 * 透传。POSIX 上直接执行时由 `#!/usr/bin/env node` 承载。
 */

import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = dirname(dirname(fileURLToPath(import.meta.url)));
const cliPath = join(packageDir, "dist", "cli", "cli.js");

const probe = spawnSync("bun", ["--version"], { stdio: "ignore" });
if (probe.error || probe.status !== 0) {
  process.stderr.write("[runledger] Bun >= 1.3.0 is required for the OpenTUI renderer. Install Bun and retry.\n");
  process.exit(127);
}

const result = spawnSync("bun", [cliPath, ...process.argv.slice(2)], { stdio: "inherit" });
process.exit(result.status ?? 1);
