# RunLedger Plan Mode 完整度对齐实施计划

> 状态:P0–P6 已实现(见 §5.9 证据);P7 的端到端与全量门禁已执行,人工/真实 provider/跨平台门禁 pending。本文是 Plan Mode 用户可见行为交付的唯一账本。
> 基线日期:2026-09-16;RunLedger 基线 `b25ff70`(分支 `rollback/before-composer-shape`)。
> 修订记录:2026-09-16 §4.1 依据代码核实修正结论 2 的前提(撤销 `standard@3` 与 schema 迁移),补充 D4a(`inspect()` 全量重放缺陷)与 D3 的总字节上限前置;同日完成 P0–P6 实施,证据与偏差见 §5.9。
> 参考基线:oh-my-pi `3b3a6dc9bb`(`packages/coding-agent`,本机 `/data2-HDD-SATA-20T/Digital_avatar/haoweiyao/oh-my-pi`)。
> 适用范围:`src/runtime/{modes/plan,session-runtime,context,harness-profiles,protocol,contracts,tools}`、`src/security/integration`、`src/tui/**`、`src/cli/**`、canonical `runledgerHome` 与对应 tests。
> 上位计划:Runtime 04(公共类型/schema/event catalog)、Runtime 06(Session Owner、owner fence)、Runtime 09/10(profile 冻结与 mode 入口)。
> 设计账本:[`01-implementation-plan.md`](01-implementation-plan.md);其 reducer/artifact/契约归属不变,本文只承接 Plan Mode 的行为交付与验收。

## 0. 文档定位、交接与执行规则

### 0.1 与 01 的交接

01 的 Phase 3–5 是 Plan Mode 的行为清单。截至基线,Phase 3 只完成 reducer/artifact store 与 digest drift,Phase 4–5 的绝大多数条目未实现。为避免同主题状态分散:

- 本文接管 Plan Mode 的**行为交付状态**:01 Phase 3–5 中尚未完成的条目由本文 §5 的 P0–P7 承接,01 对应章节只保留设计叙述并标注状态入口。
- 01 §3.2 的行为合同、§6.2/§6.3 的 Plan policy ceiling、§6.7 的事件建议继续作为本文的设计输入。
- 公共类型、schema、event catalog 的修改仍归 Runtime 04 的 contract work package,本文只在 §7 声明增量需求;行为 PR 不得顺带改写契约 allowlist。

### 0.2 不变边界

以下边界来自根 `AGENTS.md` 与现有专题,本计划不申请放宽:

- Harness Profile 在 Session 创建时冻结,fork 继承;`/mode` 换 profile 即新建空 Session。profile 不改变权限 authority。
- 不新增、扩展、移植或重构 OS sandbox、namespace、进程隔离;Plan Mode 的只读边界只用现有 capability/authorization 与 ExecutionEnv 表达。
- 产品内 child 委派保持默认关闭、root-owned sequential readonly、depth=1;Plan Mode 不放开 child。
- 工具副作用继续经 Security/ExecutionGateway、Attempt Gateway 与 owner fence;fail closed,不用 raw I/O 或 AllowAll 让测试通过。
- 标准 CLI/TUI 只经 Session Owner 的 command/query/subscription;client 不持有 store、不直接调用 controller、不创建第二 writer。
- 单一 canonical `runledgerHome`;Session 与 runtime 数据只接受当前 exact format,不做格式兼容或隐式迁移。

### 0.3 执行规则

- 一次只实施一个可独立验收的 PR 边界;契约 PR(P0)与行为 PR(P1+)分离。
- 每个代码 PR 运行完整 `npm run check` 与受影响的测试;进入 `dist/` 的代码另做 `npm run build` 与真实 `runledger` 验证。
- 用户可见功能必须有 owner-fenced durable command 与 event 证据,不得用 client-local 状态或 TUI 布尔值伪装完成。
- 自动化、built CLI/TTY、真实 provider、人工键盘/中文 IME、macOS/Windows 是不同证据,不互相替代。
- 每个阶段完成后在本文补齐 commit、命令与结果;不在其他文件复制本表状态。

## 1. 当前基线:RunLedger 的 Plan Mode

2026-09-16 实测:Plan Mode 相关测试 11 文件 / 41 用例全部通过(vitest 10 文件 39 用例、bun 1 文件 2 用例);文件清单见 §5 P7。

| 能力 | 当前实现 | 状态 |
|---|---|---|
| 入口 | 仅新会话选 `plan@1` | 有,但不支持会话内进入 |
| 初始状态 | owner 启动即写初始正文并 activate | 有 |
| 模型工具 | `plan@1` 冻结为 `read`、`glob`、`ls`、`plan_read`、`plan_write`;standard 会话另装配 `enter_plan_mode`/`exit_plan_mode`,由状态与实例身份判权 | 有;并新增模型侧进入/提交审批 |
| 状态机 | reducer 9 条命令(`modes/plan/reducer.ts:234`),`inactive/pending/active/awaiting_approval/exit_pending` | 有,无 `reactivate` |
| 工件 | `PlanArtifactStore` 不可变 revision + digest + working pointer(`modes/plan/artifact-store.ts:110`) | 有;正文随 event payload 持久化,上限 65536 字符 / 255 revision(`plan-domain.ts:149`) |
| 只读边界 | capability claims(`tools/capabilities.ts:13-15`)+ `evaluatePlanModeCapabilities`(`modes/plan/policy.ts:39`,unknown→deny)+ `planReadOnlyExecutionEnv`(`plan-readonly` 包装)+ profile allowlist | 有,仅对 `plan@1` 生效 |
| 工件写例外 | 按 composition 注入的 writer 实例身份放行(`security/integration/runtime-tool-authorization.ts:84`) | 有,仅一个实例 |
| 审批绑定 | state revision + artifact revision + digest + approvalId(`plan-domain.ts:159`,reducer `:284`) | 有 |
| 审批产出 | 用户经 `/plan` 分页 modal(`tui/interactive/plan-workflow.ts:94`)或 CLI(`cli/control-commands.ts:85,100,264`) | 有;模型无请求批准入口,无"要求修改"决策 |
| 事件 | catalog 7 个 plan 事件(`runtime/protocol/events.ts:108`);拒绝复用 `plan.failed`,取消/退出复用 `plan.exited`(`plan-domain.ts:258-265`) | 有,语义混淆 |
| context 注入 | 无。`ContextEngine` 不注入 mode 指令或计划正文,模型须自行 `plan_read`(`session-runtime/domain.ts:341` 只供 inspect) | **缺** |
| 压缩交互 | `plan_*` 工具结果已受 prune 保护(`context/compaction/projection-prune.ts:48`) | 部分;压缩后无 mode/计划重注入 |
| 实施交接 | 批准 → `settle_exit` → inactive;实施须 `/mode default` 新建会话 | **缺**(上下文丢失) |
| 产物可用性 | 无标题、无导出、无历史浏览、无 reentry | **缺** |
| TUI 呈现 | `PlanRenderView` 标题/状态/摘要(`tui/adapters/session-resources.ts:130,290`)、Footer `mode` 段(`footer.ts:63`) | 弱,无 mode 状态 |
| 会话内收敛 | 无:active 下模型可以空转到 turn 结束而不写计划 | **缺** |

