# RunLedger 评测中台实施计划（bench）

> 状态：`planned`
>
> 建档日期：2026-09-16
>
> 建档基线：`rollback/before-composer-shape@82be1df`（工作树含 plan-mode 未提交改动；本文所有事实核对于该工作树状态，行号有效性以 2026-09-16 为准）
>
> 参考输入：oh-my-pi `packages/metaharness`（见 [00-oh-my-pi-metaharness-reference.md](00-oh-my-pi-metaharness-reference.md)）。参考项目只提供机制模板，不是复制目标。
>
> 冻结合同：[02-task-pack-and-scoring-contract.md](02-task-pack-and-scoring-contract.md)

## 0. 结论

RunLedger 当前**不存在 agent 任务级评测能力**：没有 task registry、没有 experiment/run 模型、没有评分器、没有结果库、没有查询出口。仓库里唯一的任务级资产是 `tests/manual/development-cases/` 的三件套（`prompts.json` 任务描述 + `driver.py` 真实 TTY 驱动 + `acceptance.py` 独立验收），但它的四维评分是**人工写入** `results-2026-09-06.json` 的数字，没有可重放的评分器，也没有跨 run 的持久化。

本计划要建的是一个**当前 checkout 的 harness 行为回归中台**：给定冻结的任务包与冻结的 profile 组合，跑真实 CLI，采集运行事实，用宿主侧独立验收器判分，把结果作为可比数字沉淀下来，用来回答「这次改动让 harness 变好还是变坏」。

三个必须先解决的结构性冲突（详细论证见 §2.3）：

1. **RunLedger 没有 headless 入口。** `--mode` 是 AgentMode（`default|minimal|plan`），不是 omp 那样的 `text|json|rpc` 输出模式；仓库里 `isTTY` 零命中，任何不带子命令的调用都无条件进入 OpenTUI。唯一无 TUI 路径是 12 组控制命令，它们**不能提交 prompt**。
2. **无人值守与 fail-closed 治理直接冲突。** `--approval-policy never` 把 `ask` 转成 `deny`（`src/security/permission/engine.ts`），所以 `never` 下常规任务必然因拒绝而失败；唯一的「无审批」组合是 `danger-full-access` + `never`，而它被 `AGENTS.md` §2 与本文都拒绝作为默认。
3. **没有 run 级存储单元。** 隔离单元是 **session**，`runId` 只是事件 payload 与 trajectory 记录里的逻辑字段，不形成目录、不形成主键，也不存在 per-run 数据库。

因此本计划的第一交付不是看板也不是报表，而是**驱动层**（P1）与**任务包 + 独立验收**（P2/P3）。P4 之后才谈实验聚合与展示。

## 1. 权威边界

### 1.1 本文负责

- 评测中台的**驱动层**：如何以非交互方式在隔离 root 中跑一次真实 RunLedger，以及如何取得运行事实。
- 评测的**任务包格式、验收契约、指标口径与证据分级**（冻结合同在 02）。
- 评测**结果账本**（bench ledger）的 schema、聚合语义与只读报表。
- hermetic（本地 HTTP 桩、零付费、可进 CI）与 live（真实 provider、人工触发）两条证据通道的边界。
- 新增目录的门禁接线方式（类型检查、inventory 豁免、CI job），使评测资产不被静默漏管也不污染 `npm test`。

### 1.2 本文不负责

- **不新增 headless 模式的产品语义。** 若最终需要 `runledger run --prompt` 这类子命令，它属于 Runtime/TUI authority（Runtime 06、TUI 19），本文只提出需求、给出被测面变化分析，并由该 authority 单独批准。
- **不做任务执行的进程隔离。** `AGENTS.md` §2 明确：不得新增、扩展、移植、重构 OS sandbox、文件系统/网络 namespace、进程隔离实现，也不得把一般 Security / ExecutionGateway 工作宣称为 sandbox 开发。评测的隔离边界是**隔离的 `RUNLEDGER_DIR` + 隔离 workspace 目录**，不是容器或 microVM。
- **不引入第二个常驻服务作为 authority。** RunLedger 是单包，authority 固定在注入的 `RunledgerLayout`。评测中台的所有持久化必须落在评测自有的 `<bench-root>` 下，且不得被产品代码读取。
- **不绕过治理让评测通过。** 包括但不限于：AllowAll、raw I/O、关闭 ExecutionGateway、以 root 身份运行被评测进程、把审批自动应答实现为「总是允许」。
- **不复制 `auth.json` 或任何真实凭据进入评测产物**，也不把真实用户 `~/.runledger` 作为评测 root。
- **不替代各领域验收标准。** 评测给出的是行为回归数字，不是 Runtime/TUI/Security 各自专项的功能验收。

### 1.3 与现有专题的关系

