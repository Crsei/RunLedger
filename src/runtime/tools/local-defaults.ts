/**
 * 内置工具的唯一本地默认 IO 构造点。
 *
 * 低层库默认（无注入 ops 时）从 `localExecutionEnv()` 派生 read/write/edit/
 * bash/grep/find/glob/ls/web-fetch 的 fs/shell/network 操作，供单元测试与
 * 直接库使用。生产工具集必须经 `createStdlibTools(requireExecutionEnv: true)`
 * 注入 governed ExecutionEnv；本文件是静态边界检查中唯一允许调用
 * `localExecutionEnv` 的工具文件（scripts/check-execution-boundaries.ts），
 * 防止未来在工具 execute 路径重新引入 raw I/O 旁路。
 */

import { localExecutionEnv, type FileSystem, type Network, type Shell } from "../execution-env.ts";
import type { BashOperations } from "./bash.ts";
import type { EditOperations } from "./edit.ts";
import type { GlobOperations } from "./glob.ts";
import type { LsOperations } from "./ls.ts";
import type { ReadOperations } from "./read.ts";
import type { WriteOperations } from "./write.ts";

/** read 默认 ops：本地 fs 读 + stat。 */
export function localReadOperations(): ReadOperations {
  const fs: FileSystem = localExecutionEnv().fs;
  return {
    readFile: (p) => fs.readFile(p),
    access: async (p) => { await fs.stat(p); },
    stat: async (p) => ({ mtimeMs: (await fs.stat(p)).mtimeMs }),
  };
}

/** write 默认 ops：本地 fs 写 + 递归 mkdir。 */
export function localWriteOperations(): WriteOperations {
  const fs: FileSystem = localExecutionEnv().fs;
  return {
    writeFile: (p, content) => fs.writeFile(p, content),
    mkdir: async (dir) => { await fs.mkdir(dir, { recursive: true }); },
  };
}

/** edit 默认 ops：本地 fs 读改写。 */
export function localEditOperations(): EditOperations {
  const fs: FileSystem = localExecutionEnv().fs;
  return {
    readFile: (p) => fs.readFile(p),
    writeFile: (p, content) => fs.writeFile(p, content),
    access: async (p) => { await fs.stat(p); },
  };
}

/** bash 默认 ops：本地 shell exec；后台入口仍由 Host manager 决定。 */
export function localBashOperations(): BashOperations {
  const shell: Shell = localExecutionEnv().shell;
  return {
    async exec(cmd, opts) {
      return shell.exec(cmd, opts);
    },
  };
}

/** grep 默认 shell。 */
export function localGrepShell(cwd: string): Shell {
  return localExecutionEnv(cwd).shell;
}

/** find 默认 shell。 */
export function localFindShell(cwd: string): Shell {
  return localExecutionEnv(cwd).shell;
}

/** glob 默认 ops：本地 fs readdir/stat。 */
export function localGlobOperations(): GlobOperations {
  const fs: FileSystem = localExecutionEnv().fs;
  return {
    readdir: (p) => fs.readdir(p),
    stat: async (p) => {
      const s = await fs.stat(p);
      return { isDirectory: s.isDirectory, mtimeMs: s.mtimeMs, isSymbolicLink: s.isSymbolicLink === true };
    },
  };
}

/** ls 默认 ops：本地 fs exists/stat/readdir。 */
export function localLsOperations(): LsOperations {
  const fs: FileSystem = localExecutionEnv().fs;
  return {
    exists: async (p) => {
      try { await fs.stat(p); return true; } catch { return false; }
    },
    stat: async (p) => {
      const value = await fs.stat(p);
      return { isDirectory: () => value.isDirectory };
    },
    readdir: (p) => fs.readdir(p),
  };
}

/** web-fetch 默认 network。 */
export function localNetwork(): Network {
  const network = localExecutionEnv().network;
  if (network === undefined) {
    return { request: async () => { throw new Error("Host network port is unavailable"); } };
  }
  return network;
}

/** multi-edit 默认 fs。 */
export function localMultiEditFileSystem(cwd: string): FileSystem {
  return localExecutionEnv(cwd).fs;
}
