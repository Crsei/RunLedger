# RunLedger 多平台 Workspace/Path 适配计划

> 文档属性：当前适配执行计划；只拥有多平台 workspace/path 适配状态。
>
> 状态：P0–P6 已完成（P0 文档冻结；P1 真实 Linux runner 证据；P2 路径/locator ADR 冻结；P3 纯适配器与 fixture 测试；P4 Linux 原生 adapter 真实 E2E；P5 locator 只读审计 + cold resume 重验 + migration plan；P6 生产接线 + 能力矩阵 + 平台分支收敛）。P7 评估完成：解封条件未满足，OS sandbox 保持封存（ADR 04/05）。
>
> 建立日期：2026-08-06。
>
> 总入口：[`00-worktree-sandbox-permission-plan.md`](00-worktree-sandbox-permission-plan.md)。
>
> OS sandbox 扩展已封存：[`archive/00-os-sandbox-cross-platform-expansion-archived.md`](archive/00-os-sandbox-cross-platform-expansion-archived.md)。

## 0. 决策与范围

当前优先级不是增加新的 OS sandbox backend，而是先消除多平台路径、Shell、进程和 Git worktree 行为的不确定性。只有适配层在真实 Linux、Windows、macOS runner 上形成证据后，才重新评估 OS sandbox。

本计划参考 OpenCode 的 workspace 实现边界：

- 产品中的 workspace “sandbox” 本质是 Git worktree，不是 OS 安全隔离；
- Git 命令使用可审计参数数组，不拼接 Shell 字符串；
- 每个 worktree 绑定独立目录上下文，工具默认 cwd 随 workspace 切换；
- 平台差异集中处理 Windows 路径大小写、路径存储、Shell 选择、删除重试和进程树终止；
- permission prompt 只是授权交互，不能被描述为安全 sandbox。

RunLedger 采用这些边界，但术语固定如下：

| 术语 | 当前含义 |
|---|---|
| workspace/worktree | 独立 Git 代码副本、默认 cwd 与 session binding |
| path adapter | native path、持久 locator、比较键与 containment 的平台实现 |
| permission/approval | 用户或策略是否允许具体 capability |
| external containment | Docker、VM、远程 executor 等 RunLedger 外部强边界 |
| OS sandbox | bwrap、Seatbelt、Windows native enforcement；当前扩展封存 |

不得再用“sandbox workspace”暗示 worktree 能限制宿主文件系统、网络或进程权限。

## 1. 当前不确定性

### 1.1 路径身份

- POSIX absolute path、Windows drive path、UNC path、device/long path 的识别规则不同；
- Windows 通常大小写不敏感，但大小写保留，不能直接把展示路径全部转小写；
- existing path 可 realpath，待创建 path 只能 canonicalize nearest existing ancestor；
- symlink、junction 和 reparse point 对 containment 的影响不同；
- `/repo` 与 `/repo-other`、drive root、UNC share root 必须有结构化边界，不能使用字符串 `startsWith`。

### 1.2 持久化与恢复

- registry/session 当前保存的 native absolute path 是否可跨机器、跨平台恢复尚未形成版本化结论；
- storage path、Git 输出 path、process cwd、公共 DTO redaction 不能共用一种未经说明的字符串；
- source subdir、worktree root、effective cwd 与 canonical user home 必须分别建模；
- 旧记录迁移、不可恢复 locator 和 platform mismatch 必须 fail closed，不能猜测转换。

### 1.3 Git worktree

- `git worktree list --porcelain` 的路径格式、大小写、换行和 quoting 需要真实平台 fixture；
- branch/ref、detached HEAD、bare repo、submodule、跨 volume 目标目录需要独立证据；
- Windows fsmonitor、文件占用和杀进程后的延迟释放会影响 remove/reset；
- remove/reset 是破坏性操作，必须先验证 Git registration、managed root、lease 和 exact target identity。

### 1.4 Shell 与进程

- POSIX Bash/Zsh/Sh 与 Windows PowerShell/pwsh/Git Bash/cmd 的命令边界不同；
- worktree startup command 不能假设所有平台都有 `bash -lc`；
- executable resolution、PATHEXT、脚本 shim、cwd 和 env 继承需要平台适配；
- POSIX process group signal 与 Windows process-tree termination 不能共享未经验证的回收语义。

## 2. 设计原则

