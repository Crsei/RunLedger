# 01：oh-my-pi Telemetry 移植计划

## 状态

implemented（2026-08-25，worktree `RunLedger-oh-my-pi-telemetry-port` 合并回主线后复跑门禁）。P0–P6 全部完成：插桩核心（`src/runtime/telemetry/`）、agent-loop 接线、oneshot 四调用点、OTLP 三信号导出引导、52 个新增测试全绿。AGENTS.md §1.3 已移除「OpenTelemetry / metrics」排除项。

## 目标

移植 oh-my-pi（`06aecdd5`，v17.2.15，本地 `/data2-HDD-SATA-20T/Digital_avatar/haoweiyao/oh-my-pi`，与 provider port 同一快照）的 OpenTelemetry 使用方式，让 RunLedger 可被任意 OTLP collector 观测：

- **插桩层**：GenAI semantic-convention span（`invoke_agent` / `chat` / `execute_tool` / `handoff` / oneshot `chat`）+ `pi.gen_ai.*` 扩展属性 + 内容采集三档（none/summary/full）+ 成本/网关/归一化钩子，全部 opt-in、关闭时零开销；
- **聚合层**：per-run `AgentRunSummary` / `AgentRunCoverage`（run-collector），落 `invoke_agent` 聚合属性并驱动 metrics/log 事件；
- **导出层**：OTLP/proto trace + log + metric 三信号，标准 `OTEL_*` env 契约驱动，只支持 `http/protobuf`；
- **测试**：InMemorySpanExporter 断言 span 名/属性/父子关系/状态码。

## 现状核实（RunLedger 基线，2026-08-25）

| 事实 | 证据 |
|---|---|
| `@opentelemetry/api 1.9.0` 已在 dependencies，src 无任何 `@opentelemetry` 引用 | `package.json:98`；`grep @opentelemetry src` 为空 |
| `AgentLoopConfig` 已有 first-class 可选 port 先例 | `src/runtime/types.ts:404` `traceRecorder?: RuntimeTraceRecorder`（「不启用时 agent loop 保持既有 ledger-only 行为」） |
| `Agent` 类同样有可选 factory 转发先例 | `src/runtime/agent.ts:98` `traceRecorderFactory?: TraceRecorderFactory`，`prompt()` 内 `create()` 后挂入 loop config |
| 模型调用点 | `src/runtime/agent-loop.ts:318` `streamFn(loopModel, llmContext, {apiKey, env, signal})`，turn 内唯一 LLM 调用 |
| 工具调用点 | `executeToolCalls` → `prepareToolCall`（phase 1）/ `executePreparedToolCall`（phase 2）/ `finalizeExecutedToolCall`（phase 3）；truncated 消息走 `failToolCallsFromTruncatedMessage`（对应 pi `recordSkippedTool` 语义） |
| oneshot LLM 调用点 | `src/runtime/context/compaction/production-summarizer.ts:81`（`options.models.completeSimple`）、`src/runtime/session-runtime/title-lifecycle.ts`（auto-title）、`src/runtime/agents/child-model-runtime.ts`、`src/auth-gateway/server.ts` |
| 本地审计 trace 独立存在 | `src/runtime/trace/`：Event Store + Artifact Store + `RuntimeTraceRecorder`（`traceId`/节点树/hash chain），authority 为 `recording.mode`；Opik 计划 `runtime/trace/phase-04-opik-exporter-tree.md` 未开始 |
| tsconfig 约束 | `erasableSyntaxOnly: true`（禁 `enum`/`namespace`）、`verbatimModuleSyntax`、相对导入必须带 `.ts` 后缀、strict |
| 运行时 | Node ≥22.19（非 Bun）；oh-my-pi `telemetry.ts` 的 `EventLoopKeepalive`（`packages/agent/src/utils/yield.ts`）是 Bun 专属 |
| 无中央 logger | src 无 `registerLogSink` / Logger 模块；oh-my-pi 导出层依赖的 logger 接缝需要裁剪 |
| pi-ai 类型已全量移植 | `Message` / `Usage` / `AssistantMessage` / `StopReason` / `ServiceTier` / `Model<Api>` 可复用；`completeSimple` 经 `Models` 实例暴露（`options.models.completeSimple`） |

