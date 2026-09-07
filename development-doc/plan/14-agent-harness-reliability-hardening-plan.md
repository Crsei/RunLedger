# Agent Harness 既有执行闭环加固计划

> 日期：2026-09-07。状态：**planned，尚未实施**。
>
> 范围：不增加产品功能面，修复现有响应执行边界、输出裁剪、上下文选择和重复失败判断，复验中断与恢复。
>
> 审查基线：RunLedger `86f52c0` / `rollback/before-composer-shape`，含并发未提交改动；oh-my-pi `6d3bc569d1`，工作树干净。HEAD 不完整代表 dirty 快照，实施前必须重新核对。
>
> 落文复核：并发任务将 HEAD 推进到 `953f8e1`；本计划涉及的 agent-loop、context、domain composition 与 runtime controller 相对审查基线无差异。该安全修复不属于本文提交，后续 H0 仍须核对最新状态。
>
> 已有证据仅为源码审查与四组离线探针；未实施产品修复、运行完整测试、构建或真实 provider 故障注入。本文不构成任何阶段 implemented 的证据。

## 1. 目标与权威边界

目标是在现有工具、模型、模式及权限下，减少误执行、工作上下文丢失与无效重试，提高完整收尾和错误说明的可信度。本文件只编排修复、生产接线核查和联合验收，不替代领域 authority。

| 领域 | 权威入口 | 约束 |
|---|---|---|
| 工程行动 | [AGENTS.md](../../AGENTS.md) | 共享树保护、验证、提交与 sandbox 冻结 |
| 公共 DTO/schema/event | [Runtime 04](../runtime/04-governed-agent-harness-runtime-plan.md) | 复用 current contract，不另建同义状态或旁路事件 |
| 生产与恢复 | [Runtime 06](../runtime/06-session-owner-runtime-replacement-plan.md) | Session Owner + SQLite + owner generation/fence；不代为关闭 R8/R9 |
| 已有可靠性修复 | [Plan 03](03-session-execution-reliability-repair-plan.md) §1.2 | 复用审批期限、取消信号、interrupt 与终态修复，不按旧事故重复开发 |
| Context/Compaction | [Context 主计划](../plan-compact-memory/01-implementation-plan.md) | 只改模型请求投影，不改 raw ledger/history；真实 compaction 交付归原专项 |
| Profile/Mode | [Runtime 09](../runtime/09-minimal-harness-profile-implementation-plan.md)、[Runtime 10](../runtime/10-agent-mode-entry-implementation-plan.md) | 创建时冻结、fork 继承；不原地修改冻结 prompt 或工具 manifest |
| 产品内委派 | [Runtime 08](../runtime/08-bounded-multi-agent-system-plan.md) | 默认关闭、root-owned sequential readonly、depth=1、同 root 最多一个 child |
| Recording/Artifact | [Trace](../runtime/trace/README.md) | 用户级 settings 授权；Artifact 接口存在不等于模型可读取 |

**非目标：**新增工具/provider/MCP/Memory/自动 summarizer/后台服务、产品内并行或递归 Agent、扩大权限、任何 OS sandbox 开发、包结构重构、删除 legacy Host、新建评测平台或远程 exporter。不要通过放大轮次、关闭治理、堆系统提示词掩盖失败。

## 2. 代码存在与生产接线矩阵

### 2.1 标准链路

```text
bin/runledger.js -> Bun dist/cli/cli.js -> CLI main
  -> createEmbeddedSessionRuntime -> Session Owner
  -> authenticated loopback command/query/subscription
  -> assembleSessionDomain -> runtime InteractiveSessionController
  -> Agent -> runAgentLoop -> governed tools
  -> Session events / SQLite / subscription -> TUI projection
```

