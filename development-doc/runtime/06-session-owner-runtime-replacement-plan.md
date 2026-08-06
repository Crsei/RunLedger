# Session Owner Runtime 替代计划

> 状态：**R0 contract freeze 已完成；R1 SQLite foundation 已完成（2026-08-07）；R2 起实施未开始**
> 建立日期：2026-08-07
> 准入修订：2026-08-07 已纳入 offline-only schema migration、external-effect recovery barrier、attachment-count lifetime、100ms SQLite busy 上限、connection-scoped driver、candidate-before-cutover、legacy archive 与 checkpoint-cache 八项阻塞/收紧要求。
> 目标分支：`session-owner-runtime`
> 当前实现基线：`563b21c`；生产仍运行 [`05-multi-client-background-terminal-refactor-plan.md`](05-multi-client-background-terminal-refactor-plan.md) 描述的 workspace-scoped resident Runtime Host。
> 文档权威：本文是 Session Owner Runtime 的唯一替代实施计划。`05` 在切换完成前仍是 current implementation baseline，切换完成后只保留为历史输入，不再授权新增 daemon、machine leader、Unix Socket、Named Pipe 或 Host lifecycle 行为。
> 上位公共合同：[`04-governed-agent-harness-runtime-plan.md`](04-governed-agent-harness-runtime-plan.md)。本文只拥有 SessionStore、SessionRuntime、SessionOwner、RuntimeServer、Client 及其生产切换行为。

## 0. 决策摘要

RunLedger 从机器或 workspace 级 resident Host 改为 session-scoped embedded runtime：

```text
Client process
├── UI / CLI adapter
└── Embedded SessionRuntime (only when this process owns the session)
        │
        ├── 127.0.0.1:<ephemeral-port>
        └── <runledgerHome>/state.db
```

目标基数固定为：

```text
Machine: Runtime = 0..N
Session: Owner Runtime = 0..1
Runtime: Attached Clients = 0..N during startup/shutdown, 1..N while serving
```

架构原则固定为：

1. Runtime 是 session-scoped，不是 machine-scoped 或 workspace-scoped。
2. 一个 Session 同一时刻最多有一个 active owner。
3. 一个 owner 可服务多个 attached clients；这些客户端观察和操作的是同一个 SessionRuntime，不是多份状态副本。
4. Runtime 生命周期跟随该 Session 的 attachment count，而不是 owner 的本地 UI；Session 生命周期跟随 durable storage。
5. ownership、generation、heartbeat、durable session state 和 command receipt 进入同一个 SQLite；传输只使用 localhost TCP。
6. Event + Receipt 是 authority；checkpoint 只是可删除、可重建的 acceleration cache。
7. generation 是不可省略的 durable-write fencing token；它不能 fence filesystem、Git、subprocess、MCP、network 或其他外部副作用。
8. crash takeover 必须先进入 `RECOVERY_REQUIRED`，完成旧副作用核验或获得显式人工继续 receipt 后才能开放新副作用。
9. 所有 SQLite structural migration 都是 offline-only：必须先阻止新 claim，并证明零 active Session Owner。
10. 第一版明确不实现 machine daemon、后台常驻、平台专用 IPC、hot migration 或 token-level resume。

本文不是在现有 Runtime Host 外再增加一层 SessionLease。目标是删除 machine/workspace leader 及其 lifecycle，把唯一并发仲裁收敛为 SQLite 中的 `session_owners` 行和 `generation` 条件写。

## 1. 当前基线与替换边界

### 1.1 当前 HEAD 的事实

当前生产入口和持久化仍具有以下形态：

| 当前能力 | 当前入口 | 替换结论 |
|---|---|---|
| workspace-scoped Host connect-or-spawn | `src/cli/runtime-host-production.ts`、`runtime-host-composition.ts` | 删除；Client 按 session discover/attach/claim |
| resident Host 进程 | `src/cli/runtime-host.ts`、`runtime-host-service.ts` | 删除独立 Host 启动面；composition 嵌入普通 Client 进程 |
| Unix socket / peer attestation | `runtime-host-transport.ts`、`linux-peer-attestor.ts`、native helper | 删除；只保留 loopback TCP + per-generation bearer handshake |
| workspace Host election/writer lease | `src/storage/host/{startup-election,writer-lease}.ts` | 删除；SQLite `BEGIN IMMEDIATE` + owner generation 取代 |
| endpoint/build/shutdown lifecycle | `src/storage/host/**`、`host-command.ts` | 删除 machine/workspace Host 运维面 |
| JSONL SessionManager + lockfile | `src/storage/session-manager.ts`、`src/runtime/ledger/jsonl-ledger.ts` | 生产写入迁移到 SQLite；JSONL 只作为显式一次性迁移 source |
| Host command/query/subscription | `src/runtime/host/**`、`src/cli/runtime-host-*.ts` | 保留有界协议、receipt、cursor、driver 语义，改成 session scope |
| managed process / PTY / output | `src/runtime/process/**`、`src/storage/process/**` | 保留领域能力，owner 从 Host 改为 SessionRuntime；不得变成全局 manager |
| Extension、MCP、Hook、Skill | `src/extensions/**` | 每个 owned SessionRuntime 自己装配；不共享连接或进程 |
| Security/Worktree/Gateway | `src/security/**`、`src/worktree/**` | 保留 fail-closed final leaf；fence 改绑 `sessionId + generation` |
| Trace/Event/Artifact | `src/runtime/trace/**` | 保留审计与 CAS；owner generation 成为统一归属键 |

当前没有 `src/daemon/` 目录，但 `src/cli/runtime-host.ts` 实际承担 resident Host/daemon 角色。替换不能只改名；独立进程启动、全局 discover、Host 运维命令、socket、peer helper、build handover 和 workspace writer lease 都必须从生产路径消失。

### 1.2 保留的治理语义

本次简化只改变 runtime placement 和 ownership scope，不降低以下边界：

- 同一 Session 仍只有一个 canonical writer；
- mutating client 仍受 driver/observer fence；owner 与 driver 是两个概念；
- command 仍使用 stable command ID、request digest、intent/receipt 与 `uncertain_outcome`；
- subscription 仍有 cursor、bounded replay、dedupe、ACK/backpressure 与 `resync_required`；
- Permission、Approval、Sandbox、Gateway、containment 决策仍位于最终执行叶；
- public DTO 仍不得暴露 PID、raw command、cwd、env、absolute path、credential 或 private reasoning；
- process output、Artifact、Trace 和 session event 的保存/脱敏策略不因 transport 改动而放宽；
- worktree/path 必须继续经过现有 platform adapter、containment 和 cold-resume 重验。

### 1.3 明确删除的复杂度

切换完成后不得残留生产 fallback：

- machine/workspace leader election；
- resident `runledger-daemon` 等价进程；
- Unix Domain Socket、Named Pipe 和平台专用 discovery；
- `host list|status|stop|restart`；
- Host build handover、maintenance target、drain-and-restart；
- startup lock、endpoint JSON、workspace Host writer lease；
- “最后一个 client 退出但 runtime/process 继续执行”；
- 健康旧 owner 存活时的 force takeover；
- 新旧 Session store 双写、fallback reader 或隐式迁移。

## 2. 目标模块与依赖

MVP 只建立五个架构模块：

| 模块 | 唯一职责 | 禁止承担 |
|---|---|---|
| `SessionStore` | SQLite schema、session event/checkpoint/receipt、owner row、投影查询、事务迁移 | Agent、TCP server、模型/工具执行 |
| `SessionRuntime` | 恢复并执行一个 Session 的 Agent/model/tool/process/MCP/worktree 生命周期 | machine discovery、跨 Session 调度 |
| `SessionOwner` | claim、publish、heartbeat、release、takeover、generation fence | 通用分布式 lease、后台 supervisor |
| `RuntimeServer` | 单 Session 的 localhost TCP handshake、command/query/subscription、多 client fan-out | durable truth、全机管理 API |
| `Client` | resolve/create/open/fork、probe/attach/claim、TUI/IDE/Web facade、owned runtime handles | 直接写 session event、绕过 owner 执行工具 |

依赖方向固定为：

```text
Client
  ├── attach over localhost TCP ───────> RuntimeServer
  └── if claim succeeds ───────────────> Embedded SessionRuntime
                                               │
                                      SessionOwner + SessionStore
                                               │
                                      <runledgerHome>/state.db
```

`RuntimeServer` 只能服务其构造时绑定的一个 `sessionId + generation`。同一 Client 进程可以因 `/new`、多 tab 或被其他客户端 attach 而暂时持有多个 `OwnedSessionHandle`，但这只是 Client 内的生命周期集合，不得演变为 machine-wide Runtime registry 或独立 manager service。

## 3. 身份与术语