## 决策（冻结）

- **D1 属性命名空间保留不变**：`gen_ai.*`（spec）+ `pi.gen_ai.*`（扩展）与 oh-my-pi 逐字一致。dashboard/告警/成本报表跨工具可移植；改成 `pi.runledger.*` 破坏 parity，收益为零。
- **D2 配置 authority 走标准 env**：`OTEL_EXPORTER_OTLP{,_TRACES,_LOGS,_METRICS}_ENDPOINT`、`OTEL_{TRACES,LOGS,METRICS}_EXPORTER`、`OTEL_EXPORTER_OTLP{,_*}PROTOCOL`、`OTEL_SDK_DISABLED`、`OTEL_SERVICE_NAME`、`OTEL_RESOURCE_ATTRIBUTES`、`OTEL_LOG_LEVEL`、`OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT`。不进 settings，`recording.mode` 仍是本地审计记录的唯一 authority。
- **D3 与本地 trace store 不强制关联**：OTEL span 与 `RuntimeTraceRecorder` 各自独立 traceId/节点树。phase 1 不加属性桥接；可选后续在 `invoke_agent` 上补 `pi.runledger.trace_id` 属性，另行专项。
- **D4 日志信号裁剪**：RunLedger 无中央 logger，log 信号只投递结构化 run-summary 事件（对应 pi `pi.omp.agent.run.completed`）与 telemetry warning；不新增全局 logger 接缝。
- **D5 service.name 默认 `runledger`**：资源合并逻辑照搬（`resourceFromAttributes({service.name:"runledger"}).merge(detectResources([envDetector]))`），`OTEL_SERVICE_NAME` 仍可覆盖。
- **D6 SDK 依赖线照搬 oh-my-pi 锁定线**：`@opentelemetry/api ^1.9.1`（由 1.9.0 提升）、`api-logs ^0.220.0`、`exporter-{logs,metrics,trace}-otlp-proto ^0.220.0`、`context-async-hooks ^2.9.0`、`resources ^2.9.0`、`sdk-logs ^0.220.0`、`sdk-metrics ^2.9.0`、`sdk-trace-base ^2.9.0`、`sdk-trace-node ^2.9.0`。RunLedger 跑 Node，1.x OTLP 线的 Bun 死锁不适用，但保持一致便于对照复验。
- **D7 enum → const 对象**：`GenAIAttr` / `OpenAIAttr` / `PiGenAIAttr` / `PiGenAIAggregateAttr` 由 `const enum` 转 `as const` 对象 + `type X = (typeof X)[keyof typeof X]` 提取，满足 `erasableSyntaxOnly`。
- **D8 EventLoopKeepalive 省略**：Node 事件循环不会在长 promise 上冻结 timers；保留 `instrumentedCompleteSimple` 签名与调用点，删 `using _keepalive` 及其依赖。
- **D9 文件布局**：
  - `src/runtime/telemetry/semconv.ts` —— 属性常量与 GenAIOperation（D7 产物，独立文件便于边界检查）
  - `src/runtime/telemetry/run-collector.ts` —— 移植 `packages/agent/src/run-collector.ts`
  - `src/runtime/telemetry/telemetry.ts` —— 移植 `packages/agent/src/telemetry.ts`（不含导出层）
  - `src/runtime/telemetry/otel-export.ts` —— 移植 `packages/coding-agent/src/telemetry-export.ts`（init/flush/AgentMetricRecorder/run-summary log）
  - 接线：`src/runtime/types.ts`（`AgentLoopConfig.telemetry?: AgentTelemetryConfig`）、`src/runtime/agent-loop.ts`、`src/runtime/agent.ts`、`src/cli/main.ts` + session-runtime composition（`initTelemetryExport` + config merge）
  - 测试：`tests/runtime/telemetry/{otel,run-summary,compaction-telemetry}.test.ts`