| 专题 | 关系 |
|---|---|
| [`test/01`](../test/01-test-strategy-and-runner-hardening-plan.md) | **正交**。测试策略回答「一次变更该跑哪些测试」；本专题回答「harness 在任务样本上表现如何」。执行 bucket 与 bench trial 不共享 runner，也不互相替代。 |
| [Runtime 06](../runtime/06-session-owner-runtime-replacement-plan.md) | 评测驱动必须走 Session Owner Runtime；headless 入口若落地，其 authority 归 Runtime 06。 |
| [`trajectory/01`](../trajectory/01-runtime-trajectory-implementation-plan.md) | Trajectory 提供 `Run/Step/Call` 的只读投影，是本中台 `trace` 层的主要来源；但其缺口（无导出、正文默认 digest-only）由本专题自行补齐，不要求 trajectory 专题扩展。 |
| [Runtime Trace](../runtime/trace/README.md) | `<home>/events/**.jsonl` 是 trace 正文来源；Phase 04（Opik）与本专题无关，不阻塞也不复用。 |
| [`worktree-sandbox-permisson/07`](../worktree-sandbox-permisson/07-three-permission-presets-and-tui-settings-plan.md) | 权限预设是评测的**被测量**之一，不由本专题修改。 |
| `tests/manual/development-cases` | 现有任务集与驱动是本专题的**输入**：任务描述与验收器模式被继承，但其人工评分被替换为可重放评分器。 |
| `tests/manual/harness-repair` | 提供 hermetic 模式的关键先例：本地 HTTP fixture 经 LiteLLM adapter 返回确定性工具调用，不触外部模型。 |

## 2. 当前基线

### 2.1 可复用资产（已存在，可直接借用）

| 资产 | 位置 | 复用方式 |
|---|---|---|
| manifest 驱动 profile 准入模式 | `tests/manual/development-cases/driver.py`、`verify_model.py` | trial 前置校验：provider/model/thinking 与已核实证据 digest 绑定，不匹配则拒绝运行 |
| 真实 TTY 驱动 | `tests/manual/development-cases/driver.py`（tmux `-L <socket>`、`-f /dev/null`、`remain-on-exit`、`respawn-pane`、`capture-pane -S -2000`） | P1a 的过渡驱动直接沿用；就绪判定 `Message RunLedger`，退出 `Escape` + `C-d` 并核对 `pane_dead_status` |
| 运行事实采集 | `driver.py` 的 `events()`：只读 URI 打开 `home/state.db`，`SELECT sequence, payload_json FROM session_events WHERE event_type='agent.event'` | 本中台 trial 采样的权威查询模式 |
| 独立验收器模式 | `tests/manual/development-cases/acceptance.py` | P3 的验收契约母本：宿主子进程、逐条 `check(name, passed)`、产物 `independent-acceptance.json` 含 `tested_source_sha256` |
| hermetic fixture | `tests/manual/harness-repair/run.py` | P2 的零付费通道：本地 HTTP fixture + `provider: litellm` + `LITELLM_BASE_URL`（`src/providers/litellm.ts`） |
| watchdog / 清理 / 探活 | `scripts/run-test-buckets.ts` | trial 超时（`spawnSync.timeout` + `timeoutKind`）、detached 进程组 `process.kill(-pgid, 0)` 后代探活、临时根 lstat 复查 |
| 环境清洗清单 | `scripts/run-test-buckets.ts`、`scripts/run-smoke-tests.ts` | 剥离 `RUNLEDGER_DIR` 与凭据类 env，注入隔离 home/HOME/XDG |
| 时序账本 | `scripts/record-gate-timings.ts` | bench ledger 的追加式 JSONL 与坏行容忍、git/runtime 上下文记录 |
| 不可变证据包 | `scripts/collect-platform-evidence.ts` | `raw/*.txt` + `evidence.json` + `manifest.json`（sha256 digest）的 trial 打包方式 |
| 有界并发 + 汇总 | `tests/manual/native-mode/run_matrix.py` | P4 批量执行的并发与「单例异常不取消批次」语义 |
| CI 拓扑 | `.github/workflows/test.yml` | 独立 job + `tee` 日志 + `if: always()` 上传 + fail-closed 汇总 gate |

### 2.2 缺口清单（逐条带证据）

