# OS Sandbox 跨平台扩展封存记录

> 文档属性：封存记录，不是可执行计划，也不拥有当前状态。
>
> 封存日期：2026-08-06。
>
> 当前入口：[`../00-worktree-sandbox-permission-plan.md`](../00-worktree-sandbox-permission-plan.md)。
>
> 替代计划：[`../01-multiplatform-workspace-path-adaptation-plan.md`](../01-multiplatform-workspace-path-adaptation-plan.md)。

## 1. 封存决定

RunLedger 暂停继续实现或扩展多平台 OS sandbox。此前围绕 Linux bwrap、macOS Seatbelt、Windows native helper/Restricted Token、跨平台 denial 分类和平台 capability 声明的后续改动全部封存，直到多平台 workspace/path 适配计划完成真实平台验证。

封存不等于回滚当前安全边界：

- 不删除现有 `src/security/sandbox/**`、Host final-leaf receipt、ExecutionGateway 或相关测试；
- 不把 restrictive profile 静默降级到 raw shell、builtin `none` 或 client-local execution；
- backend unavailable 时继续 fail closed；
- 已有 Linux bwrap E2E 只作为当前 Linux checkout 的历史/回归证据，不构成 Windows、macOS 或发布级多平台承诺；
- 除修复明确安全漏洞或恢复既有 fail-closed 行为外，不接受 sandbox backend 功能变更。

## 2. 被封存的原路线

原计划准备继续推进以下内容：

1. 扩展统一 `SandboxBackend.probe/prepare/validateFinalLeaf` 平台能力；
2. 完善 Linux bwrap filesystem/network enforcement；
3. 完成 macOS Seatbelt 真实 runner enforcement；
4. 为 Windows 设计 native helper、Restricted Token 或其他等价强边界；
5. 把 workspace root、deny-read、protected paths 和 network policy 物化为各平台启动计划；
6. 统一平台 denial、degraded reason、attestation 与 enforcement receipt；
7. 为 Linux、macOS、Windows 建立发布级 capability/CI 矩阵。

这些任务不再是当前执行队列。原 Phase 4 与 M4 中的完成标记只能解释为封存前的本地实现证据，不能作为恢复工作或宣称多平台完成的依据。

## 3. 封存原因

OS sandbox 的强制边界依赖正确的平台路径语义。当前以下问题尚未形成真实 runner 证据支持的统一契约：

- POSIX、Windows drive、UNC、长路径和路径大小写的 canonical identity；
- existing path 与待创建 path 的 canonicalization 差异；
- symlink、junction、reparse point 与跨 volume worktree 的 containment；
- Git porcelain 路径、数据库持久化路径和 native process cwd 之间的可逆转换；
- Bash/Zsh/Sh、PowerShell/pwsh/Git Bash/cmd 的命令与参数边界；
- Windows 文件占用、fsmonitor、删除重试和进程树回收；
- Host-private absolute path、公共 DTO redaction 与 session resume identity 的一致性。

在这些问题未关闭前继续扩展 sandbox，会把路径适配缺陷误写成安全策略，或者让一个平台的假设泄漏到其他平台。

## 4. 恢复条件

只有同时满足以下条件，才能新建 sandbox 解封 ADR；不得直接从本文继续编码：

- 多平台 workspace/path 适配计划 P0–P6 全部完成；
- Linux、Windows、macOS 真实 runner 均保存 path/worktree/shell/process evidence；
- persisted locator 与 native path 的转换契约已版本化，并有 cold resume/migration 证据；
- Git worktree create/list/remove/reset 在三个平台均通过真实 E2E；
- Host final leaf 只消费平台适配器输出，不散落新的 `process.platform` 路径分支；
- 安全评审确认 canonicalization、symlink/junction、TOCTOU 和 protected roots 的平台语义；
- 产品能力矩阵明确区分 workspace isolation、permission、external containment 与 OS sandbox enforcement。

## 5. 解封后的重新规划要求

解封时必须重新编写 ADR 和实现计划，重新确认 backend 选择、helper 供应链、签名、打包、CI runner 和真实 enforcement。不得默认沿用以下旧结论：

- macOS `sandbox-exec` 仍适合作为可承诺的长期 backend；
- Windows Restricted Token 单独足以表达 filesystem/network/process-tree 边界；
- Linux bwrap 的 mount/path 输入可直接复用于 Windows/macOS；
- fixture 或 compile-time 分支可以替代真实平台验证；
- OpenCode 的 Git worktree “sandbox” 等于 OS 安全沙箱。

## 6. 当前允许的维护

封存期间只允许：

- 保持或加强 restrictive backend unavailable 时的 fail-closed 回归；
- 修复已确认的安全漏洞；
- 修复因平台适配计划导致的接口编译漂移，但不得增加 backend 能力；
- 更新 capability 文案，使其不夸大平台支持；
- 保留现有 Linux enforced 测试，不把缺少其他平台证据标记为通过。
