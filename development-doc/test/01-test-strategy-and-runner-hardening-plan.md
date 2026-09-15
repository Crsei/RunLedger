# RunLedger 测试策略与 Runner 加固实施计划

> 状态：`in_progress`
>
> 建档日期：2026-09-01
>
> 当前审计基线：`rollback/before-composer-shape@3c594f4754648b61080d8f09a3a4b90e5172b457`；本次建档前工作树干净。后续实施必须重新核对 checkout 与 dirty paths，不能沿用本文的工作树假设。
>
> 参考输入：当前 RunLedger 测试清点、oh-my-pi `main@b4e8e856ad40294167679a3f88417c07429fe59b` 的测试分桶与 CI 拓扑。参考项目只提供方法，不是复制目标。

> 实施进度（2026-09-01）：P0、P1、P2 已完成；P3、P4 的仓库内实现已完成，远端 GitHub job 尚未在本轮触发；P5 为 `partial`（evidence manifest、隔离 home、watchdog 与无 retry 已落地，duration 观测入口与首个分桶基线已落地，timeout/RSS 峰值/crash 类型采集与 quarantine 治理仍未实现）；P6、P7 保持 `planned/pending`，不得由本地 Linux 自动化代替真实 macOS/Windows、人工视觉/IME 或 live external 证据。
>
> 2026-09-16 追加 duration 证据：`npm run time:gates` 在 `rollback/before-composer-shape@d91367a`（dirty 工作树，load average 13.08）记录 `npm run check` 74.4s、`npm test` 775.6s，均 `exit 0`；分桶分解与四条实测原因见 §4 P5.1。该样本为单机单次观测，不构成阈值。
>
> 本轮 fresh automated evidence：focused Vitest 4 files / 17 tests 通过；`npm run test:inventory` 报告 476 owned files / 0 diagnostics；`npm run check`、`npm run build`、`npm run test:smoke` 与 `git diff --check` 通过。`test:smoke` 在隔离 `RUNLEDGER_DIR` 中验证候选 `bin/runledger.js → dist/cli/cli.js` 的 `--version`、`--help`，并以独立 tmux server 观察 TUI 启动帧和 Ctrl+D/Esc 后干净退出；它不是人工视觉验收。最终状态的默认 `npm test` 连续两次以外层 `exit 0` 完成（日志：`/tmp/runledger-final-stable-green-1.log`、`/tmp/runledger-final-stable-green-2.log`）。远端 CI、真实 macOS/Windows、人工和 live provider 均未在本轮执行。

## 0. 结论

RunLedger 当前测试深度已经覆盖 Runtime、TUI、Storage、CLI、Provider、Security、Extension、Contract、真实 Git/进程与部分 PTY。本轮关闭了 baseline 中的默认发现、资源归属与本地 CI/CLI smoke 缺口：

1. **完整发现**：`scripts/test-inventory.ts` 已强制 runner 的唯一归属、空 glob/overlap/unowned fail closed，并递归覆盖 Bun 文件；post-build PTY test 显式属于非默认的 `smoke` bucket。
2. **资源分桶**：canonical runner 已为 fast、singleton、runtime、security-storage、integration、tui-native、rust-native 与 smoke 生成稳定 argv、并发预算、watchdog、临时 RunLedger home 与可脱敏 execution manifest；它不自动 retry assertion failure。
3. **证据分层**：`.github/workflows/test.yml` 已定义 Linux PR/push job 与 fail-closed 汇总 gate；构建候选 smoke 记录 manifest digest、CLI 输出和 tmux 生命周期。CI 运行回执、跨平台、人工视觉和 live provider 仍是独立未完成证据。

本计划先关闭漏测，再建立可复核 inventory 和确定性分桶，随后接入 CI、标准产物 smoke、PTY/平台证据与质量治理。目标不是追赶 oh-my-pi 的测试数量，而是让每次变更的测试选择、执行环境、失败归属和完成证据都可解释、可重放、可审计。

## 1. 权威边界

### 1.1 本文负责

