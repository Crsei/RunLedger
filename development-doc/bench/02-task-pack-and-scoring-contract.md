# 评测中台冻结合同：任务包、验收与指标

> 状态：`frozen-candidate`（本文件是评测中台的数据与判定契约；实施计划见 [01](01-bench-platform-implementation-plan.md)）
>
> 建档日期：2026-09-16
>
> 冻结范围：task pack 结构、acceptance 协议、指标定义、bench ledger schema、trial 终态枚举、证据 digest 规则、可比性规则。
>
> 变更规则见 §9。任何字段增删改都必须走该节流程，不允许实现方就地扩展。

## 1. 冻结原则

1. **判定与执行分离**：执行产出的「终态」与被验收的「判定」是两个独立维度，绝不合并成一个分数。omp metaharness 把两者压成一个 reward，是因为它的 verifier 在容器内由 Harbor 管理；RunLedger 的验收在宿主侧，必须显式区分「跑完了」与「做对了」。
2. **`null` ≠ `0`**：任何缺失的量化事实记 `null` 并带 `reason`，不得折成 0。这条对成本、token、时长尤其重要——把未知折成 0 会让聚合静默低估。
3. **源事实不可变**：trial 的 `state.db`、`events/**`、`artifacts/**` 一经写入即视为证据，评测侧只读。ledger 是可重建的投影，不是第二真源。
4. **契约自描述**：每个 pack、task、acceptance、ledger 行都带自己的版本号与 digest；跨版本比较默认拒绝，除非显式声明兼容。
5. **允许被拒绝**：「治理挡住了任务」是评测结果，不是评测失败。`blocked_by_policy` 是一等终态。

## 2. 任务包（task pack）

### 2.1 目录结构

```text
tests/bench/packs/<pack-id>/
  pack.json                     # pack 级元数据与共享约束
  tasks/<task-id>/
    task.json                   # 单个任务的 prompt、限制与验收声明
    workspace/                  # 初始工作区文件（可选；存在则整体复制到 trial workspace）
    acceptance.py               # 宿主侧验收器（必需）
    fixtures/                   # 验收器使用的边界样例（可选）
```

### 2.2 `pack.json`

```jsonc
{
  "format": "runledger-bench-pack",
  "id": "dev-core",                       // [a-z0-9-]+，pack 身份
  "title": "RunLedger 开发核心任务集",
  "packVersion": "1.0.0",
  "description": "从 development-cases 迁移的可自动判定任务子集",
  "defaults": {
    "timeoutMs": 900000,                  // 单 attempt 的 agent 墙钟上限
    "attempts": 1,
    "recordingMode": "events",            // events | events_and_artifacts
    "budgetUsd": 2.0                      // 该 pack 每个 run 的成本上限
  },
  "runner": {
    "runtime": "node",                    // 任务工作区的运行时提示（写入 workspace/AGENTS.md）
    "hermetic": true                      // 是否可在无外部模型通道下运行
  },
  "tasks": ["01-jsonl", "03-rename", "05-markdown"]
}
```

约束：

- `tasks` 的顺序**构成 sample 的一部分**；改顺序即改 sample digest。
- `defaults.recordingMode=events_and_artifacts` 必须同时声明 `artifactBudgetBytes`，否则 pack 校验失败。
- `packVersion` 与稳定的 `format` 标识都参与 `pack_digest` 计算。

### 2.3 `task.json`