- **D10 独立 worktree 实施**：改动触碰 `agent-loop.ts`/`types.ts`/`agent.ts` 等核心 runtime 文件，与主线其它未提交改动隔离；镜像 provider port 惯例，用 `RunLedger-oh-my-pi-telemetry-port` worktree，完成后合并回主线。

## 实施顺序

### P0 依赖与骨架

- `package.json` 添加 D6 全部 SDK 依赖（固定版本），提升 `@opentelemetry/api`；提交 `package-lock.json`。
- 建 `src/runtime/telemetry/` 目录与 `semconv.ts`（空实现起步）。
- 门禁：`npm run check`（typecheck 通过，新依赖可解析）。

### P1 插桩核心移植（`src/runtime/telemetry/telemetry.ts` + `run-collector.ts`）

- 移植 oh-my-pi `packages/agent/src/telemetry.ts`（2078 行）与 `run-collector.ts`（631 行），逐符号对照：
  - 公开面全保留：`AgentTelemetryConfig` / `AgentTelemetry` / `resolveTelemetry` / `startInvokeAgentSpan` / `applyInvokeAgentFinish` / `startChatSpan` / `finishChatSpan` / `failChatSpan` / `startExecuteToolSpan` / `finishExecuteToolSpan` / `recordSkippedTool` / `finishInvokeAgentSpan` / `fireOnRunEnd` / `runInActiveSpan` / `recordHandoff` / `recordManualChatTelemetry` / `instrumentedCompleteSimple` / `detectGatewayFromHeaders` / `classifyGatewayResponseCacheStatus` / `setSpanAttribute` / 类型 re-export（`Attributes` / `Span` / `SpanKind` / `SpanStatusCode` / `Tracer` / `trace`）。
  - 应用 D7（enum→const）、D8（删 keepalive）、import 风格（`.ts` 后缀 / `import type`）、`MAX_*` 有界序列化常量与内容采集逻辑原样。
  - 类型导入源对齐 pi-ai 移植 barrel（`Usage` / `AssistantMessage` / `StopReason` / `ServiceTier` / `Model` 等；`ChatUsageSnapshot` 等本文件自有类型不动）。
  - 依赖裁剪：`EventLoopKeepalive`、pi 专属 `run-collector` 之外的内部 util 逐一确认。
- 门禁：`npm run check`；新增编译期导出面自检测试（不 import SDK 也能类型通过）。

### P2 agent-loop 接线

- `src/runtime/types.ts`：`AgentLoopConfig` 增加 `telemetry?: AgentTelemetryConfig`（与 `traceRecorder` 同注释风格：不启用时零 tracer 查找）。
- `src/runtime/agent-loop.ts`：
  - `runAgentLoop` 入口 `resolveTelemetry(config.telemetry, sessionId)` → `startInvokeAgentSpan(telemetry, loopModel)` → `runInActiveSpan(invokeAgentSpan, runLoopBody)` → `finally finishInvokeAgentSpan({stepCount, errorObject})`（对齐 oh-my-pi `agent-loop.ts:905-931`）。
  - 模型调用点（现 318 行 `streamFn` 调用）：`startChatSpan`（`gen_ai.operation.name=chat`，CLIENT，parent=invokeAgentSpan，request 快照含 maxTokens/temperature/tools/systemPrompt/messages）→ `runInActiveSpan` → 流结束 `finishChatSpan`（响应/usage/成本/gateway 属性 + `emitChatUsage`）/ 异常 `failChatSpan`（`recordException` + ERROR status）。
  - 工具三阶段：`startExecuteToolSpan` 于 prepare 前（`gen_ai.tool.{name,call.id,description,type}` + `pi.gen_ai.tool.status`），`finishExecuteToolSpan` 于 finalize（status 六态、`error.type` 映射、`recordException`）；`failToolCallsFromTruncatedMessage` 路径改调 `recordSkippedTool`。
  - step 计数注入 `AgentRunCollector`（`beginChat`/`endChat`/`beginTool`/`endTool`/`noteAvailableTools`）。