- `tests/**/*.test.ts` 与 Rust native 测试的发现、归属和默认覆盖；
- Vitest、Bun Test、Cargo test 的本地入口和 CI 编排；
- unit/component、singleton、runtime/session、security/storage、integration/E2E、native/TUI、contract、smoke 的分层；
- 测试隔离、凭据清洗、超时、资源释放、flake 处理和证据清单；
- CLI/build/标准 PATH/PTY/真实 runner/人工验收之间的 DoD 边界。

### 1.2 本文不负责

- 不重写各 Runtime、TUI、Security、Storage 专项的业务验收标准；
- 不把 RunLedger 改造成 monorepo，也不复制 oh-my-pi 的包结构；
- 不为了增加数字批量生成低价值断言；
- 不把真实 API key、外网或用户 `~/.runledger` 引入默认测试；
- 不用 retry、扩大 timeout 或无期限 quarantine 掩盖竞态与资源泄漏；
- 不把 native frame 断言称为人工视觉验收，不把 Linux fixture 称为 macOS/Windows 真实 runner 证据。

## 2. 当前基线

### 2.1 测试库存与默认覆盖

2026-09-01 在当前工作树只读收集所得：

| 测试层 | 发现文件 | 当前用例 | 默认入口 | 当前证据 |
|---|---:|---:|---|---|
| Vitest / Node | 453 | 2,793 collected | `vitest run` | 本轮只做 collection，未宣称全量通过 |
| Bun / OpenTUI 默认集合 | 17 | 134 | `npm run test:tui-native` | 134 pass / 0 fail |
| Bun runner 外孤儿文件 | 1 | 1 | 无 | 单独执行 1 pass，但默认漏跑 |
| Rust syntax highlighter | 1 个含测试的 Rust 文件 | 12 个 `#[test]` | `npm run check:syntax-highlighter` | 本轮未执行 Cargo |

因此当前：

- 仓库物理 TS 测试库存为 471 文件、2,928 个已收集用例；
- 默认 `npm test` 只覆盖 470 文件、2,927 个用例；
- `tests/utils/provider-fetch-context.bun.test.ts` 同时被 `vitest.config.ts` 排除，又不属于 `scripts/run-tui-bun-tests.mjs` 仅扫描的 `tests/tui` 顶层目录；
- Rust 测试归属于 `npm run check`，不属于 `npm test`，当前命令命名没有清楚表达这一事实。

这些数字是计划基线，不是永久阈值。实施后的 gate 应验证归属和趋势，不应把固定文件数硬编码成阻止正常新增/删除测试的常量。

### 2.2 当前类型分布

当前 Vitest 的主要领域为 Runtime、TUI、Storage、CLI、Provider、Security、Extension 与 Runtime Contract。显式路径/文件名可识别：

- integration：13 文件、39 用例；另有 Bun passive contract integration 1 文件、13 用例；
- E2E：3 文件、8 用例，与 integration 有重叠；
- contract：Vitest 32 文件、130 用例；加 Bun passive contract 后为 33 文件、143 用例；
- native renderer：17 个默认 Bun 文件、134 用例；
- PTY/真实进程组合：已存在少量自动化测试和独立 `verify:*` runner，但没有统一门禁；
- property/fuzz：未发现专用框架；
- visual：没有截图基线或视觉回归 runner，native layout/color 断言不等于 human visual。

类型标签天然可以重叠。例如一个真实 Git + sandbox 的 contract E2E 同时属于 integration、contract 和 E2E。资源调度必须选择唯一执行 bucket；产品能力标签可以保留多值 metadata，二者不能混用。

### 2.3 当前入口与基础设施缺口

| 现有入口 | 能力 | 缺口 |
|---|---|---|
| `npm test` | Vitest 全量后串行运行 Bun TUI | 无 inventory 前置；无法阻止孤儿；失败只归到大集合 |
| `npm run test:tui-native` | 扫描 `tests/tui` 顶层 `*.bun.test.ts` | 非递归、目录写死、遗漏 `tests/utils` Bun 测试 |
| `npm run check` | 静态边界、TS、Rust syntax tests | check 与 test 职责交叉；耗时与失败归属不可独立观察 |
| `verify:*` | Host、PTY、build replacement、candidate 等生产候选验证 | 不属于统一默认/CI gate，证据格式不一致 |
| `syntax-highlighter-prebuild.yml` | native prebuild、smoke、checksum/signature | 不是全仓 PR test workflow |
| `passWithNoTests: true` | 允许平台条件下文件零收集 | 若没有 inventory/skip 报告，可能把意外零收集误当正常 |