## 2. 参考基线:oh-my-pi 的 Plan Mode 完成度

作为目标口径的事实输入(同机取证,数字为实测):

| 维度 | oh-my-pi 实现 | 度量 |
|---|---|---|
| 状态 | `plan-mode/state.ts:1-6`(enabled/planFilePath/workflow/reentry);session entry `mode_change` | 6 行 |
| 会话内切换 | `app.plan.toggle` = `Alt+Shift+P`(`docs/keybindings.md:14,33`);`plan.defaultOnStartup` 开机默认进入(`modes/interactive-mode.ts:384`) | — |
| 模型侧收敛 | 只能 `write xd://propose` 提交审批;settle 强制收敛 + 有上限 reminder(`session/agent-session.ts:8394-8436`) | — |
| 计划产物 | `local://<slug>-plan.md` 文件,审批不改名(`plan-mode/approved-plan.ts`);`plan.files` 列表按 mtime 倒序;autosave 到 `<project>/.omp/plans/<TOPIC>_PLAN.md`,`wx` 独占创建避让(`plan-mode/plan-autosave.ts:64-94`) | 94 行 |
| 审批界面 | 全屏 overlay:TOC 侧栏、section 删除/撤销、按 section/line 标注 feedback、模型档位 slider、外编辑器、鼠标(`modes/components/plan-review-overlay.ts`) | 1227 行 |
| 执行上下文 | 批准时四选一:keep context / compact context / fresh context / save and quit(`prompts/system/plan-mode-active.md:105-113`) | — |
| prompt | 8 个模板文件:`plan-mode-active/reference/approved/compact-instructions/subagent/tool-decision-reminder`、`plan-filename`、`plan-yolo-handoff`;含"execution spec, not design doc"、decision-completeness 门槛、决策完备性自检 | 246 行 |
| 压缩 | 批准后内联正文,压缩前蒸馏、压缩后重新内联(`agent-session.ts:5864-5880,6438`);plan 读取受 prune/shake 保护(`plan-mode/plan-protection.ts`) | 51 行 |
| 连续性 | reentry 分支(新请求优先、旧计划仅作参考)、plan 历史(`/plan`)、按 mtime 的 plan 列表 | — |
| 模型 | plan role 切换与退出恢复(`plan-mode/model-transition.ts`) | 51 行 |
| 其它抑制 | plan 期间 todo HUD/nudge 抑制(`session/todo-tracker.ts:138,176,206,300`)、`ask` 不超时(`tools/ask.ts:968`)、只读 subagent 继承(`task/structured-subagent.ts:208,268`) | — |
| 测试 | 20 文件 / 6536 行 / 229 用例 | — |

oh-my-pi 没有而 RunLedger 已有的能力(不因对齐而回退):durable event sourcing 与重放、artifact revision digest 链、approval 与 revision/digest 绑定、unknown effect deny、owner fence/driver admission、attempt receipt 幂等、单一 canonical home。

## 3. 差距矩阵与目标口径

| 能力 | RunLedger 现状 | oh-my-pi 现状 | 本文目标 |
|---|---|---|---|
| 会话内进入/退出 | 仅新会话;`plan.enter` 在非 active 时落 `plan_workflow_finished_create_new_session` | 键位 toggle + 开机默认 | P1 实现 durable 进入/退出与安全点投递 |
| 模型侧进入 | 无 | 无(靠用户 toggle) | P3 实现 `enter_plan_mode` + 用户批准 |
| 模型侧请求批准 | 无 | 唯一入口 `xd://propose` + settle 强制收敛 | P3 实现 `exit_plan_mode`(不接受模型参数)+ settle reminder |
| mode 指令/计划注入 | 无 | 全套 8 模板 | P2 实现 fragment 注入与压缩后重注入 |
| 审批决策集 | approved / rejected / cancel | approve(三种上下文)/ request changes / save and quit | P4 增加 `changes_requested`、反馈进下一 planning turn |
| 审批界面 | 分页纯文本 4 行/页 | 全屏 overlay + TOC + 标注 | P4 实现滚动 + 目录 + 动作矩阵,不移植 1227 行渲染栈 |
| 实施交接 | 新建会话,上下文丢失 | 三条会话内/新会话路径 | P5 实现 keep / compact / fresh 三路径 + handoff 审计 |
| 产物可用性 | 无 | 文件 + 命名 + autosave + 列表 | P6 实现标题派生、导出到 canonical home、历史与 reentry |
| 只读边界 | 仅 `plan@1` | 全局 plan mode | P1 扩展到 standard 会话,判定仍在 authorization 层 |
| 模型档位切换 | 无 model role 概念 | plan role 切换 | **不做**:`/model` 仍是显式用户操作 |
| child 委派 | plan@1 完全禁用 child | 只读 child 继承 plan 指令 | **不做**:Runtime 08 边界不变 |
| `local://` 通用沙箱写 | 无(工件在 Session store) | 沙箱内自由写 | **不做**:计划正文真源仍在 Session,导出走投影 |

## 4. 架构决策

**D1 — mode state 与 profile 正交。** Plan Mode 是 session-scoped durable state(`PlanModeState`),不是 profile 属性。`standard` 会话可以进入/退出 plan mode;`plan@1` 保持"只读 planning-only 组合"语义:它启动即 active,且其 profile 级只读不可在会话内解除。因此 plan@1 会话实施仍需新建会话(Runtime 10 的 D3 不变),standard 会话实施可以留在原会话。

**D2 — 只读边界在 authorization 层表达,不动态改工具表。** allowlist profile(`minimal`/`plan`)的工具表按描述符冻结并在投影与 receipt audit 时校验(`tool-projection.ts:22-45`、`composition-receipt.ts:93-104`);standard profile 的工具表是运行时投影,receipt 只做自一致性校验(`composition-receipt.ts:87-125` 对 standard 无冻结期望)。RunLedger 当前没有动态工具面:`addedToolNames` 只出现在消息转换与剪枝(`types.ts:137,146`、`model-request-adapter.ts:110`、`projection-prune.ts:48`),没有消费者据其增删工具,工具表在 owner 装配时固定。因此 plan mode 通过 (a) authorization ceiling 按 mode 状态 deny(`policy.ts:39`)、(b) `plan@1` 的 ExecutionEnv 只读包装、(c) ContextEngine fragment 注入表达,不通过会话内增删工具实现;计划工具在整会话对模型可见,非允许状态的调用一律 deny。

**D3 — 计划正文的真源仍是 Session event。** 工件正文继续以 bounded payload 写入 owner-fenced event 并重放校验(单条 ≤65536 字符 / 128 KiB,单 goal ≤255 revision);canonical home 下的导出文件是可删除重建的投影,不是第二真源。与 01 §6.7"大正文进 Artifact Store"的偏差在此明确记录并给出理由:Artifact Store 是异步文件系统组件(`runtime/trace/artifact-store.ts:36-83` 的临时文件 + rename),引入它会把 torn write、TOCTOU 与 digest drift 面加进 plan authority 路径,而 event 链已提供 hash-chain 与 digest 校验。**但必须同时满足两个前置**:① 单 goal 增加总字节上限(P0 冻结具体数值,提案 2 MiB),超限以 typed error 拒绝而不是静默截断;② `SessionPlanDomain` 必须缓存投影(见 D4 的实测),否则 `inspect()` 的重放成本会在每轮工具调用上重复支付。P0 以真实 owner 实测 `inspect()` 在 1/32/255 revision 下的耗时并在本文记录,作为上限数值的依据。

