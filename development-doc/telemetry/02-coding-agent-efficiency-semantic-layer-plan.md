# RunLedger Coding Agent Efficiency Semantic Layer 实施计划

> 状态：`M0–M3 implemented; M4–M5 planned; M6 partial/pending-human`。本文是 Plan 01 已实现 OpenTelemetry/OTLP 能力之上的第二阶段计划，不覆盖或替代 [`01-telemetry-port-plan.md`](01-telemetry-port-plan.md)。
>
> 目标顺序：先交付本地流量、内存与查询能力，再交付 Plan/Step/Attempt/Verification/TDD 的完成效率语义。阶段不可调换。
>
> 当前基线：2026-08-25，`session-owner-runtime` 分支。实施时必须重新核对 HEAD、工作树、生产 composition 与测试基线，不能把本文的基线描述当成未来完成证据。

## 0. 结论

RunLedger 不再以含义模糊的 `successful task` 作为 Coding Agent Token 效率的基本单位。第一层观测对象是本地可测量的流量与资源，第二层效率对象是 **Verified Progress（已验证进展）**：

- Plan Step 只有在其当前 acceptance criteria 被确定性 Verification 覆盖并通过后，才成为 Verified Step；
- TDD 只有从有效的 Red 到 First Green，再到更广覆盖面的 Stable Green，才形成可比较的实现进展；
- `completed`、退出码非零、模型自述完成或单次 LLM 调用成功，都不能直接成为 verified；
- 不能观测的值保存为 `unavailable`，不能写成 `0`、猜测值或从命令字符串推断；
- Token、成本、流量、内存、Attempt 与 Verification 都按 Session-aware correlation 归因，但 durable authority 仍分别归属于现有 Trace Store 与 Session Event Store。

本计划分成两个连续交付面：

| 交付面 | 首要结果 | 生产完成边界 |
|---|---|---|
| A：Local Agent Profiler | 精确 application payload 流量、Runtime/Session/Managed Process 内存、本地存储、CLI 与 `/telemetry` | M0–M3 |
| B：Verified Progress Efficiency | Plan/Step/Attempt/Verification/TDD canonical events 与效率 projector | M4–M5 |
| Closure | 文档、全量门禁、标准 PATH 与真实 TTY 验收 | M6 |

Langfuse、Phoenix、OpenInference、Opik 或其它外部后端不进入本计划的第一版生产 DoD。Plan 01 的 OTel/OTLP 继续作为可选 projection；本地 Trace/Session stores 才是恢复、审计和效率重算的真相源。

## 1. 当前实现基线与缺口

### 1.1 可直接复用的能力

| 当前能力 | 代码入口 | 本计划用法 |
|---|---|---|
| 本地 hash-chain Trace Event Store 与 Artifact Store | `src/runtime/trace/` | 保存 traffic/resource observation；复用 recording mode、redaction、failure policy 与 tamper detection |
| per-prompt `TraceRecorderFactory` | `src/runtime/trace/composition.ts` | 建立 Session/Trace correlation；关闭 recording 时不创建 recorder |
| Session Owner canonical Event Store | `src/storage/session-store/`、`src/runtime/session-runtime/` | 保存 Plan/Task/Attempt/Verification 等行为真相，支持 takeover/replay |
| current-format Runtime event catalog | `src/runtime/protocol/events.ts`、`src/runtime/protocol/schemas.ts` | 扩展 plan revision 与 attempt 事件；复用现有 `task.*`、`verification.*` |
| governed managed process | `src/runtime/process/`、`src/runtime/session-runtime/process-composition.ts` | Verify 命令执行、process I/O 计量、Linux 私有 process-tree memory 采样 |
| ExecutionGateway / recovery barrier | `src/security/`、`src/runtime/session-runtime/attempt-gateway.ts` | 所有 Verify 与 Network/WebFetch 最终 leaf fail closed，不增加绕过路径 |
| Task/TodoWrite 工具 | `src/runtime/tasks/`、`src/runtime/tools/todo-write.ts` | 改造成 stable TaskId + acceptance criteria 的 Session Domain adapter |
| OTel GenAI spans、run collector、OTLP export | `src/runtime/telemetry/` | 继续导出 token/cost/latency；后续可投影本计划的聚合结果，不成为 durable authority |
| MCP stdio 与 Streamable HTTP adapters | `src/extensions/mcp/sdk-factory.ts` | stdio 计为 process I/O；HTTP/JSONL 计为 application traffic |

### 1.2 当前不能回答的问题

M0–M3 已能在 recording enabled 且 transport coverage 已声明的边界内回答：

- 一个 Session 的 LLM、MCP、WebFetch 分别发送和接收了多少 application payload bytes；
- aborted stream、retry、SSE chunk、WebSocket message 分别消耗了多少流量；
- Session Owner 的 observed peak RSS、V8 heap、logical session state，以及 managed process tree 的 Linux RSS/PSS/USS。

未声明或尚未接入 meter 的 provider/transport、任意 child process 的网络流量和未启用 recording 的 resource 值仍必须显示 `unavailable`，不由 Token、Content-Length、命令字符串或网卡总量推断。

当前实现仍不能可靠回答：

- 一个 Plan Step 从激活到通过当前 acceptance criteria 消耗了多少 Token、成本、Attempt 与时间；
- 一次 TDD cycle 从 Valid Red 到 First Green、再到 Stable Green 的效率；
- 被 rejected/reverted/superseded 的 Attempt、plan churn 和 regression repair 消耗了多少资源。

原因不是缺少图表，而是缺少可持久化、可重放、不可由自由文本猜测的 Coding Agent 语义。

### 1.3 M0–M3 fresh implementation evidence

当前工作树已完成第一交付面：

- M1：`src/runtime/telemetry/local/{meter,provider,coverage}.ts` 提供 governed fetch/stream、SSE、WebSocket message、MCP/governed HTTP 与 process I/O 的 typed observation；managed process composition 记录 observed/retained bytes，未覆盖 transport 继续由 coverage 标成 unavailable。
- M2：`src/runtime/telemetry/local/{memory,recorder}.ts` 提供 runtime/session logical size 与 Linux managed process tree RSS/PSS/USS 的 sampled observation；process identity 保持 Host-private，非 Linux process-tree 指标保持 typed unavailable。
- M3：`src/runtime/telemetry/local/{query,report}.ts`、`src/cli/telemetry.ts` 与 `src/tui/components/telemetry-overlay.ts` 提供同源只读 report、`telemetry status/report` CLI 和 `/telemetry` native overlay；query 不直接把 layout/path 暴露给 TUI。
- focused coverage 包含 local observation/transport/meter/memory/query、Trace event-store、CLI telemetry、TUI overlay、OpenTUI native overlay 与 managed process composition 回归；生产门禁还覆盖多 Trace 聚合、tamper/missing/off coverage、active-turn overlay、1 Hz refresh、Esc/focus restore 与清理。
- fresh validation：`npm run check`、`npm test`、`npm run build`、`git diff --check` 均通过；全局 `runledger` 解析到当前 checkout 的 `bin/runledger.js`；隔离 `RUNLEDGER_DIR` 的 `runledger telemetry status --format json` 与真实 tmux `/telemetry` smoke 通过。

