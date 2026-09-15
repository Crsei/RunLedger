# 评测中台（bench）

本目录保存 RunLedger 的 agent 任务级评测中台设计：任务包、驱动层、采集与评分、结果账本、报表与看板边界。这里是本专题的导航入口，不用历史 case 的人工评分替代当前 runner 与新鲜证据。

## 阅读顺序

1. [`01-bench-platform-implementation-plan.md`](01-bench-platform-implementation-plan.md)：当前权威实施计划。含现状缺口、三个结构性冲突（无 headless 入口 / 无人值守与 fail-closed 治理 / 无 run 级存储单元）、目标架构、P0–P7 阶段与验收。
2. [`02-task-pack-and-scoring-contract.md`](02-task-pack-and-scoring-contract.md)：冻结合同。任务包结构、验收协议、指标定义、bench ledger schema、trial 终态闭集、审批记录契约、可比性与 resume 规则。
3. [`00-oh-my-pi-metaharness-reference.md`](00-oh-my-pi-metaharness-reference.md)：参考输入。oh-my-pi `packages/metaharness` 的机制事实、采纳清单与明确不采纳清单。

## 文档职责

- 阶段顺序、状态、门禁与停止规则只在 `01` 维护。
- 数据与判定契约（schema、指标口径、终态枚举、可比性）只在 `02` 维护；实现方不得就地扩展字段。
- `00` 只作设计输入，不承担 RunLedger 的完成状态。
- 当前 run 数、trial 数、通过率与耗时必须由当前 checkout 的 runner 或 ledger 查询重新生成，不引用历史数字。

## 与其他专题的边界

| 专题 | 关系 |
|---|---|
| [测试策略与 Runner](../test/01-test-strategy-and-runner-hardening-plan.md) | 正交。测试回答「这次变更该跑哪些测试」；本专题回答「harness 在任务样本上表现如何」。两者不共享 runner，也不互相替代。 |
| [Runtime 06 Session Owner](../runtime/06-session-owner-runtime-replacement-plan.md) | 评测驱动必须走 Session Owner Runtime。若需 headless 入口（01 §5 P1b），其产品 authority 归该专题，本专题只提需求与被测面变化分析。 |
| [Trajectory](../trajectory/01-runtime-trajectory-implementation-plan.md) | 提供 Run/Step/Call 只读投影，是本中台 trace 层的主要来源；其缺口（无导出、正文默认 digest-only）由本专题自行补齐。 |
| [Runtime Trace](../runtime/trace/README.md) | `<home>/events/**.jsonl` 是 trace 正文来源；Phase 04（Opik）与本专题无关。 |
| [Worktree / Sandbox / Permission](../worktree-sandbox-permisson/07-three-permission-presets-and-tui-settings-plan.md) | 权限预设是**被测量**，不由本专题修改；OS sandbox 扩展仍处冻结状态。 |
| `tests/manual/development-cases` | 现有六类开发案例与本专题的输入：任务描述与独立验收器模式被继承，人工四维评分被可重放评分器替换。 |
| `tests/manual/harness-repair` | hermetic 通道的先例：本地 HTTP fixture 经 LiteLLM adapter 返回确定性工具调用。 |

## 冻结的硬边界

1. 不做 OS sandbox / 容器 / microVM 任务隔离；隔离单元是**隔离的 `RUNLEDGER_DIR` + 隔离 workspace 目录**。
2. 不新增常驻服务；评测持久化不得落在任何 `RUNLEDGER_DIR` 内。
3. 不绕过治理：不 AllowAll、不关 ExecutionGateway、不把自动审批实现为「总是允许」。
4. 默认 profile 不是 `danger-full-access`。
5. 真实凭据不进入评测产物；不把真实用户 home 当评测 root。
6. 真实评测 run 不进 `npm test`；只有 scorer / 聚合 / ledger 的纯函数单元测试进默认 gate。
7. 不用 retry / 扩大 timeout / quarantine 掩盖 flake。
8. TTY 驱动与 headless 驱动的数字不混入同一 arm 比较。

## 状态汇总

| 阶段 | 内容 | 状态 |
|---|---|---|
| P0 | 口径冻结与试运行 | `planned` |
| P1a | TTY 驱动（零产品改动） | `planned` |
| P1b | headless 入口需求评估（交 Runtime/TUI authority） | `planned` |
| P2 | 采集层（只读解析 trial home 事实） | `planned` |
| P3 | 任务包与宿主侧独立验收 | `planned` |
| P4 | 账本与实验聚合 | `planned` |
| P5 | hermetic 通道与 CI 非阻塞接线 | `planned` |
| P6 | live 通道（真实 provider，人工触发） | `planned` |
| P7 | 只读看板 | `deferred` |

当前无已完成的评测能力。本表在阶段完成时原地更新，并同时记录 `checkout`、`dist_digest`、`task_sample_digest`、`driver`、profile 组合与 artifact 指针。
