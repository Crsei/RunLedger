# RunLedger Agent Mode 入口实施计划

> 状态：planned；仅完成现状核实与计划编写，M0–M6 均未实施。
> 核实日期：2026-09-05；基线 HEAD：`61aad32`，分支 `rollback/before-composer-shape`，包含并发未提交修改。
> 本轮边界：只修改文档，不修改生产代码、配置、数据库或进程；计划提交不代表产品选项已获确认。

## 1. 归属与目标

本计划负责 `/mode`、CLI 对称入口与模式展示，承接 [Runtime 09](09-minimal-harness-profile-implementation-plan.md) 已有 Harness Profile。Profile 的持久化与组装合同仍归 Runtime 09；公共合同归 [Runtime 04](04-governed-agent-harness-runtime-plan.md)，Session 生命周期与离线迁移归 [Runtime 06](06-session-owner-runtime-replacement-plan.md)。本计划不重写这些专题的既有完成状态。

目标：

- 提供 canonical `/mode` 选择器、`/mode default`、`/mode minimal`，以 `/minimal` 为快捷 alias；CLI 提供 `runledger --mode default|minimal`。
- 使用同一 builtin 映射生成命令参数、选择器和显示文案；用户层 `default` 映射到现有 `standard@1`，不重命名数据库里的 standard。
- 在 Footer 长期显示真实 Mode 和模型可见 Tools 摘要；保留模型、Permission、Thinking 的独立含义。
- 保持模型选择与模型参数不因 mode 自动改变。模式可改变 prompt/context/tools，因此不承诺回答效果或 token 使用不变。
- shell-only 和 Plan 作为有明确前置条件的后续阶段，不用 UI 名称掩盖尚未交付的运行时行为。

非目标：OS sandbox 开发、权限预设重构、绕过 ExecutionGateway、后台 daemon、任意自定义工具集、模式 marketplace、跨工作区授权、扩展 child 并发/递归、替换模型、实现新的 headless runner。`review`、`explore` 等只保留命名空间，不注册空实现。

## 2. 当前事实与缺口

以下是当前工作树的静态核实，未在本轮重跑构建或真实 TTY；工作树候选不等于已提交版本。前一轮会话的定向测试结果不作为本计划新增能力的验收。

| 范围 | 已核实代码 | 当前行为与缺口 |
|---|---|---|
| builtin | `src/runtime/harness-profiles/{builtins,types,resolver,tool-projection}.ts` | 只有 standard/minimal，ref version 固定为 1；minimal 的完整固定 prompt 与 `bash, edit` exact manifest 已存在，不是 shell-only |
| 生产组装 | `src/runtime/session-runtime/domain.ts` 的 `assembleSessionDomain` | catalog ref 决定 prompt/tools；minimal 不装配扩展、LSP/child，执行仍走 governed tools；不能由 TUI 局部隐藏工具替代 |
| durable identity | `src/storage/session-store/{schema,session-store,schema-compatibility}.ts` | schema 4 的 ID/version/digest 与 triggers 约束 exact builtin；新版本需同步 guards、SQL 与兼容性设计 |
| CLI | `src/cli/{args,main}.ts` | `--harness-profile standard|minimal` 仅允许 fresh create；open/resume/continue/fork 禁止覆盖；没有 `--mode` |
| TUI 创建 | `src/tui/commands/registry.ts`、`interactive/session-workflow.ts`、`adapters/session-domain.ts` | `/new [standard|minimal]` 已通到 `session.create`；普通 `/new` 继承；没有 `/mode` 或 `/minimal` |
| Session 转换 | `src/runtime/session-runtime/domain-router.ts`、`src/cli/main.ts` | 创建目标 Session 后通过 switch intent 重新打开；没有修改既有 Session profile 的 operation |
| 展示 | `src/tui/components/{session-profile-header,session-picker-modal}.ts`、`interactive-mode.ts` | 顶部和 catalog 已显示 Harness；Footer 的 `footer/field-registry.ts` 尚无 Harness mode/tool profile 数据来源 |
| 选择器 | `src/tui/components/list-selection-modal.ts`、`interactive/model-workflow.ts` | `SecondarySelectionView` 和 Composer 上方 bottom-left overlay 可复用；不需要新弹窗框架 |
| Plan | `src/runtime/session-runtime/plan-composition.ts`、`src/runtime/modes/plan/policy.ts` | Session 生产路径只投影 inactive 状态，`/plan` 是 inspect；独立 capability policy 已存在，但不能据此声称生产只读模式接通 |
| settings | `src/storage/settings-manager.ts` | 当前用户级 settings JSON 没有 agent mode 默认项；不能照搬建议里的 TOML 或 allthecodes 命令 |
| receipt | `src/runtime/session-runtime/domain.ts`、`src/runtime/harness-profiles/composition-receipt.ts` | receipt 早于 multi-agent `controller.addTools`；恢复重算聚合 digest，但没有从 receipt 工具表完整重算 manifest 并逐项比对 builtin 合同 |