| 名称 | 含义 | 是否持久化 |
|---|---|---|
| `sessionId` | durable Session identity | 是，永久 |
| `runtimeId` | 当前进程内某个 SessionRuntime 实例 | 是，仅 owner record/audit |
| `generation` | 每次成功 claim 单调递增的 fencing token | 是，永久不回退 |
| `owner` | 当前持有 `sessionId + generation` 写权限的 SessionRuntime | 是 |
| `clientId` | 一次 client identity | connection/receipt 所需时持久化 digest |
| `connectionId` | 一条 TCP connection | 否，只有 bounded runtime state |
| `driver` | 当前 connection 上被允许发起交互 mutation 的 attached client | owner 内存中有效；只持久化 revision 与审计事件 |
| `subscriber` | 只消费 snapshot/event 的 attached client | cursor/ACK 可持久化，socket 不持久化 |

硬规则：

- owner 不自动等于永久 driver；driver authority 是 connection-scoped，本地首个 client 可以按现行策略 claim，后续 transfer 仍显式发生；
- driver connection 断开立即令 `driver = NONE` 并递增 `driverRevision`；owner crash/takeover 后也从 `NONE` 开始，旧 `clientId` 只能作为 audit evidence，不能自动恢复 authority；
- attached client 不持有 SessionStore writer capability；所有 mutation 走 owner server；
- `generation` 不替代 authorization、driver revision、domain revision 或 tool execution receipt；它只证明写入来自当前 owner；
- workspace lease、credential lock 等资源锁不能复用 Session owner 概念。哪个资源以后确实发生竞争，再为哪个资源建立窄作用域协调。

## 4. SQLite：唯一 Session durable state 与 ownership authority

### 4.1 保存位置与实现选择

沿用 canonical `RunledgerLayout`，新增：

```text
<runledgerHome>/state.db
<runledgerHome>/state.db-wal
<runledgerHome>/state.db-shm
<runledgerHome>/migration-backup/session-store/
```

默认仍是 `~/.runledger`，不引入第二个 `~/.agent` home。`RunledgerLayout` 新增 `database`、`worktrees` 与 `migrationBackups` 字段；现有 Artifact/CAS、private process output 和 Git worktree 可以继续是 filesystem content store，但它们只由 SQLite 保存 digest/locator/receipt，不参与 runtime discovery 或 leader election。

首版采用 Node 22 自带 `node:sqlite`，不增加 native npm database dependency。由于 `DatabaseSync` 会同步阻塞调用线程，MVP 只允许短 statement/transaction，并把单次 SQLite blocking wait 限制在 100ms。遇到 `SQLITE_BUSY` 后先返回 JS event loop，再通过 `setTimeout()` + bounded exponential backoff/jitter 重试；任何请求都不得在同步调用中等待数秒。

`SessionStore` 内部串行化本进程短事务，流式 token 先按有界 chunk 合并再写；不得在 event loop 中执行无界查询、全库 scan 或大 blob materialization。SQLite WAL 只提供 reader/writer 并行，不改变“全 DB 同时最多一个 writer”；这个全局 serialization point 对个人开发者 MVP 可接受，但必须纳入 R6.5 latency/backpressure 证据。只有实测显示 100ms 上限仍导致 UI/TCP/heartbeat 明显 stall，才另立计划把 DB adapter 移入 Worker Thread，不能在业务模块散落 worker 调用。

数据库打开时固定：

```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous = FULL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 100;
PRAGMA trusted_schema = OFF;
```

POSIX 上 `<runledgerHome>` 继续要求 `0700`，`state.db*` 要求 `0600`；Windows 只在获得真实 ACL runner 证据后声明等价保护。路径 symlink/no-follow、owner/mode、文件替换和 DB identity 必须 fail closed，不以“localhost”替代本地数据保护。

### 4.2 Structural schema compatibility 与 offline-only migration

每个 binary 编译时固定：

```text
STORE_SCHEMA_MIN
STORE_SCHEMA_MAX
STORE_SCHEMA_CURRENT
```

Client 在 owner discovery 前只能读取冻结的 schema header/`store_control`。若 DB version 高于 `STORE_SCHEMA_MAX`，立即返回 `store_schema_too_new`；低于 `STORE_SCHEMA_MIN` 且当前 binary 不拥有对应 migration 时返回 `store_schema_too_old`。protocol negotiation 不能覆盖 storage incompatibility。

所有 structural migration 必须按以下 offline protocol 执行：

```text
BEGIN IMMEDIATE
→ store_control.admission = migration_blocked
→ verify zero starting/running/recovery_required/stopping owners
→ COMMIT admission gate
→ BEGIN EXCLUSIVE
→ re-verify zero active owners and unchanged migration epoch
→ apply one transactional structural migration
→ update schema version/digest
→ store_control.admission = ready
→ COMMIT
```

硬规则：

- 每个 claim transaction 必须先验证 `store_control.admission = ready`；migration gate 激活后新 Session 只能得到 `upgrade_requires_sessions_closed`，不能 attach/claim 后再升级；
- migration 发现任何 active owner 时必须恢复 `ready` 并退出，不能把 stale heartbeat 当作零 owner、不能 kill/takeover owner；crash/stale Session 必须先由兼容 binary 完成正常 takeover、`RECOVERY_REQUIRED` 收口和 clean release；
- migration 进程崩溃时 SQLite DDL transaction 回滚，而 persisted `migration_blocked` 保持 fail closed；只能由同一兼容 migration tool 显式 resume/abort；
- structural schema 在首版冻结后尽量冻结。新增 Agent feature 优先使用版本化 `event_type`、`payload_json`、receipt payload、snapshot/cache format 和 capability，而不是新增/修改 column；
- 零 active owner 的真实多进程证明、旧 binary `store_schema_too_new` 和 claim-vs-migration race 都是 R1 阻塞门禁。

### 4.3 首版逻辑 schema

下面是逻辑 schema；实施时以版本化 migration 和 contract tests 冻结 exact SQL：

```sql
CREATE TABLE schema_meta (
  schema_version INTEGER PRIMARY KEY,
  format_digest TEXT NOT NULL,
  applied_at_ms INTEGER NOT NULL
);

CREATE TABLE store_control (
  singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
  admission TEXT NOT NULL,
  migration_epoch INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  CHECK (admission IN ('ready', 'migration_blocked'))
);

CREATE TABLE sessions (
  session_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  repository_id TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  head_sequence INTEGER NOT NULL DEFAULT 0,
  current_checkpoint_id TEXT,
  last_driver_client_id TEXT,
  driver_revision INTEGER NOT NULL DEFAULT 0,
  worktree_locator_json TEXT,
  settings_digest TEXT NOT NULL,
  CHECK (status IN ('active', 'recovery_required', 'paused', 'completed', 'failed', 'archived'))
);

CREATE TABLE session_owners (
  session_id TEXT PRIMARY KEY REFERENCES sessions(session_id) ON DELETE CASCADE,
  runtime_id TEXT,
  generation INTEGER NOT NULL,
  state TEXT NOT NULL,
  port INTEGER,
  auth_token BLOB,
  heartbeat_at_ms INTEGER,
  owner_started_at_ms INTEGER,
  updated_at_ms INTEGER NOT NULL,
  CHECK (state IN ('unowned', 'starting', 'recovery_required', 'running', 'stopping')),
  CHECK (port IS NULL OR (port >= 1 AND port <= 65535))
);

CREATE TABLE session_events (
  session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL,
  event_id TEXT NOT NULL UNIQUE,
  owner_generation INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  previous_event_hash TEXT,
  current_event_hash TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  PRIMARY KEY (session_id, sequence)
);

CREATE TABLE session_checkpoints (
  checkpoint_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  owner_generation INTEGER NOT NULL,
  boundary TEXT NOT NULL,
  source_sequence INTEGER NOT NULL,
  snapshot_json TEXT NOT NULL,
  snapshot_digest TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  CHECK (boundary IN ('before_model', 'after_model', 'before_tool', 'after_tool', 'turn_completed', 'paused'))
);

CREATE TABLE commands (
  session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  command_id TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  origin_generation INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL,
  PRIMARY KEY (session_id, command_id)
);

CREATE TABLE command_attempt_receipts (
  receipt_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  command_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  origin_generation INTEGER NOT NULL,
  settled_generation INTEGER,
  effect_class TEXT NOT NULL,
  outcome TEXT NOT NULL,
  result_json TEXT,
  result_digest TEXT,
  evidence_digest TEXT,
  created_at_ms INTEGER NOT NULL,
  FOREIGN KEY (session_id, command_id) REFERENCES commands(session_id, command_id) ON DELETE CASCADE,
  CHECK (outcome IN ('started', 'committed', 'rejected', 'interrupted', 'uncertain', 'verified'))
);
```

`commands` 是 immutable intent；`command_attempt_receipts` 只 append，不原地改写旧 outcome。`origin_generation` 表示 intent/attempt 最初由哪个 owner generation 创建；`settled_generation` 表示哪个 generation 最终核验或收口。generation 8 可以追加 receipt 验证 generation 7 的 uncertain attempt，但不得改写它的 origin 或旧 receipt。command current state/final attempt 只是这些记录的 projection。

