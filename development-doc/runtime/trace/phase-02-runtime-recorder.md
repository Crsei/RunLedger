# Phase 02：Runtime Recorder 接线

## 当前状态

implemented in current worktree。已实现 `RuntimeTraceRecorder`，并通过 `AgentLoopConfig.traceRecorder` 接入 `runAgentLoop`；Phase 03 再由每次 prompt 创建独立 recorder 的 factory 接入标准 CLI。

## 已实现

- provider 调用前清洗 system prompt、完整 LLM message context 和工具 schema，并按 recording mode 形成 digest-only 或 Artifact descriptor；
- provider stream 完成后记录 model output descriptor、provider usage、reasoning/cache token、USD micros、stop reason 和 monotonic duration；缺失 usage/cost 使用 `unavailable`，不伪造 0；
- agent/turn/tool start/end 复用现有 AgentEvent，工具 input/output 通过同一 redaction 边界处理；Tool 节点显式挂到当前 Model 节点；
- `RuntimeTraceRecorder.finishRun()` 提供幂等 public terminal API；Session-owned
  process 在 output materialization 后映射 finished/failed/interrupted，
  timed-out/killed/lost/uncertain 与 crash takeover 均闭合为可解释终态，且不重连
  旧 PID/PTY；watcher 与 explicit wait 共用同一 terminal task，完成后释放 recorder；
- private reasoning、credential、auth header、env、不可序列化值和 CAS path escape 有 focused negative coverage。

## 尚未实现

- TTFT、retry/attempt 节点、child Agent 和 Permission/Approval/Sandbox receipt；
- Opik exporter/outbox；recorder 目前只写本地 Store，不调用网络。

## 目标

在最终 context 送入 provider 前、模型 stream 结束时、工具授权/执行前后和 Agent spawn/finish 边界追加 canonical trace events。

## 事件

`context.assembled`、`turn.started/finished/failed`、`model.requested/finished/failed`、`tool.requested/started/finished/failed/interrupted`、`tool.usage_recorded`、`agent.spawned/finished/failed`、`cost.recorded/reconciled`。

## 规则

- 模型 usage 优先读取 provider reported；缺失为 `unavailable`，不得记成 0；
- 普通文件/shell/network 工具不虚构 token；内部 LLM 以独立 model span 计量；
- context attribution 不重复加入 billable cost；
- start/end 使用 wall timestamp，duration 使用 monotonic clock，首 token记录 TTFT；
- recorder 只消费统一安全清洗后的 content descriptor；Permission/Approval/Sandbox receipt 尚未实现，当前不把它们设为本地 Artifact 写入前置条件。

## 验收

mock stream、provider error、abort、并行工具、tool retry、工具失败和 child Agent 场景都能 replay 出相同树和 usage/cost projection。