相关既有测试：`tests/cli/session-harness-profile.test.ts`、`tests/runtime/harness-profiles/`、`tests/runtime/session-runtime/harness-profile-{minimal,standard,recovery}.test.ts`、`tests/tui/{session-workflows,session-profile-header}.test.ts`、`tests/tui/adapters/session-domain.test.ts`、`tests/tui/components/session-picker-modal.test.ts`。

当前迁移入口先于 owner discovery；`countActiveOwners` 按数据库状态计数。上轮真实用户库遇到 schema 3 → 4 被残留 owner 阻塞，本轮没有复查实时状态。此问题归 Runtime 06/09 的恢复专项，不得通过 `/mode` 跳过迁移、清空 owner 或在真实用户库做测试。

## 3. 推荐产品语义与需决定事项

以下均为推荐方案；需用户决定的项在 M0 记录结论，不因本计划提交而视为批准。文档交付不依赖现在作答。

| 决策 | 推荐选择与理由 | 另一选择的影响 / 阻塞阶段 |
|---|---|---|
| D1：切换是否保留原 Session/对话 | 选择不同 mode 时新建空 Session 并切换；明确显示“将创建新会话，当前会话可恢复”。保持现有 immutable ref 和 fork 继承 | 原 Session 热切换或带历史切换需先修订 Runtime 09 非目标、设计事件/工具历史兼容与恢复；阻塞 M1–M3 的切换语义 |
| D2：minimal 是否必须单 shell | 首期保留 `minimal@1` 的 bash/edit，标签如实显示；若确认单 shell，再交付 `minimal@2` | 若首发必须 shell-only，M5 必须先于公开入口发布；不能直接删掉旧 edit 或沿用旧 digest |
| D3：`plan` 是否首期可选 | 首期不列为可选择项；`/mode plan` 明确报 unavailable，保留 `/plan` inspect | 首期三模式必须等待 M6；Plan mutation、审批/退出与 deny gateway 归既有 Plan 专题，不是增加一个 readonly 字符串 |
| D4：是否持久保存默认 mode | 首期 CLI 默认仍 default，TUI `/new` 仍继承当前；可选用户级 `agentMode` JSON 后续启用 | 若要求配置默认，M3 同时加入 settings 校验及优先级测试；不引入新 TOML 文件 |
| D5：模型选择是否随新会话继承 | 保持当前 provider/model/thinking，并经现有 model-routing admission 验证；失败留在原会话并说明原因 | 若遵循全局默认会让 mode 操作间接换模型，需明确 UX；阻塞 M2 完整验收，现有 switch 是否完整继承待实测 |

`default` 表示当前策略允许的标准能力集，不表示取消权限或必定装配所有扩展。`Mode ≠ Permission ≠ Sandbox` 是分层原则；本轮不新增 PermissionPolicy/SandboxPolicy 枚举，也不把 shell-only 标为安全或只读。