### 4.4 Authority、projection 与 cache

authority 固定为：

```text
immutable Session identity
+ append-only session_events
+ immutable command intents + append-only attempt receipts
+ external content digest/locator refs
```

`sessions` 中的 mutable status/head/driver/worktree/settings 字段、`turns`、`messages`、`tool_calls`、timeline 和 search index 都是 projection；必须能从 Event + Receipt 确定性重建。`last_driver_client_id` 只用于 audit display，不能授予 driver authority。

command intent、attempt receipt 与引用它的 session event 必须在一个 owner-fenced transaction 中 append，并相互保存 digest/ID；禁止出现“receipt 已提交但 event 永久缺失”或反向孤儿。若 crash 发生在 transaction 外部副作用之后、receipt 之前，则下一 generation 只能追加 `uncertain`/verification receipt，不能猜测 committed。

`session_checkpoints` 只是 acceleration cache：删除全部 checkpoint 后，系统必须仍能从 genesis event/receipt replay 得到相同 Session state，只是更慢。任何 pending approval、Queue item、domain revision、worktree binding、process/tool settlement 或 recovery decision 若无法从 event/receipt 重建，必须先增加 durable event/receipt，禁止把唯一事实偷偷塞进 snapshot。

### 4.5 写入 fence

所有 durable mutation 必须在同一事务中先验证 owner：

```sql
SELECT 1
FROM session_owners
WHERE session_id = ?
  AND runtime_id = ?
  AND generation = ?
  AND state IN ('starting', 'recovery_required', 'running');
```

验证失败返回 typed `owner_fenced`，当前 SessionRuntime 立即：

1. 停止接收新 mutation；
2. abort 当前 model/tool work；
3. 关闭 listener 和 clients；
4. 不再 heartbeat；
5. 不尝试把进程内状态写回 durable truth。

owner mutation transaction 必须使用 `BEGIN IMMEDIATE`，在持有 SQLite writer reservation 后完成上述验证与实际写入，不能先在 transaction 外检查再写。只在 Runtime 构造时检查 generation 不够。event append、checkpoint、command receipt、driver transfer、tool result、process settlement、approval decision、model selection 和 domain revision 每个写入口都必须消费同一个 `OwnerFence`。

generation 只能 fence SQLite durable mutation。它不能停止已经进入 filesystem、Git、shell、Docker、MCP、GitHub API、deploy 或其他外部系统的旧副作用；这部分 correctness 必须由 §7.3 的 recovery barrier 处理，不能在文档或测试中表述为 generation 已解决。

### 4.6 Secret 与本机信任边界

每个 generation 生成 32-byte 随机 `auth_token`，只保存在 mode/ACL 受保护的 SQLite owner row 和当前进程内存：

- 不进入 event、Trace、Artifact、endpoint DTO、debug log、error、crash report 或 TUI；
- handshake 使用 constant-time compare；认证前只允许固定大小 initialize frame；
- generation 变化立即轮换 token；旧 token 永久失效；
- 127.0.0.1 上任何未认证连接都不能 query、subscribe 或触发 reverse request；
- threat model 明确把“同一 OS user 的任意恶意进程”视为已越过本地用户边界；首版不声称能隔离同用户恶意进程。

## 5. Owner discovery、claim 与 takeover

### 5.1 固定时序

候选 owner 必须先绑定 listener，再 publish endpoint，避免数据库指向尚未存在的端口：

```text
Client.open(sessionId)
  │
  ├─ read owner row
  │    ├─ authenticated probe succeeds ──> attach
  │    └─ probe fails ────────────────────> evaluate owner state
  │
  ├─ bind candidate 127.0.0.1:0
  ├─ generate runtimeId + auth token
  ├─ BEGIN IMMEDIATE
  │    ├─ row absent/unowned ─────────────> claim generation + 1
  │    ├─ row changed/healthy ────────────> lose; close candidate; attach/retry
  │    └─ expected stale row still exact ─> takeover generation + 1
  ├─ COMMIT owner state=starting + port + token
  ├─ restore SessionRuntime
  ├─ clean create/release path ─────────> CAS publish state=running
  ├─ crash takeover path ───────────────> CAS publish state=recovery_required
  └─ attach local Client through the same RuntimeServer facade
```

本地 owner Client 也走相同 command/query/subscription facade；不得因同进程而直接调用 controller，避免生产形成 remote/local 两套 mutation path。

### 5.2 并发 claim

`SessionOwner.tryClaim()` 固定使用 `BEGIN IMMEDIATE`：

- claim 首先检查 schema compatibility 与 `store_control.admission = ready`；offline migration gate 优先于任何 owner decision；
- 新 Session 的 generation 从 `1` 开始；
- release 只清空 runtime/port/token 并置 `unowned`，不删除 generation；
- takeover 只允许把读取到的 exact `(runtime_id, generation, heartbeat_at_ms, state)` CAS 到 `generation + 1`；
- loser 关闭自己的 candidate listener 和 token，重新读取 winner 后 attach；
- 单次 SQLite busy wait 最多 100ms；`SQLITE_BUSY` 释放 JS call stack 后用 timer + bounded jitter retry，超过整个 operation deadline 返回 typed `owner_store_busy`，不得回退 JSONL lockfile、flock 或进程内 mutex。

并发证明必须由两个真实 Node 进程争抢同一 DB/session 完成，不能只用同一 Vitest 进程内 Promise 竞争代替。

### 5.3 heartbeat 与健康探测

默认参数先冻结为：

```text
heartbeat interval: 3 seconds
stale threshold:   20 seconds
connect timeout:    1 second
startup grace:     20 seconds
takeover probes:     3 consecutive authenticated failures
probe spacing:       at least 250ms + jitter
retry:              bounded exponential backoff + jitter
```

对非 `unowned` row 的 crash takeover 必须同时满足：

1. heartbeat 已 stale；
2. 对 row 中 exact `127.0.0.1:port` 连续执行 3 次 authenticated initialize/health probe，三次均失败或超时；
3. claim transaction 内 row 仍与 probe 前读取的 runtime/generation/heartbeat/state 完全一致。

显式 `unowned` 可以直接 claim，不需要 stale probe；其他情况仅 heartbeat stale 或单次 probe failure 都不允许 takeover。任一次 authenticated probe 成功都立即 attach/重新读取，不继续抢占；TCP accept 成功但 authenticated health 无响应只记为一次失败。Laptop sleep、debugger pause、CPU stall 和唤醒瞬间因此不会被单次时序抖动误判为 takeover 条件。

### 5.4 heartbeat 丢失与旧 owner 复活

heartbeat 使用：

```sql
UPDATE session_owners
SET heartbeat_at_ms = ?, updated_at_ms = ?
WHERE session_id = ? AND runtime_id = ? AND generation = ?
  AND state IN ('starting', 'recovery_required', 'running');
```

`changes = 0` 等同于 owner 已被 fence。旧 owner 即使 listener 仍能 accept，也不能再提交任何 durable mutation；server handshake 还必须读取/缓存校验当前 generation，并在 fence notification 后主动断开所有连接。

## 6. RuntimeServer 与 Client 协议

### 6.1 Transport

首版 transport 固定为：

- `node:net` TCP；
- 只绑定 IPv4 `127.0.0.1`，端口传 `0` 由 OS 分配；
- 不绑定 `0.0.0.0`、LAN address 或 public interface；
- 不实现 Unix socket、Named Pipe、HTTP、SSE 或 WebSocket；
- 使用当前有界 JSON frame 语义；实施时选择 length-prefixed JSON 或严格 JSONL 后冻结一种 current format，不提供双 parser；
- 保留 `maxFrameBytes`、connection outbox、replay、pre-activation pending、ACK window、reverse waiter、output page 等现有限额。

浏览器/Web UI 以后必须通过单独评审的 localhost HTTP/WebSocket adapter 接入，不能让浏览器直接降低 raw TCP 的认证和 Origin 边界。

### 6.2 Handshake

首个 frame 必须包含：

```text
protocolVersion
sessionId
expectedRuntimeId
expectedGeneration
authToken
clientId
clientCapabilities
```

server 返回当前 runtime/session generation、protocol capability、snapshot cursor 和 driver revision。以下情况全部 typed fail closed：

- session 不匹配；
- generation/runtime 不匹配；
- token 错误或过期；
- protocol 不兼容；
- owner 仍在 `starting`；
- owner 已 `stopping` 或 fenced；
- frame 超限、unknown field、invalid current format。

不同 build 只做 protocol/capability negotiation，不再形成 machine Host build election。健康旧 owner 与新 Client 不兼容时返回 `session_owner_incompatible`，提示用户关闭拥有该 Session 的旧 Client 后从 checkpoint 恢复；新 Client 不得因此强抢健康 owner。

### 6.3 Session surface

RuntimeServer 只暴露一个 Session 的：

