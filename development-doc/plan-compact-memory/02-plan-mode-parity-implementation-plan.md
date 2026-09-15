# RunLedger Plan Mode 完整度对齐实施计划

> 状态:待实施;P0–P7 全部未开始。本文是 Plan Mode 用户可见行为交付的唯一账本。
> 基线日期:2026-09-16;RunLedger 基线 `b25ff70`(分支 `rollback/before-composer-shape`)。
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
| 入口 | 仅新会话选 `plan@1`(`harness-profiles/builtins.ts:63`、`agent-mode.ts`、`--mode plan`/`/mode plan`/`settings.agentMode`) | 有,但不支持会话内进入 |
| 初始状态 | owner 启动即写初始正文并 activate(`session-runtime/plan-domain.ts:66`) | 有 |
| 模型工具 | `read`、`glob`、`ls`、`plan_read`、`plan_write`(`builtins.ts:70`、`plan-tools.ts:9,28`) | 有;无进入/退出/请求批准工具 |
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

**D2 — 只读边界在 authorization 层表达,不动态改工具表。** Harness composition(tool manifest + prompt + digest)在 owner 启动时冻结并校验(`composition-receipt.ts:99`、`tool-projection.ts:35`)。因此 plan mode 不通过移除工具实现,而是:(a) authorization ceiling 按 mode 状态 deny(`policy.ts:39`),(b) ExecutionEnv 对 `plan@1` 保持只读包装,(c) mode 指令经 ContextEngine fragment 注入。计划工件工具在 mode 非受限状态一律 deny。

**D3 — 计划正文的真源仍是 Session event。** 工件正文继续以 bounded payload(≤65536 字符 / 128 KiB / 255 revision)写入 owner-fenced event 并重放校验;canonical home 下的导出文件是可删除重建的投影,不是第二真源。与 01 §6.7"大正文进 Artifact Store"的偏差在此明确记录:避免 payload 变体、避免隐式格式迁移、避免双真源。若单会话 plan 事件总量成为实际负担,再以独立显式迁移入口处理。

**D4 — standard 会话新增 plan 工具必须走新 profile ref。** 新增 `plan_read`/`plan_write`/`enter_plan_mode`/`exit_plan_mode` 到 standard 工具表会改变 manifest digest,与 profile 冻结冲突。因此本次冻结 `standard@3 = standard@2 + plan 工具组`,旧 `standard@2` 会话保持原 ref 恢复;迁移沿用 Runtime 10 的 offline 结构性路径(schema 6 → 7),不改写历史 SQL。

**D5 — 工件写例外从单一 writer 实例扩展为显式 plan 工具集合,仍按对象身份判定。** 集合由 composition 注入,不看工具名、不受用户输入影响;`plan_write`/`enter_plan_mode`/`exit_plan_mode` 在允许后仍受 state 状态约束(仅 active 或 pending 的合法转移)。plan 工具之外的一切 `workspace_write`/`process`/`network`/未知效果继续 deny。

**D6 — 审批绑定不变,决策集扩展。** 继续绑定 state revision + artifact revision + digest + approvalId;新增 `changes_requested` 决策回到 `active`,反馈文本作为**下一 planning turn 的 user 输入**,不写入工件正文。

**D7 — 实施交接三条路径,不用 `session.fork`。** `session.fork` 固化继承源 profile(`domain-router.ts:461-480`),plan@1 的 fork 仍是只读。因此 fresh-context 实施改为:新建 standard@3 会话 + 显式 approved plan handoff(带源 sessionId、revision、digest、审批 receipt digest),只带已批准计划与来源引用,不带未批准的 planning tail。

**D8 — 不引入 plan 专用模型与 model role。** RunLedger 无 model role 概念;进入/退出 plan mode 不切换模型,模型与 thinking 仍由用户显式选择。

**D9 — 不移植 `local://` 通用沙箱与子代理计划交接。** 计划产物经 `plan_write`(无路径参数)与 canonical home 导出落地;child 委派保持 Runtime 08 边界。

## 5. 阶段

### P0:契约与事件冻结

前置:无。

目标:把本文所需的公共契约、事件名与 reducer 命令冻结到 Runtime 04 / 01 的 allowlist;行为 PR 只消费。

任务:

- [ ] 扩展 `PlanApprovalRefSchema.status` 枚举与 `PlanApprovalRef` 类型,加入 `changes_requested`(`modes/plan/schema.ts`、`modes/plan/types.ts`)。
- [ ] 新增 reducer 命令 `reactivate`:`pending` + 目标为当前 working revision 的合法工件 → `active`(`modes/plan/reducer.ts`);既有 `activate` 继续要求 revision 0,首次激活的不变量不放宽。
- [ ] 新增事件名并登记 catalog 与 inventory:`plan.revision_written`、`plan.approval_rejected`、`plan.changes_requested`、`plan.approval_invalidated`、`plan.handoff_created`、`plan.exported`(`runtime/protocol/events.ts`、`runtime/contracts/inventory.ts:348`)。
- [ ] 冻结 domain operation 名:`plan.enter`、`plan.exit`、`plan.reenter`、`plan.export`;`plan.resolve_approval` 的 `decision` 取值 `approved|rejected|changes_requested`。
- [ ] 冻结 session handoff 载荷形状:`session.create` 的 `planHandoff`(源 sessionId、源 artifact revision、digest、审批 receipt digest)与目标 profile 为 `standard@3`。
- [ ] 冻结 `standard@3` ref 与 plan 工具组描述符;登记 composition receipt 期望摘要与 schema 迁移边界(schema 6 → 7)。
- [ ] 更新 01 Phase 3–5 的状态入口注记,指向本文。

测试:

- [ ] `tests/runtime-contracts/plan-context-memory/{passive-contracts,contract-consumer}.test.ts`:新枚举、新事件名、handoff 载荷的 public surface 断言。
- [ ] `tests/runtime-contracts/public-surface.test.ts`:无重复类型、无私有 current payload。
- [ ] `tests/runtime/modes/plan/reducer-store.test.ts`:`reactivate` 的合法/非法转移与 `activate` 的 revision 0 不变量。

完成门槛:

- 契约 PR 与行为 PR 分离;allowlist 之外的公共类型/schema 无 diff。
- `npm run check` 通过,`check:current-format` 通过(事件名与文档不含代际标记)。

建议 commit:`plan: freeze plan-mode lifecycle and approval contract`

### P1:会话内 mode 生命周期与安全点

前置:P0。

目标:standard 会话可 durable 进入/退出 plan mode;`plan@1` 保持自动 active 与不可解除的只读组合;mid-turn 请求在安全点投递;重启/恢复状态一致。

任务:

- [ ] 装配改动(`session-runtime/domain.ts:207-224`):SessionPlanDomain 对所有 profile 装配;新增 `planCompositionReadonly`(仅 `plan@1`)控制只读 ExecutionEnv(`:214`)与 authorizaton 的 `enforceReadonly`(`:312-314`);plan 工具组在 standard 会话注册但按 mode 状态判权。
- [ ] `standard@3` profile 与 schema 6 → 7 offline 迁移(`harness-profiles/{builtins,agent-mode,resolver,composition-receipt,tool-projection}.ts`、`storage/migration.ts`);旧 ref 会话按原 ref 恢复,不改写历史行。
- [ ] `plan-domain.ts` 补齐 `plan.enter`(inactive → pending → active)与 `plan.exit`(active → inactive,不经审批);`mutate()` 的 active 幂等快照保持不变(`:77`)。
- [ ] 安全点:mode 转移只在 turn 边界投递(无在飞 model request、无未完成 tool batch);未投递的 pending 可跨重启恢复,不得出现"半 active"。
- [ ] 恢复语义:owner 重启重放后 `active`/`awaiting_approval`/`pending` 与重启前一致;crash 于投递边界不产生伪 exit 事件。
- [ ] TUI:`/plan` 在空闲且可用时提供 `Enter plan mode` / `Exit plan mode`(`tui/interactive/plan-workflow.ts:39`);Footer `mode` 段显示 plan 状态(`tui/components/footer.ts:63`);`PlanRenderView.status` 映射 mode 状态(`tui/adapters/session-resources.ts:336`)。
- [ ] CLI:补 `plan exit`、`plan reenter` 的解析、动作集合与 mutation 登记(`cli/control-commands.ts:85,100`),`expectedRevision` 继续由 `controlCommandQueryOperation` 提供(`:264`)。

测试:

- [ ] `tests/runtime/session-runtime/plan-domain.test.ts`:standard 会话 enter → pending → active;active 期间写型/进程/网络被拒;exit 后恢复原权限;stale revision conflict;重启后状态一致;response-loss 不重复 mutation。
- [ ] `tests/runtime/session-runtime/agent-mode-plan.test.ts`:plan@1 仍自动 active,且 exit 不使其变为可写会话。
- [ ] `tests/security/plan-mode-tool-admission.test.ts`:standard 会话进入后 unknown effect、`bash`、写型 MCP、child 仍 deny;always-approve 不覆盖。
- [ ] `tests/tui/{blocks/plan-update,agent-mode-plan-review}.test.ts`:菜单项、Footer 状态、Esc 无 mutation、不可用时提示。
- [ ] `tests/cli/*`:`plan enter|exit|reenter` 解析、非法参数、`expectedRevision` 注入。

完成门槛:

- mode 状态不来自 prompt 或 TUI 布尔;重启后一致。
- plan@1 行为零回归(既有 41 用例全绿)。
- 迁移仅在隔离数据库验证,不触碰真实用户 home。

建议 commit:`plan: make plan mode a durable in-session lifecycle`

### P2:ContextEngine 注入与压缩后重注入

前置:P1。

目标:mode 指令、当前工件 revision/digest、已批准计划正文按需进入 model-visible context;压缩后仍存在;计划相关内容不被剪枝。

任务:

- [ ] 新增纯函数 fragment builder(`modes/plan/prompt.ts`):按状态产出 mode 指令、工件摘要(revision、digest 前缀、标题、正文是否已内联)、已批准计划正文;文本为 RunLedger 口径,不引用 planning 对话。
- [ ] 在 `session-runtime/domain.ts` 的 `withContextSources`(`:280-300`)注入 plan fragment:layer `session_mode`、trust `trusted`、priority `required`;正文来自 Session-owned authority 并校验 digest,drift 时不注入并留诊断。
- [ ] 去重:同一 revision 的正文已在本轮内联时不重复注入;revision 变化必须重新注入。
- [ ] 压缩后重注入:approved plan 与 mode 片段走既有 `compaction.assemble`,压缩不得使其丢失(`context/compaction/*`)。
- [ ] prune 保护复核:`context/compaction/projection-prune.ts:48` 的保护集覆盖 plan 工具组结果与 approved fragment。
- [ ] mode 片段写入计划质量标准:执行规格而非设计文档、决策完备(实施者无需再做设计选择)、禁止 Non-Goals/Alternatives/Risk 之类免决策章节、必须含可执行的 Verification 与端到端证据、不得引用 planning 对话。

测试:

- [ ] `tests/runtime/context/plan-fragment.test.ts`(纯函数):inactive/pending/active/awaiting/approved 各态输出、digest drift、revision 去重、空计划与大计划。
- [ ] `tests/runtime/session-runtime/plan-context-injection.test.ts`(真实 owner + 本地 HTTP fixture):请求体含 mode 指令与 approved 正文;compact 后仍在;同一 revision 不重复。
- [ ] `tests/runtime/context/compaction/*`:prune 不丢 plan 结果与 approved fragment。

完成门槛:

- 所有 model 请求由 ContextEngine 组装并留 receipt(既有总清单项)。
- 压缩后 mode 仍 active 且权限未放宽。

建议 commit:`plan: inject plan fragments and re-inline after compaction`

### P3:模型侧进入/退出与收敛

前置:P2。

目标:模型可请求进入 plan mode(须用户批准)、可提交计划请求审批;active 下 turn 不以空转结束。

任务:

- [ ] 新增工具 `enter_plan_mode`(agent 发起 → `plan.enter` with `requestedBy: agent` → `pending` + reverse request;用户批准后安全点 `activate`,拒绝则 `cancel_activation` 并返回明确结果)与 `exit_plan_mode`(不接受任何模型提供的 revision/digest/路径,从 state 读并 pin 当前 artifact → `request_approval`)。工具实现在 `session-runtime/plan-tools.ts`,schema 与 claim 同步。
- [ ] 工具判权:`plan_write`/`exit_plan_mode` 仅 `active` 允许;`enter_plan_mode` 仅 `inactive` 允许;`plan_read` 在受限状态下允许。D5 的 plan 工具集合按 composition 注入的对象身份判定。
- [ ] reverse request:复用 `session-runtime/approval-reverse-request.ts` 的可重连 waiter(driver 断连保留,新 driver 显式 claim,observer 响应拒绝);批准前不改变 mode。
- [ ] settle 收敛:active 下 turn 结束且本 turn 既未写 revision 也未请求审批时,注入有上限的 reminder(同 revision 不重复,达到上限停止),提示必须写计划或请求审批;实现为 context 注入,不改变权限。

