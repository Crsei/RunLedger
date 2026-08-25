# Telemetry / OpenTelemetry 模块

本模块记录把 oh-my-pi 的 OpenTelemetry 使用方式移植到 RunLedger 的计划与状态。

## 文档

| 文档 | 内容 | 状态入口 |
|---|---|---|
| [`01-telemetry-port-plan.md`](01-telemetry-port-plan.md) | oh-my-pi `06aecdd5` v17.2.15 telemetry 移植：GenAI semconv 插桩（invoke_agent / chat / execute_tool / handoff / oneshot）、run 级聚合、OTLP trace/log/metric 导出、env 契约与测试 | planned，未开始 |

## 与其它模块的边界

- `runtime/trace/`：本地审计 trace store（Event Store + Artifact Store + recorder，`recording.mode` authority）。OTEL 是外部可观测性出口，两者不共享 ID、不互相依赖；本地记录 authority 不因 OTEL 启用而改变。
- `runtime/trace/phase-04-opik-exporter-tree.md`：Opik exporter 计划（独立专项，未开始）。OTEL 与 Opik 是两条独立投递路径，本模块不触碰。
- `AGENTS.md` §1.3：本模块实施后移除「OpenTelemetry / metrics」显式不实现项（RBAC / 多租户保留）。