tmux frame 只证明真实 TTY 的自动化入口与生命周期，不等于真人视觉、主题和 IME 验收；M4/M5 尚未开始。

## 2. 架构与 authority

```text
Provider / MCP / Governed HTTP / Process / Session Runtime
                         │
                 LocalTelemetryPort
                         │
        Runtime Trace Store + Session Event Store
                         │
              SessionTelemetryProjector
                    /                 \
        telemetry CLI report      /telemetry TUI
```

### 2.1 真相源划分

| 数据 | Durable authority | recording off 时 | OTel/OTLP |
|---|---|---|---|
| traffic/resource/process-I/O observation | 本地 hash-chain Runtime Trace Store | 不采样、不包 transport、不建文件 | 可选 projection |
| Plan revision、Task、Attempt、Verification、TDD phase | Session Owner canonical Event Store | 仍必须持久化 | 可选 span/event projection |
| Token/cost provider receipt | 现有 runtime trace/session usage receipt | 按现有 authority；缺失为 unavailable | 现有 GenAI span projection |
| CLI/TUI report | 两个真相源的可重建 projection | 只显示仍有 authority 的进展数据 | 不是输入 |
| derived cache/index | 可删除、可重建 | 不得变成第三真相源 | 不适用 |

### 2.2 冻结规则

1. `settings.json#recording.mode=off|events|events_and_artifacts` 仍是本地 observation 的唯一 recording authority；不增加 workspace setting、CLI flag 或额外环境变量绕过它。
2. `recording.mode=off` 时 composition 必须在创建 sampler、metered transport、timer 和文件之前退出；仅仅创建一个 no-op wrapper 仍不合格。
3. `recording.failurePolicy=best_effort|fail_closed` 继续控制 Trace observation 写入失败；不得另造静默失败规则。
4. Progress semantics 是 Session 行为真相，不能因为 recording off 而丢失。
5. OTel/OTLP、Langfuse 或任何远端 sink 都只是 projection，不参与 local replay、verification validity 或 takeover 决策。
6. `unavailable` 与 `0` 不等价。零必须来自一次可证明的测量；缺失、平台不支持、权限不足、correlation 丢失均为 unavailable。
7. 任何 report 都必须带 current-format contract marker、measurement coverage 和 unavailable reasons，避免把部分覆盖误读为完整成本。
8. 仓库禁止内部代际类型名和数字 schema 标记，因此合同使用 unversioned current-format 名称；兼容性由 exact schema、digest 与显式 migration 维护。

## 3. 测量边界

### 3.1 Application traffic

第一版只承诺 **governed application payload bytes**，不承诺网卡、TLS/TCP 或任意子进程的 wire bytes。

| 通道 | TX 定义 | RX 定义 | 是否纳入第一版 |
|---|---|---|---|
| HTTP request/response | body 完成 serialization 后、compression/TLS 前的实际 byte length | fetch/HTTP client 解压后、交给 parser 前实际读取的 body bytes | 是 |
| SSE | request 同 HTTP | 解压后的原始 SSE byte stream，包含 SSE framing；按实际消费 chunk 累加 | 是 |
| WebSocket | 每次 `send` 的 message payload bytes，不含 frame/TLS 开销 | 每次 message event 的 payload bytes，不含 frame/TLS 开销 | 是 |
| MCP Streamable HTTP/JSONL | SDK transport 实际写入的序列化 payload | SDK transport 实际读取的 payload | 是 |
| MCP stdio | 不算 network；计入 process stdin/stdout/stderr | 不算 network；计入 process stdin/stdout/stderr | 是，归入 Process I/O |
| governed Network/WebFetch | `NetworkRequest.body` 实际 bytes | `NetworkResponse.body.byteLength` | 是 |
| auth-gateway | 只有存在可信 Session correlation 的内部 dispatch 才归因；匿名/外部调用不得猜 Session | 同左 | 条件覆盖 |
| `curl`/`npm`/Git/Chromium/任意 child process 网络 | 无 application interception | 无 application interception | `unavailable` |

精确计量还必须遵守：

- `Content-Length` 只能作为诊断，不能作为最终计数；
- abort 前已经读取/写出的 bytes 必须保留，未消费的 response body 不计入；
- retry 的每个 transport attempt 独立记录，Session totals 对实际 attempts 求和；
- gzip/br/zstd 的本指标是 application payload，不是 compressed wire bytes；
- string 统一以 UTF-8 `Buffer.byteLength` 计数，`Uint8Array`/`Buffer` 使用实际 `byteLength`；
- wrapper 必须保持 backpressure、abort、错误与 stream ownership，不允许为计数预读整个流；
- provider 或 transport 没有进入已审计 wrapper 时，coverage 必须显示 unavailable，不能用 Token 或 JSON 重新序列化估算为 exact。

### 3.2 Process I/O

Process I/O 与 network 分栏保存：

- `stdin_bytes`：Host 向 managed process 实际接受的输入 frame bytes；
- `stdout_bytes` / `stderr_bytes`：Host 从对应 stream 实际读取的 bytes；
- PTY 合流输出标记为 `pty_output_bytes`，不能伪拆成 stdout/stderr；
- truncation 前的 observed bytes 与保存后的 retained bytes 分开；
- public observation 只带 `executionId`/`attemptId`，不保存 PID、command、cwd、native path 或输出正文。

### 3.3 Runtime 与 Session memory

