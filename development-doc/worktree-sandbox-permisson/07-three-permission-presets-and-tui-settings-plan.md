# 三种权限预设与 TUI 设置实施计划

> 文档属性：`partial`。本计划是 [`00-worktree-sandbox-permission-plan.md`](00-worktree-sandbox-permission-plan.md) 的 UI/策略组合后续，消费 [`06-codex-permissions-adaptation-plan.md`](06-codex-permissions-adaptation-plan.md) 已落地的 config、PermissionEngine、ApprovalCoordinator 与 ExecutionGateway；不改变 00 中冻结的 OS sandbox 扩展范围。
>
> 建立日期：2026-09-02。
>
> 用户目标：在 TUI 中首先提供三个可理解、可审计的系统预设：**Ask for approval**、**Approve for me**、**Full Access**；完整的命名 profile、filesystem/network/rules/bash 设置随后才进入 Advanced。

## 实施状态（历史基线 2026-09-04；即时更新增量见 §0）

2026-09-09 增量已完成当前会话 apply、pending 重新授权和 Linux TTY 验证；以下条目是先前保存默认值实现的历史记录。

- 已落地（P1/P4/P5 的可验证切片）：三项 builtin preset、`approvalReviewer`、managed constraints、`SecuritySettingsPort` 的原子 CAS 保存、Session Owner 的 `security.settings.inspect/update`、workspace deny-only 收紧校验，以及唯一的 `/permissions` 三卡选择器和 Full Access 二次确认。
- Host inspection 会投影 reviewer、managed constraint digest、sandbox capability 与三项 preset availability；TUI 对 Host 标记 unavailable 的预设禁用选择。保存只作用于后续 Session，当前 immutable snapshot 不会被改写。
- 2026-09-04 复核修正已闭合六个安全缺口：启动 resolver 与 durable settings port 都禁止 workspace 扩大 user baseline；`headless-workspace`、`workspace-write`、`approve-for-me` 不再按相同粗粒度 rank 处理；切换系统预设会移除旧 `allow` rule；Approve for me 的 workspace 外写回落到精确 user approval；managed source 只以具体 constraints 限制候选值而不再冻结全部本地设置；deterministic reviewer 的 input/policy digest、generation、classification version、decision 与有界 reason 已写入 Session hash-chain event store。
- automated production evidence 已覆盖 canonical user/project settings 三预设、普通 workspace write、workspace 外 write 的 allow/deny/revoke、network review 拒绝不触达 raw broker、managed availability 与 auto-review durable audit。尚未完成：Advanced 的 Profile/Inheritance、Approvals/Granular、Filesystem、Network、Rules、Bash 与 Effective-policy 编辑页；`runledger security inspect`；人工跨平台验收。因此 P5（Advanced）与 P6 的 CLI/human 部分仍为 partial/pending，不能宣称计划整体完成。
- 2026-09-04 fresh evidence：security/session/TUI 宽集 42 files / 244 tests 通过（macOS-only 3 tests 按平台跳过）；完整 `npm run check`、`npm test`、`npm run build` 均 exit 0。全局链接解析到本仓库 `bin/runledger.js`；隔离 `RUNLEDGER_DIR` 的真实 tmux TTY 已捕帧验证三卡、Full Access confirm/cancel、Approve for me 保存与重新打开后的 current 状态，并以 Esc + Ctrl+D 干净退出。未读写真实用户配置。
- 后续修正（2026-09-02）：`/settings` 不再作为 permissions 的 alias；本分支的 `HEAD` 没有 SettingsWorkbench，完整历史实现位于分叉的 `session-owner-runtime@cb15812`，恢复它必须作为独立 settings-runtime 移植处理，不能用权限页替代。新增 `config-file-permission-presets.integration.test.ts` 在隔离 user/project `settings.json#security` 写入三个预设，并经 governed filesystem 实际写入目标文件；同时修复 `danger-full-access` 把正常 unrestricted write 错误变成 approval deny 的缺口。

## 0. 决策摘要

### 2026-09-09 当前会话权限即时生效修复计划

**状态：implemented，Linux 自动化与构建后 TTY 已验证。** 本节取代旧 P4/P5 的“保存只影响新 Session”语义：显式 `/permissions` 已更新为当前会话 apply；通用配置 update 仍只保存默认值。Runtime 04 与 Runtime 06 已同步合同及生产接线，以下旧诊断是修复前证据。

#### 问题与证据

- 2026-09-09 最新会话“查找已合并可删除的工作树”（session ID 后缀 `mttr9u7g`）于 15:07:05 创建，用户 settings 于 15:07:57 保存为 `danger-full-access`；之后 15:08–15:09 的三次普通 shell 审批均在 30 秒后过期。命令是目录存在性检查和 Git 合并关系检查，包含 `for`/`if`，不是系统破坏操作。
- `src/tui/permissions/workflow.ts` 的 current 来自保存文档 `view.document.profile`，而保存调用 `security.settings.update`；成功提示明确限定 new Sessions。选中状态因此不能代表当前执行权限。
- `src/runtime/session-runtime/security-settings-domain.ts` 只保存 settings，不替换当前 SecuritySnapshot。`src/security/composition/session-security.ts` 在创建时加载 snapshot；governed shell/filesystem/network、managed process、final-leaf digest、domain inspection 与其他 policy ceiling 消费者持有启动期引用。只更新 UI 或一个字段无法修复生产行为。
- 已核对 PATH/global npm link 指向本仓库，当前进程运行本仓库 `dist/cli/cli.js`；此诊断不是由启动了另一个 checkout 推导而来。

