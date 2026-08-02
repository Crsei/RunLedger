# Phase 01：Event Store、Artifact Store 与 Trace Tree 基础

## 目标

建立可独立测试的持久化事实层。生产路径使用注入的 canonical user-home layout；测试使用临时目录。当前阶段不调用网络、不引入 Opik SDK、不修改 agent-loop 的生产写入路径。

## 实现内容

- `src/runtime/trace/types.ts`：Trace event、ArtifactRef、usage/cost、tree node 的严格类型；
- `src/runtime/trace/event-store.ts`：单文件 append-only event chain、sequence、previous hash、current hash、replay 和 corruption rejection；
- `src/runtime/trace/artifact-store.ts`：SHA-256 CAS、metadata、原子写入、读取校验与 dedupe；
- `src/runtime/trace/tree.ts`：按显式 `nodeId/parentNodeId` 重建树，terminal event 更新节点；
- `tests/runtime/trace/`：先写 RED 测试，再实现最小行为。

## 当前不做

不接旧 `LedgerSink` 双写，不做旧 session 兼容 reader，不把 prompt/tool 正文写入 event，不实现 Opik delivery 或 TUI。

## 当前实现

- `JsonlTraceEventStore` 已提供 append-only sequence/hash chain、并发 append 串行化、replay 和篡改/断链拒绝；
- `FileArtifactStore` 已提供 SHA-256 CAS、原子写入、dedupe、metadata、读取完整性和 digest/path containment 校验；
- `TraceTreeProjection` 已按显式 parent ID 重建 terminal node 状态并保留 orphan；
- focused tests 已覆盖并发 append、replay/tamper、CAS dedupe/tamper/path escape 和 tree/orphan。

## 完成门槛

Event append/replay、hash tamper、并发 append、CAS dedupe/read/tamper、树重放和 orphan handling 测试通过；当前门槛已满足，完整验证随 Phase 02 变更继续执行。