## 4. 推荐交互与兼容合同

### 4.1 TUI

- `/mode` 展示当前有效模式和选择器，标题 `Select agent mode`。首期两项：`default — Standard toolset (subject to policy)`、`minimal — Bash + edit`。实际文案可本地化。
- `/mode default|minimal` 与 `/minimal` 进入同一 workflow；alias 必须绑定 minimal 参数，不能只是让 bare `/minimal` 打开通用选择器。未知值/多余参数在 mutation 前拒绝。
- 选择当前 exact ref 为 no-op；不同 ref 按 D1 创建并切换。选择器显示新会话语义，不静默丢弃未发送输入。推荐有草稿时保留草稿并提示处理，不自动带入目标会话。
- 空闲时允许切换；运行中拒绝；observer、revision 冲突、recovery barrier、断连均复用既有 admission。取消只关闭弹窗，失败不改变 Footer/当前 sessionId；目标成功打开后才刷新身份。
- 同名 minimal 不等于同一版本：恢复 minimal@1 时仍显示 `bash + edit`；未来默认 minimal@2 的选择器须区分“当前旧版本”和“新建最新版本”，不把重新选择当成无条件 no-op。
- `/new [standard|minimal]` 保留兼容；文档将 `/mode` 作为主要模式入口。`/permissions`、`/model`、thinking、`/plan` 的既有职责不改。

### 4.2 CLI 与配置

新增 `runledger --mode default|minimal`，沿用 fresh-create 限制。`--harness-profile` 保留兼容，归一化到同一 ref；两者同时出现只在完全相同目标时接受，冲突/未知值/缺值 fail closed。未来版本映射的兼容策略也要在 M5 明确，不能由两个参数分别选出不同 minimal 版本。

若 D4 选择配置项：只在 canonical 用户级 settings JSON 中新增 `agentMode`；fresh create 优先级为显式 CLI > settings > default。resume/attach/continue/fork 始终以 durable ref 为准，忽略创建默认值，显式覆盖仍拒绝。TUI 新会话继承规则不被 settings 静默覆盖。

用户建议中的 `allthecodes run --mode ...` 不是 RunLedger 的已确认命令；本期不新增 run 子命令或专家 `--tool-profile`，现有非交互执行入口适配待单独核实。

### 4.3 Footer 与数据来源

首期示例：`Mode: minimal · Tools: bash + edit`；未来单 shell 才能显示 `Tools: shell`。standard 显示 `Tools: standard` 并允许详情查看实际工具表，避免把动态工具名全部塞入 Footer。

mode 从当前 Session snapshot 的 exact profile 映射；工具摘要从已校验的最终 composition/descriptor 投影，不根据用户刚输入的命令乐观更新。未知 ref 显示 unavailable，不 fallback 为 default。Header、Footer、catalog 共用 mapper，恢复旧版本保持一致。

通过 `FooterSnapshot`/field registry/现有 presenter 接线，禁止新建旁路 renderer。80/143 列验证 Mode 不被静默删掉，优先压缩 Tools 详情；极窄宽度显示短 Mode，完整 ref 可由 `/mode` 查看。模型/权限/thinking 继续独立显示，不把现有业务 Plan state 当成 Harness mode。

### 4.4 shell-only 扩展

推荐后续 `minimal@2`：复用 governed bash leaf，模型工具名称暂保留 `bash`，用户摘要可叫 shell；不为了名称统一新增裸进程执行器。既有 `minimal@1` 永久保持两个工具，resume/fork 保持原 ref；新版本通过 registry、schema guards/triggers、receipt 与显式兼容迁移加入。

shell-only 指模型只看到命令执行工具，不代表命令只读。读写/网络/进程效果仍由 Security、Attempt Gateway、owner fence 处理。不开放后台 handle 或补造 `exec_command/write_stdin` 协议；若长进程交互是产品需求，另行定义 governed lifecycle 合同。可执行程序是否已安装、Windows shell 适配、shell 写文件审计覆盖均需实测，不能由 cat/rg/python 示例推断已支持。

