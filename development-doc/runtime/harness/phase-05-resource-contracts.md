# Phase 5:动态资源 Runtime 协议与数据结构

> 权威总入口:[`04-governed-agent-harness-runtime-plan.md`](../04-governed-agent-harness-runtime-plan.md)
> 分阶段索引:[`README.md`](README.md)
> 导航:[Phase 4](phase-04-artifact-episode.md) / [Phase 6](phase-06-model-plan-context-contracts.md)
> 状态规则:当前实现状态以主计划 §0.0 为唯一汇总真源;严格开发顺序、并行 lane 与 join gate 以主计划 §12 为准。本文件只承载本 Phase 的完整需求、门槛、故障注入与历史证据。
> 当前窗口:`GREEN/refreeze completed`;owner=`Codex /root`;worktree=`worktree/governed-agent-harness-runtime`;RED commit=`cb83538`;GREEN 基线=`cb83538 + 当前 refreeze commit`。
> 当前验收状态:`Resource Contract v2 completed; Extension specialty behavior frozen/unavailable`。

目标:只定义 Tool/MCP/Skill/Hook/Plugin 接入 Runtime 所需的中立、版本化、可验证数据结构和 adapter port,不在 Runtime 计划中实现任何具体扩展子系统。

前置:Phase 0,以及 Phase 3 的 `CapabilityClaim` 与 Phase 4 的 `ArtifactRef` contract 已冻结;不等待 Phase 3/4 行为实现完成。resource identity/provenance 的草案可在 Phase 0 后并行准备,但包含 invocation/result/receipt 的 Phase 5 整体不能在上述引用 schema 冻结前完成。具体实现由 [`../../plugin-mcp-skill-hooks/01-implementation-plan.md`](../../plugin-mcp-skill-hooks/01-implementation-plan.md) Extension-M0–Extension-M6 完成。

计划文件:

- 补全现有 `src/runtime/resources/{types,schemas,ports,events}.ts`,删除 TODO 级宽松合同并与 v3 exact payload 对齐。
- 补全 `tests/runtime-v3/resource-contracts/`。
- 不修改 `src/runtime/tool-registry.ts`、`src/runtime/tools/skill.ts`、`src/runtime/agent-loop.ts`、controller、CLI 或 TUI。

最小中立类型:

- `ResourceKind`、`ResourceIdentity`、`ResourceProvenance`、`ResourceManifestDigest`。
- `ResourceTrustState`、`ResourceActivationState`、`ResourceApprovalReceipt`。
- `RuntimeToolDescriptor`、`RuntimeToolInvocation`、`RuntimeToolResult`,并引用 Phase 3 已定义的 `CapabilityClaim`;Phase 5 不重复定义 claim。
- `RuntimeResourceSnapshot`、`ResourceLifecycleEvent` 与对应 TypeBox schemas。
- `RuntimeResourceCatalogPort`、`RuntimeResourceInvocationPort`、`RuntimeResourceEventSink`、`RuntimeResourceSnapshotProvider`。

`ResourceKind` 的 closed taxonomy 至少区分 native tool、browser tool、MCP server/tool、Skill metadata/body/assets/script、Hook、Plugin component 与 repository/user/organization instruction;unknown kind 只能 quarantine,不能当作普通 tool 放行。

契约规则:

