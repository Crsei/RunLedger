# ADR 04：OS Sandbox 重新评估（P7 决策，当前保持封存）

> 状态：**评估完成，决策为“暂不解封”**。本 ADR 复核 archive 恢复条件、比较
> 候选 backend、给出解封门禁；未批准新 ADR 前不修改 `src/security/sandbox/**`
> 的能力面（本次 slice 已用 git diff 验证无任何改动）。
>
> 关联：[`archive/00-os-sandbox-cross-platform-expansion-archived.md`](archive/00-os-sandbox-cross-platform-expansion-archived.md) §4 恢复条件、
> [`01-multiplatform-workspace-path-adaptation-plan.md`](01-multiplatform-workspace-path-adaptation-plan.md) P7、
> [`02-path-locator-adr.md`](02-path-locator-adr.md)。

## 1. 恢复条件复核（archive §4 → 当前状态）

| archive 恢复条件 | 当前状态（2026-08-06，P1–P6 后） | 结论 |
|---|---|---|
| 多平台 workspace/path 适配计划 P0–P6 全部完成 | P0–P5 完成；P6 完成 Linux 生产接线与能力矩阵，macOS/Windows runner CI/E2E 仍为 gap | **未满足** |
| Linux/macOS/Windows 真实 runner 均保存 evidence | 仅 Linux（`tests/fixtures/platform-evidence/linux`）；macOS/Windows 全部 gap | **未满足** |
| persisted locator 与 native path 转换契约版本化 + cold resume/migration 证据 | PrivateLocatorV1 + `resume.ts` + read-only audit + migration plan（未执行） | 已满足（Linux） |
| Git worktree create/list/remove/reset 三平台真实 E2E | 仅 Linux 真实 E2E | **未满足** |
| Host final leaf 只消费平台适配器，无散落 process.platform 分支 | P6 已收敛到 `src/workspace/{factory,runtime-platform}.ts` 两个单点，静态边界强制 | 已满足 |
| 安全评审确认 canonicalization/symlink/junction/TOCTOU/protected roots 平台语义 | Linux 路径语义已冻结（ADR 02）；junction/reparse 与 Windows 语义仍 pending | **部分满足** |
| 能力矩阵区分 workspace isolation / permission / external containment / OS sandbox | `workspace capability` 矩阵 + 本文档明确区分 | 已满足 |

结论：**解封前置条件未全部满足**。P7 只做评估与路线规划，不授权 backend 实现。

## 2. 候选 backend 比较（决策输入，非实现）

| 维度 | Linux bwrap | macOS Seatbelt（sandbox-exec） | Windows native helper（Restricted Token / Job Object） | external containment（Docker/VM/远程 executor） |
|---|---|---|---|---|
| filesystem 隔离 | mount namespace，强 | profile 规则，中等 | ACL/Restricted Token，中等 | 容器/VM 边界，强 |
| network 隔离 | net namespace，强 | 弱（Seatbelt 不隔离网络） | 需要额外 WFP/代理 | 容器网络，强 |
| process tree | cgroup/namespace | 无独立机制 | Job Object，强 | 容器进程边界 |
| symlink/junction 语义 | 依赖路径适配层正确 | 依赖路径适配层正确 | junction/reparse 需专门处理 | 由环境保证 |
| helper 供应链 | setuid 二进制或内核特性 | 系统自带 | 需自建签名 helper（Rust/C++）+ 打包/签名链 | 无本地 helper |
| 审计/失败语义 | receipt + denial 分类可复用 | 同上 | 同上 | 需要外部 attestation |
| 当前证据 | Linux 本地 enforced 回归 | 无真实 runner | 无真实 runner | 无 |

关键判断：

1. 三者的 filesystem/process 语义都依赖 ADR 02 的路径身份契约正确落地——
   这正是 P1–P6 正在建立的层；在 macOS/Windows 证据补齐前实现 backend，
   会把单平台假设写成安全策略；
2. macOS Seatbelt 对网络无隔离能力，单独不足以表达 network deny 承诺；
   archive §5 明确不默认沿用 `sandbox-exec` 为长期 backend；
3. Windows Restricted Token 单独不表达 network/process-tree 边界，必须
   Job Object + 网络过滤组合，且需要签名 helper 供应链；
4. external containment 必须携带外部 attestation，不能因“运行在容器里”
   自动标记有效（00 计划 §4.7 冻结不变量）。

## 3. 决策

1. **暂不解封**：恢复条件未满足（macOS/Windows 真实 runner 证据 + P6 CI 矩阵
   是硬缺口），继续冻结 `src/security/sandbox/**` 能力面；
2. 保持现有 fail-closed 回归与 Linux bwrap 本地证据；backend unavailable
   不得回退 raw shell / builtin none / client-local execution；
3. 解封动作 = 新建**独立** unfreeze ADR + 实现计划（本 ADR 不授权任何实现）；
4. 解封门禁（全部满足才可提交新 ADR）：

   - [ ] P5–P6 全部完成（含 macOS/Windows runner CI 矩阵与 artifact evidence）；
   - [ ] Linux/macOS/Windows 三平台 evidence fixtures 齐全并通过 digest manifest；
   - [ ] 三平台 Git worktree create/list/remove/reset 真实 E2E 通过；
   - [ ] 安全评审确认 junction/reparse、TOCTOU、protected roots 平台语义；
   - [ ] 新 unfreeze ADR 明确定 backend 组合（bwrap / Seatbelt / Windows
     helper / external）与各自 enforcement 范围，并批准 helper 供应链方案。

## 4. 与 P0–P6 的边界

- 本 ADR 不修改 `src/security/sandbox/**`、ExecutionGateway 或 fail-closed 回归；
- workspace isolation / permission / approval / external containment 是独立
  能力，不依赖本 ADR；
- `runledger workspace capability` 展示的证据状态与本文一致，不宣称 sandbox。

## 5. 解封后的重规划要求（archive §5 落实为下文 05 计划）

helper 构建、签名、打包、capability probe 与 enforcement E2E 的具体规划见
[`05-os-sandbox-unfreeze-plan.md`](05-os-sandbox-unfreeze-plan.md)（PLAN ONLY，
不执行）。
