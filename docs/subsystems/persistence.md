# Persistence

Persistence 子系统拥有 canonical RunLedger home、SQLite Session authority、owner-fenced hash-chain events、command attempt receipts、checkpoint cache、ledger replay 和显式 legacy migration。Runtime Trace 文件是相邻观测存储，不属于 Session authority。

源码入口：[`src/runtime/contracts/storage-layout.ts`](../../src/runtime/contracts/storage-layout.ts)、[`src/storage/session-store/`](../../src/storage/session-store)、[`src/runtime/session-runtime/sqlite-ledger.ts`](../../src/runtime/session-runtime/sqlite-ledger.ts)、[`src/runtime/session-runtime/restore.ts`](../../src/runtime/session-runtime/restore.ts)、[`src/runtime/session-runtime/checkpoint.ts`](../../src/runtime/session-runtime/checkpoint.ts)、[`src/runtime/session-runtime/recovery-barrier.ts`](../../src/runtime/session-runtime/recovery-barrier.ts)。

## Canonical home

`RUNLEDGER_DIR` 必须解析为既有绝对目录；未设置时使用用户 home 下的 `.runledger`，默认目录可在首启创建。composition root 只解析一次 `RunledgerLayout`，下层模块接收 locator，不各自读取环境变量或 cwd 猜测存储位置。

| 路径 | 内容 |
|---|---|
| `settings.json` | 用户级 settings 与 recording authority |
| `auth.json` | provider credential store |
| `AGENTS.md` | 用户级 system instruction source |
| `projects/<workspace-key>/settings.json` | workspace 限制与覆盖 |
| `state.db` | Session catalog、owner、events、checkpoint、command/receipt authority |
| `events/<date>/<trace-id>.jsonl` | 可选 Runtime Trace events |
| `artifacts/sha256/...` | 可选 trace/tool overflow content-addressed artifacts |
| `worktrees/` | managed worktree roots |
| `migration-backup/` | 显式迁移产生的 verified archive |

Runtime 文件默认采用限制性权限。layout 只负责绝对路径拼接；各 store/factory 必须在自己的 I/O 边界执行 containment、symlink 与 mode 检查，不能把 layout object 的存在当成统一验证。`state.db` 自身拒绝 symlink 和过宽权限。

## SQLite authority

Session Store 的逻辑表分为 catalog/control、owners、session events、checkpoint cache、commands 和 attempt receipts。store header 先于 owner discovery 校验；标准 CLI 会把 binary 迁移窗口内的旧 schema 顺序迁移到 current。版本超出兼容窗口、format digest 不匹配、结构损坏、migration 失败或处于 migration-blocked 状态时 fail closed。

Session catalog 保存 workspace/repository identity、source locator、settings digest、harness profile 与可选 worktree locator 等 row authority，也保存 status、head sequence、driver revision、title 和 checkpoint pointer 等投影/指针。后者可由事件重建或仅用于加速，但不能据此把整张 catalog 都称为 cache；event/receipt 仍是 replay 与副作用结算的事实来源。

## Event append

每个 `session_events` 记录 `sessionId`、单调 sequence、event id、owner generation、event type、canonical payload、previous/current hash 与时间。append 在一个 SQLite transaction 中完成以下检查和写入：

1. owner row 仍精确匹配 runtime id 与 generation；
2. expected previous hash 与当前 head 一致；
3. 新 sequence 紧跟 head；
4. event insert、head/status/driver projection 一起提交。

任何一步失败都不能留下部分 append。Event hash 保护顺序与内容完整性，但不替代 filesystem 权限或 credential redaction。

## Ledger adapter 与 replay

`SqliteLedgerSink` 把 Core 的 message/turn/tool/agent/config/task entries 编码为 `ledger.*` Session events。`restoreSession()` 先读取已经过 chain 验证的 Session events，并校验 checkpoint cache 自身的 digest/schema/boundary/source-sequence 对应；它不会额外证明 checkpoint 与 durable head、event hash、owner generation 或 receipts 相容。领域 replay 再恢复 Agent messages、runtime selection 与 audit entries。

Session Runtime 发出的 owner、driver、recovery、workspace、process、extension 和 policy 事实也进入相同 Session event stream。每个领域负责自己的 event payload 与 projector；不要另建一条竞争的“真实 session log”。

## Command 与 attempt receipt

Mutation command 先记录稳定 request digest。可能产生副作用的操作经 `beginAttempt()` 记录 `started`，完成后写入 committed/rejected/interrupted 等 terminal receipt，并可附 result/evidence digest。

`started` 没有 terminal receipt 表示 outcome unknown，而不是自动失败。crash takeover 用这些未决记录打开 recovery barrier；用户或 verifier 做出显式决策后才恢复 mutation admission。

## Checkpoint

Checkpoint 在模型/工具前后、turn 完成和 pause 等定义 boundary 写入。descriptor 记录 source sequence 与 snapshot digest；当前校验只覆盖 cache 自洽，不比较 durable head、event hash、owner generation 或 receipts。

模型/工具/turn boundary 写入 `replayReady=false` cache；只有 orderly pause 写入的 `replayReady=true` checkpoint 当前可以作为领域 replay seed，其余候选会退回 genesis 全量 replay。Checkpoint 是可删除的 acceleration cache；删除全部 checkpoint 后仍须能从 genesis events/receipts 重建，cache 不授予 owner、driver、tool 或 recovery authority。

## JSONL 与迁移边界

Runtime 层仍保留 `MemoryLedger`/`JsonlLedger` 与旧 SessionManager，主要供测试、示例和 legacy Host 使用；SQLite migrator 直接解析 canonical JSONL 文件，不以这些类作为输入 adapter。标准 CLI 的当前 Session authority 是 SQLite，不会因为发现旧 JSONL 自动 fallback。

迁移分为两条显式流程：`runledger migrate --source <path> --confirm-delete` 把外部 legacy source 搬入 canonical JSONL home，验证后逐项删除已确认 source；`runledger migrate session-store --confirm-archive` 只把 canonical JSONL sessions 导入 SQLite，验证后原子移动到 `migration-backup/session-store/<manifest>`，物理删除还要另行执行 `runledger storage prune-legacy --manifest=<digest> --confirm-delete`。根外 JSONL、旧项目 `.runledger` 或历史 sessionDir 不能直接进入第二条流程，也不能作为 active Session 打开。

## 与 Runtime Trace 的关系

Runtime Trace 记录模型、工具、context、usage、cost 与 artifact 的观测树；它有独立 JSONL hash chain 和 CAS。Trace 写入失败按 recording failure policy 处理，但 trace event 不能恢复 owner/driver，也不能证明副作用已 settle。详细语义见 [trace.md](trace.md)。