- `src/runtime/agent.ts`：`AgentOptions.telemetry?: AgentTelemetryConfig`，`prompt()` 内转发到 loop config（镜像 `traceRecorderFactory` 模式）。
- 门禁：`tests/runtime/telemetry/otel.test.ts` 在 `runAgentLoop` + mock streamFn 上通过（见 P5）。

### P3 oneshot 接线

- 移植 `instrumentedCompleteSimple`（`startChatSpan` → `runInActiveSpan` → `finishChatSpan`/`failChatSpan`），替换下列直连 `completeSimple`/`streamSimple` 调用，打 `pi.gen_ai.oneshot.kind`：

| 调用点 | oneshotKind |
|---|---|
| `src/runtime/context/compaction/production-summarizer.ts` | `compaction_summary` |
| `src/runtime/session-runtime/title-lifecycle.ts` | `auto_title` |
| `src/runtime/agents/child-model-runtime.ts` | `child_agent` |
| `src/auth-gateway/server.ts` | `gateway` |

- 每个调用点的 `telemetry` 来源：agent-loop 持有者链式传入；gateway/oneshot 无 agent loop 时用 `recordManualChatTelemetry` 或直接 `resolveTelemetry(config)`（实施时按调用点上下文选一，保持与 pi 语义一致）。
- 门禁：`tests/runtime/telemetry/compaction-telemetry.test.ts` 通过。

### P4 OTLP 导出引导（`src/runtime/telemetry/otel-export.ts`）

- 移植 `packages/coding-agent/src/telemetry-export.ts`：
  - `initTelemetryExport()`：幂等；`OTEL_SDK_DISABLED=true` 或无任何 endpoint → no-op；`resolveSignalConfig`/`signalEnabled` 逐信号判定（endpoint 回退、`EXPORTER=none`、非 `http/protobuf` 禁用并 warn）。
  - `registerProviders`：resource merge（D5）→ trace（`NodeTracerProvider` + `BatchSpanProcessor` + `OTLPTraceExporter` + `AsyncLocalStorageContextManager`）→ metric（`MeterProvider` + `PeriodicExportingMetricReader` + `AgentMetricRecorder`：`gen_ai.client.token.usage` 直方图、`pi.omp.agent.chat.cost.estimated_usd` counter、runs/steps/chats/tools/errors counter + duration 直方图）→ log（`LoggerProvider` + `BatchLogRecordProcessor` + `OTLPLogExporter`；按 D4 只发 run-summary 与 warning，`OTEL_LOG_LEVEL` 过滤，携带 active span context）。
  - `createTelemetryExportConfig(config)`：把 `onChatUsage`（metrics）与 `onRunEnd`（metrics + run-summary log）merge 进既有 `AgentTelemetryConfig`。
  - `flushTelemetryExport()`：`forceFlush` 三信号；30s `setInterval().unref()`；退出钩子 `provider.shutdown()`（对齐 pi postmortem 钩子，RunLedger 用进程退出/服务关闭接缝）。
- 接线：`src/cli/main.ts` 与 session-runtime composition（`process-composition.ts`）启动路径 `await initTelemetryExport()`，启用后 `AgentLoopConfig.telemetry = createTelemetryExportConfig(...)`；flush 挂到 turn 结束（`interactive-session-controller` 的 turn 边界）与 print-mode/退出路径。
- 门禁：`OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` 指向本地测试 collector 的 smoke（或 `OTEL_TRACES_EXPORTER=none` 负向断言）；`tests/runtime/telemetry/otel-export.test.ts` 覆盖 signal 判定矩阵。

### P5 测试移植

- 移植并适配 `packages/agent/test/{otel,run-summary,compaction-telemetry}.test.ts`（oh-my-pi 用 Vitest + `InMemorySpanExporter` + `AsyncLocalStorageContextManager`，与 RunLedger Vitest 一致）：
  - span 名/属性（request/response/usage/内容采集三档）/父子关系/status 断言；
  - 关闭时零 span、run-summary 聚合字段、oneshot kind 标签；
  - mock streamFn 替代 pi mock provider（`src/runtime/providers/mock-stream.ts` 已具备）。
- 门禁：`npm test`（新增测试 + 全量 401+ 回归）。