| 闭合任务 | 状态 | 最近更新 |
|---|---|---|
| P5-C1 identity 精确解析 | completed | 2026-07-24T02:29:12+08:00 v2 exact identity/golden PASS |
| P5-C2 provenance 与 locator containment | completed | 2026-07-24T02:29:12+08:00 canonical locator receipt/escape rejection PASS |
| P5-C3 trust/activation 分离 | completed | 2026-07-24T02:29:12+08:00 descriptor contract PASS |
| P5-C4 approval receipt 全绑定 | completed | 2026-07-24T02:29:12+08:00 policy/Hook/publisher/generation binding PASS |
| P5-C5 descriptor capability/exposure | completed | 2026-07-24T02:29:12+08:00 closed capability/exposure PASS |
| P5-C6 raw input 与 claims 重派生 | completed | 2026-07-24T02:29:12+08:00 input revision/derivation PASS |
| P5-C7 handshake/generation/annotation | completed | 2026-07-24T02:29:12+08:00 protocol v2/generation digest PASS |
| P5-C8 Hook updatedInput 重授权 | completed | 2026-07-24T02:29:12+08:00 old derivation invalidation PASS |
| P5-C9 invocation stream terminal | completed | 2026-07-24T02:29:12+08:00 bounded stream PASS |
| P5-C10 Skill facet 分离 | completed | 2026-07-24T02:29:12+08:00 body/script capability isolation PASS |
| P5-C11 snapshot-bound Skill read/budget | completed | 2026-07-24T02:29:12+08:00 facet read/generation/budget PASS |
| P5-C12 Instruction taint/SoD | completed | 2026-07-24T02:29:12+08:00 exact kind/taint/SoD PASS |
| P5-C13 Browser capability 分离 | completed | 2026-07-24T02:29:12+08:00 browser boundary matrix PASS |
| P5-C14 bounded non-executable snapshot | completed | 2026-07-24T02:29:12+08:00 architecture/snapshot PASS |
| P5-C15 lifecycle event | completed | 2026-07-24T02:29:12+08:00 exhaustive lifecycle PASS |
| P5-C16 Hook transform receipt/order | completed | 2026-07-24T02:29:12+08:00 source-order/short-circuit/prompt binding PASS |
| P5-C17 MCP annotation/remembered approval | completed | 2026-07-24T02:30:40+08:00 untrusted annotation/trust recheck PASS |
| P5-C18 Hook runner bounded execution | completed | 2026-07-24T02:30:40+08:00 existing Extension bounded runner regression PASS |
| P5-C19 exact schema/legacy reapproval | completed | 2026-07-24T02:29:12+08:00 v1 explicit import/reapproval PASS |
| P5-C20 complete neutral ports | completed | 2026-07-24T02:31:49+08:00 fake adapter all ports PASS |
| P5-C21 generation-bound cache | completed | 2026-07-24T02:29:12+08:00 generation/resource digest cache PASS |

### Phase 5 窄解冻登记

- owner:`Codex /root`;branch/worktree:`worktree/governed-agent-harness-runtime`;
- RED allowlist:`development-doc/runtime/harness/phase-05-resource-contracts.md`,`development-doc/runtime/06-specialty-implementation-freeze.md`,`tests/runtime-v3/resource-contracts/**`;
- GREEN allowlist:RED allowlist加`src/runtime/resources/**`,`src/extensions/{identity,types,snapshot,extension-manager,trust/**,integration/**,hooks/**,mcp/**,plugins/**,skills/**,schemas}.ts`,`tests/extensions/**`,`tests/fixtures/extensions/**`,`src/index.ts`,`package.json`;
- 共享消费者只允许协议迁移。禁止新增 CLI、TUI、installer、runner、planner、store 或专项行为;若现有行为需要扩大,对应项标记`blocked`并停止。
- v1 golden fixture必须保持只读且 SHA-256 固定为`45bdfa9e1e6a1874ac9617eeb290e83e6bae965ce5b1607661fdf7918902a654`;v1 approval 只允许显式 legacy parser 导入并返回`reapproval_required`。
- 状态只允许`pending | in_progress | completed | blocked`,且同时最多一个`in_progress`。每项完成后必须记录定向命令、结果、实现 commit、fixture digest、不可用行为边界和时间。