| 指标 | 定义 | 归因/精度 |
|---|---|---|
| `runtime.rss_bytes` | `process.memoryUsage.rss()` | Session Owner 进程的 sampled upper bound，不是精确 per-session heap |
| `runtime.heap_total_bytes` | `process.memoryUsage().heapTotal` | V8 runtime sample |
| `runtime.heap_used_bytes` | `process.memoryUsage().heapUsed` | V8 runtime sample |
| `runtime.external_bytes` | `process.memoryUsage().external` | native memory linked to JS objects |
| `runtime.array_buffers_bytes` | `process.memoryUsage().arrayBuffers` | Buffer/ArrayBuffer sample |
| `session.logical_state_bytes` | 对 current-format session logical DTO 做 `canonicalJson` 后的 UTF-8 bytes | exact serialized logical size，不等于 V8 heap |
| `session.context_current_tokens` | 当前一次模型请求的 canonical context input usage | provider-reported 优先，否则 typed estimate/unavailable |
| `session.context_peak_tokens` | Session 内 observed maximum | observed peak，不声称覆盖采样间隙 |
| `process_tree.rss_bytes` | Linux managed root process 与仍属于该 execution 的 descendants RSS 之和 | sampled；共享页可能重复 |
| `process_tree.pss_bytes` | Linux `/proc/<pid>/smaps_rollup` PSS 之和 | sampled；权限不足为 unavailable |
| `process_tree.uss_bytes` | `Private_Clean + Private_Dirty` 之和 | sampled approximation；权限不足为 unavailable |
| checkpoint/artifact bytes | 各自 storage record/ref 的 bytes | storage footprint，不能并入 RAM |

Logical state 至少分组件计数：messages、tool results、context components、task/plan projection、checkpoint descriptor 与其它 current-format session DTO。只保存数值和 coverage，不复制正文。

### 3.4 Sampling policy

- active run 期间每 `2s` 采样轻量 RSS；
- 每 `10s` 采样一次完整 Node memory；
- run start/end、turn start/end、managed process spawn/terminal、checkpoint、Plan/Task/Attempt/Verification boundary 强制采样；
- logical session state 只在 turn/checkpoint/progress boundary 计算，禁止 2s 轮询序列化整个 Session；
- Linux process tree 在 managed process 存活期间按 2s cadence 采样；进程终态后强制最后一次采样并停止；
- sampler 使用 monotonic clock，防止 wall clock 回拨；timer 必须 `unref()` 且由 Session Runtime lifecycle 显式 dispose；
- projector 输出 `observedPeak`，不能把离散采样的最大值命名为绝对 peak；
- 一个 Owner 同时服务额外内部工作时，owner RSS 仍标记 `upper_bound`，不按 Session 比例拆分。

## 4. Local telemetry contracts

以下是计划冻结的语义形状。实施时需在 `src/runtime/telemetry/local/` 建 exact TypeScript 类型、TypeBox schema 与 guards；不得仅用 `Record<string, unknown>` 作为持久化合同。

### 4.1 Quantity 与 correlation

```ts
export type ObservationUnit = "bytes" | "tokens" | "usd_micros" | "milliseconds" | "count";

export type ObservationAccuracy = "exact" | "sampled" | "estimated" | "upper_bound";

export type ObservationSource =
  | "runtime_meter"
  | "provider_reported"
  | "canonical_serialization"
  | "linux_proc"
  | "derived";

export type ObservationUnavailableReason =
  | "recording_disabled"
  | "transport_not_instrumented"
  | "platform_unsupported"
  | "permission_denied"
  | "correlation_missing"
  | "provider_usage_missing"
  | "sample_failed"
  | "not_applicable";

export type ObservedQuantity<TUnit extends ObservationUnit> =
  | {
      readonly availability: "available";
      readonly unit: TUnit;
      readonly value: number;
      readonly accuracy: ObservationAccuracy;
      readonly source: ObservationSource;
    }
  | {
      readonly availability: "unavailable";
      readonly unit: TUnit;
      readonly reason: ObservationUnavailableReason;
    };

export interface TelemetryCorrelationContext {
  readonly sessionId: SessionId;
  readonly traceId: TraceId;
  readonly ownerGeneration: number;
  readonly agentId?: AgentId;
  readonly turnId?: TurnId;
  readonly toolCallId?: ToolCallId;
  readonly commandId?: CommandId;
  readonly executionId?: ExecutionId;
  readonly goalId?: GoalId;
  readonly planRevision?: number;
  readonly taskId?: TaskId;
  readonly attemptId?: AttemptId;
  readonly verificationCommandId?: CommandId;
}
```

所有 number 必须是有限、非负、安全整数；累计溢出返回 unavailable/typed error，不能 wrap。`traceId` 对 observation 必填，因为 observation 只进入 Trace Store；progress event 自身继续使用 Session event envelope，不强制存在 trace。

### 4.2 Observation union

```ts
export interface TelemetryObservationBase {
  readonly format: "runledger.telemetry.observation";
  readonly observationId: EventId;
  readonly observedAt: string;
  readonly monotonicOffsetMs: number;
  readonly correlation: TelemetryCorrelationContext;
}

export interface TrafficObservation extends TelemetryObservationBase {
  readonly kind: "traffic";
  readonly channel: "llm_http" | "llm_sse" | "llm_websocket" | "mcp_http" | "governed_http" | "gateway";
  readonly direction: "tx" | "rx";
  readonly boundary: "request_body" | "response_body" | "message_payload";
  readonly bytes: ObservedQuantity<"bytes">;
  readonly transportAttempt: number;
  readonly terminal: "completed" | "aborted" | "failed";
}

export interface ProcessIoObservation extends TelemetryObservationBase {
  readonly kind: "process_io";
  readonly stream: "stdin" | "stdout" | "stderr" | "pty_output";
  readonly observedBytes: ObservedQuantity<"bytes">;
  readonly retainedBytes: ObservedQuantity<"bytes">;
}

export interface RuntimeMemoryObservation extends TelemetryObservationBase {
  readonly kind: "runtime_memory";
  readonly rssBytes: ObservedQuantity<"bytes">;
  readonly heapTotalBytes: ObservedQuantity<"bytes">;
  readonly heapUsedBytes: ObservedQuantity<"bytes">;
  readonly externalBytes: ObservedQuantity<"bytes">;
  readonly arrayBuffersBytes: ObservedQuantity<"bytes">;
}

export interface LogicalSessionStateObservation extends TelemetryObservationBase {
  readonly kind: "logical_session_state";
  readonly totalBytes: ObservedQuantity<"bytes">;
  readonly messagesBytes: ObservedQuantity<"bytes">;
  readonly toolResultsBytes: ObservedQuantity<"bytes">;
  readonly planTaskBytes: ObservedQuantity<"bytes">;
  readonly checkpointDescriptorBytes: ObservedQuantity<"bytes">;
  readonly contextCurrentTokens: ObservedQuantity<"tokens">;
}

export interface ManagedProcessMemoryObservation extends TelemetryObservationBase {
  readonly kind: "managed_process_memory";
  readonly rssBytes: ObservedQuantity<"bytes">;
  readonly pssBytes: ObservedQuantity<"bytes">;
  readonly ussBytes: ObservedQuantity<"bytes">;
  readonly observedProcessCount: ObservedQuantity<"count">;
}

export type TelemetryObservation =
  | TrafficObservation
  | ProcessIoObservation
  | RuntimeMemoryObservation
  | LogicalSessionStateObservation
  | ManagedProcessMemoryObservation;
```