```jsonc
{
  "format": "runledger-bench-task",
  "id": "01-jsonl",
  "title": "JSONL 日志统计 CLI",
  "prompt": "…完整任务提示（中文，含「不提交或推送」等约束）…",
  "workspace": {
    "runtime": "node",                    // node | python | none
    "seedBun": true                       // 是否把宿主 bun 二进制复制到 workspace/.runtime/bun
  },
  "limits": {
    "timeoutMs": 900000,                  // 覆盖 pack 默认
    "maxTurns": 60,                       // 可选：超过则终止并记 terminated
    "budgetUsd": 1.5                      // 可选：单 attempt 成本上限
  },
  "acceptance": {
    "entry": "acceptance.py",
    "checks": [                           // 期望的检查项 id 与说明；验收器输出必须与之一致
      { "id": "core_stats", "title": "常规统计正确", "weight": 1 },
      { "id": "filter_service", "title": "--service 过滤生效", "weight": 1 },
      { "id": "json_format", "title": "--format json 结构正确", "weight": 1 },
      { "id": "bad_line_tolerance", "title": "坏行继续处理并在 stderr 报行号", "weight": 1 },
      { "id": "top5_ordering", "title": "耗时 Top 5 排序正确", "weight": 1 }
    ],
    "passPolicy": "all",                  // all | threshold
    "threshold": null                     // passPolicy=threshold 时的通过线（0–1）
  },
  "requires": {
    "autoApproval": ["fs-write-workspace", "shell-known"]  // 见 §6；缺省为空 = 不允许任何自动应答
  }
}
```

约束：

- `acceptance.checks[].id` 是稳定标识；验收器输出的 `check` id 必须是该集合的子集，多出即整体判 `unscored`（防止验收器悄悄放宽标准）。
- `passPolicy=all` 是默认：任一项失败即 `fail`。
- `requires.autoApproval` 只声明**本任务需要**的自动应答类别；runner 取 pack 与 task 的并集，且必须与运行时的 profile 组合兼容，否则在 trial 开始前拒绝（fail fast，不浪费成本）。

## 3. 验收契约（acceptance）

### 3.1 调用协议

验收器由 runner 以**宿主进程**启动，不进入被评测进程的环境：

```
python3 <task>/acceptance.py --workspace <abs trial workspace> --out <abs result path>
```

- `cwd` 为**验收器自身目录**，不是 workspace。
- 环境为清洗后的宿主环境（剥离 `RUNLEDGER_DIR`、凭据类变量），**不得**包含被评测 session 的 home、token 或事件。
- 退出码：`0` = 全部 check 通过；非零 = 至少一项失败或验收器自身错误（后者必须在输出里以 `acceptance_error` 区分）。

### 3.2 输出格式

```jsonc
{
  "format": "runledger-bench-acceptance",
  "acceptanceVersion": "1.0.0",
  "taskId": "01-jsonl",
  "workspace": "/abs/path/to/workspace",
  "testedDigest": { "algorithm": "sha256", "digest": "…" },   // 被验收产物的整体 digest
  "checks": [
    { "id": "core_stats", "passed": true, "detail": "6/6 记录统计一致" },
    { "id": "bad_line_tolerance", "passed": false, "detail": "第 7 行坏 JSON 未在 stderr 报行号" }
  ],
  "passPolicy": "all",
  "verdict": "pass",                                           // pass | fail | error
  "environment": "independent host subprocess; not the evaluated process environment"
}
```

### 3.3 禁止事项

1. 验收器不得读取 trial 的 `home/`（`state.db`、`events/`、`artifacts/`）。
2. 验收器不得读取模型的最终自述文本作为判定依据。
3. 验收器不得复用被测进程的运行时环境（含其 `.runtime/bun` 之外的路径劫持）。
4. 验收器不得修改 workspace；需要临时文件时用 `--out` 同级的临时目录。
5. 验收器不得因「没找到文件」而静默通过；缺产物一律 `fail` 并给出期望路径。

### 3.4 采集规则

runner 采集时必须记录：

| 字段 | 来源 |
|---|---|
| `acceptanceVersion` + `acceptanceDigest` | 验收器文件 sha256 |
| `verdict` | 验收器退出码与输出交叉核对；不一致记 `evidence_conflict` 并判 `unscored` |
| `testedDigest` | 验收器输出；与 runner 自己算的 workspace digest 对照 |
| `checkResults` | 验收器 `checks[]`，逐项保留 |

## 4. 指标定义

指标声明形态（每个 pack 可追加自定义指标，但 §4.2 的四个主指标不可改名、不可改口径）：