## 5. 模块边界与依赖顺序

| 模块 | 计划涉及的文件/责任 |
|---|---|
| mode 映射 | runtime/harness-profiles 下纯 mapper，复用 builtin registry；TUI/CLI 不各自维护 mode truth |
| CLI / settings | `src/cli/{args,main}.ts`、`src/storage/settings-manager.ts`，参数归一化与新建默认 |
| TUI 命令/交互 | `commands/registry.ts`、dispatcher/action types、`interactive/session-workflow.ts`、`adapters/session-domain.ts`，选择器与新建转换 |
| 显示 | `footer/field-registry.ts`、`components/footer.ts`、`interactive-mode.ts`、profile header/catalog presenter，snapshot 派生显示 |
| Runtime/存储 | `session-runtime/{domain,domain-router}.ts`、harness receipt、session-store，保持 owner/attempt/revision 验证 |
| Plan 后续 | [Plan Mode 权威计划](../plan-compact-memory/01-implementation-plan.md)，本计划只消费已验收 operation/capability |
| UI 权威 | [TUI 20](../tui/20-codex-slash-command-adaptation-plan.md)、[界面术语](../frame/00-tui-and-security-terminology.md)、[Footer 计划](../plan/08-usage-status-line-replication-plan.md) |

推荐顺序：M0 → M1 → M2 → M3 → M4。M5/M6 是条件阶段，分别依赖 D2/D3 与各自运行时门禁；若产品要求首发具备其行为，M4 的发布验收必须等待它们。不得把完成 UI 当成 shell-only 或 Plan 完成。

## 6. 可独立验收阶段

所有阶段当前均为 **planned**。代码阶段按有意义的 RED → GREEN 推进，复用已有 fixtures；既有测试只作回归，不作为新增行为证明。

| 阶段 | 前置 | 交付物 | 验证与独立退出条件 |
|---|---|---|---|
| M0 合同与决策冻结 | 本计划 | 记录 D1–D5；命令/版本映射/错误码/兼容矩阵；核实 model/thinking、draft、observer 切换行为 | 文档与现有 profile freeze、Plan 专题一致；每个待决定项有负责人/结论；仅完成规划，不发布 UI |
| M1 统一映射与 receipt 修复 | M0，确定首期 profile | 纯 mode/ref/display mapper；修正 receipt 在最终工具装配后生成且首个模型调用前持久化，失败释放 owner；恢复完整校验工具 manifest 与 builtin descriptor 合同 | builtin/version/未知值测试；standard 开启 child 时 receipt 包含实际最终工具；minimal exact surface；篡改工具表而保留旧摘要须拒绝；无数据库 schema 变更的首期可独立交付 |
| M2 TUI 垂直入口 | M1、D1/D5 | `/mode`、直接参数、`/minimal`、SecondarySelectionView；session.create → switch → 实际新 snapshot；兼容 `/new` | registry/dispatch/workflow/adapter/runtime 集成；无参/同模式/取消/错误参数/运行中/observer/冲突/断连/创建失败/草稿；Session ID 与 ref 对照；不改模型选择；原会话可恢复 |
| M3 CLI 与 Footer | M1、M2；D4 | `--mode` 与旧参数冲突校验，可选 agentMode settings；Footer/header/catalog 统一显示 | CLI fresh/resume/fork/双参数/未知配置；模型表面与 Footer 一致；切换失败不提前显示；80/143 列真实 native frame、dark/light 与 overlay 布局，摘要不误称 shell-only |
| M4 首期交付验收 | M2–M3 | 文档/帮助更新，标准 PATH 构建 CLI 证据；各门禁状态分别回填本计划 | check、相关测试、全量测试、build；隔离 home 的真实 TTY `/mode` 两向新建、取消、resume/fork、干净退出；无凭据自动测试与真实 provider、人眼/IME、跨平台证据分列，不借用旧截图 |
| M5 shell-only 版本（条件） | D2；M1；Runtime 09 版本/迁移方案确认 | 新 exact ref/manifest、旧版保留、版本选择规则、schema/guard 兼容迁移和显示映射；不直接修改 minimal@1 | 旧库/旧会话 resume/fork/takeover 保持两工具，新建新版只有 bash；旧 binary 拒绝不兼容库；健康 owner 阻止离线迁移，残留 owner 恢复须另有门禁；restrictive denial 零副作用、允许读写/超时/取消/输出截断与 receipts、无扩展/child；check/test/build/隔离真实 CLI |
| M6 Plan 入口（条件） | D3；既有 Plan 专题生产 mutation/gateway/approval/恢复验收完成 | `/mode plan` 消费 Plan authority，区分 Harness ref 与 Plan workflow state，模式退出语义和 Footer | 真实进程禁止任意 shell/写工具/未知效果，批准不能越过 deny；计划工件唯一允许写路径、取消/退出/恢复/模型切换；minimal 与 Plan 组合策略须先决定，不擅自扩大工具；check/test/build/真实 CLI 与人工验收 |

