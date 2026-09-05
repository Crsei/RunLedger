#!/usr/bin/env node
/**
 * RunLedger npm bin launcher。
 *
 * 旧实现是 POSIX shell 脚本(`#!/bin/sh` + `exec bun ...`),Linux/macOS 上
 * npm 会创建指向它的符号链接由 shell 执行;但 Windows 上 npm 的 .cmd shim
 * 直接用 `node` 运行 bin 目标,shell 脚本被 node 当 JS 解析直接 SyntaxError。
 *
 * 统一改为 Node launcher:定位 package 目录(import.meta.url 已解析真实路径,
 * 兼容 npm link)→ spawn `bun dist/cli/cli.js` 并把退出码
 * 透传。POSIX 上直接执行时由 `#!/usr/bin/env node` 承载。
 */

import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = dirname(dirname(fileURLToPath(import.meta.url)));
const cliPath = join(packageDir, "dist", "cli", "cli.js");

// 不阻塞 Node 事件循环，确保按 launcher PID 停止时能通知并等待实际运行时。
const child = spawn("bun", [cliPath, ...process.argv.slice(2)], { stdio: "inherit" });
const forwardedSignals = ["SIGINT", "SIGTERM", "SIGHUP"];
const handlers = new Map();
for (const signal of forwardedSignals) {
  const handler = () => child.kill(signal);
  handlers.set(signal, handler);
  process.on(signal, handler);
}

child.once("error", (error) => {
  process.stderr.write(error.code === "ENOENT"
    ? "[runledger] Bun >= 1.3.0 is required for the OpenTUI renderer. Install Bun and retry.\n"
    : "[runledger] Failed to start the Bun runtime.\n");
  process.exitCode = 127;
});
child.once("close", (code, signal) => {
  for (const [name, handler] of handlers) process.removeListener(name, handler);
  // 正常 cleanup 的退出码由 child 决定；未处理的信号保留原有终止语义。
  if (signal !== null) process.kill(process.pid, signal);
  else process.exitCode ??= code ?? 1;
});