```jsonc
{ "key": "task_pass_rate", "label": "任务通过率", "format": "percent", "higherIsBetter": true, "unit": "ratio" }
```

### 4.1 主指标（跨 pack 固定）

| key | 定义 | format | 方向 | 缺失语义 |
|---|---|---|---|---|
| `task_pass_rate` | `count(verdict=pass) / count(verdict ∈ {pass, fail})` | percent | ↑ | 分母为 0 时 `null` |
| `policy_blocked_rate` | `count(execution=blocked_by_policy) / count(all trials)` | percent | ↓ | 不适用时为 0（分母恒 > 0） |
| `cost_usd_per_pass` | `sum(cost_usd) / count(verdict=pass)` | usd | ↓ | 无通过时为 `null` |
| `active_ms_per_pass` | `sum(active_duration_ms) / count(verdict=pass)` | number | ↓ | 无通过或全缺时为 `null` |

`unscored` 的 trial 从 `task_pass_rate` 的分母中排除，但**计入** `policy_blocked_rate` 的分母，并在报表中单列。

### 4.2 过程指标

| key | 定义 | 方向 |
|---|---|---|
| `tool_failure_rate` | `count(tool_execution_end.isError=true) / count(tool_execution_end)` | ↓ |
| `tool_calls_per_task` | `count(tool_execution_end) / count(trials)` | — |
| `steps_per_task` | `count(turn_start) / count(trials)` | — |
| `approval_count_per_task` | 被应答的 `agent_work_pause(reason=approval)` 数 / tasks | ↓ |
| `denial_count_per_task` | 治理 `deny` 决策数 / tasks | ↓ |
| `cache_hit_pct` | `cacheRead / (input + cacheRead + cacheWrite)` | ↑ |
| `ttft_p50_ms` | assistant 首 delta 推算的 TTFT 中位数 | ↓ |
| `wall_ms` | 驱动层墙钟（含 TUI 与审批等待） | — |

### 4.3 精度与来源标注

每个数值指标必须随行携带来源：

- `usage.source ∈ {provider, metered, estimated, replayed, unavailable}`
- `cost.source ∈ {provider, pricing_table, metered, estimated, unavailable}`
- 时间类：`timing.source ∈ {event, driver_clock}`
- TTFT 只能标 `derived_first_delta`，不得标为 provider 上报。

## 5. bench ledger schema

### 5.1 位置

`<bench-root>/_bench/bench.sqlite`。`<bench-root>` 默认 `<repo>/tmp/bench`（已被 `.gitignore` 的 `tmp/` 覆盖），可被 `--bench-root` 覆盖；**不得**位于任何 `RUNLEDGER_DIR` 内。trial 的原始产物在 `<bench-root>/runs/<runId>/trials/...`，是证据真源；ledger 是可重建投影。唯一入库的评测产物是提交到 `development-doc/bench/baselines/` 的基线 JSON。

### 5.2 当前 DDL