耗时观测：`npm run time:gates`（`scripts/record-gate-timings.ts`）按门禁分别记录 `npm run check`、`npm test` 的墙钟耗时，逐次追加到 `tmp/gate-timings.jsonl`（本地证据，不进版本库），并汇总 last / median / min / max；它只提供 check 与 test 的独立耗时口径，不改变上表的职责归属与失败归属缺口。

## 3. 目标测试拓扑

### 3.1 两套正交分类

每个测试文件必须有且只有一个 **执行 bucket**，同时可以带多个 **能力标签**。

执行 bucket 建议如下：

| Bucket | 典型范围 | 资源策略 | 首期 CI |
|---|---|---|---|
| `fast` | 纯函数、schema、projector、provider catalog、utils、contract pure tests | Vitest，可文件并行，无外部进程 | Linux；后续 OS matrix |
| `singleton` | settings/env/fake timers/global registry/module cache | Vitest，单 worker、禁止文件并行 | Linux |
| `runtime` | Agent、Session、Host、replay、extension lifecycle | Vitest，小分块、受控并行 | Linux |
| `security-storage` | SQLite、lock、filesystem、gateway、sandbox policy | Vitest，隔离 temp root，低并发 | Linux；平台分支进 matrix |
| `integration` | 真实 Git、socket、HTTP fixture、进程、E2E | Vitest，低并发、独立 watchdog | Linux |
| `tui-native` | `*.bun.test.ts`、OpenTUI `createTestRenderer()` | Bun Test，独立进程、小分块 | Linux + Bun |
| `rust-native` | syntax-highlighter Cargo tests | Cargo test | native target matrix |
| `smoke` | 构建产物、标准 CLI、PTY/candidate | 构建后串行，隔离 home/workspace | Linux；按能力扩平台 |

能力标签包括但不限于 `unit`、`component`、`contract`、`integration`、`e2e`、`pty`、`native`、`platform-linux`、`platform-macos`、`platform-windows`、`visual-programmatic`、`live-external`。标签用于报告、影响分析和验收，不决定唯一 runner 所有权。

### 3.2 Canonical inventory

新增 `scripts/test-inventory.ts` 作为唯一测试库存解析器，至少输出：

- repo-relative path；
- runner：`vitest | bun | cargo | verification`；
- execution bucket；
- capability labels；
- 平台约束；
- 是否进入默认 local、PR CI、nightly/live；
- 归属规则来源和冲突诊断。

建议由路径规则 + 小型显式 override 表组成，而不是扫描源码关键词决定资源属性。源码关键词会随 import、注释和 helper 改动漂移，不能成为稳定 authority。

必须满足：

1. 每个受支持测试文件恰好匹配一个 runner；
2. 每个默认测试文件恰好匹配一个 execution bucket；
3. 未归属、重复归属、未知平台、空 glob、默认入口遗漏均 fail closed；
4. fixtures、worker helper、generated data 和 snapshot 必须由显式规则排除，不能仅靠“名称看起来不像测试”；
5. `--check` 只验证，不写仓库；`--format json` 输出稳定、机器可读的报告；
6. inventory 单测使用临时 fixture tree，不读取或修改真实用户目录。

### 3.3 Canonical runner

新增 `scripts/run-test-buckets.ts`，职责只限于：

- 消费 inventory 生成明确 argv，不把 shell glob 交给不同平台展开；
- 支持 `--bucket`、`--changed-since`、`--dry-run`、`--list-files`；
- 对高内存/全局状态 bucket 分块并设置明确并发预算；
- 清洗 provider credential、cloud config 与真实 `RUNLEDGER_DIR`；
- 为每个 child 设置 watchdog，并区分 assertion failure、timeout、runtime crash、SIGKILL/OOM；
- 任一 chunk 失败时保留原始输出和确切 argv；
- 不自动 retry assertion failure。若底层 Bun/Node 自身 crash 需要临时 retry，必须单独计数并使 gate 可见。

