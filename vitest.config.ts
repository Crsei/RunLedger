import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // 测试与仓库源码同源运行（与其它 src 测试一致），不要求先构建 collab-web；
    // 构建产物由 check:collab-web 与真实 runledger web 验证覆盖。
    alias: {
      "@runledger/collab-web/contracts": fileURLToPath(new URL("packages/collab-web/src/contracts/index.ts", import.meta.url)),
    },
  },
  test: {
    include: ["tests/**/*.test.ts", "packages/*/test/**/*.test.ts"],
    exclude: ["tests/**/*.bun.test.ts"],
    environment: "node",
    globals: false,
    // Windows 无 git-bash、进程启动/关闭更慢;默认 5s 上限在并行全量跑时
    // 容易误超时。统一放宽为 15s,慢测试仍应显式声明更长 timeout。
    testTimeout: 15000,
    // Windows 上部分 Linux-only 套件整体 skip 后文件内无已收集测试,
    // 视为通过而不是判为失败。
    passWithNoTests: true,
    server: {
      deps: {
        external: [/node:sqlite/]
      }
    }
  }
});