```sql
CREATE TABLE schema_meta (
  schema_version INTEGER PRIMARY KEY,
  applied_at_ms   INTEGER NOT NULL,
  format_digest   TEXT NOT NULL
);

CREATE TABLE experiments (
  id          TEXT PRIMARY KEY,          -- [a-z0-9-]+，arm 名首段
  goal        TEXT,                      -- 该实验要回答的问题
  created_at_ms INTEGER NOT NULL
);

CREATE TABLE arms (
  experiment_id      TEXT NOT NULL REFERENCES experiments(id) ON DELETE CASCADE,
  arm                TEXT NOT NULL,      -- 不含 experiment 前缀
  label              TEXT,               -- 显示名；与 arm 语义等价，仅展示
  -- 可比性身份（改任一项即视为不同 arm）
  driver             TEXT NOT NULL,      -- e.g. tty-1 | headless-1
  mode               TEXT NOT NULL,      -- 当前实际值是 AgentMode: default|minimal|plan
  harness_profile    TEXT NOT NULL,      -- standard|minimal|plan + 版本
  provider           TEXT NOT NULL,
  model              TEXT NOT NULL,
  thinking           TEXT NOT NULL,
  permission_profile TEXT NOT NULL,
  approval_policy    TEXT NOT NULL,
  recording_mode     TEXT NOT NULL,      -- off|events|events_and_artifacts
  auto_approval_json TEXT NOT NULL,      -- 生效的自动应答类别数组
  pack_id            TEXT NOT NULL,
  task_sample_digest TEXT NOT NULL,      -- §8.1
  config_digest      TEXT NOT NULL,      -- 上述字段的规范化 sha256
  PRIMARY KEY (experiment_id, arm)
);

CREATE TABLE runs (
  run_id           TEXT PRIMARY KEY,
  experiment_id    TEXT NOT NULL,
  arm              TEXT NOT NULL,
  commit_sha       TEXT,
  dirty_digest     TEXT,                 -- 工作树 dirty 路径的规范化 digest；clean 为 NULL
  dist_digest      TEXT NOT NULL,        -- dist/cli/cli.js 的 sha256
  bench_version    TEXT NOT NULL,        -- 评测中台自身版本
  started_at_ms    INTEGER NOT NULL,
  finished_at_ms   INTEGER,
  status           TEXT NOT NULL,        -- running|complete|failed|cancelled|stale
  budget_usd       REAL,
  resumed_from     TEXT,                 -- 被恢复的 runId
  FOREIGN KEY (experiment_id, arm) REFERENCES arms(experiment_id, arm) ON DELETE CASCADE,
  CHECK (status IN ('running','complete','failed','cancelled','stale'))
);

CREATE TABLE trials (
  run_id           TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  task_id          TEXT NOT NULL,
  attempt          INTEGER NOT NULL,
  -- 执行事实
  execution        TEXT NOT NULL,        -- §5.3 闭集
  stop_reason      TEXT,
  termination_reason TEXT,
  cli_exit_code    INTEGER,
  timeout_kind     TEXT,                 -- watchdog|task|none
  started_at_ms    INTEGER NOT NULL,
  finished_at_ms   INTEGER,
  wall_ms          INTEGER,
  active_duration_ms INTEGER,
  turns            INTEGER,
  tool_calls       INTEGER,
  tool_failures    INTEGER,
  approval_pauses  INTEGER,
  denials          INTEGER,
  input_tokens     INTEGER,
  output_tokens    INTEGER,
  cache_read_tokens INTEGER,
  cache_write_tokens INTEGER,
  cost_usd         REAL,
  usage_source     TEXT,
  cost_source      TEXT,
  -- 判定
  verdict          TEXT NOT NULL,        -- pass|fail|error|unscored
  unscored_reason  TEXT,
  -- 证据
  trial_dir        TEXT NOT NULL,
  artifact_digest  TEXT NOT NULL,
  evidence_flags   TEXT NOT NULL DEFAULT '[]',  -- JSON 数组，如 ["content_unavailable","evidence_conflict"]
  attempt_receipt_outcomes TEXT,          -- 逗号连接的闭集值，便于快速筛选
  PRIMARY KEY (run_id, task_id, attempt),
  CHECK (execution IN ('completed','model_error','aborted','terminated','timeout','blocked_by_policy','cli_crash','not_started','incomplete')),
  CHECK (verdict IN ('pass','fail','error','unscored'))
);

CREATE TABLE trial_checks (
  run_id   TEXT NOT NULL,
  task_id  TEXT NOT NULL,
  attempt  INTEGER NOT NULL,
  check_id TEXT NOT NULL,
  passed   INTEGER NOT NULL,
  detail   TEXT,
  PRIMARY KEY (run_id, task_id, attempt, check_id),
  FOREIGN KEY (run_id, task_id, attempt) REFERENCES trials(run_id, task_id, attempt) ON DELETE CASCADE
);

CREATE TABLE metrics (
  run_id   TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  scope    TEXT NOT NULL,               -- run | arm | task
  scope_id TEXT NOT NULL,               -- runId / arm / taskId
  key      TEXT NOT NULL,
  value    REAL,                        -- NULL = 未定义（见 §4 缺失语义）
  format   TEXT NOT NULL,
  source   TEXT,
  PRIMARY KEY (run_id, scope, scope_id, key)
);

CREATE TABLE decisions (               -- 审批与拒绝的逐条审计
  run_id    TEXT NOT NULL,
  task_id   TEXT NOT NULL,
  attempt   INTEGER NOT NULL,
  ordinal   INTEGER NOT NULL,
  kind      TEXT NOT NULL,             -- filesystem|shell|network|worktree|tool
  request_digest TEXT NOT NULL,
  summary   TEXT NOT NULL,             -- 脱敏后的短摘要（命令/路径）
  decision  TEXT NOT NULL,             -- allow|deny|ask|blocked
  responder TEXT NOT NULL,             -- auto:<category> | user | none
  matched_rules TEXT,
  created_at_ms INTEGER NOT NULL,
  PRIMARY KEY (run_id, task_id, attempt, ordinal)
);

CREATE INDEX idx_trials_run ON trials(run_id, execution, verdict);
CREATE INDEX idx_runs_arm ON runs(experiment_id, arm, started_at_ms);
```

