# 评测中台参考：oh-my-pi `packages/metaharness`

> 状态：`reference`（设计输入，不是 RunLedger 的完成状态或复制目标）
>
> 建档日期：2026-09-16
>
> 参考 checkout：oh-my-pi `main`，路径 `packages/metaharness`（含 `src/`、`adapters/`、`agent/`、`scripts/`、`test/`）。
>
> 本文只整理参考实现的可复用机制与明确不采纳的部分。RunLedger 的落地计划见 [`01-bench-platform-implementation-plan.md`](01-bench-platform-implementation-plan.md)，冻结合同见 [`02-task-pack-and-scoring-contract.md`](02-task-pack-and-scoring-contract.md)。

## 0. 参考对象是什么

`@oh-my-pi/pi-metaharness` 是 oh-my-pi 仓库内的 private 包（`package.json` 的 `private: true`、`bin: metaharness → src/server.ts`），定位是「一个 manager 管多个 benchmark」：把 Harbor、TypeScript edit、SnapCompact 三类评测统一到同一套 `experiment → run → trace` 模型、同一份 SQLite、同一套 REST/SSE 与同一个 dashboard，各 benchmark 的原生产物仍留在磁盘上，由 adapter 归一化。

它不是 agent 运行时组件，不被 `packages/coding-agent` 依赖；它是「产出分数」的那一层。

## 1. 参考实现的机制事实

### 1.1 实验模型

| 机制 | 事实 |
|---|---|
| experiment id | job name 的第一个 `-` 分隔 token；`sb2-n8`、`sb2-gemini` 同属 experiment `sb2`（`src/experiments.ts` 的 `experimentOf`） |
| arm | job name 去掉 experiment 前缀（`armOf`），可由用户用 label 覆盖显示名 |
| 重跑折叠 | `-fix` / `-backfill` / `-retry` / `-rerun` / `-bf\d*` 后缀经 `canonicalArmOf` 折回同一 arm；`pickMergedTrials` 按 reward 把重跑合并成「一任务一行」 |
| 在飞投影 | `calibratedFinalPassPct` 按任务难度给出运行中 arm 的最终通过率投影，UI 用虚线区分「实测」与「投影」 |
| 可比性继承 | 新增 arm 时服务端 `resolveArmLaunch` 从 sibling arm 继承 dataset 与精确任务样本，只让用户填 arm 专属变量 |
| 参考臂 | `pickReferenceArm` 取「已完成的 baseline 中通过率最高者」当参考天花板；`Delta` 输出百分点/相对差，`ScatterChart` 把 cost-vs-success 画成象限 |

### 1.2 存储与真源

- 归一化状态在 `<jobs-dir>/_manager/metaharness.sqlite`；**文件系统是真源**，`RunStore.discover()` 把历史 CLI 跑出的 job dir 回填为 run 行，`_bench` / `_manager` 被 `NON_JOB_DIRS` 排除（`src/store.ts`）。
- 度量语义数据化：`BENCHMARK_DEFINITIONS` 里每个 benchmark 自带 `MetricDefinition[]`（harbor `success_rate`；edit `task_success_rate`/`edit_success_rate`；snapcompact `f1`/`exact_match`），存储与 UI 不硬编码 benchmark 语义（`src/benchmarks.ts`）。
- 残留运行态靠证据判定：job dir 30 分钟无 mtime 变化（`JOB_DIR_STALE_MS`）或 pid 不存活（`processAlive`）才把 `running` 行判为陈旧。

### 1.3 执行与凭据边界

- `--install source`：仓库只读 bind-mount 进任务容器 + 一份 manifest 骨架的 linux `node_modules` 缓存（`prepareSourceDeps` / `sourceDepsStamp`）+ 挂载 linux `bun` 到 `/opt/omp/bin`；TS 改动**下一个 trial 生效**，trial 装配零出网。
- 备选 `--install local`（每 run `bun pm pack`）、`--install published`、`--binary`（预编译 `omp-linux-*`）。
- 凭据不进容器：`writeModelsYaml` 把 provider `baseUrl` 指向宿主 auth-gateway（`http://host.docker.internal:4000`，apple-container 下 `192.168.64.1:4000` 并由 `startVmnetGatewayForward` 反代）；只有 `--no-gateway` 才把 host key 传进容器。
- 可恢复：`resolveResumeConfig` 从 `_bench/<name>/runner-config.json` 快照或 run 的 `manager.json` 恢复原始 flag；`POST /api/runs/:name/resume` 复用已完成 trial（含已花费用）、重跑中断/待跑、按 exception type 重试（`--filter-error-type`）。
- 运行中成本：增量解析 live transcript（首扫只读尾部 16MiB，超 4MiB 的单行判定为损坏跳过），不等 trial 结束就能看花费。

### 1.4 服务与展示

