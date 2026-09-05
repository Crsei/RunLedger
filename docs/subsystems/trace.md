# Runtime Trace

Runtime Trace 子系统拥有可选的本地运行观测：append-only trace event hash chain、SHA-256 content-addressed artifact、run/model/tool/context/usage/cost 节点和 trace tree projection。它不拥有 Session recovery、权限或远程 telemetry delivery。

源码入口：[`src/runtime/trace/`](../../src/runtime/trace)、[`src/storage/settings-manager.ts`](../../src/storage/settings-manager.ts)、[`src/cli/trace-config.ts`](../../src/cli/trace-config.ts)。

## Recording authority

recording 只由 canonical 用户 settings 的 `recording` 配置控制。mode 为 `off`、`events` 或 `events_and_artifacts`；failure policy 为 `best_effort` 或 `fail_closed`。workspace settings、项目 `.runledger`、额外环境变量和任意 sessionDir 不拥有 recording authority。

CLI 解析 layout/settings 后创建 `TraceRecorderFactory`，Session domain 为每次 Agent run 创建独立 recorder，并补入 session id 与 owner generation。一个有状态 recorder 不跨 run 复用。

## Event store

每个 trace 写入 `events/<date>/<trace-id>.jsonl`。`JsonlTraceEventStore` 维护单调 sequence、previous/current hash 和 canonical event payload；打开已有 trace 时校验完整 chain，损坏时抛出明确 corruption error。

Trace event 描述 node kind、phase、parent、时间、metadata、content descriptor、usage/cost 和 error。`TraceTreeProjection` 从 event stream 构造父子树；projection 不是新的持久 authority。

## Artifact store

`events` mode 只保留 content digest、byte size 与 media type。`events_and_artifacts` mode 可以把清洗后的正文写入 `artifacts/sha256/<prefix>/<digest>`，metadata 写入独立目录；重复内容按 digest 复用。

`TraceRecorderFactory` 创建 recorder 时校验 event file 与 artifact roots containment 于 canonical home，并拒绝这些 storage path 上已有的 symlink component。Artifact locator 只由 digest 派生；`FileArtifactStore` 本身不在每次 `put()` 时重复做全路径 symlink walk。读取 artifact 时重新验证 digest 与 size，内容与 locator 不一致产生 integrity error。

## Recorder lifecycle

```text
factory.create(sessionId, ownerGeneration)
  -> startRun
  -> record Agent events
  -> startModel / finishModel
  -> startTool / finishTool
  -> record context/usage/cost metadata
  -> finishRun | failRun | interruptRun
```

Recorder 对输入运行安全清洗，限制 metadata 为标量，并用 content descriptor 隔离正文。Tool result overflow 也可以通过 artifact adapter 保存大结果，但 artifact ref 仍不等于 command attempt receipt。

## Failure policy

`best_effort` 在写入失败后把 recorder 标记 degraded、发送 bounded diagnostic，并允许 Agent 主路径继续；后续 trace 不能伪造为完整。`fail_closed` 把记录失败提升为 `TraceRecordingError`，阻止要求完整审计的运行继续。

两种策略都不允许 trace failure 修改 Session owner/driver state。相反，Session Store/receipt 失败必须按其自己的 fail-closed 规则处理，不能由 best-effort trace 吞掉。

## Usage 与 cost

usage/cost 同时保留数值和 source，例如 provider、metered、estimated 或 unavailable。缺失值保持 unavailable，不写成零；共享进程资源的估算也不能伪装为精确 per-Session 指标。

## 稳定边界

- 当前实现是本地 store 与 projection，不包含 OpenTelemetry/OTLP、Opik、Langfuse、remote exporter 或 durable outbox。
- `TelemetryExporterPort` 与 control telemetry schema 只是被动 contract；当前标准组合没有为它注册 exporter backend。
- Trace tree 可以关联 parent/child Agent 观测，但不替代 bounded-subagent durable graph。
- recording 打开不自动授权保存 secret；正文仍需经过 redaction，credential/token 不进入 artifact。