### 5.3 `execution` 闭集与判定依据

| 值 | 判定依据（按优先级从高到低） |
|---|---|
| `cli_crash` | 进程非零退出且无 `agent_end` |
| `timeout` | runner watchdog 或 task `timeoutMs` 触发 |
| `blocked_by_policy` | 存在未被应答的 `agent_work_pause(reason=approval)` 且 run 已结束 |
| `model_error` | `message_end` 的 assistant `stopReason=error` |
| `aborted` | `agent_end.stopReason=aborted` |
| `terminated` | `agent_end.terminationReason` 非空（如 `repeated_tool_failure`） |
| `not_started` | 无任何 `agent_start`（例如模型不可用、前置校验失败） |
| `incomplete` | 无 `agent_end` 且无以上证据 |
| `completed` | `agent_end.stopReason=stop` 且 CLI 退出码 0 |

`execution` 与 `verdict` 正交：`completed` 的任务仍可能 `fail`；`blocked_by_policy` 的任务不计入 `task_pass_rate` 分母，但必须出现在报表与 `policy_blocked_rate` 中。

### 5.4 陈旧运行判定

`status=running` 的 row 只在**同时**满足以下两条时降级为 `stale`：进程不存活（按记录的 pid/进程组探活失败）**且** run 目录与其 `result.json` 的最新媒体 mtime 距今超过阈值。阈值默认 30 分钟，写入 `<bench-root>/_bench/config.json` 后可调。禁止仅凭时间单条件降级。

## 6. 审批与权限记录契约

### 6.1 自动应答类别（白名单闭集）

| 类别 | 允许的内容 | 依据 |
|---|---|---|
| `fs-write-workspace` | 目标路径位于 trial workspace 根内的 filesystem mutation | 路径规范化后前缀判定 |
| `shell-known` | 仓库既有 shell 分类结果为「已知/无需审批」的命令；`ask`（危险或未知）一律不自动应答 | 复用在产的分类结果，不新增分类器 |
| `net-allowlisted` | task 显式声明的 host，且运行时 `--network` 为 `allowlist` 或 `review` 且 host 在表内 | host 精确匹配 |

约束：

1. 类别之外一律**不自动应答**：trial 结束为 `blocked_by_policy`，逐条写 `decisions` 行（`decision='blocked'`、`responder='none'`）。
2. 禁止出现 `auto-allow-all` 之类的兜底类别。
3. `danger-full-access` 仅在 arm 显式声明时可用，且该 arm 的报表必须印出来源标记；默认 profile 为 `workspace-write`。
4. 每条决策必须记录 `request_digest` 与命中依据；`summary` 走脱敏（不写凭据、不写完整环境变量）。

### 6.2 与产品语义的关系