M1 receipt 修复不等于完整审计专项结束，需保留原始 storage/admission 错误分类，避免所有恢复错误被误报为 profile corruption。若首期只做 UI 别名而不新增工具摘要，可单独缩小 M1 交付范围，但必须明确记录未完成的 receipt 门禁。

## 7. 验证纪律与完成定义

- 本轮文档：逐路径审阅、相对链接存在性、计划/现状状态一致性、`git diff --check`。不运行代码测试或 build，不把前轮 91 项测试写成新入口通过。
- 实施阶段：按当时 `package.json` 选入口，定向测试可用 `npm run test:local -- --file <path>`；代码提交完成 `npm run check` 和受影响测试，按 AGENTS 完成全量 `npm test`；进入 dist 的变更再 build 和真实路径验证。
- PATH 先核对 `command -v runledger`、`readlink -f`、`npm ls -g --depth=0`；所有测试使用新建绝对路径 RUNLEDGER_DIR，不复制真实凭据或清理真实 owner。
- TTY 记录 candidate、命令、Session ref、有效工具 manifest、Frame 和最终退出码；Esc 逐层关闭，Ctrl+D 正常退出，确认退出后仅清理本任务资源。
- mock/单测、built CLI、真实 provider、human visual/IME、macOS/Windows 分开记状态。未完成门禁写 pending；不能因为本计划处于 planned 而改写 Runtime 09 既有实现状态。
- 共享工作树先查 diff；本计划涉及的 registry/main/Footer 当前有并发修改，实施时重新定基线。只提交本任务路径/索引增量，不提交并发代码或其他计划。

## 8. 外部参考与待核实信息

用户提供的跨产品示例是设计输入，不是 RunLedger 兼容合同。2026-09-05 打开的 [Claude Code 官方 CLI 文档](https://code.claude.com/docs/en/cli-usage) 明确区分 `--tools`（可用工具集合）与 `--allowedTools`（无需提示即可执行的工具），因此不能把 allowedTools 等同于工具表选择。只借鉴分层，不复制权限模式语义。

提供的 [OpenCode 社区文档](https://github.com/mudrii/opencode-docs/blob/main/docs/12-permissions.md) 不是官方源码证据，本文不采用其 deny 移除工具的具体说法；该细节待官方源码核实。[Codex 源文件链接](https://github.com/openai/codex/blob/main/codex-rs/utils/cli/src/shared_options.rs) 可访问，但不用于推导 RunLedger 的 shell/Plan 行为。无需验证跨产品趋势才能实施本地命令映射。

待核实清单：D5 的实际模型/草稿继承；现有非交互入口；新 profile 的精确 SQL 迁移成本与旧 binary 可读性；Windows shell 能力；shell 写入治理和审计覆盖；Plan authority 全链路接线。各项由 M0/M5/M6 的对应验收关闭，不默认已经支持。