建议 package scripts：

```jsonc
{
  "test": "npm run test:local",
  "test:inventory": "tsx scripts/test-inventory.ts --check",
  "test:local": "tsx scripts/run-test-buckets.ts --mode local",
  "test:fast": "tsx scripts/run-test-buckets.ts --bucket fast",
  "test:singleton": "tsx scripts/run-test-buckets.ts --bucket singleton",
  "test:runtime": "tsx scripts/run-test-buckets.ts --bucket runtime",
  "test:security-storage": "tsx scripts/run-test-buckets.ts --bucket security-storage",
  "test:integration": "tsx scripts/run-test-buckets.ts --bucket integration",
  "test:tui-native": "tsx scripts/run-test-buckets.ts --bucket tui-native",
  "test:rust-native": "cargo test --locked --manifest-path native/syntax-highlighter/Cargo.toml",
  "test:smoke": "tsx scripts/run-smoke-tests.ts"
}
```

具体脚本名可在 P1/P2 的 RED 测试中微调，但最终只能保留一个 canonical inventory 和一个 bucket 编排入口；不得长期并存两套互不一致的 test file list。

## 4. 分阶段实施

阶段顺序为 `P0 → P1 → P2 → P3 → P4 → P5 → P6 → P7`，不得跳过前置阶段直接扩张 CI 或视觉范围。

### P0：冻结基线和证据语义

目标：把当前事实固定成 characterization evidence，但不把快照数字当永久阈值。

实施：

- 新增 inventory 的 fixture 与 RED 测试，证明当前孤儿 Bun 文件会触发 `unowned_test_file`；
- 记录 Vitest files/cases/skip、Bun files/cases、Rust tests 的独立字段；
- 规定 `collected`、`passed`、`skipped`、`not_run`、`blocked`，禁止用一个“tests”字段混合；
- 规定证据必须带 commit、dirty paths/digest、cwd、Node/Bun/Cargo 版本、命令 argv、开始/结束时间、exit code；
- 把本计划状态保持为 `planned`，P0 RED 证据落地后才改为 `in_progress`。

RED：

- fixture 中存在未归属 `.bun.test.ts` 时 inventory 必须失败；
- 同一文件同时归属 Vitest/Bun 时必须失败；
- glob 为空时必须失败；
- `passWithNoTests` 文件必须在报告中显示 collected=0，而不是静默消失。

DoD：focused inventory tests 先 RED 后 GREEN；当前仓库运行 inventory 时应准确报告 1 个 orphan，而不是为了让 gate 绿先忽略它。

建议提交：`test(inventory): expose runner ownership gaps`

### P1：关闭默认 runner 漏测

目标：所有 `tests/**/*.bun.test.ts` 都由 Bun runner 精确拥有，默认测试零孤儿。

实施：

- 将 Bun 文件发现从 `tests/tui` 顶层 `readdirSync` 改为跨平台递归发现；
- 或在审阅语义后将 provider fetch context Bun 测试移动到权威目录；二者只能选择能表达真实所有权的一种；
- 用 runner 单测固定排序、空集合、嵌套目录、路径空格和 Windows separator；
- 保留 `spawn` 的 argv 数组和 `shell:false`，不依赖 shell glob；
- inventory 在修复后必须报告 orphan=0、overlap=0。

GREEN 门禁：

```bash
npm run test:inventory
npm run test:tui-native
npm test
git diff --check
```

验收不硬编码“仍是 2,928”，因为新增 runner 单测会增加用例；验收硬条件是物理测试文件与 runner file set 完全相等。

停止规则：若递归发现会误收 fixture/worker，先完善显式排除和 fixture 测试，不用后缀改名掩盖归属问题。

建议提交：`test(runner): make Bun discovery complete`

### P2：建立显式资源分桶

目标：让失败归属到稳定 bucket，并降低全局状态、真实 I/O 和 native heap 的相互干扰。

实施：