来源：[launcher](../../bin/runledger.js)、[embedded runtime](../../src/cli/embedded-session-runtime.ts)、[domain](../../src/runtime/session-runtime/domain.ts)、[runtime controller](../../src/runtime/interactive-session-controller.ts)、[client adapter](../../src/cli/session-interactive-controller.ts)、[Agent](../../src/runtime/agent.ts)。客户端 adapter 与 runtime controller 不是同一 authority；TUI 不直接驱动内部 Agent 或写 SQLite。

“接线存在”仅指生产 composition 静态可达，不等于本次构建后 CLI 或真实 provider 已验证。

| 能力 | 代码存在 | 标准 Session Owner 接线 | 本计划处置 |
|---|---|---|---|
| 失败响应处理 | [loop-runner](../../src/runtime/agent-loop/loop-runner.ts) 对 length 合成结果 | controller → Agent → loop 已接入；error/aborted 在执行分支后退出 | H1 修执行前置条件 |
| 有界工具输出 | [applyToolResultBudget](../../src/runtime/agent-loop/tool-call-finalization.ts) 已在 execute 后调用 | 通用 inline 裁剪已接入 | H2 修全部文本块处理 |
| overflow 存储/读取 | [overflow adapter](../../src/runtime/trace/tool-result-overflow.ts) 和 controller 参数存在 | domain 未注入 `toolResultOverflowStore`；模型受治理读取闭环未证实 | 不自动上线新读取能力；分别验证有/无 store |
| 请求上下文选择 | [model-request-adapter](../../src/runtime/context/model-request-adapter.ts) / ContextEngine 存在 | domain 注入 `modelContextAssembler`，loop 每次请求调用 | H3 修此生产投影边界 |
| Context receipt | assembler 返回 receipt，loop 可调 `contextAssemblySink` | domain 未注入 sink；不能宣称 receipt 已持久化或等于最终 wire payload | 测试捕获投影与请求；durable sink 留原专项 |
| 安全 compaction cut/checkpoint | [cut planner](../../src/runtime/context/compaction/cut-planner.ts)、内存 store、legacy Host 实现存在 | domain 未装配完整 summarizer/compact operation 链路；Session replay checkpoint 是另一用途 | 复用纯配对 invariant，不新增 compact 接线 |
| 重复失败预算 | [run-budget](../../src/runtime/agent-loop/run-budget.ts) 存在 | controller 注入预算，loop 统计并终止 | H4 修分类与批次计数 |
| 中断/steering/recovery | 队列、interrupt、审批撤销、恢复 barrier 存在 | 已有 production 路径与 Plan 03 修复记录 | H5 先回归，仅修当前 RED 问题 |

### 2.2 已有审查证据

- **E1，loop 缺陷已离线复现：** error 响应携带合法 toolCall 时，内存工具执行计数为 1。loop 仅 length 阻止执行；[OpenAI completions adapter](../../src/api/openai-completions.ts) 的 catch 保留流式 content 并发送 error，存在实际传播路径。未真实 provider 故障注入，不称为权限绕过。
- **E2，投影缺陷已离线复现：** user + 长 assistant(toolCall) + toolResult 在窄预算下只剩 user/toolResult。history 按单消息选择且仅末条 required；[runtime-adapter](../../src/runtime/context/runtime-adapter.ts) 固定 order=0，[ContextEngine](../../src/runtime/context/context-engine.ts) 同优先级按字符串 ID 选择，不能保证最近优先。当前 [transform-messages](../../src/api/transform-messages.ts) 把孤儿结果降为低权限 user 文本，因此不直接断言 provider 400；确认损失调用参数和配对语义。
- **E3，输出丢失已离线复现：** maxChars=5，文本块 `ABCDEFGHIJ` 与 `FINAL_TEST_FAILURE`；inline 只留 `ABCDE`，fake store 只收到 `FGHIJ`，第二块完全丢失。
- **E4，失败指纹已离线复现：** 不同错误文本、同 bash/exitCode=1 得到 count=2；两结果或无白名单 details 得到 count=0，分别存在误停和漏计。

这些是审查会话的内存探针，不是已提交回归文件。实施时必须重建 RED 用例并保留输入、输出与执行命令。

