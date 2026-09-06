# 本地轨迹实施与验证记录

日期：2026-09-06。实现基线：`8c1989c`；工作分支 `feat/trajectory-runtime`，独立工作树 `RunLedger-trajectory`。主工作树的既有修改、暂存区和全局 CLI 链接未被替换。

## 实现范围

- 用户级 recording 缺省 events + best_effort；部分配置逐字段补缺省，显式 off 保留，非法配置关闭并诊断；不回写真实用户 settings。
- Session Owner 持有轨迹 cache；page/detail/search/status 经过已有 domain envelope、认证 transport 和 generation 检查。TUI 仅消费有界 DTO。
- Session Event、Trace 与 Attempt receipt 各自保留进度；cache 可重建，不迁移 Session schema。运行中公开文本更新同一个模型节点，private reasoning 不参与新增摘要检索。
- `/trajectory`、`/trajectory close`、`/trajectory status`；Duration/Turns/Calls、时间范围、全历史安全摘要搜索、分页、详情、Follow、显示偏好和窄屏布局。
- Trace 写队列 256、单事件输入 64 KiB、单 Trace 100,000 条/128 MiB、单次写入 deadline 5 秒；逐条 flush，发生 I/O 故障后停写该实例。关闭记录不删除历史，也不关闭必要的 Session 持久化。

## 自动化证据

运行期间完整保留各命令日志。首次独立工作树缺少 node-pty 原生模块，执行 `npm rebuild node-pty` 后重跑；这些首次启动失败不计作行为验证。

| 验证 | 结果与边界 |
|---|---|
| `npm run check` | 最终命令退出码 0；包含所有仓库边界、consumer typecheck 与 TypeScript |
| 受影响测试 | 覆盖配置、旧历史/off、hash/cursor/session/generation、UTF-8 正文分页、超大正文、cache 损坏、流式公开文本、Attempt 终态、队列/尾部/I/O 故障、面板和生产 Trace factory 接线 |
| 完整 `npm test` | 已执行；原样基线在 `tests/tui/adapters/adapters.test.ts` 的两个 Plan Mode 断言失败：期望 unknown，现有实现返回 inactive。本任务未修改该文件或相应 adapter；主工作树已存在独立修正，不纳入本提交 |
| 补充 fast | 明确排除上述整份既有文件后，其余 fast 测试 1537 项通过；不将补充运行写成原始 `npm test` 全绿 |
| singleton / runtime / security-storage | 分别 77 / 707 / 596 项通过；后续本任务相关修改另做定向复验 |
| integration | 144 项通过。曾有一次同版本 build replacement 验证与构建重写重叠而失败；构建停止后完整重跑通过 |
| tui-native | Bun 测试桶 144 项通过；仅代表 Linux/Bun 自动化 |
| `npm run build` | 最终命令退出码 0；原生模块、TypeScript、TUI assets 与 build manifest。最终 TTY 在构建完成后运行 |

## 构建后的 CLI / TTY

入口已核对：PATH `runledger` 仍链接主工作树；本次使用独立工作树的 `bin/runledger.js`，由 Bun 加载该工作树 `dist/cli/cli.js`。临时目录使用绝对 `RUNLEDGER_DIR`，只含本任务合成数据和假凭据。

本机 loopback OpenAI-compatible fixture 通过 canonical models 配置、显式 fixture compatibility manifest、正常登录和模型选择进入生产路径；未添加生产 mock fallback，工具执行继续经过治理。

已观察两次模型请求及一次 Bash `printf trajectory-fixture`；面板显示 Run/Step/Model/Call/Attempt。默认 events 生成 Trace 日志，没有 artifacts。Duration、Turns、Calls、搜索 bash、Output 详情和 Follow 控件已在真实 TTY 操作。保留 [tmux 文本捕获](evidence/2026-09-06-tty.txt)，不能替代人工视觉/IME 验收。

显式 off 后重启并读取旧 session，80×24 面板显示 `off / ready`，旧事件可查。另新建 off Session 完成两步模型/Bash 执行，既有 2 个 Trace 文件及总计 15,841 bytes 完全不变，新 Session 仍有持久执行事实；Esc 逐级返回后 Ctrl+D 退出码 0。运行中还发现并修复 Bun 对缺失 opendir 目录延迟抛错导致的空会话误报 degraded。一次 TUI 与原生构建重写重叠时退出码 132，不计作退出验收；随后稳定构建上的退出码 0 单列为通过。

## 10 万事件测量

可复现入口：`node --experimental-strip-types scripts/benchmark-trajectory.ts`。脚本新建隔离 home，实际通过 JsonlTraceEventStore 写入 100,000 条有 hash chain 的合成事件，再建立 owner cache，交替测量尾页和摘要检索 100 次，最后关闭并删除自己的临时目录。

初始基线：写入 228.66 秒、首次重建 79.24 秒、查询 p95 25.91 ms、最大响应 61,713 bytes、事件日志 51,744,368 bytes、cache 主文件 60,796,928 bytes、峰值 RSS 190,971,904 bytes。

复验（完整历史 hash 前缀校验）：写入 218.09 秒、首次重建 83.97 秒、查询 p95 22.66 ms、最大响应 61,733 bytes、峰值 RSS 186,085,376 bytes。cache 数字为 SQLite 主文件，不含临时 WAL/SHM；不把它冒充整个 home 的总磁盘占用。

[最终测量原始结果](evidence/2026-09-06-benchmark.json)：写入 221.38 秒、重建 81.49 秒、查询 p95 3.16 ms、最大响应 61,743 bytes、事件日志 51,744,368 bytes、cache 主文件 62,267,392 bytes、峰值 RSS 189,939,712 bytes。kind/run 索引避免每次状态查询扫描全部记录。

冻结本机场景回归预算：查询 p95 ≤100 ms，峰值 RSS ≤256 MiB，单页响应 <256 KiB，100,000 条合成事件日志 <64 MiB。batch=1 的写入吞吐和首次重建较慢，界面显示 rebuilding 并后台推进；这些数值不是跨硬件 SLA。TUI 内存窗口上限 400，详情按 48 KiB 单块加载，不随总历史累计正文。

## 保留的验收边界

- 真实外部 provider 多 step/call 未执行；本机模拟 provider 不计作该项通过。
- 人工视觉、鼠标拖动、中文 IME、macOS/Windows runner pending。
- 完整 `npm test` 的既有 Plan Mode 断言仍由原专项修正，不能宣称当前提交独立全绿。
- 旧/现有 Attempt receipt 缺少可证明的 Call 关联时，明确显示 association unavailable；不补造关联或回填历史。
- Session 索引批次按 4 MiB 正文预算读取；单事件超过 8 MiB 时停止该 Session 前缀重放并显式 degraded，不跳过未验证正文宣称 hash 链完整。Trace 仍可提供独立观测事实。
- 超过安全预览限制的已保存正文显示 unavailable，不宣称可无限读取；digest-only 内容不能全文搜索。
- 开发索引中指向 `tests/manual/development-cases/README.md` 的既有链接在独立基线缺少目标；主工作树中该目录属于其他未提交工作，本任务不复制或提交。
- 没有实现 Opik/OTLP、Sandbox 专项或产品内并行/可写 child。
