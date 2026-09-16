# oh-my-pi `/loop` 与 Goal Mode 适配实施计划

> 状态:**实施中：P0.5 已实现，完整测试门禁受既有 glob 失败阻塞，未提交**。P0 与 P1–P6 尚未实施；阶段证据见 §13。
> 基线日期:2026-09-16;RunLedger 基线为当前工作树(`git status` 为准)。
> 参考基线:oh-my-pi `packages/coding-agent`(本机 `/data2-HDD-SATA-20T/Digital_avatar/haoweiyao/oh-my-pi`),行号以该工作树为准。
> 适用范围:`src/runtime/{modes,session-runtime,agent-loop,protocol,contracts,usage,tools}`、`src/security/{integration,permission}`、`src/storage/{settings-manager,session-store}`、`src/tui/**`、`src/cli/**` 与对应 tests。
> 上位计划:Runtime 04(公共类型/schema/event catalog)、Runtime 06(Session Owner、owner fence)、Runtime 09/10(profile 冻结与 mode 入口)、[`plan-compact-memory/02`](../plan-compact-memory/02-plan-mode-parity-implementation-plan.md)(mode 家族先例,D1–D9 范式)。
> 姊妹计划:[`16-omp-tool-parity-update-plan.md`](16-omp-tool-parity-update-plan.md)(新工具准入 checklist)。
> 修订记录:2026-09-16 初版;同日依据四路只读侦察(逐文件比对、会话状态、agent 循环、工具系统)修正:§1.2 增补仓库已预留的 goal 落点(含 TUI 渲染器槽位)、§1.3 增补 `withContextSources` 注入通道与「`src/` 无 `.md` 提示词」事实、§3.4 增补 G9–G12、§4 增补 D13/D14/D15 并修正 D5/D7、§5 P3 与 §6 提示词落位改为 TS 模块、§11 增补 3 项待裁定。同日二次修订:G12 根因精确化(`ToolContext.ledger` 在生产恒有值而 `todo.ts:393` 未接收该参),登记为独立任务 **P0.5** 并给出采纳处置 A(`context?.ledger ?? options.ledger`);§5/§6/§8/§9/§12 同步。

## 0. 文档定位与执行规则

### 0.1 与既有计划的关系

- **02(Plan Mode 完整度对齐)** 已确立 RunLedger mode 家族的全部范式:mode state 与 harness profile 正交(D1)、只读边界在 authorization 层表达而不动态改工具表(D2)、正文真源在 Session event(D3)、standard 会话直接扩展工具表不新增 profile ref(D4)、按对象身份判定 mode 写例外(D5)。**本文完整继承 D1–D5,不重新论证**;本文 D 编号是 02 的增量,冲突时以 02 为准。
- **16(工具面对齐)** 的 §7「新工具准入 checklist」是本文新增 `goal` 工具的准入流程;16 的 P0.1 已把 admission 从静态名字集合改为按组合实例身份判定(`src/security/integration/runtime-tool-authorization.ts:10-16,63-96`)。
- **Runtime 04** 拥有公共类型/schema/event catalog。goal 的契约增量(§7)必须先在该 work package 落地,行为 PR 不得顺带改写 catalog allowlist。
- 本文接管 loop 与 goal 的**用户可见行为交付账本**。

### 0.2 不变边界(来自根 `AGENTS.md`,本文不申请放宽)

- Harness Profile 在 Session 创建时冻结,fork 继承;`/mode` 换 profile 即新建空 Session。**不动态增删会话内工具表**(02 D2)。
- 不新增、扩展、移植或重构 OS sandbox、namespace、进程隔离。
- 产品内 child 委派保持默认关闭、root-owned sequential readonly、depth=1;loop/goal 不放开 child。
- 工具副作用继续经 Security/ExecutionGateway、Attempt Gateway 与 owner fence;fail closed,不用 raw I/O 或 AllowAll 让测试通过。
- 标准 CLI/TUI 只经 Session Owner 的 command/query/subscription;client 不持有 store、不直接调用 controller、不创建第二 writer。
- 单一 canonical `runledgerHome`;Session 与 runtime 数据只接受当前 exact format,不做格式兼容或隐式迁移。
- `resolve-config-value.ts` 只支持字面值与 `${ENV_VAR}`,**不引入 `$(cmd)` 执行**。直接约束 §4 D10 与 §5 P5。

### 0.3 执行规则

- 一次只实施一个可独立验收的 PR 边界;契约 PR(P0)与行为 PR 分离。
- 每个代码 PR 运行完整 `npm run check` 与受影响测试桶;进入 `dist/` 的代码另做 `npm run build` 与真实 `runledger` 验证。
- 用户可见功能必须有 owner-fenced durable command 与 event 证据,**不得用 client-local 状态或 TUI 布尔值伪装完成**。这直接否掉了 omp 把 loop/goal 放在 TUI 的实现形态。
- 每阶段完成后在本文补齐 commit、命令与结果。
- **独立缺陷修复不与功能 PR 混提**:P0.5 是既有缺陷(非本计划引入),单独 PR、单独验收;其 RED 必须走生产路径而非构造期参数自证(§5 P0.5)。

## 1. 当前基线

### 1.1 loop 与 goal 均无行为实现

全仓检索 `loopMode|loopPrompt|loopCondition|goalMode|GoalRuntime|goalRuntime` 只命中两处,均无关:`src/runtime/agent-loop/loop-runner.ts`(agent 内层循环)、`src/tui/sessions/types.ts`。`src/tui/commands/registry.ts` 无 `/loop`、`/goal`、`/guided-goal` 条目。`src/runtime/modes/` 下只有 `plan/`(8 文件)。仓库另有一组**已声明未实现**的通用 `goal` 契约(§1.2),它们没有行为,但决定了本计划的落位方式。

### 1.2 仓库已预留的 goal 落点(关键事实)

RunLedger 有一个**已声明但零生产者**的通用 `goal` 概念。这不是本计划引入的,实施前必须正面处理(§4 D13)。

| 预留物 | 位置 | 现状 |
|---|---|---|
| 事件类型 `goal.transitioned` | `src/runtime/protocol/events.ts:33`(`RUNTIME_EVENT_TYPES` 内) | **零生产者**;`events.ts:379` 的 `RuntimeEventSubjectKind` 含 `"goal"` |
| 事件 subject 映射 | `src/runtime/protocol/schemas.ts:370` `case "goal": return "goal"`、`:392` `case "plan": return "goal"` | plan 事件已用 `subject.kind === "goal"` |
| 被动投影 `GoalProjection` | `src/runtime/contracts/passive-state.ts:24-32`;schema `passive-state-schemas.ts:47-64` | `status: proposed\|active\|blocked\|completed\|failed\|cancelled`;含 `revision`/`completionRef`/`verificationRef`/`ProjectionMetadata`;**零生产者** |
| 投影保存策略 | `src/runtime/contracts/inventory.ts:61` `passivePolicy("GoalProjection", "reconstructible_passive", "rebuildable_from_source_head", "content_ref_only")`;inventory 条目 `:220-240`(`gaps: []`) | 声明为可重建被动 DTO |
| `SessionProjection.rootGoalId` | `passive-state.ts:22` | 每个 session 有一个 root goal 槽位 |
| TUI 查询工作流 | `src/tui/task-goal/types.ts`(`GoalView`、`TaskGoalSnapshot`、`TaskGoalQueryPort`) | `GoalView.lifecycle = active\|paused\|blocked\|completed\|failed\|unknown` |
| TUI effect/reducer 槽位 | `src/tui/application/effect.ts:27`(`task-goal.inspect`)、`effect-runner.ts:161`、`reducer.ts:251`、`ports.ts:42`(`taskGoal?:`) | 端口**从未被赋值**:`initial-state.ts:35` 只设 `unavailable`,`ports.ts:80` 据此算 available |
| TUI timeline | `src/tui/timeline/types.ts:62-63`(`kind:"goal"` + `goalId`)、`:129`(`goal_lifecycle` 事件)、`reducer.ts:114-135` | 渲染行 `id: goal:<correlationId>` |
| TUI 工具渲染 | `src/tui/presentation/tools/types.ts:22`(tool kind 含 `"goal"`)、`:116`(`{kind:"goal", goalId, phase, revision, evidenceCount}`) | 渲染器槽位已预留,无消费者 |
| ID kind | `src/runtime/protocol/ids.ts:53` `GoalId` | plan mode 已在消费(`plan-composition.ts:47`、`runtime-host-model-context.ts:429`) |

**命名冲突**:RunLedger 现有的 `goal` = 任务/目标树的通用记录(与 `task`/`agent_graph` 并列的 projection 家族成员);omp 的 goal mode = 会话级自主目标 + token 预算 + 自动续跑。两者共用 `GoalId` 但语义不同。§4 D13 给出处理方案。

### 1.3 可复用基础设施