- command：prompt、interrupt、approval、driver claim/release/transfer、model/mode/domain mutation、process input/resize/stop；
- query：snapshot、timeline、process/resource/worktree/security status；
- subscription：assistant delta、tool/process/permission/session/turn/error event；
- reverse request：approval、credential/onboarding 等 UI interaction；
- lifecycle：detach、pause request、owner health。

`session.open/create/resume/fork` 不再是 machine Host command。Client 必须先通过 `STORE_SCHEMA_MIN/MAX` compatibility gate，之后才能从只读 `SessionStore` catalog resolve sessionId；fresh create/fork 由受限 SessionStore transaction 创建 durable row，再走统一 owner discovery。Client 不能为了 discover owner 而自动执行 structural migration。

### 6.4 Connection-scoped driver

RuntimeServer 内存中只允许一个 authenticated connection 持有 driver role：

```text
connection A claims driver
→ driver = A
→ durable driver.claimed event increments driverRevision

connection A disconnects
→ driver = NONE
→ durable driver.released event increments driverRevision

owner takeover
→ driver = NONE
→ durable driver.reset_on_takeover event increments driverRevision
```

SQLite 不保存跨 connection 仍有效的 `driver_client_id`。`sessions.last_driver_client_id` 只是 event projection/audit hint；新 connection 即使复用同一 `clientId` 也必须携 expected revision 显式 claim。不得为 driver 再创建 heartbeat、lease、stale timeout 或第二套 takeover protocol。

## 7. SessionRuntime、checkpoint 与恢复

### 7.1 Runtime composition

一个 `SessionRuntime` 只装配一个 Session 的：

- `Agent` / `InteractiveSessionController`；
- canonical event writer、Queue、Trace recorder；
- model/context/plan/memory services；
- Permission/Approval/Sandbox/Gateway；
- session-scoped managed process manager；
- session-scoped Extension/MCP/Hook/Skill snapshot 与连接；
- session worktree binding；
- one `OwnerFence`。

不得把多个 SessionRuntime 再汇总到一个共享 mutable registry 作为 durable truth。Client 可以持有多个 handle，但每个 handle 都拥有独立 runtime composition、server、generation、MCP connections 和 process capacity。

### 7.2 Safe checkpoints

首版只支持以下 checkpoint：

```text
before_model
after_model
before_tool
after_tool
turn_completed
paused
```

checkpoint 缓存可包含 model-visible context、current turn、pending queue、domain revisions、worktree binding、process/tool settlement refs 和 approval state 的 current-format projection，并绑定：

```text
sessionId + ownerGeneration + sourceSequence + snapshotDigest
```

不保存 live JS object、socket、AbortController、stream iterator、PTY handle、MCP client、child process 或 secret。恢复顺序固定为：校验 authority event/receipt → 尝试校验 checkpoint digest/source sequence/cache schema → 命中则从 checkpoint 后 replay → checkpoint 缺失、旧版或损坏则丢弃 cache 并从 genesis replay。只有 event/receipt hash、sequence、schema 或外部 locator authority 损坏才返回 typed corruption/migration error；checkpoint 自身损坏不能改变事实，也不能阻止可验证的 full replay。

### 7.3 Crash recovery policy

SessionRuntime lifecycle 固定为：

```text
STARTING
  ├─ clean create / clean release resume ──> READY
  └─ crash takeover ───────────────────────> RECOVERY_REQUIRED

RECOVERY_REQUIRED
  ├─ evidence proves no unresolved effect ─> READY
  ├─ verification settles prior attempt ───> READY
  └─ user accepts uncertain state ──────────> READY_WITH_UNCERTAINTY
```

每次 crash takeover 无条件先进入 `RECOVERY_REQUIRED`。恢复评估可以在没有任何 in-flight external attempt 时自动形成 `recovery.verified_clean` receipt 并进入 `READY`；只要存在 unresolved side-effect attempt、lost process、unknown MCP/network outcome 或 worktree drift，就必须保持 barrier。

`RECOVERY_REQUIRED` 允许：

- attach/subscribe、读取 snapshot/timeline/diff/receipt/output；
- `recovery.explain` / recovery-scoped question：默认本地投影；若显式调用模型则 tools 为空、只读 recovery context、单独记录 token/cost receipt，不能进入普通 Agent loop；
- 使用明确分类且由 recovery policy allowlist 的只读检查；
- best-effort terminate 上一代受管 process tree；
- 对 filesystem/Git/external service 生成核验 evidence；
- 提交 `recovery.verify`、`recovery.abort` 或显式 `recovery.resume_despite_uncertainty` decision。

`RECOVERY_REQUIRED` 禁止：

- normal prompt admission 和自动 completion follow-up；
- write/edit/bash/process spawn、dependency install、Git mutation、deploy、MCP/network mutation；
- 新 approval 把普通 side-effect 降级为 allow；
- 仅因为新 generation 已取得 DB writer 就进入 `READY`。

barrier 必须同时在 Runtime command admission 和 ExecutionGateway/final leaf enforcement；单靠 TUI 隐藏按钮不构成保护。人工选择继续时必须展示 unresolved attempts/evidence digest，写入 `recovery.resume_despite_uncertainty` event/receipt、principal、reason、origin/settled generation 后才能开放新副作用。

| Crash boundary | 恢复动作 |
|---|---|
| before model call | barrier 核验没有外部 attempt 后可重新发起，但必须记录新的 attempt identity |
| model stream 中 | 旧 partial response 标为 interrupted；不得从 token offset 续写；barrier 收口后才允许新 model attempt |
| after model response | 从 durable response/event 继续，不重复 model call |
| before read-only tool | barrier 复核 capability/effect class 后可按稳定 command/tool identity retry |
| read-only tool running | 根据 canonical effect classification 和 receipt 决定 retry；不能只看工具名字 |
| side-effect tool running | 标为 `interrupted`/`uncertain`，核验外部状态或取得显式人工 decision；默认不重执行且 barrier 不开放 |
| after tool result | 从 durable result 继续，不重复 tool call |
| turn completion | 恢复 idle Session |

所有 retry 都产生新 attempt ID，并引用原 command/tool call；“相同输入”不等于可以无审计重放副作用。

### 7.4 Process / PTY

后台命令只允许在至少一个 client attached 且 owner runtime 存活时运行：

- graceful 最后一个 attachment detach：停止 admission，interrupt model，按 bounded policy settle/terminate process tree，写 checkpoint 后 release owner；
- owner crash：新 owner 不按 PID/port/PTY handle reattach；未 terminal 的 execution 投影为 `lost` 或 `uncertain`，进入 `RECOVERY_REQUIRED`，并保留 output/checkpoint/receipt；
- barrier 内可以用现有 containment evidence best-effort terminate 旧 process tree，但不要求为了自动恢复新建跨平台 supervisor；无法证明停止时继续保持 uncertain；
- containment backend 可继续使用真实平台能力帮助清理 child tree，但它不是 daemon，也不授予跨 runtime reattach；
- process output 可以继续存 filesystem private store，SQLite 保存 cursor/checkpoint/seal/digest refs；
- completion follow-up 仍通过 durable Queue 幂等交付，但 owner 不存在时只保持 pending，直到下次 Session restore。

### 7.5 MCP、Search、Worktree、Credentials

- MCP：每个 SessionRuntime 自己启动和关闭连接；首版无 shared broker。
- Search：首版直接使用 session worktree 中的 `rg`/`fd`/`git`；无 machine index service。
- Worktree：默认 canonical locator 为 `<runledgerHome>/worktrees/<sessionId>`；创建、resume、cleanup 仍经平台 adapter 和 Git evidence。worktree 随 Session 持久存在以便 resume，archive/delete 必须显式确认，不建立 global pool leader。
- Credentials：继续使用当前全局 credential store 及其窄文件锁；不因此创建全局 Runtime。只有真实 refresh race 证据出现后，才允许在 SQLite 增加 resource-specific lock，并单独计划/验收。

## 8. Client 生命周期与产品语义

### 8.1 打开、attach、takeover

`Client.openSession(id)` 对用户始终呈现一个操作，内部依次执行：

```text
resolve durable session
→ probe current owner
→ attach if healthy
→ retry if unhealthy but heartbeat fresh
→ claim if unowned; takeover only after stale + 3 failed probes
→ restore embedded runtime
→ if crash takeover, enter RECOVERY_REQUIRED
→ attach local view through TCP facade
```

create、discover、attach、takeover、recover 共用这一条路径，不提供 direct-controller fallback。

### 8.2 `/new`、`/resume`、`/fork`

- `/new`：先创建新 Session row，再 open；旧 Session 有其他 attached clients 时，其 runtime 可继续留在同一 Client 进程；没有 client 时按 last-detach 规则 checkpoint/exit。
- `/resume`：从 SQLite catalog 选 sessionId，再执行统一 open 流程。
- `/fork`：在一个事务中从 source checkpoint/event range 创建新 sessionId；新 Session generation 独立从 1 开始；worktree/approval/process 不继承活跃句柄。
- 切换 UI 不是 hot migration。旧 runtime 是否继续只由其 attached-client count 决定。