- 实现 `fast/singleton/runtime/security-storage/integration/tui-native/rust-native`；
- 先按目录建立稳定规则，再用显式 overrides 处理少量例外；
- `singleton` 强制单 worker；integration/native 使用小 chunk 和低并发；
- runner `--dry-run` 输出每个 bucket 的文件数、chunk 数、argv 和并发预算；
- 增加 partition 完备性测试：union 等于默认 inventory，intersection 为空；
- 对当前并行敏感的 acceptance tests 建立独立 bucket，不用 `--no-file-parallelism` 临时散落在人工命令里；
- 保持 focused file invocation 能力，便于 TDD RED→GREEN。

DoD：

- 每个 bucket 可独立运行；
- 全 bucket union 与默认 `npm test` 行为等价；
- 同一 commit 连续两次 Stable GREEN；
- 无新增 retry、skip 或扩大 timeout；
- 失败日志能定位到 bucket/chunk/file。

建议提交：`test(runner): isolate resource-sensitive suites`

### P3：建立全仓 PR CI 门禁

目标：让 check、测试、build 和 smoke 具有明确 job ownership，并提供单一 required gate。

新增 `.github/workflows/test.yml`，首期 jobs：

1. `inventory-and-check`：`npm ci`、版本核对、inventory、`npm run check`；
2. `test-fast`；
3. `test-singleton`；
4. `test-runtime`；
5. `test-security-storage`；
6. `test-integration-linux`；
7. `test-tui-native-linux`；
8. `build-and-cli-smoke`；
9. `test-gate`：`if: always()` 汇总所有 required jobs，任一 skipped/cancelled/failure 均不伪装成功。

CI 规则：

- Node 与 Bun 版本从 `package.json`/lockfile 的权威范围安装，不使用 runner 偶然预装版本；
- 默认清洗所有 provider key、OAuth token、cloud credential 和用户级 config；
- 所有 home、workspace、socket、DB、tmux/session 名使用 job-scoped temp root；
- 上传失败 chunk 日志和 evidence JSON；成功路径只保留简洁汇总；
- concurrency cancel 只取消同 PR 的旧 commit，不取消主分支或 release gate；
- required gate 不依赖真实外网、API key 或人工输入。

DoD：PR 与 push 触发均通过；故意破坏任一 bucket 时 `test-gate` 稳定失败；workflow 权限最小化。

建议提交：`ci(test): make repository gates attributable`

### P4：构建产物、标准 CLI 与 PTY smoke

目标：验证用户实际执行的 `bin/runledger.js → dist/cli/cli.js`，而不是只验证源码 import。

实施：

- build job 后验证 `runledger --version`、`--help` 和无参数 TUI 启动/干净退出；
- 使用绝对候选 bin 或临时 npm link，记录 `command -v`、`readlink -f`、build manifest 和 live PID/cwd；
- 标准 smoke 始终使用隔离 `RUNLEDGER_DIR`，不得读取真实 auth/session/settings；
- 把 `verify:managed-process-pty`、`verify:host-build-replacement`、`verify:session-owner-candidate` 的适用范围和前置 build 收敛到 manifest；
- 每个 runner 负责 kill child/Host、关闭 socket/renderer、清理 tmux 与 temp root；cleanup 失败本身使 gate 失败；
- 自动 PTY 只证明按键、frame、生命周期和退出，不标记 human visual。

DoD：候选 executable provenance 可复核；无 orphan process/socket；同一 smoke 在干净临时环境可重放。

建议提交：`test(smoke): verify the built production entrypoint`

### P5：确定性、flake 与资源治理

目标：减少真实 sleep、全局状态泄漏、非确定调度和高内存 chunk。

实施顺序：

1. 统计每个 bucket/file 的 duration、timeout、RSS 峰值和 crash 类型；
2. 对 deadline/backoff/debounce 使用 `async-state-machine.md` 的 fake clock + explicit gate；
3. 对 SQLite、lock、mtime、Git、process、PTY 保留少量真实集成测试；
4. 所有 env/module singleton 测试迁入 singleton bucket并显式 cleanup；
5. 对偶发失败先独立复现三次，定位共享资源或时序，不直接 retry；
6. quarantine 只允许带 issue、owner、原因、进入日期、到期日期和替代覆盖；到期未修使 gate 失败。