| 能力 | 实现位置 | 与本计划的关系 |
|---|---|---|
| mode 状态范式 | `src/runtime/modes/plan/{types,schema,reducer,errors,prompt}.ts`;`reducePlanModeState` `reducer.ts:252`、`isValidPlanModeState` `:129`、`PlanModeCommand` 联合 `:86`、`snapshotPlanModeState`/`restorePlanModeState` `:162/:168` | goal 的直接模板 |
| mode authority | `src/runtime/session-runtime/plan-domain.ts`:`SCHEMA` `:20`、`OPERATIONS` `:26-29`、`MANIFEST` `:30-33`、`PlanEventPayload` `:36-58`、`operationManifest` `:124`、`commit` `:216`(`beginAttempt` `:232`、`appendEvent` `:281-284`、`settleAttempt` `:316-320`)、`prepare` `:325`、`load` 重放 `:451`、`notePlanTurn` 收敛提示 `:143-158` | goal 的直接模板 |
| mode 被动投影 | `src/runtime/session-runtime/plan-composition.ts`(`createSessionPlanInspection` `:27`) | goal 需要同名文件 |
| mode 工具与写门 | `src/runtime/session-runtime/plan-tools.ts`(`PlanArtifactWriteGate` `:16-21`、`capabilityClaims` `:10-15`、`isReadOnly`) | goal 工具模板 |
| 组合点 | `src/runtime/session-runtime/domain.ts`:`planDomain` `:211`、`planTools` `:221`、`baseTools` `:230`、`governedTools` `:257`、`resolveHarnessComposition` `:266`、`planState` 注入 `:335-336`、`controller.addTools` `:453`、`compositionReceipt` `:460`、`planInspection` `:470`、`productionSessionTools` `:615` | goal 需要同款接线 |
| 工具准入 | `src/security/integration/runtime-tool-authorization.ts:63-96`(admission 按实例身份 + plan mode ceiling) | goal 需要状态 gate |
| 工具 claim 表 | `src/runtime/tools/capabilities.ts:17-31`(`READ_TOOLS`/`WRITE_TOOLS`/`PROCESS_TOOLS` → `builtinCapabilityClaims`,缺省即 unknown effect → active Plan Mode 一律 deny) | goal 工具需显式 claim |
| access 分类 | `src/security/permission/access-resolver.ts:27-63`(按工具名映射,未命中落 `{kind:"tool"}` `:63`) | goal 会落通用分支 |
| 命令路由 | `src/runtime/session-runtime/command-routes.ts:16-42`(分组表)、`command-routes/{conversation,model,account,domain,recovery}.ts` | goal/loop 走 `domain_query`/`domain_command` |
| 协议能力与清单 | `src/runtime/session-server/protocol.ts:16-37`(`SESSION_PROTOCOL_CAPABILITIES`)、`domain-router.ts:110-125`(汇总,`plan.inspect` `:121` 条件加入)、`session-runtime.ts:382-394` | 新增 `session.goal`/`session.loop` |
| 公共合同 | `src/runtime/contracts/public.ts:29-30`(plan 导出)、`inventory.ts:348-366`(plan-mode 条目) | goal-mode 需登记条目 |
| **owner 侧定时器范式** | `src/runtime/session-runtime/idle-recap.ts`(`IdleRecapCoordinator` `:53`、`arm` `:82`、`notifyActivity` `:104`、`fire` `:127`、`isIdleRecapEligible` `:164`);controller `idle-recap-controller.ts`(`handleDomainAgentEvent` `:55`、`currentIdleRecapActivity` `:76`、`invalidateIdleRecap` `:95`、`handleEditorActivity` `:138`、`fireIdleRecap` `:152`) | **续跑调度的直接模板** |
| idle recap 接线点 | `session-runtime.ts:172,206,225,242,257-258,284,451` | goal/loop controller 照此接线 |
| agent 内层续跑 port | `src/runtime/agent-loop/loop-runner.ts:564-571`(`getSteeringMessages` 优先、`getFollowUpMessages` 次之,任一非空则 `continue`);run budget 硬边界 `:175,519,535,543` | **goal continuation 的注入通道** |
| token 用量 | `src/runtime/usage/index.ts`:`UsageQuantity` `:5-8`、`UsageSnapshot.cumulative` `:26-40`、`usageSnapshot` `:127`、`quantityValue` `:238`(unknown → `undefined`)、`seedUsageAccumulator` `:228` | 预算记账必须使用 |
| settings | `src/storage/settings-manager.ts`:`ProjectSettings` `:42-74`、`RecapSettings` `:76-90`、`DEFAULT_RECAP_SETTINGS` `:86`、`RECAP_MIN/MAX_IDLE_SECONDS` `:91-92`、`resolveRecapSettings` `:250`、`sanitizeProjectSettings` `:388` | goal/loop settings 模板 |
| 「日志追加 + 恢复重建」先例 | `src/storage/session-codec.ts:29`(`projectSessionReplay`)、`:64`(`appendRuntimeConfig`);消费 `interactive-session-controller.ts:321,726` | mode 元数据持久化先例 |
| mode 片段注入点 | `src/runtime/session-runtime/domain.ts:289-320`(`withContextSources`),构造 `RuntimeContextSource`(`context/runtime-adapter.ts:8`)并叠加进 `ModelContextAssemblyInput.sources`(`types.ts:366-379`,`layer: "mode"`、`priority: "required"`);被 `:355,357,358,363` 四个组装入口复用 | **goal fragment 的正确注入通道**;对照 `modes/plan/prompt.ts` 的 `buildPlanFragment` |
| 提示词形态 | `src/runtime/harness-profiles/standard-prompt.ts`(`STANDARD_EXECUTION_SYSTEM_PROMPT` 常量)、`src/runtime/modes/plan/prompt.ts`(纯函数返回 fragment);`src/` 下**无 `.md` 提示词文件** | goal 提示词必须落成 TS 模块,不是模板文件 |
| session 事件存储约束 | `src/storage/session-store/schema.ts:13`(`SESSION_STORE_SCHEMA_VERSION = 7`)、`:66/:179` `event_type TEXT NOT NULL`(**无 CHECK 白名单**) | 新增事件类型**不需要** schema 迁移 |
| owner 事件目录 | `src/runtime/session-owner/types.ts:148-161`(`SESSION_OWNER_EVENT_TYPES`) | 只含 owner/driver/recovery,**不含** goal/loop,无需改动 |
| 消息类型 | `src/runtime/types.ts:162-165`(`UserAgentMessage = {role:"user", content: TextContent[]}`,**无 synthetic/hidden/display/origin 字段**) | §4 D7 |
| `AgentEvent` 联合 | `src/runtime/types.ts:242-341`,11 成员;`AgentEventSink` `:342` | 记账与续跑事件源 |
| TUI 命令注册表 | `src/tui/commands/registry.ts`:`SlashCommandActionType` `:32-67`、`RegisteredSlashCommand` `:62`、`builtinCommandDescriptors` `:140`(`/mode` `:210`、`/plan` `:274`)、`commandsForContext` `:354` | `/goal`、`/loop` 注册点 |
| TUI 派发 | `src/tui/interactive-mode.ts:1163`(`dispatchCommand`,按 `actionType` switch,`plan.inspect` `:1242`);`src/tui/interactive/input-controller.ts:30`(`handleSubmit`)、`:48/:317/:322`(`port.dispatchCommand`) | 无 subcommands/动态描述/prompt 回传(§4 D14) |
| TUI 编辑器/自动提交 | `interactive-mode.ts:1031`(`echoPrompt`,**唯一合法自动提交入口**)、`interactive/types.ts:132`、`input-controller.ts:81` | client 侧迭代提交须经此 |
| TUI footer | `src/tui/footer/field-registry.ts`:`FooterSnapshot` `:10-33`、`FooterFieldDefinition` `:36-45`、`FooterFieldRegistry` `:79`、`register` `:86`、`createDefaultFooterFieldRegistry` `:168`、`fitProjectedFooterRows` `:175`;`interactive-mode.ts:972`(`registerFooterField`,**唯一入口**)、`:1420`(`getFooterSnapshot`) | goal badge 接入点 |
| TUI 忙碌判定 | `interactive-mode.ts:1292`(`inFlight`)、`cli/session-interactive-controller.ts:182`、`runtime/interactive-session-controller.ts:347`(`session_busy` 条件含 `promptPending`/`selectionChangePending`/队列非空) | 自动提交 gate |
| TUI 工作流范式 | `src/tui/interactive/plan-workflow.ts`(`openPlanWorkflow` `:47`、`runDomainCommand`)、`src/tui/adapters/session-resources.ts:153`(条件注入 `plan` port) | goal/loop workflow 模板 |
| 任务桶 | `package.json:92-97`(`test:runtime`/`test:security-storage`/`test:integration`/`test:tui-native`) | §9 验证矩阵 |

### 1.4 与 omp 的两处结构性不兼容

1. **续跑由 TUI 定时器拥有**(`setTimeout(…, 800)`,`modes/interactive-mode.ts:1731-1741`)。RunLedger 的 client 只经 owner command/query/subscription,没有「client 自行发起下一轮」的合法路径(§0.2),headless 也必须成立。
2. **隐藏注入靠 `display:false` 的自定义消息**(`session/agent-session.ts:1716-1730`)。RunLedger 的 `UserAgentMessage` 无该字段(`src/runtime/types.ts:162-165`)。

## 2. 参考基线:oh-my-pi 的实现

### 2.1 `/loop`:TUI 层的提示词节拍器

- 状态全在 `InteractiveMode` 实例(`modes/interactive-mode.ts:627-639`),**不持久化**。
- 参数解析 `modes/loop-limit.ts`:`parseLoopArgs` 依次剥离 limit(`10`/`10m`/`1h30m`/`10 minutes`)、condition(`--while`/`--until`,值经 `readShellWord`)、余下为 inline prompt;形状像 limit/flag 但解析失败即硬报错。
- 预算运行时区分只读判定与消费:`isLoopLimitExhausted` 查死、`consumeLoopLimitIteration` 扣减。
- 迭代节拍:`getUserInput()` `:1714` → `#scheduleLoopAutoSubmit` `:1721-1745`(800ms 留给 Esc) → `#runLoopIteration` `:1827-1886`。检查顺序:禁用/换 prompt → `#isAutoSubmitBlocked` → reset+vibe → `isLoopLimitExhausted` → 条件求值 → **再查** blocked/vibe → consume → 按 `loop.mode` 执行 compact/reset → 提交。
- 条件求值 `modes/loop-condition.ts`:**退出码权威、stdout 忽略**;`0`/`1` 按 `--while`/`--until` 极性映射;`>1`(127/126/2)判为条件自身损坏并停止;超时判 error、Esc 判 aborted;独立 shell session key `loop-condition:<sessionId>` 隔离。
- 入口:Esc 在 streaming 时中断本轮、idle 时 `pauseLoop`(丢 prompt 保留 enabled);`setLoopPrompt` 任何手动提交都覆写并立即 abort 在飞条件(`modes/controllers/input-controller.ts:403-412,922,971,997`)。

### 2.2 goal:TUI 状态 + 隐藏工具 + 预算记账