## 3. 实施不可突破的边界

1. 原始会话、attempt intent/result 和已发生副作用不改写。synthetic result 只说明本次未执行，不能将已执行或 uncertain attempt 改判为未执行。
2. 工具副作用继续经 Security/ExecutionGateway、Attempt Gateway 和 owner fence，保持 fail closed；不用 raw I/O、AllowAll、TUI 本地状态或 legacy Host fallback 接通测试。
3. 优先修私有算法。确需公共 DTO/schema/event 变化时，先在 Runtime 04 单独冻结合同与兼容/迁移、consumer 验证，再实施依赖行为；不顺带扩展公共 contract。
4. 保留当前 `terminationReason` 与 `stopReason` 兼容映射。重复失败映射 length 已有明确未完成摘要，不为文案重新设计终态协议。
5. 不改变 minimal@1、minimal@2、standard@1、plan@1 的冻结 prompt、工具集合、扩展/background/child 开关。若触及版本化模型可见合同，按 Runtime 09/10 规则处理，不能篡改历史 profile。
6. public workspace DTO 仅 digest/locator；native path 保持 runtime 私有。错误指纹只用规范化摘要，不记录敏感参数原文。
7. canonical home 由 composition root 解析并注入；测试只用新建绝对路径 `RUNLEDGER_DIR`，不操作真实用户 Session、复制真实凭据或恢复项目 `.runledger` authority。
8. 不因输出修复强制开启 recording/events_and_artifacts；off/events 下仍提供真实、有界且不虚构可读取性的反馈。
9. 遵守 TypeScript strict、type-only import、相对 `.ts` import、可擦除语法与平台 adapter 约定；工具失败返回既有错误结果，不向调用方抛出。

## 4. 执行阶段

| 阶段 | 交付物 | 依赖 | 当前状态 |
|---|---|---|---|
| H0 | 实施快照、生产接线清单、RED fixtures | 无 | planned |
| H1 | 失败响应不执行工具，结果/终态完整 | H0 | planned |
| H2 | 输出裁剪处理全部文本块 | H1 | planned |
| H3 | 最近工作上下文与调用配对保真 | H2 | planned |
| H4 | 重复失败分类、计数与终止准确 | H1、H2；在 H3 后整合 | planned |
| H5 | 中断、steering、恢复一致性回归 | H1–H4 | planned |
| H6 | Built CLI 与开发结果联合验收 | H1–H5 | planned |

默认串行整合，每阶段形成可独立审阅的提交。开发助手委派不改变产品内 sequential child 边界。

### H0：固定实施基线

- 检查 HEAD/分支/index/dirty diff、实际 executable 与 dist 来源，记录受影响文件摘要。
- 主树仍 dirty 时建 sibling worktree，从 committed HEAD 开始，不自动复制或提交其他任务补丁。若依赖 dirty 修改，记录具体路径、行为及集成顺序，等待其形成可追踪提交；不降低断言绕过依赖。
- 重建 E1–E4；已被并发任务修复的项记录解决提交与回归结果，不重复实现。
- 审阅 Plan 03 §1.2 与现有中断测试；区分已修复、当前回归和未测竞态。旧六例使用旧 dist，不能证明当前源码仍失败。
- **退出：**每项有复现输入/预期/实际/快照，每个接口有生产 producer/consumer 或明确未接线标记。

### H1：由模型终态约束工具执行

**文件边界：** `src/runtime/agent-loop/{loop-runner,assistant-recovery}.ts` 与 provider 事件测试夹具；不新增重试策略。

- 工具 admission/prepare 之前判断终态：error、aborted、length 只形成明确未执行结果，不执行工具。
- 冻结已有成功 toolUse/stop 携带完整调用的兼容规则，不因只接受 toolUse 破坏合法 stop 响应。
- 工具已经执行后发生的取消仍走既有 attempt settlement/uncertain recovery，不能套用未执行合成结果。
- 保持 toolCallId 配对、message/turn/agent 终态唯一；合成事件不能制造 execution success 或已执行 receipt。