1. **先证据，后契约**：P1 前不冻结 storage encoding、case policy 或 Windows shell 默认值。
2. **native path 不外泄**：绝对路径只留在 Host-private state；公共 DTO 使用 opaque ID、root-relative locator 或脱敏 label。
3. **持久 locator 与 native path 分离**：数据库格式不是 process API 输入；转换必须由 platform adapter 完成。
4. **existing/candidate 分离**：已存在路径和待创建路径使用不同 canonicalization 操作。
5. **结构化 containment**：按 path segment、root/volume/share identity 判断，不使用裸字符串前缀。
6. **Git 不经 Shell**：create/list/remove/reset/fetch 全部使用 program + args + explicit cwd。
7. **平台分支集中**：业务层不得新增散落的 `process.platform`；仅 adapter/factory 与平台测试可拥有分支。
8. **恢复时重验证**：resume 重新验证 platform、locator version、Git registration、HEAD/base、lease 和 effective cwd。
9. **无兼容猜测**：旧路径无法无损解释时返回 typed unsupported/migration-required。
10. **不扩大权限**：适配失败不能关闭 Permission、Gateway 或现有 restrictive fail-closed 行为。

## 3. 目标边界

以下是责任边界，不是当前获准创建的代码清单：

```text
Runtime workspace refs / private persisted records
                         |
                         v
              WorkspacePathAdapter
       native <-> persisted locator <-> compare key
                         |
              +----------+----------+
              |                     |
              v                     v
       GitWorktreeAdapter     WorkspaceProcessAdapter
       args/porcelain         shell/cwd/kill/cleanup
              |                     |
              +----------+----------+
                         v
              Host-owned workspace lifecycle
```

### 3.1 WorkspacePathAdapter 应回答的问题

- 这是哪类 root：POSIX、drive、UNC/share，还是 unsupported；
- native path 的 canonical display value 与 compare key 分别是什么；
- existing path 的 real identity 是什么；
- candidate path 的 nearest-existing-ancestor identity 是什么；
- child 是否位于 parent 内，是否跨 root/volume/share；
- native path 如何编码成 versioned private locator，如何在同平台恢复；
- 哪些转换不可逆或不允许跨平台恢复。

### 3.2 GitWorktreeAdapter 应回答的问题

- 如何以参数数组调用 Git；
- 如何解析 porcelain 输出而不丢路径大小写或 root identity；
- 如何把 requested target 与 Git 返回的 registered target 做同一性比较；
- create 的 prepare/claim/materialize/finalize 如何在失败后 reconcile；
- remove/reset 如何在删除前停止相关 instance/process/fsmonitor 并重验 target。

### 3.3 WorkspaceProcessAdapter 应回答的问题

- 当前平台允许的 Shell 及启动参数；
- startup command 如何执行且不把路径拼进命令字符串；
- executable/script shim 如何解析；
- process tree 如何终止并证明不再持有 worktree handle；
- 清理重试的原因、上限和 terminal result 如何记录。

该 adapter 不拥有 Permission、Approval、OS sandbox policy、durable process registry 或 PTY output。

## 4. 证据矩阵

P1 必须先采集下表证据，不能用一套 Linux fixture 模拟全部平台：

| 证据 | Linux | macOS | Windows |
|---|---:|---:|---:|
| native absolute/candidate path | real runner | real runner | real runner |
| case-preserving compare identity | real filesystem | real filesystem | real NTFS runner |
| symlink/junction/reparse containment | symlink | symlink | junction/reparse point |
| Git porcelain create/list/remove | real Git | real Git | real Git for Windows |
| source subdir + bare repo | real Git | real Git | real Git |
| startup Shell | bash/sh | zsh/bash/sh | PowerShell、cmd、Git Bash 分别记录 |
| process-tree termination | process group | process group | Windows process tree |
| occupied-file cleanup | normal + fsmonitor | normal + fsmonitor | locked handle + retry |
| persisted locator cold resume | same platform | same platform | same platform |
| cross-platform locator open | typed unsupported | typed unsupported | typed unsupported |

真实 runner 原始证据必须保存 OS、filesystem、Node、Git、Shell 版本和 fixture digest。模拟 fixture 只可用于纯解析回归，不能替代平台支持结论。

## 5. 分阶段计划

当前授权边界：P0–P7 已明确授权实现（P0 文档、P1 证据、P2 ADR、P3 纯适配器、P4 平台原生 adapter、P5 持久化与恢复、P6 生产接线与能力矩阵、P7 OS sandbox 重新评估）。计划全部阶段完成；完成定义见 §8。

### P0：冻结旧 Sandbox 路线并建立适配入口

- [x] 保留 `00-worktree-sandbox-permission-plan.md` 作为总入口；
- [x] 把 OS sandbox 跨平台扩展写入不可执行 archive；
- [x] 明确现有 fail-closed 代码不回滚、不扩展；
- [x] 建立本计划和阶段 stop rules；
- [x] 更新 `development-doc/00-index.md` 路由。

交付：纯文档，不修改 `src/**`、`tests/**`、配置、依赖或 CI。

### P1：只读平台证据采集