#### 目标行为与边界

1. 用户在当前 TUI 通过 `/permissions` 确认预设后，同一 session ID、同一对话内的后续工具操作立即采用新的有效权限，同时保留目前“保存为用户默认值”的行为。不得要求重启、新建对话或再次提交原问题。
2. 保留 Full Access 二次确认。更新只能由当前 driver 经 Session Owner 的正式命令发起，observer、模型工具和普通文件写入不能调用该提权路径。managed、workspace deny-only、CLI 收紧、protected paths 与系统单次确认继续生效。
3. 每个 SecuritySnapshot 仍不可变；新增会话内单调递增的权限 revision，Owner 显式发布新 snapshot。权限 revision 与 owner generation、Harness Profile version 分开；不重建 session、不改变 harness/mode、不放宽 child authority。
4. “生效”的线性化边界是 Owner 提交权限切换并发布当前 revision。尚未到最终副作用入口的操作必须使用新 revision 重新授权；已跨过该入口的操作保留旧 revision 的审计归属，不重复执行、不宣称撤回已有副作用。运行中的进程不会因切换自动被杀死，其后新请求仍走新权限；该限制必须在界面和验收中明确。
5. 本专项只修改权限更新、组合引用、审批与执行一致性接线。复用已有预设与 backend 选择，不修改 `src/security/sandbox/**`、namespace、隔离机制或平台实现；若完成方案必须扩展这些实现，应报告范围阻碍，不顺带开启 sandbox 专项。

#### R1 — 版本与更新合同

- 在 Runtime 04 定义当前有效权限 query、显式 apply 命令、变更事件与结果 DTO。建议新增 session 级 apply 操作，保留通用 `security.settings.update` 的配置编辑语义，避免其他调用方意外提权；最终命名随 contract 审阅确定。
- 请求包含期望 owner generation、security revision、source digest 及预设；复用 driver authorization、command/effect 幂等性、Attempt Gateway 和 CAS。冲突返回明确 stale，不自动覆盖并发修改。
- query/result 分别表达 effective profile/revision/digest、saved default、应用状态和受限原因。成功必须表明当前会话已应用；不得用“保存成功”代替“应用成功”。
- 整个候选预设经原 resolver/compiler 校验，包含 filesystem/network/reviewer/bash 和全部配置层约束；不能只把 approvalPolicy 改为 never。

#### R2 — Owner 发布与一致执行

- 在生产 `domain.ts` 与 `session-security.ts` 引入 Owner 持有的权限版本容器和受控更新协调器。所有稳定对外端口在每次新操作开始时取得版本，禁止已创建工具闭包长期捕获旧 snapshot。
- 逐项盘点并更新：authorizationPolicy、permissionRequester、governed shell/filesystem/network、managed-process security、constraint providers、ExecutionGateway/final leaf、session.security.inspect、权限提示词及 policy ceiling 消费者。extension trust 和 child 的冻结限制不得通过重写 ceiling 被隐式扩大。
- 操作内 pin 同一个 revision；在最终副作用前核对 active revision 和 owner fence。版本已变则丢弃旧授权、重走授权链；绝不能拿旧 receipt 搭配新 snapshot。版本校验与副作用 admission 必须共享受控边界，覆盖“校验后、执行前”切换竞态。
- 更新协调器仅短暂阻挡新操作 admission，不持锁等待用户审批、模型返回或长进程结束；待审批阶段必须能接收权限切换，避免等待自身结束的死锁。

#### R3 — 待审批与切换故障

- 切换提交后，旧 revision 的 pending ticket 明确终结为被权限切换取代，通知反向请求/TUI 关闭对应弹框；旧弹框迟到的 allow/deny 不得授权新 revision 的操作。
- 原操作尚未执行且仍有效时，在运行时内部重新评估一次：新策略 allow 则继续原操作；ask 则创建绑定新 revision 的票据；deny 则返回明确结果。已取消、过期或完成的操作不得复活；不得依赖模型重新提交相同命令。
- 普通升级 Full Access 关闭旧普通审批；系统破坏确认仍创建精确单次请求。收紧权限时，旧 one-shot、session/prefix/network grant 均不能跨 revision 复用。
- 用户配置文件与 SQLite 不具备跨存储原子事务。采用可恢复的切换记录：校验并准备候选版本 → 持久记录 intent/旧新 digest → CAS 保存配置 → Owner 提交应用记录并发布版本 → 解除 admission 屏障。禁止先发布权限再尝试保存。
- R1 明确并在 R3 实现每个失败点的恢复表：保存失败保留旧有效权限；保存成功但应用未提交时保持旧版本或阻止执行，并明确报告“已保存、当前未应用”，不返回完整成功。接管按 durable intent 和配置 digest 完成或拒绝恢复，禁止猜测。配置发生并发变化时不盲目回滚覆盖；审计提交失败时 fail closed。
- apply 幂等重试不得重复递增 revision、重复执行工具或重复消费审批。恢复过程中旧 owner、旧 ticket、旧授权继续受 fence 约束。

#### R4 — TUI 与上下文同步