### 8.3 最后一个 Client

首版产品规则固定为：

> Closing the last client pauses this session.

Runtime lifetime follows the Session's attachment count, not the owner UI lifetime：

```text
local UI detaches + remote attachments > 0
→ owner process stays alive in headless-attached mode
→ SessionRuntime/model/tool/process continue

all authenticated attachments == 0
→ pause + checkpoint + settle + owner release + runtime exit
```

本地 `/quit`、关闭一个 tab 或 `/new` 切换只 detach 对应 local view，不能调用 whole-process exit。若该进程仍 owner 某个有 remote attachment 的 Session，它继续运行最小 headless owner loop，只服务既有 Session connections，不新增后台 autostart、detachment 或 machine service；最后一个 remote connection 关闭后立即走下述 shutdown。

最后一个 attachment（包括 owner 的本地 view）关闭时：

1. TUI 对 active turn/process 显示明确警告；
2. RuntimeServer 停止新 admission；
3. 当前模型流被 interrupt；工具按 §7.4 settle；
4. 写 `paused` checkpoint 和 lifecycle receipt；
5. owner row CAS 到 `unowned`，保留 generation；
6. 关闭 MCP、server 和 SessionRuntime。

只有 whole process 被强杀、terminal/OS 终止、不可恢复 fatal error 或机器崩溃时，attached remote clients 才通过断线、stale threshold、连续 probe 和 takeover 进入 `RECOVERY_REQUIRED`；不寻找 Machine Leader。正常 local UI detach 且仍有 remote attachment 时不得人为制造 crash/takeover。

## 9. 目标文件布局与删除清单

### 9.1 新的唯一实现入口

```text
src/
├── storage/session-store/
│   ├── database.ts             # node:sqlite open/pragmas/transaction boundary
│   ├── schema.ts               # exact current schema + migrations
│   ├── schema-compatibility.ts # MIN/MAX/current + offline admission gate
│   ├── session-store.ts        # event/receipt/checkpoint cache/catalog
│   ├── owner-store.ts          # claim/touch/publish/release CAS
│   └── jsonl-migration.ts      # explicit one-shot importer + verified archive
├── runtime/session-owner/
│   ├── types.ts
│   ├── fence.ts
│   └── session-owner.ts
├── runtime/session-runtime/
│   ├── session-runtime.ts
│   ├── restore.ts
│   ├── checkpoint.ts
│   └── recovery-barrier.ts
├── runtime/session-server/
│   ├── protocol.ts
│   ├── runtime-server.ts
│   ├── driver.ts
│   └── subscription.ts
└── cli/
    ├── session-client.ts
    └── embedded-session-runtime.ts
```

命名可以在 R0 contract freeze 时微调一次；一旦 R0 完成，不得再保留 `RuntimeHost`/`SessionOwnerRuntime` 两套同义 public types。

### 9.2 复用并改绑 session scope

- `src/runtime/{agent,agent-loop,interactive-session-controller}.ts`；
- `src/runtime/process/**`、`src/storage/process/**`；
- `src/runtime/context/**`、`modes/**`、`resources/**`、`trace/**`；
- `src/security/**`、`src/worktree/**`、`src/extensions/**`；
- `src/tui/**`；
- 现有 bounded frame、driver、cursor、receipt pure algorithms，在去除 Host-specific identity 后迁入新目录。

### 9.3 最终删除或退出生产 barrel

- `src/runtime/host/**`；
- `src/storage/host/**`；
- `src/cli/runtime-host*.ts`、`reconnecting-host-bridge.ts`、`host-command.ts`、`linux-peer-attestor.ts`、`host-build-identity.ts`；
- `scripts/build-linux-peer-credential-helper.ts`、Host build/audit/replacement runner；
- `native/linux-peer-credential.c`；
- `hostEndpointRelativeLocator`、`hostSocketRelativeLocator`、`hostStartupElectionRelativeLocator`、`hostStateRelativeLocator`；
- CLI `host list|status|stop|restart` 和帮助文本；
- production `SessionManager`、JSONL ledger lock acquisition；
- package scripts `verify:multi-client-host`、`verify:host-build-replacement`、`verify:runtime-host-audit`，由 Session Owner runner 取代。

删除前先用 `rg` 构造 exact consumer inventory。`JsonlLedger` 若仍被 mock/demo 单测使用，可以保留为 test-only adapter，但不得从 production composition 或 public current-format storage route 可达。

## 10. 实施阶段

所有阶段严格串行。每阶段先增加 RED test/fixture，再实现 GREEN；不使用 rollout flag、环境变量或双 production path。R0–R6 期间标准 CLI 仍运行现有 Host；R6.5 用隔离 home 调用真实 candidate composition；R7 一次性切换标准 CLI；R8 在旧源码仍可回退的窗口完成稳定化和人工验收；R9 最后删除旧 Host。

### R0：冻结 authority、threat model 与 current contracts

目标：阻止继续扩展 machine Host，并固定替换契约。

- [x] 更新 `04` public contract：`RuntimeHostScope`/Host generation 替换为 session owner identity/fence；保留 driver/domain revision 的独立含义。`04` §3.8 已移除 `runtime.*` Host 事件并新增 §3.9 Session Owner 合同；当前 catalog 中 `runtime.*` 事件由 `owner.*`/`driver.*`/`recovery.*` 取代，Host 术语只允许出现在 legacy 源码与 `05` 历史文档。
- [x] 冻结 `SessionOwnerRecord`、`OwnerFence`、endpoint、handshake、owner/recovery event、command/attempt receipt、checkpoint cache 和 typed error schemas。实现于 `src/runtime/session-owner/{types,schemas}.ts` 与 `src/runtime/session-server/protocol.ts`（纯契约模块，纳入 `check:runtime-boundaries` 扫描与 public barrel）；fixtures 见 `tests/runtime/session-owner/contracts.test.ts`（10 tests）与 `tests/runtime/session-server/protocol.test.ts`（4 tests），先 RED 后 GREEN。
- [x] 固定四条 P0 invariant：offline-only schema migration（`upgrade_requires_sessions_closed`/`store_schema_too_new/too_old` typed error）、generation 不 fence 外部副作用（§4.5 注释 + `recovery.*` 事件）、crash takeover 进入 `RECOVERY_REQUIRED`（owner state 枚举含 `recovery_required`）、attachment count 决定 runtime lifetime（`OWNER_RELEASE_REASONS = paused/detached/error/fenced`）。
- [x] 固定同用户本机 threat model、token 保存/脱敏、TCP bind、DB mode/ACL、stale + 3 probes 条件。`SESSION_OWNER_HEARTBEAT_PARAMS` 冻结 3s/20s/1s/20s/3 probes/250ms；`SESSION_OWNER_AUTH_TOKEN_BYTES = 32`、token 只存 owner row + 内存，record/DTO/event schema 均拒绝额外字段；endpoint schema 只允许 `127.0.0.1`。
- [x] 固定 connection-scoped driver、Event + Receipt authority、checkpoint cache 和 legacy archive 边界。`driver.*` 事件递增 driverRevision，`sessions.last_driver_client_id` 仅 audit；`CommandAttemptReceipt` guard 强制 `settledGeneration >= originGeneration`；`SessionCheckpointDescriptor` 只带 digest 不内联 snapshot_json；`COMMAND_EFFECT_CLASSES` 冻结 canonical effect classification。
- [x] 新增 `check:session-owner-boundaries`：禁止新 machine leader、daemon、UDS/Named Pipe、production Host import 和 direct controller fallback。见 `scripts/check-session-owner-boundaries.ts`，已接入 `npm run check`；R0-frozen legacy consumer allowlist（19 个既有文件）与 legacy Host 内部前缀豁免；新 session 模块禁止 Host/TUI import、`detached`/`spawnBackground`/Named Pipe/`unix:`/`0.0.0.0`/`::`、Host election 依赖与 Client 直连 controller（只有 `src/runtime/session-runtime/` 可组合）。
- [x] 建立 current code consumer/delete inventory；记录哪些 pure algorithm 迁移、哪些文件删除。见 [`06-session-owner-inventory.md`](06-session-owner-inventory.md)（R0 冻结：34 个 legacy Host 消费文件分类、§9.3 删除清单核实、pure algorithm 迁移清单与复用清单）。
- [x] 更新下游 Plan/Context、Plugin/MCP、Worktree/Security 和 TUI 文档，把 production owner 路由到本文；历史证据仍指向 `05`。已更新 `plan-compact-memory/01`、`plugin-mcp-skill-hooks/01`、`worktree-sandbox-permisson/00`、`tui/00-overview`、`tui/09-remote-control-roadmap`、`tui/19-passive-contract-integration-plan`；`00-index` 与 `04` 继续指向本文为替代实施权威。

退出条件：schema/contract fixtures RED→GREEN（已达成，14 tests）；文档 link 检查通过（R0 完成时全绿）；没有两个 public owner contract（session owner 是唯一 public owner contract，`RuntimeHostScope` 标记为 R9 删除的 legacy 合同）。

