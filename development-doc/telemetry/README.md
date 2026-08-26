# Telemetry / OpenTelemetry 模块

本模块记录 RunLedger 的 OpenTelemetry/OTLP 基础能力，以及其上的本地 Coding Agent 流量、内存与 Verified Progress 效率语义计划。Plan 02 当前为 `M0–M3 implemented`；`M4–M5 planned`，M6 的真人视觉/IME 验收仍 pending-human。

## 文档

| 文档 | 内容 | 状态入口 |
|---|---|---|
| [`01-telemetry-port-plan.md`](01-telemetry-port-plan.md) | oh-my-pi `06aecdd5` v17.2.15 telemetry 移植：GenAI semconv 插桩（invoke_agent / chat / execute_tool / handoff / oneshot）、run 级聚合、OTLP trace/log/metric 导出、env 契约与测试 | implemented；状态与验收结果见 Plan 01 状态表 |
| [`02-coding-agent-efficiency-semantic-layer-plan.md`](02-coding-agent-efficiency-semantic-layer-plan.md) | Coding Agent Efficiency Semantic Layer：application payload 流量、Runtime/Session/Managed Process 内存、本地 CLI/TUI 查询，以及 Plan/Step/Attempt/Verification/TDD Verified Progress 效率指标 | M0–M3 implemented；M4–M5 planned；M6 partial/pending-human，状态以 Plan 02 §14 为准 |

## 与其它模块的边界

- `runtime/trace/`：本地审计 Trace Store（Event Store + Artifact Store + recorder）是 traffic/resource observation 的 durable authority；`recording.mode` 仍是唯一启停 authority。
- Session Owner Event Store：Plan/Task/Attempt/Verification/TDD 是行为与 Verified Progress 的 durable authority，即使 `recording.mode=off` 也不能丢失。
- `src/runtime/telemetry/` 的 OTel/OTLP 是外部 projection，不参与本地 replay、verification validity、takeover 或效率重算；Plan 02 不要求 Langfuse/OpenInference/Opik 才能完成第一版生产 DoD。
- `runtime/trace/phase-04-opik-exporter-tree.md`：Opik exporter 是独立专项，不属于 Plan 02 的第一版范围。
