# 上游对照（parity）

本目录保存 RunLedger 与上游 oh-my-pi 的**模块级对照事实**：以某个上游快照为口径，列出 RunLedger 已具备、部分具备与完全缺失的模块，并给出可复核的上游代码位置。

这里的文档是**现状记录与设计输入**，不是实施计划，也不改变任何模块的 authority、阶段状态或验收门禁。任何要落地的缺口都必须回到对应领域专题立项。

## 文件

| 文件 | 内容 |
|---|---|
| [00-oh-my-pi-coding-agent-module-gap-report.md](00-oh-my-pi-coding-agent-module-gap-report.md) | **第 1 轮**。以 `oh-my-pi/packages/coding-agent/src` 单包为口径的模块对照与缺口报告。含：方法与证据规则、规模总览、33 项完全缺失、39 项部分缺失、对等项、明确不移植项、复现命令、建议优先级、证据限制。每项列出上游代码位置。 |
| [01-oh-my-pi-monorepo-package-and-crate-gap-report.md](01-oh-my-pi-monorepo-package-and-crate-gap-report.md) | **第 2 轮**。以 monorepo 其余部分为口径：`packages/*` 中除 `coding-agent` 外的 15 个包、`crates/*` 的 10 个 Rust crate、`python/`、`nix/`、`bazel/`、`infra/`、`types/`。新增 `rl_mode`（`ported` / `third-party` / `absent`）维度以区分「换实现」与「真缺失」，含依赖级能力清单对照与两轮合并视角。 |
| [02-oh-my-pi-tool-registration-and-presentation.md](02-oh-my-pi-tool-registration-and-presentation.md) | **机制说明**（非缺口报告）。上游 100+ 工具如何注册、发现，并在不炸 context 的前提下呈现：发现层（14 kind capability registry、87 个 provider 注册点、优先级去重、FS 缓存语义）、注册层（`createTools` 唯一调用点、逐工具门表、冻结语义与变更触发器）、呈现层（`loadMode`、`xd://` 设备挂载、Code Mode、inline descriptors）。含动态来源清单、命名冲突与准入四层、三个反直觉点（BM25 已移除但注释未更新、hook 拦截未接线、capability `tool` kind 与运行时 registry 是两轴）、与 RunLedger 的机制对照。 |

## 使用约定

- **00/01 是缺口报告，02 是机制说明。** 00/01 回答「RunLedger 缺什么」，02 回答「上游是怎么拼起来的」；不要从 02 引用缺口状态。
- **两轮口径互不重叠，按需取用。** 00 管 `coding-agent/src` 的模块面；01 管包边界、原生层与非 TS 树。01 §7 给出合并视角，并修正了 00 中三处口径性判断（compaction 归属兄弟包、`src/sandbox/*` 上游不存在、RunLedger `src/web/*` 的真实上游对等物）。
- **口径必须随文档声明。** 对照结论只对文首注明的上游 commit 与目标工作树成立；上游或目标前进后，请按各文档的复现命令重新生成事实，不要在旧结论上增量推测。
- **缺口关闭后不回改结论，而是行内标注。** 目标快照前进使某项缺口落地时，在原文该行加 `🔵 已关闭（日期，commit）` 标记 + 落地文档链接，并在文首「快照推进」补记说明；**编号保持稳定**（外部文档按 `§3 #N` 引用，如 [`plan/18`](../plan/18-omp-web-capability-port-plan.md) 引 `§3 #6`/`#7`），已关闭项不删除、不重编号。已关闭项：00 §3 #6（`web/`）、§3 #7（`exa/`）、00 §8 P1 `web/`、01 §3 #14 的 `dom`/`turndown` 两族（部分）。
- **区分「缺失」与「决定不移植」。** 后者已有决策文档（`packages/collab-web/README.md`、`development-doc/compact/README.md`、`development-doc/bench/00-*.md`、根 `AGENTS.md`），不能按缺口重新立项；两份报告均分列不同章节。
- **01 的 `third-party` 不是缺口。** 它表示 RunLedger 用等价依赖或平台能力替代上游实现；但语义等价性需逐项评估，报告只对 `omptype`↔`typebox` 给出了结论。
- **不从本目录引用完成状态。** `full`/`partial` 是静态源码对照结论，不代表运行时验收、真实 provider、TTY 或跨平台证据。

## 与其他专题的边界

| 专题 | 关系 |
|---|---|
| [Plan 16 omp 工具对齐](../plan/16-omp-tool-parity-update-plan.md) | 工具面缺口的**执行账本**归该专题；本报告只做事实登记，不与其争状态来源。冲突时以该专题为准。 |
| [Plan 17 loop/goal 适配](../plan/17-omp-loop-goal-mode-adaptation-plan.md) | goal/loop 行为交付状态归该专题 §14；本报告只记「两侧均已实现、验收未闭合」。 |
| [Compact 专项](../compact/README.md) | 压缩服务的上游事实与决策矩阵归该目录；本报告不重复其结论。 |
| [Providers 专项](../providers/02-oh-my-pi-provider-port-execution-checklist.md) | provider/catalog 增量移植状态归该专题。 |
| [Plugin / MCP / Skill / Hooks](../plugin-mcp-skill-hooks/01-implementation-plan.md) | 扩展面的目标架构与 `不复刻` 清单归该专题；本报告的 `extensibility/`、`discovery/`、`capability/` 缺口行与之对齐。 |
| [Bench 中台](../bench/00-oh-my-pi-metaharness-reference.md) | 其参考对象 `packages/metaharness` 与 `coding-agent/src/if-bench/` 是**两个不同能力**（任务级评测中台 vs 模型级指令遵循基准），分别见 01 §3 #6 与 00 §3 #12，勿混。00 的采纳/拒绝结论已在该专题冻结，01 只做登记。 |