- `--approval-policy never` 会把 `ask` 转 `deny`，因此 **`never` 只允许用于 read-only 类任务**；用于普通任务时 `denial_count_per_task` 会升高、`task_pass_rate` 会下降，这是被测量的现象而不是中台的 bug。
- 自动应答器只在驱动层实现，不进产品代码；它复用产品给出的决策结果（`allow` 才可能被应答），不覆盖 `deny`。

## 7. 证据包与 digest 规则

每个 trial 目录产出：

```text
trials/<taskId>-<attempt>/
  home/                    # trial 的 RUNLEDGER_DIR（只读证据）
  workspace/               # 被测进程的 cwd（验收对象）
  user/                    # HOME
  transcript/              # TTY 帧（tty 驱动）或事件流（headless 驱动）
  decisions.json           # §5.2 decisions 的导出副本
  acceptance.json          # 验收器原始输出
  artifacts.json           # trial 证据清单：每个文件的相对路径 + sha256 + 类别
  result.json              # 采集层的结构化结果（写入 ledger 的同一份数据）
```

规则：

1. `artifacts.json` 的 digest 用 sha256；`artifact_digest`（入 ledger）是 `artifacts.json` 自身内容的规范化 sha256。
2. `result.json` 与 ledger 行必须逐字段一致；不一致时以 `result.json` 为准并记 `evidence_conflict`。
3. 凭据扫描：写 artifact 前对全部产物做一次 sentinel 扫描（沿用 `tests/manual/development-cases/test_driver.py` 的断言思路），命中即中止并报错，不写 ledger。
4. 报告与基线文件用同一 digest 口径，便于跨日期比对。

## 8. 可比性规则

### 8.1 `task_sample_digest`

```
sha256( canonical_json( [{ task_id, attempts, order } …] ) )
```

两个 arm 只有在 `task_sample_digest`、`driver`、`provider`、`model`、`thinking`、`mode`、`harness_profile`、`permission_profile`、`approval_policy`、`recording_mode`、`pack_id` 全部相同时，才允许同图 delta 比较。任一不同即只输出并列表格，不输出差值。

### 8.2 resume 语义

- 复用单元是 `(run_id, task_id, attempt)`：已有可复用的 `verdict` 时跳过执行，成本按原值计入且不重复累加。
- 不可复用的情形：`execution ∈ {timeout, cli_crash, blocked_by_policy, incomplete, not_started}` 默认重跑；`verdict ∈ {fail, error}` 默认**不重跑**（失败是结果，不是噪声），除非显式传 `--retry-failed`。
- 恢复必须校验：`dist_digest`、`task_sample_digest`、`config_digest` 与目标 run 一致，否则拒绝并提示新建 run（防止把不同构建混进一个 run）。

### 8.3 重跑折叠

`-fix` / `-retry` / `-rerun` / `-bf\d*` 后缀折回同一 arm；同一 `(task, attempt)` 有多份结果时，按 `verdict` 优先级合并为一行：`pass` > `fail` > `error` > `unscored`；被折叠掉的原始 trial 保留在 `trials` 表中（以 run 区分），报表额外列出折叠来源。

## 9. 变更规则

1. 本文任何字段的增删改都必须：先在本文更新、再改实现、最后在同一提交里更新受影响 pack 的声明与内容 digest；任务内容变化同步更新 `packVersion`。
2. `format` 是稳定的当前格式标识，不编码内部代际。读取端严格校验当前合同；不兼容的旧数据明确拒绝，ledger 迁移走显式入口（与产品存储的显式迁移原则一致），**不新增猜测格式、不做静默导入**。
3. 新增指标（非 §4.1 主指标）可单独发布，不影响既有行。
4. 修改 `passPolicy`、`acceptance.checks` 集合或验收器判定逻辑，等同于改变被测标准：必须提升 `acceptanceVersion`，且新旧结果不得混入同一 arm 比较。
5. 修改自动应答类别集合必须回归 §6 的闭集约束，并重新跑一次「越界请求必须 `blocked_by_policy`」的负向验收。