- 三卡“当前”改为读取 effective profile；另行显示保存默认值，仅在不一致时提示差异。应用中禁用重复提交；收到 committed event/result 后更新选择状态、页脚/权限提示及待审批视图。
- 成功提示“已应用到当前会话，并保存为默认权限”。stale/失败/部分保存显示实际状态，保留重试入口；退出弹窗不等于更新已提交。
- 下一次模型请求使用新的权限说明，历史消息和历史 receipt 不改写。正在生成中的工具请求也由当前权限版本重新治理，不能把 prompt 当 authority。

#### R5 — 回归与验收

| 场景 | 必须观察到的结果 |
|---|---|
| 当前会话从 Ask for approval 切换 Full Access | 同一 session ID；目录检查 `for`/Git 只读循环执行一次，不再普通弹框；shell/fs/network receipt 绑定新 revision |
| 弹框等待中切换 | 旧票据终结并关闭弹框，原操作按新策略继续一次；旧响应迟到无效，无 30 秒超时等待 |
| Full Access 切回受限预设 | 后续越界文件/网络操作按新策略 ask/deny；旧 grant 不可复用 |
| 切换与最终执行、用户批准并发 | 以 admission 边界决定版本；无旧授权穿透、重复执行、锁死或 receipt 混用 |
| managed/workspace/CLI 限制及系统确认 | 不允许的更新失败；普通 Full Access 与特殊确认边界保持现有语义 |
| observer/过期 driver/旧 owner 发起更新 | 明确拒绝，配置和有效权限均不被越权更改 |
| 保存失败、审计失败、CAS 冲突、各阶段崩溃/接管 | 按恢复表保留或恢复可证明的版本，UI 无假成功，无跨存储状态静默漂移 |
| 正在运行的进程、已有 extension/child 限制 | 既有操作不被重复执行或宣称撤回；新操作受新策略约束，冻结能力不被扩大 |
| TUI 重开权限页与新会话默认值 | 有效状态和保存状态分别正确；同一会话可立即继续，无需重启 |

- 先增加缺陷回归：在 Owner 已创建且正在等待普通审批时调用 TUI 所用更新路径，确认当前实现仍使用旧权限，然后再实现。
- 定向测试覆盖版本容器、resolver、审批竞态、final-leaf admission、Owner 接管和 TUI 状态；对 fs/network 使用隔离 broker 计数证明“未授权不触达、成功仅一次”，不调用真实付费 provider。
- 代码交付按 `npm run check`（完整输出）、受影响测试及 `npm test`、`npm run build` 执行；既有失败记录归因，不算通过。
- build 后核对 `command -v runledger`、`readlink -f`、`npm ls -g --depth=0`；以隔离 RUNLEDGER_DIR、受控本地 provider fixture 和真实 tmux/TTY 复现同一对话内切换，检查弹框、输出、session ID、事件及执行次数。Esc/Ctrl+D 退出并验证本任务进程清理。
- 人工视觉/中文 IME、macOS/Windows、真实外部 provider 分开标注，未执行不关闭门禁。实际已执行的验证见下方交付记录，未执行的门禁仍保留。

#### 已实现的失败恢复表

| 失败位置 | 当前执行状态 | 保存与恢复处理 |
|---|---|---|
| generation/revision/source CAS、预设可用性或 resolver 校验失败 | 旧版本继续有效 | 不写配置；返回 stale/denied/failed |
| Attempt begin 明确拒绝 | 撤销候选、解除本次屏障 | 无配置保存，报告 recovery_required；保留原 Attempt authority |
| Attempt begin 抛错、intent/audit 写入不可判定 | admission 封闭 | 无假成功；接管仍受通用 Attempt recovery barrier 约束 |
| Settings update 失败且读取确认来源仍是旧 digest | 旧版本继续有效，旧等待票据不主动撤销 | 写 rejected，结算 attempt 后撤销候选；不覆盖并发配置 |
| 保存已改变来源后失败/抛错、语义复核不匹配、applied 或 attempt settlement 失败 | admission 封闭，查询显示 recovery_required | 返回 permissions_saved_not_applied；保留 prepared 与旧新 digest，不静默回滚 |
| 接管遇到 prepared，来源仍为旧 digest | 按当前 baseline 建立更高 revision | 记录 abandoned；不重放工具 |
| 接管遇到 prepared，来源与候选 digest、全部配置语义一致 | 按当前 baseline 建立更高 revision | 记录 recovered；通用未结算 attempt 仍需既有 recovery 流程处理 |
| 接管配置与 intent 不符或 journal 非法 | 拒绝创建执行组合 | 不猜测、不覆盖用户配置 |

#### 2026-09-09 交付记录

