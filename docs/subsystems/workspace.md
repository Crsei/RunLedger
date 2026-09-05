# Workspace 与 Worktree

Workspace 子系统拥有跨平台 path identity、root/volume/share 语义、结构化 containment、versioned locator、Git worktree lifecycle、lease 和 cold-resume revalidation。它不提供 OS sandbox。

源码入口：[`src/workspace/`](../../src/workspace)、[`src/worktree/`](../../src/worktree)、[`src/runtime/session-runtime/worktree-composition.ts`](../../src/runtime/session-runtime/worktree-composition.ts)、[`src/cli/session-workspace-identity.ts`](../../src/cli/session-workspace-identity.ts)。

## Workspace identity

Session catalog 记录 workspace id 与 repository id；标准 CLI 在选择或打开 Session 前解析当前 cwd 的 repository/workspace identity，并拒绝把一个 Session 绑定到不匹配的 workspace。

路径比较不使用字符串 `startsWith`。`PathIdentity` 先解析 POSIX root、Windows drive 或 UNC share，再按平台规范化 segment/大小写；containment 只允许同 root 且 child segment 具有 parent 前缀。跨 root、device namespace、无效 locator 和缺少迁移字段都是 typed failure。

公共 execution envelope 只暴露 path/cwd digest。native absolute path 保留在 Session/Host-private context，不进入通用 protocol DTO 或审计展示。

## Adapter composition

`createWorkspaceAdaptersForCurrentPlatform()` 是生产代码的平台分支点。它组合 path syscall、Git broker、process capability 和 cleanup adapter；业务模块依赖 `WorkspaceAdapters`，不直接散布 `process.platform` 判断。

当前 factory 只为具有真实 runner 证据的平台返回 adapter。Linux 可用；macOS 与 Windows 返回 `unverified_platform`，即使对应 path/parser 实现存在也不推断为 production verified。该能力矩阵不表示 sandbox enforcement。

## Worktree lifecycle

`WorktreeManager` 管理 create/list/status/remove 与 JSONL registry，`WorktreeLeaseManager` 管理 workspace lease。managed target 必须 containment 于 `<runledgerHome>/worktrees`，Git 调用经 argv broker 而不是 shell 拼接。

Session 可以使用 source cwd，也可以创建 managed worktree。创建成功后依次获取 lease、检查 Git observation、构造 `PersistedWorkspaceBinding`，再以 `workspace.bound` event 将 locator 与 binding digest 写入 Session Store。

worktree remove 默认拒绝 dirty、active lease、根外目标或缺少明确 approval 的操作。registry event 与实际 Git result 不一致时进入可诊断失败，不把目录存在性当成完整 lifecycle state。

## Cold resume

已绑定 worktree 的 Session 在每次 owned Runtime 启动时执行：

```text
decode and validate persisted binding
  -> load exact registry record
  -> verify Session/worktree identity
  -> retain or reacquire exact lease
  -> validate locator for current platform
  -> realpath/root/Git/base/effective-subdir checks
  -> validate current observation
  -> append workspace.validation_recorded
```

任一复验失败都终止 Session domain 启动，不 fallback 到 source cwd。`--no-worktree` 不能绕过一个已持久化的 worktree binding。

## Lease 与 owner generation

lease 绑定 runtime id、revision 与 fencing-token digest。另一个 live Runtime 持有 lease 时拒绝接管；stale/expired lease 必须显式 reacquire。Runtime shutdown 按幂等路径释放 lease，旧 lease revision 的 release 不能删除新 owner 的 lease。

Workspace locator 与 Session owner fence 是互补约束：locator 证明目标身份，owner/lease 证明当前写入者。只有其中一个不能授权 filesystem 或 process effect，实际执行仍经过[工具与 Security](tools.md)。

## 稳定边界

- Workspace adapters 负责 identity、Git lifecycle 和 cleanup，不宣称 OS process confinement。
- macOS/Windows 源码适配器存在不等于标准生产 factory 可用；缺少真实 runner 证据时保持 typed unavailable。
- legacy binding 缺少当前 locator/identity 字段时要求迁移，不猜测 native path。