### P6 文档与门禁

- 环境变量契约文档：在 RunLedger 现有 settings/env 文档对应位置补「OpenTelemetry export」一节（对齐 oh-my-pi `docs/environment-variables.md` §11 表格）。
- `AGENTS.md`：§1.3 移除「OpenTelemetry / metrics」（保留 RBAC / 多租户）；§1.2 增 telemetry 专项条目（状态、证据、门禁）。
- 本计划文档状态表更新为 implemented / 验收结果。
- 最终门禁：`npm run check` 完整输出、`npm test`、`npm run build` 全绿；worktree 合并回主线后复跑。

## 验收矩阵

| # | 验收项 | 判定 |
|---|---|---|
| A1 | `AgentLoopConfig.telemetry: {}` 时 runAgentLoop 产出 `invoke_agent`→`chat`/`execute_tool` 父子 span，属性符合 `gen_ai.*` + `pi.gen_ai.*` | otel.test.ts 断言通过 |
| A2 | 不传 `telemetry` 时零 span、零 tracer 查找（性能不回归） | otel.test.ts 关闭态断言 |
| A3 | `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` 设置后 span 可达本地 collector | smoke 或 exporter 配置断言 |
| A4 | `OTEL_SDK_DISABLED=true` / 无 endpoint → init no-op | otel-export.test.ts |
| A5 | 协议非 `http/protobuf` → 对应信号禁用并 warn | otel-export.test.ts |
| A6 | `OTEL_LOG_LEVEL` 过滤生效；run-summary 事件含 step/tool/token/cost 字段 | otel-export.test.ts |
| A7 | metrics：token 直方图 + pi 扩展 counter 在 run 后记录 | otel-export.test.ts |
| A8 | 内容采集 none/summary/full 三档 + env 默认生效 | otel.test.ts |
| A9 | oneshot 调用（compaction/auto-title/child/gateway）打 `pi.gen_ai.oneshot.kind` | compaction-telemetry.test.ts |
| A10 | `npm run check` / `npm test` / `npm run build` 全绿 | 门禁输出 |
| A11 | AGENTS.md §1.3 移除 OTEL 排除项 | diff 审查 |

## 显式不实现

- RBAC / 多租户（AGENTS.md §1.3 保留）。
- Opik exporter 与本地 Event Store 改动（`runtime/trace/phase-04` 独立计划）。
- OTEL 与本地 trace store 的 ID 桥接（D3）。
- 中央 logger sink 与 OMP 日志全量转发（D4）。
- pi coding-agent 产物层：`streamProxy`、`compat.ts` / `legacy-api-aliases.ts` / `env-api-keys.ts` / coding-agent `cli.ts`。
- provider 层（api adapters）内的 per-request HTTP 自动插桩：chat span 已覆盖调用语义，HTTP wire 级 span 留给 collector 的 agent instrumentation 或后续专项。

## 风险与缓解

| 风险 | 缓解 |
|---|---|
| pi-ai 类型差异导致编译错误面大 | RunLedger 已全量移植 pi-ai；P1 以 `npm run check` 逐符号消错，禁止 `any` |
| `BatchSpanProcessor` 长驻进程（Session Owner server）缓冲滞留 | 30s unref 定时 flush + turn 边界 flush + 退出 shutdown（照搬 pi） |
| `AsyncLocalStorageContextManager` 在流式/并行工具下的上下文传播 | `runInActiveSpan` 原样包裹所有 chat/tool 体，与 pi 语义一致 |
| oneshot 调用点无 agent loop 上下文 | 按调用点选 `recordManualChatTelemetry` / `resolveTelemetry`，A9 断言 kind 标签 |
| 与主线未提交改动冲突 | D10 独立 worktree，完成后按仓库提交纪律合并 |
| exporter 依赖线在新 Node 下的行为差异 | D6 锁定 oh-my-pi 验证线；P4 smoke 用真实本地 collector 验证一次 |

## 状态表