#### P5.1 duration 观测入口与首个分桶基线（2026-09-16）

P5 第 1 项的 duration 部分已有可重复入口：`npm run time:gates`（`scripts/record-gate-timings.ts`）按 gate 分别运行门禁、记录墙钟耗时，逐行追加 `tmp/gate-timings.jsonl`（本地证据，不进版本库），并汇总 last/median/min/max；每条记录带 commit、分支、dirty 与 node/npm/bun 版本、CPU 数与 load average。timeout、RSS 峰值与 crash 类型采集仍未实现。

首个样本：`rollback/before-composer-shape@d91367a`，工作树 dirty，记录时 load average 13.08，`npm run check` 74.4s、`npm test` 775.6s，均 `exit 0`。该机器 64 逻辑核但同时在跑仓库外高负载任务，同一命令冷热差 2.3s → 7.9s，因此下列数字是单机单次分解，只用于定位相对占比，不构成阈值或跨机器期望。

`npm test` 的墙钟分解（`scripts/run-test-buckets.ts --dry-run` 的计划与运行日志逐 chunk 汇总）：

| bucket | 并发 | chunks | files | chunk wall 合计 | collect（worker 和） | tests（worker 和） | 非测试占比 |
|---|---:|---:|---:|---:|---:|---:|---:|
| fast | 4 | 3 | 238 | 131.1s | 92.8s | 286.3s | 45% |
| singleton | 1 | 9 | 9 | 23.0s | 12.5s | 4.9s | 79% |
| runtime | 2 | 13 | 147 | 294.0s | 141.9s | 267.6s | 54% |
| security-storage | 1 | 13 | 103 | 140.9s | 55.0s | 26.5s | 81% |
| integration | 1 | 7 | 27 | 118.0s | 46.1s | 55.9s | 53% |
| tui-native（bun） | 1 | 4 | 24 | 8.9s | 无该口径 | 8.9s | ~0% |

合计：chunk wall 715.9s，门禁 wall 775.6s，chunk 之外 59.7s（npm 启动、inventory 与 49 次 node/vitest 冷启）；vitest 自报口径的 worker 和为 transform 103.5s、collect 348.3s、tests 641.1s、prepare 46.0s，并行度使其和大于 wall。

四条已实测原因：

1. **chunk 固定税**：`run-test-buckets.ts` 用单个 `spawnSync` 循环串行跑全部 49 个 chunk，bucket 之间与 chunk 之间都不并行。1 文件 chunk 实测 wall 2.05–2.59s，同次 vitest 自报 Duration 0.90–1.02s，差额约 1.2–1.6s/chunk，×49 ≈ 60–78s（同文件同参数实测，折算为估算）。security-storage 的 13 个 chunk 为 26.5s 测试付 55.0s collect；singleton 的 9 个 chunk 为 4.9s 测试付 12.5s collect。
2. **并发预算低于机器容量**：fast/runtime 并发固定为 4/2。fast 首个 chunk 80 文件、成员耗时和 254.0s，并发 4 的理论下限 63.5s，实测 86.7s；runtime 以 2 worker 承担 267.6s 的 worker 量。这是配置预算问题，不是核数不足。
3. **长尾 chunk**：runtime chunk #19 wall 128.3s，其中 `tests/runtime/session-runtime/compaction-domain.test.ts` 占 111.1s / 33 用例（20 次 `fixture()`、无 `beforeEach`，每用例重建本地 HTTP server、SQLite 与 Session Owner）；fast chunk #0 wall 86.7s、成员和 254.0s，集中了 session-owner-production 53.4s、control-command-execution 46.7s、session-owner-cli 43.4s、main.test 31.8s、acceptance-runners 30.9s，按字母分片把 CLI E2E 集群排进同一队列；integration chunk #38 wall 46.1s，其中 acceptance-runners 单个用例 18.8s。
4. **CLI E2E 每用例冷启进程**：29 个测试文件通过 `spawnSync(process.execPath, ["--import", "tsx", "src/cli/cli.ts", ...])` 启动 CLI。实测 `node -e ""` 0.36s、该 tsx 路径 2.30s（冷启动 4.99–7.88s）、`./bin/runledger.js --version`（bun + dist）1.50s；`tests/cli/main.test.ts` 22 个用例均值约 2.4s，内容多为 `--help` 字符串断言。