### R1：SQLite foundation 与 schema migration engine

目标：建立安全、版本化、跨进程可并发的 `state.db`。

- [x] 为 `RunledgerLayout` 添加 `database`/`worktrees`/`migrationBackups`，保持单一 home authority。`RunledgerLayout` 新增 `state.db`/`worktrees/`/`migration-backup/` 三个字段并同步 storage-layout contract tests。
- [x] 实现 DB open、100ms busy 上限、异步 bounded jitter retry、error taxonomy、transaction wrapper、close/checkpoint。见 `src/storage/session-store/database.ts`（固定 PRAGMA：WAL/synchronous=FULL/foreign_keys=ON/busy_timeout=100/trusted_schema=OFF；`runAsync` 释放 event loop 后用 setTimeout + bounded exponential backoff/jitter 重试；typed `SessionStoreDatabaseError`）。`node:sqlite` 是 experimental builtin，不在 Node 22 builtinModules 白名单，vitest 无法 externalize，故用 `createRequire` 运行时加载并保留 `@types/node` type-only import。
- [x] 实现 exact schema、`schema_meta`、`store_control`、`STORE_SCHEMA_MIN/MAX/CURRENT` 和 format digest。见 `src/storage/session-store/schema.ts`（§4.3 全量 DDL 唯一 source + canonical sha256 format digest）与 `schema-compatibility.ts`（MIN/MAX 窗口、too-new/too-old/digest mismatch fail closed）。
- [x] 实现 offline-only migration admission gate；零 active owner、claim-vs-migration、migrator crash 和旧 binary too-new 全部用真实多进程测试。gate 流程：`BEGIN IMMEDIATE` → admission=migration_blocked → 零 owner 证明 → COMMIT；migration 在 `BEGIN EXCLUSIVE` 重验 gate epoch + 零 owner 后应用；crash 后 persisted blocked 只允许显式 resume/abort。测试见 `tests/storage/session-store/{schema-compatibility,migration}.test.ts`，用两个真实 `node` 进程（`tests/fixtures/session-store/db-worker.mjs`）证明并发 open、跨进程 busy ≤100ms、crash 回滚、old binary too-new。
- [x] 冻结首版 structural core；新增领域能力优先扩展 versioned payload，不随意做 DDL。`SESSION_STORE_SCHEMA_MIN=MAX=CURRENT=1` 已冻结在 session-owner contract。
- [x] POSIX mode/symlink/no-follow；Windows capability 没证据时 typed `unverified_platform`，不得伪造等价 ACL。见 `src/storage/session-store/platform-capability.ts`（linux verified 0600；macos/windows `unverified_platform`，fileModeFloor=null）。
- [x] 测试 WAL reopen、process crash recovery、disk full/readonly/corruption、migration rollback 和 bounded query。`database.test.ts` 覆盖 symlink/mode/not-a-database fail-closed 与 busy 上限；`event-loop-latency.test.ts` 覆盖单次 wait ≤100ms、重试期间 event loop 释放、bounded catalog query 与 WAL reopen；`migration.test.ts` 覆盖跨进程 crash rollback。disk full/readonly 分类已进 error taxonomy，注入式测试留 R6.5 fault matrix。

退出条件：两个真实进程可同时打开 DB（已达成，跨进程测试）；主 event loop 单次 DB wait 不超过 100ms（已达成，busy_timeout=100 + latency fixtures）；structural migration 只在 admission blocked + 零 active owner 下发生（已达成，gate 测试）；损坏/未知新版本 fail closed（已达成，too-new/too-old/digest/missing-header 测试）。

### R2：SessionStore 与 JSONL 显式迁移

目标：SQLite 成为新 Session 的唯一 durable truth。

- [ ] 实现 session catalog/create/fork/event append/checkpoint cache/command + attempt receipt/projection API。
- [ ] event append 在事务内校验 sequence、previous hash、owner fence 并更新 head。
- [ ] 删除全部 checkpoint/projection 后可只凭 Event + Receipt 从 genesis 重建；禁止 checkpoint/projection 反向授权 mutation。
- [ ] 实现 `runledger migrate session-store --confirm-archive`：只读取现行 canonical JSONL，固定 source digest manifest，导入、全量 verify 后原子归档到 `migration-backup/session-store/<manifestDigest>/`。
- [ ] 迁移前证明不存在 active legacy Host/writer；无法证明则返回 `legacy_host_active`，不自动 kill、删 endpoint 或抢锁。
- [ ] 新 Runtime 永不读取 archive；删除只由后续 `runledger storage prune-legacy --manifest <digest> --confirm-delete` 显式执行。
- [ ] 不提供 background auto migration、legacy reader、dual write 或 runtime fallback。

退出条件：新的 SessionStore test composition 对 fresh/create/resume/fork 全部能从 SQLite 无损恢复；migration 注入任一失败时 source 保持原位、target 不被当作完成；成功时 source 只归档不删除。标准 CLI 在 R7 前仍保留当前 Host/JSONL 基线，R2 不提前改写真实用户数据。

### R3：SessionOwner claim、heartbeat 与全写入 fence

目标：证明同 Session 单 owner、不同 Session 可并行 owner。

- [ ] 实现 bind-before-publish candidate、`BEGIN IMMEDIATE` claim、loser cleanup。
- [ ] 实现 generation monotonic、starting/recovery_required/running/stopping/unowned CAS。
- [ ] 实现 heartbeat、stale 判断、连续 3 次 authenticated probe 与 takeover CAS。
- [ ] 把 OwnerFence 注入 SessionStore 所有 mutation；静态检查禁止 fence-free write。
- [ ] owner transition 与 audit event 在同一 DB transaction；token 不进入 audit payload。
- [ ] 两个/十个真实进程同 session race；多个不同 session 并发运行；旧 owner 恢复写入被拒绝。

退出条件：任何 fault schedule 下同一 session 都至多一个 generation 能提交；仅 stale、单次 connect failure 或 sleep/wake 抖动都不能 takeover；这项证明只覆盖 durable write，不冒充外部副作用已停止。

### R4：localhost TCP RuntimeServer 与 Client attach

目标：替换平台 IPC，同时保留 bounded multi-client 语义。

- [ ] 实现 `127.0.0.1:0` listener、认证前 frame cap、token handshake 和 protocol negotiation。
- [ ] 将 command/query/subscription/ACK/reverse-request pure protocol 迁为 session scope。
- [ ] driver 改为 connection-scoped；disconnect/takeover 强制 `NONE` + revision event，禁止 driver lease/heartbeat。
- [ ] 本地 owner view 也通过 TCP facade；增加静态测试禁止 direct controller shortcut。
- [ ] 覆盖多 client snapshot→replay→live、slow subscriber、ACK loss、resync、disconnect cleanup。
- [ ] 覆盖 token guessing/replay、old generation、port reuse、wrong session/runtime、oversize/malformed frame。
- [ ] Linux/macOS/Windows 使用同一个 Node TCP implementation；平台差异只记录 runner evidence，不新增 transport adapter。

退出条件：三个 client 同时观察同一 SessionRuntime；observer mutation 在进入 Agent/tool/backend 前被拒绝；slow client 不影响其他 client。

### R5：authority replay、checkpoint cache 与 recovery barrier

目标：Runtime disposable、Session durable。

- [ ] 实现六个 safe checkpoint cache 和 exact snapshot/digest/schema 校验；cache miss/corruption 自动回退 full authority replay。
- [ ] 实现 model partial、tool intent/result、origin/settled generation、side-effect uncertain、Queue pending 的恢复状态机。
- [ ] owner crash 后 client 经 stale + 3 probes + CAS 获得 generation+1，先恢复 authority，再无条件进入 `RECOVERY_REQUIRED`。
- [ ] 实现 recovery assessment、best-effort terminate、worktree/external evidence、verified clean 与 `resume_despite_uncertainty` receipt。
- [ ] Runtime admission 与 ExecutionGateway final leaf 双重阻止 barrier 内的新 side-effect tool/process/MCP/network mutation。
- [ ] 旧 owner 恢复时 heartbeat/write fence 触发 self-stop。
- [ ] 覆盖 crash at claim/publish/restore/event/checkpoint/tool/receipt 边界；禁止重复 side effect。
- [ ] 明确不恢复 token stream、socket、PTY、MCP client 或 child handle。

退出条件：takeover 后 session/event sequence/hash 连续；旧 generation 的 durable 写入全部被拒绝；旧外部 effect 未被错误宣称 fenced；barrier 未收口前新副作用 `spawnCount=0`。

### R6：Session-scoped domain composition

目标：把现有生产能力从 resident Host 改绑到单 SessionRuntime。