- [x] identity 以 `kind + qualified id + version/source + digest` 精确解析;display name 永远不能成为执行路由键。
- [x] provenance 可表达 builtin/user/project/plugin/session、canonical locator、publisher/signature 引用和 parent plugin,但不解释具体配置格式。locator 必须 canonicalize 并做 source-root containment;路径 containment 只验证定位,不能单独把 resource 标为 trusted。
- [x] trust 与 enabled/activation 分离;`untrusted/stale/revoked` 不得表达为 enabled 布尔值。
- [x] approval receipt 绑定 resource identity、manifest/config/command/assets digest、capability digest、principal、scope、expiry 与 revocation revision;任一绑定字段变化后 receipt 不匹配。
- [x] descriptor 只声明结构化能力、filesystem/network/process/credential 边界、risk 与 `direct/deferred/direct-model-only/hidden` exposure;不携带函数、client 或进程句柄。首版没有 nested Code Mode 时仍保留第四态并默认不向 child/nested executor 暴露,未知 exposure fail closed。
- [x] Runtime 只接受 raw invocation input,canonicalization 后由受信 descriptor 推导 `CapabilityClaim[]`;调用方提交的 claim 只能作为请求,不能成为最终授权事实。
- [x] adapter/tool-server handshake 协商 protocol/schema/features,并把 session binding、adapter generation 和 sequence envelope 固定进 snapshot/invocation/result;对端自报 `ToolCapabilities`/`ToolScope` 只属于不可信 annotation,默认 Read 或 capability bit 不能直接派生 authorization。
- [x] Hook/adapter 返回 `updatedInput` 后必须把它视为新的 raw invocation:重新 exact-schema validate、canonicalize、派生 capability/workspace/resource claims 并 authorize;改写前的 decision/receipt 立即失效,adapter 不得通过“已处理”标志绕过 Gateway/sandbox。
- [x] tool invocation stream 固定为零或多个 bounded progress event 加 exactly one terminal result;EOF/cancel/adapter replacement 前缺 terminal 必须生成稳定 failure terminal,duplicate terminal 或 terminal 后 progress 一律拒绝,且 terminal durable 前 Orchestrator 不推进。
- [x] Skill 的 metadata/body/assets/script 使用不同 resource/capability 标识;正文可读绝不蕴含脚本可执行。
- [x] Skill catalog list 与 body/assets read 绑定同一 snapshot generation;正文或资产 digest 变化生成新 generation,旧 snapshot 不得读取新内容,metadata/body/assets/script 的所有 context 注入路径共享同一硬字节/条目上限。
- [x] Instruction 是独立、带 source/digest/taint 的资源;instruction 内容或优先级变化使旧 approval stale,提出变更的 Agent/principal 不能批准自己的高权限 instruction,必须有 separation-of-duty receipt 或更高优先级组织策略。
- [x] Browser tool 与 native tool 使用不同 resource identity/capability manifest;browser navigation、DOM/script、download/upload、cookie/credential 和 network egress 分别声明能力,不能因“只做验证”绕过 Gateway/sandbox。
- [x] snapshot 不包含可执行对象,只包含有界 descriptor、diagnostic summary、digest 和 adapter generation id。
- [x] lifecycle event 只定义 discovered/approved/revoked/activated/deactivated/failed 等中立状态及 receipt refs;Plugin/MCP/Skill/Hooks 领域事件由扩展计划定义并映射。
- [x] snapshot/invocation 都绑定 adapter generation;reload/replacement 后旧 context 与旧 invocation 必须 fail closed。Hook adapter contract 还要能表达 same-role replacement、tool-result source-order patch、tool-call block short-circuit、system-prompt chain 与 input handled/transform 的确定顺序;具体 reducer 和错误策略由扩展专项实现与验收。
- [x] MCP annotation（含 `read_only_hint`）只作为不可信 metadata,不能生成 capability decision;remembered approval 每次都重新核对当前 policy/Hook、server config、tool/publisher/digest/generation。生产 composition 必须能证明使用显式安全 client factory 与 authorization adapter,缺失时 fail closed。
- [x] Hook runner 本身通过 Resource port + Gateway/Sandbox 执行;Hook input/output、stderr 与 diagnostic 都有硬字节上限和写前脱敏,持久 event 默认只保留分类、digest 与 bounded diagnostic ref。具体 runner 行为与联合 E2E 归扩展专项。
- [x] schemas 拒绝未知 major version、缺失 digest、含糊 identity、过期 receipt 和无法穷尽的状态值。
- [x] port 支持 exact resolve、bounded metadata search、snapshot acquire/release、invoke/cancel 和 event emission;不规定文件扫描、MCP transport、hook runner 或 plugin 安装方式。
- [x] snapshot/generation/cache ticket 绑定 adapter generation 与 resource digest;cache hit 只代表内容身份匹配,不替代 publisher trust、approval 或 capability decision。

