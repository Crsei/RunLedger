# Phase 03：本地 Trace Store 配置与生产 Composition

## 状态

implemented in current worktree。配置、canonical locator、per-run recorder factory 与标准 CLI composition 已接线；Opik、网络 exporter 和 outbox 不属于本阶段。

## 用户级配置

唯一配置 authority 是 `<runledgerHome>/settings.json`：

```json
{
  "recording": {
    "mode": "off",
    "failurePolicy": "best_effort"
  }
}
```

- `mode`：`off | events | events_and_artifacts`；默认 `off`；
- `failurePolicy`：`best_effort | fail_closed`；默认 `best_effort`；
- 不接受 workspace recording、项目级 `.runledger/`、CLI flag、额外环境变量或任意 Store 路径；
- `RUNLEDGER_DIR` 仍只是唯一用户级根覆盖；配置在 CLI 启动时解析一次并以 digest 绑定到 trace root event。

## 模式与失败语义

- `off`：不构造 recorder，不创建 trace 文件；
- `events`：只写 `events/YYYY/MM/DD/<traceId>.jsonl`，正文安全清洗后只记录 `digest_only` descriptor；
- `events_and_artifacts`：另外写 `artifacts/sha256/<prefix>/<digest>` 与 `artifact-metadata/sha256/<prefix>/<digest>.json`；用户在 canonical settings 中显式开启后，标准 CLI 同样启用该模式；
- `best_effort`：Artifact 故障降为 digest-only；Event Store 故障后停用本 run 的后续 trace/Artifact 写入并让 Agent 继续；
- `fail_closed`：关键写入失败抛出 `TraceRecordingError`，阻止后续模型或工具执行；
- 路径逃逸与 symlink 拒绝不受 `best_effort` 放宽。

每次 `Agent.prompt()` 通过 `TraceRecorderFactory` 创建独立 trace。secret、credential、auth header、完整 env 和 private reasoning 在 digest 或 Artifact 生成前清洗。

## 延后安全接线

当前需求只要求用户显式开启本地记录，不要求 Artifact 正文写入依赖尚未落地的 PermissionEngine、Approval 或 Sandbox。composition 不预设布尔 capability，也不把三者伪装成已实现的授权收据。

待这些能力有明确的策略、receipt 和执行边界后，再由对应专项计划定义正文持久化授权、拒绝语义和审计关联，并以独立测试先行变更接入；在此之前不阻断 canonical user settings 明确选择的 `events_and_artifacts`。

## 验收

- settings load/save/default/invalid/workspace authority tests；
- off/events/events-and-artifacts、标准 CLI Artifact 模式、per-run factory、配置 digest 与 canonical UTC locator tests；
- Event/Artifact failure policy、CAS、tamper、symlink/path containment 和 redaction tests；
- `npm run check`、`npm test`、`npm run build`、`git diff --check`。