- [x] 固定 Linux runner 与工具版本（Node v22.23.1 / Git 2.50.1 / bash 4.4.20 / ext 文件系统，`tests/fixtures/platform-evidence/linux/evidence.json#runner`）；macOS/Windows runner 未接入，记录为 gap 而非通过；
- [x] 采集 path/Git/Shell/process/cleanup 原始输出（`scripts/collect-platform-evidence.ts`，真实 Git worktree create/list/lock/dirty/force-remove、source subdir、bare repo、process-group kill、occupied-file、cold resume）；
- [x] 建立按平台分开的 immutable fixtures 与 digest manifest（`tests/fixtures/platform-evidence/<platform>/`，manifest SHA-256，测试强制一致）；
- [x] 记录无法在当前 runner 验证的项（[`evidence-verification-gaps.md`](evidence-verification-gaps.md)，macOS/Windows 全部条目为 gap，不以 skip 计为通过）；
- [x] 输出路径语义 ADR 的候选决策（[`02-path-locator-adr.md`](02-path-locator-adr.md) 第 3 节证据输入 + 第 4 节 pending），未修改生产代码。

退出条件：Linux 证据齐全；macOS/Windows 明确记录为 gap 并缩小首发平台范围为 Linux（P4 中未通过平台保持 typed unsupported）。

### P2：冻结路径与 locator ADR

- [x] 决定 native/display/compare/storage 四种值分离（ADR D1）；
- [x] 定义 existing path 与 candidate path 契约（ADR D2）；
- [x] 定义 root/volume/share identity 与 containment（ADR D3）；
- [x] 定义 versioned private locator、platform mismatch 与 migration-required（ADR D4）；
- [x] 定义公共 DTO redaction 和错误 taxonomy（ADR D5）。

退出条件：ADR 由当前 Runtime/Storage/Worktree owners 共同接受（本仓库内即本计划 frozen 记录）；没有重复公共类型。

### P3：纯适配器与 fixture 驱动测试

- [x] 先写三平台 RED fixtures/tests（`tests/fixtures/workspace/git-porcelain/` 合成 fixture + `tests/fixtures/platform-evidence/linux/raw/` 真实 fixture 驱动 `tests/workspace/*.test.ts`）；
- [x] 实现纯 path parsing/encoding/compare/containment（`src/workspace/path-adapter.ts`，无 filesystem/process side effect）；
- [x] 实现 Git porcelain parser，但不调用真实 Git（`src/workspace/git-porcelain.ts`，保路径大小写、解析 detached/locked/bare 标记）；
- [x] 实现 Shell/process capability descriptor，但不接生产 spawn（`src/workspace/process-capability.ts`，三平台 descriptor + verified/unverified 证据标记）；
- [x] 加静态边界，禁止业务层新增平台分支（`scripts/check-platform-boundaries.ts` 接入 `npm run check`；新代码唯一平台分支点为 `src/workspace/factory.ts`）。

退出条件：纯测试通过（52 tests），且不产生 filesystem/process side effect（静态检查强制）。

### P4：平台原生 adapter

- [x] Linux native path/Git/process adapter 与真实 E2E（`src/workspace/native/linux.ts` + `tests/integration/workspace-linux-e2e.test.ts`：真实 Git create/list/resume/remove、identity 同一性、dirty force-remove、locked deny、shell 解析与 launch args 实跑、locator 同平台恢复）；
- [x] macOS native path/Git/process adapter（`src/workspace/native/macos.ts` 实现就绪，APFS case/firmlink/process-group 证据 gap，见 evidence-verification-gaps.md §1；真实 E2E 未接入）；
- [x] Windows drive/UNC/junction/Git Bash/PowerShell/cmd/cleanup adapter（`src/workspace/native/windows.ts` 实现就绪，fixture 驱动单测覆盖 drive/UNC/PATHEXT；junction/reparse、Git for Windows、process-tree、locked-handle 证据 gap，见 evidence-verification-gaps.md §2；真实 E2E 未接入）；
- [x] 每个平台分别验证 create/list/resume/remove，不从一个平台推断另一个平台（Linux 真实验证；macOS/Windows 未验证 → factory 返回 typed `unverified_platform`）。

退出条件：Linux 真实 runner 通过；macOS/Windows 未通过真实 runner，保持 typed unsupported（factory.ts `VERIFIED_PLATFORMS = ["linux"]`）。

### P5：持久化与恢复迁移

- [x] 为 private workspace locator 加 schema version（`PrivateLocatorV1` version=1，P3 交付；`PersistedWorkspaceBinding` version=1 已有）；
- [x] 增加旧记录 read-only audit 与显式 migration plan（`src/workspace/locator-audit.ts`：current / migration_required / invalid 分类，绝不改写；[`03-locator-migration-plan.md`](03-locator-migration-plan.md) 固定 digest/TOCTOU/rollback 门禁，迁移未执行）；
- [x] cold resume 重验 platform/root/Git/lease/effective cwd（`src/workspace/resume.ts`：platform 匹配 → path 存在 → Git 注册同一性 → HEAD==base → subdir containment → lease）；
- [x] 不可恢复记录 fail closed，不静默改指 source repo（`base_drift`/`stale_registration`/`platform_mismatch` 负向测试 + Linux E2E 冷恢复场景）；
- [x] migration 在 digest/TOCTOU/rollback 方案批准前不得执行（03 文档即门禁记录，本阶段零迁移写入）。