**验收：**完整参数后 stream error、部分参数 error、provider aborted 但外部 signal 未取消、length 均 execute=0；toolUse/兼容 stop 执行一次；已开始副作用后取消不重复执行。先内存计数，再本地 HTTP 断流经真实 adapter/Session Owner 验证文件未创建、事件和 receipt 一致。

### H2：有界输出保留有效反馈

**文件边界：** `tool-call-finalization.ts`、`tool-call-execution.ts` 与既有 overflow port 测试。标准 domain 无 store 是必须支持的生产基线。

- 按全部文本序列裁剪，不能忽略首个溢出块之后的文本；保持顺序、图像语义和多字节字符完整。
- 无 store 时采用确定性的有界首尾保留，明确省略范围/数量；不承诺保留全部诊断，但末块不能被静默遗弃。
- 有 store 的既有调用方保存全部省略文本，验证顺序、digest/size 和重建；store 失败退回准确截断说明，不虚构写入成功。
- 截断标记纳入明确输出上限；保留 isError/退出状态，不把日志中的“测试通过”当 authority。post-tool hook 的最终结果同样要验证有界性，避免后处理重新放大输出。
- 不新增标准 Session 的 artifact 工具或 operation。只有现有工具确实能够受治理读取时才给可操作的读取提示；否则明确已截断。全量检索接线缺口保留，不冒充本阶段已完成。

**验收：**单/多块、末块失败摘要、中文/emoji、图片混排、空块、零剩余预算、store throw、hook 改写。inline 有界，后续文本保留或显式计入省略；有 store 时能重建原始文本。分别记录 off/events 的生产无 store 与 fake store 的纯接口结果。

### H3：请求上下文按完整工作单元选择

**文件边界：** `src/runtime/context/{model-request-adapter,runtime-adapter,context-engine}.ts` 必要私有逻辑；入口仍是 domain 注入的 assembler。

- 用数值序列与显式最近优先策略选择历史，最终请求按原时间顺序排列，不依赖字符串 ID 排序。
- 调用及结果按完整依赖组原子选择，复用 complete-tool-batch invariant；不得把纯 cut planner 存在当作生产接线完成。
- 保留本次用户目标、最近纠正及相关调用/结果。required 本身放不下时返回明确预算错误，不静默删约束或发送孤儿消息；不完整的恢复历史沿现有错误投影处理，不伪造执行成功。
- 扩展 sources 的 trust/taint/required 与 protected policy 不因最近优先而降级。预算核对实际工具 schema、system、输出 reserve 和 provider 转换后的消息，不假定固定 reserve 能覆盖任意工具表。
- receipt 反映实际选择、省略与投影 digest；raw ledger 不改。assembler 与 provider wire 是两个边界：允许必要的 ID/签名转换，但测试须核对语义、配对和容量，不要求字节相同。
- 不新增 durable receipt sink、summarizer 或自动 compact；组信息如需公共合同变化，先完成 §3 合同前置步骤。

**验收：**12 条以上历史、多调用、超大末结果、最新用户反向纠正、跨模型转换、required 超限及扩展 policy。捕获 assembler 和本地 HTTP 实际请求，断言近期任务保留、配对完整、顺序稳定、预算失败关闭；重启重建不改 raw history。

### H4：按请求与错误事实识别重复失败

**文件边界：** `run-budget.ts`、工具 preparation/execution 既有错误分类、loop 私有计数状态。

- 组合工具名、规范化请求摘要、稳定错误分类；同 exitCode=1 不合并不同命令，时间戳/call ID 等无关变化不算进展。
- 按调用处理批次，不因 results.length != 1 清空所有统计；schema、unknown tool、执行失败均有可解释分类。
- 冻结成功、请求变化、错误变化对计数的影响；相同请求同失败收敛，实际修正或结果变化不误停，状态有界且不保存敏感原文。
- 审批过期维持独立计数/human wait；不吞用户拒绝、不自动重新审批、不重放 uncertain 副作用。
- 反馈针对当前工具给修正方向；保持已有预算值、terminationReason 与任务未完成摘要，不新增 guard 设置。