| 缺口 | 事实与证据 |
|---|---|
| 无 headless prompt 入口 | 解析表无 `-p` / `--print` / `--prompt` / 顶层 `--json` / `--mode text\|json\|rpc`（`src/cli/args.ts` 全文分支表）；文档明文声明不存在（`docs/cli.md:21`） |
| 无 stdin prompt 通道 | stdin EOF 只触发 `quit()`（`src/cli/main.ts`） |
| 无 CLI 会话列举 | `/resume`（别名 `/sessions`）只在 TUI registry 中；CLI 无对应子命令 |
| 无 attach / observer 接缝 | `runledger host list\|status\|stop\|restart` 代码存在但**未从 `src/cli/main.ts` 派发**；无调用点 |
| 协议不在 package exports | `package.json` exports 无 `./runtime/*`、`./cli/*`；`src/index.ts` 不导出 `SessionClient` / `RuntimeServer` |
| 无 run 级隔离目录 | `runId` 仅存在于事件 payload、trace metadata 与 trajectory 记录前缀 `run/<runId>`；无目录、无表、无主键 |
| 无离线只读导出 | 无 `query` / `export` / `sql` / `dump` 子命令；`SessionDatabase.open({readOnly:true})` 能力存在但生产 `src` 无调用点；`session_index.jsonl` 字段已定义但无 producer/consumer |
| usage/cost 无独立聚合表 | usage 累计只是显示层 reducer（`src/runtime/usage/index.ts`）；`cost.recorded` / `cost.reconciled` 协议事件声明但**无发送方** |
| 无 per-run 成本聚合 | trace tree 只 replay 单 trace；trajectory 无聚合端点 |
| 工具结果正文默认不可得 | `recording.mode=events`（默认）只写 `digest_only`；正文需 `events_and_artifacts`，且源事件 >8MiB 直接标 unavailable |
| 无审批的程序化应答 | reverse-request handler 未注入即 fail closed（`src/cli/session-client.ts`）；审批只在 InteractiveMode 接线（`src/cli/main.ts`） |
| 无 provider 角色模型 | 全仓无 smol/slow/plan 模型角色；标题、压缩摘要、child agent 全部复用当前 session model |
| 无 ModelStore 持久化 | CLI 启动一律 `refresh({allowNetwork:false})`，`ModelsStore` 仅 `InMemoryModelsStore` 实现 → 「先在线刷新、之后离线跑」不成立 |
| 评测资产无门禁归属 | `scripts/test-inventory.ts` 只发现 `tests/**/*.test.ts` 与含 `#[test]` 的 native Rust 文件；`scripts/check-typecheck-coverage.ts` 只覆盖 `tests/`、`scripts/`、`examples/`。新顶层目录**既不进类型检查也不产生诊断**（静默） |
| 现有 benchmark 脚本与任务级评测无关 | `scripts/benchmark-*.ts` 四个脚本都测进程内库函数热路径（coalescer、native addon、trajectory store），不含 CLI 进程、不含模型请求与工具循环；除 syntax-highlighter 的 50ms p95 门禁外无阈值、零 CI 接线 |

### 2.3 三个结构性冲突

#### 冲突一：没有 headless 入口，而评测必须非交互

`src/cli/main.ts` 的路径是：解析 args → 解析/创建 session → `openView` → 控制命令分支（若有）→ 否则无条件 `runSessionTransitionLoop` → `InteractiveMode` → OpenTUI alternate screen。没有 `isTTY` 检查，也没有「跑完一轮就退出」的模式。

三条可选路线：

| 路线 | 做法 | 优点 | 代价 |
|---|---|---|---|
| **A（推荐起步）** | 加固现有 tmux + 真实 TTY 驱动（`driver.py` 模式）：隔离 root、隔离 workspace、独立 tmux server、`capture-pane` 取证、SQLite 读 `agent.event` | 零产品改动；走的是标准 CLI/production 链路，证据力最强；已有可用先例 | 慢（含 TUI 渲染开销）；审批应答只能靠 `send-keys`；tmux 依赖；并发上限低 |
| **B（长期）** | 新增 headless 子命令：进程内 `SessionClient` + 自动 reverse-request handler + 事件流输出到 JSONL | 快、可扩并发、审批可编程、事件流精确 | **改变被测面**（TUI 与交互路径不再被执行）；属于产品面扩张，需 Runtime/TUI authority 批准；`--mode` 命名须避开已有 AgentMode |
| **C** | 外部进程直接打 Session Owner 协议（127.0.0.1 + NDJSON v3 + 32-byte hex token） | 不改产品代码即可编程驱动 | token 只能从 `state.db` 的 `session_owners` 行读；需要把协议/传输代码对外可 import，否则复制产生 drift；`trajectory`/`subscription` 的完整语义要自行实现 |

**决策**：P1a 走 A（建立端到端骨架与首份可比数字），P1b 作为独立申请项评估 B。**A 与 B 的数字不可混入同一 arm 比较**——B 消除了 TUI 与交互开销，墙上时间、`active_duration_ms`、审批等待时间都不可比。切换驱动必须新建 arm 并标注驱动身份（见 02 §5 的 `driver` 字段）。

#### 冲突二：无人值守与 fail-closed 治理

