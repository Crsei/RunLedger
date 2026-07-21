#!/usr/bin/env node
/**
 * RunLedger CLI bin 入口 —— 直接调用 src/cli/main.ts 的 main()。
 *
 * 这个文件编译为 dist/cli/cli.js,由 bin/runledger.js 加载。本文件本身只做:
 *   1. 从 process.argv.slice(2) 取参
 *   2. 调 main + .catch(exit 1)
 *
 * 业务逻辑全部留在 src/cli/main.ts 以便单测直接 import;此文件不引 vitest。
 */

import { main } from "./main.ts";

main(process.argv.slice(2)).catch((err: unknown) => {
  process.stderr.write(`[runledger] fatal: ${String(err)}\n`);
  if (err instanceof Error && err.stack && process.env.RUNLEDGER_DEBUG === "1") {
    process.stderr.write(err.stack + "\n");
  }
  process.exit(1);
});
