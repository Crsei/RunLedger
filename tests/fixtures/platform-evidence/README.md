# 平台证据 fixtures（P1，不可变）

本目录保存多平台 workspace/path 适配计划 P1 的**真实 runner 原始证据**。每个平台一个子目录：

- `linux/` —— 2026-08-06 在真实 Linux runner（`uname`/Node/Git/Shell 版本见
  `linux/evidence.json#runner`）采集；由 `scripts/collect-platform-evidence.ts` 生成。
- `macos/`、`windows/` —— 当前仓库没有对应真实 runner，**不存在**；任何采集
  完成前不得用模拟 fixture 或 Linux 结果冒充。

## 不可变约定

1. 目录内容由 `scripts/collect-platform-evidence.ts --out <staging>` 生成后整体拷入，
   **不手工改写** `evidence.json` 或 `raw/*.txt`；
2. `manifest.json` 是 `evidence.json` + `raw/*` 的 SHA-256 digest 清单；
   `tests/workspace/platform-evidence.test.ts` 每次运行验证 digest 一致，
   任何静默修改都会失败；
3. 重新采集必须在真实 runner 上运行脚本生成**新的 staging**，审阅后整体替换；
   替换意味着本平台证据快照更新（collector 或 runner 升级），而不是“修数据”；
4. 纯解析回归 fixture 属于 `tests/fixtures/workspace/`，与本目录职责分开：
   本目录只存放真实 runner 原始输出。

## 当前证据矩阵状态（P1 2026-08-06）

| 证据 | Linux | macOS | Windows |
|---|---|---|---|
| native absolute/candidate path | 已采集 | gap | gap |
| case-preserving compare identity | 已采集（case-sensitive ext） | gap | gap |
| symlink/junction/reparse containment | 已采集（symlink） | gap | gap |
| Git porcelain create/list/remove | 已采集 | gap | gap |
| source subdir + bare repo | 已采集 | gap | gap |
| startup Shell | 已采集（bash/sh/zsh） | gap | gap |
| process-tree termination | 已采集（process group） | gap | gap |
| occupied-file cleanup | 已采集（POSIX unlink） | gap | gap |
| persisted locator cold resume | 已采集（同平台） | gap | gap |
| cross-platform locator open | typed unsupported（设计决策，非证据） | — | — |

gap 明细见 `development-doc/worktree-sandbox-permisson/evidence-verification-gaps.md`。