`--approval-policy` 语义（`src/security/permission/engine.ts`）：

- `never`：把 `ask` 转成 `deny`（`reason: "approval policy never converted ask to deny: ..."`），但 `danger-full-access` + `never` 会让普通 shell 直接 allow。
- `on-request`：只对 `filesystemMode === "unrestricted"` 的普通写做「跳过审批」，其余仍 `ask`。
- `untrusted` / `granular`：更严格。

结论：**不存在「既不放行 danger-full-access、又能无人值守跑完普通任务」的现成组合**。因此 P1 必须交付一个**显式、可审计、默认拒绝**的审批适配器，规则写在 02 §6：

1. 自动应答只在 `driver` 声明的 `autoApproval` 白名单内生效（评测资产自身声明，不是用户 settings）。
2. 白名单最小集：workspace 根内的 filesystem mutation、经由仓库既有的 shell 分类结果判定为「已知」的 shell 命令、任务包显式声明的网络 host。
3. 白名单之外的 `ask` **不自动拒绝也不自动允许**：trial 以 `blocked_by_policy` 终态结束，并记录 request digest。这是**评测结果**而不是评测失败——「治理把任务挡住了」正是本中台要测的东西。
4. 每条决策（request kind、工具名、command、决策、命中规则、应答来源）写入 trial artifact。
5. 任何情况下不得使用 `danger-full-access` 作为默认 profile；例外需在 arm 配置里显式写明并作为独立 arm 参与比较。

#### 冲突三：没有 run 级存储单元

RunLedger 的隔离单元是 session + workspace key。评测需要的是「一个 trial 一个可丢弃环境」。**解法是把 `RUNLEDGER_DIR` 本身当作 trial 单元**：

```
<bench-root>/runs/<runId>/trials/<taskId>-<attempt>/
  home/                 ← 该 trial 的 RUNLEDGER_DIR（预创建，绝对路径）
  workspace/            ← 被测进程的 cwd（任务初始文件 + 隔离 bun 等）
  user/                 ← HOME
  transcript/           ← TTY 帧或事件流
  artifacts.json        ← 证据清单 + digest
  result.json           ← 该 trial 的结构化结果
```

一个 `RUNLEDGER_DIR` 内可承载多 session（例如多轮任务），但**跨 trial 绝不共享**。这样 `state.db`、`events/**`、`artifacts/**`、`projections/**` 全部天然隔离，且不依赖任何产品侧新增能力。

注意 `scripts/run-test-buckets.ts` 的 `sanitizedTestEnvironment` 会剥离 `RUNLEDGER_DIR` 并注入自己的隔离 home——评测 runner 必须**反过来**注入显式 trial home，并明确不复用测试 runner 的环境构造函数（避免语义混淆）。

## 3. 目标架构

### 3.1 分层

```
task pack（冻结的任务样本 + 验收器）
        │
        ▼
runner ── 为每个 (task, attempt) 物化隔离 trial 环境
        │
        ├─ 驱动层（P1）：真实 CLI（TTY 或 headless）+ 审批适配器
        │
        ▼
采集层（P2）：只读解析 trial home 的 state.db / events / artifacts
        │
        ▼
评分层（P3）：宿主侧独立验收器 + 指标计算
        │
        ▼
账本（P4）：bench.sqlite（experiments / arms / runs / trials）
        │
        ▼
报表与看板（P5/P7）：markdown + JSON + 只读静态投影
```

### 3.2 数据模型

沿用 metaharness 的三段模型，但字段按 RunLedger 口径重定义（完整 schema 在 02 §5）：

| 实体 | 定义 | 关键字段 |
|---|---|---|
| **experiment** | 一个待回答的问题，id 为 arm 名首段（`prewalk` 的 `prewalk-flash` → `prewalk`） | `id`、`goal`、`created_at` |
| **arm** | experiment 内一个可比较的分支；**同一 experiment 内只允许一个自变量差异** | `arm`、`driver`、`mode`、`provider`、`model`、`thinking`、`harness_profile`、`permission_profile`、`approval_policy`、`recording_mode`、`task_sample`、`task_sample_digest` |
| **run** | 一次 arm 在某时间点上对某 task sample 的执行 | `run_id`、`arm`、`checkout{commit,dirty_digest}`、`dist_digest`、`started_at`、`status` |
| **trial** | 一个 `(run, task, attempt)` 三元组 | `trial_id`、`task_id`、`attempt`、`status`、`metrics`、`artifact_dir`、`artifact_digest` |
| **attempt 事实** | 从 trial 的 `session_events` 抽取的执行事实 | `steps`、`tool_calls`、`tool_failures`、`approvals`、`denials`、`usage`、`cost_usd`、`wall_ms`、`active_duration_ms` |