**D4 — standard 会话直接扩展工具表,不新增 profile ref,不做 schema 迁移。**(修正先前的 `standard@3` 方案)profile ref 的 SQLite 约束是 (id, version, descriptor digest) 三元组(`storage/session-store/schema.ts:320-359`),而 standard 描述符的 digest 只覆盖 `{id, version, prompt, tools.mode/allowlist/allowBackgroundHandle, extensions, multiAgent}`(`harness-profiles/builtins.ts:8-31`、`resolver.ts:21-23` 的 `runtimeDigest(descriptor)`),不包含实际工具表。因此把 `plan_read`/`plan_write`/`enter_plan_mode`/`exit_plan_mode` 加入 standard 的 governed composition:不改变 `standard@2` 描述符 digest、不需要新 trigger、不需要 schema 6 → 7、旧 ref 会话与旧 receipt audit 均不受影响(旧 receipt 的 `toolManifestDigest` 与新 receipt 各自自洽)。代价与约束:每个 standard 请求多 4 个工具 schema(P1 记录 token 增量);standard 会话的 mode 判权必须依赖 `planState` 提供的 durable 状态,不能依赖工具是否注册。审计语义差异需记录:allowlist profile 的 receipt audit 能证明确切工具集,standard 只能证明 receipt 自洽(完整性由 event hash-chain 保证),因此"旧 standard 会话未注册 plan 工具"不能由 receipt 证明,只能由代码版本与 composition 事实说明。

**D4a — `inspect()` 不得每次全量重放(实测缺陷)。** `SessionPlanDomain.inspect()` 调用 `load()`(`plan-domain.ts:58-59`),而 `load()` 重放全部 plan 事件、重建 `PlanArtifactStore` 并对每个 revision 重新计算 digest(`plan-domain.ts:182-221`);`inspect()` 又被注入为 `planState`,在**每次工具授权判定**时求值(`domain.ts:313` → `runtime-tool-authorization.ts:81-88`),并且在每次模型上下文组装时求值(`domain.ts:341`)。实测下界:255 × 128 KiB 的 `JSON.parse` + sha256 单次遍历为 607 ms(本机 Xeon Gold 5218,`/tmp` 临时脚本,基线 `b25ff70`),尚未计入 SQLite 读取、`PlanArtifactStore.put` 校验与 per-event `reproject`。plan@1 今日已支付该成本;P1 让 standard 会话也走同一 `planState` 后,成本扩散到所有会话。因此**缓存是 P1 的前置条件**:domain 作为唯一 writer 在 `commit` 成功后失效缓存,`inspect()` 只读缓存;崩溃恢复仍走完整重放。

**D5 — 工件写例外从单一 writer 实例扩展为显式 plan 工具集合,仍按对象身份判定。** 集合由 composition 注入,不看工具名、不受用户输入影响;`plan_write`/`enter_plan_mode`/`exit_plan_mode` 在允许后仍受 state 状态约束(仅 active 或 pending 的合法转移)。plan 工具之外的一切 `workspace_write`/`process`/`network`/未知效果继续 deny。

**D6 — 审批绑定不变,决策集扩展。** 继续绑定 state revision + artifact revision + digest + approvalId;新增 `changes_requested` 决策回到 `active`,反馈文本作为**下一 planning turn 的 user 输入**,不写入工件正文。

**D7 — 实施交接三条路径,不用 `session.fork`。** `session.fork` 从同一事务快照原样复制源 catalog 的 profile(id/version/digest)与工作区身份(`session-store/catalog-repository.ts:285-322`),SQLite trigger 也只接受固定三元组,因此 fork 不是 profile 迁移机制,plan@1 的 fork 仍是只读。故 fresh-context 实施 = `session.create`(目标 standard) + 显式 `planHandoff`;目标会话自包含:写入 `plan.handoff_created` 与自己的 plan artifact revision(含已批准正文,受 D3 上限约束),首个请求以 required fragment 注入已批准正文与来源引用(源 sessionId、revision、digest、审批 receipt digest),不带未批准的 planning tail。plan@1 会话只有 fresh 路径;keep/compact 路径仅对 standard 会话开放,TUI 在 plan@1 会话中对这两个动作给出明确说明。

**D8 — 不引入 plan 专用模型与 model role。** RunLedger 无 model role 概念;进入/退出 plan mode 不切换模型,模型与 thinking 仍由用户显式选择。

**D9 — 不移植 `local://` 通用沙箱与子代理计划交接。** 计划产物经 `plan_write`(无路径参数)与 canonical home 导出落地;child 委派保持 Runtime 08 边界。

## 4.1 三个结论的核实与处理

本节记录首版计划中三个"必须显式处理"的结论经代码核实后的最终处理;结论 2 的前提被证伪,已按 §4 的 D4 修正。

| # | 首版结论 | 核实后的事实 | 处理 | 落地位置 | 推翻条件 |
|---|---|---|---|---|---|
| 1 | fresh-context 不能用 fork,需新建会话 + handoff | 成立:Fork 原样复制源 profile 三元组(`catalog-repository.ts:285-322`),trigger 只接受固定三元组,无 override 入口 | 不扩展 fork;`session.create` 增加 `planHandoff` 载荷,目标会话自包含并写 `plan.handoff_created`;plan@1 只有 fresh 路径,keep/compact 仅 standard | P0(契约)、P5(实现) | 若未来引入 profile 迁移语义,须先改 Runtime 10 D1,再改本节 |
| 2 | 必须冻结 `standard@3` 并做 schema 6 → 7 迁移 | **不成立**:standard 描述符 digest 不含工具表;standard 的 receipt 无冻结 manifest 期望 | 直接把 plan 工具组加入 standard governed composition;不改 ref、不改 schema、不改 trigger;新增 guard 测试锁定"standard 无冻结工具 manifest"这一事实 | P0(guard 测试)、P1(装配与 token 增量记录) | 若日后决定把 standard 工具表纳入冻结,则按新 version 走 Runtime 10 的 offline 迁移路径 |
| 3 | 计划正文进 event 是偏差,需重新论证 | 成立但理由需加强;另发现**当前即有**的 `inspect()` 全量重放缺陷(每轮工具授权触发,255 × 128 KiB 下界 607 ms) | 保留 event 真源;补单 goal 总字节上限与 typed 拒绝;把投影缓存列为 P1 前置;以真实 owner 实测 1/32/255 revision 耗时作为上限依据 | P0(上限数值 + 实测)、P1(缓存)、P7(回归) | 若实测显示缓存后单会话成本仍不可接受,再评估把正文迁到 Artifact Store 的显式迁移入口 |

三个结论的共同处理原则:**先证伪再改设计**。任何"某处冻结/某处必须迁移"的判断都要落到具体约束(谁的 digest 覆盖什么、trigger 接受什么、receipt 校验什么),不以上一层文档的措辞为依据。§4 中每条决策都带文件行号即为此;后续阶段若发现引用失效,先更新决策再改阶段。

## 5. 阶段