测试:

- [ ] `tests/runtime/session-runtime/plan-agent-entry.test.ts`:未批准前 mode 不变;批准后下一请求含 fragment 且写型被拒;拒绝返回明确结果;重连后 waiter 仍在。
- [ ] `tests/runtime/session-runtime/plan-settle-convergence.test.ts`:reminder 次数上限、同 revision 不重复、上限后不再注入、写 revision 或请求审批后不再注入。
- [ ] `tests/security/plan-mode-tool-admission.test.ts`:新工具的 claim、mode 外拒绝、模型不能自批。

完成门槛:

- 未批准不得进入;模型不能批准自身计划。
- unknown effect → deny 与 always-approve 不越权不变。

建议 commit:`plan: add model-side plan entry and exit tools`

### P4:审批闭环与 review 界面

前置:P3。

目标:决策集齐全(批准/要求修改/拒绝/取消),反馈进入下一 planning turn;大计划可用;CLI 对称。

任务:

- [ ] `plan-domain.ts` 与 reducer 支持 `changes_requested`(回到 `active`,approval 状态记录,不写正文);拒绝与失效分别落 `plan.approval_rejected` / `plan.approval_invalidated`,不再复用 `plan.failed`。
- [ ] TUI review surface(扩展 `tui/interactive/plan-workflow.ts`,必要时拆 `plan-review-workflow.ts`):滚动 + 按 heading 的目录;动作 `Approve and implement`(keep context)、`Approve and implement after compact`、`Approve as fresh session`、`Request changes`(可附反馈)、`Reject`、`Cancel`、`Export`(P6);固定快照显示 state revision 与 digest 前缀;按现有 OpenTUI modal/selection 组件实现,不新造渲染栈。
- [ ] 反馈通道:决策提交后把反馈文本作为**下一 user turn** 进入 planning,不直接改工件;UI 明确提示。
- [ ] CLI 对称:`plan approve|reject|changes_requested <approval-id> [feedback]`;`plan inspect` 输出 mode 状态、revision、digest、approval 状态,正文分页避免一次打印 128 KiB。
- [ ] pending 审批在 TUI reconnect/resume 后重新出现;driver 断连不等于拒绝,只有显式决策结束 awaiting。

测试:

- [ ] `tests/tui/plan-review-*`:动作矩阵、固定快照绑定、Esc 无 mutation、大计划滚动、空计划、80 列窄终端。
- [ ] `tests/runtime/session-runtime/plan-domain.test.ts`:stale revision 审批 conflict、外部改工件后旧 approval 失效、decision 落盘成功但 UI 断连不重复实施、changes_requested 后状态与反馈通道。
- [ ] `tests/cli/*`:新动作解析与参数校验。

完成门槛:

- 未批准计划无法触发写型实施 turn。
- 审批与决策在 event 中可追溯,revision/digest 绑定可验证。

建议 commit:`plan: complete resumable approval and review surface`

### P5:实施交接与可追溯

前置:P4。

目标:批准后三条路径都能进入实施,且 approved plan 在实施请求中可追溯。

任务:

- [ ] keep context:`settle_exit` → inactive 后提交实施 user turn,注入 approved 正文(`required` fragment,绑定 revision + digest)。
- [ ] compact context:先走既有 manual compaction(`compact.run` 同一 service),再提交实施 turn;压缩不得丢 approved plan。
- [ ] fresh session:实现 `session.create` 的 `planHandoff`(D7):新 standard@3 会话,注入 approved 正文与来源引用,不带未批准的 planning tail;源会话保留完整历史可查。
- [ ] 审计:写 `plan.handoff_created`,含源 sessionId、revision、digest、审批 receipt digest;实施请求的 ContextAssemblyReceipt 含 approved plan digest。
- [ ] 边界复核:批准/退出不改变 profile permission authority;plan@1 仍需新建会话实施。