`task_sample_digest` 是 arm 可比性的硬门槛：**两个 arm 的 task 集合与顺序必须一致，否则拒绝同图比较**。

### 3.3 真源边界

| 数据 | 真源 | 评测侧读取方式 |
|---|---|---|
| trial 的 agent 事件 | trial 的 `home/state.db` → `session_events`（`event_type='agent.event'`） | **只读 URI 连接**（`file:...?mode=ro`），与 `driver.py` 一致 |
| trial 的 trace 正文 | trial 的 `home/events/YYYY/MM/DD/<traceId>.jsonl` | 只读逐行解析；`events` 模式下内容为 digest-only，摘要标 `content_unavailable` |
| trial 的工具输入输出正文 | trial 的 `home/artifacts/sha256/**`（仅 `events_and_artifacts`） | 只读 + 重算 digest 校验 |
| 验收结论 | 宿主侧 `acceptance.py` 输出 | 由 runner 采集，不由被测进程产生 |
| 指标与聚合 | bench ledger（评测自有） | 评测自读，产品代码不可读 |

**禁止**：评测 runner 写入 trial home 的任何 RunLedger 文件；评测代码 import 产品存储层写接口；把 ledger 放在 `RUNLEDGER_DIR` 内。

### 3.4 目录布局（提案）

```
tests/bench/                       ← 评测资产根（不叫 *.test.ts，不进 vitest 规则）
  README.md
  packs/<pack-id>/                 ← 任务包
    pack.json
    tasks/<task-id>/{task.json,workspace/**,acceptance.py}
  runner/                          ← 驱动与编排（TS + 必要时的 Python 验收桥）
  scorer/
  ledger/
development-doc/bench/             ← 本文档所在
development-doc/bench/baselines/   ← 提交入版本库的基线 JSON（唯一入库的评测产物）
<bench-root>/                      ← 运行产物（默认 <repo>/tmp/bench，已被 .gitignore 的 tmp/ 覆盖）
  _bench/bench.sqlite
  runs/<runId>/trials/<taskId>-<attempt>/{home,workspace,user,transcript,artifacts.json,result.json}
  reports/<runId>.md
```

`<bench-root>` 默认取 `<repo>/tmp/bench`：`tmp/` 已在 `.gitignore` 中（与 `scripts/record-gate-timings.ts` 写 `tmp/gate-timings.jsonl` 的先例一致），因此无需改 `.gitignore`，也不会把 trial 产物误提交。需要长期保留的只有基线文件，它提交到 `development-doc/bench/baselines/`。

放 `tests/bench/` 而非新顶层目录的理由：`tests/**` 已被 `tsconfig.tests.json` 与 inventory 规则覆盖，`tests/bench/**/*.test.ts` 会自动被 vitest-default 拥有（`fast` bucket），而非 `*.test.ts` 的 runner/fixture 文件既不被 discovery 匹配也不产生 unowned 诊断。若将来确实需要新顶层目录，必须同步补 `scripts/check-typecheck-coverage.ts` 的 CONFIGS / expectedOwner 与新的 tsconfig，否则属于 §6 禁止的静默漏管。

**真实评测 run 绝不进 `npm test`**：它要钱、要网络、耗时分钟级。只有 scorer / 聚合 / ledger 的纯函数单元测试进默认 gate。

## 4. 指标

指标定义数据化，形态参考 metaharness 的 `MetricDefinition`（`key` / `label` / `format` / `higherIsBetter`），每个 pack 与 adapter 自带声明，报表与看板不硬编码语义。完整定义与精度要求见 02 §4。

主指标：

| key | 口径 | 方向 |
|---|---|---|
| `task_pass_rate` | 独立验收器判定通过的 trial / 已判定 trial | ↑ |
| `policy_blocked_rate` | 终态为 `blocked_by_policy` 的 trial / 全部 trial | ↓ |
| `cost_usd_per_pass` | 总成本 / 通过数（无通过时为 `null`，不是 0） | ↓ |
| `active_ms_per_pass` | `active_duration_ms` 总和 / 通过数 | ↓ |

过程指标：`tool_failure_rate`、`approval_count_per_task`、`denial_count_per_task`、`steps_per_task`、`cache_hit_pct`、`ttft_p50_ms`（完整清单与口径见 02 §4.2）。

**`policy_blocked_rate` 与 `approval_count_per_task` 是本中台相对 omp metaharness 的一等新增**：RunLedger 评的不只是「模型能不能完成任务」，还有「治理在什么代价下允许它完成」。把这两者拆成独立指标，才能区分「harness 变强了」与「治理被迫放宽了」。

`unavailable` 与 `0` 必须区分：缺 usage 记 `null` + `reason`，不得写成 0，否则聚合会静默低估成本。

## 5. 阶段计划

### P0 — 口径冻结与试运行