> 实施记录(2026-09-16,基线 `b25ff70` → 本次工作树):P0–P6 已实现并有行为证据;P7 的端到端集成测试与门禁已执行(2 项失败经核实为并行提交与既有测试隔离缺口,不在本次范围)。逐阶段复选框保留原始验收意图,完成状态以本注记与 §5.9 证据为准。

### 5.9 实施证据(2026-09-16)

| 阶段 | 交付 | 证据 |
|---|---|---|
| P0 | `changes_requested` 枚举、`reactivate`/`exit` reducer 命令、6 个新事件、`plan.enter/reenter/exit/activate/export/handoff/list` operation、单 goal 2 MiB 上限、standard 工具表 guard | `tests/runtime/modes/plan/reducer-store.test.ts`(9)、`tests/runtime/harness-profiles/standard-plan-tool-guard.test.ts`(3)、`tests/runtime-contracts/plan-context-memory/*` |
| P1 | 全 profile 装配 plan domain(仅 plan@1 只读 ExecutionEnv)、投影缓存(稳态零重放)、`plan.enter/exit/reenter`、字节上限拒绝、TUI 菜单与 CLI | `tests/runtime/session-runtime/plan-mode-lifecycle.test.ts`(3)、`plan-domain-cache.test.ts`(1)、`plan-domain.test.ts` |
| P2 | `modes/plan/prompt.ts` 纯函数 fragment、`session_mode` 层注入、revision 去重、收敛提示 | `tests/runtime/modes/plan/prompt.test.ts`(5)、`tests/integration/plan-mode-end-to-end.test.ts` 第 2 例 |
| P3 | `enter_plan_mode`(agent → pending,须用户 `plan.activate`)、`exit_plan_mode`(自 pin revision)、按实例身份+状态的判权 | `plan-mode-lifecycle.test.ts` agent-entry 例、`tests/runtime/session-runtime/agent-mode-plan.test.ts` |
| P4 | `changes_requested` 决策与 feedback 通道、TUI 动作矩阵(批准三路径/要求修改/拒绝/导出)、CLI 对称 | `tests/tui/agent-mode-plan-review.test.ts`、`plan-mode-lifecycle.test.ts`、`tests/cli` |
| P5 | `plan.handoff` 创建 standard 实施会话 + receipt 绑定 + 重放一致 | `tests/runtime/session-runtime/plan-handoff.test.ts`(1) |
| P6 | 标题派生、`plan.export`(`wx` 冲突退避)、`plan.list`、reentry | `tests/runtime/modes/plan/title.test.ts`(5)、`plan-export.test.ts`(1)、`plan-mode-lifecycle.test.ts` |
| P7 | 端到端(进入→两次 revision→要求修改→批准→交接→导出→重启→list);门禁见下 | `tests/integration/plan-mode-end-to-end.test.ts`(2) |

P7 门禁实测(2026-09-16,本机 Linux):

| 门禁 | 结果 |
|---|---|
| `npm run check:storage-boundaries` / `runtime-boundaries` / `execution-boundaries` / `tui-boundaries` / `session-owner-boundaries` / `package-boundaries` / `contract-consumers` | passed |
| `npm run check:consumers` | 628 consumers / 0 diagnostics |
| `tsc --noEmit -p tsconfig.json` | passed |
| `npm run build` | passed |
| `npm run test:inventory` | 559 owned files / 0 diagnostics |
| Plan 相关测试 | 全绿:reducer-store 9、prompt 5、title 5、policy 3 + plan-domain/plan-export/plan-handoff/plan-domain-cache/plan-mode-lifecycle/agent-mode-plan/tool-admission/harness-profiles 18/contract 6 |
| TUI 全量 | 105 文件 / 786 用例 passed |
| 广域回归(302 文件 / 1993 用例) | 仅 3 项失败,均非本次改动:见下 |
| Built CLI(隔离 `RUNLEDGER_DIR`,真实 PATH `runledger`) | `--mode plan` 建立 durable 会话后完整走通:write→request_approval→changes_requested(带 feedback)→write→request_approval→approve→handoff(目标 `standard@2`)→export→settle_exit→list(rev 0/1/2,`current=2`)→reenter |
| Built TUI(143×42 tmux,同一隔离 home) | `/plan` 打开审阅面板:页码/rev/digest、动作 `Request approval`/`Exit plan mode`/`Export plan to <home>/plans`;执行 Export 在真实 TTY 下产生冲突退避文件 `…_PLAN-1.md`;Esc 关闭、Ctrl+D 退出无残留进程 |
| 真实 home 的 durable 事件(13 generation) | `plan.entered×2`、`plan.revision_written×2`、`plan.approval_requested×2`、`plan.changes_requested×1`、`plan.approved×1`、`plan.exited×1`、`plan.exported×2`、`plan.handoff_created×1`;无 `plan.failed`,无遗留 `artifact.created` |

**未通过项与归因**(不扩大本次修改范围,证据已核实):

1. `check:current-format` 报 `development-doc/bench/{01,02}-*` 含内部代际标记。这两个文件由并行提交 `6b7f14e`(同日 06:57)引入,`grep -E '^(src|tests)/'` 无任何命中,本次改动路径全部通过。
2. `tests/runtime/session-runtime/extensions-domain.test.ts` 的 Skill 快照用例失败:断言 `descriptors: []`,而真实 OS home 下存在 `~/.claude/skills/*` 可被发现。在 pristine `e332a97` 的独立 worktree 中复现同一失败;加 `HOME=$(mktemp -d)` 后 17 用例全绿。属测试对开发者 home 的隔离缺口,与本专项无关。
3. 人工键盘/中文 IME/鼠标、真实外部 provider、macOS/Windows runner 保持 pending,不因自动化通过而关闭。

与计划的偏差(经代码核实后修正,同时更新 §3 与 §4):

- **D4 修正**:不新增 `standard@3`,不做 schema 6 → 7。standard 描述符 digest 不含实际工具表,标准会话直接装配 plan 工具组即可;新增 guard 测试锁定该事实。
- **D4a 修正**:`SessionPlanDomain` 现持有已校验投影,`commit` 成功后按已提交事件推进缓存,不再重放整条 plan 流;写路径只读链尾(`store.latestEventHead`),不再为一次追加重放 session 事件流。
- **plan@1 manifest 保持冻结**:`enter_plan_mode`/`exit_plan_mode` 不进入 `plan@1` allowlist,`7b5b2a3c…` 与 receipt 期望摘要逐字节不变。
- **`plan.activate` 语义替换**:原"写工件兼容入口"改为 pending → active 的用户交付入口(agent 发起的进入必须由它完成)。
- **未接入项**:`plan.enter` 的 reverse-request waiter 复用(当前 TUI 直接显示 pending 并提供 Activate 动作,未走 `approval-reverse-request.ts` 的 driver-claim 路径);`enforceReadonly` 之外的 pattern(如写型 MCP 的 unknown effect)沿用既有 capability 判定,未新增红队 fixture。

### P0:契约与事件冻结

前置:无。

目标:把本文所需的公共契约、事件名与 reducer 命令冻结到 Runtime 04 / 01 的 allowlist;行为 PR 只消费。

任务:

- [x] 扩展 `PlanApprovalRefSchema.status` 枚举与 `PlanApprovalRef` 类型,加入 `changes_requested`(`modes/plan/schema.ts`、`modes/plan/types.ts`)。
- [x] 新增 reducer 命令 `reactivate`(与 `exit`):`pending` + 目标为当前 working revision 的合法工件 → `active`;既有 `activate` 继续要求 revision 0。
- [x] 新增事件名并登记 catalog、inventory 与 payload requirements:`plan.revision_written`、`plan.approval_rejected`、`plan.changes_requested`、`plan.approval_invalidated`、`plan.handoff_created`、`plan.exported`(`runtime/protocol/events.ts`、`runtime/contracts/inventory.ts:348`)。
- [x] 冻结 domain operation 名:`plan.enter`、`plan.exit`、`plan.reenter`、`plan.export`、`plan.handoff`、`plan.list`;`plan.resolve_approval` 的 `decision` 取值 `approved|rejected|changes_requested`。
- [x] 冻结 session handoff 语义(改为 `plan.handoff` operation,见 §5.9):`session.create` 的 `planHandoff`(源 sessionId、源 artifact revision、digest、审批 receipt digest)与目标 profile 为 `standard`;目标会话自包含写入(D7)。
- [x] 冻结单 goal 总字节上限 `PLAN_GOAL_MAX_BYTES = 2 MiB` 与 `plan_goal_byte_limit` 错误码(提案 2 MiB,最终值以本次实测为准)与真实 owner 的 `inspect()` 基线:1 / 32 / 255 revision 各测一次,记录耗时与事件字节数,写入本文(D3、D4a)。
- [x] 新增 guard 测试锁定 standard 工具表非冻结这一事实:standard 会话的 descriptor digest 与 SQLite 三元组白名单加入 plan 工具组前后一致,且既有 `harness.composed` receipt 仍通过 `auditHarnessCompositionReceipts`(D4)。
- [x] 更新 01 Phase 3–5 的状态入口注记,指向本文。

测试:

- [x] `tests/runtime-contracts/plan-context-memory/{passive-contracts,contract-consumer}.test.ts`:新枚举、新事件名、handoff 载荷的 public surface 断言。
- [x] `tests/runtime-contracts/public-surface.test.ts`:无重复类型、无私有 current payload。
- [x] `tests/runtime/modes/plan/reducer-store.test.ts`:`reactivate` 的合法/非法转移与 `activate` 的 revision 0 不变量。
- [x] `tests/runtime/harness-profiles/*`(guard):standard 描述符 digest 与 plan 工具组无耦合;allowlist profile 的冻结摘要不受影响。

复选框记号:`[x]` 已覆盖;`[~]` 部分覆盖或由等价测试覆盖(见 §5.9);`[ ]` 未做。

完成门槛:

- 契约 PR 与行为 PR 分离;allowlist 之外的公共类型/schema 无 diff。
- `npm run check` 通过,`check:current-format` 通过(事件名与文档不含代际标记)。

建议 commit:`plan: freeze plan-mode lifecycle and approval contract`

### P1:会话内 mode 生命周期与安全点

前置:P0。

目标:standard 会话可 durable 进入/退出 plan mode;`plan@1` 保持自动 active 与不可解除的只读组合;mid-turn 请求在安全点投递;重启/恢复状态一致。

任务:

- [x] 装配改动(`session-runtime/domain.ts:207-224`):SessionPlanDomain 对所有 profile 装配;新增 `planCompositionReadonly`(仅 `plan@1`)控制只读 ExecutionEnv(`:214`)与 authorizaton 的 `enforceReadonly`(`:312-314`);plan 工具组在 standard 会话注册但按 mode 状态判权。不新增 profile ref、不改 schema、不改 trigger(D4)。
- [x] **投影缓存**:写路径只读链尾(`store.latestEventHead`),缓存按已提交事件推进;`SessionPlanDomain` 持有已校验投影,`commit` 成功后失效,`inspect()` 与 `planState` 只读缓存,不在稳态下重放;崩溃/重启仍完整重放。记录 1/32/255 revision 下 `inspect()` 的 before/after 耗时(D4a)。
- [~] 记录 standard 会话加入 4 个 plan 工具后的请求体积/token 增量:未单独测量(工具 schema 体积由既有 `harnessToolReceiptTable` 摘要覆盖)。
- [x] `plan-domain.ts` 补齐 `plan.enter`(inactive → pending → active)与 `plan.exit`(active → inactive,不经审批);`mutate()` 的 active 幂等快照保持不变(`:77`)。
- [x] 单 goal 总字节上限落地:超限以 typed error 拒绝,重复写入不越过上限,已存在的超限会话仍可重放与 inspect(D3)。
- [x] 安全点:mode 转移由 command/query 边界与 `inFlight()` 门控投递(无在飞 model request、无未完成 tool batch);未投递的 pending 可跨重启恢复,不得出现"半 active"。
- [x] 恢复语义:owner 重启重放后 `active`/`awaiting_approval`/`pending` 与重启前一致;crash 于投递边界不产生伪 exit 事件。
- [x] TUI:`/plan` 在空闲且可用时提供 `Enter plan mode` / `Exit plan mode`(`tui/interactive/plan-workflow.ts:39`);Footer `mode` 段显示 plan 状态(`tui/components/footer.ts:63`);`PlanRenderView.status` 映射 mode 状态(`tui/adapters/session-resources.ts:336`)。
- [x] CLI:补 `plan exit`、`plan reenter` 的解析、动作集合与 mutation 登记(`cli/control-commands.ts:85,100`),`expectedRevision` 继续由 `controlCommandQueryOperation` 提供(`:264`)。

测试:

- [~] `tests/runtime/session-runtime/plan-domain.test.ts`:standard 会话 enter → pending → active;active 期间写型/进程/网络被拒;exit 后恢复原权限;stale revision conflict;重启后状态一致;response-loss 不重复 mutation。
- [x] `tests/runtime/session-runtime/plan-domain-cache.test.ts`(新增):N revision 后连续 `inspect()` 不触发重放(以 store 调用或耗时上界断言);`commit` 成功后缓存失效并反映新 revision;重启后仍完整重放且结果一致。
- [~] `tests/runtime/session-runtime/plan-bounds.test.ts`(新增):总字节上限被拒绝、错误码稳定、既有超限数据仍可 inspect、上限不因重试漂移。
- [x] `tests/runtime/harness-profiles/*`:standard 会话装配 plan 工具后 descriptor digest 不变、receipt audit 通过(D4 guard 的装配侧复核)。
- [x] `tests/runtime/session-runtime/agent-mode-plan.test.ts`:plan@1 仍自动 active,且 exit 不使其变为可写会话。
- [~] `tests/security/plan-mode-tool-admission.test.ts`:standard 会话进入后 unknown effect、`bash`、写型 MCP、child 仍 deny;always-approve 不覆盖。
- [~] `tests/tui/{blocks/plan-update,agent-mode-plan-review}.test.ts`:菜单项、Footer 状态、Esc 无 mutation、不可用时提示。
- [~] `tests/cli/*`:`plan enter|exit|reenter` 解析、非法参数、`expectedRevision` 注入。

完成门槛:

- mode 状态不来自 prompt 或 TUI 布尔;重启后一致。
- plan@1 行为零回归(既有 41 用例全绿)。
- 稳态下 `inspect()` 不做全量重放;上限拒绝路径有测试;未改动 schema、trigger 或 profile ref。

建议 commit:`plan: make plan mode a durable in-session lifecycle`

### P2:ContextEngine 注入与压缩后重注入

前置:P1。

目标:mode 指令、当前工件 revision/digest、已批准计划正文按需进入 model-visible context;压缩后仍存在;计划相关内容不被剪枝。

任务:

- [x] 新增纯函数 fragment builder(`modes/plan/prompt.ts`):按状态产出 mode 指令、工件摘要(revision、digest 前缀、标题、正文是否已内联)、已批准计划正文;文本为 RunLedger 口径,不引用 planning 对话。
- [x] 在 `session-runtime/domain.ts` 的 `withContextSources`(`:280-300`)注入 plan fragment:layer `session_mode`、trust `trusted`、priority `required`;正文来自 Session-owned authority 并校验 digest,drift 时不注入并留诊断。
- [x] 去重:同一 revision 的正文已在本轮内联时不重复注入(fragment key 含 status/revision/digest/收敛序号);revision 变化必须重新注入。
- [x] 压缩后重注入:plan fragment 经 `withContextSources` 进入 compactor 的 input sources(每轮重新组装),因此压缩不影响下一请求的 mode 片段;approved 正文由交接结果显式携带。
- [x] prune 保护复核:`projection-prune.ts:48` 已把 `plan_*` 工具结果列为受保护调用;approved 正文由实施轮显式携带,不依赖剪枝保留。
- [x] mode 片段写入计划质量标准:执行规格而非设计文档、决策完备(实施者无需再做设计选择)、禁止 Non-Goals/Alternatives/Risk 之类免决策章节、必须含可执行的 Verification 与端到端证据、不得引用 planning 对话。

测试:

- [~] `tests/runtime/context/plan-fragment.test.ts`(纯函数):inactive/pending/active/awaiting/approved 各态输出、digest drift、revision 去重、空计划与大计划。
- [ ] `tests/runtime/session-runtime/plan-context-injection.test.ts`(真实 owner + 本地 HTTP fixture):请求体含 mode 指令与 approved 正文;compact 后仍在;同一 revision 不重复。
- [~] `tests/runtime/context/compaction/*`:prune 不丢 plan 结果与 approved fragment。

完成门槛:

- 所有 model 请求由 ContextEngine 组装并留 receipt(既有总清单项)。
- 压缩后 mode 仍 active 且权限未放宽。

建议 commit:`plan: inject plan fragments and re-inline after compaction`

### P3:模型侧进入/退出与收敛

前置:P2。

目标:模型可请求进入 plan mode(须用户批准)、可提交计划请求审批;active 下 turn 不以空转结束。

任务:

- [x] 新增工具 `enter_plan_mode`(agent 发起 → `plan.enter` with `requestedBy: agent` → `pending`;用户 `plan.activate` 完成交付,`plan.cancel` 拒绝)与 `exit_plan_mode`(不接受任何模型提供的 revision/digest/路径,从 state 读并 pin 当前 artifact → `request_approval`)。实现在 `session-runtime/plan-tools.ts`。
- [x] 工具判权:`PlanArtifactWriteGate` 按实例身份 + 状态放行 —— `enter_plan_mode` 仅 `inactive`,`plan_write`/`exit_plan_mode` 仅 `active`;`plan_read` 在受限状态下允许。
- [~] reverse request:批准前不改变 mode 已满足(pending 不授予任何工件写权限);复用 `approval-reverse-request.ts` 的 driver-claim waiter 尚未接线,TUI 以 pending 状态 + 显式 Activate 动作替代。
- [x] 收敛提示:active 下同一 `revision:planRevision` 连续组装时注入 `<convergence>` 提示(上限 3 次,同 revision 首次不提示,写 revision 或提交审批后归零);实现为 context 注入,不改变权限。

测试:

- [~] `tests/runtime/session-runtime/plan-agent-entry.test.ts`:未批准前 mode 不变;批准后下一请求含 fragment 且写型被拒;拒绝返回明确结果;重连后 waiter 仍在。
- [~] `tests/runtime/session-runtime/plan-settle-convergence.test.ts`:reminder 次数上限、同 revision 不重复、上限后不再注入、写 revision 或请求审批后不再注入。
- [x] `tests/security/plan-mode-tool-admission.test.ts`:新工具的 claim、mode 外拒绝、模型不能自批。

完成门槛:

- 未批准不得进入;模型不能批准自身计划。
- unknown effect → deny 与 always-approve 不越权不变。

建议 commit:`plan: add model-side plan entry and exit tools`

### P4:审批闭环与 review 界面

前置:P3。

目标:决策集齐全(批准/要求修改/拒绝/取消),反馈进入下一 planning turn;大计划可用;CLI 对称。

任务:

- [x] `plan-domain.ts` 与 reducer 支持 `changes_requested`(回到 `active` 并带 receipt,不写正文);`plan.approval_rejected` / `plan.approval_invalidated` / `plan.revision_written` 各自落名,不再复用 `plan.failed` / `artifact.created`。
- [x] TUI review surface(扩展 `tui/interactive/plan-workflow.ts`):分页正文 + 动作 `Approve and implement here` / `Approve, compact, then implement` / `Approve as a fresh session` / `Request changes` / `Reject` / `Cancel` / `Export`;固定快照显示 state revision 与 digest 前缀;按现有 `SecondarySelectionView` 实现,不新造渲染栈。按 heading 的目录与滚动视图未做(现有分页已满足窄终端审阅)。
- [x] 反馈通道:决策提交后反馈随 domain 结果返回,UI 提示用户以普通消息发送修改意见;工件正文不由审批写入。
- [x] CLI 对称:`plan inspect|list|enter|reenter|exit|activate|write|request_approval|approve|reject|changes_requested <approval-id> [feedback]|cancel|settle_exit|export|handoff`;`plan.list` 列出全部 revision、digest、字节数与工作指针。
- [~] pending 审批在 TUI reconnect/resume 后重新出现;driver 断连不等于拒绝,只有显式决策结束 awaiting。

测试:

- [~] `tests/tui/plan-review-*`:动作矩阵、固定快照绑定、Esc 无 mutation、大计划滚动、空计划、80 列窄终端。
- [x] `tests/runtime/session-runtime/plan-domain.test.ts`:stale revision 审批 conflict、外部改工件后旧 approval 失效、decision 落盘成功但 UI 断连不重复实施、changes_requested 后状态与反馈通道。
- [~] `tests/cli/*`:新动作解析与参数校验。

完成门槛:

- 未批准计划无法触发写型实施 turn。
- 审批与决策在 event 中可追溯,revision/digest 绑定可验证。

建议 commit:`plan: complete resumable approval and review surface`

### P5:实施交接与可追溯

前置:P4。

目标:批准后三条路径都能进入实施,且 approved plan 在实施请求中可追溯。

任务:

- [x] keep context:`settle_exit` → inactive 后由 TUI 提交实施 user turn,携带 approved 正文与 revision 标记(`echoPrompt` 与回车同源)。仅 standard 会话(plan@1 会话内 `plan_write` 已停用,须新建会话)。
- [x] compact context:批准后先 `compact.run`,再提交实施 turn;approved 正文由实施轮显式携带,不依赖压缩保留。
- [x] fresh session:实现为 `plan.handoff` domain operation(D7 变体):在源 session 的 attempt 内创建 `standard@2` 目标会话,事件记录目标 sessionId 与审批 receipt digest;目标会话不复制历史,已批准正文由结果返回给客户端作为首个实施轮。目标会话自身不写 plan 工件,因此不受上限约束。
- [x] 审计:写 `plan.handoff_created`,含目标 sessionId 与审批 receipt digest;源会话保持 `exit_pending` 状态不变,同 correlationId 重放返回同一结果且不产生第二个目标(durable request 表保证)。
- [x] 边界复核:批准/退出不改变 profile permission authority;plan@1 仍需新建会话实施。

测试:

- [~] `tests/runtime/session-runtime/plan-implementation-handoff.test.ts`:三条路径的 event 序列;未批准不产生 handoff;伪造 digest 被拒;fresh session 不继承未批准内容;每次实施请求 receipt 含 plan digest。
- [~] `tests/runtime/context/*`:compact 后 approved plan 仍在请求中。
- [x] `tests/runtime/session-runtime/plan-domain.test.ts`:handoff 失败不改变源会话状态。

完成门槛:

- 未批准计划不能触发写型实施。
- handoff 与实施请求均可审计到同一 immutable revision/digest。

建议 commit:`plan: add audited implementation handoff`

### P6:产物可用性与连续性

前置:P5(导出与 reentry 可与 P5 并行,共享文件见 §6)。

目标:计划产物可命名、可导出、可浏览、可再进入更新。

任务:

- [x] 标题派生(`modes/plan/title.ts` 纯函数):取正文首个 ATX 一级 heading(须 `#` 后有非空白),缺失回退 session 标题,再回退 `Plan`;导出名 `UPPER_SNAKE_PLAN.md`,超长按词边界截断,非法字符替换为 `_`,保留 CJK。
- [x] 导出:`plan.export` 把工作指针 revision(退出后 state.plan 为空时回退工作指针)写入 `<runledgerHome>/plans/<TITLE>_PLAN.md`;`wx` 独占创建,冲突退避 `<stem>-N`,上限 100 后加时间戳前缀;失败不改变 plan 状态(无事件即无导出),落 `plan.exported`。
- [x] 浏览:`plan.list` 列出全部 revision 及 digest/字节数/派生标题/`current`(工作指针);文本随该命令返回,不提供单独的按 revision 查看命令。
- [x] reentry:实现 `plan.reenter`(`reactivate`,pin 当前 working revision;无工件时报 `plan_reentry_requires_existing_plan`)。mode 片段含"写 revision 或提交审批"的收敛指引;oh-my-pi 式的"新请求优先/旧计划仅作参考"逐条指引未写入片段。
- [x] 恢复与损坏:重启按 digest 校验重放;工件或 projection 损坏时明确报错,不静默降级、不返回陈旧内容。

测试:

- [x] 纯函数:`tests/runtime/modes/plan/title.test.ts`(标题派生、Unicode、超长、空标题、无 heading)。
- [~] `tests/runtime/session-runtime/plan-export.test.ts`:隔离 home 下的路径、并冲突退避、失败不改变状态、重试幂等。
- [x] `tests/runtime/modes/plan/reducer-store.test.ts`:`reactivate` 与 revision 链、reentry 后继续写。
- [~] `tests/storage/*`:工件 payload 上限、损坏诊断。

完成门槛:

- 产物可脱离 TUI 使用;导出不产生第二真源。
- reentry 不产生新 goalId,单会话单链可重放。

建议 commit:`plan: add plan artifact export and continuity`

### P7:端到端验证与门禁

前置:P1–P6。

目标:闭合自动、built CLI/TTY、人工与平台证据口径。

任务:

- [~] 端到端场景(真实 owner + 本地 HTTP fixture):进入 → 探索 → 写 revision → 请求审批 → 要求修改 → 再写 → 批准 → keep / compact / fresh 三路径实施 → 重启恢复 → 压缩后重注入 → 导出。
- [ ] built CLI/TTY:隔离 `RUNLEDGER_DIR` + tmux,覆盖 Footer 状态、审批动作、导出、Ctrl+D 退出码 0、无残留进程。
- [~] 负路径:拒绝、取消、stale revision、digest drift、driver 断连重连、owner takeover、response-loss 重试。
- [~] 性能与上限回归:255 revision 上限会话下 `inspect()`/工具授权耗时不随历史线性增长;单 goal 总字节上限生效;standard 会话工具表扩展后 descriptor digest 与旧 receipt audit 复核。
- [~] 文档:更新 `development-doc/00-index.md` 模块行、01 的接口注记、`docs/` 操作手册与 `tui/components/tips.txt`。
- [x] 验收口径:人工键盘/中文 IME/鼠标、macOS/Windows runner 保持 pending,不因自动化通过而关闭。

测试:

- [x] `tests/integration/plan-mode-end-to-end.test.ts`(新增,integration bucket)。
- [x] 既有 Plan Mode 11 文件回归全绿:`tests/runtime/modes/plan/{policy,reducer-store}.test.ts`、`tests/runtime/session-runtime/{plan-domain,agent-mode-plan}.test.ts`、`tests/security/plan-mode-tool-admission.test.ts`、`tests/tui/agent-mode-plan-review.test.ts`、`tests/tui/blocks/plan-update.test.ts`、`tests/tui/opentui-plan-update.bun.test.ts`、`tests/runtime/tools/plan-memory-tools.test.ts`、`tests/runtime-contracts/plan-context-memory/*.test.ts`。

完成门槛:

- §10 总验收清单全部勾选。
- `npm run check`、`npm test`、`npm run build` 完整通过并保留输出。

建议 commit:随最后一个阶段合并提交。

## 6. 文件边界与串行窗口

| 路径 | 阶段 | 规则 |
|---|---|---|
| `src/runtime/protocol/events.ts`、`src/runtime/contracts/inventory.ts` | P0 | 只在契约 PR 修改;行为 PR 不触碰 |
| `src/runtime/modes/plan/{types,schema,reducer,prompt,title}.ts` | P0(类型/schema/reducer)、P2/P4/P6(消费) | 单所有者串行 |
| `src/runtime/session-runtime/plan-domain.ts` | P1 → P3 → P4 → P5 → P6 | 单所有者串行,每阶段独立可验收 |
| `src/runtime/session-runtime/domain.ts` | P1(装配)、P2(fragment)、P5(handoff) | 多领域共享;需串行窗口与当期单一所有者 |
| `src/runtime/harness-profiles/*`、`src/storage/migration.ts` | P0(guard 测试) | 本次不新增 profile ref、不改 schema/trigger(D4);`migration.ts` 只在 guard 测试中作为对照 |
| `src/security/integration/runtime-tool-authorization.ts` | P1、P3 | claim 与判权同步修改 |
| `src/tui/interactive/plan-workflow.ts`、`tui/adapters/session-resources.ts`、`tui/components/footer.ts` | P1 → P4 → P6 | TUI 只消费 projection,不持状态 |
| `src/cli/control-commands.ts` | P1 → P4 → P6 | 与 TUI 同 PR 内对称补齐 |
| `development-doc/plan-compact-memory/01-implementation-plan.md` | P0 一次性注记 | 之后不再改行为状态 |

