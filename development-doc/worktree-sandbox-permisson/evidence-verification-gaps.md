# P1 平台证据验证缺口（verification gaps）

> 状态：随证据采集更新。本文件记录**当前 runner 无法验证**的证据矩阵条目；
> 未验证的条目不得计为通过，不得以模拟 fixture、单平台推断或 skip 代替。
>
> 关联：[`01-multiplatform-workspace-path-adaptation-plan.md`](01-multiplatform-workspace-path-adaptation-plan.md) §4 证据矩阵。

## 0. 当前可验证范围（2026-08-06）

- 唯一可用 runner：Linux x86_64（版本固定见 `tests/fixtures/platform-evidence/linux/evidence.json#runner`）。
- macOS、Windows 真实 runner 未接入；下列全部条目为 gap。

## 1. macOS（darwin）gap 清单

| 证据 | 所需 runner 与工具 | 状态 |
|---|---|---|
| native absolute/candidate path | macOS runner + Node | gap |
| case-preserving compare identity（APFS 默认大小写不敏感但保留；大小写敏感 APFS 需分别采集） | macOS runner + APFS（两种配置） | gap |
| symlink containment | macOS runner | gap |
| Git porcelain create/list/remove | macOS runner + Git for macOS | gap |
| source subdir + bare repo | 同上 | gap |
| startup Shell（zsh 默认、bash 3.2 旧版、sh） | macOS runner | gap |
| process-tree termination（POSIX process group 在 macOS 的行为、pkill 语义） | macOS runner | gap |
| occupied-file cleanup（Finder/Spotlight/mds 索引占用） | macOS runner | gap |
| persisted locator cold resume | macOS runner | gap |

未决语义：macOS 路径 compare key 的 case policy（区分大小写 FS 与不区分），
以及 `realpath` 对 APFS firmlink 的行为。在真实 runner 证据之前，macOS
adapter 保持 typed unsupported（P4 退出条件：未通过的平台保持 unsupported）。

## 2. Windows（win32）gap 清单

| 证据 | 所需 runner 与工具 | 状态 |
|---|---|---|
| drive path / UNC path / device path 的 node:path 行为 | Windows runner + Node | gap |
| NTFS case-preserving compare identity（大小写不敏感、保留大小写） | Windows runner + NTFS | gap |
| junction / reparse point containment | Windows runner | gap |
| Git for Windows porcelain 输出（路径大小写、引号、换行） | Windows runner + Git for Windows | gap |
| source subdir + bare repo | 同上 | gap |
| startup Shell（PowerShell/pwsh、cmd、Git Bash 分别记录；PATHEXT 解析；shim） | Windows runner | gap |
| process-tree termination（taskkill /T、job object、句柄占用延迟释放） | Windows runner | gap |
| occupied-file cleanup（locked handle + retry 上限与 terminal result） | Windows runner | gap |
| persisted locator cold resume | Windows runner | gap |

未决语义：UNC `\\server\share` 的 share 身份比较、junction 是否按 reparse
语义处理、Git Bash 路径翻译（POSIX↔Windows）是否进入 adapter 契约。证据之前，
Windows adapter 保持 typed unsupported。

## 3. 跨平台条目（不是证据缺口，是设计契约）

| 条目 | 处理 |
|---|---|
| cross-platform locator open | P2 ADR 固定为 typed `platform_mismatch` / `migration_required`，fail closed，不猜测转换 |

## 4. 更新规则

- 每个平台真实 runner 采集完成后：证据并入 `tests/fixtures/platform-evidence/<platform>/`，
  本文件删除对应 gap 行并注明采集日期与 runner digest；
- 收集器或 runner 升级导致证据快照替换时，保留本文件变更记录；
- 不允许以“测试跳过”“仅解析 fixture”“Linux 行为类推”方式关闭 gap。