**验收：**不同命令同 exit1 不误停；同请求同错误达阈值停止；多结果、无 details、schema/unknown tool 不漏计；成功和变化遵循冻结规则；审批过期独立结算，终态/恢复一致。

### H5：现有中断与恢复的交付边界

**文件边界：**先测 Agent/loop 队列、Session interrupt/recovery 与客户端投影；仅 RED 证明当前缺陷时修改对应路径，不重复 Plan 03。

- 测 steering 接受后、dequeue 前后、请求前和批次末尾的取消竞态，区分接受、写历史、交付模型、收到响应。
- 避免已取消 run 消费队列；已写历史但未交付的输入核对现有继续逻辑。不得隐式增加跨重启队列合同作为本阶段功能。
- 审批取消后不得启动进程；运行中工具 stop→wait→settle 后再接受下一次请求。迟到响应、owner fence 丢失和 observer interrupt 沿既有治理收尾。
- 恢复保留磁盘事实与 unresolved attempt；不自动将 assess 当 accept，不删除 barrier 强行继续。

**验收：**TCP/Session Owner/TUI 连续路径无输入静默丢失、无重复执行、终态唯一、waiter/owned process 回收；同 Session 恢复正确显示 Outcome unknown。没有复现缺陷的项目记 regression verified，不能称新增修复。

### H6：生产链路与开发结果验收

- 先用本地 HTTP fixture 经本次构建 CLI → Session Owner → 治理工具 → 事件 → TUI 覆盖 H1–H5，helper PASS 不代替此层。
- 复用 [Harness repair 回归](../../tests/manual/harness-repair/README.md) 和 [六类开发案例](../../tests/manual/development-cases/README.md)，不新增平台。旧脚本模型准入断言按 [Context 主计划 §0.3](../plan-compact-memory/01-implementation-plan.md) 的现行目录路由复核，不能恢复旧 manifest gate。
- 六例独立核验生成物，同时记录正常退出、终止原因、失败类型、active 时间和人工等待；自带测试通过不等于任务正确。
- fresh before/after 固定模型/provider/thinking、profile、权限、工具链、提示和数据，记录源码/dist digest。旧 2026-09-06 六例含旧 dist/人工干预，只作事故输入，不直接算收益。
- 真实外部 provider 的模型、Token/费用、样本次数和干预单列；不复制真实凭据到测试 home。未执行该层时保留 pending，不将本地 fixture 宣称为模型能力提升。

## 5. 验证命令与证据记录

本次仅文档：审阅差异、本地链接/规则一致性、`git diff --check`；不运行代码测试/build，也不启动 H0–H6。

后续代码阶段按当前 package.json 运行：

优先复用以下测试入口，只有缺少对应行为覆盖时新增文件；H0 须核对其 tracked/dirty 状态，不能收走其他任务正在编写的用例。

| 阶段 | 现有测试入口（相对仓库根） |
|---|---|
| H1/H4 | `tests/agent-loop.test.ts`、`tests/runtime/session-runtime/run-budget.test.ts`；补真实 adapter 断流夹具 |
| H2 | `tests/runtime/agent-loop-overflow.test.ts`；增加生产无 store 的 integration 覆盖 |
| H3 | `tests/runtime/context/context-engine.test.ts`、`tests/runtime/context/compaction-cut-planner.test.ts`、`tests/api/model-switch-history.test.ts`；补实际 model-request assembler 及 HTTP 请求断言 |
| H5 | `tests/cli/session-steering.test.ts`、`tests/runtime/session-runtime/process-composition.test.ts`、`tests/tui/approval-reverse.test.ts`；复用 Harness repair TTY fixture |
| H6 | `tests/manual/harness-repair/`、`tests/manual/development-cases/`；分别记录确定性链路与真实模型结果 |