- `src/server.ts` 用 `Bun.serve` 把 dashboard 与 API 放**同一端口**（`routes: {"/": indexHtml}`，无独立 Vite 进程）；SSE 推送运行列表快照。
- REST 面覆盖 experiment 的增删改查、arm 追加、run 启动/取消/恢复/删除、trace 读取（`?raw=1` 取原生）。
- 原生 Terminal-Bench 2.1 runner（`src/tb/`）绕开 Harbor/Docker：任务 OCI 镜像在远程 KVM microVM 启动，`vmon exec --pipe` 里跑 omp 的 `--mode rpc`，verifier 在同一被改动的 VM 内执行，epoch 级 resume 与 `--forever`。
- `scripts/trace-report.ts` 把一条 trace 经两段 map/reduce 便宜模型转成叙事报告（逐轮 Turn Log + Story Arc + 失败分析）。
- `agent/omp_local.py` 是 Harbor 的 agent 实现：在任务容器里跑**工作树里的 omp**而不是 npm 版，支持 source/local/binary 三种安装模式。

### 1.5 它依赖的、RunLedger 没有的前提

metaharness 之所以能这么薄，是因为 omp 提供了三件 RunLedger 当前不具备的东西：

1. **headless 入口**：`omp --mode rpc` / `cli.ts` 可在无 TUI 的进程里跑完整 agent 循环；metaharness 的 runner 只做编排。
2. **容器 / microVM 任务执行**：任务隔离靠 Docker 或 Vibemon，不靠宿主进程。
3. **远端数据集**：Harbor 提供 `terminal-bench@2.0` 之类的任务集与 verifier。

RunLedger 三件都没有，所以参考实现的「编排层」不能直接照搬，必须先把驱动与任务包这两层补上——这正是 01 计划的 P0–P4。

## 2. 采纳与不采纳

### 2.1 采纳（机制层）

| 采纳项 | RunLedger 落点 |
|---|---|
| experiment → run → trace 三段模型与 arm 语义 | 01 §3.2；experiment id 取自 arm 名首段，重跑后缀折叠 |
| 度量定义数据化（`MetricDefinition` 模式） | 02 §4；每个 benchmark adapter 自带指标定义，报表与看板不硬编码 |
| 文件系统真源 + 归一化只读 store | 01 §3.4；trial 产物留在 `bench-runs/<runId>/`，ledger 由 `sync` 归一化 |
| arm 继承样本 + 只改一个变量 | 01 §5（P4）；arm 继承 task sample 与 frozen 配置，只让用户改目标变量 |
| resume 语义（复用已完成 trial 与花费） | 01 §5（P4）；按 `(task, attempt)` 复用，只重跑未决项 |
| 凭据留在宿主、子进程只见受控注入 | 01 §5（P3）；复用 `LITELLM_BASE_URL` / provider env 与隔离 home，禁止复制 `auth.json` 入产物 |
| 运行中增量成本 | 01 §5（P3）；从 `session_events` 增量读 `usage`/`cost`，不等 trial 结束 |
| 超时 / 预算 / 并发 / 残留清理 | 01 §5（P3）；复用 `run-test-buckets.ts` 的 watchdog、进程组清理与 `cleanup.status` 判定 |
| 只读投影看板 | 01 §5（P6）；从 ledger 生成，不做第二个常驻服务 |
| trace 叙事报告 | 01 §7（deferred）；先做结构化报表，叙事报告按需 |

### 2.2 不采纳（边界层）

| 不采纳项 | 理由 |
|---|---|
| Docker / microVM 任务执行 | `AGENTS.md` §2 明确 OS sandbox 与进程隔离处于冻结状态，不得顺带扩展；评测任务先在宿主隔离目录执行（与 `tests/manual/development-cases` 现有做法一致） |
| 第二个常驻 HTTP 服务作为 authority | RunLedger 是单包（Plan 13 尚未拆包），新增常驻服务会把 authority 挪出 `RUNLEDGER_DIR` 与 Session Owner；看板降级为只读投影 |
| Harbor / terminal-bench 数据集依赖 | 会重新引入容器与外部注册表；任务集改为仓库内 task pack |
| `bun pm pack` / 跨平台预编译二进制分发 | RunLedger 不发布多平台自包含产物，评测对象是当前 checkout 的构建产物 |
| 用 `danger-full-access` 作为无人值守默认 | 见 `src/security/permission/engine.ts:90`；评测默认不绕过治理，权限面必须显式记录在 run manifest 里 |
| 远端 trace exporter（Opik） | Phase 04 未实现，评测中台不复用也不阻塞 |

## 3. 一句话对照

omp metaharness 解决的是「**多个容器化 benchmark 的统一编排与展示**」；RunLedger 需要解决的是「**同一 checkout 的 harness 行为在任务级样本上是否变好**」。前者可以假设 headless 入口与容器隔离已经存在，后者必须先把这两层建出来，并且必须证明评测数字来自真实 CLI 与真实治理链路，而不是测试替身。
