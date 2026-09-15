# Compact 专项入口：接入 oh-my-pi 压缩服务

> 状态：**in_progress**：O0 合同冻结完成，O1–O5 待实施；O6 `deferred`、O7 `blocked`。基线日期 2026-09-15。
> 目标基线：RunLedger `9ab79772e512935da2d98fd2239693ec451b415f`（分支 `rollback/before-composer-shape`）。
> 来源快照：oh-my-pi `3b3a6dc9bbd85102ce19d0b1c11bf6870915f6ec`。

## 本目录管什么

把 oh-my-pi 的压缩机制接入 RunLedger 现有 compact 适配器（`src/runtime/context/compaction/` + `src/runtime/session-runtime/compaction-domain.ts`）的**增量**方案：切点与 token 预算、迭代摘要与格式校验、文件操作清单、投影级剪枝、handoff、provider 原生 V2 与 length-stop 恢复。

不管什么：Model/Plan/Context/Compaction/Memory 的公共契约、authority、生命周期与 C0–C5 阶段状态仍归 [plan-compact-memory/01](../plan-compact-memory/01-implementation-plan.md)（其 §0 规定同主题只能有一个执行账本）；本目录以该账本为准，与之冲突时先改上位文档再改这里。

## 文件

| 文件 | 内容 |
|---|---|
| [00-oh-my-pi-compaction-services.md](00-oh-my-pi-compaction-services.md) | omp 侧事实清单：服务入口/导出/数值、耦合度判定、移植阻断点、与当前适配器的能力对照、术语对齐。含来源行号，可直接复核。 |
| [01-integration-plan.md](01-integration-plan.md) | 接入计划：服务→落点决策矩阵、接口与文件级 delta、阶段 O0–O7（含前置/文件边界/交付物/必须验证）、验证矩阵、风险、拒绝项与重评估触发、索引同步与证据规则。 |

## 决策速览

| 服务 | 决策 |
|---|---|
| 阈值/预算纯函数、token 预算切点、比率校正 | 采用（O1） |
| 摘要格式 seam、迭代 update 契约、文件清单、序列化加固 | 采用（O2） |
| 投影剪枝（superseded read / useless 结果） | 采用（O3） |
| handoff 策略 | 采用（O4） |
| provider 原生 V2、`stopReason === "length"` 有界恢复 | 采用（O5） |
| snapcompact 位图归档 | 延后（O6，条件：原生渲染 + 图像投影通道 + 媒体契约 + vision 计费） |
| shake 重型块替换 | 延后（O7，条件：先有模型可见的恢复通路） |
| 分支摘要、实验性 context 管理、推测压缩、idle、多候选 fallback、原生 tokenizer | 拒绝（理由与重评估条件见 01 §8） |

## 门禁速查

- `src/runtime/context/**` 是契约目录：禁止 `node:fs|child_process|net|http|https`、`node:os`、`storage|tui|providers` 依赖与字面 `fetch(`（`scripts/check-runtime-boundaries.ts` 经 `src/runtime/contracts/inventory.ts` 管辖）。
- `src/runtime/session-runtime/**` 受 `scripts/check-session-owner-boundaries.ts` 管辖。
- 新增测试必须被 `tsconfig.tests.json` 覆盖，否则 `check:consumers` 失败。
- 阶段证据：focused 测试 + `npm run check` + （进 `dist` 时）`npm run build` 与隔离 `RUNLEDGER_DIR` 的真实 `runledger` 路径；`npm test` 按专题要求执行。证据必须来自目标 commit，历史结果只作参考。