**目标**：在不写任何评测代码的前提下，先确认被测量与被测面。

**交付**
1. 冻结 evaluand 定义：评测对象是当前 checkout 的 `dist` 构建（`bin/runledger.js` → `dist/cli/cli.js`）+ 冻结的 `dist_digest`；tests 与 bench 自身不参与评分。
2. 冻结 profile 矩阵的候选维度：`mode(default|minimal|plan)`、`thinking`、`permission_profile`、`approval_policy`、`recording_mode`、prompt 变体。**排除**「角色模型」（不存在）。
3. 选定首个任务包：从 `tests/manual/development-cases/prompts.json` 的六个案例中取 2–3 个可完全自动化判定的（`01-jsonl`、`03-rename`、`05-markdown`），并为每个写出验收器的判定清单草案。
4. 确认 hermetic 通道可用：`litellm` provider + 本地 HTTP fixture（`tests/manual/harness-repair/run.py` 的先例）。

**验收**：`development-doc/bench/02` 的 schema 与六个案例的验收清单通过 review；一次手工 dry-run（单 task、单 arm、TTY 驱动）产出 `result.json` 与 `independent-acceptance.json`。

**证据级别**：文档 + 人工确认；dry-run 属 automated。

### P1 — 驱动层

**目标**：能以非交互方式跑完一个 task 的一次 attempt，并稳定拿到终态。

**P1a（TTY 驱动，零产品改动）**
- 物化隔离 trial 环境（`home`/`workspace`/`user`），注入 `RUNLEDGER_DIR`、`HOME`、`XDG_*`，剥离凭据类 env。
- 独立 tmux server 启动 `bin/runledger.js`，就绪判定 + fatal 正则拦截，`capture-pane` 取证，退出核对 pane 状态码与 subprocess 探活。
- 注入 prompt，等待 `agent_end`，超时按 pack 声明执行并记 `timeoutKind`。
- 审批适配器 v1：白名单内 `send-keys` 应答 + 决策落盘；白名单外不动作，等待转为 `blocked_by_policy` 终态。

**P1b（headless 评估，独立申请）**
- 产出需求文档：headless 子命令的语义、事件出口格式、审批应答接口、与 `--mode`(AgentMode) 的命名冲突规避。
- 交付被测面变化分析：哪些指标在 A→B 切换后不可比（墙上时间、`active_duration_ms`、审批等待、TUI 相关工具失败）。
- 该阶段**不实施产品改动**，结论交 Runtime 06 / TUI 19 authority。

**验收**
- 同一 task 连续 3 次 run，`result.json` 结构稳定，`artifact_digest` 可复算。
- 故意构造的失败路径各有独立终态：`timeout`、`blocked_by_policy`、`model_error`、`cli_crash`。
- 环境探针：trial home 之外无写入；trial 结束后无残留进程（进程组探活）；真实用户 `~/.runledger` 未被读取或修改。

**证据级别**：automated + built-CLI；不构成 human 或跨平台证据。

### P2 — 采集层

**目标**：把 trial 的执行事实变成结构化指标。

**交付**
1. 只读解析 `session_events`：`agent_start/agent_end`、`turn_start/turn_end`、`tool_execution_start/end`、`message_end`（取 `usage`/`cost`/`durationMs`/`ttftMs`）、`agent_work_pause/resume`（审批等待）。
2. usage/cost 归集：`usage.unknown` 与 `null` 必须保留原因，不得折成 0。
3. 审批与拒绝统计：从事件与驱动决策日志两侧交叉核对，不一致时标 `evidence_conflict`。
4. 运行中增量成本：trial 未结束时即可读当前花费（不等 `agent_end`）。
5. trace 正文按 `recording_mode` 分级：`events` → `content_unavailable`；`events_and_artifacts` → 读 CAS 并重算 digest。
6. 单 trace 上限处理：超过 `100,000` 事件 / `128MiB` 时按 trace store 的 failure policy 结果标注，不静默截断。

**验收**
- 用 hermetic 通道（本地 HTTP fixture）跑零付费 trial，采集结果与 fixture 的确定性预期一致（工具调用次数、turns、终态）。
- 成本字段：已知模型走定价表估算并标注 `source=pricing_table`；未知模型 fail closed，trial 记 `model_unavailable` 而不是猜一个价格。
- `recording_mode=events` 的 trial 明确输出 `content_unavailable`，不产生空字符串。

**证据级别**：automated（hermetic）+ built-CLI。

### P3 — 任务包与独立验收

**目标**：任务可被第三方重放，判定不依赖被测进程。

