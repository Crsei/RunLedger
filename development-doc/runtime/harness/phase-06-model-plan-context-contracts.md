# Phase 6:Model、Plan、Context、Compaction 与 Memory 公共契约

> 权威总入口:[`04-governed-agent-harness-runtime-plan.md`](../04-governed-agent-harness-runtime-plan.md)
> 分阶段索引:[`README.md`](README.md)
> 导航:[Phase 5](phase-05-resource-contracts.md) / [Phase 7](phase-07-orchestrator-budget.md)
> 状态规则:当前实现状态以主计划 §0.0 为唯一汇总真源;严格开发顺序、并行 lane 与 join gate 以主计划 §12 为准。本文件只承载本 Phase 的完整需求、门槛、故障注入与历史证据。
> 当前窗口:`RED/unfreeze`,`P6-C1 in_progress`;owner=`Codex /root`;worktree=`worktree/governed-agent-harness-runtime`;起始基线=`600ca84`。

目标:只冻结专项实现与 Runtime 其他模块共享的中立数据结构、schema、event payload 和 fixture,不改变用户行为。

前置:Phase 0、Phase 1、Phase 3、Phase 4 与 §0.5 `PiAiParityManifest`;resource snapshot/ref 结构依赖 Phase 5 contract。各 contract slice 冻结后,专项计划可在不改写本阶段文件的前提下并行实现。

Runtime contract allowlist:

- 补全现有 `src/runtime/model-routing/{types,schema}.ts`。
- 补全现有 `src/runtime/modes/plan/{types,schema}.ts`。
- 补全现有 `src/runtime/context/{types,schema}.ts`。
- 补全现有 `src/runtime/context/compaction/{types,schema}.ts`。
- 补全现有 `src/runtime/context/memory/{types,schema}.ts`。
- 按统一协议变更 allowlist 扩展 `src/runtime/protocol/v3/{event-catalog,event-payloads,events,schemas,state-transitions}.ts`,只注册本阶段的 payload/catalog/transition/version fence。
- 新增 `tests/runtime-v3/contracts/{model-routing,plan-mode,context,compaction,memory}.test.ts` 与 `tests/runtime-v3/fixtures/{model-routing,plan-mode,context,compaction,memory}/`。

本阶段禁止修改:

- 不新增 manifest loader、router、profiles、adapter-state service、reducer、ContextEngine、token estimator、compaction planner/summarizer/validator/service、Memory store/index/search/approval 或 Plan Mode 工具。
- 不修改 `src/runtime/{agent-loop,interactive-session-controller}.ts`、`src/models.ts`、`src/models-store.ts`、`src/storage/**`、`src/cli/**`、`src/tui/**` 和 provider adapters。
- 不写 behavior/security/recovery/E2E 测试,不用虚假 implementation 让 fixture 通过。这些任务全部归专项计划。

数据结构任务:

| 闭合任务 | 状态 | 最近更新 |
|---|---|---|
| P6-C1 Model Routing v2 contract | in_progress | 2026-07-24T02:38:00+08:00 RED fixture/test 登记 |
| P6-C2 pi-ai parity/catalog binding | pending | 2026-07-24T02:36:00+08:00 audit 164/164 + 72 PASS |
| P6-C3 manifest/profile evidence binding | pending | - |
| P6-C4 七类 compatibility hash fail-closed | pending | - |
| P6-C5 ModelSwitchConversionReceipt | pending | - |
| P6-C6 compatible receipt / lossy fork | pending | - |
| P6-C7 model.routed v1 replay + v2 producer | pending | - |
| P6-C8 Plan v1 cross-contract evidence | pending | - |
| P6-C9 Context v1 cross-contract evidence | pending | - |
| P6-C10 Memory v1 cross-contract evidence | pending | - |
| P6-C11 Compaction recovery assessment | pending | - |
| P6-C12 recovery invalid/corrupted matrix | pending | - |
| P6-C13 taint end-to-end preservation | pending | - |
| P6-C14 public event/catalog exhaustiveness | pending | - |
| P6-C15 ownership manifest exhaustiveness | pending | - |
| P6-C16 frozen PCM 16 files / 94 tests | pending | - |
| P6-C17 Phase 5/Extension regression | pending | - |
| P6-C18 full gates/refreeze | pending | - |

### Phase 6 窄解冻登记

- owner:`Codex /root`;branch/worktree:`worktree/governed-agent-harness-runtime`;
- RED allowlist:`development-doc/runtime/harness/phase-06-model-plan-context-contracts.md`,`development-doc/runtime/06-specialty-implementation-freeze.md`,`tests/runtime-v3/phase-06-v2-red.test.ts`,`tests/runtime-v3/fixtures/model-routing/**`,`tests/runtime-v3/fixtures/compaction/**`,`tests/runtime-v3/fixtures/taint/**`;
- GREEN allowlist:RED allowlist加`src/runtime/model-routing/**`,`src/runtime/context/compaction/{types,schema,validator,projection}.ts`,`src/runtime/protocol/v3/event-payloads.ts`,`src/runtime/session/{agent-loop-events,reducer}.ts`,`src/runtime/integration/{catalog-model-router,governed-model-request,production-model-runtime}.ts`,`tests/runtime-v3/{contracts,model-routing,context/compaction,plan-context-memory,integration,public-surface}/**`,`development-doc/runtime/{04-governed-agent-harness-runtime-plan,06-specialty-implementation-freeze}.md`;
- Plan、Context、Memory wire shape继续为v1,只补交叉fixture/consumer evidence。禁止新增Plan UI、Context行为、compaction trigger、Memory lifecycle、provider/catalog数据或用户面。
- parity manifest必须保持SHA-256=`fcb4713c661a7de0732d9f1379bbbc0525250ebcdd7027186d076cddcd938d77`;固定审计命令必须保持`164/164 upstream files,72 catalog files PASS`。若发生真实pi drift,P6-C2立即`blocked`并转独立reconciliation。
- 状态只允许`pending | in_progress | completed | blocked`,且同时最多一个`in_progress`。