- [ ] Agent、Context/Plan/Memory、Trace、Security/Gateway 只持当前 Session OwnerFence。
- [ ] managed process capacity/output/recovery key 从 workspace Host scope 改为 session scope；owner crash 投影 lost/uncertain，不 reattach。
- [ ] MCP/Hook/Skill/Plugin 每 SessionRuntime 独立启动、bounded、关闭；无 shared broker。
- [ ] worktree 改为 session ownership 和 canonical session locator；resume 重验平台/root/Git/lease/effective cwd。
- [ ] model selection、approval、credential onboarding、driver transfer 和 completion follow-up 全部走 server facade + durable receipt。
- [ ] local UI detach 且 remote attachment 存在时进入 headless-attached owner loop；只有 attachment count 归零才 pause/release。
- [ ] 删除所有领域中的 Host global registry 假设和 workspace Host fallback。

退出条件：所有真实 tool/process/approval/domain mutation 都绑定 `sessionId + generation` 且经过 recovery barrier；不同 Session 的故障、MCP 和 process capacity 相互隔离。

### R6.5：Candidate production composition 与 fault evidence

目标：在不改变标准 CLI production path、不删除旧 Host 的前提下，验证真正的 SQLite/TCP/SessionRuntime composition。

- [ ] 新增 `scripts/verify-session-owner-candidate.ts`，只接受预创建、绝对、隔离且位于仓库外的 `RUNLEDGER_DIR`；脚本直接调用与 R7 相同的 production factory，不使用 fake/in-memory adapter。
- [ ] 覆盖真实多进程 claim、SQLite WAL/busy retry、TCP auth、三 client、driver disconnect、local UI detach 保活、last attachment shutdown、crash takeover 和 recovery barrier。
- [ ] 使用真实 model、MCP、PTY、worktree：model 验证 checkpoint replay，MCP 验证重建，PTY 验证 lost/uncertain，worktree 验证 side-effect barrier 与 locator revalidation。
- [ ] Linux、macOS、Windows CI/runner 使用同一 candidate code path；缺平台证据时阻止 R7，不把 `unverified` 当 PASS。
- [ ] candidate manifest 绑定 HEAD、tracked/untracked candidate digest、store schema digest、command/gate output digest；candidate drift fail closed。
- [ ] 测量 100 Session catalog、10 并行 owner、3 client streaming、slow subscriber；证明同步 DB call 上限与 async retry 不造成秒级 event-loop stall。

退出条件：candidate 自动 fault matrix 全绿，三平台 required evidence 齐全，独立只读审计无阻塞 finding。该 runner 不是 feature flag、第二个用户入口或 dual production path。

### R7：标准 CLI/TUI 原子切换

目标：生产只剩 Session Owner path。

- [ ] `src/cli/main.ts` 改为 resolve store → resolve sessionId → attach/claim → local TCP facade → TUI。
- [ ] `/new`、`/resume`、`/fork` 使用 §8 语义；修复 owner view/remote view 的 attachment 计数。
- [ ] schema upgrade 需要零 active owner；不满足时标准入口返回 `upgrade_requires_sessions_closed`，不得边运行边 migration。
- [ ] JSONL 首次转换只归档 source，不物理删除；新 Runtime 不读取 archive。
- [ ] 最后一个 attachment 尝试关闭且 Session 仍 active 时显示 pause 警告；完成 bounded checkpoint/settlement/release。
- [ ] 删除 `host` CLI dispatch/help；增加只读 session owner diagnostics 时只能针对 exact session，不引入全机 manager。
- [ ] standard PATH 两/三个真实 TUI 验证同 Session attach、不同 Session 并行 owner、owner crash takeover。
- [ ] 切换提交中不得保留 feature flag、legacy fallback 或“TCP 失败就直接 SessionManager 写”。

退出条件：`runledger` 标准入口不再 import/call 任何 `runtime-host-*`、Host socket/election/writer lease；真实 TUI 能完成 create/attach/takeover/recovery/resume。旧源码和 verified JSONL archive 仍保留，必要时只能通过 revert R7 cutover commit + offline archive restore 处置，不能由新 Runtime 自动 fallback。

### R8：生产稳定化与 human acceptance

目标：在旧 Host 源码尚未删除、但已从 production path 不可达的安全窗口验证真实升级与日常使用。

- [ ] 用标准 PATH 而非 candidate script 重跑 R6.5 fault matrix 和 migration archive/restore rehearsal。
- [ ] 真实 operator 验证同 Session 多窗口、不同 Session 并行、local UI detach 保活、whole-process crash、`RECOVERY_REQUIRED` 和 explicit uncertainty decision。
- [ ] 验证 old binary 遇到新 schema 返回 `store_schema_too_new`；有 active owner 时新 binary 返回 `upgrade_requires_sessions_closed`。
- [ ] 连续运行稳定窗口内记录 SQLite busy/event-loop latency、heartbeat、TCP disconnect、checkpoint full replay 和 archive retention。
- [ ] 完成独立只读安全/数据审计；自动化 agent 不填写 `human-verified`。

退出条件：§11 自动化 gate、标准 PATH fault matrix、独立审计和 human acceptance 全部 PASS；没有依赖旧 production fallback 的未解决问题。

### R9：删除 Host/daemon 遗产与最终收口

目标：只在 R8 证据闭合后，从代码、构建、测试和文档中彻底移除旧生产架构。

- [ ] 按 §9.3 删除 Host source、storage、scripts、native helper、commands 和 package scripts。
- [ ] 删除 Host build manifest、maintenance/restart、peer attestation、endpoint cleanup 和旧 audit runner。
- [ ] production 删除 SessionManager/JSONL lock path；test-only adapter 明确不导出。
- [ ] 更新 Runtime contract inventory、barrels、AGENTS、开发索引和所有下游 owner 路由。
- [ ] `rg` 静态门禁仅允许 `05` 历史文档、migration source/archive tooling 和历史 fixture 出现 legacy 术语。
- [ ] 保留 migration archive；只有用户另行执行 `storage prune-legacy --confirm-delete` 才物理删除，不把 prune 混入代码删除阶段。

退出条件：构建产物无 resident Host entrypoint/native peer helper；package 只有 `runledger` client binary；旧架构不能通过配置复活；完整 gate 再跑通过；此时 `05` 才标为 superseded。

## 11. 验证矩阵

每个实现阶段至少执行：

```bash
npm run check
npm test
npm run build
git diff --check
```

定向测试建议固定为：

```text
tests/storage/session-store/database.test.ts
tests/storage/session-store/schema.test.ts
tests/storage/session-store/schema-compatibility.test.ts
tests/storage/session-store/migration.test.ts
tests/storage/session-store/event-loop-latency.test.ts
tests/runtime/session-owner/claim.test.ts
tests/runtime/session-owner/fencing.test.ts
tests/runtime/session-owner/takeover.test.ts
tests/runtime/session-server/transport.test.ts
tests/runtime/session-server/subscription.test.ts
tests/runtime/session-server/driver.test.ts
tests/runtime/session-runtime/checkpoint.test.ts
tests/runtime/session-runtime/recovery.test.ts
tests/runtime/session-runtime/recovery-barrier.test.ts
tests/cli/session-client.test.ts
tests/cli/session-owner-production.test.ts
```

最终 fault matrix 至少覆盖：

| 领域 | 必测场景 |
|---|---|
| schema/version | active owner 阻止 migration、claim-vs-migration、old binary too-new、migrator crash 保持 admission blocked |
| claim | 2/10 contender、不同 session 并行、100ms DB busy + async retry、candidate bind failure、claim loser cleanup |
| publish | claim 前 crash、claim 后/ready 前 crash、port reuse、starting timeout |
| health | heartbeat stale + endpoint healthy、heartbeat fresh + endpoint fail、stale + 连续 3 probe failure、sleep/debugger pause/wake |
| durable fencing | event/checkpoint/receipt/driver/tool/process/approval/domain write 的旧 generation 全拒绝 |
| external effects | 旧 process 可能存活时新 owner 进入 recovery barrier；核验/人工 decision 前新副作用 `spawnCount=0` |
| TCP auth | wrong token/session/runtime/generation、token replay、oversize/slowloris、非-loopback bind 拒绝 |
| clients | 3 viewers、connection-scoped driver、driver disconnect→NONE、observer mutation、slow subscriber、cursor resync |
| attachment | local UI detach + remote 保活、`/new` 多 owned handle、最后 attachment 归零才 pause/release |
| recovery | model partial、read-only tool、side-effect uncertain、origin/settled generation、Queue pending、explicit uncertainty receipt |
| process | graceful last detach、owner crash、orphan lost/uncertain、output cursor/seal、无 PID reattach |
| checkpoint | 删除/损坏/旧版 cache 后从 genesis Event + Receipt 得到相同 state |
| storage | WAL crash、hash tamper、disk full、readonly、migration partial failure、JSONL verified archive 不被 Runtime 读取 |
| isolation | Session A crash/MCP/process flood 不影响 Session B；不同 generation token 不串用 |
| lifecycle | last attachment pauses、重新打开 resume；零 attachment 时不存在 runtime；健康 owner 不被强抢 |
| audit | owner claim/takeover/release/fenced 与 model/tool/permission/timeline 全部可按 session+generation 归属 |