**交付**
1. 任务包格式落地（`pack.json` / `task.json` / `workspace/` / `acceptance.py`），schema 见 02 §2。
2. 验收器规范：宿主子进程、显式环境、逐条 `check(name, passed, detail)`、`tested_source_sha256`、非零退出即整体 fail、**验收器自身版本与 digest 固定并记入 trial**。
3. 迁移 `01-jsonl` / `03-rename` / `05-markdown` 三个案例为 pack；其余三个（`02-tasks` 多轮、`04-trace` 只读、`06-csv` 中断恢复）标注为后续。
4. 验收器不得读取 trial home、不得读取模型自述、不得复用被测进程的运行时环境。

**验收**
- 同一 trial 的产物在验收器版本不变时可复现相同判定（重复执行两次结果一致）。
- 反向验证：故意把产物改坏（截断文件、写入非法值），验收器必须失败并给出定位信息。
- 三份 pack 在 hermetic 通道下全跑通；判定结果与既有 `results-2026-09-06.json` 的人工结论做一次差异对照，差异逐条解释（历史结论里 `01-jsonl` 的 stdin 缺陷、`03-rename` 的扩展名空格缺陷应被验收器捕获）。

**证据级别**：automated（hermetic）+ built-CLI。

### P4 — 账本与实验聚合

**目标**：能回答「arm A 相对 arm B 好多少」。

**交付**
1. `bench.sqlite`（experiments / arms / runs / trials / metrics），schema 见 02 §5；追加式写入，单进程写。
2. arm 可比性校验：`task_sample_digest` 与 `driver` 不一致时拒绝同图比较并给出原因。
3. resume 语义：按 `(task, attempt)` 复用已完成 trial 与已花费用，只重跑未决项；`--resume <runId>` 从 ledger 恢复。
4. 重跑折叠：`-fix` / `-retry` 后缀折回同一 arm，按 reward/判定优先合并为「一任务一行」。
5. 报表：`reports/<runId>.md`（任务 × arm 矩阵、指标表、失败分类、证据指针）+ 机器可读 JSON。
6. 在飞投影：未完成 run 的最终 pass rate 只以「投影」标注输出，绝不与实测混排。

**验收**
- 两个 arm（同一 task sample，仅一个自变量不同）产出可比较的矩阵与 delta。
- 中断 run 后 `--resume` 复用行为可验证：已完成 trial 不重跑（以 trial 目录 mtime 与 ledger 记录为证），成本不重复计。
- 残留运行态判定：进程不存活或 mtime 超阈值（参考 metaharness 的 30 分钟口径，具体阈值写入 02）才把 `running` 判为陈旧。

**证据级别**：automated。

### P5 — hermetic 通道与 CI 非阻塞接线

**目标**：便宜、确定、可在 CI 跑的一小撮回归数字。

**交付**
1. hermetic task pack：本地 HTTP fixture 驱动，零付费、零外网、确定性工具调用序列。
2. CI job（独立、**非阻塞**）：跑 hermetic pack，上传 artifact（evidence + report），失败不阻断 PR merge，但结果与基线差异超过阈值时产生显式报告。
3. 基线文件：`development-doc/bench/baselines/<date>-<pack>-<pack-digest>.json`（唯一入库的评测产物），含 checkout、`dist_digest`、profile 组合、指标与 digest。
4. 阈值策略：只对确定性指标设阈值（hermetic 下的 `task_pass_rate`、`tool_failure_rate`、`blocked_by_policy` 计数）；时间类指标只记录趋势，不设硬门禁。

**验收**
- 同一 commit 连续两次 CI 运行，hermetic 指标完全一致（确定性证明）。
- 故意引入一处 harness 回归（例如让某个工具失败路径失效），CI 报告能指出对应 task 与指标变化。
- CI job 不在 PR 上做阻塞判断；无网络环境下通过。

**证据级别**：automated（hermetic）+ CI 回执。

### P6 — live 通道

**目标**：对真实 provider 产出可引用数字，且不承担无人值守风险。

**交付**
1. live 前置校验：沿用 `verify_model.py` 思路，先做付费小样本协议校验，把 provider/model/thinking 与证据 digest 绑定为隔离 profile；不匹配即拒绝运行。
2. 凭据边界：真实凭据只进被评测子进程内存（或经 `runledger auth-gateway serve` 走宿主侧解析），产物目录扫描不含凭据值。
3. 成本上限：每个 run 声明 `budget_usd`，达到即停止调度未开始 trial，已开始 trial 允许完成并记录。
4. provider 差异保护：live arm 的 `provider` / `model` / `thinking` 必须显式记录；跨 provider 的结果只作参考不做同图 delta。

**验收**
- 一次 live run（少量 task、单 arm）产出完整 artifact，含成本与实际使用模型核对。
- 产物扫描无凭据泄漏（对照 `test_driver.py` 的 sentinel 断言思路）。
- 预算上限触发路径可验证。

