# Session Audit 阅读模式计划

> 状态：planned，当前只完成设计，不代表 `/audit` 已实现。
>
> 入口：在已经打开的 canonical session 中输入 `/audit`，进入只读调用审计视图。
>
> 关联权威：Trace/Event/Artifact 以 [`../runtime/trace/README.md`](../runtime/trace/README.md) 为准；TUI renderer 迁移以 [`../tui/17-opentui-refactor-plan.md`](../tui/17-opentui-refactor-plan.md) 为准；通用 Runtime contract 仍以 [`../runtime/04-governed-agent-harness-runtime-plan.md`](../runtime/04-governed-agent-harness-runtime-plan.md) 为准。

## 1. 结论

`/audit` 应是当前 session 内的只读阅读模式，不是发给模型的 prompt，也不是新的 audit truth：

```text
opened Session
  -> exact sessionId
  -> matching Trace root events
  -> hash-verified TraceEvent[]
  -> in-memory TraceTreeProjection
  -> optional digest-verified Artifact preview
  -> read-only TUI
```

首版固定以下边界：

- 只阅读当前 `InteractiveSessionController.sessionId`，不接受任意文件路径；
- 仅在当前 turn idle 时进入，形成稳定快照；
- 不调用模型、不执行工具、不修改 session、不写 projection、不联网；
- Event 是调用生命周期与计量事实源，Artifact 只在用户明确展开节点时按需读取；
- `recording.mode=events` 时展示调用树和 digest descriptor，但正文明确显示不可恢复；
- `recording.mode=events_and_artifacts` 时允许阅读安全清洗后的正文；
- `recording.mode=off` 或 session 没有 trace 时展示明确空状态；
- hash chain、Artifact digest 或 metadata 校验失败时显示 corruption，不把部分内容冒充可信结果。

## 2. 当前实现事实与缺口

### 2.1 已有能力

- `InteractiveMode.handleSubmit()` 已拦截 `/provider`、`/model`、`/thinking`、`/clear`、`/quit` 等 slash command；
- `InteractiveSessionController` 已暴露当前 `sessionId`、历史 messages、ledger audit entries 和运行状态；
- `JsonlTraceEventStore` 已校验 event shape、sequence、`previousEventHash` 与 `eventHash`；
- `TraceTreeProjection` 已把 TraceEvent 投影为 Trace → Agent → Turn → Model → Context/Tool 树；
- `FileArtifactStore.read()` 与 `metadata()` 已校验 Artifact digest、size 和 metadata；
- Trace recorder 已记录 duration、Token、费用、stop reason、error 和 content descriptor。

### 2.2 必须先补的缺口

1. `TraceRecorderFactory.create({ sessionId })` 当前收到 `sessionId`，但 local composition 没有把它持久化到 trace root event；不能靠扫描 `agent:<sessionId>` 猜正式关联。
2. `JsonlTraceEventStore.initialize()` 会调用 `mkdir()`，属于可写 store；`/audit` 不能把它当只读 reader。
3. 当前没有 session-scoped Trace 查询 API；TUI 不应直接遍历 `~/.runledger/events`、解析 JSONL 或拼 Artifact 路径。
4. 当前 slash command selector 没有 `/audit`，也没有独立的 audit focus/key layer。
5. OpenTUI 重构仍在 P1 起步阶段；不能新增长期依赖旧 pi-tui 的 audit 组件，然后在 P5 再重写一次。
6. `replayInitialHistory()` 中的 `auditEntries` 是 session ledger 的旧工具条目摘要，不等价于新的 Trace Tree，不能复用为 `/audit` 数据源。

## 3. 数据权威与关联方式

### 3.1 Session → Trace 正式绑定

在 `createLocalTraceRecorderFactory()` 构造 recorder 时，把 factory input 中经过校验的 `sessionId` 写入 trace root 的 bounded metadata：

```ts
metadata: {
  sessionId,
  recordingMode,
  failurePolicy,
  recordingConfigDigest,
}
```

约束：

- `sessionId` 必须通过 current Runtime ID 校验；CLI 路径不得传 `"<no-ledger>"`；
- session binding 只存在于 trace root event，不复制 cwd、session 文件绝对路径或 auth 信息；
- 每次 `Agent.prompt()` 仍创建独立 trace，同一 session 可以关联多个 traces；
- 查询只接受 root metadata 的 exact current format，不根据文件名、时间接近或 agent node display name 猜测；
- 现有缺少 `sessionId` metadata 的 trace 不做隐式兼容。若以后需要导入，另建显式 reindex/import 计划。

### 3.2 初版发现算法

`SessionAuditReader` 从已打开 session 的 header 获得 `sessionId` 和 `createdAt`，只读扫描从 session 创建 UTC 日期到当前日期的 event shards：

