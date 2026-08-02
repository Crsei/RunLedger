# Phase 04：Opik Exporter、Durable Outbox 与展示

## 状态

planned。本阶段未开始；本地 Event Store、Artifact Store 和 recording 配置不依赖 Opik，也不会联网。

## 目标

以 `opik@2.2.13` 为固定实现依赖，把 trace projection 投递到 Opik，并提供本地可重建树查询。

## 实现内容

- `OpikTransportPort`：封装 SDK generated trace/span REST resources；不把 SDK batch queue 的 flush 完成当作 durable ACK；
- `OpikExporter`：写本地 outbox 后批量发送，记录 `spooled/delivery_pending/acknowledged/retry_scheduled/reconciliation_required/failed`；
- 稳定保存 Opik trace/span ID 与 RunLedger node ID，重复投递不重复建节点；
- `TraceTreeProjection` 查询 DTO、CLI/TUI 只读展示；
- exporter 使用独立配置与凭据 authority，不改变本地 `recording.mode`。

## 验收

Opik UI 能按 `traceId + parentSpanId` 展示 Trace → Agent → Turn → Model → Tool/Attempt/Child Agent；网络失败、认证失败、超限、限流、超时和进程重启均不会改变 canonical Event Store 结果。