**证据级别**：automated + live-external；**必须标注为人工触发的 live 证据，不得与 hermetic 数字混排**。

### P7 — 只读看板（可选，deferred）

**目标**：不引入第二个常驻服务的前提下提供可浏览投影。

**范围**：从 `bench.sqlite` **静态生成**一个自包含 HTML/JSON 目录（每次 run 结束生成一次），或复用 TUI 只读查询面板模式。**明确不做**常驻 HTTP/SSE 服务、不做写入端点、不做实时推送。若将来确实需要常驻服务，须作为独立计划并先解决 authority 与认证问题。

**状态**：`deferred`，不阻塞 P0–P6。

## 6. 非目标与冻结项

1. **不做 OS sandbox / 容器 / microVM 任务隔离**（`AGENTS.md` §2）。
2. **不新增常驻服务**，评测持久化不得进 `RUNLEDGER_DIR`。
3. **不绕过治理**：不 AllowAll、不关 ExecutionGateway、不以 root 跑被评测进程、不把自动审批实现为「总是允许」。
4. **不使用 `danger-full-access` 作为默认 profile**。
5. **不复制真实凭据进评测产物**，不把真实用户 home 当评测 root。
6. **不把评测 run 放进 `npm test`**；只有纯函数单元测试进默认 gate。
7. **不编辑 pending 的领域计划**（Runtime/TUI/Security/Storage 各专题的 checkbox 与状态归各自文档）。
8. **不为通过评测而修改产品行为**：评测发现的问题记录为具体影响与证据，按领域专题另行处理。
9. **不用 retry / 扩大 timeout / quarantine 掩盖 flake**。
10. **不把 A 驱动与 B 驱动的数字混入同一比较**。

## 7. 验收矩阵与证据分级

自动化的通过不等于人工或跨平台通过。各阶段结论必须标注证据级别：

| 证据级别 | 含义 | 本专题何时产生 |
|---|---|---|
| `automated-hermetic` | 本地 HTTP fixture、零外网、零付费，可进 CI | P2、P3、P5 |
| `automated-live` | 真实 provider，人工触发 | P6 |
| `built-cli` | 经 `bin/runledger.js` → `dist` 的真实构建产物 | P1、P2、P3、P6 |
| `human` | 人工视觉 / 键盘 / 中文 IME 确认 | 本专题基本不涉及（评测不做 UI 验收） |
| `cross-platform` | macOS / Windows 真实 runner | 未计划；现有 typed `unverified_platform` 不改 |

阶段完成声明必须同时给出：`checkout`、`dist_digest`、`task_sample_digest`、`driver`、profile 组合、指标与原始 artifact 指针。缺少任一项即不算可比较结论。

## 8. 风险登记

| 风险 | 影响 | 缓解 |
|---|---|---|
| TTY 驱动慢且脆弱（tmux 依赖、键序敏感） | 并发上限低、长尾 flake | P1b 评估 headless；flake 记录为独立分类，不用 retry 掩盖 |
| 审批 `send-keys` 不可靠 | 应答丢失 → 假 `blocked_by_policy` | P1 起用事件与决策日志交叉核对，冲突标 `evidence_conflict` |
| A→B 驱动切换使历史数字不可比 | 基线断裂 | 驱动身份入 arm 字段；切换即新建 arm |
| 模型随机性导致判定不稳 | 同一 task 时好时坏 | hermetic 通道承担回归；live 只作参考；记录 `attempt` 维度不取单次样本 |
| 工具结果正文默认不可得 | 失败归因困难 | 需要正文的 pack 声明 `recording_mode=events_and_artifacts` 并计磁盘预算 |
| 成本单位与定价表缺口 | 成本低估为 0 | `null` 与 `0` 严格区分；未知模型 fail closed |
| 评测资产被 vitest/inventory 静默纳入或漏管 | 默认门禁变慢或资产无人守护 | 放置于 `tests/bench/`、非 `*.test.ts`；必要时补类型检查登记 |
| 治理放行口径漂移导致 `policy_blocked_rate` 不可比 | 指标失真 | 权限与审批策略写入 arm 字段并纳入可比性校验 |
| 缺少 ModelStore 持久化导致离线不可复现 | hermetic 通道冷启动目录为空 | hermetic 只用带静态 baseline 的 `litellm`/`lm-studio`/`vllm`，不用纯动态 provider |
| 真实 provider 成本失控 | 意外账单 | `budget_usd` + 调度层停止 + live 人工触发 |

## 9. 下一步

1. P0：冻结 evaluand 与首个任务包范围，确认 hermetic 通道（本文 §5 P0）。
2. P0 同时审阅 02 的冻结合同，固化 task/pack/指标/ledger schema。
3. P1a 起建驱动层，先跑通单 task 单 attempt 的端到端，再谈并发与聚合。