1. 验证 `<runledgerHome>/events` 和日期分片没有 symlink escape；
2. 只读每个 trace 文件第一条 root event，筛选 `metadata.sessionId === openedSessionId`；
3. 对命中的文件再读取完整 JSONL 并验证 hash chain；
4. 在内存中构建 tree、summary 和 totals；
5. 按 trace root timestamp 排序，默认最新在前。

初版不写索引。数据量需要优化时，可以在 `projections/` 下新增可重建的 session-trace index，但它只能加速查找，查询结果仍须回到 canonical Event Store 校验。

## 4. 真正只读的查询层

新增独立 read-only API，不复用带 append/mkdir 行为的 writer class：

```ts
interface SessionAuditReader {
  snapshot(input: {
    layout: RunledgerLayout;
    sessionId: string;
    sessionCreatedAt: number;
  }): Promise<SessionAuditSnapshot>;

  artifactPreview(input: {
    layout: RunledgerLayout;
    ref: TraceArtifactRef;
    offset: number;
    maxBytes: number;
  }): Promise<AuditContentPreview>;
}
```

读取边界：

- 只使用 read-only open/read/stat/lstat/realpath，不创建目录、不 chmod、不加 writer lock；
- 不更新 atime 之外的业务状态，不写“最近查看”、projection 或 telemetry；
- path 必须来自 `RunledgerLayout` 和 validated ID/digest，禁止接受用户提供的绝对路径；
- 单个 trace 读取设置大小上限，超限返回 bounded diagnostic；
- Artifact preview 默认最多 64 KiB，按 UTF-8 安全边界分页；
- 读取正文前先校验 digest、size 和 metadata；校验失败不返回正文；
- Artifact JSON 只显示已经持久化的安全清洗版本，不尝试恢复被 redaction 的原值；
- 错误信息不回显 runledgerHome 绝对路径、凭据或原始环境变量。

## 5. 领域 DTO

建议新增纯只读 DTO，TUI 不直接持有 writer/store：

```ts
interface SessionAuditSnapshot {
  sessionId: string;
  capturedAt: string;
  recordingMode: "off" | "events" | "events_and_artifacts";
  traces: readonly AuditTraceSummary[];
  totals: AuditUsageTotals;
  diagnostics: readonly AuditDiagnostic[];
  truncated: boolean;
}

interface AuditTraceSummary {
  traceId: string;
  timestamp: string;
  phase: TraceEventPhase;
  durationMs?: number;
  modelCalls: number;
  toolCalls: number;
  failures: number;
  usage: TraceUsage;
  cost: TraceCost;
  root: TraceTreeNode;
}

interface AuditContentPreview {
  storage: "digest_only" | "artifact";
  mediaType: string;
  digest: string;
  size: number;
  text?: string;
  nextOffset?: number;
  unavailableReason?: "digest_only" | "missing" | "corrupt" | "unsupported_media_type";
}
```

DTO 必须满足：

- immutable/read-only；
- 不包含绝对路径、API key、headers、env 或 private reasoning；
- totals 只聚合 model node 的 billable usage/cost，context/tool node 不重复计费；
- 缺失 usage/cost 保留 `unavailable`，不伪造为 0；
- projection 不把 Artifact body 常驻在 snapshot 中，正文按选中节点独立加载。

## 6. `/audit` 命令语义

在 slash command registry 和 `handleSubmit()` 中注册 `/audit`：

```text
/audit
```

首版不接受参数。行为固定为：

1. command 在 prompt dispatch 前被截获，永远不进入 Agent messages；
2. demo mode 没有 controller/session 时显示 `Audit requires an opened session.`；
3. turn 运行中时显示 `Audit is available when the current turn is idle.`；
4. 保存 editor draft，不清空、不提交；
5. 异步读取 snapshot，期间显示 loading；
6. 成功后打开全屏 audit overlay；
7. 关闭 overlay 后恢复 editor focus 和原 draft；
8. `r` 显式刷新，新 snapshot 原子替换旧 snapshot；初版不 live-tail。

后续可增加 `/audit <traceId>`、过滤和导出，但不进入首版。

## 7. 阅读模式信息架构

### 7.1 宽终端

宽度不少于 100 列时使用双栏：

```text
┌ Session Audit · session_xxx · 2 traces · $0.000232 ───────────────┐
│ Trace tree (45%)               │ Selected node (55%)              │
│ ▼ trace_...  finished  1.2s    │ model: deepseek/v4-flash         │
│   ▼ agent                      │ status: finished · 842 ms        │
│     ▼ turn 1                   │ input 261 · output 77 · cache 640│
│       ▼ model                  │ cost $0.000059                    │
│         context               │ input: artifact_...  [open]      │
│         tool echo ✓ 2 ms      │ output: artifact_... [open]      │
│                                │ error: none                       │
├────────────────────────────────┴───────────────────────────────────┤
│ ↑↓/jk move  ←→/hl fold  Enter details  Tab pane  r refresh  q back│
└────────────────────────────────────────────────────────────────────┘
```