### 4.3 LocalTelemetryPort

Port 至少提供：

```ts
export interface LocalTelemetryPort {
  observe(observation: TelemetryObservation): Promise<{ readonly ok: true } | { readonly ok: false; readonly code: string }>;
  bind<T>(correlation: TelemetryCorrelationContext, operation: () => Promise<T>): Promise<T>;
  currentCorrelation(): TelemetryCorrelationContext | undefined;
  forceSample(reason: "run" | "turn" | "process" | "checkpoint" | "progress"): Promise<void>;
  close(): Promise<void>;
}
```

`bind` 可以在 composition 内用 AsyncLocalStorage 传播 correlation，但 storage event 必须显式携带完整 correlation；不得依赖读取 OTel active span 作为唯一来源。关闭态不实例化这个 port。

### 4.4 Trace schema integration

M0 在现有 Trace contract 上做向后兼容扩展：

- `TraceNodeKind` 增加 `observation`；
- `TraceEventInput` / `TraceEvent` / `TraceTreeNode` 增加可选 `observation: TelemetryObservation`；
- observation 使用 `phase="finished"` 的单次 leaf，parent 指向当前 turn/tool/process node；无更细 parent 时指向 trace root；
- event hash 必须覆盖完整 observation；旧事件缺少该字段仍可 replay；
- `TraceTreeProjection` 默认可以折叠 observation leaves，CLI/TUI 通过 projector 读取，不把 2s sample 平铺到 `/audit` 主树；
- `events` 模式只保存数值、availability 与 correlation；本计划的 observation 从不需要 Artifact body。

不得把高频 observation 写入 Session Event Store，也不得把 progress event 只写入 Trace Store。

## 5. 隐私、安全与 coverage

### 5.1 永不持久化的字段

traffic/resource observation、report JSON 与 `/telemetry` 均禁止保存或展示：

- URL（包括 host、query、fragment）与 redirect URL；
- request/response headers、cookies、authorization、API key；
- request/response body、SSE data、WebSocket message、MCP JSON-RPC payload；
- command 原文、cwd、workspace native path、environment；
- PID/PPID、`/proc` path、OS username；
- stdout/stderr/PTY 正文；
- prompt、tool result、reasoning 或 Artifact body。

允许字段限于 stable Runtime IDs、provider/model/tool 的既有安全标识、transport class、数值、状态、reason code、schema/version 与 digest/ref。若现有 ID 本身不能安全出现在外部 report，projector 使用 digest，不回退原值。

### 5.2 Coverage

每份 report 必须输出 coverage，例如：

```text
traffic.llm_http        measured
traffic.llm_websocket   measured
traffic.mcp_http        unavailable: transport_not_instrumented
traffic.process_wire    unavailable: not_applicable
memory.runtime          sampled
memory.process_pss      unavailable: platform_unsupported
progress.verification   measured
```

一个 provider 只要存在未 instrument 的可达 transport，就不能把 provider traffic coverage 标成 complete。M1 必须建立 transport coverage registry 与静态/测试门禁；新增 provider transport 时若未声明 meter，`npm run check` 失败或明确标为 unavailable。

## 6. Plan、Step、Attempt 与 Verification 语义

本节是第二交付面，必须在 M0–M3 完成后实施。

### 6.1 Identity

| 对象 | 稳定 identity | 规则 |
|---|---|---|
| Plan | `goalId + revision + digest` | 每次结构或 acceptance 变化产生新 revision；旧 revision append-only 保留 |
| Step | `TaskId` | 跨 Plan revision 保留同一语义 Step 时必须保留 ID；禁止按文本相似度猜测 |
| Attempt | `AttemptId` | 一个 Task 从开始/重试到一次 Verification terminal 的实现区间 |
| Verification | governed `CommandId` | command、constraint、ExecutionGateway receipt 与 parser result 可审计；不新增裸 shell identity |
| TDD cycle | `TaskId + acceptanceDigest + redVerificationCommandId` | acceptance 变化后必须创建新 cycle |

### 6.2 Canonical events

在 `RUNTIME_EVENT_TYPES`、payload requirements、TypeBox schemas 与 replay projector 中加入或强化：

- `plan.revision_recorded`
- `plan.revision_superseded`
- 现有 `task.created`
- 现有 `task.definition_revised`
- 现有 `task.transitioned`
- `attempt.started`
- `attempt.finished`
- 现有 `verification.started`
- 现有 `verification.finished`

Plan revision payload 至少包含 goalId、revision、plan digest、ordered TaskId list、每个 task 的 definition/acceptance digest、previous revision 与 reason。不得保存整篇 Plan 正文；正文继续走现有 plan artifact authority。

Attempt outcome 使用闭集：

```ts
export type CodingAttemptOutcome =
  | "verified"
  | "rejected"
  | "reverted"
  | "superseded"
  | "no_progress"
  | "partial_progress"
  | "blocked"
  | "infra_failure"
  | "user_interrupted";

export type AttemptWasteReason =
  | "model_incorrect"
  | "model_repetition"
  | "context_missing"
  | "invalid_tool_arguments"
  | "verification_failed"
  | "regression"
  | "harness_failure"
  | "network_retry"
  | "rate_limit_retry"
  | "user_scope_changed"
  | "superseded";
```

Attempt 事件是 Coding efficiency 语义，不得把现有 ExecutionGateway 的每个 side-effect receipt 自动等同于一个 Coding Attempt。两者可以通过 AttemptId/CommandId 引用，但 recovery attempt 和 implementation attempt 的作用不同。

### 6.3 TodoWrite 与 Task authority

`TodoWrite` 必须从 legacy `custom` JSONL task ledger 的生产 authority 迁移到 Session Domain：

