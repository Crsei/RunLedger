# 版本升级与发布设施（Release / Upgrade）

本专题负责 RunLedger 的**分发与升级链路**：版本真相与发布单元、清洁构建与打包边界、
发布产物与完整性、安装形态识别、`runledger update` 的委托式升级、启动期升级提示，
以及配套门禁与证据矩阵。

不负责：模型/provider 目录、`state.db` schema 迁移本身（见 [Storage/CLI](../storage-cli/README.md)
与 [Runtime 04](../runtime/04-governed-agent-harness-runtime-plan.md)）、TUI 渲染细节
（见 [TUI](../tui/00-overview.md)）、legacy 常驻 Host（见 [Runtime 05](../runtime/05-multi-client-background-terminal-refactor-plan.md)）。

## 文档地图

| 文档 | 角色 | 状态 |
|---|---|---|
| [00-release-baseline.md](00-release-baseline.md) | 只读现状基线：可复现命令、实测数字、带 `文件:行` 的闸门清单、阻塞项与未核实项 | 事实记录，随代码演进需要重新实测 |
| [01-release-and-upgrade-infrastructure-plan.md](01-release-and-upgrade-infrastructure-plan.md) | 实施计划（唯一状态账本）：冻结合同、R0–R7 阶段、门禁矩阵、兼容性政策、风险 | `planned` |

计划与现状分开维护：00 只写实测到的事实与证据命令，01 只写目标、交付物、验收与顺序。
两者冲突时以当前代码、`tests/` 与 00 的实测证据为准，并就地修正 01。

## 状态规则

- 阶段状态只有 `planned / in_progress / implemented / blocked`；只有当前工作树具备
  RED 证据、实现、对应门禁与真实安装/升级证据后才可标 `implemented`。
- 自动化通过、构建后 CLI 通过、隔离 prefix 真实安装通过、人工验收是**不同等级的证据**，
  不得互相替代。跨平台（macOS/Windows runner）在 Linux 证据之外单列。
- 不把未执行的检查、未跑通的安装或未验证的平台写成通过。

## 与 legacy auto-update 线的关系

`feat/agent-loop-resurrect` 分支（工作树 `RunLedger-agent-loop-resurrect`）另有一条已实现到
U8 的 managed auto-update 线：`src/update/**`（24 个模块）、`src/daemon/update-host-controller.ts`
与 `development-doc/auto-update/{01-implementation-plan.md,02-release-runbook.md,03-acceptance-matrix.json,04-windows-validation-plan.md}`。
该线**不在当前工作树/当前分支**，其实现依赖本线不存在的 `src/daemon/`，且与本线
`tests/cli/session-owner-cli.test.ts` 的 import 边界、`src/tui/update/types.ts` 的被动合同
约束不同。本专题把它当作**参考输入与后续阶段候选**，不作为当前能力，也不重复实现其
签名频道、rollout/revocation、managed installer 与激活编排；差异与复用边界见
[01 §7](01-release-and-upgrade-infrastructure-plan.md)。

## 证据边界

所有安装/升级验收必须使用新建的隔离前缀（`npm --prefix <tmp>`）与新建的隔离
`RUNLEDGER_DIR`，不得操作真实用户目录、真实全局 `node_modules` 或现有 `~/.runledger`。
真实全局安装（`npm install -g`）与 `npm link` 属于人工验收，需要单列记录。