证据口径也需区分：本地 `npm test` 把 `.github/workflows/test.yml` 中各自 `runs-on: ubuntu-24.04` 的 7 个 job 串到一台机器上执行，本地墙钟不能与 CI 单个 job 耗时直接比较。

压缩耗时必须走第 5 节的 TDD 协议并单点验证（例如只调整 fast/runtime 并发或 chunk 划分后 `npm run time:gates` 复测），不得引入 retry、扩大 timeout、跳过文件或新增 skip；P2 DoD 要求的失败定位粒度（bucket/chunk/file）优先于减少 chunk 数量。

质量指标：

- flaky retry rate = 0 为目标；
- orphan/overlap = 0；
- 默认 eligible file coverage = 100%；
- cleanup leak = 0；
- Verified Progress / Plan Step 与 TDD Red→Green / Stable Green 作为实施效率指标；
- 不以测试数量增长率、单次最快耗时或“任务成功”作为核心质量指标。

建议按领域拆小提交，不使用一个全仓“修 flake”提交吸收无关变化。

### P6：真实跨平台 runner

目标：将平台 fixture/compile-time branch 与真实 OS 证据分开。

顺序：

1. Linux 先闭合默认 required gate；
2. macOS 加入 path/Git/process/storage/CLI 和支持范围内的 TUI tests；
3. Windows 加入 path separator、cmd/PowerShell/Git Bash、spawn argv、file lock、cleanup 和 CLI tests；
4. native syntax-highlighter 继续使用既有 target matrix，但测试 workflow 消费真实构建 artifact；
5. 暂不支持的 Host/PTY/sandbox 行为必须返回 typed unsupported/unverified，不能用 mock fixture 标为平台通过。

DoD：每个平台报告实际运行、显式 skip 及原因；required matrix 中意外零收集或整 job skip 失败。

### P7：人工视觉与 live external 验收

目标：补齐无法由默认自动化替代的证据，同时保持默认 gate hermetic。

人工 TUI matrix 至少覆盖：

- dark/light；
- 60/80/143 列；
- 真实鼠标 selection/scroll/overlay；
- 真实 IME/CJK 输入；
- Ctrl+C/Ctrl+D/Esc 的清理与退出；
- 至少两个终端环境；
- 人工填写操作者、时间、commit、候选 bin、结果与 artifact。

Live provider/网络验收：

- 仅 workflow dispatch 或受控环境运行；
- 使用最小权限 secret，不打印 request/header/token；
- 与默认 PR gate 分离；
- 失败不得被本地 mock 测试“抵消”；
- 结果记录 provider/model/transport 与脱敏 Trace digest，不保存敏感正文。

完成后也只能分别声明 `human-verified` 或 `live-external-verified`，不能反向覆盖尚未通过的自动化或平台 gate。

## 5. TDD 执行协议

每一阶段都遵守：

1. 写一个能精确暴露当前缺口的 focused RED；
2. 运行并保存失败类型，确认不是缺依赖、错误 cwd、旧 dist 或错误全局链接；
3. 实施最小修复；
4. focused GREEN；
5. 对相关 bucket 连续两次 Stable GREEN；
6. `npm run check`、默认测试、build/CLI gate 按改动风险逐级扩大；
7. `git diff --check`；
8. 回写本计划状态和 fresh evidence，但不覆盖历史基线。

如果 RED 在未实施时已经通过，先检查测试是否真正走生产路径、是否命中了目标文件、是否因 skip/passWithNoTests 失效；不能继续写实现来“配合”一个无效 RED。

## 6. Evidence manifest

CI 和 production candidate runner 应输出版本化、可脱敏的 JSON artifact，最少包含：