- 版本容器覆盖稳定 fs/network/shell、managed process 与 request_permissions；最终 dispatch 复核版本，managed spawn 用短 admission lease。旧 pending 只在提交切换后被 superseded，精确 reverse request 取消后原操作重评估；已取消/过期请求不会复活。已有 child 捕获原权限 revision，不随 root 放宽；minimal 固定 prompt 不变，assembled harness 的下一次上下文读取有效权限。
- 增加 `session-permission-updates.integration`、`security-update`、`active-permissions-owner` 及 TUI workflow 回归，包含 CAS、幂等、并发更新、partial rename、audit 故障、恢复冲突、workspace 收紧、child scope、pending managed prepare、迟到 allow 与 exact execution count。Owner 测试经过真实 TCP、driver、pending prompt、反向取消、持久 journal、订阅与重新接管，不调用外部模型。
- 构建后 `python3 tests/manual/active-permissions/run.py` 已在标准 PATH、143×42 真 tmux TTY 通过。同一 session（后缀 `mtttvbdd`）从 workspace-write → danger-full-access → workspace-write，审批弹框 `/` 进入、Esc 返回、Full Access 二次确认均走真实 UI；原 loop 仅写入一次，后续 loop 无普通审批，收紧后拒绝不落文件。持久事件为 2 次 approval.requested、1 次 superseded、revision 1→2→3；本地 provider 收到的后续 system 上下文反映 revision 2/3；Esc/Ctrl+D 退出码 0、无存活测试进程。证据根为 `/data2-HDD-SATA-20T/Digital_avatar/haoweiyao/runledger-active-permissions-ggc5qp8h`。
- 最终验证：`npm run check`、`npm run build` exit 0；`npm test` 的全部 Vitest 分组 504 files / 3305 passed / 3 skipped，补充 `session-permission-events` 1 passed。原生阶段发现权限字段强制显示挤掉 80 列 thinking；恢复既有窄屏降级规则后，`npm run test:tui-native` 全部分组 24 files / 154 passed / 0 failed。早先 `npm test` 进程因原生失败返回 1，本轮以受影响原生分组的完整复验闭合该失败，不将该进程记为 exit 0。首轮 MCP list 30 秒超时也在后续完整 Vitest 运行中通过。
- 验证日志根：`/tmp/runledger-permission-validation-sYWFyp`。真实外部 provider、人工视觉/键盘/中文 IME 与 macOS/Windows 未执行；本轮不修改 `src/security/sandbox/**`，也不关闭 Advanced 或 Runtime R8/R9 的门禁。

#### 交付顺序与完成标准

按 R1 contract/失败恢复表 → R2 生产接线 → R3 审批及故障恢复 → R4 TUI → R5 集成/TTY 顺序实现，R2–R4 未闭环前不将功能标记完成。阶段可分提交，但最终交付必须包含同一会话即时生效、待审批重新评估、反向收紧、审计恢复和真实 TTY 证据；仅改提示、默认值或要求用户重开 session 均不算修复。

### 2026-09-07 Full Access 与独立系统确认

当前内置 Full Access（`danger-full-access` + `never`）允许普通 shell 命令，包括 legacy/AST 无法完整分类的重定向、控制流与脚本。显式设置其他 approval policy 仍保留其收紧语义；管理员要求的 AST 分类也不被普通 Full Access 放行规则覆盖。其他 profile 的 `never` 仍将普通 `ask` 转为 `deny`。

优先级为：显式 deny / 管理员约束 → 自身策略保护及系统安全门禁 → 普通 Full Access 放行。根目录、整个 HOME 的递归删除、格式化/擦除文件系统、分区修改、关机/重启要求单次用户确认；fork bomb、全系统进程终止仍硬拒绝。整体根/HOME 删除按系统确认处理，不因为其包含 policy 文件而降为普通文件写入。shell 检查覆盖常见包装、HOME 写法、命令替换与控制流，但不承诺解释任意动态脚本。

系统确认独立于常规 `never`，不会被 allow rule、session/prefix grant 或 auto-review 跳过；无交互通道、取消、超时、绑定变化时拒绝，且不启动进程。确认绑定完整命令、cwd、policy digest 和当前 request；只接受 `allow-once`，UI 不提供持久批准选项。原来的 `2>/dev/null; ...` 分类缺口同时修复。

Composition root 将 canonical user/project `settings.json` 与 `/etc/runledger/security.json`（含已解析的别名）纳入控制文件保护。受治理文件操作可按原 read policy 读取，但不得写入、删除或替换这些文件及其父目录；canonical revalidation 同样检查符号链接。可识别的 shell 控制文件写入也拒绝。Agent 可提出修改，实际更新通过用户的 `/permissions` / 受控配置入口，不能用普通工具的 Full Access 自行降低限制。

**验收边界**：上述是执行治理与路径检查，不是 OS 级隔离。`sandbox=off` 下，外部脚本、计算得到的路径、硬链接或同用户进程仍可能绕过 shell 文本检查；当前 immutable Session snapshot 不随配置文件改写而更新，但这不等于防止所有宿主机文件写入。完整防绕过依赖独立的 OS/权限分离工作，本次未修改被冻结的 sandbox 实现。原生终端验证使用合成工作区与隔离配置，不读取真实用户凭据或操作现有工作目录。

拒绝结果保留稳定错误码，并通过 `SessionDomainResult.reason` 给 Bash/TUI 传递固定、有界的原因摘要；不透传底层原始错误、审批自由文本或路径。测试入口为 `full-access-policy`、`approval-session-scope`、`security-composition`、`process-composition` 与 `approval-reverse`。