- 输入/输出携带 stable `TaskId`；新 Step 可请求分配 ID，后续 revision 必须回传该 ID；
- 每个 Step 至少有一个结构化 acceptance criterion；criterion 具有 stable criterion ID、kind、target digest 与 required 标志；
- 整盘覆盖通过 stable ID 计算 added/removed/reordered/revised，不通过 content 字符串匹配；
- definition 或 acceptance 变化写 `task.definition_revised` 并生成新 acceptance digest；
- `status="completed"` 只表示 Agent 声明完成，不能写 verification passed；
- production projector 只消费 canonical Session events；旧 `kind=task|task_update` JSONL 可读兼容但 efficiency coverage 必须标为 unavailable；不隐式迁移、不猜 ID；
- 测试/demo 的 MemoryLedger fallback 可以保留，但不能进入生产 report。

### 6.4 Attempt state machine

```text
task in_progress
       │
       ▼
attempt.started
       │
 model / tool / patch / process
       │
       ▼
verification.started ── infra failure ──► attempt.finished(infra_failure)
       │
       ├── failed ───────────────────────► attempt.finished(rejected/partial_progress)
       │                                      │
       │                               next model request
       │                                      ▼
       │                                attempt.started
       │
       └── passed ─────────────────────► attempt.finished(verified)
```

首个 Attempt 在 Task 明确进入 `in_progress` 后、首个归属于该 Task 的 model request 前写入。Verification 失败后，下一个归属于同一 active Task 的 model request 前写入新的 Attempt。所有边界由 typed task/model/verification lifecycle 决定，不分析 shell command 文本。

若没有唯一 active Task/Attempt，Verify 必须返回 `verification_context_missing`，不能执行后再猜归因。Plan supersede、用户中断、recovery uncertainty 与 acceptance change 必须显式闭合 active Attempt。

### 6.5 Governed Verify tool

新增 `Verify` 作为 managed process + ExecutionGateway 的薄包装，不实现第二套 shell：

- 输入：taskId、attemptId、verification kind、TDD phase、adapter、受治理 command ref、coverage/acceptance digest；
- 执行：复用 managed process、constraint snapshot、approval、sandbox/workspace binding、output artifact 与 terminal receipt；
- 输出：只持久化 parser aggregates、exit code、duration、coverage digest、result、reason code 与 evidence ref；
- 第一批 adapter：generic exit code、Vitest JSON；
- 第一批 kind：test、typecheck、build、lint、contract_test；
- parser 必须有版本号；raw stdout/stderr 仍归 process artifact authority，不复制到 event；
- command start 前写 `verification.started`，terminal + parser 完成后写 `verification.finished`；崩溃恢复必须能区分 running、terminal-unparsed 与 finished。

### 6.6 TDD phases

```text
red_candidate
      │ parser 证明目标 test 因预期 assertion/behavior 失败
      ▼
red_verified
      │
 implementation attempts
      │
      ▼
green_candidate
      │ target coverage passed
      ▼
first_green
      │ broader regression verification passed
      ▼
stable_green
```

规则：

- generic nonzero exit、SyntaxError、缺依赖、fixture broken、wrong cwd、timeout、runner crash 都不是 valid Red；
- `red_verified` 必须由 adapter 识别目标 test 与预期 failure class；第一版只有能提供结构化证据的 adapter 可产出该 phase；
- First Green 只证明目标 acceptance coverage passed；
- Stable Green 必须由之后的、更广 coverage digest 的 regression verification passed；
- First Green 后 regression failed 会使 Step 回到未验证状态，并启动 regression repair 区间；
- acceptance digest 变化立即使旧 Verification 对当前 Step 失效；旧 evidence 保留，不改写历史；
- Step 的所有 required criteria 通过且无更新的 invalidation/regression，才投影为 verified。

## 7. Efficiency metrics

### 7.1 Token ledger normalization

`rawModelTokens = contextInputTokens + outputTotalTokens`。cache read/write 和 reasoning 如果是 provider total 的子集，不得再次相加。跨 provider/model 的主比较指标优先使用 actual cost；usage/cost 缺失时相应 metric unavailable。

所有 Token 归因依赖 model call 的 explicit correlation。无法唯一关联 Task/Attempt 的 Token 进入 `unattributed_tokens`，不得按时间比例或 Step 数均摊。

### 7.2 核心指标定义

#### Tokens To Verified Step（TTVS）

```text
TTVS(task, acceptanceDigest)
  = Σ rawModelTokens
    for all explicitly correlated attempts
    from first attempt.started under that acceptance digest
    through first verification state that covers all required criteria
```

若 Step 尚未 verified，输出 `in_progress` + current accumulated tokens，而不是伪造终值。

#### Cost / Attempts To Verified Step

```text
CostToVerifiedStep = Σ actualCostUsdMicros over the same TTVS boundary
AttemptsToVerifiedStep = count(attempt.started) over the same boundary
```

任一 cost receipt unavailable 时，total cost availability 必须说明 partial/unavailable；Token 与 cost 不互相代替。

#### Retry Waste Rate

```text
RetryWasteRate
  = Σ tokens of eligible wasted attempts
    / Σ tokens of all finished attempts in the same Step boundary
```

eligible wasted attempt 默认包括 rejected、reverted、superseded、no_progress，以及明确归为 model/context/verification/regression 的失败；infra_failure、network/rate-limit、user scope change 单独分栏，不默认归咎模型。分子、分母和每类 reason 必须同时展示。

#### Tokens Red → First Green

```text
TokensRedToFirstGreen
  = Σ rawModelTokens after red_verified
    through the first target verification passed
```

没有 `red_verified` 时 unavailable，不从第一次任意测试失败开始计算。

#### Tokens Red → Stable Green

```text
TokensRedToStableGreen
  = Σ rawModelTokens after red_verified
    through the later broader regression verification passed
```

#### Regression Repair Tokens

```text
RegressionRepairTokens
  = Σ rawModelTokens after the first post-green regression failure
    through stable_green
```

#### Plan Churn Rate

只按 stable TaskId 与 digests 计算：

```text
PlanChurnRate(revision n)
  = (added + removed + definitionChanged + acceptanceChanged + reordered)
    / max(1, taskCount(revision n - 1))
```

同时单列每种 change count 和 abandoned-plan tokens。不得用 LLM/embedding 做文本相似匹配。

#### Context Amplification

```text
ContextAmplification
  = Σ contextInputTokens across model calls
    / Σ tokenCount of unique prompt components in the Session
```

unique component 由 `componentType + contentDigest + tokenizer/model identity` 去重。`context.assembled` 需要增加 component digest/token count/source，但不得保存正文。若 component token 只能估算，metric accuracy 为 estimated。另行展示 cache read/write 与 paid cost，不用高 raw amplification 自动判定浪费。