### 7.2 窄终端

少于 100 列时使用单栏 drill-down：

- 第一级：trace 列表和 session totals；
- 第二级：选中 trace 的 node tree；
- 第三级：node details / Artifact preview；
- `Esc` 返回上一级，位于第一级时关闭 `/audit`。

### 7.3 展示字段

- Session header：sessionId、recording mode、snapshot time、trace count、总 duration/Token/cost、diagnostic count；
- Trace row：traceId、phase、开始时间、duration、model/tool/failure 数；
- Model node：provider/API/model、turn、stop reason、duration、input/output/cache/reasoning token、USD micros；
- Tool node：tool name、toolCallId、phase、duration、error code；
- Context node：descriptor type、digest、size；
- Detail pane：parent/child IDs、timestamp、usage/cost source、error certainty、input/output descriptor；
- Artifact preview：只读、可选择文本、分页，redacted 内容原样显示。

不显示：

- auth header、API key、credential、完整 env；
- private reasoning；
- Event/Artifact 的绝对文件路径；
- 未经验证的原始 JSONL 行；
- Opik 状态，因为 Opik 不是本地 audit 的事实源。

## 8. 键位、焦点和 renderer 边界

业务状态先实现为纯 `AuditViewModel`，renderer 只做 projection：

```text
SessionAuditSnapshot
  -> AuditViewModel(selection/fold/pane/preview)
  -> OpenTUI Box + ScrollBox + Text renderables
```

键位：

| Key | 行为 |
|---|---|
| `Up/Down`、`j/k` | 移动选择 |
| `Left/Right`、`h/l` | 折叠/展开树节点 |
| `Enter` | 打开详情或 Artifact preview |
| `Tab` / `Shift+Tab` | 切换 tree/detail pane |
| `g` / `G` | 跳到顶部/底部 |
| `r` | 重新读取稳定 snapshot |
| `Esc` / `q` | 返回上一级或关闭 audit |

约束：

- audit 打开时由独立 input/focus layer 消费上述键位，不能穿透 editor；
- overlay owner 唯一，关闭后恢复原 editor focus；
- Ctrl+C/Ctrl+D 不直接摧毁 renderer，沿用 `InteractiveMode` 生命周期 authority；
- renderer 使用自动重绘，不为静态阅读模式开启持续 FPS；
- selectable text 默认开启，便于复制 traceId、digest 和错误信息；
- 宽/窄布局由纯函数根据 renderer width 决定，resize 后保持选中 nodeId，不按旧行号恢复；
- 必须建立在 OpenTUI P3/P5 的 screen/overlay/focus seam 上，不新增长期 pi-tui 专用实现。

## 9. 降级与错误状态

| 场景 | UI 结果 |
|---|---|
| recording `off` | 显示记录已关闭，并给出 canonical settings 提示；不创建目录 |
| 无匹配 trace | 显示当前 session 尚无 trace |
| `events` mode | tree/usage/cost 可读，正文显示 `digest-only` |
| Artifact best-effort 降级 | 对应节点显示 digest-only，其余节点正常 |
| Event hash chain 损坏 | 整个 trace 标记 corrupt，不参与 totals |
| Artifact digest/metadata 损坏 | 该 preview 拒绝显示，tree 仍可读 |
| 某个 trace 文件不可读 | diagnostics 中列出 bounded 相对 locator，其他 trace 继续 |
| 扫描/文件大小超过预算 | snapshot 标记 truncated，提示缩小范围或后续索引支持 |
| session 正在运行 | 不进入 audit，保持 editor 和运行状态不变 |

## 10. 计划文件边界

建议实现文件：

```text
src/runtime/trace/
  audit-types.ts                 # immutable DTO、diagnostic、preview
  read-only-event-reader.ts      # 无 mkdir/append/lock 的 hash-chain reader
  session-audit-reader.ts        # session binding、shard discovery、tree/totals
  composition.ts                 # trace root metadata 写 sessionId
src/tui/audit/
  view-model.ts                  # selection/fold/pane/preview 纯状态
  presentation.ts                # 宽/窄 snapshot
src/tui/opentui/
  audit-overlay.ts               # Box/ScrollBox/Text + focus/input adapter
src/tui/
  interactive-mode.ts            # `/audit` command 与 overlay lifecycle
tests/runtime/trace/
  read-only-event-reader.test.ts
  session-audit-reader.test.ts
tests/tui/
  audit-view-model.test.ts
  audit-overlay.bun.test.ts
```