2026-09-07 验证：`npm run check`、`npm run build` 通过，本次涉及的 9 个测试文件、175 个用例通过。构建后的真实 CLI 在隔离 HOME / `RUNLEDGER_DIR`、本地确定性 HTTP 模型夹具下，通过 80 列 light / 143 列 dark 的 tmux 验证：原始 `wc ... 2>/dev/null; echo ...; head ...` 和控制流命令直接执行，系统确认取消时零执行、allow-once 后执行无害 `reboot` 替身，策略文件写入返回 `policy_denied` 和固定摘要、文件内容不变，退出码 0 且无残留进程。未执行真实系统破坏命令；不作为真实 provider、人工视觉/IME 或跨平台验收。

完整 `npm test` 被工作树原有未跟踪用例 `tests/runtime/session-runtime/model-selection-policy.test.ts` 阻塞：它期待为 `fixture/unverified` 自动选择替代模型，但当前实现拒绝替代；将该用例单独复制到隔离 HEAD 副本后复现相同失败，证明与本次修改无关。中断后剩余 179 个测试文件已按 canonical bucket 补跑，退出码 0。本次未修改该用例或模型选择实现；完整回归不标记通过。

### 0.1 三张卡不是三个 approval 值

一个预设必须原子组合以下维度：

```text
profile / filesystem capability / network capability / sandbox target
    + approval policy / reviewer route / rules / protected paths
    -> immutable SecuritySnapshot(policyDigest)
    -> PermissionEngine -> ApprovalCoordinator -> ExecutionGateway -> final leaf
```

因此禁止把 TUI 的三张卡实现为只改 `approvalPolicy` 的快捷开关；也禁止把 oh-my-pi 的 `yolo` 解释成 `danger-full-access`。前者只是工具 tier 的 approval UX，不构成 filesystem、network 或 OS sandbox 边界。

### 0.2 系统预设及精确承诺

| TUI 文案 | stable preset id / resolved profile | 对用户的承诺 | 初始配置目标 |
|---|---|---|---|
| **Ask for approval** | `workspace-write` | 可在当前 workspace 读、编辑、运行已知安全命令；访问网络或编辑 workspace 外文件前询问。 | workspace read/write、network `review`（初始 hosts 为空）、sandbox `workspace-write`、`on-request` |
| **Approve for me** | `approve-for-me`（新增系统 profile） | 低风险且可验证的动作由本机 deterministic reviewer 代表用户批准；不确定、高风险、网络/路径越界仍询问。 | workspace read/write、network `review`、sandbox `workspace-write`、`on-request` + `approvalReviewer: auto-review` |
| **Full Access** | `danger-full-access` | 普通命令、workspace 外写及网络无需常规审批；系统级破坏操作仍单次确认。 | unrestricted filesystem、network `allow`、sandbox `off`、`never` |

三者都不绕过 managed/explicit deny、保留的硬性 shell 禁令、自身策略保护、`protectedPaths`（至少 `.git`、`.runledger`）、canonical path/symlink 重验、ExecutionGateway 和 Host final leaf。Full Access 只免除普通审批，系统确认按上方 2026-09-07 规则执行。

### 0.3 用户面与内部 ID

- 首屏只显示上述三张卡；`read-only`、`headless-workspace`、命名 profile 与全部细项仅在 **Advanced / Custom** 中出现。
- `workspace-write` 和 `danger-full-access` 保留当前 stable ID；新增 `approve-for-me` 为内置 profile，不能被 settings 中同名定义覆盖。
- TUI 持久化选择的 profile ID，而非“第 1/2/3 项”的显示序号；显示文案可国际化，审计/恢复记录始终使用 stable ID。
- 运行中 session 永不改写其 snapshot。保存只影响下一次 create/resume；当前页显示“将在新会话生效”。

## 1. 当前基线与必须修复的语义差距

### 1.1 已有能力

- `src/security/config/schema.ts` 已接受 profiles、四种 approval policy、五项 granular 开关、五种 sandbox、network、filesystem、rules 和 bash analyzer；Host 从 managed、workspace canonical settings、user canonical settings 与 CLI 层加载 `settings.json#security`。
- `src/security/config/resolver.ts` 已有 `read-only`、`workspace-write`、`headless-workspace`、`danger-full-access`、`custom` 默认 profile，named profile 的 unknown parent/cycle fail closed，且生成带 `policyDigest` 的 snapshot。
- `src/security/permission/engine.ts`、`ApprovalCoordinator` 和 `ExecutionGateway` 已是生产工具的唯一授权链；`PolicyFileSystem` 会 canonicalize/revalidate path，`.git`/`.runledger` 默认受保护。
- 当前 TUI 有逐请求 approval 和只读 `session.security.inspect`，但没有完整 `/permissions` 管理页，也没有 session security mutation contract。

### 1.2 当前实现不能直接兑现三张卡文案

| 差距 | 现有行为 | 所需行为 |
|---|---|---|
| Ask for approval 的 workspace 编辑 | 普通 workspace write 产生 `ask`。 | 普通、已验证 workspace edit 自动 allow；危险/未知仍 ask。 |
| Ask for approval 的 workspace 外编辑 | root boundary 直接 `deny`；`request_permissions` 也不能提升 deny filesystem entry。 | 只有“普通 root boundary”可创建 **精确路径、精确 operation、一次性** 的 approval ticket；protected/managed/explicit deny 继续 deny。 |
| Approve for me | `untrusted` 当前把所有非 read 转为 ask；无 reviewer route。 | reviewer 只处理显式 eligible 的 ask；不可证明安全、失败、超时一律回到 user ask 或 deny。 |
| Full Access | 内置 profile 已接近目标。 | 保持 managed/protected/hardline deny；TUI 显示风险并要求二次确认。 |
| settings 落盘 | Host 能从 raw `security` section 读取；通用 `saveProjectSettings()` 会丢弃未知 `security` 字段。 | 单独的 Host-owned `SecuritySettingsPort` 做 schema 校验和原子 read-modify-write，TUI 不接触文件路径。 |
| named inheritance | 当前 resolver 会解析所有内置名为父级，包含 `danger-full-access`。 | 同 Codex profiles：允许继承 `read-only`、`workspace-write` 或命名 profile；禁止 `danger-full-access` 作为 parent，拒绝 unknown/cycle。 |