测试:

- [ ] `tests/runtime/session-runtime/plan-implementation-handoff.test.ts`:三条路径的 event 序列;未批准不产生 handoff;伪造 digest 被拒;fresh session 不继承未批准内容;每次实施请求 receipt 含 plan digest。
- [ ] `tests/runtime/context/*`:compact 后 approved plan 仍在请求中。
- [ ] `tests/runtime/session-runtime/plan-domain.test.ts`:handoff 失败不改变源会话状态。

完成门槛:

- 未批准计划不能触发写型实施。
- handoff 与实施请求均可审计到同一 immutable revision/digest。

建议 commit:`plan: add audited implementation handoff`

### P6:产物可用性与连续性

前置:P5(导出与 reentry 可与 P5 并行,共享文件见 §6)。

目标:计划产物可命名、可导出、可浏览、可再进入更新。

任务:

- [ ] 标题派生:取正文首个一级 heading,缺失时用 session 标题;导出文件名 `<TITLE>_PLAN.md` 风格,超长按词边界截断,非法字符替换为 `_`(`modes/plan/title.ts` 纯函数)。
- [ ] 导出:`plan.export` domain operation,把指定 revision(默认当前或已批准)写入 `<runledgerHome>/plans/<TITLE>_PLAN.md`,用独占创建避免并发覆盖(冲突退避 `<stem>-N`,上限后加时间戳前缀);写入失败不改变 plan 状态,重试幂等;落 `plan.exported`。
- [ ] 浏览:`plan list` 列出会话内 revision 与已批准版本(`PlanArtifactStore.revisions`),可选只读查看历史 revision 正文。
- [ ] reentry:实现 `plan.reenter`(调用 reducer 的 `reactivate`,pin 当前 working revision);mode 片段含 reentry 指引:新请求优先、旧计划仅作参考、同任务增量更新并删除过时章节、不同任务新建会话。
- [ ] 恢复与损坏:重启按 digest 校验重放;工件或 projection 损坏时明确报错,不静默降级、不返回陈旧内容。

测试:

- [ ] 纯函数:`tests/runtime/modes/plan/title.test.ts`(标题派生、Unicode、超长、空标题、无 heading)。
- [ ] `tests/runtime/session-runtime/plan-export.test.ts`:隔离 home 下的路径、并冲突退避、失败不改变状态、重试幂等。
- [ ] `tests/runtime/modes/plan/reducer-store.test.ts`:`reactivate` 与 revision 链、reentry 后继续写。
- [ ] `tests/storage/*`:工件 payload 上限、损坏诊断。

完成门槛:

- 产物可脱离 TUI 使用;导出不产生第二真源。
- reentry 不产生新 goalId,单会话单链可重放。

建议 commit:`plan: add plan artifact export and continuity`

### P7:端到端验证与门禁

前置:P1–P6。

目标:闭合自动、built CLI/TTY、人工与平台证据口径。

任务:

- [ ] 端到端场景(真实 owner + 本地 HTTP fixture):进入 → 探索 → 写 revision → 请求审批 → 要求修改 → 再写 → 批准 → keep / compact / fresh 三路径实施 → 重启恢复 → 压缩后重注入 → 导出。
- [ ] built CLI/TTY:隔离 `RUNLEDGER_DIR` + tmux,覆盖 Footer 状态、审批动作、导出、Ctrl+D 退出码 0、无残留进程。
- [ ] 负路径:拒绝、取消、stale revision、digest drift、driver 断连重连、owner takeover、response-loss 重试。
- [ ] 文档:更新 `development-doc/00-index.md` 模块行、01 的接口注记、`docs/` 操作手册与 `tui/components/tips.txt`。
- [ ] 验收口径:人工键盘/中文 IME/鼠标、macOS/Windows runner 保持 pending,不因自动化通过而关闭。

测试:

- [ ] `tests/integration/plan-mode-end-to-end.test.ts`(新增,integration bucket)。
- [ ] 既有 Plan Mode 11 文件回归全绿:`tests/runtime/modes/plan/{policy,reducer-store}.test.ts`、`tests/runtime/session-runtime/{plan-domain,agent-mode-plan}.test.ts`、`tests/security/plan-mode-tool-admission.test.ts`、`tests/tui/agent-mode-plan-review.test.ts`、`tests/tui/blocks/plan-update.test.ts`、`tests/tui/opentui-plan-update.bun.test.ts`、`tests/runtime/tools/plan-memory-tools.test.ts`、`tests/runtime-contracts/plan-context-memory/*.test.ts`。

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
| `src/runtime/harness-profiles/*`、`src/storage/migration.ts` | P0/P1 | 与 Runtime 09/10 叠加;迁移必须在隔离库验证 |
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
| 工件 | 空/大正文、并发 revision、stale revision、digest drift、255 revision 上限、损坏诊断 |
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
| `standard@3` 迁移失败 | 会话无法恢复 | offline 迁移 + 事务内复验 + 旧 ref 保留;迁移只在隔离库验证 |
| 动态只读边界表达错误 | 写型工具在 plan mode 泄漏 | authorization 层 deny + ExecutionEnv 只读 + 红队用例(§8 授权行) |
| mode fragment 未注入或丢失 | 模型绕过只读约定 | fragment 为 required + receipt 校验 + HTTP fixture 断言请求体 |
| 计划正文事件膨胀 | 单会话事件量增大 | 保留 65536 字符 / 255 revision 硬上限;超阈值再加显式迁移入口 |
| settle reminder 热循环 | 空转与成本上升 | 次数上限 + 同 revision 去重 + 达到上限停止 |
| handoff 泄漏未批准内容 | 实施偏离审批 | fresh session 只带 approved 正文与来源引用,mutation 断言不外泄 |
| reentry 语义漂移 | 旧计划覆盖新请求 | 单链 + reentry 指引 + reducer 不变量测试 |
| 双真源(导出文件被当作 authority) | 审计不一致 | 导出为投影;canonical 状态仍在 Session event |
| 回滚 | 实施中发现问题 | 关闭 mode 入口后保留事件与工件,projection 忽略新 command;awaiting 审批保持 pending,只能显式 cancel |

## 10. 总验收清单

- [ ] Plan Mode 是 durable session state,不由 prompt 或 TUI 布尔值推断。
- [ ] standard 会话可进入/退出 plan mode;plan@1 保持自动 active 与不可解除只读。
- [ ] plan mode 的 deny 覆盖 always-approve、`bash`、写型 MCP、child 与未知效果。
- [ ] 审批绑定 immutable revision + digest + approvalId;任一变化使审批失效。
- [ ] 模型不能批准自身计划;模型不能提供任意路径或 revision。
- [ ] mode 指令、工件摘要与 approved 正文经 ContextEngine 注入,压缩后重新注入并留 receipt。
- [ ] 未批准计划无法触发写型实施 turn。
- [ ] keep / compact / fresh 三条实施路径都有 event 证据与 approved digest 追溯。
- [ ] 计划产物可导出到 canonical home,且导出不是第二真源。
- [ ] 重启、reconnect、takeover、response-loss 均不产生重复 mutation 或丢失状态。
- [ ] `npm run check`、`npm test`、`npm run build` 完整通过。
- [ ] built CLI/TTY 在隔离 `RUNLEDGER_DIR` 通过并保留帧与退出码证据。
- [ ] 人工键盘/中文 IME、macOS/Windows runner 的 pending 状态如实记录。
- [ ] 本文件记录各阶段 commit、命令与结果;01 与 Runtime 04 不复制本表状态。

## 11. 与其他专题的接口

| 专题 | 接口 |
|---|---|
| Runtime 04 | 消费公共类型/schema/event catalog;增量需求在 §7 声明,由契约 PR 落地 |
| Runtime 06 | mode mutation 走 owner fence、driver admission、attempt receipt、恢复路径 |
| Runtime 09/10 | profile 集合新增 `standard@3`,frozen ref 与 receipt 期望摘要同步;plan@1 语义不变 |
| Runtime 08 | child 边界不变;plan mode 不放开委派 |
| 权限专题 | Plan Mode 只读 ceiling 与权限预设正交;`request_permissions` 不能放宽 mode deny |
| Compact 专题 | 压缩 service 与 checkpoint 不变;plan 只提供 required fragment 与剪枝保护 |
| TUI 专题 | review surface 用现有 modal/selection/滚动组件;状态来自 domain projection |
| Storage/CLI | 导出路径在 canonical home 子树;不新增 sessionDir authority |