- 模型 `goals/state.ts`:`GoalStatus = active|paused|budget-limited|complete|dropped`、`Goal{id,objective,status,tokenBudget,tokensUsed,timeUsedSeconds,…}`、`GoalModeState{enabled,mode:"active"|"exiting",goal}`。
- 状态机与记账 `goals/runtime.ts`(`GoalRuntime` + `GoalRuntimeHost` 注入):`goalTokenDelta` = `input + cacheWrite + output` 增量,**排除 cacheRead**(注释给出理由:cacheRead 是复用前缀,cacheWrite 在 Anthropic/Bedrock 实际计费);wall-clock 累积;`#accountingTail` 串行化并发 flush;越预算翻 `budget-limited` 且每 goal 只 steer 一次(`#budgetReportedFor`);`steering: "allowed"|"suppressed"` 区分自然工具 flush 与收尾 flush;纯 wall-clock flush 不落盘。
- 模型面工具 `goals/tools/goal-tool.ts`:`op: create|get|complete|resume|drop`,strict schema,`intent:"omit"`;**动态进出工具集**(`modes/interactive-mode.ts:3563-3625`)。
- 注册:`sdk.ts:2889-2895` eager + `ensureGoalRegistered()` `:2976-2990` lazy(注释引用 issue #9444);`HIDDEN_TOOL_NAMES = ["yield","goal","think"]`(`tools/builtin-names.ts:34`)。
- 提示词:`prompts/goals/{goal-mode-active,goal-continuation,goal-budget-limit,goal-mode-context,goal-todo-context}.md`、`prompts/tools/goal.md`;注入点 `session/agent-session.ts:5932-5995`(`#buildGoalModeMessage`)、`:6446`(每请求注入)、`:5772`(`sendGoalModeContext` → `deliverAs:"steer"`)。
- 记账钩子:`:3054`(`turn_start` 记基线)、`:3112-3115`(`tool_execution_end` flush,`goal` 工具自身走 suppressed)、`:3295`(`agent_end` 收尾)。
- 续跑调度 `modes/interactive-mode.ts:1747-1788`:一串 guard(loop 开启即跳过、`goal.continuationModes` 必须含 interactive、非 plan/vibe、非 paused、无 pending、编辑器为空、无待发图片、状态必须 enabled+active),800ms 后**再复检**;`#goalSuppressNextContinuation`(一次续跑轮无工具调用则抑制下一次)、`#goalContinuationTurnInFlight`。
- 持久化:`persist` → `appendModeChange("goal"|"goal_paused"|"none", {goal})`;恢复 `#reconcileModeFromSession` `:3264-3340` 读 `buildSessionContext().mode/modeData`,区分同 session 切换(`preserveActiveGoal`)与冷恢复(转 paused,要求显式 resume)。
- 设置:`config/settings-schema.ts:4952/4963/4974`、`:2055/2080`。
- 状态行:`modes/components/status-line/segments.ts:295-324,369-371`、`component.ts:723-727`。

### 2.3 omp 侧问题(不在 RunLedger 复制)

- `goals/state.ts:32` 的 `GoalRuntimeEvent.goal_continuation_requested` 是**死类型**:全仓无生产者,续跑实际由 TUI 定时器驱动。RunLedger 必须真实产生该事件(§7)。
- 动态工具集的懒注册路径(`sdk.ts:2968-2990`)是为修补 issue #9444 打的补丁;RunLedger 不走动态工具集,该缺陷类不存在(§4 D4)。

## 3. 逐文件比对

### 3.1 处置语义

**移植**=纯逻辑可直接搬并改 import;**重写**=语义保留、实现按 RunLedger 范式重做;**换宿主**=同一行为在不同层实现;**收窄**=保留语义但去掉与边界冲突的部分;**不移植**=与边界冲突或收益不足。

### 3.2 核心交付表

| omp 文件/符号 | RunLedger 对应物 | 处置 | 依据 |
|---|---|---|---|
| `modes/loop-limit.ts` 全部 | 无 | **移植** → `src/runtime/loop/limit.ts` | 纯函数。`readShellWord` 需确认等价物或内联最小解析器(P4 前置) |
| `modes/loop-condition.ts` 判定语义 | 无 | **重写** → `src/runtime/loop/condition.ts`(P5,待裁定) | 三段语义保留;执行换 governed managed process(§0.2) |
| `modes/interactive-mode.ts:1814-1886` 迭代节拍 | `loop-runner.ts:564-571`(follow-up port)+ owner controller | **换宿主** | D1/D2 |
| `modes/interactive-mode.ts:1747-1788` goal 续跑 | `idle-recap-controller.ts`(范式) | **换宿主** | 新增 `SessionGoalContinuationController` |
| `modes/interactive-mode.ts:3066-3110` goal 会话事件 | `AgentEvent`(types.ts:242-341) | **换宿主** | owner 订阅 domain agent event |
| `modes/interactive-mode.ts:3264-3340` reconcile | `SessionGoalDomain.load()` 重放 | **重写** | D5 |
| `modes/interactive-mode.ts:3563-3625` enter/exit | 无 | **重写 + 收窄** | **不移植**动态工具集(D4) |
| `modes/interactive-mode.ts:627-639` loop 字段 | 无 | **重写** | 状态进 owner |
| `goals/state.ts` | → `src/runtime/modes/goal/{types,schema}.ts` | **重写** | 状态集保留;`enabled` 并入 reducer |
| `goals/runtime.ts` 记账 | `src/runtime/usage/index.ts`(`UsageQuantity`) | **重写** | D6 |
| `goals/runtime.ts:goalTokenDelta` | 无 | **移植语义** | `input + cacheWrite + output`,排除 cacheRead;理由一并搬运 |
| `goals/runtime.ts` wall-clock | `AgentEvent.agent_work_pause/resume`(`types.ts:255-262`) | **改进** | D6:改活跃时长 |
| `goals/tools/goal-tool.ts` | `plan-tools.ts`(模板) | **重写** → `goal-tools.ts` | 加 claim;`expectedRevision` 走乐观并发 |
| `prompts/tools/goal.md` | `plan-tools.ts` 的 `description` 内联字符串(`:52,60,70`) | **移植 + 落成 TS** | RunLedger 工具描述是 TS 字面量,无 `.md` |
| `prompts/goals/goal-mode-active.md` | `modes/plan/prompt.ts:buildPlanFragment`(范式) | **移植 + 落成 TS** | 新增 `buildGoalFragment`;预算段改为「已观测下界 + 计量完整度」 |
| `prompts/goals/goal-continuation.md` | 同上 | **移植 + 落成 TS** | 6 步完成前审计清单是本功能的质量门 |
| `prompts/goals/goal-budget-limit.md` | 同上 | **移植 + 落成 TS** | — |
| `prompts/goals/goal-mode-context.md` + `goal-todo-context.md` | `domain.ts:289-320` `withContextSources` + `RuntimeContextSource` | **换宿主** | 走 `layer:"mode"`/`priority:"required"` 的 context source,不是 TUI 拼字符串 |
| `slash-commands/builtin-modes.ts:251-289` | `tui/commands/registry.ts` + command-routes | **重写 + 扩展** | D14 |
| `slash-commands/builtin-modes.ts:290-313` | 同上 | **重写 + 扩展** | D14 |
| `config/settings-schema.ts` 5 key | `settings-manager.ts:42-90` | **重写** | D8 |
| `session/agent-session.ts:1698-1732` host 接线 | `domain.ts:211-336` | **换宿主** | GoalRuntimeHost → `SessionGoalDomain` |
| `session/agent-session.ts:3054/3112-3115/3295` | `AgentEvent` 订阅 | **换宿主** | owner 驱动记账 |
| `session/agent-session.ts:5772` `sendGoalModeContext({deliverAs:"steer"})` | `withContextSources` 的 mode fragment(`domain.ts:289-320`) | **换宿主** | 恒定注入优先于一次性 steer:不需要在 streaming 中抢投 |
| `session/agent-session.ts:5932-5995/6446` `#buildGoalModeMessage` + 每请求注入 | 同上 | **换宿主** | `buildGoalFragment` 由 `withContextSources` 无条件叠加 |
| `sdk.ts:2889-2990` eager+lazy | `tool-projection.ts:19-21`(standard 直通) | **简化** | D4:goal 常驻,不需 lazy |
| `tools/builtin-names.ts:34` `HIDDEN_TOOL_NAMES` | 无 | **不移植** | RunLedger 无隐藏工具概念;`goal` 是正常可见工具 |
| `modes/components/status-line/*` | `tui/footer/field-registry.ts` | **换宿主** | 经 `registerFooterField`(`interactive-mode.ts:972`) |
| `modes/controllers/input-controller.ts:403-412` Esc | `tui/interactive-mode.ts` 输入路径 | **重写** | Esc 只发 owner 命令,client 不改状态 |
| `main.ts:311/371` | 无 | **不移植** | omp CLI 的 loop prompt 透传,无对应需求 |

### 3.3 仓库预留物的处置

| 预留物 | 处置 | 说明 |
|---|---|---|
| `goal.transitioned`(`events.ts:33`) | **采用** | 语义完全匹配 goal 状态转移;注册在 catalog 内即自动获得 payload schema(`schemas.ts:158,211`) |
| `RuntimeEventSubjectKind."goal"`(`events.ts:379`)、`schemas.ts:370` | **采用** | 直接复用,无需改动 |
| `GoalProjection`(`passive-state.ts:24-32`)、`GoalProjectionSchema` | **扩展(需 Runtime 04 裁定)** | 作为 goal mode 的被动投影;缺 `paused`/`budget-limited`/`dropped` 与预算字段 → 见 D13 |
| `inventory.ts:61` `passivePolicy("GoalProjection",…)` | **更新** | DTO 扩展后重算,或新增独立策略项 |
| `SessionProjection.rootGoalId` | **采用** | goal mode 的 goal 即该 session 的 root goal |
| TUI `task-goal`(`GoalView`/`TaskGoalSnapshot`/`TaskGoalQueryPort`) | **采用 + 接线** | `goal.inspect` port 的生产实现;`GoalView.lifecycle` 需与 `GoalProjection.status` 对齐 |
| TUI effect `task-goal.inspect`(`effect.ts:27`/`effect-runner.ts:161`/`reducer.ts:251`/`ports.ts:42`) | **启用** | 目前 `ports.taskGoal` 恒为 `undefined`(`initial-state.ts:35`) |
| TUI timeline `goal_lifecycle`(`timeline/types.ts:129`/`reducer.ts:114-135`) | **采用** | goal 转移的 TUI 呈现通道 |
| `ids.ts:53` `GoalId` | **采用** | 与 plan 共用一个 kind 但不同实例;需在文档中明确区分 |

### 3.4 能力缺口

| 缺口 | 现状 | 影响 |
|---|---|---|
| G1 goal canonical mode 状态 | 只有 plan 一个实例 | 需 `modes/goal/*` + domain + inspection |
| G2 隐藏/合成消息 | `UserAgentMessage` 无标记(`types.ts:162-165`) | continuation 无法既进 history 又不被当作真实输入 → D7 |
| G3 可量化但可能不可知的用量 | `UsageQuantity` 含 `unknown`(`usage/index.ts:5-8`),`quantityValue` 返回 `undefined` | 预算须给出「不可知」分支,否则把未知当 0(D6) |
| G4 owner 侧续跑调度 | 只有 idle recap 一个实例 | 需新 controller,并与 `runBudget` 硬边界协调(D9) |
| G5 loop 迭代间动作 | compaction domain 存在;session 重建只在 client | `compact` 可 runtime 化,`reset` 只能 client 化(D2) |
| G6 loop condition 的受治理 shell | managed process 存在,但 loop 谓词是新执行来源 | D10 待裁定 |
| G7 goal 工具 access 分类 | 未命中落 `{kind:"tool"}`(`access-resolver.ts:63`) | 需显式分类 |
| G8 TUI 命令描述符能力 | 无 subcommands、无动态描述、无「返回 prompt 继续提交」(`registry.ts:62`、`interactive-mode.ts:1163`) | `/loop <inline prompt>` 与 `/goal set` 需要扩展(D14) |
| G9 无 `abort(reason)` | `Agent.interrupt(): void`(`agent.ts:212`)、`controller.interrupt(): void`(`interactive-session-controller.ts:605`),无参;终止只体现为 `stopReason:"aborted"` | 「用户 Esc」与「内部压缩中断」不可区分(D5 简化) |
| G10 无 `isCompacting`/`hasPostPromptWork` | 忙碌判定是 `inFlight`/`promptPending`/`selectionChangePending`(`interactive-session-controller.ts:347`) | 自动提交 gate 照此写 |
| G11 编辑器无图片/附件 API | 只有 `getText()`/`getCursor()` | omp 的「有待发图片则不自动提交」guard 无对应物,直接省略 |
| G12 生产路径 todo 状态不持久化 | `todo.ts:393` 的 `execute(_toolCallId, params)` **第五参 `context` 被省略**,`:394` 的 `ledger` 只取自构造期闭包 `options.ledger`;而 `createTodoTool` 的该选项只在 `createStdlibTools(cwd, {ledger})` 传入时非空(`tools/index.ts:93`),三个组合点(`domain.ts:624`、`interactive-session-controller.ts:819`、`runtime-host-session.ts:210`)**都不传**。与此同时 `ToolContext.ledger` 在生产**恒有值**:`domain.ts:328` 把 `SqliteLedgerSink`(`:130`)交给 controller → `:668` `new Agent({ledger})` → `agent.ts:320` 挂入 `AgentLoopConfig.ledger` → `tool-call-execution.ts:80` 注入 `makeToolContext`。现有测试全部显式 `createTodoTool({ledger})`(`tests/tools-m4.test.ts:191,216,232,…`),**因此永不覆盖生产路径**。独立缺陷,**独立任务 P0.5**(不阻塞 P1/P2,P3 依赖其结论) |

## 4. 架构决策

### D1 — loop 与 goal 的宿主分层:canonical 归 owner,呈现归 client

omp 把两者都放在 TUI,因此 headless、多客户端、重连后均不成立,状态无法审计。RunLedger 拆三层:canonical 状态(goal 进 reducer + domain;loop 不进 canonical,见 D3)、驱动(owner 侧 controller)、呈现(`src/tui/**`)。依据:`command-routes.ts:16-42` 的 client 契约只有 command/query/subscription;`AGENTS.md` §2。

### D2 — loop 的三种迭代间动作归属不同层

| omp `loop.mode` | omp 行为 | RunLedger 处置 |
|---|---|---|
| `prompt` | 重提交 prompt | **runtime 可做**:owner 在 `agent_end` 后经 follow-up 注入(`loop-runner.ts:568`) |
| `compact` | 调 `handleCompactCommand` | **runtime 可做**:走既有 compaction domain 独占路径 |
| `reset` | `handleClearCommand` 起新 session | **只能 client 做**:runtime 只发「需要新 session」信号;client 经 `echoPrompt`(`interactive-mode.ts:1031`)与 session 工作流执行 |

不给 runtime 新增「自主新建 session」能力:那等于让 owner 越过 driver admission(`session.driver.claim`/`release`)改变会话身份。

### D3 — loop 状态是 ephemeral + 审计事件,不是 canonical reducer

loop 是用户发起的批处理节奏,不是可重放的状态转移;canonical 化会引入「重启后继续自主执行」的语义,本仓库不应默认获得。因此 `persistence: "ephemeral"` 并在 `inventory.ts` 显式登记;每次迭代写审计事件(§7)。SQLite 层无需迁移(`schema.ts:66,179` 的 `event_type` 无 CHECK),但事件类型需按 D15 进入 `RUNTIME_EVENT_TYPES` 或明确排除。

### D4 — goal 不新增 harness profile,工具随 standard 常驻

与 02 D4 同构:`tool-projection.ts:19-21` 明确 standard 直通、不 pin manifest。goal 工具加入 standard governed composition 不改 profile ref、不改 `standard@2` 描述符 digest、不做 schema 迁移。

**与 omp 的关键差异**:omp 动态把 `goal` 加进 active tool set、退出时还原(`interactive-mode.ts:3563-3625`)。RunLedger 不做动态工具表,因此 `goal` 在 standard 会话**始终可见**,模型可随时 `op:create`;非法状态调用由 **reducer 拒绝**(typed error),不是「工具不存在」。`minimal`/`plan` 的 allowlist 不含 `goal`,这些会话没有该能力。

代价:standard 每请求多 1 个工具 schema;`harness-profile-standard.test.ts` 工具名有序 golden 与 canonical digest 会变(§8)。

### D5 — goal 状态机沿用 plan 的 reducer 纪律,恢复语义简化

照 `modes/plan/reducer.ts` 形态:命令联合带 `expectedRevision` + `updatedAt`,跨字段不变量在 `isValidGoalModeState` 校验,projection 用 reproject-style 重算 digest。

**不移植** omp 的「冷恢复一律转 paused、要求显式 resume」(`interactive-mode.ts:3264-3330`)。该规则存在是因为 omp 的 mode 靠 `appendModeChange` 稀疏记录恢复,无法区分「用户暂停」与「进程退出」;RunLedger 从 canonical event 重放,`paused` 与 `active` 都由显式命令产生,重放即权威。

**不移植** omp 的 `mode:"exiting"` 自动退出链路(D12):RunLedger 无动态工具集可还原,改为 reducer 的完成转移 + `goal.transitioned` 事件 + footer/通知投影。

**受影响的一条**:G9 说明 RunLedger 的 `interrupt(): void` 无原因参数,无法区分「用户 Esc」与「内部压缩中断」。因此 omp 的「Esc → goal 转 paused,内部中断 → 保持 active」无法照搬。改为:goal **不因任何 interrupt 自动转 paused**;仅在 run budget 终止(`runBudget` 命中 `loop-runner.ts:175/519/535/543`)或用户显式 `pause` 时转 paused(D9)。

### D6 — 预算记账使用 `UsageQuantity`,并显式建模计量完整度

omp 的 `tokensUsed: number` 单调累加;RunLedger 的用量是 `UsageQuantity`(`usage/index.ts:5-8`),可能是 `unknown`/`unavailable`,且 `quantityValue` 对它们返回 `undefined`(`:238`)。因此:

- 状态携带 `accountingCompleteness: "complete" | "partial"` 与 `unaccountedTurns: number`。
- `tokensUsed` 语义是**已观测下界**;`unknown` 的 turn 不累加但把完整度降为 `partial`。
- 预算耗尽判定只允许从确证下界推进:`tokensUsed >= tokenBudget` 且完整度 `complete` → `budget-limited`。`partial` 时**不得**据此判定完成或停止,只注入预算提示。
- 时间预算改用 `agent_work_pause`/`agent_work_resume`(`types.ts:255-262`)累计**活跃时长**,而非 omp 的 wall clock(wall clock 会把审批等待与用户离开计入预算)。
- `goalTokenDelta` 口径(input + cacheWrite + output,排除 cacheRead)连同理由一并保留。

### D7 — 分两条通道:mode 指令走 context source,续跑触发走 `origin` 标记

两种内容性质不同,不能混用一条通道:

| 内容 | 通道 | 依据 |
|---|---|---|
| goal 状态/预算/质量规则(`<goal_context>`) | `ModelContextAssemblyInput.sources` 的 mode fragment | `domain.ts:289-320` 的 `withContextSources` 已为 plan mode 这样做(`layer:"mode"`、`trust:"trusted"`、`priority:"required"`);进 system prompt,不进 transcript,天然可审计(`ContextAssemblyReceipt`) |
| continuation 触发消息 | `UserAgentMessage` + `origin` 标记 | 它必须**开始一个新 turn**,只有 `steer`/`followUp` 队列能做到(`loop-runner.ts:564-571`) |

因此 D7 只需解决**触发消息**的标记问题:continuation 必须进 history(模型须看到自己在被续跑;恢复后上下文一致;审计要求注入内容可重放),但不得被当作真实用户输入。

方案:`UserAgentMessage`(`types.ts:162-165`)增加必填 `origin: "user" | "runtime"`;`runtime` 消息在 TUI transcript 折叠、不计入用户输入历史。影响面见 §6;这是本计划唯一的**公共契约破坏性变更**,单独作为 P0 交付。

替代(不推荐):不落 history,只作 loop-runner 临时注入。缺点:重放后模型上下文与首次不一致,违反事件溯源原则。

注:omp 的 `#buildGoalModeMessage`(`agent-session.ts:5932-5995`)把 mode 指令与 todo 快照拼成一条消息再 steer;RunLedger 拆开——指令走 context source,只有触发走消息。这也顺带避免了 omp 在非 streaming 场景下依赖 `deliverAs` 时序的那部分复杂度。

### D8 — settings 按 `RecapSettings` 模式

omp 的 `goal.continuationModes` 是 array(`settings-schema.ts:4974`),限定哪些 run mode 允许自动续跑。RunLedger 无该 run mode 概念;改为单一布尔 `goal.autoContinuation`,并在 user/workspace 层分别清洗(workspace 只能进一步收窄,对照 `skills`/`multiAgent` 的层级语义)。

新增 setting(照 `RecapSettings` 形态:`interface` + `sanitize` + `resolve` + `DEFAULT_*` + `MIN/MAX` 常量,`settings-manager.ts:76-92,250,388`):

| key | 类型 | 默认 | 说明 |
|---|---|---|---|
| `goal.enabled` | boolean | `true` | 总闸;关闭时 `goal` 工具不进入 composition |
| `goal.autoContinuation` | boolean | `true` | 允许 owner 在 idle 后自动续跑 |
| `goal.continuationDelaySeconds` | number | `30` | 续跑前 idle 窗口,边界风格照 `RECAP_MIN/MAX_IDLE_SECONDS` |
| `goal.maxContinuations` | number | `20` | 跨 run 续跑次数上限(D9) |
| `loop.enabled` | boolean | `true` | 总闸 |
| `loop.maxIterations` | number | `50` | 无显式 limit 时的硬上限(omp 无此上限,属 RunLedger 加固) |
| `loop.conditionEnabled` | boolean | `false` | 待 D10 裁定 |

注:仓库无 JSON schema 文件、无 TUI 设置面板;`number`/`enum`/`array` 均有先例(`recap.idleSeconds`、`enabledModels`),写入靠逐功能注入端口。

### D9 — 续跑必须与既有 run budget 协调,不得绕过

`loop-runner.ts` 已有四条硬边界:模型轮数 `:175`、工具轮数 `:519`、审批过期 `:535`、重复失败指纹 `:543`。goal 的自动续跑是在这些边界**之外的跨 run 循环**,因此:

- 续跑次数由 `SessionGoalContinuationController` 单独计量,上限 `goal.maxContinuations`。
- 保留 omp 的空转抑制:一次续跑轮若**没有任何工具调用**则抑制下一次。
- 任一 run budget 终止(`terminationReason` 非空)后不再续跑,并把 goal 置 `paused` 并记录原因。

### D10 — loop condition 的 shell 谓词需用户裁定(§11)

`--while`/`--until` 每次迭代前要跑一条用户提供的 shell 命令。omp 用 `executeBash` 直跑(`loop-condition.ts`,独立 session key + 超时)。RunLedger 约束是硬的:

- `AGENTS.md` §2:工具副作用继续经 Security/ExecutionGateway、Attempt Gateway 与 owner fence;不用 raw I/O 绕过治理。
- 同文件:`resolve-config-value.ts` 仅支持字面值与 `${ENV_VAR}`,**不引入 `$(cmd)` 执行** —— 说明本仓库对「配置里的命令执行」有过明确否决。

因此这不是「移植」而是**新增一类受治理执行来源**:需 capability claim(`process`)、managed process 分配、超时、以及是否走用户审批的裁定。裁定前 P5 不启动,`loop.conditionEnabled` 默认 `false`。

### D11 — `/guided-goal` 不在本期范围

omp 的 `/guided-goal`(`builtin-modes.ts:278-289`)只是一段交互式访谈提示词(`prompts/goals/guided-goal-interview.md`),无新机制。列为可选(P6),避免初版范围膨胀。

### D12 — 不移植 omp 的 `mode:"exiting"` 自动退出链路

见 D5。omp 的 `complete` 置 `mode:"exiting"`,再由 `getUserInput`/`agent_end` 触发 `#exitGoalMode`(`interactive-mode.ts:1706-1708,3106-3110`)还原工具集、写 custom entry。RunLedger 无需 client 参与退出。

### D13 — goal 概念的归属:复用仓库预留槽位,不新造第二套(需 Runtime 04 裁定)

§1.2 显示仓库已有一个**零生产者**的 `goal` 概念(`goal.transitioned` + `GoalProjection` + `GoalView` + timeline `goal_lifecycle`)。本计划的 goal mode 与它语义高度重叠但状态集不同:

| 维度 | 预留的 `GoalProjection` | omp goal mode 需要 |
|---|---|---|
| status | `proposed\|active\|blocked\|completed\|failed\|cancelled` | `active\|paused\|budget-limited\|complete\|dropped` |
| 预算 | 无 | `tokenBudget`/`tokensUsed`/`timeUsedSeconds`/`accountingCompleteness` |
| 目标正文 | 无(只有 `completionRef`/`verificationRef`) | `objective` 文本 |
| 生命周期 | 任务树/agent_graph 家族 | 会话级自主目标 |

三个候选:

- **α(推荐)— 复用 + 扩展**:goal mode 采用 `goal.transitioned` 作为转移事件;`GoalProjection` 作为被动投影并在 Runtime 04 扩展状态集与预算字段(或改用 `content_ref_only` 指向预算快照)。新增 `GoalModeState` 作为 canonical 状态(照 `PlanModeState` 先例),`GoalProjection` 是其被动投影输出。收益:单一 goal 概念,已接线的 TUI `task-goal`/timeline 槽位直接可用。
- **β — 并行新增**:新增 `session_objective` 概念,`GoalProjection` 保持原样。成本:两套 goal 概念永久共存,`GoalId`/`goal.transitioned` 语义分叉。
- **γ — 只复用投影,不用事件**:canonical 事件另起 `objective.*` 前缀。成本:与 `events.ts:33` 的预留重复。

推荐 α。理由:`GoalProjection` 的 `ProjectionMetadata`(`sourceHead`/`projectionDigest`/`completeness`)与 `revision`/`status` 正是 plan mode 被动投影的形状;扩展一个 `gaps: []` 的死 DTO 比引入第二套目标概念代价低。**裁定权属 Runtime 04**(`inventory.ts:220-240` 的 contract work package),本文只提出需求与理由。

若裁定为 β/γ,§6.2 的 `passive-state*.ts`/`inventory.ts` 改动项取消,其余不变。

### D14 — TUI 命令描述符需要三处能力扩展

`RegisteredSlashCommand`(`registry.ts:62`)与 `dispatchCommand`(`interactive-mode.ts:1163`)目前是「单 actionType + 单 arg 字符串」,缺少 omp 的三项能力:

| omp 能力 | omp 位置 | RunLedger 缺口 | 处置 |
|---|---|---|---|
| `subcommands[]` 声明 | `builtin-modes.ts:255-262` | 无;`/permissions` 用 `usage` 字符串硬编码提示 | 保持现状:用 `supportsInlineArgs` + `usage` + 工作流内解析(与 `/recovery` `registry.ts:262-269` 同款) |
| `getTuiAutocompleteDescription` 动态描述 | `builtin-modes.ts:265-270` | `description` 是静态字符串 | **需要**:否则 `/goal` 无法显示当前状态。扩展 `description` 为 `string \| (() => string)`,或在 `commandsForContext` 注入动态值 |
| `handleTui` 返回 `{prompt}` 让 dispatcher 继续提交 | `builtin-modes.ts:306-312` | 无;`dispatchCommand` 只调 workflow | **需要**:`/loop <inline prompt>` 与 `/goal set <objective>` 都必须把文本交给正常提交路径。经 `echoPrompt`(`interactive-mode.ts:1031`)实现,不新增返回协议 |

第 3 项是 `/loop <prompt>` 能否成立的前提(omp 正是用它跑第一轮迭代)。

### D15 — 新事件类型的注册路径

`RUNTIME_EVENT_TYPES`(`events.ts:15-151`,133 项)是**精确闭合 catalog**:`protocol/schemas.ts:52` 生成 `enum`,`:158`/`:211` 对每个成员生成 payload requirement 与 schema(requirement 由事件名后缀推导,`:143-155`)。plan 事件已全量登记(`:108-118`)。

因此 goal 的事件**必须**登记进 `RUNTIME_EVENT_TYPES` 并同步 `protocol/schemas.ts` 的推导表(自动生成,只需 catalog 成员)。`goal.transitioned` 已在其中且名字满足 `TRANSITION_ACTIONS` → 自动要求 `transition` + `expectedRevision` payload,与 reducer 语义天然吻合。

loop 的审计事件同样需要登记(否则不在 catalog 内,`isRuntimeEventType` `:563` 会拒绝)。这与 D3 的 `persistence: "ephemeral"` 不矛盾:**ephemeral 指不经 canonical reducer 重建状态,不指事件不入 catalog**。

SQLite 侧确认无迁移:`schema.ts:66/:179` 的 `event_type TEXT NOT NULL` 无 CHECK;`event-persistence.ts:87` 已写 `agent.event`、`sqlite-ledger.ts:40` 写 `ledger.*`,两者都不在 catalog 内,证明存储层不校验。

## 5. 阶段

### P0:契约冻结(独立 PR,无行为)

- D7 的 `UserAgentMessage.origin`。
- D13 裁定后:goal mode 状态 DTO/schema 落位;`GoalProjection` 扩展或并列。
- D15:goal/loop 事件类型进 `RUNTIME_EVENT_TYPES`;`session.goal`/`session.loop` protocol capability(`protocol.ts:16-37`)。
- `inventory.ts` 登记 `goal-mode` 与 `loop` 条目(照 plan-mode 条目 `:348-366`;loop 的 persistence 为 `ephemeral`)。
- `contracts/public.ts` 导出(照 `:29-30`)。
- RED:`tests/runtime-contracts/goal-mode/*` 消费者用例;`event-contracts.test.ts` 的 catalog 完整性。
- DoD:契约 PR 不含行为;`npm run check` 全绿。

### P0.5:独立缺陷修复 — todo 生产路径状态不持久化(G12)

独立缺陷,非本计划引入;可并行于 P1/P2(不阻塞),但 **P3 依赖其结论**(goal fragment 内嵌 todo 快照时,resume 后必须能读回真实进度)。独立 PR、独立验收,不与契约 PR 或 goal/loop 行为 PR 混提。

- 事实(§3.4 G12):`AgentTool.execute` 第五参已是 `ToolContext`(`types.ts:98-104`,注释明示「本期两者并存,后期完全切换到 context」),`ToolContext.ledger` 在生产恒有值(`tool-context.ts:39`,由 `agent.ts:320` → `tool-call-execution.ts:80` 注入);但 `todo.ts:393` 省略该参,`ledger` 只取构造期闭包。
- **处置 A(采纳)**:`todo.ts:393-395` 的 `execute` 接收 `context`,改为 `const ledger = context?.ledger ?? options.ledger`。一处改动覆盖全部三个组合点,不动 `domain.ts` 等热点文件,不破坏 `createExtendedTools` 的显式传入路径。
  - 优先级:context 优先,构造期选项为回退。当前无「两者都传且不同实例」的情形;若未来出现,以 context 为准并在注释中写明。
- **处置 B(不采纳)**:把 `ledger` 透传进 `createStdlibTools` 并改三个调用点。已在 16 P0.4 判定为待删的 legacy Host 也要跟着改,且 `domain.ts` 是 §6.3 的串行热点,收益低于 A。
- RED:新增走真实路径的用例 —— 经组合构造工具集,以**带 `ledger` 的 `ToolContext`** 调 `todo` 的 `execute` 并断言 `ledger.findByType("custom")` 出现 `todo_phases` 快照;再断言 `context` 缺省时回退到构造期选项。现有 `tests/tools-m4.test.ts:189-330` 的 8 个 todo 用例(全部直接调 `execute`,只传构造期 ledger)必须继续通过。
- 反例覆盖要点:该缺陷的漏网原因与 16 P0.1 的 `spawn_agent` 同构 —— 测试绕过了生产路径。用例必须经过 `makeToolContext`/agent-loop 的注入点,不得直接 `createTodoTool({ledger})` 后自证。
- DoD:生产 Session Owner 路径下 `todo` mutation 落 `ledger.custom` 事件,`resume` 后 `view` 返回原相位表;`npm run test:runtime` 与 `npm run test:security-storage` 全绿。

### P1:goal canonical 状态与 authority

- `src/runtime/modes/goal/{types,schema,reducer,errors,prompt}.ts`。
- `src/runtime/session-runtime/goal-domain.ts`:`SCHEMA`/`OPERATIONS`/`MANIFEST`/`GoalEventPayload`/`commit`/`prepare`/`load`,照 `plan-domain.ts:20-58,216-325,451` 分层;`effectClass` 取无工作区副作用类别。
- `src/runtime/session-runtime/goal-composition.ts`:被动投影(照 `plan-composition.ts`)。
- 生命周期命令:`set`/`replace`/`pause`/`resume`/`drop`/`request_complete`/`settle_complete`/`set_budget`/`account_usage`。
- 缓存:`goal-domain` 照 02 D4a 的结论做投影缓存(domain 为唯一 writer,提交后失效;`inspect()` 只读缓存;崩溃恢复仍走完整重放)。
- RED:非法转移矩阵、revision 冲突、幂等重放、缓存失效。测试:`tests/runtime/modes/goal/*`、`tests/runtime/session-runtime/goal-domain.test.ts`。
- DoD:owner 重启后从 event 重放得到逐字节相同状态;重复 `requestId` 返回缓存结果而非二次提交。

### P2:模型面 `goal` 工具与准入

- `src/runtime/session-runtime/goal-tools.ts`:单个 `goal` 工具(`op: create|get|complete|resume|drop|set_budget`),带 `capabilityClaims`(照 `plan-tools.ts:10-15`;缺 claim 会被 plan mode 的 unknown-effect deny 拒掉,`capabilities.ts:3-5`)。
- `domain.ts` 接线:构造 goal domain/tools,加入 `governedTools`(`:257`),注入 `goalState` 给 authorization(`:335` 同款)。
- `runtime-tool-authorization.ts:63-96`:goal 工具状态 gate(照 `planArtifactWriteTools` 的实例判定)。
- `access-resolver.ts:27-63`:显式分类 `goal`(不再落 `{kind:"tool"}`)。
- `goal-tools.ts` 的 `description` 为 TS 字面量(移植 `prompts/tools/goal.md` 内容;`plan-tools.ts:52,60,70` 是范式)。
- RED:`tests/security/goal-tool-admission.test.ts`(组合出的 `goal` 实例必须 allow;非当前实例必须 deny,参数化覆盖,与 16 P0.1 同款)。
- DoD:standard 会话中 `goal({op:"create"})` 经完整 `beforeToolCall` 链路成功;minimal/plan 会话无该工具。

### P3:mode fragment 与预算记账

- `src/runtime/modes/goal/prompt.ts` 的 `buildGoalFragment`(照 `modes/plan/prompt.ts`:`PlanFragmentInput` → `{key, text}`,`key` 供注入方去重)。
- 注入:`domain.ts:289-320` 的 `withContextSources` 增加 goal fragment(`layer:"mode"`、`trust:"trusted"`、`priority:"required"`),与 plan fragment 并列。
- 记账驱动:owner 在 `turn_start`/`tool_execution_end`/`agent_end` 上把 `UsageQuantity` 增量交给 `account_usage`(D6)。
- 用量来源:`usageSnapshot`(`usage/index.ts:127`)的 `cumulative` + `quantityValue`(`:238`)。
- 前置:**P0.5**(G12 修复,独立缺陷)。未修则 goal fragment 内嵌的 todo 快照在 resume 后为空;若 P0.5 未落地,本阶段的 fragment 必须显式省略 todo 段而不是注入空表。
- RED:usage 为 `unknown` 的 turn 必须把完整度降 `partial` 且不推进 `budget-limited`;`cacheRead` 不计入而 `cacheWrite` 计入的边界用例;`key` 去重(同 revision 不重复占预算)。
- DoD:预算耗尽 steer 每个 goal 只发一次(对照 omp `#budgetReportedFor`);`partial` 完整度下 fragment 明确标注下界语义。

### P4:loop 的 runtime 半边

- `src/runtime/loop/limit.ts`(移植 `loop-limit.ts`)+ `src/runtime/session-runtime/loop-controller.ts`。
- 迭代驱动:owner 在 `agent_end` 后判定,经 follow-up 注入下一轮(`loop-runner.ts:568`)。
- `prompt` 与 `compact` 两种动作(D2);`reset` 只发信号。
- 加固:`loop.maxIterations`(D8)。
- 前置:`readShellWord` 等价物确认(或内联最小解析器,只处理引号与转义)。
- RED:`tests/runtime/loop/limit.test.ts`(含「形状像 limit 但解析失败必须报错」用例)、`tests/runtime/session-runtime/loop-controller.test.ts`(预算耗尽、busy 时延迟重排、Esc 暂停、idle 窗口)。
- DoD:headless(无 TUI)下 `/loop 3` 恰好提交 4 次(首次 + 3 次迭代),且有对应审计事件。

### P5:loop condition(D10 裁定后)

- `src/runtime/loop/condition.ts`:退出码极性、`>1` 视为损坏、超时≠abort 三段语义保留;执行改走受治理路径。
- RED:超时/取消/退出码矩阵;条件自身损坏时停止而非当作 false。
- DoD:条件命令不出现在 agent 的持久 shell 会话中。

### P6:client 呈现(含 D14 的扩展)

- D14 的三项描述符能力(至少第 2、3 项)。
- `registry.ts`:新增 actionType 与 `/goal`、`/loop` 条目(照 `/plan` `:274`、`/mode` `:210` 的 `policy`/`availableDuringTask`/`requiredOperation`/`supportsInlineArgs`)。
- `interactive-mode.ts:1163` dispatch 分支;`src/tui/interactive/{goal-workflow,loop-workflow}.ts`。
- `task-goal` port 生产接线(照 `adapters/session-resources.ts:153` 的条件注入);timeline `goal_lifecycle` 投递。
- `footer/field-registry.ts`:goal badge + 预算字段(经 `registerFooterField` `:972`)。
- `/guided-goal`(D11,可选)。

## 6. 逐文件改动清单

### 6.1 新增

| 路径 | 内容 |
|---|---|
| `src/runtime/modes/goal/types.ts` | `GoalStatus`、`GoalModeState`、`GoalUsageDelta`、`GoalAccountingCompleteness` |
| `src/runtime/modes/goal/schema.ts` | typebox exact schema + guards |
| `src/runtime/modes/goal/reducer.ts` | 命令联合 + `reduceGoalModeState` + `isValidGoalModeState` |
| `src/runtime/modes/goal/errors.ts` | typed failures(照 `modes/plan/errors.ts`) |
| `src/runtime/modes/goal/prompt.ts` | `buildGoalFragment`(照 `modes/plan/prompt.ts` 的纯函数 + `key`/`text` 形态) |
| `src/runtime/session-runtime/goal-domain.ts` | authority:OPERATIONS/MANIFEST/commit/prepare/load/缓存 |
| `src/runtime/session-runtime/goal-composition.ts` | 被动投影 |
| `src/runtime/session-runtime/goal-tools.ts` | `goal` 工具(描述为 TS 字面量) |
| `src/runtime/session-runtime/goal-continuation-controller.ts` | 续跑调度(D9) |
| `src/runtime/loop/limit.ts` | loop 预算(移植) |
| `src/runtime/loop/condition.ts` | 条件判定(P5) |
| `src/runtime/session-runtime/loop-controller.ts` | 迭代驱动 + 审计事件 |
| `src/tui/interactive/goal-workflow.ts`、`src/tui/interactive/loop-workflow.ts` | client 工作流 |
| `tests/runtime/modes/goal/*`、`tests/runtime/loop/*`、`tests/runtime/session-runtime/goal-*.test.ts`、`tests/runtime/session-runtime/loop-*.test.ts`、`tests/security/goal-tool-admission.test.ts`、`tests/integration/goal-mode-end-to-end.test.ts`、`tests/tui/*`、`tests/runtime-contracts/goal-mode/*` | 测试 |
| `tests/runtime/tools/todo-context-ledger.test.ts`(**P0.5**;现有 todo 用例在 `tests/tools-m4.test.ts`,同族测试位于 `tests/runtime/tools/`) | 经带 `ledger` 的 `ToolContext` 驱动 `todo.execute`,断言落 `ledger.custom` 快照与 `context` 缺省时的回退 |

### 6.2 修改

| 路径 | 改动 |
|---|---|
| `src/runtime/types.ts:162-165` | `UserAgentMessage.origin`(D7) |
| `src/runtime/protocol/events.ts:15-151,376-386` | 新事件类型进 `RUNTIME_EVENT_TYPES`(D15);`goal.transitioned` 已存在 |
| `src/runtime/protocol/schemas.ts:52,143-155,158,211` | 推导表随 catalog 成员自动覆盖;若需额外 payload 要求则在 `payloadRequirements` 补分支 |
| `src/runtime/contracts/passive-state.ts:24-32`、`passive-state-schemas.ts:47-64`、`inventory.ts:61,220-240` | D13 裁定为 α 时扩展 `GoalProjection` 与策略 |
| `src/runtime/session-server/protocol.ts:16-37` | `session.goal`、`session.loop` capability |
| `src/runtime/session-runtime/domain-router.ts:110-125` | 汇总 goal/loop operation(照 `:121`) |
| `src/runtime/session-runtime/session-runtime.ts:172-284,382-394` | 接线两个 controller(对照 idleRecap 的 8 个接线点) |
| `src/runtime/session-runtime/domain.ts` | `:211-266` 组合、`:289-320` `withContextSources` 叠加 goal fragment、`:335-336` 状态注入、`:453/:460/:470`(goal 与 loop) |
| `src/runtime/tools/todo.ts:393-395` | **P0.5**:`execute` 接收第五参 `context`,ledger 取 `context?.ledger ?? options.ledger`(G12;不改 `domain.ts`) |
| `src/runtime/session-runtime/command-routes.ts:16-42` | 若需新命令组则登记;否则复用 `domain` 路由 |
| `src/runtime/contracts/public.ts:29-30` | 导出 goal types/schema |
| `src/security/integration/runtime-tool-authorization.ts:63-96` | goal 状态 gate |
| `src/security/permission/access-resolver.ts:27-63` | `goal` access 分类 |
| `src/runtime/tools/capabilities.ts:17-31` | 若 `goal` 走 `createStdlibTools` 则登记 claim 映射(否则由 `goal-tools.ts` 自带 claim) |
| `src/storage/settings-manager.ts:42-90,250,388` | `goal.*`/`loop.*` settings(D8) |
| `src/tui/commands/registry.ts:32-67,62` | 两条命令 + actionType + D14 的描述符能力 |
| `src/tui/interactive-mode.ts:972,1031,1163,1420` | dispatch、footer 字段注册、`echoPrompt` 复用 |
| `src/tui/footer/field-registry.ts:10-45` | `FooterSnapshot` 增加 goal/loop 字段 + 新增 field 定义 |
| `src/tui/application/{effect,effect-runner,reducer,ports}.ts` | 启用 `task-goal.inspect` 与新增 loop inspect |
| `src/tui/presentation/tools/types.ts:22,116` | 已预留 `"goal"` tool kind 与 renderer payload;接上真实工具结果 |
| `src/tui/timeline/{types,reducer}.ts:62,129/114-135` | 已预留 `goal_lifecycle`;接上 `goal.transitioned` 投递 |
| `src/tui/adapters/session-resources.ts:153` | 条件注入 `taskGoal` port |
| `docs/subsystems/tools.md`、`development-doc/{00-index.md,plan/README.md}` | 文档登记 |

### 6.3 串行窗口

`domain.ts`(组合点)与 `command-routes.ts`(路由表)是全仓热点,两个功能共用一个修改窗口,不得并行编辑(与 02 §6 同一纪律)。`types.ts`(`origin`)与 `protocol/events.ts`(catalog)同属 P0,单独一个 PR。

## 7. 事件与契约增量

登记进 `RUNTIME_EVENT_TYPES`(D15);`goal.transitioned` 已存在,其余新增:

| 事件 | 语义 |
|---|---|
| `goal.transitioned`(**已预留**) | 所有 goal 状态转移;payload 自动要求 `transition` + `expectedRevision`(`schemas.ts:146,149`) |
| `goal.budget_updated` | 预算变更 |
| `goal.budget_exhausted` | 确证耗尽(仅在完整度 `complete` 时产生) |
| `goal.usage_accounted` | 一次用量记账(含完整度与 `unaccountedTurns`) |
| `goal.continuation_requested` | 续跑决策(omp 该类型是死代码,见 §2.3;RunLedger 必须真实产生) |
| `goal.continuation_suppressed` | 空转抑制(D9) |
| `loop.started`、`loop.iteration_submitted`、`loop.iteration_settled`、`loop.stopped` | loop 审计(D3) |

契约增量:

- `UserAgentMessage.origin`(D7)—— 破坏性,单列 PR。
- `session.goal`、`session.loop` protocol capability。
- D13 裁定后 `GoalProjection` 的扩展(或并列 DTO)。

## 8. 冻结物与门禁

任一项遗漏即 fail closed:

- `tests/runtime/session-runtime/harness-profile-standard.test.ts` 的工具名有序 golden + canonical digest(`goal` 入列)。
- `tests/stdlib-tools.test.ts` 的 registry size 与 `has()` 显式清单(若 `goal` 走 `createStdlibTools`)。
- `tests/security/current-boundary.test.ts` 的静态边界扫描(对新增组合点敏感)。
- `tests/runtime/harness-profiles/*` 的 minimal/plan 冻结 manifest:**goal 不进 allowlist 则不改**,但 P2 必须有 guard 固化「minimal/plan 不含 goal」。
- `tests/runtime-contracts/event-contracts.test.ts` 与 `inventory.test.ts`(catalog 与 inventory 完整性)。
- `tests/runtime-contracts/passive-state-contracts.test.ts`(若 D13 为 α)。
- **P0.5**:`tests/tools-m4.test.ts:189-330` 的 8 个 todo 用例(全部走构造期 `createTodoTool({ledger})`)必须继续通过 —— 回退路径的回归锚点;`tests/stdlib-tools.test.ts` 对 `createStdlibTools` 签名的断言(处置 A 不改签名,应保持原样)。
- `scripts/check-*-boundaries.ts` 全套(§0.3 的 `npm run check`)。

## 9. 验证矩阵

| 层 | 命令 | 覆盖 |
|---|---|---|
| 契约 | `npm run check` | 类型、边界、consumer 覆盖、catalog 完整性 |
| runtime(P0.5) | `npm run test:runtime` + `tests/runtime/tools/todo-context-ledger.test.ts` | todo 经 `ToolContext.ledger` 持久化;`tests/tools-m4.test.ts` 回退路径不回归 |
| runtime | `npm run test:runtime` | reducer、domain、controller |
| security/storage | `npm run test:security-storage` | admission、settings |
| integration | `npm run test:integration` | goal 端到端(工具 → domain → event → 投影) |
| TUI | `npm run test:tui-native` | footer 字段、命令注册与派发 |
| 构建 | `npm run build` | 进入 `dist/` 的改动 |
| 真实 CLI/TUI | 隔离 `RUNLEDGER_DIR` + 真实 TTY | `/goal set` → 自动续跑 → `complete`;`/loop 3` 精确迭代计数 |

自动化、built CLI/TTY、真实 provider、人工键盘是不同证据,不互相替代(02 §0.3)。

## 10. 风险与回滚

| 风险 | 说明 | 缓解 |
|---|---|---|
| 自主执行风险 | 自动续跑让 agent 在无人值守时持续消费预算并改动工作区 | `goal.maxContinuations` + `loop.maxIterations`;空转抑制(D9);全部迭代可审计 |
| 契约破坏 | `UserAgentMessage.origin` 触及 codec、`convertToLlm`、transcript、web | 单列 P0 PR;旧消息按 `origin:"user"` 读取 |
| goal 概念分叉 | 与 §1.2 的预留物冲突处理不当会留下两套目标语义 | D13 显式裁定;α 优先 |
| catalog 闭合性 | 新事件不在 `RUNTIME_EVENT_TYPES` 内会被 `isRuntimeEventType` 拒绝 | D15 强制登记;`event-contracts.test.ts` 覆盖 |
| 预算语义误读 | `partial` 完整度下 `tokensUsed` 是下界,可能被当作精确值 | prompt 与 footer 都显示完整度;`budget-limited` 只在下界确证时触发 |
| 两层上限叠加 | goal 续跑与 run budget 同时生效,行为难解释 | 任一 run budget 终止即停续跑并记录原因(D9) |
| domain 重放成本 | 02 D4a 实测 plan 全量重放 607ms 下界;goal 每轮重放会重复支付 | P1 强制投影缓存 |
| `reset` 语义漂移 | runtime 只发信号,client 执行;多客户端下信号可能无人消费 | 显式失败提示,不静默降级为 `prompt` |

回滚:goal/loop 均为新增模块与新增事件类型;回滚 = 撤掉组合点接线与命令注册,已写入事件在重放时被忽略(未注册类型的 reducer 不参与)。`UserAgentMessage.origin` 是唯一需单独回滚策略的项(P0 单独 PR)。P0.5 是单点行为修复(`todo.ts` 一行取值),回滚 = 还原为只读构造期选项,不影响本计划其余部分。

## 11. 待裁定

> 2026-09-17 裁定结果（用户确认）：1=α、2=(a)、4 保持 30s 默认但改为 owner 侧可配置、5=保留、6=不允许、3=接受、7 取 `commandsForContext` 注入动态描述（本期未改 `description` 类型）。

1. **D13 — goal 概念归属**：**已裁定 α**。goal mode 复用 `goal.transitioned` 事件与 `GoalProjection` 被动投影；`GoalProjection` 的 `status` 改为与 `GoalStatus` 同一状态集，并新增 `objective`/`budget`/`usage`/`continuations`；`GoalModeState` 为 canonical 状态。落地见 §13 P0/P1。
2. **D10 — loop condition 的执行路径**：**已裁定 (a)**。`src/runtime/loop/condition.ts` 保留三段判定语义，执行经调用方注入的受治理端口（`LoopConditionOptions.execute`）。P5 的判定与矩阵测试已实现；把该端口接到 Session Owner 的 governed bash 能力路径属于 workspace/security 侧接线，见 §13 的剩余缺口。
3. **D7 — `UserAgentMessage.origin`**：**已接受**。`origin` 为必填字段；owner 注入的 goal 续跑与 loop 迭代以 `origin:"runtime"` 提交，TUI 以 `[runtime]` 标记呈现，不触发自动标题。
4. **D8 — `goal.continuationDelaySeconds` 默认 30s**：保持 30s；owner 侧可配置（1–3600s），不再是 omp 的 TUI 800ms 固定延迟。
5. **loop `reset` 动作**：**保留**（D2）。runtime 只回 `loop_reset_requires_client`，由 client 换新 session 执行。
6. **`goal` 是否允许在 `plan@1` profile 使用**：**不允许**。goal 工具、`goal.*` operation 与 `session.goal` capability 只在 standard 组合出现；`minimal`/`plan` 的冻结 allowlist 不含 goal，测试固化该边界。
7. **D14 第 2 项的实现形态**：本期在 workflow 内解析参数并渲染结果（`/goal` 无参即输出当前状态），未修改 `description` 的类型；若后续需要命令列表内的动态描述，再改为 `string | (() => string)`。

## 12. 附:未采纳的 omp 实现细节

| omp 细节 | 不采纳的理由 |
|---|---|
| 800ms 固定延迟(`interactive-mode.ts:1731-1741`) | RunLedger 用可配置 idle 窗口,判定在 owner 侧;固定 800ms 是 TUI 交互产物 |
| 动态工具集进出(`:3563-3625`) | profile 会话创建时冻结(§0.2、D4) |
| 「冷恢复一律转 paused」(`:3264-3330`) | RunLedger 从 canonical event 重放,重放即权威(D5) |
| 「Esc → paused / 内部中断 → 保持 active」 | `interrupt(): void` 无原因参数,不可区分(G9、D5) |
| 「有待发图片则不自动提交」 | 编辑器无附件 API(G11) |
| `mock`/`echo` 类测试辅助 | 本仓库不用 mock 作生产 fallback(`AGENTS.md` §2) |
| TUI 私有标志(`#pendingSubmittedInput`/`#goalTurnHadToolCalls`) | 状态归 owner,client 不持有判定用布尔值 |
| `GoalRuntimeEvent.goal_continuation_requested` 的死实现 | omp 无生产者;RunLedger 必须真实产生(§2.3、§7) |
| `goal-mode-context.md` 的 todo 快照拼接 | RunLedger 走 context source;若内嵌 todo 需先落地 P0.5(生产路径 todo 状态不持久化,G12) |
| `readShellWord` 的直接复用 | 需先确认 RunLedger 有等价 tokenizer 或内联最小实现(§5 P4) |

## 13. 实施记录

### 2026-09-16 — P0.5 todo 调用上下文持久化

先实施已裁定且可独立验收的 P0.5，遵守 §0.3 的单阶段交付边界。本次不实施 P0 契约或 goal/loop 行为，不改动工作树中既有 Web 可观测性工作。

- `src/runtime/tools/todo.ts` 接收第五参 `ToolContext`，使用 `context?.ledger ?? options.ledger`；当前调用的会话 ledger 优先，保留构造期回退。
- 新增 `tests/runtime/tools/todo-context-ledger.test.ts`：经 `createStdlibTools` 与 `makeToolContext` 注入，覆盖持久化、新工具实例恢复、跨会话隔离、context 优先、无 context/无 context ledger 回退，以及 owner-fenced SQLite 写入与数据库重开恢复。修复前 4 项中 3 项失败，修复后全通过。
- 定向验证：`npx vitest run tests/runtime/tools/todo-context-ledger.test.ts tests/tools-m4.test.ts tests/stdlib-tools.test.ts`，3 文件 / 52 项通过。
- `npm run check` 通过；完整日志 `/tmp/runledger-plan17-check.log`。
- `npm run test:runtime` 通过，155 文件 / 924 项；`npm run test:security-storage` 通过，103 文件 / 691 项。日志分别为 `/tmp/runledger-plan17-runtime.log`、`/tmp/runledger-plan17-security.log`。
- `npm run build` 通过，日志 `/tmp/runledger-plan17-build.log`。`command -v runledger`、`readlink -f` 与 `npm ls -g --depth=0` 确认全局入口链接到本仓库 `bin/runledger.js`。
- 构建后的 CLI 在隔离 home、真实 PTY、本地确定性 HTTP provider 下执行 `todo init → done → view`，4 次模型请求、2 条 `todo_phases` 快照，最终任务为 `completed`。证据目录 `/tmp/runledger-plan17-cli-lc6sqG`，验收脚本 `/tmp/runledger-plan17-cli.mjs`。这是实际 CLI/Owner/HTTP 接线证据，不是外部 provider 或人工 TUI 验收。
- 扩展恢复验收通过：CLI 退出后，用 `dist` 中的生产 embedded Owner 与 Session controller 重新附着同一 Session，经正常 prompt/tool 链调用 `todo view`，读回 `completed`；前后共 6 次 HTTP 模型请求，todo 快照仍为 2 条，读取不额外写快照。证据目录 `/tmp/runledger-plan17-cli-9maGW0`。
- `npm test` 未通过：fast 首块 78 文件通过 / 2 文件失败，527 项通过 / 2 项失败。`tests/glob.test.ts` 要求单段 `*.ts` 不递归，与当前工具明确的任意深度匹配语义冲突；`tests/cli/control-command-execution.test.ts` 一项收到 `status:null`。单独复核两文件后 CLI 6 项通过，glob 的同一断言仍失败（合计 12 通过 / 1 失败）。本次未修改这些文件。日志 `/tmp/runledger-plan17-test.log`、`/tmp/runledger-plan17-baseline-failures.log`。
- 提交：无。根 `AGENTS.md` §7 要求验证失败时不自动提交，因此保持本阶段改动未提交；不把完整计划或完整门禁标为完成。

后续阶段从 P0 契约边界继续；D7/D13 等裁定仍按 §11 记录，P5 在 D10 用户裁定前不启动。

### 2026-09-17 — P0/P1/P2/P3/P4/P5/P6 主体实施

按 §11 裁定（α、(a)、接受 `origin`、保留 reset、不允许 plan@1、30s 默认）实施全部阶段。

**P0 契约冻结**

- `UserAgentMessage` 增加必填 `origin: "user" | "runtime"`（`src/runtime/types.ts`）；owner 注入的续跑/迭代以 `runtime` 提交，`normalizePrompts` 对字符串输入默认 `user`，controller `prompt(text, behavior, origin)` 在 runtime-origin 时不触发 `onAcceptedUserPrompt`（自动标题只跟真实用户输入）。
- `RUNTIME_EVENT_TYPES` 新增 `goal.budget_updated`/`budget_exhausted`/`usage_accounted`/`continuation_requested`/`continuation_suppressed` 与 `loop.started`/`iteration_submitted`/`iteration_settled`/`stopped`；`loop.*` 的 subject kind 映射为 `session`（loop 不是独立 subject 家族）。payload requirement 推导同步：`budget_updated`/`budget_exhausted`/`continuation_requested` 带 `transition + expectedRevision`（revision 推进会 CAS），`usage_accounted`/`iteration_settled` 带 metadata digest，`continuation_suppressed` 带 reasonCode，`iteration_submitted` 带 refs。
- `SESSION_PROTOCOL_CAPABILITIES` 新增 `session.goal`、`session.loop`。
- `GoalProjection` 扩展为与 `GoalStatus` 同一状态集并新增 `objective`/`budget`/`usage`/`continuations`；`GoalBudget`/`GoalUsage` 直接复用 canonical 结构，投影与状态拒绝同一组漂移字段。`PASSIVE_PERSISTENCE_POLICIES` 的 `GoalProjection` 改为 `metadata_only` + 显式 forbiddenFields。
- `CONTRACT_INVENTORY` 新增 `goal-mode` 与 `loop` 条目（loop 的 persistence 为 `ephemeral`）；`contracts/public.ts` 导出 goal types/schema。
- 新增 `tests/runtime-contracts/goal-mode/contract-consumer.{ts,test.ts}`：catalog 完整性、subject kind 绑定、payload 精确校验、状态与投影的漂移拒绝。

**P1 goal authority**

- 新增 `src/runtime/modes/goal/{types,schema,reducer,errors,prompt}.ts`、`src/runtime/session-runtime/goal-domain.ts`、`goal-composition.ts`。
- reducer 覆盖 `set/replace/pause/resume/drop/request_complete/settle_complete/set_budget/account_usage/record_continuation`；跨字段不变量含「`tokensUsed` 等于可见分项之和」「`partial` 必须由 `unaccountedTurns` 解释」「`budget_limited` 必须有上限」。
- 预算耗尽只在完整度为 `complete` 时成立；`partial` 下即使下界远超预算也不进入 `budget_limited`，且 `resume` 会被拒到预算被提高为止。
- 缓存与重启：写路径只读链尾、`inspect` 只读缓存；新 owner 完整重放得到逐字节相同状态。同一 `requestId` 返回缓存结果，payload 不同则 `goal_idempotency_conflict`。

**P2 goal 工具与准入**

- 新增 `src/runtime/session-runtime/goal-tools.ts`：单个 `goal` 工具（`create|get|complete|resume|drop|set_budget`），描述为 TS 字面量，声明 `workspace_write`/`session-goal-state` claim。
- 只在 `standard` 组合叠加：`goal.enabled` 且 `profile.tools.mode === "standard"`。`minimal`/`plan` 既无工具也无 `session.goal`（测试固化）。
- admission 按实例身份：组合出的 `goal` 实例 allow，同名外来实例 deny。

**P3 mode fragment 与预算记账**

- `buildGoalFragment` 按状态产出片段：inactive 不注入；active 带 objective/预算/工具指引；续跑轮额外带 `<goal_continuation>` 与完成前 6 条审计清单；`paused`/`budget_limited`/`complete`/`dropped` 各自给对应禁令。
- 预算渲染在 `partial` 时显式标注 `observed lower bound` 与未计量轮次；todo 段来自持久化状态（`readTodoPhases`/`renderTodoPhases`），空快照整段省略而不是注入空表。
- 记账驱动在 owner：`message_end`（assistant，带 usage）按 input+cacheWrite+output 入账、排除 cacheRead；usage 缺失记 `tokensUnknown`；`agent_end` 的活跃时长单独入账。注入点复用 `withContextSources` 的 `layer:"mode"` fragment。

**P4/P5 loop**

- 新增 `src/runtime/loop/limit.ts`：移植 `parseLoopArgs`（count/duration/`--while`/`--until`/inline prompt），形状像 limit 或 flag 但解析失败一律硬报错；`LoopLimitRuntime` 不可变，消耗迭代返回新值；无显式 limit 时用 `loop.maxIterations` 兜底。`readShellWord` 内联为最小引号/转义解析器。
- 新增 `src/runtime/loop/condition.ts`：保留三段语义（退出码权威、`>1` 判坏条件、超时≠取消），执行经注入端口，从不抛出。
- 新增 `src/runtime/session-runtime/loop-controller.ts`：首轮立即提交 + N 次迭代；每次迭代写 `iteration_submitted`/`iteration_settled`/`stopped` 审计事件；run budget 终止、recovery barrier 打开、空 prompt、`reset`、条件关闭都在提交前明确拒绝而不是静默降级。
- 条件执行接到 Session 的 governed `ExecutionEnv`（与 bash 同一能力路径），带强制超时（60s）与取消区分；证据见下。

**P6 client 呈现**

- `registry.ts` 新增 `/goal`（`goal.inspect`）与 `/loop`（`loop.control`），`availableDuringTask: false`，`requiredOperation` 绑定到协商结果。
- 新增 `src/tui/interactive/goal-loop-workflow.ts`：`/goal [set|pause|resume|complete|drop|set-budget]`、`/loop <limit> [--while|--until 'cmd'] <prompt>`、`/loop stop`，并把 typed 失败映射为可读提示；只经 command/query，不在 client 安排迭代节奏。
- `interactive-mode.ts` 接线 workflow/派发；footer 新增 `identity.goal` 徽标（`partial` 显示 `≥` 前缀）；`task-goal` port 经 `goal.inspect` 条件注入；`agent_end` 后刷新徽标并在状态变化时投递 `goal_lifecycle` timeline 行。
- runtime-origin 消息在 transcript 折叠为 `[runtime] …` 行（`PresentationBlock.role` 增加 `"runtime"`），timeline 行携带 `origin`。

**验证（本次工作树状态）**

- `npm run check` 通过（含 `check:tui-boundaries`、契约 consumer、catalog 完整性）；日志 `/tmp/plan17-check-final.log`。
- `npm run test:runtime` 通过（含新增 goal/loop 用例）；`npm run test:security-storage` 通过；`npm run test:tui-native` 通过；日志 `/tmp/plan17-runtime.log`、`/tmp/plan17-security.log`、`/tmp/plan17-tui.log`。
- 定向证据：`tests/runtime/session-runtime/goal-domain.test.ts`（canonical 转移 + durable 事件序列）、`goal-domain-cache.test.ts`（缓存零重放、重启逐字节一致、幂等与冲突）、`goal-tool-admission.test.ts`（实例身份准入、minimal 无 goal）、`loop-controller.test.ts`（迭代计数与审计、run budget 终止、barrier 打开、governed condition 真实执行）、`goal-continuation.test.ts`（抑制矩阵 + 用量口径）、`tests/runtime/modes/goal/*`、`tests/runtime/loop/*`、`tests/tui/commands/goal-loop-commands.test.ts`。

**未完成的验收项（不隐瞒）**

- 真实 CLI/TTY 的 `/goal set` → 自动续跑 → `complete` 与 `/loop 3` 精确迭代计数尚未执行：自动续跑需要真实 provider 往返，本机未配置外部 provider；owner 侧的迭代计数与审计已由 `loop-controller.test.ts` 的真实 store/owner 组合覆盖。
- `npm run build` 与构建后 CLI 尚未在本阶段重跑。

### 2026-09-17 — 真实 CLI/TTY 验收与由此发现并修复的缺陷

在隔离 home、真实 tmux PTY、本地确定性 HTTP provider（每轮先调 `goal` 工具再收尾，保证 run 真正结束）下，用构建后的 `runledger` 跑通两条路径。证据目录 `/tmp/runledger-plan17-real-v49V5W`（含 `plan17goal.pane.txt`、`plan17loop.pane.txt`、`requests.jsonl`、`report.json` 与两份验收脚本）。

- `/goal set Ship the goal mode adaptation end to end.` → 真实用户轮 → owner 自动续跑 → `/goal complete`：provider 观察到 4 次固定文案 `Continue the active goal.` 的续跑轮，第 5 次被 `goal.continuation_suppressed`（`max_continuations`）抑制；随后 `goal.request_complete` + `goal.settle_complete` 把目标结算为 `complete`。
- `/loop 3 check the objective status`：恰好 4 次 `loop.iteration_submitted`（首轮 + 3 次迭代），8 次 provider 往返（每轮 2 次），最后 `loop.stopped` 的 `reasonCode` 为 `iteration_limit_reached`；loop 事件未进入 goal 会话流（两边各自独立审计）。

本轮验收暴露并修复了 6 个只有真实链路才会显形的问题；每个都补了回归覆盖：

1. **组合根未传 goal/loop settings**：`embedded-session-runtime` 只解析 `recap`，`goal.continuationDelaySeconds`/`loop.maxIterations` 等配置形同虚设（续跑按默认 30s 而非配置的 1s）。现按 `recap` 同款注入 `resolveGoalSettings`/`resolveLoopSettings`。
2. **owner 侧并发提交抢 revision**：每轮 `message_end` 记账与 `agent_end` 续跑记账并发触发，互相读到过期 revision，续跑记账被 CAS 拒绝。`SessionGoalDomain` 现以单一写队列串行化全部写（含客户端 mutation）。
3. **清除可选字段写成 `undefined`**：`resume`/`replace`/`drop`/`record_continuation` 用 `{ completion: undefined }` 表达清除，exact schema 直接拒绝，导致 `resume` 与续跑记账全部失败。`nextState` 现把显式 `undefined` 解释为删除键。
4. **空转判定按 turn 而非按 run**：`turn_start` 就重置「本轮有工具调用」，于是末轮只回文本的 run 一律被判空转，第二次续跑起全部被抑制。改为 `agent_start` 重置、`tool_execution_end` 置位。
5. **注入轮与在飞 run 竞态**：`agent_end` 时 `agent.inFlight` 尚未清除，直接 `prompt` 会落进 steering 队列而当前 run 已过 dequeue 点，消息无人消费 → loop 停在第 2 次迭代。goal 续跑与 loop 迭代现在都先 `waitForIdle()` 再注入。
6. **`prompt` 丢失接收者**：两个 controller 都解构 `const prompt = controller.prompt` 后调用，丢掉 `this`；改为保留 controller 再调用。
7. **用户结算路径不闭环**：`/goal complete` 只登记请求，没有任何客户端能结算，目标永远停在 pending。用户是唯一权威，一次 `/goal complete` 现在先登记（若未登记）再按新 revision 结算；另加 `/goal reject` 撤回请求。
8. **loop 启动失败静默**：迭代提交失败只停止 loop，不给用户原因。现在投递 `session.loop_notice` 并记录 `prompt_failed`。

验证：`npm run check`、`npm run test:runtime`、`npm run test:security-storage`、`npm run test:tui-native`、`npm run build` 通过；`tests/runtime/session-runtime/loop-controller.test.ts`（含 governed 条件真实执行与启动失败提示）、`goal-continuation.test.ts`（含空转判定按 run）、`tests/runtime/modes/goal/reducer.test.ts`（含字段清除）为对应回归。

提交：`12d0552`（仅本计划改动；工作树中既有的 Web 可观测性工作按显式路径排除，混合文件用过滤补丁只暂存 `origin` 相关 hunk）。