### 7.3 聚合维度与防误用

允许的 report 分组：provider、model、agent version、prompt version、toolset digest、step kind、verification kind、task difficulty bucket、TDD phase 与 waste reason。

不能把不同难度 Step 的 `steps/token` 作为单一排行榜。第一版主要比较：

- 同一个 Task/acceptance 在不同 model/prompt/harness 下的 TTVS；
- 同类 task/verification bucket 的 P50/P75/P95；
- 在质量门槛已满足的候选之间比较 cost/time/token；
- observed trend，不声称因果关系。

## 8. SessionTelemetryProjector 与查询合同

`SessionTelemetryProjector` 是纯 projection：

```text
Session Event Store events ─┐
                            ├─► correlation/validity join ─► SessionTelemetryReport
Trace Event Store events ───┘
```

要求：

- 按 event hash chain 先验证再聚合；任一 source tampered 时 fail closed，不输出可信 totals；
- progress replay 决定 Plan revision、active Task/Attempt、Verification validity；Trace observation 只提供 usage/traffic/resource samples；
- trace 缺失时 progress 仍可展示，resource/token 对应字段 unavailable；
- Session/Trace 之外的高基数 ID 只在 report JSON detail 中出现，不进入 Prometheus label；
- derived index 可以加速 session→trace 定位，但必须可删除重建；索引损坏回退安全扫描，不改变 totals；
- JSON report 使用固定 `runledger.telemetry.report` current-format contract；table 只是同一 report 的 renderer，不能独立计算；
- totals 同时提供 observed sum、observed peak、sample count、first/last timestamp 与 coverage。

## 9. CLI 与 `/telemetry` TUI

### 9.1 CLI

冻结命令：

```text
runledger telemetry status
runledger telemetry report --session <sessionId> --format table|json
runledger telemetry report --latest --format table|json
```

`status` 显示 recording mode/failure policy、local store 可读性、transport coverage、平台 memory capability、OTel exporter 健康摘要；不展示 endpoint、path 或凭据。

table report 至少分为：

1. Summary：duration、turns、model calls、coverage；
2. Traffic：LLM/MCP/governed HTTP TX/RX、process I/O；
3. Memory：owner observed RSS、V8、logical state、managed process RSS/PSS/USS；
4. Progress：Plan revisions、verified/unverified/reopened Steps；
5. Efficiency：TTVS、retry waste、TDD、context amplification；
6. Unavailable：原因与未覆盖 transport/platform。

### 9.2 TUI `/telemetry`

`/telemetry` 是 local control command：

- 绝不进入 user prompt、conversation history 或 model context；
- active turn 期间可打开；只读，不暂停 Agent；
- UI refresh 最大 1 Hz，不能按每个 stream chunk 重渲染；
- wide layout 左侧 summary/traffic/memory，右侧 current Step/Attempt/Verification；narrow layout 改为单列 section；
- 打开前保存 composer draft、selection、scroll 与 focus；关闭后完整恢复；
- active metrics 显示 `observed`/`in_progress`，不能把当前累计值当 final；
- 不显示 Artifact body、secret、path、URL、PID、command 或 raw output；
- recording off 时资源页明确显示 disabled，进展页仍从 Session events 展示；
- TUI 与 CLI 必须消费同一个 `SessionTelemetryReport`。

## 10. 非可重排实施阶段

每阶段先增加 RED contract/behavior test，再写实现。前一阶段的 acceptance 未闭合时不得开始下一阶段；不得为了展示 UI 先造 fake metrics。

### M0：contracts、Trace storage 与 disabled behavior

目标：建立 typed observation、存储与零开销关闭边界。

实施项：

- 新增 `src/runtime/telemetry/local/{types,schemas,port,recorder,coverage}.ts`；
- 扩展 Trace types、event hash/replay/tree projection，支持 observation leaf；
- 在 Session Runtime composition 中只于 recording enabled 时创建 `LocalTelemetryPort`；
- 建 correlation binder，串起 session/trace/owner/agent/turn/tool/execution；
- 定义 `SessionTelemetryReport` 初始 traffic/resource 字段和 exact JSON schema；
- 建只读 projector 骨架，旧 trace/session 缺字段时返回 unavailable；
- 保持 Plan 01 OTel 初始化与本地 recording authority 相互独立。

Acceptance：

- mode off 不创建 timer、wrapper、event/artifact/index 文件，也不调用 `process.memoryUsage`；
- events/events_and_artifacts observation JSONL hash chain 可验证，单字节 tamper fail closed；
- old TraceEvent 可 replay；unknown observation schema fail closed；
- best_effort/fail_closed 与现有 recorder 完全一致；
- privacy sentinel 不出现在任何本地 observation 文件。

### M1：exact application traffic 与 process I/O（implemented）

状态：implemented。实现入口为 `src/runtime/telemetry/local/meter.ts`、`provider.ts`、`coverage.ts` 与 Session managed process I/O hooks；未进入审计 wrapper 的 transport 仍只报告 unavailable。

目标：在所有第一版声明覆盖的 governed transport 上直接数实际 bytes。

实施项：

- 完成 provider transport inventory，建立 coverage registry；
- 实现 backpressure-safe `meteredFetch`/stream wrapper，覆盖 request body、response stream、SSE、abort 与 retry；
- 在 OpenAI Codex WebSocket 的 send/message 边界计 message payload；
- 通过 MCP SDK 已有 custom fetch seam 覆盖 Streamable HTTP；stdio JSONL 只接 process I/O；
- 在 governed `Network`/WebFetch request/response 边界计数；
- 在 managed process write/output store 边界计 stdin/stdout/stderr/PTY 与 retained bytes；
- 将 provider/model/tool/execution correlation 从 Session Runtime 传播到 meter；
- 未覆盖的 provider/transport 显式 unavailable，不影响调用本身。

Acceptance：

- streaming request、SSE chunks、gzip response、abort、retry、WebSocket、MCP HTTP、MCP stdio、WebFetch fixtures 的 bytes 与 fixture exact length 相等；
- instrumentation 不改变 chunk ordering、TTFB、abort signal、retry count、response parser 与 error type；
- process stdio 不出现在 network totals；
- URL/header/body/credential/path/PID sentinel 全部不落盘；
- transport coverage registry 能检测新增但未声明的生产 transport。

### M2：runtime/session/managed-process memory（implemented）