生产 runner 的最小场景：

1. TUI A 创建 S1 并成为 owner/driver；TUI B、VS Code facade attach S1。
2. TUI C 创建 S2；证明 S1、S2 有不同 runtimeId/port 且同时运行。
3. TUI A local view 正常 detach，B 仍 attached；owner/runtime/turn/process 不重启，B 连续收到 event。
4. kill S1 owner process；B 在 stale + 连续 3 次 probe 失败后 claim generation+1，恢复同一 event head 并停在 `RECOVERY_REQUIRED`。
5. 保留一个旧 generation child effect 的受控 fixture；证明新 generation 的 DB 写安全不等于 child 已停止，barrier 收口前所有新副作用 `spawnCount=0`。
6. 暂停旧 owner 后让 B takeover，再恢复旧 owner；旧 owner 的 durable mutation 均得到 `owner_fenced`，不伪造 external effect 已撤销。
7. heartbeat stale 但任一次 endpoint/handshake probe 成功；不得 takeover。覆盖 laptop sleep/wake。
8. active owner 存在时 schema migration 返回 `upgrade_requires_sessions_closed`；升级后 old binary 返回 `store_schema_too_new`。
9. 最后一个 attachment 关闭 active session；process 被 settle、cache checkpoint 写入、owner 为 unowned，机器上无 resident RunLedger runtime。
10. 删除全部 checkpoint 后重新打开 S1；从 Event + Receipt full replay 恢复，不重复 prompt、model call 或 side-effect tool。
11. Linux/macOS/Windows runner 使用完全相同 TCP/server/store production code path。

## 12. Rollout、迁移与停止规则

### 12.1 无双生产路径

- R0–R6：新实现仅在 test composition；标准 `runledger` 仍是旧 Host。
- R6.5：隔离 home 的 candidate runner 使用真实 production factory，但没有用户入口或切换开关。
- R7：单次原子切换；标准 CLI 只使用 Session Owner。
- R7 后：发现旧 JSONL 或 active legacy Host 时 typed fail closed，要求显式 archive migration/关闭旧版本；不临时回退。
- R8：旧源码仍在 tree 中用于 revert 安全窗，但 production path 不可达；完成稳定化、审计与 human acceptance。
- R9：上述证据通过后才删除旧代码和构建入口。

不增加 `runtimeFeatures.sessionOwner`、`--legacy-host`、`RUNLEDGER_DAEMON` 或 hidden fallback。

### 12.2 Session data migration 与 archive

本节只描述 current JSONL → SQLite 的一次性数据转换，不是 §4.2 的 SQLite structural migration。两者都要求零 active owner，但 archive 规则只适用于 JSONL source。

迁移顺序固定为：

```text
preflight no active legacy owner/writer and no active Session Owner
→ enumerate canonical current JSONL
→ freeze source digest/archive manifest
→ SQLite transaction import
→ verify IDs/counts/hash chain/checkpoints/projections/file modes
→ mark migration committed
→ atomically rename source into migration-backup/session-store/<manifestDigest>/
→ verify archive digest and target reopen
```

任一步失败：停止，不把 target 标完成，source 保持原位。成功后新 Runtime 永远不读取 archive；archive 只用于人工恢复/审计，最终物理删除必须另行执行带 manifest 和 `--confirm-delete` 的 `storage prune-legacy`。migration 不读取旧格式、不猜测损坏记录、不跨 `RunledgerLayout` root、不复制 auth/credential secret 到 event payload。

### 12.3 停止规则

出现以下任一情况立即停止阶段，不继续扩大实现：

- 无法证明某个 production write 绑定 OwnerFence；
- structural migration 期间存在 active owner，或 binary schema range 无法确定；
- 任何实现把 generation 描述成可以 fence/撤销外部副作用；
- crash takeover 未先进入 `RECOVERY_REQUIRED`，或 barrier 只存在于 UI；
- checkpoint 含有无法从 Event + Receipt 重建的唯一事实；
- `DatabaseSync` 一次 busy wait 可阻塞主线程超过 100ms，或 retry 在同步循环中执行；
- 需要 machine daemon/leader 才能满足新增需求；
- 为兼容旧 Host 而需要双写、双 reader 或自动 takeover；
- TCP 需要绑定非 loopback address；
- side-effect tool crash 后只能通过盲目重跑恢复；
- Windows/macOS 能力只有 source 推断而无 runner evidence；
- migration 无法证明 active legacy writer 已停止；
- local UI detach 在仍有 remote attachment 时会终止 owner；
- R6.5 跨平台/fault evidence 未通过就切换标准 CLI，或 R8 未通过就删除旧 Host；
- migration 计划要求新 Runtime 读取 archive，或在用户显式 prune 前物理删除 archive；
- last-attachment shutdown 需要让 runtime 或 child process 脱离客户端继续运行。

停止后应先修改本文的范围/ADR并取得明确授权，不能在代码中偷偷恢复被删除的复杂度。

## 13. 非目标

首版明确不实现：

- daemon、service、systemd、launchd、Windows Service、detach/autostart/updater handover；
- machine/workspace leader、global Runtime registry、global worktree pool；
- Unix Domain Socket、Named Pipe、跨机器 TCP、LAN listen；
- 所有 client 关闭后继续跑 Agent、MCP 或 process；
- token-level LLM resume、live model stream migration、PTY/MCP/subprocess hot migration；
- 按 PID/port 猜测 reattach orphan；
- shared MCP broker、shared project search daemon；
- credential 全局单例 Runtime；无真实 refresh race 时不预建 resource lock framework；
- driver lease、driver heartbeat、跨 connection 自动恢复 driver authority；
- MVP 默认 DB Worker Thread；只有 100ms blocking 上限与 R6.5 latency evidence 不满足时才单独评审；
- browser transport、remote multi-user、RBAC、TLS；
- 旧 Host protocol/session JSONL compatibility reader、双写或自动迁移；
- 新 Runtime 自动读取 migration archive，或在用户显式 prune 前自动物理删除 archive；
- 健康 owner 的 force takeover。

## 14. 完成定义

- [ ] 标准 `runledger` 进程内可 owner 一个 Session，也可 attach 另一个 owner；无独立 resident Host。
- [ ] 同一 Session 的并发 contender 只有一个 generation 能写；不同 Session 可并行运行。
- [ ] owner discovery/claim/heartbeat/takeover 只有 SQLite + authenticated localhost TCP 两个机制。
- [ ] structural schema migration 只在 admission blocked + 零 active owner 下发生；binary 严格执行 `STORE_SCHEMA_MIN/MAX`。
- [ ] `DatabaseSync` 单次 blocking wait 不超过 100ms；busy retry 释放 event loop 后异步、有界执行。
- [ ] Event + Receipt 是 authority，checkpoint/projection 可全部删除并重建；cache 不保存唯一事实。
- [ ] 旧 JSONL 只显式迁移并归档；新 Runtime 不读取 archive，物理删除需要独立 prune 确认。
- [ ] RuntimeServer 只绑定 `127.0.0.1:0`，token 按 generation 轮换且不泄漏。
- [ ] owner 与 connection-scoped driver 分离；disconnect/takeover 后 driver 为 `NONE`，多个 subscriber 共享同一个 SessionRuntime。
- [ ] 每个 durable mutation 都验证 `sessionId + runtimeId + generation`；旧 owner 自停，但文档和实现不声称该 fence 能撤销外部副作用。
- [ ] crash takeover 必经 `RECOVERY_REQUIRED`；核验或显式 uncertainty receipt 前所有新副作用在 final leaf 被拒绝。
- [ ] 恢复只使用 authority replay + safe checkpoint cache；模型 token、PTY、MCP、child handle 不迁移。
- [ ] side-effect tool 的 crash outcome 是 verified/uncertain/interrupted，不盲目重复。
- [ ] local UI detach 且 remote attachment 存在时 owner 保持运行；最后一个 attachment 退出才 pause/checkpoint/settle/release。
- [ ] MCP、process、worktree 生命周期 session-scoped；不存在 global pool/broker/manager。
- [ ] Permission/Approval/Sandbox/Gateway/Trace/Artifact 的治理边界没有被简化掉。
- [ ] R6.5 candidate fault evidence 和 R8 标准 PATH/human acceptance 在删除旧源码前完成。
- [ ] `src/runtime/host/**`、`src/storage/host/**`、Host CLI/native helper/build handover 在 R9 从生产删除。
- [ ] Linux/macOS/Windows 的 SQLite/TCP 使用同一代码路径，能力声明有各自真实证据。
- [ ] focused tests、`npm run check`、`npm test`、`npm run build`、production runner、独立审计与 human acceptance 全部闭合。

完成以上条件后，架构的最终解释固定为：

> Runtime is disposable and session-scoped. Session is durable. SQLite owns coordination and history; localhost TCP only attaches views to the current owner.