不修改：

- Session/Trace/Artifact 的物理根目录；
- recording 配置 authority；
- Agent prompt、tool execution 或 provider 流；
- Opik exporter/outbox；
- Permission/Approval/Sandbox；
- session ledger 和 Event Store 的 durable truth 分工。

## 11. 实施阶段

每阶段遵循 RED → GREEN → refactor，阶段完成前不更新为 implemented。

### N0 · Session binding 与只读 reader

- RED：factory input 的 sessionId 未进入 trace root；
- RED：只读打开不存在的 events 根不得创建目录；
- 实现 exact sessionId root metadata；
- 实现无副作用 JSONL reader、current schema 和 hash-chain 校验；
- symlink、path escape、duplicate eventId、sequence/hash corruption 负向测试。

验收：读取前后目录树、mtime 和 writer lock 状态不发生业务写入。

### N1 · SessionAuditReader 与 totals

- RED：同一天多个 session 的 traces 不能串线；
- 实现日期 shard discovery、root filter、完整 trace validation；
- 实现 tree、orphans diagnostic、model-only usage/cost totals；
- off/events/events-and-artifacts 三模式；
- Artifact preview digest/metadata/64 KiB 分页测试。

验收：一个 session 两次 prompt 可读取两个 traces，另一个 session 的 trace 不出现。

### N2 · Pure AuditViewModel

- RED：tree fold、selection、pane、narrow drill-down 和 refresh replacement；
- 实现稳定 nodeId selection；
- 实现宽/窄 presentation snapshot；
- corruption/digest-only/empty/truncated 状态测试。

验收：不依赖 renderer、文件系统或真实终端即可完整测试导航状态。

### N3 · `/audit` command 与 OpenTUI overlay

依赖：[`../tui/17-opentui-refactor-plan.md`](../tui/17-opentui-refactor-plan.md) P3 主 screen 与 P5 overlay/focus owner 已完成。

- RED：`/audit` 不进入 Agent messages；
- RED：in-flight 拒绝、idle 打开、关闭恢复 editor draft/focus；
- 在 command selector 和 parser 中注册 `/audit`；
- 建立 audit-specific input layer；
- lazy Artifact preview 和 refresh；
- overlay destroy/renderer cleanup。

验收：`@opentui/core/testing` 的真实 frame 在 60/80/143 列下可读，mockInput 验证导航、返回与 focus。

### N4 · 集成与真实 smoke

- mock Agent 在 canonical session 连续执行两次 prompt；
- `/audit` 显示 2 traces、model/tool node、Token/费用和正确父子关系；
- `events` 下正文不可恢复，`events_and_artifacts` 下 preview 可读；
- corrupt Event/Artifact 不导致 TUI 崩溃；
- 真实 PTY 中打开、resize、复制、关闭后继续 prompt；
- 可选 DeepSeek live smoke 只记录统计和 digest，不把 API key 或正文写入测试输出。

## 12. 验证门禁

```bash
npx vitest run tests/runtime/trace/read-only-event-reader.test.ts
npx vitest run tests/runtime/trace/session-audit-reader.test.ts
npx vitest run tests/tui/audit-view-model.test.ts
bun test tests/tui/audit-overlay.bun.test.ts
npm run check
npm test
npm run build
```

人工 PTY 验收：

1. 在同一 session 完成至少两次 prompt，其中包含一次工具调用；
2. 输入 `/audit`；
3. 确认 trace 数、模型/工具节点、Token、费用和状态；
4. 展开 Artifact 并确认 redaction 与分页；
5. resize 到 60/80/143 列；
6. `q` 返回，editor draft 和 focus 保持；
7. 继续发送普通 prompt，session 未被 audit 模式修改。

## 13. 完成定义

- [ ] `/audit` 只读取当前打开的 exact session；
- [ ] command 不进入模型上下文，不产生新的 trace；
- [ ] session-to-trace 关联是 canonical metadata，不依赖猜测；
- [ ] reader 无 mkdir/append/chmod/lock/网络副作用；
- [ ] Event hash chain 和 Artifact digest/metadata 在展示前校验；
- [ ] off/events/events-and-artifacts 三模式语义明确；
- [ ] totals 不重复计费，unavailable 不伪造为 0；
- [ ] Artifact 正文 lazy、bounded、可分页且不恢复 redaction；
- [ ] 宽/窄布局、键位、focus、resize、cleanup 有真实 OpenTUI frame/input 测试；
- [ ] corruption 只降级对应 trace/content，不导致 TUI 或 session 崩溃；
- [ ] `npm run check`、`npm test`、`npm run build` 与 PTY smoke 全部通过；
- [ ] 文档状态只在具备上述证据后改为 implemented。