### 1.3 当前层级问题

managed source 不能只是一个可被 CLI 覆写的普通 config layer。实施时须把 managed policy 编译为 **constraints**：可选 profile 集、最小 sandbox、network deny、不可提升 deny 和最小 bash analyzer。CLI、user、workspace 只能在这些 constraints 内选择或进一步收紧。

最终优先级为：

```text
managed constraints (only restrict)
  > session/CLI one-shot request (can only restrict)
  > workspace canonical security (can only restrict user baseline)
  > user canonical security
  > builtin preset defaults
```

rules 不采用“后层 allow 覆盖前层 deny”：所有来源保留，针对同一 AccessRequest 的结果始终 `deny > ask > allow`。

## 2. 范围、非目标与不变量

### 2.1 本计划范围

1. 定义/解析/审计三个 immutable builtin permission presets。
2. 对齐第 0.2 节承诺所需的 approval/temporary escalation/reviewer 契约。
3. 把 `security` 的安全落盘、revision、snapshot 与 Host command 接通。
4. 实现 `/permissions` 三卡选择器与 Advanced read/edit flow。
5. 为每一预设建立 unit、Host integration、TUI interaction 与真实 TTY 验收。

### 2.2 明确非目标

- 不解冻 `04`/`05` ADR 中的跨平台 OS sandbox 扩展，不新增 Landlock、Seatbelt、Windows Restricted Token 或 raw shell fallback。
- 不把 LLM、外部 Guardian 服务或 provider 输出作为自动批准 authority；第一版 reviewer 是可审计、确定性的本机规则/分类器。
- 不允许 TUI client 直接读写 settings、创建 snapshot、发放 grant 或调用 raw `fs`/`spawn`/`fetch`。
- 不实现 profile 继承自 `danger-full-access`、持久“全局 allow all”、自动批准 protected path、自动批准 host allowlist miss。
- 不宣称 `strict`、`external` 在任何平台已经被 OS 强制执行；TUI 只展示 Host capability proof。

### 2.3 关键不变量

1. 所有生产工具副作用继续经 `ExecutionGateway`；预设不能创建旁路。
2. 普通 `never` 仍是“ask → deny”，不是“deny → allow”。内置 Full Access 普通 shell 在分类前产生 allow，系统 circuit breaker 则独立产生不可持久化的单次 user ask。
3. temporary escalation 永远不修改存储 profile；它是 request/policy/session generation 绑定的短期 grant，并在完成、取消、超时、takeover、snapshot 变更时失效。
4. `auto-review` 的不确定、异常、超时、重复响应、证据缺失结果均为 user ask；headless 时为 deny。
5. `Full Access` 选择必须被审计，且 managed policy 不允许时不可展示为可选。

## 3. 目标配置与契约

### 3.1 settings 形状

`<RUNLEDGER_DIR>/settings.json#security` 为 user baseline；`projects/<workspace-key>/settings.json#security` 只可收紧。示意：

```json
{
  "security": {
    "profile": "approve-for-me",
    "approvalReviewer": "auto-review",
    "profiles": {
      "project-edit": {
        "extends": "workspace-write",
        "network": { "mode": "allowlist", "allowedHosts": ["api.openai.com"] },
        "filesystem": {
          "denyRead": ["**/*.env"],
          "protectedPaths": [".git", ".runledger"]
        }
      }
    },
    "bashAnalyzerMode": "ast",
    "rules": [
      { "id": "deny-git-push", "action": "deny", "kind": "shell", "pattern": "git push*" }
    ]
  }
}
```

`approvalReviewer` 新类型：`"user" | "auto-review"`。它不是 approval policy 的第五种值；policy 决定 action 是否为 ask，reviewer 决定 eligible ask 先由谁处理。

### 3.2 系统 registry

新增只读 `BuiltinPermissionPresetRegistry`。每项至少包含：

```ts
interface BuiltinPermissionPreset {
  readonly id: "workspace-write" | "approve-for-me" | "danger-full-access";
  readonly label: "ask_for_approval" | "approve_for_me" | "full_access";
  readonly description: string;
  readonly profile: SecurityProfile;
  readonly reviewer: "user" | "auto-review";
  readonly requiresExplicitConfirmation: boolean;
  readonly availability: (constraints: ManagedSecurityConstraints, capability: SandboxCapability) => PresetAvailability;
}
```

registry 只描述默认组合；`SecurityConfigDocument` 仍是唯一用户可配置格式。resolver 将 registry + user/workspace config 编译为 snapshot，不能把 UI 文案或 TUI 状态写进 policy。

### 3.3 temporary filesystem escalation

对普通 workspace-root boundary（而非显式 deny）创建：