本轮证据:

- 公共无后缀 contract/protocol 原位升级为 v2;instruction kind 精确拆为 repository/user/organization。v1 只经根 namespace `resourceLegacyV1` 只读解析,旧 approval 固定导入为`reapproval_required`。
- v2 增加 source-root containment receipt、publisher/signature/parent-plugin provenance binding、policy/Hook/publisher/locator/adapter-generation approval binding、snapshot-bound Skill facet read/budget、Hook transform/input revision/ordered patch receipt与 bounded untrusted MCP annotation。
- ports 覆盖 locator validation、exact resolve/search、snapshot acquire/release、facet read、transform、derive、invoke/cancel与event emission;in-memory fake adapter effects保持`fileReads=0/processStarts=0/networkRequests=0`。
- Extension 只做 identity/trust/discovery/runtime adapter 协议迁移;Extension 自身 persistence/domain schema继续为v1,CLI/TUI/installer/runner/store与行为状态机均未新增。
- 定向门禁:`tests/runtime-v3/resource-contracts`为`9 files / 35 tests PASS`;`tests/extensions`为`12 files / 52 tests PASS`;Phase 5+Extension+Phase 0+Artifact+public surface为`24 files / 103 tests PASS`;冻结 Security/Worktree为`21 files / 119 tests PASS`。
- 完整门禁:`npm run check`、`npm run build`、`git diff --check`均PASS;`npm test`为`267 files / 1755 tests PASS`,另有`1 file / 1 opt-in test SKIP`。
- fixture SHA-256:v1=`45bdfa9e1e6a1874ac9617eeb290e83e6bae965ce5b1607661fdf7918902a654`;v2=`7b054320507594b399e0f3862905565ff179d8e3d84cea0bdec7820577689f6c`;legacy approval=`b0eceb6d2d84c0c423790156a4bcfcb0f2ccc40f922a0c277791c7ccbb07c3a6`;failure matrix=`18cc38e3545a6a64d37cb75bd0410253b8a79626ea4aaff32eee898e7c57cc94`。
- 行为边界:`Resource Contract v2 completed; Extension specialty behavior frozen/unavailable`。Extension M2/M6/M7剩余用户面、marketplace、publisher root与完整生产 lifecycle继续保持`partial-frozen/deferred-frozen`。

显式不实现:

- Plugin manifest parser/discovery/store/install/update/rollback/marketplace。
- Skill frontmatter/discovery/catalog renderer/body/assets/script loader。
- Hook config/matcher/runner/dispatcher/failure policy。
- MCP config/SDK client/connection manager/catalog/tool adapter/OAuth/pagination。
- extension trust root/key lifecycle/trust store/fingerprint persistence、probe sandbox。
- extension-specific CLI/TUI/modal/doctor/reload 和 `src/extensions/**`。

迁移/交接:

- 先冻结 schema version、导出路径和 contract fixtures;扩展线只通过 public port 消费,不 import Runtime 内部 reducer/store。
- 扩展 adapter 将具体 `ExtensionSnapshot` 投影为 `RuntimeResourceSnapshot`,将具体 trust record 投影为 `ResourceApprovalReceipt`,不把 Runtime 类型反向持久化成另一份 extension 真源。
- 任何资源配置变化、批准撤销或 adapter generation 变化,由扩展实现生成新 snapshot/lifecycle event;Runtime 只验证结构、receipt 绑定与 Gateway decision。

完成门槛:

- 所有 TypeBox schema 与静态类型一致,round-trip/golden/unknown-version/invalid-receipt contract tests 全绿。
- fake adapter 可在不读取文件、不启动进程、不访问网络的情况下完成 exact resolve、snapshot 和 invocation contract 测试。
- 架构测试证明本阶段未新增 `src/extensions/**`,且 Runtime resources 模块不依赖 MCP SDK、YAML/semver parser 或具体 Plugin/Skill/Hook 实现。
- 具体资源的发现、信任、执行和 UI 验收只在扩展计划中判定,不得用本阶段完成状态代替。

建议 PR:

1. `runtime: define versioned neutral resource contracts`
2. `runtime: add resource adapter ports and contract fixtures`