- [ ] 定义 model capability/profile manifest、route request/decision/diagnostic、adapter-state compatibility 与必须 fork reason。
- [ ] model profile 的 provider/api/tool/reasoning/image/context/transport 能力从已验证 `PiAiParityManifest` 和 catalog 生成或核对;未知/缺失能力按 incompatible 处理,不得根据 display name 或 best-effort `transformMessages` 猜测可切换。
- [ ] 定义 `SessionMode`、`PlanModeState`、`ApprovedPlanRef`、mode/plan command、expected revision 与 approval/artifact reference;只表达状态,不实现迁移。
- [ ] 定义 `ContextLayer`、`ContextFragment`、trust/taint/provenance、assembly request/receipt、omission diagnostic 和 bounded budget 字段。
- [ ] Context assembly、compaction summary/checkpoint、model switch、Memory proposal/injection 全程保留 InputSourceRef/TaintLabel 与允许 sink;任何合并/摘要都只能取 taint 上界,去污只接受 Phase 0 的独立 DeclassificationReceipt。
- [ ] 定义 compaction reason、cut/checkpoint/invariant snapshot/ref、validation result、suppression/attempt receipt 和 previous-checkpoint link。
- [ ] compaction checkpoint 携带完整 replacement-history ArtifactRef/digest、被替换范围、previous link 与 surviving suffix cursor;恢复只允许验证 checkpoint 后正向 replay suffix,不能从 UI delta、bounded summary 或最后可解析行猜测 canonical history。
- [ ] 定义 memory scope/status/source/ref、record/proposal/diff/search request/result/receipt、TTL/revocation/approval reference。
- [ ] 复用 Phase 3 capability/effect 和 approval ticket、Phase 4 `ArtifactRef`、Phase 2 workspace identity;不在本阶段重新声明同义类型。
- [ ] 扩展穷尽 v3 event union,覆盖 model route、mode/plan lifecycle、context receipt、compaction lifecycle 和 memory proposal/approval/publication/search/injection;大正文只保存 Artifact/Memory ref 和 bounded metadata。
- [ ] 为每个类型提供 TypeBox schema、public export 和稳定 discriminant;禁止 `any`、`enum`、宽松 `Record<string, unknown>` canonical payload 和无上界 array/string。
- [ ] fixture 覆盖 compatible/incompatible model switch、approval resume、multi-compaction chain、taint 跨摘要/切模型不丢失、memory revoke/expire、unknown major version、oversized payload 和 invalid reference。
- [ ] compatibility fixture 对 tool/reasoning/adapter-state/compaction/context/profile/regression 的每一个 hash 分别构造 missing/unknown;任一缺证明均判 incompatible,只能拒绝或显式 fork,不得等同于“hash 未变化”。
- [ ] compaction contract 区分 prepared replacement、durably committed checkpoint 与 live projection installed,并携带 expected projection revision/installation receipt;专项行为必须先 durable commit replacement Artifact、invariant snapshot 和 previous link,再以 CAS 安装 projection。
- [ ] compaction/recovery fixture 覆盖 invalid window UUID/chain、损坏 world-state、patch-without-full、legacy missing replacement、坏 checkpoint 与 checkpoint 外坏 JSONL;每种输入都应有确定 invalid/corrupted 结果,不得通过 optional/default 字段降级为可恢复。
- [ ] compatible-switch fixture 明确验证允许的 reasoning/image/tool-call ID 降级及转换 receipt;incompatible-switch fixture 覆盖 tool schema、private adapter state、compaction format、transport/context profile 不兼容并要求 fork/拒绝。两者都不得以 `transformMessages` 未抛错作为判定依据。
- [ ] contract test 校验 schema/static type 一致、JSON round-trip、unknown-field/version fail closed、budget bound、ID/ref 关系和 v3 event catalog 穷尽性。
- [ ] 生成 contract ownership manifest,精确列出 Runtime allowlist、专项 behavior path 和 shared integration path;架构测试拒绝专项模块重复定义公共类型。

交接规则:

- 专项 Phase 0 通过 public exports 和 golden fixtures 验证契约,不在其 PR 内修改 allowlist。
- 若行为实现发现字段/状态不足,先在本阶段登记变更理由、schema version、兼容性和 fixture,由独立 contract PR 冻结后再适配 behavior。
- Runtime Phase 6 只回写 contract commit/验证证据;专项最终完成时只在此添加指向专项账本的汇总链接,不把 behavior checklist 搬回本阶段。

完成门槛:

- contract allowlist 中的静态类型、TypeBox schema、event payload、public export 和 fixture 一一对应。
- 全部 contract tests 通过,破坏性 schema 漂移、未知版本、越界 payload 和非法 ref 都 fail closed。
- ownership manifest/架构测试证明 Runtime 与专项没有重叠写入路径,本阶段 diff 不含任何 behavior 或用户面实现。
- 已在本阶段分别记录“contract 已冻结”与“专项实现状态”;不得因 contract 通过就声称模型切换、Plan Mode、compaction 或 memory 可用。

建议 PR:

1. `runtime: freeze model plan and context data contracts`
2. `runtime: add compaction memory schemas and contract fixtures`
3. `runtime: fence contract ownership from behavior implementations`