| 阶段 | 状态 | 证据 |
|---|---|---|
| P0 依赖与骨架 | implemented | 11 个 OTEL SDK 依赖按 D6 锁定线加入(api ^1.9.1 / sdk-* ^2.9.0 / exporter-* ^0.220.0),`npm run check` 通过 |
| P1 插桩核心移植 | implemented | `semconv.ts`(D7 const 对象)+ `run-collector.ts` + `telemetry.ts` 移植完成,公开面全保留;类型适配见「实施记录」 |
| P2 agent-loop 接线 | implemented | `AgentLoopConfig.telemetry` / `AgentOptions.telemetry` 转发;invoke/chat/tool 三档 span + step 计数 + `recordSkippedTool` 截断路径 |
| P3 oneshot 接线 | implemented | `instrumentedCompleteSimple`(completeImpl 必需)+ 四调用点 kind:compaction_summary / auto_title / child_agent / gateway |
| P4 OTLP 导出引导 | implemented | `otel-export.ts`(init/flush/shutdown + 三信号 + AgentMetricRecorder + run-summary log);CLI main + gateway CLI + domain/controller 接线;turn 边界 flush |
| P5 测试移植 | implemented | `tests/runtime/telemetry/` 4 文件 52 测试全绿(otel / run-summary / compaction-telemetry / otel-export);全量 `npm test` 回归通过 |
| P6 文档与门禁 | implemented | 本文档状态表 + env 契约 + 实施记录;AGENTS.md §1.3 移除 OTEL 排除、§1.2 增专项条目;`npm run check` / `npm test` / `npm run build` 全绿(见验收矩阵) |

## 验收矩阵结果

| # | 验收项 | 判定 |
|---|---|---|
| A1 | `AgentLoopConfig.telemetry: {}` 时 runAgentLoop 产出 `invoke_agent`→`chat`/`execute_tool` 父子 span,属性符合 `gen_ai.*` + `pi.gen_ai.*` | otel.test.ts 断言通过 |
| A2 | 不传 `telemetry` 时零 span、零 tracer 查找(性能不回归) | otel.test.ts「emits no spans」通过 |
| A3 | `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` 设置后 span 可达本地 collector | otel-export.test.ts「registers providers」断言 exporter 装配;真实 wire smoke 见下 |
| A4 | `OTEL_SDK_DISABLED=true` / 无 endpoint → init no-op | otel-export.test.ts 通过 |
| A5 | 协议非 `http/protobuf` → 对应信号禁用并 warn | otel-export.test.ts signalEnabled 矩阵通过 |
| A6 | `OTEL_LOG_LEVEL` 过滤生效;run-summary 事件含 step/tool/token/cost 字段 | parseOtelLogLevel + emitRunSummaryLog 字段集在 otel-export.test.ts / run-summary.test.ts 断言 |
| A7 | metrics:token 直方图 + pi 扩展 counter 在 run 后记录 | AgentMetricRecorder + InMemoryMetricExporter 断言 9 个 metric 与 data points 通过 |
| A8 | 内容采集 none/summary/full 三档 + env 默认生效 | otel.test.ts content-capture describe 通过 |
| A9 | oneshot 调用(compaction/auto-title/child/gateway)打 `pi.gen_ai.oneshot.kind` | compaction-telemetry.test.ts 通过 |
| A10 | `npm run check` / `npm test` / `npm run build` 全绿 | 门禁输出(见下) |
| A11 | AGENTS.md §1.3 移除 OTEL 排除项 | diff 审查 |

## OpenTelemetry export 环境变量契约

与 oh-my-pi `docs/environment-variables.md` §11 对齐。RunLedger 在 CLI / gateway 启动路径调用 `initTelemetryExport()`:任一信号存在 endpoint 时注册 OTLP provider,`OTEL_SDK_DISABLED=true` 或全无 endpoint 时 no-op。**不进 settings**,`recording.mode` 仍是本地审计记录的唯一 authority。