```bash
npm run check
npm run test:local -- --file tests/agent-loop.test.ts
# 按实际改动补充受影响文件；提交代码前完成全量门禁。
npm test
npm run build
command -v runledger
readlink -f "$(command -v runledger)"
npm ls -g --depth=0
git diff --check
```

完整保存 check/test/build 输出与最终 exit；不以截断片段或排除失败文件后的运行代替全量通过。同状态已通过的检查不重复；新增修改、失败或未解决疑点才扩验。新增测试按现有 inventory/bucket 归属，不绕过 runner。

真实 CLI 使用新建绝对路径隔离 home，核对 launcher 加载本次 dist；链接错误时按当前布局修复，不能套用未落在本 checkout 的 workspace 路径。独立 tmux/PTY 中 Esc 关闭弹窗、Ctrl+D 退出，记录 launcher/child exit 和残留 PID，只清理本任务资源。

每阶段在本文及对应领域原地回写：commit/dirty 摘要、路径、复现输入、命令/exit、证据位置、生产链路是否到达、未闭合门禁。不另建重复状态文档。证据脱敏；Trace 不等于远程 exporter，receipt 不等于完整 prompt 或独立验证。

## 6. 完成标准与提交

| 层级 | 门禁 | 当前状态 |
|---|---|---|
| 算法/loop | E1–E4 RED→GREEN，故障路径覆盖 | pending |
| Session Owner | 标准 domain 实际调用，治理/fence 不变 | pending |
| Built CLI/Linux TTY | 本次 dist、隔离 home、本地 HTTP、退出/回收齐全 | pending |
| 开发结果 | 六例独立验收，终态与功能结果分开记录 | pending |
| 真实 provider | 当前模型实跑/故障注入证据 | pending |
| 人工/平台 | 视觉、键盘/中文 IME、macOS/Windows 分别验证 | pending |

核心修复完成须 H1–H5、对应 check/test/build、确定性 Session Owner/built-CLI 验证通过；H6 剩余层逐项保留状态。只有对应证据齐全才能声称效果提升、live verified 或跨平台 accepted。不得用本计划自动化关闭 Runtime 06 R8/R9。

阶段提交只暂存本任务显式路径，核对身份/分支/完整 staged diff/check，保护并发改动。失败先修本任务问题；无关基线失败记录证据与影响，不绕 hook、删测试或改无关实现促成提交。只有用户明确要求才推送。

## 7. oh-my-pi 借鉴与延后项

下列路径相对本地 oh-my-pi `6d3bc569d1`，仅为机制参考，不是 RunLedger 完成证据，也不要求移植其 API：

| 参考路径 | 原则 | 本计划边界 |
|---|---|---|
| `packages/agent/src/agent-loop.ts` runnable/synthetic result | 失败调用未执行、截断提示拆小载荷 | H1/H4；不新增自动 retry |
| `packages/coding-agent/src/session/turn-recovery.ts` | 重放要有未执行证据，不确定则拒绝 | H1 安全边界；新增 retry 编排不在范围 |
| `packages/agent/src/compaction/compaction.ts` | 最近历史、调用配对、工作事实保真 | H3；不移植 summarizer |
| `packages/coding-agent/src/session/session-maintenance.ts` | 压缩后重算 fit/headroom，无进展不循环 | 延后到 Context 专项真实 compaction 接线 |
| `packages/agent/src/agent-loop.ts` steering/abort | 取消不吞未交付输入 | H5；不新增 aside/并行队列 |
| `packages/ai/src/utils/tool-call-loop-guard.ts` | 重复调用纠偏；同参不等于无进展 | H4 不照搬仅参数计数器 |

标准 Session 完整 compaction/summarizer、durable context receipt、模型 Artifact 全量检索、Memory 与其他新功能保持延后，回归原 Context/Trace/Runtime 专项。本计划完成不改变其 production unavailable/partial 状态。