状态：implemented。实现入口为 `src/runtime/telemetry/local/memory.ts`、`recorder.ts` 与 Session process composition；Linux process-tree 采样保留 `(pid,starttime)` 校验，public report 不暴露 PID/native path。

目标：交付可解释的 sampled physical memory 与 exact logical serialized size。

实施项：

- `RuntimeMemorySampler`：2s RSS、10s full Node memory、boundary forced sample；
- `LogicalSessionStateSizer`：current-format DTO canonical JSON UTF-8 分组件计数；
- context current/peak tokens 接 usage receipt；缺 provider usage 不猜；
- managed process backend 增 Host-private process identity port，root PID 与 start time 不进入 public DTO/receipt；
- Linux `/proc` adapter 遍历仍属于 execution 的 descendants，校验 `(pid,starttime)` 防 PID reuse；
- 解析 `/proc/<pid>/status`/`smaps_rollup` 生成 RSS/PSS/USS；权限或文件消失返回 unavailable；
- macOS/Windows 第一版只提供 Node runtime memory，process-tree PSS/USS 标记 platform unsupported；
- checkpoint/artifact/output storage bytes 独立投影。

Acceptance：

- fake clock 验证 2s/10s cadence、boundary sample、unref/dispose 与无 post-close write；
- observed peak、sample count、missing interval 语义正确；
- logical size 与 canonical serialized fixture byte length exact 一致；
- Linux fixture/真实隔离 child tree 验证 RSS/PSS/USS、child exit、权限失败和 PID reuse；
- public event/report 不含 PID/native path；
- owner RSS 明确为 upper_bound，不出现 per-session heap 误导字段。

### M3：local projector、CLI report 与 `/telemetry`（implemented；human acceptance pending）

状态：automated 与真实 TTY production smoke 已通过；真人视觉/IME 验收仍 pending-human。实现入口为 `src/runtime/telemetry/local/{query,report}.ts`、`src/cli/telemetry.ts`、`src/tui/components/telemetry-overlay.ts` 与 `src/tui/interactive-mode.ts`。

目标：让第一交付面可查询、可操作，并验证 active-turn UX。

实施项：

- 完成 traffic/resource `SessionTelemetryProjector`；
- 增 telemetry CLI parser/dispatcher 与 versioned table/JSON renderer；
- `--latest` 通过 canonical Session catalog 选择，不按 trace 文件 mtime 猜；
- 增 `/telemetry` local command、responsive OpenTUI panel、1 Hz refresh controller；
- 复用 current session subscription，关闭 overlay 时恢复 draft/focus/scroll；
- status/report 所有读取使用 resolved canonical layout 与只读路径。

Acceptance：

- CLI table 与 JSON 对相同 report 的 totals/availability 一致；
- 多 Session、多 Trace、aborted run 与 background process 不串数据；
- recording off/trace missing/tampered source 的展示符合 authority；
- OpenTUI native frame/input tests 覆盖 wide/narrow、active refresh、resize、close/restore 与 cleanup；
- 标准 PATH 的 `runledger telemetry ...` 与 tmux `/telemetry` smoke 通过。

### M4：Plan/Step/Attempt/Verification/TDD canonical events

目标：建立 Verified Progress 的非推断事实链。

实施项：

- 扩展 `RUNTIME_EVENT_TYPES`、schemas、guards、payload requirements、replay 与 boundary inventory；
- Plan Domain 写 revision recorded/superseded，使用 goal/revision/digest；
- TodoWrite/Task tools 改为 Session Domain adapter，增加 stable TaskId 与 acceptance criteria；
- 实现 Attempt state machine 与 crash/takeover replay；
- 新增 governed Verify tool、generic exit adapter 与 Vitest JSON adapter；
- 写 verification start/finish 与 TDD phase；
- acceptance change、plan supersede、regression failure 显式 invalidation/reopen；
- legacy Task JSONL 保持只读兼容但不进入 production efficiency truth。

Acceptance：

- Plan revision 保留稳定 TaskId，added/removed/reordered/revised 无文本推断；
- duplicate command/event 幂等，owner fence 与 takeover 后不重复 Verification；
- completed 不等于 verified；acceptance digest 变化使旧 verification 失效；
- generic nonzero、syntax error、missing dependency 不能成为 Red；Vitest target expected failure 可以成为 red_verified；
- First Green 与 Stable Green 独立；回归失败 reopen，后续通过形成 stable_green；
- Verify 不存在 active Task/Attempt 时在 spawn 前 fail closed。

### M5：efficiency projector

目标：从 canonical events 与 trace usage 计算可重放效率指标。

实施项：

- 扩展 `SessionTelemetryReport` progress/efficiency 部分；
- model call 增 task/attempt/verification correlation；
- `context.assembled` 增 component type/digest/token/source，支持 amplification；
- 实现 TTVS、cost/attempts、retry waste、TDD、regression repair、plan churn、unattributed；
- 增 P50/P75/P95 bucket aggregation，但不把高基数 ID 放入 Prometheus labels；
- 可选把聚合结果映射到 OTel attributes/events，不能反向作为 truth。

Acceptance：

- golden event/trace fixtures 的每个公式得到 exact 预期值；
- reasoning/cache token 不重复计数；
- partial/unavailable cost 不被求和成精确 total；
- infra/user-change waste 与 model retry waste 分栏；
- unattributed token 不均摊；
- plan/acceptance revision 与 regression invalidation 后边界重算正确；
- CLI/TUI 同时展示新字段且旧 Session 不崩溃。

### M6：文档、全量门禁与真实入口验收

实施项：

- 更新本计划状态表、telemetry README、总索引、AGENTS.md 当前能力与限制；
- 写用户文档：recording authority、指标定义、privacy、CLI、TUI、platform coverage；
- 写 provider/MCP transport coverage 清单与新增 transport 接入规则；
- 重建 dist，验证全局 npm link 指向本仓库；
- 使用隔离 `RUNLEDGER_DIR` 做 CLI 与真实 TTY smoke；
- 分开记录 automated、real TTY 与 human acceptance，不把 tmux frame 称为真人验收。

最终门禁：

```text
npm run check
npm test
npm run build
git diff --check
```

若实施触碰 catalog，另跑 `npm run generate-models` 并审阅生成结果。任何测试都不得读写真实 `~/.runledger`。

## 11. 测试与验收矩阵