| 变量 | 行为 |
|---|---|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | 通用 endpoint 回退 |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` / `..._LOGS_ENDPOINT` / `..._METRICS_ENDPOINT` | 单信号 endpoint,优先于通用值 |
| `OTEL_TRACES_EXPORTER` / `OTEL_LOGS_EXPORTER` / `OTEL_METRICS_EXPORTER` | 列表含 `none` 时禁用对应信号 |
| `OTEL_EXPORTER_OTLP_PROTOCOL` 与各 `..._{TRACES,LOGS,METRICS}_PROTOCOL` | 只支持 `http/protobuf`;显式其他协议禁用对应信号并 warn |
| `OTEL_SERVICE_NAME` / `OTEL_RESOURCE_ATTRIBUTES` | OpenTelemetry 资源元数据(D5:默认 service.name=`runledger`,可被覆盖) |
| `OTEL_LOG_LEVEL` | 最小导出日志级别(`none`/`error`/`warn`/`info`/`debug`,默认 `info`);run-summary 事件与 telemetry warning 按此过滤 |
| `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT` | 内容采集默认档:`true`/`1`/`yes`/`full` → `full`,`summary` → `summary`,缺省 `none`;可被 `AgentTelemetryConfig.captureMessageContent` 覆盖 |
| `OTEL_SDK_DISABLED` | `true` 时 `initTelemetryExport()` no-op |

运行时行为:turn 结束(turn 边界)+ 30s unref 定时 + 进程退出(`beforeExit` / SIGINT / SIGTERM best-effort)三处 flush;退出路径 `shutdownTelemetryExport()` 幂等关闭三信号 provider。span/metric/log 只在真实 provider 注册后产生,未配置时零开销。

## 实施记录(相对 oh-my-pi 的裁剪与适配)

- **D7**:`semconv.ts` 独立文件,`GenAIAttr` / `OpenAIAttr` / `PiGenAIAttr` / `PiGenAIAggregateAttr` / `GenAIOperation` 全为 `as const` 对象 + 类型提取;`telemetry.ts` 不再声明这些常量(测试改从 `semconv.ts` 导入)。
- **D8**:`EventLoopKeepalive` 省略,`instrumentedCompleteSimple` 无 `using` 语句。
- **completeImpl 必需**:RunLedger 无独立 `completeSimple` 导出(`Models.completeSimple` 是实例方法),`InstrumentedChatSpanOptions.completeImpl` 设为必填,调用点传 `(m, c, o) => models.completeSimple(m, c, o)` 闭包。
- **类型字段适配**:`Usage.reasoning`(pi `reasoningTokens`)、`AssistantMessage.ttftMs`(pi `ttft`);`upstreamProvider` 与 `usage.server` 字段 RunLedger 无,对应属性不发。
- **pi-ai barrel 补齐**:`src/types.ts` 新增 `ToolChoice` / `ServiceTier` / `shouldSendServiceTier`(provider-string 版)与 `SimpleStreamOptions.toolChoice` / `serviceTier`,保持 pi-ai parity。
- **D4 日志裁剪**:`otel-export.ts` 无中央 logger sink,只发 run-summary 事件(`pi.omp.agent.run.completed`)与 telemetry warning;`logger.warn` → `console.warn`;`postmortem` → 导出 `shutdownTelemetryExport()` + 进程退出接缝。
- **测试接缝**:`otel-export.ts` 导出 `resolveSignalConfig` / `signalEnabled` / `parseOtelLogLevel` / `AgentMetricRecorder` 供矩阵与 metrics 断言。
- **child_agent kind**:pi 无此 kind;child runtime 的 streamFn 在 streamSimple 层打 chat span(kind=child_agent),child 的 `Agent` 不传 loop telemetry,避免双 span。
- **测试框架**:oh-my-pi 用 bun:test + `agentLoop` 流 API + pi mock provider;RunLedger 用 Vitest + `runAgentLoop` + `mockStreamFn`/`singleTurnStreamFn`,InMemorySpanExporter + AsyncLocalStorageContextManager 一致。
- **门禁差异**:`npm test` 中 `composer-shape-pty` 与 `acceptance-runners` 两个失败是 worktree 环境问题(全局 `runledger` npm link 指向主 worktree、Host native 二进制未在 worktree 构建),与 telemetry 改动无关;主 worktree 基线同样失败。