```text
schemaId
commit
dirtyDigest / dirtyPaths
cwdDigest
runnerVersions { node, bun, npm, rustc, cargo }
bucket
commandArgv
startedAt / finishedAt / durationMs
files { discovered, selected, collected }
tests { collected, passed, failed, skipped, todo }
process { exitCode, signal, timeoutKind }
platform { os, arch, libc, runnerImage }
artifacts { buildManifestDigest, logDigest }
cleanup { childProcesses, sockets, tempRoots, status }
```

manifest 不保存 home 绝对路径、用户名、token、header、prompt 正文或 session 内容。Schema 采用仓库允许的稳定标识方式，不引入违反 current-format boundary 的数字 schema 字段命名。

## 7. 验收矩阵

| 证据 | Agent 可自动执行 | 需要真实 runner | 需要人工 | 完成条件 |
|---|---|---|---|---|
| inventory 完备性 | 是 | 否 | 否 | orphan/overlap/empty glob 为 0 |
| unit/component/contract | 是 | CI Node/Bun | 否 | focused + bucket + full green |
| Runtime/Session/Security | 是 | Linux CI | 否 | 资源隔离、fault/cleanup green |
| native OpenTUI | 是 | Bun + OS | 否 | real renderer frame/input + destroy |
| CLI build smoke | 是 | 候选 artifact | 否 | provenance + startup + clean exit |
| PTY/process | 是 | 真实 Linux runner | 部分 | production entry + no leak；视觉另验 |
| macOS/Windows | 部分 | 对应 OS | 部分 | real runner，不以 fixture 代替 |
| dark/light/IME/mouse | 否 | 真实 terminal | 是 | 人工矩阵签字 |
| live provider | 可编排 | 受控网络/secret | 可选 | 脱敏 Trace + terminal outcome |

## 8. 全局停止规则

- 实施前重新检查 branch、HEAD、linked worktrees 和 dirty paths；若主工作树存在其他任务改动，使用独立 sibling worktree，或只修改完全不重叠的测试基础设施路径。
- 新 worktree 没有 `node_modules` 时先 `npm ci`，不得让 `npx` 隐式联网安装未知版本。
- inventory 未闭合前，不新增“全仓 CI 已覆盖”的宣称。
- 任一 bucket 只能通过扩大 timeout、启用 retry 或新增 skip 变绿时，停止并定位根因。
- 测试需要真实用户 home、真实凭据或不可清理的常驻进程时，停止并重建隔离边界。
- 自动化不能证明 human visual、IME、鼠标手感、跨平台支持或 live provider；这些状态必须保持 pending。
- 实施不得吸收届时存在的任何用户改动，也不得使用 `git stash`、`git reset --hard` 或宽泛暂存。

## 9. 建议提交边界

1. `test(inventory): expose runner ownership gaps`
2. `test(runner): make Bun discovery complete`
3. `test(runner): isolate resource-sensitive suites`
4. `ci(test): make repository gates attributable`
5. `test(smoke): verify the built production entrypoint`
6. 后续按 determinism、platform、human/live evidence 分领域提交。

文档导航修改可单独提交，不与任何 runner 实现混在一起。用户未明确要求前不提交、不推送。

## 10. 计划完成定义

只有同时满足下列条件，本文状态才能从 `planned/in_progress` 改为 `implemented`：

- inventory 对所有测试文件归属 fail closed，orphan/overlap 为 0；
- 默认 local 与 required PR CI 覆盖 100% eligible tests；
- execution buckets 可独立运行且 union 等价于默认集合；
- check、test、build、CLI smoke 的 required gate 可归责、可重放；
- production CLI/PTY evidence 绑定候选 artifact 并完成 cleanup；
- Linux required gate 稳定，macOS/Windows 的支持与未支持项有真实 runner 证据；
- flake/retry/quarantine 符合 P5 规则；
- 自动、真实 runner、人工视觉和 live external 状态分别记录；
- fresh evidence 使用当前 commit/工作树重新执行，不复用本文 2026-09-01 基线数字。

若 P7 的人工/live 项仍 pending，可以把 P0–P6 分别标记 implemented，但整体只能标记 `partial`，不得用自动化结果代替最终验收。