| 编号 | 验收面 | 必需证据 |
|---|---|---|
| A01 | Trace observation schema/hash | append/replay、旧 schema、unknown schema、single-byte tamper |
| A02 | recording modes | off 零 timer/wrapper/file；events 无 Artifact；events_and_artifacts 不复制 observation body |
| A03 | failure policy | best_effort diagnostic、fail_closed typed failure |
| A04 | HTTP body | string/Buffer/stream request 与 response exact bytes |
| A05 | SSE/gzip | chunk boundary 无关、解压后 bytes exact、parser output 不变 |
| A06 | abort/retry | partial bytes 保留、attempt 分开、未消费 bytes 不计 |
| A07 | WebSocket | send/message payload exact；frame overhead 不计 |
| A08 | MCP | Streamable HTTP traffic；stdio JSONL 只进 process I/O |
| A09 | WebFetch/Network | governed body bytes exact、redirect/abort/error 保持现有语义 |
| A10 | privacy | URL/header/body/secret/path/PID/output sentinel 不进入 event/report/frame |
| A11 | runtime memory | cadence、forced sample、upper bound、observed peak、dispose |
| A12 | logical size | canonical JSON UTF-8 exact、component totals、无正文 |
| A13 | Linux process memory | `/proc` fixture、PSS/USS、permission、process exit、PID reuse |
| A14 | platform fallback | macOS/Windows unsupported 为 unavailable，不为 0 |
| A15 | plan identity | goal/revision/digest、stable TaskId、reorder/acceptance change |
| A16 | attempt replay | start/finish、duplicate、supersede、interrupt、takeover |
| A17 | verification | managed process/ExecutionGateway、terminal-unparsed recovery、parser version |
| A18 | TDD validity | false Red、valid Red、First Green、regression、Stable Green |
| A19 | metric formulas | TTVS/cost/retry waste/TDD/churn/amplification golden fixtures |
| A20 | query isolation | 多 Session/Trace/process 不串数据；tamper fail closed |
| A21 | CLI parity | table/JSON 同源；status/session/latest/error paths |
| A22 | OpenTUI | native frame/input/resize/1 Hz/active turn/draft-focus restore/cleanup |
| A23 | production entry | isolated `RUNLEDGER_DIR`、global linked dist、tmux smoke |
| A24 | full regression | check/test/build 全绿，文档状态与真实证据一致 |

## 12. Stop rules 与风险控制

出现以下情况必须停止扩大范围并先修正边界：

- exact traffic 只能通过 `Content-Length`、Token、重新序列化或网卡总量估算；
- recording off 仍创建 sampler、AsyncLocal wrapper、timer、文件或执行 serialization；
- 为了 per-session RAM 把共享 owner RSS 按比例拆分；
- 将 PID/native path/URL/headers/body 写进 telemetry；
- 从 `npm test`、`pytest` 等 command string 推断 verification kind、Red 或 Green；
- 把 Task `completed`、exit code 0、LLM Judge 或 user silence 当成 verified；
- Verify 绕过 managed process、ExecutionGateway、approval、workspace containment 或 recovery barrier；
- OTel/Langfuse 数据反向参与 Session replay 或覆盖本地事件；
- 为了图表先加入 fake/placeholder metric；
- 未区分 missing/unavailable 与 zero；
- 未闭合 M0–M3 就开始效率排名或 M4–M5 UI 宣传。

主要风险与缓解：

| 风险 | 缓解 |
|---|---|
| provider transport 分散，部分 SDK 不暴露 stream | M1 inventory + coverage registry；只声明已直接计量的 transport，其余 unavailable |
| 高采样频率放大 Trace JSONL | 2s/10s 分级、只在 active lifecycle、单次 compact observation；M3 加 sample count/size benchmark |
| logical serialization 阻塞 event loop | 仅 boundary 计算、分组件 DTO、建立 P95 duration budget；超时/失败 unavailable |
| `/proc` race 与 PID reuse | Host-private `(pid,starttime)` identity，每次读前后校验，文件消失视为终态 race |
| Task/Attempt correlation 丢失 | Verify 前 fail closed；unattributed 单列，禁止时间启发式 |
| plan churn 被任务粒度操纵 | stable ID + digest-based change counts，并按 task kind/difficulty 分桶 |
| raw context amplification 被缓存误判为浪费 | 同时展示 cache/cost，不用单指标自动告警或路由 |
| TUI active refresh 影响 streaming | projector 与 renderer 1 Hz 上限，后台 sample 不直接触发 frame |

## 13. 显式延期

以下不属于本计划第一版生产 DoD：

- TLS/TCP/IP wire traffic、HTTP headers overhead 与 NIC-level bytes；
- arbitrary `curl`/`npm`/Git/Chromium/child process network attribution；
- Linux unified cgroup hierarchy、network namespace、eBPF 或 sidecar proxy；
- exact per-session V8 heap、object retained-size 或 heap snapshot attribution；
- macOS/Windows managed process PSS/USS 等价实现；
- 自动 retention/compaction/GC 与长期 telemetry warehouse；
- Langfuse/OpenInference/Phoenix/Opik 专用 dashboard 或 exporter；
- RBAC、多租户、chargeback/billing settlement；
- LLM Judge、自动 difficulty scorer 或统一“效率总分”；
- model routing 自动决策、reasoning effort 自动调节；
- 把 telemetry body、Artifact body 或 prompt 内容发送到远端。

## 14. 状态表

| 阶段 | 状态 | 完成证据入口 |
|---|---|---|
| M0 contracts/storage/disabled | implemented | `tests/runtime/telemetry/local-observation.test.ts` 8 tests；`npm run check`、`npm run build`、`npm test` |
| M1 application traffic/process I/O | implemented | `local-transport.test.ts`、`local-meter.test.ts`、`process-composition.test.ts`；transport boundary check 与 full gates |
| M2 memory/resources | implemented | `memory-sampler.test.ts`、Linux isolated child-tree evidence、runtime/process Trace projection与 full gates |
| M3 CLI 与 `/telemetry` | implemented；pending-human | `local-query.test.ts`、`tests/cli/telemetry.test.ts`、TUI overlay tests、OpenTUI native frame test、linked tmux smoke |
| M4 progress canonical events/TDD | planned | event/state-machine/Verify/TDD tests |
| M5 efficiency projector | planned | golden formulas + CLI/TUI parity |
| M6 docs/full validation | partial；pending-human | 本次已完成文档回写、check/test/build、isolated CLI 与 linked TTY；真人视觉/IME 等验收仍未完成 |

只有对应实现、自动门禁与生产入口证据全部存在后，才能逐行改为 `implemented`。M3/M6 的真实 TTY smoke 不等于人工视觉验收；需要真人判断的项目必须继续标为 pending-human。
