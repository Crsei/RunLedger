# RunLedger Agent Runtime Trace / Opik 总体实施计划

## 1. 目标与事实源

一次 Agent run 对应一个 Opik Trace；Turn、模型请求、工具调用、工具 attempt、内部工具模型和 child Agent 通过 `parentSpanId` 组成树。Opik 只做 projection，不能替代 RunLedger Event Store、Artifact Store、费用 projection 或安全 receipt。

当前工作树已补齐本地 durable Event Store、CAS Artifact Store、安全清洗边界、runtime recorder 和用户级 recording composition。Opik 仍只是后续 projection。

固定决策：使用 `opik@2.2.13`；完整业务原文先剔除安全字段，Event Store 只存 bounded metadata/ref，Artifact Store 存完整安全清洗正文；Opik payload 有界，超限只发送 preview + ArtifactRef；Opik 采用 optional + durable outbox，不阻断 Agent。

## 2. 记录模型

| RunLedger | Opik | 父节点 |
|---|---|---|
| run/session invocation | Trace | root |
| agent | `general` Span | Trace/parent agent |
| turn | `general` Span | Agent |
| model request | `llm` Span | Turn |
| logical tool call | `tool` Span | Model |
| tool attempt/retry | `tool` Span | logical tool |
| internal tool LLM | `llm` Span | tool attempt |
| child Agent | `general` Span | parent Agent |
| verification/sandbox | `guardrail`/`general` Span | Agent/Tool |

每个节点保留 RunLedger ID、source event range、ArtifactRef、status、started/finished、monotonic duration、usage、cost 和 error outcome。retry 使用新 attempt 节点；并发关系只由显式 ID 关联，不按时间猜父子。

## 3. 阶段顺序

1. Phase 01：Event Store、CAS Artifact Store、redaction 基础和 replay tree；
2. Phase 02：model/tool/context/agent recorder 与 canonical event 接线；
3. Phase 03：用户级 recording 配置、canonical Store locator、失败策略和 production composition；
4. Phase 04：Opik transport、outbox、delivery reconciliation 和 CLI/TUI tree；
5. 最后才在 Security enforcement、Permission/Approval/Sandbox receipt 都可用后打开生产 Opik。

## 4. 验收

- Event Store 崩溃后可按 cursor/hash replay，且不依赖 Opik；
- Artifact Store 可读取完整安全清洗业务上下文；
- tree live/replay 结果一致，父子、retry、并行、child Agent 不丢失；
- 节点显示 input/output token、cache/reasoning token、USD、duration、TTFT、retry 和错误；
- Opik 401/413/429/5xx/timeout/重复投递只影响 exporter 状态，不影响 Agent；
- secret、auth header、完整 env、credential、private reasoning 永不进入 canonical event 或 Opik；
- `npm run check`、`npm test`、`npm run build` 和 focused trace tests 全绿。