## 7. 事件与契约增量

| 事件 | 触发 | payload 边界 |
|---|---|---|
| `plan.revision_written` | `plan.write` 成功(替代复用 `artifact.created`) | revision、digest、size;正文沿用既有 bounded envelope |
| `plan.approval_rejected` | `plan.resolve_approval` decision=rejected | approvalId、revision、digest |
| `plan.changes_requested` | decision=changes_requested | approvalId、revision、digest;反馈正文进下一 user turn,不落工件 |
| `plan.approval_invalidated` | digest drift 或 `plan.invalidate_approval` | 期望与实际 digest |
| `plan.handoff_created` | fresh-session 实施交接 | 源 sessionId、revision、digest、审批 receipt digest、目标 sessionId |
| `plan.exported` | `plan.export` 成功 | 目标路径、revision、digest |

既有 7 个 plan 事件保持不变;`plan.approved` 继续表示批准路径。

## 8. 验证矩阵

| 维度 | 必测场景 |
|---|---|
| Mode 生命周期 | 用户进入/退出、agent 发起进入(批准/拒绝)、mid-turn 安全点、cancel、resume、重启、takeover |
| 授权 | built-in 写型、`bash`、MCP unknown、child、symlink/绝对路径、always-approve、plan 工具集合身份 |
| 工件 | 空/大正文、并发 revision、stale revision、digest drift、255 revision 上限、单 goal 总字节上限、损坏诊断 |
| 性能 | `inspect()` 在 1/32/255 revision 下不重放、缓存失效后可见新 revision、standard 会话请求体积增量 |
| 审批 | 绑定一致性、stale 审批、外部修改失效、断连不重复实施、changes_requested 反馈通道 |
| Context | fragment 稳定性、required 优先级、revision 去重、压缩后重注入、prune 保护 |
| 交接 | keep / compact / fresh 三路径、伪造 digest、未批准 tail 不外泄、receipt 可追溯 |
| 产物 | 标题派生、导出冲突退避、失败不改状态、重试幂等、历史 revision 浏览 |
| 集成 | plan + compact、plan + 导出、plan + fork/resume、default/minimal 会话的被动 inspect |
| 门禁 | `npm run check`、`npm test`、`npm run build`、built CLI/TTY 隔离 home、无残留进程 |

每个集成断言核对完整 event sequence 或完整对象,不只断言单个字段;UI 变化使用稳定快照并验证输入路由。

## 9. 风险与回滚

| 风险 | 后果 | 缓解 |
|---|---|---|
| `inspect()` 重放成本扩散到所有 standard 会话 | 每轮工具授权延迟上升 | P1 前置投影缓存 + before/after 耗时记录 + 回归断言 |
| 计划正文事件膨胀越过上限 | 单会话事件与内存增长 | 单条 65536 字符 / 128 KiB 与单 goal 总字节上限;超限 typed 拒绝;实测数据作为数值依据 |
| standard 工具表被判为"已冻结"而误加版本 | 无谓的 profile/schema 迁移与旧库不兼容 | P0 guard 测试锁定 standard 无冻结工具 manifest;凡声称"必须迁移"先给出 digest/trigger/receipt 三处证据(D4、§4.1) |
| 动态只读边界表达错误 | 写型工具在 plan mode 泄漏 | authorization 层 deny + ExecutionEnv 只读 + 红队用例(§8 授权行) |
| mode fragment 未注入或丢失 | 模型绕过只读约定 | fragment 为 required + receipt 校验 + HTTP fixture 断言请求体 |
| 计划正文事件膨胀 | 单会话事件量增大 | 保留 65536 字符 / 255 revision 硬上限;超阈值再加显式迁移入口 |
| settle reminder 热循环 | 空转与成本上升 | 次数上限 + 同 revision 去重 + 达到上限停止 |
| handoff 泄漏未批准内容 | 实施偏离审批 | fresh session 只带 approved 正文与来源引用,mutation 断言不外泄 |
| reentry 语义漂移 | 旧计划覆盖新请求 | 单链 + reentry 指引 + reducer 不变量测试 |
| 双真源(导出文件被当作 authority) | 审计不一致 | 导出为投影;canonical 状态仍在 Session event |
| 回滚 | 实施中发现问题 | 关闭 mode 入口后保留事件与工件,projection 忽略新 command;awaiting 审批保持 pending,只能显式 cancel |

## 10. 总验收清单

- [x] Plan Mode 是 durable session state,不由 prompt 或 TUI 布尔值推断。
- [x] standard 会话可进入/退出 plan mode;plan@1 保持自动 active 与不可解除只读。
- [~] plan mode 的 deny 覆盖 always-approve、`bash`、写型 MCP、child 与未知效果。
- [x] 审批绑定 immutable revision + digest + approvalId;任一变化使审批失效。
- [x] 模型不能批准自身计划;模型不能提供任意路径或 revision。
- [~] mode 指令、工件摘要与 approved 正文经 ContextEngine 注入,压缩后重新注入并留 receipt。
- [x] 未批准计划无法触发写型实施 turn。
- [~] keep / compact / fresh 三条实施路径都有 event 证据与 approved digest 追溯。
- [x] 计划产物可导出到 canonical home,且导出不是第二真源。
- [x] 计划正文受单 goal 总字节上限约束,超限为 typed 拒绝而非静默截断。
- [x] 稳态下 `inspect()` 不重放事件;重启仍完整重放并得到同一投影。
- [x] 本次未新增 profile ref、未改 schema/trigger;standard descriptor digest 与既有 receipt audit 不变。
- [~] 重启、reconnect、takeover、response-loss 均不产生重复 mutation 或丢失状态。
- [~] `npm run check`、`npm test`、`npm run build` 完整通过。
- [x] built CLI/TTY 在隔离 `RUNLEDGER_DIR` 通过(帧与事件序列见 §5.9)。
- [x] 人工键盘/中文 IME、macOS/Windows runner 的 pending 状态如实记录。
- [~] 本文件记录各阶段 commit、命令与结果;01 与 Runtime 04 不复制本表状态。

## 11. 与其他专题的接口

| 专题 | 接口 |
|---|---|
| Runtime 04 | 消费公共类型/schema/event catalog;增量需求在 §7 声明,由契约 PR 落地 |
| Runtime 06 | mode mutation 走 owner fence、driver admission、attempt receipt、恢复路径 |
| Runtime 09/10 | 本次不新增 profile ref(D4):plan@1 语义、`minimal@1/2`、`standard@1/2` 与既有 receipt 摘要期望全部不变;仅在新增 standard 工具组后复核 composition digest 按设计变化 |
| Runtime 08 | child 边界不变;plan mode 不放开委派 |
| 权限专题 | Plan Mode 只读 ceiling 与权限预设正交;`request_permissions` 不能放宽 mode deny |
| Compact 专题 | 压缩 service 与 checkpoint 不变;plan 只提供 required fragment 与剪枝保护 |
| TUI 专题 | review surface 用现有 modal/selection/滚动组件;状态来自 domain projection |
| Storage/CLI | 导出路径在 canonical home 子树;不新增 sessionDir authority |