```ts
interface PendingFilesystemEscalation {
  readonly operation: "write" | "delete";
  readonly canonicalTarget: string;
  readonly requestedPath: string;
  readonly policyDigest: RuntimeDigest;
  readonly sessionGeneration: number;
  readonly scope: "once";
}
```

批准后只把 canonical target 的 exact entry 写入该 gateway invocation/launch plan；不扩大 `writeRoots`，不持久化 config，不使用 glob/prefix，不覆盖 protected/managed/explicit deny。完成后 receipt 与 grant 一起 settle/revoke。

### 3.4 auto-review 准入矩阵

只有由 PermissionEngine 标记为 `ask` 且同时满足下列条件的请求才可送 auto-review：workspace 内、canonical path 已重验、非 protected、非显式 deny、无 credential/read deny 命中、无 shell hardline、无 network host miss、无 worktree remove、policy/session generation 匹配。

第一版 auto-review 只可返回 `allow-once`、`ask-user`、`deny`；不产生 session grant、prefix rule、network amendment 或配置写入。它依据可版本化的 deterministic classification/risk evidence 决策，并把分类版本、输入 digest、结果和理由摘要写入 ledger。任何未覆盖 action 直接 `ask-user`。

## 4. 分阶段执行

每个阶段先写 RED 测试，再实现最小代码，完成 `npm run check`、相关测试和 `npm run build` 后才能进入下一阶段。每阶段单独提交；共享 Host/TUI 文件只在记录的串行集成窗口改动。

### P0 — 基线冻结与契约 RED

**目标**：使三张卡的 promise、当前差距和不可放宽边界变为可执行测试。

- 新增 `tests/security/permission-presets.contract.test.ts`：三项 registry 组合、受保护路径、managed deny、snapshot digest、不可继承 full access。
- 新增 current-behaviour RED：workspace `on-request` ordinary write、root-boundary external write、`untrusted` non-read ask、缺少 reviewer route，逐项锁定为待改差距。
- 记录当前 Host source ordering 与 `ManagedSecurityConstraints` 未接入处；先定义 constraints input，不在 P0 改行为。

**完成条件**：红测清晰表达第 1.2 节差距；不改生产语义。

### P1 — 内置预设 registry、继承与 managed constraints

**目标**：安全地解析三项预设，并让 managed policy 成为上限而非普通 override。

- 新增 registry/类型、`approve-for-me` builtin profile、`approvalReviewer` schema 和 snapshot 字段；未知值 fail closed。
- resolver 只允许 named profile extends `read-only`、`workspace-write`、另一个 named profile；拒绝 `danger-full-access` parent、unknown/cycle、builtin 名覆盖。
- Host loader 将 `/etc/runledger/security.json` 编译为 constraints；CLI/workspace/user 请求在 constraints 下求交集，不能提升。
- 在 `session.security.inspect` 中增加 profile ID、reviewer、policy digest、preset availability 的只读投影。

**测试**：registry、inheritance、constraints precedence、full-access 被禁、source digest/replay；原有 config/profile tests 全量回归。

### P2 — Ask for approval 的真实语义

**目标**：兑现“workspace 自动编辑；网络与外部文件询问”。

- 调整 PermissionEngine：在 `workspace-write + on-request` 下，已验证的普通 workspace mutation allow；未知/dangerous shell、worktree mutation、network review miss 仍 ask。
- 把 root-boundary 区分为 explicit deny/protected/managed deny（始终 deny）与 escalation-eligible boundary（ask）。
- ApprovalCoordinator/ExecutionGateway 实现 `PendingFilesystemEscalation`，并在 filesystem broker、managed process launch plan、final-leaf revalidation 同时消费 exact grant。
- 无 UI/headless/recovery-uncertain/receipt 无效时 escalation 为 deny；任何 path canonicalization 变化为 deny。

**测试**：workspace auto-write、protected/deny 不可升级、外部单文件 write approve/deny/cancel/timeout、symlink swap、session takeover、grant replay/settle。

### P3 — Approve for me reviewer

**目标**：让第二张卡有真实、可审计但保守的含义。

- 新增 Host-owned `AutoApprovalReviewerPort`、deterministic reviewer 实现与 `ApprovalReviewer` 解析；TUI 只显示状态，不拥有决策。
- 把 eligible `ask` 先交 reviewer；`allow-once` 继续经过 gateway，`ask-user` 走现有 reverse request，`deny` 直接拒绝。
- 失败、超时、unavailable、classification version/digest 不符均不自动放行；interactive → user ask，headless → deny。
- Advanced 可查看 reviewer 的分类版本、理由摘要和 receipt，但不显示原始敏感 command/file body。

**测试**：每一准入/排除项、timeouts、异常、重复 response、policy change、headless、审计脱敏与 idempotency。

### P4 — SecuritySettingsPort 与安全持久化

**目标**：使 TUI 可保存配置且不丢弃 `security`。

- 新增 Host command/query：`security.settings.inspect`、`security.settings.update`；update 包含 expected revision/source digest，返回 durable receipt。
- 实现专用 raw-section read/modify/write：只修改 `settings.json#security`，用 `parseSecurityConfigDocument` exact validate；不经过通用 `ProjectSettings` sanitizer。
- scope 规则：managed 只读；user 可选择三个预设/管理 named profiles；workspace 只能收紧 user baseline，Full Access 在受限 workspace 不能成为更宽松覆盖。
- 保存成功后提示“新 Session 生效”；当前 session snapshot 不变。新 session/resume 的 snapshot/ledger 记录 source digests。