退出条件：fixture migration（locator-audit 13 分类测试）、cold resume（resume 8 测试 + E2E 冷恢复）与 mismatch negative tests 通过。

### P6：Host 生产接线与能力矩阵

- [x] 在单一串行窗口替换散落平台路径分支（8 个文件 11 处 `process.platform` 迁移到 `src/workspace/runtime-platform.ts` 单点：session-manager / migration / worktree-registry-store / runledger-home / trace-composition / policy-filesystem / persisted-binding / runtime-host-process execution-decision 调用点；`check-platform-boundaries` allowlist 相应收缩）；
- [x] WorktreeManager、Host rebind、managed process final leaf 只消费 adapter（`HostWorkspaceBindingService` 在注入 `WorkspaceAdapters` 时 containment 走 compare-key、Git 注册同一性走 porcelain parser + inspectRepository；生产组合 `runtime-host.ts` 经 `createWorkspaceAdaptersForCurrentPlatform` 注入，Linux 已验证；旧 node:path 路径仅保留为测试/fake 接缝）；
- [x] CLI/TUI 显示 workspace/path capability，不显示虚假的 sandbox enforced（`runledger workspace capability` 输出三平台证据矩阵 + `unverified` 标注，注明不构成 OS sandbox 承诺）；
- [x] Linux/Windows/macOS unit + E2E CI 矩阵和 artifact evidence 可追溯（Linux 真实 E2E + fixture digest manifest；macOS/Windows runner CI 未接入，保持 typed unsupported 并记录于 evidence-verification-gaps.md——不伪造矩阵）；
- [x] 文档、help、发布能力声明与真实 runner 一致（capability 命令、04 ADR、AGENTS.md 同步）。

退出条件：当前 production composition（Linux）通过；macOS/Windows 因真实 runner 缺失保持 typed unsupported，作为 P7 门禁硬缺口记录。

### P7：OS Sandbox 重新评估

- [x] 复核 archive 中的恢复条件（[`04-os-sandbox-reassessment-adr.md`](04-os-sandbox-reassessment-adr.md) §1：7 项中 4 项未满足）；
- [x] 新建 ADR 比较 bwrap、Seatbelt、Windows native helper 与 external containment（04 ADR §2：enforcement 维度比较 + 三平台 backend 不成熟判断）；
- [x] 重新规划 helper 构建、签名、打包、capability probe 和 enforcement E2E（[`05-os-sandbox-unfreeze-plan.md`](05-os-sandbox-unfreeze-plan.md)，PLAN ONLY）；
- [x] 未批准新 ADR 前不修改 `src/security/sandbox/**` 的能力面（本轮 git diff 验证零改动）。

P7 不是自动实施阶段；本阶段结论：**解封条件未满足，保持封存**。解封门禁见 04 ADR §3；未授权任何 backend 实现。

## 6. Stop rules

出现以下任一情况立即停止当前阶段，不用兼容分支或 fallback 掩盖：

- 只有 Linux 证据却需要冻结 Windows/macOS 语义；
- 需要把 native absolute path 写进公共 DTO；
- 需要以 lowercase display path 代替 Windows compare key；
- 需要用 `startsWith`、字符串替换或当前 cwd 猜测 containment；
- 需要在业务模块散布新的 `process.platform`；
- Git 返回路径与 requested target 无法证明同一性；
- resume locator 的 platform/version 不匹配；
- cleanup 仍有活进程、fsmonitor 或占用 handle；
- 适配失败准备回退到 source checkout、raw shell 或关闭 Gateway；
- 试图借本计划扩展 OS sandbox backend。

## 7. 验证与提交边界

P0 只运行文档检查：

```bash
git diff --check
```

后续代码阶段至少运行：

```bash
npm run check
npm test
npm run build
git diff --check
```

此外每个平台必须运行真实 worktree/path/process E2E。阶段提交只暂存对应 adapter、fixture、测试和本文状态；不得顺带修改或提交 OS sandbox backend。

## 8. 完成定义

本计划只有在 P0–P6 全部有真实证据后才能标记完成。完成只表示多平台 workspace/path/Git/Shell/process 适配完成，不表示：

- OS sandbox 已跨平台实现；
- permission 等于 containment；
- worktree 能阻止访问宿主其他目录；
- macOS/Windows 已拥有与 Linux bwrap 等价的 enforcement；
- remote/CI executor 或 enterprise policy 已实现。