**测试**：unknown field 不被误吞、invalid JSON fail closed、CAS conflict、并发 update、user/workspace 收紧、managed 冲突、保存后重启与旧 session 不变。

### P5 — TUI 三卡选择器与 Advanced

**目标**：可用、无 authority 泄漏的 permissions 设置界面。

- `/permissions` 首屏三卡，显示当前选择、约束摘要、availability 和 Full Access 风险提示。
- Full Access 需二次确认（清晰列出 workspace 外写、网络、无常规 approval），managed 禁止或 capability unavailable 时不可选择。
- Advanced 依次提供 Profile/Inheritance、Approvals/Granular、Filesystem、Network/hosts、Rules、Bash、Effective policy；每一页从 `security.settings.inspect` 投影，提交为 typed patch。
- Network allowlist 空、重复 rule ID、非法 profile parent、未知 token、`granular` 缺五项开关均在保存前展示明确错误。
- 保留现有 inline permission request；它是运行中单次请求界面，不能与 settings editor 混为一处。

**测试与人工验收**：OpenTUI keyboard navigation、焦点恢复、窄/宽终端、CJK 文案、Full Access confirm/cancel、unavailable 显示、无 layout/path 泄漏；真实 linked `runledger` TTY 捕帧验证。

### P6 — 生产组合、审计与最终验收

**目标**：确认三个预设在真实 Host/CLI/TUI 路径中不会绕过约束。

- 标准 CLI 启动、create/resume、Host takeover、worktree binding、managed process、governed filesystem/network 全部使用同一 SecuritySnapshot。
- CLI 一次性 flags 只能选择受允许 preset 或收紧字段；`--approval-policy granular` 不再默默假设五个开关，必须显式声明或拒绝。
- `runledger security inspect` 输出 redacted effective policy、preset、reviewer、capability proof、source/constraint digest，不输出 secrets/原始敏感规则值。
- 对三项预设完成 fresh end-to-end trace/receipt inspection；不以 Linux 回归当作跨平台 sandbox enforcement 声明。

**最终门禁**：

```text
npm run check
npm test
npm run build
git diff --check
which runledger
runledger security inspect
# 真实 TTY：三项选择、保存、重启新 session、一次 external-write/network ask、Full Access 二次确认
```

真人仍需确认：Full Access 的文字是否足够明确、自动 reviewer 的理由是否可理解、真实 IME/鼠标/窄终端行为，以及各目标平台的实际 sandbox capability。

## 5. 文件与提交边界

| 阶段 | 主要路径 | 不应触碰 |
|---|---|---|
| P0–P1 | `src/security/{types,config/**,permission/**}`、`tests/security/**` | sandbox backend、TUI renderer |
| P2 | permission/approval/gateway、Host security、focused integration tests | raw fallback、平台 sandbox 扩展 |
| P3 | approval reviewer port/adapter、audit、tests | provider/LLM authorization |
| P4 | storage security port、Host command/query、storage/security tests | TUI direct filesystem |
| P5 | `src/tui/**`、TUI tests、Host client adapter | policy decision ownership |
| P6 | CLI composition/help、integration/TTY evidence、docs | unrelated session/store migrations |

每个提交只包含一个阶段的 code/test/doc 路径；本计划本身只在阶段状态或明确的设计决策变化时更新。不得以已有历史 `check`/TTY/E2E 结果标记本计划通过。

## 6. 完成定义

只有以下条件同时成立，三种预设才可对用户宣称可用：

- 三张卡均由 registry、schema、resolver、immutable snapshot 和 policy digest 表达，且运行中无 client-local mutation；
- Ask for approval 能在 workspace 自动编辑，并且 workspace 外/网络实际走精确 approval 或安全拒绝；
- Approve for me 仅由确定性、可审计、fail-closed reviewer 自动批准 eligible action；
- Full Access 允许正常 workspace 外写/网络，但无法越过 managed/protected/hardline deny；
- settings 持久化不会丢失 `security`，workspace 不可扩大 user/managed 权限；
- 运行中 approval、CLI、TUI、managed process 和 final leaf 使用同一个 snapshot；
- P0–P6 的 fresh automated/TTY evidence 和人工验收均完成；未证实的平台 sandbox 状态继续显示为 unavailable/unverified。

## 7. 明确拒绝的捷径

- 只给三张 TUI 卡换文案，而不改变实际 profile/network/filesystem/gateway 行为；
- 把 `never`、`yolo` 或 `Full Access` 当作 ignore deny；
- 用普通 `saveProjectSettings()` 保存 security，导致未知字段静默丢失；
- 将 workspace-root boundary 的 deny 直接变成 unrestricted write，或批准一个目录/glob 来代替 exact one-shot path；
- 用 LLM、模型输出、prompt 文本或前端布尔值作为 auto-approval authority；
- 让 auto-review 对网络 host miss、credential/deny match、protected path、未知 shell、worktree remove 自动批准；
- 在 session 运行中静默替换 policy snapshot，或让 observer/TUI 自行更改它；
- 把 sandbox/backend unavailable 降级为 raw local I/O。
