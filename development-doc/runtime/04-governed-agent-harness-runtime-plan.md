# RunLedger 可治理 Agent Harness Runtime 主计划

> 文档状态:完整计划,当前权威执行入口;实现状态:未完成,复选框只有附当前目标分支/工作树证据后才能勾选
> 基线日期:2026-07-22
> 适用范围:`src/runtime/`、`src/storage/`、`src/cli/`、后续 `src/daemon/` 与对应测试;Plugin/MCP/Skill/Hooks 以及 Worktree/Sandbox/Permission 交叉领域仅定义 Runtime 中立数据结构与适配端口
> 上游设计输入:[`00-reference.md`](00-reference.md)
> 历史计划:[`01-minimum-runtime-scaffold-plan.md`](01-minimum-runtime-scaffold-plan.md)、[`02-agent-loop-resurrection-plan.md`](02-agent-loop-resurrection-plan.md)、[`03-tool-system-plan.md`](03-tool-system-plan.md)
> pi-ai 移植基线:[`../providers/01-pi-ai-migration-plan.md`](../providers/01-pi-ai-migration-plan.md)
> 扩展实现计划:[`../plugin-mcp-skill-hooks/01-implementation-plan.md`](../plugin-mcp-skill-hooks/01-implementation-plan.md)
> Plan/Context/Compaction/Memory 专项实现:[`../plan-compact-memory/01-implementation-plan.md`](../plan-compact-memory/01-implementation-plan.md)
> Worktree/Sandbox/Permission 专项实现:[`../worktree-sandbox-permisson/00-worktree-sandbox-permission-plan.md`](../worktree-sandbox-permisson/00-worktree-sandbox-permission-plan.md)

## 0. 文档定位与执行规则

本文件把四个参考仓库的可复用机制、RunLedger 当前实现和 `00-reference.md` 的治理要求收敛为一个可执行建设计划。`01`–`03` 继续保留为历史实施记录,不再承担未来 Runtime 的状态跟踪。本文件是后续 Runtime PR 的唯一总入口和阶段状态账本;其中已列出专项计划的领域,本文件只跟踪公共契约和跨域依赖,具体实现状态以各专项账本为准。

执行规则:

- 每次只推进一个阶段内可独立验收的 PR 边界,不得用一次重写跨越多个安全边界。
- 每个 PR 必须在本文件对应复选框后补充 commit、测试命令和结果;没有证据不得标记完成。
- Provider/API/Auth 已大体完成 pi-ai 移植,后续只做差异同步与 Model Compatibility 扩展,不重新移植整套 provider。
- Session 与 Runtime 只接受当前 exact format；未知或旧格式直接拒绝，不提供 migrate、fork-to-current、兼容 reader 或双写路径。所有治理语义都写入当前唯一真源。
- Event Store 是 session/goal/orchestration 状态的唯一事实源。TUI、CLI、daemon、model history、activity、cost 和 verification status 都是 projection;外部权威存储的边界见 §3.1。
- 在单 Agent 的 Session、Workspace、Capability、Artifact 与 Verification 边界稳定前,不得默认启用多 Agent 或远程执行。
- 任一安全组件初始化失败时 fail closed,不得静默退化到共享 workspace、无 sandbox、AllowAll 或未验证资源。
- 本文件的状态真源是当前目标分支上的文件内容与已记录 commit/test evidence。其他 worktree 的未合并实现、口头报告或局部定向测试都不改变这里的复选框;合入当前目标分支并重新验证后才能回写状态。

### 0.1 与 Plugin/MCP/Skill/Hooks 计划的强制边界

本计划只拥有 Runtime 通用协议、数据结构、schema、event payload 和 adapter port。它不实现任何 Plugin/MCP/Skill/Hooks 的发现、解析、信任存储、进程生命周期或用户控制面。具体实现及状态账本统一归属 [`../plugin-mcp-skill-hooks/01-implementation-plan.md`](../plugin-mcp-skill-hooks/01-implementation-plan.md),不得在 `src/runtime/resources/` 下再造第二套实现。

为避免与本计划发布里程碑混淆,下文把该专项的 `M0`–`M7` 统一写作 `Extension-M0`–`Extension-M7`;本计划自身只使用 `Runtime-M0`–`Runtime-M4`。

| 边界 | Runtime 计划拥有 | 扩展计划拥有 |
|---|---|---|
| 数据契约 | `ResourceIdentity`、provenance、digest、trust/activation state、approval receipt、tool descriptor/invocation/result、snapshot、lifecycle event、capability claim | Plugin manifest、Skill frontmatter、Hook/MCP 配置和领域状态的具体 schema |
| 端口 | exact resolve、snapshot provider、invocation、event sink、capability gateway 的中立接口 | `ExtensionManager` 及实现这些端口的 adapter |
| 安全执行 | 定义 raw invocation、canonical input、required claim 与 Gateway receipt 的组合契约；Gateway 行为实现归 §0.2 专项计划 | Hook/MCP 子进程、Skill 正文/资产/脚本、Plugin component 的发现和执行编排,全部消费受限 executor |
| 持久化 | current event envelope 与 receipt 引用结构 | extension enable/trust/config 状态文件及内容 fingerprint |
| 用户面 | Runtime 通用 approval/session/control-plane 协议 | plugin/mcp/skill/hooks 的 CLI/TUI/doctor/reload 操作 |

并行实施规则:

1. Runtime 线只新增 `src/runtime/resources/{types,schemas,ports,events}.ts` 与 `tests/runtime-contracts/resource-contracts/`,不得新增 manager、loader、installer、client、runner、catalog 或 trust store。
2. 扩展线只修改 `src/extensions/**`、`tests/extensions/**` 和 `tests/fixtures/extensions/**`,通过 Runtime port 编译,不得反向修改 Runtime 契约来迁就实现。
3. `src/runtime/{agent-loop,types,tool-registry,tool-authorization,interactive-session-controller}.ts` 是跨专项串行集成面。扩展线先在 `src/extensions/integration/**` 产出 adapter,只有取得记录过的集成窗口后才由单一所有者修改；不得与 Runtime contract、Worktree/Sandbox/Permission 或其他专项并发修改。
4. `package.json` 和 `package-lock.json` 属于扩展计划 Extension-M0 的串行 dependency handoff:Runtime 线先交出 dependency HEAD,扩展线以一个独立提交加入精确依赖,随后双方以该提交为基线。`src/storage/{paths,settings-manager}.ts`、`src/cli/**`、`src/tui/**`、`src/index.ts` 属于 Extension-M6 串行集成面;Runtime 后续阶段基于 handoff commit 继续,不得并发改同一文件。
5. 若契约确需变更,先由 Runtime 线提交 schema 版本升级和 contract tests,再由扩展 adapter 跟进。不得在同一提交同时改两侧实现,也不得复制类型形成漂移的双真源。

### 0.2 与 Worktree/Sandbox/Permission 计划的强制边界

对 workspace/worktree、permission/approval、sandbox 三组交叉领域,本计划只交付 Runtime 可消费的规范化数据结构:

- Runtime ID、`WorkspaceExecutionEnvelope`、workspace/lease/checkpoint 引用与投影结构;
- capability/permission/approval/sandbox 决策、ticket、receipt 引用类型;
- current event name、payload schema、reducer 输入/输出和 control-plane command/query schema;
- Orchestrator、Artifact、Verification、Multi-Agent 中对 workspace/capability/approval/sandbox 的 ID 或 receipt 引用。

[`../worktree-sandbox-permisson/00-worktree-sandbox-permission-plan.md`](../worktree-sandbox-permisson/00-worktree-sandbox-permission-plan.md) 是上述领域唯一行为实现和集成状态账本,独占负责 repository/worktree 生命周期与 lease、path/shell/network 分析、PermissionEngine、ApprovalCoordinator、Credential Broker、ExecutionGateway、filesystem/process/network broker、平台 sandbox 以及生产 CLI/TUI/session 接线与事件发射时机。

下文用 `WorkspaceSecurity-PhaseN` 与 `WorkspaceSecurity-MN` 分别引用该专项的实施阶段和发布里程碑,不得与 Runtime Phase/Runtime-M 混写。

依赖只允许单向流动:

```text
runtime protocol contracts
        -> security/worktree implementations
        -> serialized runtime integration adapters
```

平行实施规则:

1. Runtime 线独占 `src/runtime/protocol/**` 与对应 contract tests,不得 import `src/security/**` 或 `src/worktree/**`,不新建 `src/runtime/workspace/**` 或 `src/runtime/capability/**` 行为实现。
2. 安全实现线独占 `src/security/**`、`src/worktree/**`、`tests/security/**` 和 `tests/worktree/**`,实现并验证 Runtime contract,不重新定义 envelope、decision、receipt 或 event 联合。
3. `src/runtime/{agent-loop,execution-env,tool-context,tool-authorization,interactive-session-controller}.ts`、`src/runtime/ledger/types.ts`、`src/storage/{paths,session-codec}.ts`、`src/cli/**` 和 `src/tui/**` 是串行集成面。Runtime contract 与安全实现各自完成后,由专项计划的集成阶段修改;不得与其他专项集成提交并发。
4. Runtime 事件契约拥有 event name/payload schema;专项实现拥有发射时机、enforcement receipt 的产生和外部存储。契约变更先提交 exact contract 与 fixture,再更新 adapter。

### 0.3 与 Plan/Context/Compaction/Memory 计划的强制边界

本计划 Phase 6 只生成 Model Compatibility、Plan Mode、Context、Compaction 与 Memory 接入 Runtime 所需的中立数据结构、TypeBox schema、current event payload、fixture 和 contract tests。router、reducer、service、store、算法、工具、TUI/CLI 与 agent-loop/controller 接线统一归属 [`../plan-compact-memory/01-implementation-plan.md`](../plan-compact-memory/01-implementation-plan.md),Phase 6 的“完成”不能代表专项行为已实现。

| 边界 | Runtime Phase 6 拥有 | Plan/Context/Compaction/Memory 专项拥有 |
|---|---|---|
| 公共类型 | model profile/route decision、mode/plan ref、context receipt、checkpoint、memory record/proposal/search receipt | 不复制类型,只通过 public export 消费 |
| schema/event | TypeBox schema、current payload/catalog、版本栅栏、bounded metadata | event 生成时机、状态迁移、intent/commit/recovery |
| 行为 | 无 | manifest loader/router、ContextEngine、PlanModeService、CompactionService、MemoryService |
| 存储/用户面 | 只引用 Artifact/Approval/Workspace 契约 | plan/memory store、index、tools、TUI/CLI、controller/agent-loop 接线 |
| 测试 | schema round-trip、golden fixture、unknown-event/invalid-bound contract | reducer/service/store/security/recovery/integration/E2E |

并行实施规则:

1. Runtime 线独占 `src/runtime/{model-routing,modes/plan,context}/**/{types,schema}.ts`、`src/runtime/protocol/{events,schemas}.ts` 中对应 payload/catalog 和 `tests/runtime-contracts/contracts/**`;具体 allowlist 见 Phase 6。
2. 专项线独占上述目录中除 contract allowlist 外的行为文件,以及专用 storage/tool/TUI 组件和行为测试。不得在专项 PR 顺手修改 contract 文件。
3. `src/runtime/{agent-loop,interactive-session-controller}.ts`、`src/models.ts`、`src/models-store.ts`、`src/cli/**`、`src/tui/**`、`src/index.ts` 是串行集成面。专项先在新模块和 adapter 中完成行为,只在对应 Runtime 前置 contract 冻结后安排单一所有者的集成 PR。
4. 契约变更时,先在本计划 Phase 6 登记 exact contract/fixture 变更并提交 contract PR,再由专项 PR 适配。不允许在专项内创建同义型别或临时 payload 绕开该流程。
5. Phase 6 状态分为“contract 已冻结”与“专项实现已验收”两个独立记录;后者只能引用专项计划的 commit 和验证证据,不把其任务复制回本文件。

格式边界以本计划 §6 的当前格式策略为唯一真源。专项只能消费当前 public contract；输入不满足 exact contract 时必须拒绝，不通过猜测、文本降级或隐式转换继续。

### 0.4 Enterprise/Remote/Telemetry 的实现所有权

Phase 11 同时包含 Runtime 自有行为与跨专项合同,必须按下表交付,不能把“schema 已冻结”误写成“企业安全已实现”。

| 领域 | Runtime 主计划拥有 | 行为实现与最终验收 owner |
|---|---|---|
| Control Plane Activity 基础面 | `RuntimeActivity` 完整 schema、单 Agent projection、heartbeat 与 `activity:get` | Runtime Phase 10 |
| Activity/cost/OTel/SIEM 加固 | nested-agent/cost enrichment、redaction pipeline、exporter adapter、health signal、Telemetry Manifest | Runtime Phase 11 |
| startup/shutdown/session-artifact GC | canonical recovery order、writer/daemon lifecycle、session/artifact ref 清理 | Runtime Phase 1、4、10–11；workspace/process 外部清理由下列专项返回 receipt |
| managed policy、identity/tenant、RBAC/ABAC、Credential Broker | versioned schema、provider port、correlation/receipt 校验 | [`../worktree-sandbox-permisson/00-worktree-sandbox-permission-plan.md`](../worktree-sandbox-permisson/00-worktree-sandbox-permission-plan.md) Phase 8 |
| CI/SSH/relay executor、egress、remote attestation/handoff | invocation/attestation/result receipt 与 event/artifact/workspace refs | Worktree/Sandbox/Permission Phase 8 + Runtime Phase 10–11 联合 E2E |
| ChangeProposal、human gate、forge | Phase 8 contract/port,Phase 10 service/provider adapter,Phase 11 production credential/organization gate 联合验证 | Runtime Phase 8、10–11 + WorkspaceSecurity-Phase8 |
| marketplace allowlist、publisher/signature/revocation | 中立 resource identity/trust/capability refs | [`../plugin-mcp-skill-hooks/01-implementation-plan.md`](../plugin-mcp-skill-hooks/01-implementation-plan.md) Extension-M7 |
| memory/compaction telemetry 与 managed bounds | 通用 telemetry/policy refs | [`../plan-compact-memory/01-implementation-plan.md`](../plan-compact-memory/01-implementation-plan.md) Phase 10 |

若后续需求无法落入上述 owner,必须先新增或扩展唯一专项状态账本并在本节登记,不得在 Phase 11 内临时复制 policy/credential/executor 实现。

### 0.5 pi-ai 上游差异同步门

RunLedger 已完成 pi-ai 大体移植,但“曾经全量移植”不能自动证明与本计划固定的 pi snapshot 仍等价。[`../providers/01-pi-ai-migration-plan.md`](../providers/01-pi-ai-migration-plan.md) 只作为历史移植基线;本节是后续 Provider/API/Auth/catalog 差异同步的当前 gate 与状态入口,不把它塞进 Runtime Phase 6 的 model-routing contract。Phase 6 行为接线前必须取得一个可追踪 `PiAiParityManifest`。

计划产物与边界:

- 新增 `development-doc/providers/pi-ai-parity-manifest.json` 和只读审计脚本 `scripts/audit-pi-ai-delta.ts`;脚本接受显式 upstream path/commit,不在构建时联网或隐式依赖本机 `../pi`。
- 允许修改 `src/{api,auth,providers,storage,utils}/**`、`src/{types,models,models-store,models.generated}.ts`、生成脚本和对应 provider tests;不得顺手修改 Runtime Orchestrator/Session/Control Plane。
- manifest 是审计证据而非运行时授权或 model compatibility 真源;Runtime 只消费经测试导出的 capability/profile 字段。

`PiAiParityManifest` 至少记录 pi upstream commit、RunLedger base commit、`packages/ai/src` 到 `src/{api,auth,providers,storage,utils}` 及顶层 model/image/session 资源的 file/digest mapping、已应用 delta、明确拒绝/后置项、生成 catalog digest、事件/消息转换行为摘要和验证结果。

本次固定 snapshot 已确认至少存在以下 delta,后续 preflight 必须逐项决策而不能把它们漏成“无差异”:

| delta | pi 证据 / RunLedger 现状 | 必需验证 |
|---|---|---|
| Qwen Token Plan providers | pi `packages/ai/src/{types,providers/all}.ts` 及 `providers/qwen-token-plan*.ts`;RunLedger 对应 provider/type/注册缺失 | provider registry、catalog 生成、auth/model smoke |
| ToolResult usage | pi `packages/ai/src/types.ts` 的 `ToolResultMessage.usage?`;RunLedger `src/types.ts` 未带该字段 | event/message round-trip、cost projection |
| OpenAI tool-call identity | pi `packages/ai/src/api/openai-completions.ts` 合并 `call_id + item_id` 并对超长值加短 hash;RunLedger 仅截断 `call_id` | 同 call/multi-item、超长、collision fixture |
| stored credential env | pi `packages/ai/src/auth/helpers.ts` 与 `providers/amazon-bedrock.ts` 保留 `credential.env`;RunLedger 当前丢失 | secret redaction、provider env 选择与 serialization test |
| model catalog cache | pi `packages/ai/src/models-store.ts` 含 `lastModified`;RunLedger 只有 `checkedAt` | stale/cache refresh/conditional fetch test |
| overflow detection | pi `packages/ai/src/utils/overflow.ts` 覆盖 DashScope/Qwen range 文本;RunLedger 未覆盖 | overflow classifier 与单次 compact/retry fixture |

任务:

- [ ] 对固定 upstream snapshot 做 tree/digest diff,把变更分成 provider transport、共享 Message/Event 类型、auth/storage、model catalog/generator、纯 coding-agent 产物五类,逐文件记录 adopt/reject/localize 与许可证结论。
- [ ] 用独立 provider PR 同步前四类中适用变更;`compat.ts`、coding-agent CLI/UI 等继续按 RunLedger 范围显式拒绝,不能用整个目录覆盖本仓。
- [ ] 为本次已知 delta 增加跨 provider、tool-call identity collision、ToolResult usage、credential env/redaction、cache refresh、overflow/compact-retry fixture。
- [ ] 共享 Message/Event 或 reasoning/tool-call 转换变化先更新 provider contract tests,再由 Runtime Phase 6 更新 Compatibility Manifest;adapter 的 best-effort 规范化不能被写成 session-level 可安全切模证明。
- [ ] catalog/provider 有变化时执行 `npm run generate-models` 并审阅生成物;随后运行受影响 provider tests、`npm run check`、`npm test`、`npm run build` 与 `git diff --check`。
- [ ] 只有 manifest、差异说明和完整验证进入目标分支后,Runtime 才可把该 provider baseline 标为可消费;无差异也必须记录 upstream/base/digest,不能只写“已同步”。

完成门槛:`PiAiParityManifest` 可由显式 upstream checkout 重算,所有 intentional divergence 有理由和 regression fixture,生成物无未解释 diff,完整验证全绿。建议独立 PR:`providers: reconcile pi-ai delta before runtime model routing`。

### 0.6 全局串行集成账本

§0.1–§0.3 各专项的独占目录可以并行开发,但共享 composition 文件必须严格按下表串行交接。每个窗口开始前在本文件对应阶段记录 `baseline commit + 前置 owner commit + 允许路径 + 负责人`,结束后记录 `handoff commit + 完整验证`;没有 handoff 记录不得打开下一窗口。表中顺序只约束共享文件,不阻止新模块、fake adapter 或 contract consumer tests 并行开发。

| 窗口 | 单一 owner | 允许的共享路径 | 开始条件 | 后继 handoff |
|---|---|---|---|---|
| I0 Runtime contract/session baseline | Runtime Phase 0–5 baseline owner | `src/runtime/protocol/**`、`src/runtime/{types,ledger,agent-loop,agent}.ts`、`src/storage/{session-manager,session-codec}.ts`、Phase 4 Artifact 独占模块与最小 public exports | Phase 0–3 contract、Phase 1 session、Phase 4 fake-port/CAS 与 Phase 5 resource-contract 定向测试分别通过;既有 scaffold 已完成追溯审计 | 冻结 contract/session/Artifact HEAD,供所有专项 rebase |
| I1 Extension dependency | Extension-M0 owner | `package.json`、`package-lock.json` | I0 dependency HEAD 已记录,依赖版本/许可证/lockfile diff 已审阅 | 交出唯一 dependency HEAD |
| I2 Workspace/Security production integration | WorkspaceSecurity-Phase5 owner | `agent-loop.ts`、`execution-env.ts`、`tool-context.ts`、`tool-authorization.ts`、`tools/tool-support.ts`、stdlib tool 接线、controller、ledger/storage session 与 `storage/paths.ts` 接线、CLI/TUI security surface | I1 handoff + WorkspaceSecurity-Phase0–4 独占实现与真实 adapter tests | 交出 WorkspaceSecurity-M5 产品闭环基线 |
| I3 Extension production integration | Extension-M6 owner | tool registry/authorization/controller、CLI/TUI、settings/paths、`src/index.ts` | I1、I2 + Extension-M1–Extension-M5 独占实现 | 交出 Extension-M6 composition baseline |
| I4 Plan/Context production integration | Plan/Context/Compaction/Memory 专项集成 owner | agent-loop/controller、models/models-store、CLI/TUI、`src/index.ts` | I3 + Runtime Phase 6 contract + 专项对应行为门禁 | 交出 model/plan/context behavior baseline |
| I5 Orchestrator/Verification integration | Runtime Phase 7–8 owner | `agent.ts`、agent-loop/controller、Artifact/Episode gate、verification runner、经审阅的 browser 依赖与 exports | I4 + Phase 7 独占 reducer/budget tests + Phase 8 独占 verifier/fake-port tests + WorkspaceSecurity-Phase7 verification adapter | 交出 Runtime-M1 candidate baseline |
| I6 Control Plane/final client composition | Runtime Phase 10 owner | CLI/controller/TUI facade、daemon composition root、change-proposal service 与 forge adapter 接线 | I5;Phase 9 可在独占目录并行,生产 advertise 仍受 composition receipt 限制 | 交出 Runtime-M3 headless baseline |
| I7 Enterprise/telemetry composition | Runtime Phase 11 owner;安全专项只交 adapter | daemon composition root 的 telemetry/managed-policy/executor/credential/forge/human-gate adapter 注册与 composition matrix 更新 | I6 + Runtime-M2 handoff + WorkspaceSecurity-Phase8 + Extension-M7 | 交出 Runtime-M4 最终 baseline |

任何窗口需要修改表外共享路径或改变顺序时,先更新本表和受影响专项计划,再创建实现 PR。不得让多个长期分支各自修改 controller/CLI/TUI 后以自动冲突选择合并;最终 composition root owner 始终是 I6/I7 的 Runtime owner。

## 1. 审查快照与证据边界

本节记录的是 2026-07-22 对本机 checkout 的只读快照,没有执行 fetch/pull,因此只证明本计划实际审阅过的源码版本,不声称它们仍是上游远端最新提交。`00-reference.md` 以内容摘要固定,四个外部仓库以 commit 固定;后续移植 PR 必须重新核验当前上游与许可证。

| 仓库 | 审查快照 | 工作区状态 | 许可证取样 | 本计划主要参考 |
|---|---|---|---|---|
| RunLedger | `feat/agent-loop-resurrect@65f905452195e034c99fa5ac560a7e23a822f052` | 主工作区已有文档修改/未跟踪文件;审阅未把这些文件视为已完成实现 | `package.json`:MIT | 当前代码、Phase 0 前置 scaffold 与缺口基线 |
| `runtime/00-reference.md` | `sha256:2de7660e6726729deacbb320b670863eb5518760b4ab2294d3e7cb5655894428`(838 行) | 本地未跟踪设计输入 | 仓库内设计输入,不单独授权源码复制 | 11 类问题、总体架构、执行闭环、硬约束与推荐落地顺序 |
| codex | `main@0b175e6439a8608ba7726ee153fd8590619e8f34` | 仅用户未跟踪 `codex-rs/WEBSOCKET_PROXY_ISSUES.md` | 根 `LICENSE`:Apache-2.0 | 权限、sandbox、control plane、延迟工具、MCP/Skill/Plugin、多 Agent、分页历史与 fork lineage |
| pi | `main@3f1762cc7d3af39898aa5d21891335935011287f` | 干净 | 根 `LICENSE`:MIT | AgentHarness、Session、Compaction、生命周期、本地 RPC |
| grok-build | `main@c68e39f60462f28d9be5e683d9cbe2c57b1a5027` | 干净 | 根 `LICENSE`:Apache-2.0 | actor、workspace/checkpoint、permission、shell policy、有界 subagent |
| claude-code-bun | `main@73338f21dc166ac13303d24f3fe671a52bac745d` | 干净;仓库自述为 reverse-engineered/decompiled,且部分模块为 stub 或默认关闭 | 当前 checkout 无根 `LICENSE`;README 仅链接远端许可证 | worktree、session restore、memory、成本、telemetry、graceful shutdown 的行为样本 |

这些快照是设计取样,不是依赖锁定。当前计划只采用机制与拒绝边界,不授权直接复制源码。真正移植某一机制前,仍需在对应 PR 中重新核对上游当前版本、逐文件许可证/NOTICE、行为测试与 RunLedger 的 TypeScript 约束;`claude-code-bun` 既不是官方 Claude Code 契约真源,当前 checkout 的根许可证也无法本地确认,未补齐可验证授权前只能作行为研究,不得复制源码或据此宣称官方 Claude Code 的当前行为。

### 1.1 codex:采用机制与拒绝边界

关键证据:

- `codex-rs/protocol/src/{protocol,models,permissions}.rs`、`codex-rs/core/src/config/permissions.rs`:结构化 permission profile 与 filesystem deny。
- `codex-rs/tools/src/tool_executor.rs`、`codex-rs/core/src/tools/{spec_plan,registry}.rs`:tool exposure、model-visible spec 与 executable registry 的组合。
- `codex-rs/sandboxing/src/manager.rs`、`codex-rs/core/src/tools/{orchestrator,sandboxing,registry,router,parallel}.rs`:approval、sandbox 与 tool execution 编排。
- `codex-rs/execpolicy/src/{decision,policy}.rs`、`codex-rs/core/src/exec_policy.rs`:`allow/prompt/forbidden` 合并和命令审批。
- `codex-rs/rollout/src/recorder.rs`、`codex-rs/thread-store/src/{store,live_thread}.rs`、`codex-rs/core/src/thread_manager.rs`:session writer、fork、flush/shutdown API 与有序关闭;不提供 fsync durability 证明。
- `codex-rs/thread-store/src/local/{thread_history,thread_history_materialization,rollout_lineage}.rs`、`codex-rs/rollout/src/rollout_reference_index.rs`:分页/物化历史、投影 checkpoint、fork lineage 与引用感知删除。
- `codex-rs/app-server-protocol/src/protocol/current/`、`codex-rs/app-server/src/request_processors/`:headless thread/turn/item API、correlation 与分页/订阅;`expected_turn_id` 当前只约束 steer,不是通用 revision CAS。
- `codex-rs/app-server/src/connection_rpc_gate.rs`、`message_processor.rs`:close gate、drain background task 与 shutdown ordering。
- `codex-rs/codex-mcp/src/`、`codex-rs/core-skills/src/`、`codex-rs/core-plugins/src/`:资源发现、延迟暴露、安装 staging 与配置优先级。
- `codex-rs/core/src/hook_runtime.rs`、`codex-rs/models-manager/src/{manager,model_info,cache}.rs`、`codex-rs/core/src/context_manager/{history,updates,normalize}.rs`:typed hook lifecycle、模型 metadata/cache 与 history normalization。
- `codex-rs/core/src/session/turn.rs::comp_hash_changed`、`codex-rs/core/src/session/mod.rs::replace_compacted_history`、`codex-rs/core/src/compact_remote.rs`、`codex-rs/core/src/session/rollout_reconstruction.rs`、`codex-rs/core/tests/suite/compact_resume_fork.rs`:compatibility hash、replacement-history 安装、只重放后缀的 compaction resume/fork,以及降级恢复边界。
- `codex-rs/core/src/agent/`、`codex-rs/agent-graph-store/src/`:depth bound、total concurrency/residency bound、durable parent/child edge 与 residency；总并发约束独立于递归深度。
- `codex-rs/app-server-transport/src/transport/`、`codex-rs/app-server-transport/src/transport/auth.rs`、`codex-rs/app-server/src/request_processors/thread_lifecycle.rs`:bounded input queue/overload、UDS/WS 启动与 transport-level bearer auth 约束、idle thread unload/reload 时序;现有 token claim 不包含 principal/tenant。
- `codex-rs/core/src/rollout_budget.rs`、`codex-rs/core/src/agent/{registry,control}.rs`、`codex-rs/agent-graph-store/src/`:root-tree token budget、分层 Agent registry/limiter/residency 与 durable parent/child edge。
- `codex-rs/core/src/tasks/review.rs::{start_review_conversation,parse_review_output_event}`、`codex-rs/core/src/guardian/{review,approval_request}.rs`:模型 review、Guardian fail-closed 与截断 approval evidence 的边界。
- `codex-rs/config/src/loader/mod.rs::load_config_layers_state`、`codex-rs/config/src/requirements_layers/stack.rs::compose_requirements`、`codex-rs/config/src/config_requirements.rs::ConfigRequirements`:managed config 来源归因、字段级约束合并与违规值 fallback。
- `codex-rs/otel/src/events/session_telemetry.rs::user_prompt`、`codex-rs/rollout-trace/src/{writer,tool_dispatch,inference,compaction}.rs`、`codex-rs/rollout-trace/src/reducer/`:typed telemetry、可保存 request/response/tool/reasoning 全内容的 raw trace,以及可重建 reducer/projection 分离。

采用:

- 权限独立于 prompt,`deny > ask > allow`,执行升级不得丢失 deny-read。
- tool schema 与 executable runtime 同一注册单元,`direct/deferred/direct-model-only/hidden` 按需暴露;`direct-model-only` 保留 Codex 中“root model 可见、nested Code Mode 不可见”的语义,即使 RunLedger 首版没有 Code Mode 也不得在解析时静默折叠。RunLedger 在此基础上把 duplicate name 强化为启动时 fail closed。
- session writer 单一所有者、显式 close/drain 次序、fork 前 flush durable history 并按显式 cut 构建上下文、关闭 RPC gate 后再排空 handler;RunLedger 另行实现真正的 durable flush barrier,且首版 fork 仍只接受 stable turn boundary。
- canonical rollout 与可重建的 SQLite projection 分离;分页历史保留继承 lineage,删除前检查 fork 引用。
- compaction 把 replacement history 作为独立 checkpoint,恢复时选择最新可存活 checkpoint 并只正向 replay suffix;RunLedger 将 replacement body 外置为有 digest/previous-link 的 Artifact,先 durable commit replacement+invariant+expected revision,再以 CAS 切换 live projection,不从 UI delta 猜测历史。
- MCP/Skill/Plugin 先汇总 provenance,再解析 immutable winner;安装使用 staging 和原子切换。
- MCP snapshot generation/cache ticket、Skill namespace precedence、Plugin staging/atomic replace 与 awaited typed hook lifecycle。
- control plane 的 session/turn/item 分层、请求 correlation 和分页/订阅模型;RunLedger 把 expected revision/idempotency 扩展到所有 mutation。
- sandbox 的 managed/disabled/external policy 与 effective enforcement 分离,additional permission 先 normalize/intersect/merge;RunLedger 只采用数据分层与单调收窄,不沿用不可用时的降级。
- app-server transport 的 bounded input queue、typed overload、UDS stale-path/startup-lock/mode、非 loopback WebSocket/Origin 拒绝和 transport-level bearer auth;RunLedger 另补 durable cursor、consumer checkpoint,并把 authenticated principal/tenant 绑定到每个 mutation、session 与 evidence。
- Agent depth 与总并发/驻留限制只作为预算输入;RunLedger 的 depth、children、total-agent 与 root budget 必须同时硬限制,不能把 concurrency bound 误写成递归有界。
- Guardian 在 timeout、会话失败或解析失败时阻止执行的方向可作为自动预审参考;任何模型 review/Guardian 输出都只形成 candidate evidence,仍需独立 verifier 或人工 gate。
- managed config 借鉴 source attribution 和逐字段单调收窄;每次层合并、违规值归一化或 required-default fallback 都必须形成 durable normalization receipt,无法证明 effective value 时 fail closed。

拒绝照搬:

- Codex 的历史投影仍会跳过 rejected rollout line;append 只会在末字节不是 LF 时补换行,不会验证、截断或修复 malformed tail/record。其日志也没有 RunLedger 所需的完整 sequence/hash chain/payload digest,不能作为 current 真源。
- Codex release build 对 duplicate tool name 记录并跳过,不保证启动失败;RunLedger 不能沿用该降级。
- Codex append/flush/shutdown 的成功语义不能证明 fsync durability;RunLedger 的 tool terminal/permission/stop barrier 必须自行定义并故障注入。
- Codex 可在活跃 turn 物化 synthetic `TurnAborted` 后 fork;RunLedger 首版只允许已经持久且可验证的 stable turn boundary。
- residency 会卸载 idle resident,而 interrupted Agent 可被视为不可重载并在 eviction 后永久丢失;RunLedger eviction 必须有 durable paused/partial terminal 或可验证 rehydrate 路径,不得把 resident 消失当作完成。
- `SessionMeta` 的 cwd/GitInfo 只是观测,不是每次工具执行的 workspace lease 证明。
- rollback 只回退模型历史,没有与文件状态、artifact 和 event position 原子绑定。
- `comp_hash_changed` 在任一 compatibility hash 缺失时不会判定变化;RunLedger 必须把缺失的兼容证明视为 incompatible,拒绝原 session 切模或要求显式 fork,不能把“未检测到变化”当作兼容。
- `replace_compacted_history` 先切换内存历史,再分别持久化 Compacted、WorldState 与 TurnContext,不是原子 checkpoint;RunLedger 不得在 durable commit 前改变 live projection。
- rollout reconstruction 对非法 window UUID、损坏 world-state、patch-without-full 与 legacy missing replacement 会 warning 后降级;RunLedger current 必须停止恢复并进入 corrupted/forensic salvage,不得猜测补全。
- Codex Plugin manifest 已有 `developer_name` 和声明型 capabilities,但 Tool/Plugin/MCP 尚缺统一绑定的已验证 publisher identity、content/config digest、signature、可执行 capability grant 与 trust receipt;现有 metadata 不能直接作为 RunLedger 授权。
- MCP fingerprint/cache identity 不等于 publisher signature 或 trust receipt;Hook 可执行命令、改写输入和注入 context,必须另过 Gateway/sandbox/taint 边界。
- MCP server/tool 自报的 `read_only_hint`、其他 annotation 或 remembered approval 都不是当前授权事实;remembered decision 必须重新绑定当前 policy/Hook、server config、tool identity、publisher、digest 与 adapter generation。缺少显式安全 client factory/authorization adapter 时,生产启动必须失败。
- Skill catalog 的 metadata list 与 body/assets read 必须绑定同一 immutable generation;正文变化产生新 generation,旧 snapshot 不得读到新内容,所有注入路径都执行统一的有界内容限制。Hook runner 自身及其改写/输出也必须经过 Gateway/sandbox,采用硬字节上限、脱敏和只保留分类/digest 的受限诊断。
- Codex durable graph 主要表达 parent/child 与 residency/open/closed,不是带 task/workspace/capability/budget/partial-artifact contract 的治理 DAG。
- approval request 虽携带 call/approval/turn 标识,active waiter 最终主要按 effective approval id 解析;RunLedger 必须使用 authority/tenant/session/runtime generation/turn/toolCall/approval/request digest/decision revision 的复合绑定,拒绝 stale、duplicate 与 cross-turn response。
- sandbox backend 选择在平台实现不可用时可能退到 `None`,`External` 也只是外部强制声明;RunLedger 必须验证实际 backend attestation/execution receipt,不能把 policy label 当作 enforcement。
- transport 虽有 capability token/HS256 bearer,但 claim 与 transport event 没有可供 Runtime 授权的 subject/tenant 绑定;它也没有 RunLedger 所需的 durable event cursor、原子 consumer checkpoint 或 UDS peer-credential tenant binding。UDS 文件 mode、loopback 检查或 bearer 通过都不能单独替代 mutation/session/evidence 上的已认证 principal。
- token budget、Guardian review 和 attestation 都不能替代全维度 BudgetGuard、独立 verifier 和 Episode Manifest。
- review parser 会把普通文本或无法验证的伪 JSON 包装为模型 review 结果;RunLedger 只能把它记录为 finding candidate/`inconclusive`,不得签发 trusted pass。Guardian action evidence 一旦被截断也只能 deny/转人工,不得自动批准。
- telemetry 的部分模式和 rollout trace 会记录完整 prompt、request/response、tool arguments/output 与 readable reasoning;RunLedger 默认只能记录脱敏 metadata,raw bundle 必须进入独立高敏 forensic store,默认关闭且具有单独授权、加密、tenant isolation、retention 与审计。
- managed config 的 required-default fallback 不能静默修复违规输入;没有 durable source/effective/normalization receipt 时,低优先级本地值和 fallback 都不得继续驱动安全决策。

### 1.2 pi:采用机制与拒绝边界

关键证据:

- `packages/agent/src/harness/{agent-harness,types}.ts`:operation phase、save point、资源快照、listener settlement 与 `prepareNextTurn` 重建。
- `packages/agent/src/{agent-loop,agent,types}.ts`:tool batch、hook、queue、transform context 和 stop/next-turn 语义,以及默认 parallel、sequential-tool 整批降为串行、并行批次的 preflight/execute/terminal/result ordering。
- `packages/agent/src/harness/env/nodejs.ts`:Node ExecutionEnv 的绝对路径解析与文件/shell 操作,用于界定不能照搬的 workspace 边界。
- `packages/agent/src/harness/session/{session,jsonl-storage}.ts`:current header、leaf/tree path 与 LF JSONL;未知 entry type/payload 仍存在 cast,不能称为完整 exact schema。
- `packages/storage/sqlite-node/src/sqlite/repo.ts::{configureSqliteDatabase,SqliteSessionRepo.fork}`、`migrations/001_initial.sql`、`storage/index.ts::{SqliteSessionStorage.create,appendEntry,decodeEntryRows,getEntry,findEntries}`:SQLite backend 使用 `WAL`、`synchronous=FULL`、事务内 sequence/entry/active leaf/branch/materialized projection 更新和 append cache rollback,同时暴露 create/fork 原子性与坏 row 边界。
- `packages/agent/test/harness/sqlite-migrations.test.ts`:覆盖 migration、active leaf、branch/materialized state、分页、append rollback 与 summary projection,是 storage contract/fault fixture 的直接参考。
- `packages/agent/src/harness/compaction/`:cut point、split turn、retained tail、旧摘要链和 branch summary。
- `packages/ai/src/api/transform-messages.ts`:跨 provider/model 的 image downgrade、thinking/signature 处理、tool-call ID 规范化与 orphan tool-result 补齐,属于发送前 best-effort 消息转换。
- `packages/ai/src/{types,models,models-store}.ts`、`packages/ai/src/providers/all.ts`:pi-ai 差异同步、provider/model catalog 与兼容字段的上游真源。
- `packages/coding-agent/src/core/session-manager.ts`:legacy JSONL 解析/恢复边界;多处坏行跳过只能作为兼容性反例。
- `packages/coding-agent/src/core/extensions/loader.ts`:通过 `jiti` 在主进程加载扩展的实现,用于界定资源 sandbox/trust 缺口。
- `packages/coding-agent/src/core/{skills,trust-manager}.ts`、`packages/coding-agent/src/core/extensions/{loader,runner}.ts`:Skill discovery/provenance/model visibility、project trust surface、Hook reducer ordering 与旧 runtime context 失效。
- `packages/coding-agent/docs/usage.md`、`packages/agent/docs/{agent-harness,durable-harness}.md`:pi 明确非目标与 durable recovery 的设计/实现边界。
- `packages/coding-agent/src/core/{model-resolver,agent-session}.ts`:模型查找、认证与切换流程,用于区分 resolver 与 session-level compatibility gate。
- `packages/coding-agent/src/core/{agent-session,agent-session-runtime,sdk}.ts`:retry、auto-compaction、session replacement teardown/rebind。
- `packages/ai/src/utils/retry.ts`、`packages/ai/src/api/openai-codex-responses.ts`:通用 transient classifier 与 provider adapter 自有 retry 的分层;`StreamOptions.maxRetries` 不能等同于应用级 durable retry journal。
- `packages/coding-agent/src/modes/rpc/{rpc-types,rpc-mode,rpc-client,jsonl}.ts`:本地 JSONL RPC、prompt preflight accepted ack、backpressure 与 pending rejection;该 ack 不是 transport/protocol handshake。
- `packages/server/{README.md,src/supervisor.ts}`:experimental server 与进程 supervisor 状态恢复,用于界定不能据此宣称 durable daemon resume。

采用:

- 借鉴 provider-request snapshot/save point 与 `prepareNextTurn` 的安全重建点:已经发出的 provider request 保持不变,model/tools/resources/system prompt/config 只有在 durable turn save-point 后才作用于下一次 provider request。若 RunLedger 需要把多个 request 合成更大的不可变 operation,必须作为显式且更严格的本地状态机规则,不能归因于 pi。
- 借鉴 pi durable-harness 设计中“宿主先注册不可序列化依赖,再 reduce durable state 并 reconcile”的顺序,但 RunLedger 必须通过显式异步 `open/restore` factory 实现;构造器不得隐式启动异步恢复或在依赖校验前返回可变 handle。
- AgentHarness 的 `message_end` 会先 await append 再通知后续 listener;RunLedger 进一步区分 append accepted cursor 与关键边界 fsync/flush 后的 `DurableEventReceipt`,且不能沿用 coding-agent 先 extension/listener 后 SessionManager append 的相反顺序。
- append-only leaf marker、compaction-aware context、split-turn summary、单次 overflow compact-and-retry。
- 借鉴 SQLite backend 的 durability 配置、事务内序号分配及 canonical entry 与可重建 projection 分离;RunLedger 先把这些语义固化为 backend-neutral Event Store contract,不能把“换成 SQLite”本身当作完整性证明。
- transient classifier、可取消的应用级 backoff 与 provider adapter 自有 retry 可作为错误分类和策略输入;RunLedger 仍由 Orchestrator 记录 durable retry intent、attempt、idempotency 与终态,不能让 adapter 的进程内 retry 代替 session 事实。
- 借鉴 `transformMessages` 对目标 adapter 的消息形状归一化与不兼容 reasoning signature 丢弃,但只把结果记录为转换 receipt/diagnostic,不把转换成功视为 session 状态兼容。
- session replacement 成功后使旧 context/generation 永久失效;RunLedger 不沿用 pi 的 teardown-first 顺序,而是先 prepare/validate 候选 runtime,再以 durable transition 和 fencing 原子切换 authority。
- 写端 LF-delimited JSONL、命令 correlation、stdout backpressure、进程退出时拒绝全部 pending request;pi 读取端会接受空行和无尾 LF,不能作为 RunLedger strict framing/torn-tail 证明。
- Skill discovery 的 ignore/停止下探、metadata/model visibility、来源诊断,以及 extension reload 后旧 runtime context 失效、same-role replacement、tool-result patch、tool-call short-circuit 和 system-prompt/input transform 的有序 reducer 语义。
- parallel tool batch 的串行 preflight、并发 execute、terminal completion order 与 source-order result message 可作为确定性测试参考;RunLedger 保持默认 sequential,只有能力 claim 与副作用独立性已证明时才 opt in parallel。
- core `Agent` 会 await listener,但 Harness 可先把内部 phase 设为 idle 再等待 subscriber settlement;RunLedger 必须把 loop terminal、subscriber settled、externally idle 与 next-mutation-allowed 分开。

拒绝照搬:

- Node ExecutionEnv 和 coding-agent 路径工具允许任意绝对路径,没有 worktree identity、containment 与 capability gateway。
- 新版 harness session reader 对 malformed JSON/base shape 会 fail closed,但 `loadJsonlStorage()` 会过滤空行,entry payload 仍主要依赖 cast,也没有完整验证 duplicate id、parent existence 与 tool/message payload;legacy coding-agent SessionManager 才会进一步跳过坏行。RunLedger 采用 strict framing、逐事件 exact schema 和跨 entry invariant,不能把三条读取路径笼统描述为同一种恢复语义。
- harness append 被 await 不等于落盘 durability,不能直接作为 tool terminal/stop barrier。
- `EventStream.result()`、`pendingSessionWrites`、queue、retry attempt/backoff 与 operation phase 都是进程内 settlement/control state,不是可跨崩溃证明的 durable truth。
- harness fork 的 path-to-root/compaction 选择可作树上下文参考,但没有 stable-turn gate、atomic lineage receipt、hash identity 或 workspace 一致性。
- SQLite append 的单事务更新值得采用,但 `SqliteSessionStorage.create()` 的 session/sequence/materialized 初始化未包在同一事务,repo fork 又逐 entry 独立提交;中途失败可能留下半初始化或部分 fork。普通读取还会跳过 malformed row,且 schema 没有 parent FK、hash chain、writer lease/fencing、idempotency key、effect intent/commit 与 durable receipt,因此不能直接作为 current canonical backend。
- Extension 使用 `jiti` 在主进程直接加载并可 exec,不满足 sandbox、digest 与 capability 要求。
- Hook 修改 tool input 后,pi 明确不会替调用方重新完成最终 schema/path/security validation;RunLedger 必须对更新后的输入重新执行 exact schema、canonicalization、capability/workspace/resource claim 派生和 Gateway/sandbox 授权,不能复用改写前 receipt。
- pi 明确不内建 MCP、sub-agent、permission popup、Plan Mode、Todo 或 background Bash;它只能为 extension seam 提供参考,不能作为这些能力的 parity 或验收真源。
- Skill 冲突 first-wins 与基于路径的 project trust 不能形成 publisher/capability receipt;RunLedger 必须使用 exact identity、digest、优先级诊断和独立 trust/approval。
- TUI 仍持有 retry/compaction/bash/queue 的部分流程状态,不能成为多客户端真源。
- RPC 缺 protocol handshake、cursor replay、idempotency、typed error、auth 和 workspace envelope。
- RPC server JSON parse 后仍直接 cast command,每行以未 await 的 handler 并发进入,缺 runtime schema validation、authoritative mutation serialization/revision critical section、durable acceptance 与统一 server-side pending cleanup;session replacement 创建新 runtime 失败也没有事务性回退旧 runtime。
- coding-agent 的 replacement 会先 teardown/dispose 旧 runtime 再创建新 runtime;factory/open 失败时既不能恢复旧 authority,也没有 durable terminal/rollback receipt。RunLedger 必须 prepare-before-teardown,并对“切换 commit 前失败”与“commit 后失败”分别给出可恢复终态。
- durable queue、pending write、operation/turn/tool crash journal 和 provider-stream resume 在 pi Harness 中仍主要是设计或 future work;RunLedger Phase 1/7 的 strict recovery 不能标成已从 pi 移植。
- 应用级 retry attempt、AbortController 与 backoff 仍是进程内状态;provider adapter 也可在自身内部 retry,但两者都没有 durable intent、跨重启 attempt identity 或 exactly-once side-effect proof,不能直接进入 Runtime 的“已恢复/已完成”投影。
- 未完成 tool call 只能先记录 interrupted/uncertain 并暂停;仅当工具显式声明 idempotent/retry-safe、原请求身份和副作用结果已 reconcile 时才允许自动重试。`packages/server` 仍是 experimental,重启时把 online/starting 投影为 stopped 不能作为 durable daemon resume 证据。
- pi 已有发送前 best-effort 消息兼容转换,但 Harness/coding-agent 的 `setModel` 仍主要记录 model change、检查 auth/重夹 thinking level,没有冻结 tool schema、reasoning state、compaction/context invariant、adapter state 与 regression profile 的 session-level compatibility gate;因此不能据此直接支持任意 session 内切换。

### 1.3 grok-build:采用机制与拒绝边界

关键证据:

- `crates/codegen/xai-grok-agent/src/{agent,builder}.rs`。
- `crates/codegen/xai-grok-shell/src/session/{acp_session,persistence}.rs`、`crates/codegen/xai-grok-shell/src/session/acp_session_impl/{run_loop,turn,tool_calls,turn_end,goal_support}.rs`。
- `crates/codegen/xai-grok-shell/src/session/storage/jsonl/mod.rs`、`crates/codegen/xai-grok-shell/src/session/fork.rs`。
- `crates/codegen/xai-grok-shell/src/session/goal_tracker.rs`、`crates/codegen/xai-grok-shell/src/agent/subagent/{mod,handle_request}.rs`:未知 Goal 状态、orphan reconciliation、goal-scoped token budget/high-water 与 cancel/max-turn partial text。
- `crates/codegen/xai-grok-shell/src/session/goal_orchestrator.rs`:由模型通过 `update_goal` 驱动的 orchestration,用于界定不能作为确定性 Goal gate 真源。
- `crates/codegen/xai-grok-workspace/src/session/{checkpoint,checkpoint_store}.rs`、`crates/codegen/xai-grok-workspace/src/worktree/mod.rs`。
- `crates/codegen/xai-grok-workspace/src/{capability,handle}.rs`、`crates/codegen/xai-grok-workspace/src/session/tool_config.rs`、`crates/codegen/xai-grok-tools/src/types/tool.rs`:child≤parent capability partial order、tool filtering 与 `Other` kind。
- `crates/codegen/xai-fast-worktree/src/{db/mod,api}.rs`:WorktreeRecord、liveness/GC 与 snapshot/delete primitive;`crates/codegen/xai-grok-workspace/src/worktree/mod.rs`、`crates/codegen/xai-grok-shell/src/agent/subagent/{handle_request,mod}.rs`:capture-transfer-verify、persist-ref-before-delete 的生产调用顺序与销毁前复核。
- `crates/codegen/xai-grok-workspace/src/permission/{types,policy,bash_command_splitting,shell_access,resolution}.rs`。
- `crates/codegen/xai-grok-config/src/signed_policy.rs`、`crates/codegen/xai-grok-workspace/src/folder_trust.rs`:签名策略 envelope 与 folder trust,同时用于记录默认未激活和 dev-build 短路边界。
- `crates/codegen/xai-grok-agent/src/plugins/{trust,manifest,registry}.rs`:canonical path containment、manifest registry 与只按路径记录的 `TrustStore`。
- `crates/common/xai-tool-protocol/src/{capabilities,handshake,registration,envelope,session_event,registry_error}.rs`:`HelloMsg/HelloAckMsg`、ToolId、session binding、generation CAS、sequence envelope、stream/cancel/并发能力和 typed collision/stale-generation error。
- `crates/codegen/xai-grok-agent/src/config.rs::AgentDefinition::browser_use`、`crates/codegen/xai-grok-shell/src/extensions/pr.rs`:prompt-level browser 配置与只读 PR status/view/merge-queue 扩展,用于界定不能据此宣称 Browser verifier、Draft PR provider 或 HumanGate 已实现。
- `crates/codegen/xai-grok-telemetry/src/config.rs::TelemetryMode`、`crates/codegen/xai-grok-telemetry/src/external/config.rs::{ExternalOtelConfig,ContentGates}`、`crates/codegen/xai-grok-telemetry/src/external/{schema,redact,providers}.rs`:默认关闭、metadata-only、内容双重 opt-in、closed allowlist 与 redaction。
- `crates/codegen/xai-grok-sandbox/src/{lib,profiles}.rs`。
- `crates/codegen/xai-grok-tools/src/implementations/grok_build/task/`。
- `crates/common/xai-tool-runtime/src/{tool,dispatch}.rs`、`crates/codegen/xai-grok-shell/src/session/acp_session_impl/tool_calls.rs`:tool `Progress* + exactly one Terminal` 协议、preflight/dispatch 与 path-lock 并发选择。
- `crates/codegen/xai-grok-tools/src/implementations/grok_build/web_fetch/artifact.rs`、`crates/codegen/xai-grok-shell/src/upload/manifest.rs`:临时写+file sync+noreplace 和 `Enqueued` 被误计为 fully uploaded 的完成边界反例。
- `crates/codegen/xai-chat-state/src/actor/mod.rs`、`crates/codegen/xai-chat-state/src/persistence.rs`、`crates/codegen/xai-chat-state/src/actor/mutations.rs`:独占 actor、append/replace/flush 与 dangling-tool repair。
- `crates/codegen/xai-grok-shell/src/{agent,leader}/server.rs`、`crates/codegen/xai-grok-workspace/src/daemonize.rs`:authenticated WebSocket、多客户端路由、进程内 session residency、pidfile single-instance/takeover 与 shutdown drain;用于界定连接期服务能力和 durable daemon recovery 的差异。

采用:

- Session command/event dispatch 的串行入口、临时文件加 rename 的 crash-atomic replacement 思路,以及 checkpoint mirror/cache rehydrate 的结构;后者尚未证明会重灌所有 live tracker,写入错误也未稳定传到调用方。RunLedger 另行收敛为唯一 EventWriter、单一 reducer 真源和显式 live projection restore,并定义 file/parent-directory durability barrier。
- worktree 持久状态与 liveness/GC 的 fresh row/`last_accessed_at`、creator PID、live process CWD 重检;RunLedger 另补 session owner、lease revision 与 fencing token,生产 cleanup 不开放绕过 fresh recheck 的 `force`。
- subagent dispose 在删除前 capture/transfer/verify snapshot ref,且要求调用方先持久化 ref;该顺序只作为显式 dispose 参考。现有 metadata 持久化只是直接写文件,没有 temp+rename、fsync 或与 terminal state 的原子提交,因此 RunLedger 必须先取得 durable commit receipt 并把 snapshot ref 与 terminal state 绑定后才能 dispose,也不能推定普通 expired GC 会自动保全工作状态。
- capability-mode 工具分类/过滤、child mode 不高于 parent 的粗粒度偏序和 `deny > ask > allow` policy resolution;RunLedger 另行实现逐 capability 的 parent-grant subset receipt。
- signed policy 的 principal/expiry/key-revision envelope 形状与 Tool Registry 的 canonical identity、`HelloMsg/HelloAckMsg` handshake、session binding、generation CAS、sequence envelope、collision/stale-generation typed error;RunLedger 另补可验证 trust root、publisher/signature、content digest 和细粒度 capability receipt。
- Plugin locator 先 canonicalize 并验证 containment;这只证明解析目标一致,不签发信任。Telemetry 借鉴 default-off、metadata-only、内容与 exporter 双重 opt-in、closed field allowlist 和 redaction,再由每个 production composition 的 `TelemetryManifest` 收窄。
- shell command splitting、redirect/cwd/symlink 检查。
- 工具调用先 prepare/preflight 再 dispatch、写同一路径时串行的两阶段结构,以及 policy deny、user reject、cancel、follow-up 和 channel failure 的不同终态;RunLedger 使用结构化 resource claims 和 durable receipt,不按参数猜 path。
- tool stream 的 `Progress* + exactly one Terminal` invariant,缺 terminal 形成稳定错误;RunLedger terminal event 还必须 durable 后才向后推进。
- web-fetch Artifact 的 allocation lock、总量预算、temp+file sync+noreplace 写入形状;RunLedger 另加 CAS digest、provenance、parent-directory sync 与 visible commit event。
- ChatState 独占 actor 与 dangling-tool repair 可作为 reducer 输入参考;RunLedger 保持单一 canonical event log,不复制 chat/update/sidecar 多轨真源。
- subagent depth 上限、cancel/max-turn 时尽量返回最后 assistant 文本;未知 Goal 状态降为 paused,orphan subagent 则标 cancelled。
- authenticated WebSocket、多客户端 request 路由、pidfile single-instance/takeover 与 shutdown drain 可作为 Phase 10 的服务生命周期和竞态测试参考;session 进程内存活只表示连接重建,不能替代 current Event Store 的跨进程 restore。

拒绝照搬:

- JSONL append 只做普通 flush 且读取仍会跳过坏行;文件持久化也并非 strict single writer,同步重写可绕过 persistence actor并争用同一个固定 `<path>.tmp`,因此并发时可能覆盖、tmp 互扰或 rename 失败;`sync_session_files` 还会吞掉 `sync_all` 错误。checkpoint 私有写函数会返回 file sync 错误,但外层 `persist()` 捕获后只 warning 并继续,父目录 sync 也是 best-effort;这不构成对调用方可见的 durability failure。RunLedger 只允许唯一 EventWriter,并要求 file、rename 与 parent-directory durability 结果进入失败 receipt。
- Goal orchestrator 仍由模型直接调用 `update_goal`;GoalTracker、planner/classifier/skeptic 只能作为状态记录或 evidence capture 参考,不能成为 build/test/review/completion gate 真源。
- signed policy 的可信公钥集在当前 checkout 默认为空,`verification_active()` 只有非空时才启用;这是一条 dark capability,不能作为当前 production enforcement 证据。folder trust 在 local/dev build 还会自动信任且不 gate repo-local hooks/plugins/MCP/LSP,必须作为明确反例而不是整体安全基线。
- Plugin `TrustStore` 只按 canonical path 记忆信任,home config 还可自动信任;记录没有绑定 publisher/signature/version/content digest,内容变化不会自然使旧 trust stale,不能作为资源供应链 receipt。
- `ToolCapabilities`/`ToolScope` 是工具端自报 annotation,缺省 scope 还是 Read;它们只能进入不可信 discovery metadata,不能生成 CapabilityClaim、authorization decision 或 parent-grant subset 事实。
- `browser_use` 只是 Agent prompt 开关,PR extension 也只查询 status/view/merge queue;二者都不能替代 Phase 8 Browser evidence provider、Phase 10 Draft PR provider 或 Phase 10/11 HumanGateCoordinator。
- `ToolKind` 有 `Other`;已知 builtin 会回填 kind,external MCP/hub kindless 在受限 mode 已被删除,但 baseline/ad-hoc opaque/custom kindless 仍可保留。该粗粒度 mode filter 不能代替逐 capability、带 receipt 的 parent-grant subset enforcement。
- 任意已存在路径可作为 worktree,缺 canonical root、owner/session 绑定和跨进程 lease。
- 普通 expired GC 不 capture snapshot,且 reclaimability 不校验 session owner/lease;不能作为有证据保全的 cleanup。
- sandbox 行为不统一:Linux read-deny 与不可应用 custom profile 会 fail closed,但普通 built-in profile apply 失败可只 warning 后继续,worktree 失败也存在共享 workspace 降级;RunLedger 必须按 requested/effective backend receipt fail closed,不能把局部安全路径概括成整体 enforcement。
- 工具 prepare 是逐项进行且不是 batch all-or-none;后续 call 被用户拒绝时,此前 approved call 仍可 dispatch。`lock_path_for_args` 也只是单路径参数启发式;RunLedger parallel 必须先完成全批 preflight并用结构化 workspace/resource claim 证明独立性。
- policy deny、user reject、cancel 与 follow-up 的控制流不同,不能压成一个布尔 deny;permission channel 故障虽 fail closed,仍必须持久化明确 terminal receipt。
- checkpoint rewind 在 Git 回退失败后仍可能继续 filesystem 回退并形成 partial 状态,不能作为 event/workspace 原子恢复证明。
- grok partial result 是 best-effort assistant text,没有 ArtifactRef、integrity 或 verification status。
- upload manifest 会把 `Enqueued` 计入 `fully_uploaded`;RunLedger 必须区分 accepted/enqueued、durable、content-verified 与 externally acknowledged,任何非 terminal 状态都不能进入 Episode evidence 或 cleanup gate。
- chat history、updates 和 sidecar 构成多轨持久化,不能直接作为单一可重放真源;RunLedger 只允许 canonical events 驱动可丢弃 projection。
- Goal tracker 阶段过粗。grok 已有 root-goal token budget,并把 running/finished goal-scoped subagent marginal 计入单调 high-water,但采样、compaction 间增长与 crash 前未持久增量仍是 best-effort,也没有 USD/time/tool/network/storage/verification/agent 的 reserve/commit/refund。它可作为 Phase 7 token accounting 输入,不能代替确定性状态机、全维 BudgetGuard 与 Phase 11 cost reconciliation。
- agent/leader server 主要依赖 unbounded channel 和进程内 session residency;断线后 session 继续存活不等于 daemon 重启后 durable recovery,也没有证明 cursor replay、idempotent mutation、durable checkpoint 或 exactly-once side-effect reconciliation。RunLedger Phase 10 只能采用服务形状和生命周期测试,不能据此宣称 control-plane 完成。
- session replay 的 `find_latest_compaction_checkpoint`/`replay_to_prompt`/`persist_compaction_checkpoint` 可为 checkpoint 选择和 suffix replay 提供测试样本,但普通 JSONL reader 仍会跳过坏行;局部 checkpoint fail-closed 不能覆盖整个 session 真源的宽松读取。
- telemetry 尚缺 per-composition `TelemetryManifest`、SIEM delivery receipt 与 retention/legal-hold 证明;redaction 或 exporter opt-in 不能把 enqueued/export-attempted 冒充 externally acknowledged。

### 1.4 claude-code-bun:采用机制与拒绝边界

关键证据:

- `src/utils/worktree.ts`、`src/utils/{sessionStorage,sessionRestore}.ts`、`src/types/logs.ts`。
- `src/utils/json.ts`、`packages/builtin-tools/src/tools/AgentTool/{agentToolUtils,runAgent,resumeAgent}.ts`:JSONL 宽松解析、tool filtering、mode 继承与 worktree resume。
- `src/services/compact/`、`src/services/SessionMemory/`。
- `src/utils/permissions/`、`src/utils/sandbox/sandbox-adapter.ts`。
- `src/services/mcp/`、`src/utils/plugins/`、`src/skills/loadSkillsDir.ts`。
- `packages/builtin-tools/src/tools/AgentTool/` 与 `packages/builtin-tools/src/tools/AgentTool/built-in/verificationAgent.ts`。
- `src/cost-tracker.ts`、`src/utils/telemetry/`、`src/utils/gracefulShutdown.ts`。
- `src/utils/telemetry/betaSessionTracing.ts`、`src/utils/secureStorage/{index,plainTextStorage}.ts`:内容 tracing 与 Linux 明文凭据 fallback。
- `src/services/remoteManagedSettings/index.ts`、`src/services/remoteManagedSettings/securityCheck.tsx`、`src/services/teamMemorySync/{secretScanner,teamMemSecretGuard}.ts`:checksum/cache 形状、fail-open managed settings 与只覆盖 team-memory 内容的本地 secret guard。
- `src/services/skillLearning/{observationStore,promotion,skillLifecycle}.ts`、`scripts/defines.ts`:有状态观察、project-to-global 自动晋升、learned artifact 生命周期,以及当前 build 默认不启用 `SKILL_LEARNING`/`TEAMMEM` 的边界。
- `src/server/{server,sessionManager}.ts`、`src/daemon/{main,state}.ts`、`packages/remote-control-server/src/{index,store}.ts`、`packages/acp-link/src/server.ts`:stub server、进程 supervisor、普通 JSON PID state、in-memory remote store 与 requestId-only approval correlation 反例。
- `src/utils/fileHistory.ts`、`src/utils/config.ts`:tracked-file checkpoint/rewind 与默认开关/无界内存注释的实现状态冲突。

采用:

- worktree slug 校验、canonical main-repository root、stale cleanup 的 exact-name 筛选与 Git 检查失败、tracked dirty、unpushed commit 时拒删;以及 parentUuid conversation chain、session metadata/restore、compaction 与 memory 分服务。这些只作为恢复/防误删算法参考,不构成 owner/lease 完整性保证。
- permission rule、危险命令分类、sandbox adapter 分层。
- Agent fork/resume、memory snapshot、角色 profile、成本跟踪和 graceful shutdown。
- SessionMemory 对可用工具和唯一 memoryPath 做 deny-by-default 精确收窄;RunLedger 借鉴该最小写面,再增加 provenance/taint 与人工发布生命周期。
- team-memory secret scanner 只返回 rule id/label、不返回命中的 secret 原文,以及 learned artifact 的 archive/manifest/tombstone 形状可作为脱敏 finding 和可恢复资源生命周期的局部参考;两者都不能绕过独立 approval、trusted-base gate 或 Runtime Event/Artifact receipt。

拒绝照搬:

- 子 Agent 可重组工具并默认 `acceptEdits`;RunLedger 子权限必须是父权限严格子集。
- Agent tool filtering 会无条件保留 MCP tools,mode 可从 parent 的 bypass/acceptEdits/auto 继承,resume 也未重新执行原 denied-agent gate;必须由独立 subset/re-gating receipt 收窄。
- verification agent 仍依赖模型判断,不能代替可信基线上的独立验证。
- transcript parser 跳过 malformed line,write queue 超 1000 会丢最旧条目,append 无 fsync,读取异常可能被吞,环检测只返回 partial chain;它没有完整 sequence/hash chain,大输出也不是 CAS。
- stale cleanup 使用 `git status --porcelain -uno`,会把过期 worktree 的 untracked 文件视作可丢弃构建产物;RunLedger 的 checkpoint/cleanup 必须覆盖 untracked Artifact 与 owner/lease 复核,不能照搬该删除条件。
- worktree hook 返回路径缺 canonical/owner binding,remove 接受 caller 提供的 path/root/branch 且缺 durable owner/session/lease receipt;resume 在原 worktree 缺失时还可回退 parent cwd。RunLedger 必须禁止 fallback-to-shared-workspace 与未授权 remove target。
- sandbox 设置/初始化异常可退为 disabled,且 `allowUnsandboxedCommands` 默认 true,不满足 fail-closed。SessionMemory 的工具/path 授权本身是收窄的,真正缺口是自动内容更新没有用户 diff review、provenance/taint、持久 approval/revoke/publish 生命周期。
- tracing 可记录 prompt/tool/model 内容;Linux secure storage 也可能退化为 0600 明文。
- remote managed settings 的 fetch/timeout 路径明确 fail open,checksum/cache 也不能证明 authority、签名、版本优先级或 effective-policy receipt;RunLedger 的 managed deny、Telemetry Manifest 和 executor policy 不得在远端策略不可验证时继续沿用本地低优先级配置。
- team-memory scanner 是 feature-gated 的精选高置信度正则,只保护该写入路径,不扫描 candidate diff、untracked/generated 文件、待发布 Artifact 或配置降级;它不能替代 Phase 8/11 的 trusted-base `SecretScanGate`。build flag 关闭也只是功能状态,不是安全门禁证据。
- skill-learning 的 `checkPromotion()` 可仅凭跨项目数量和平均置信度把 project instinct 写成 global,随后 lifecycle 可直接写 learned Skill/Command/Agent;缺用户 diff approval、独立回归套件、capability receipt 和 case -> repository -> repeated validation -> global 晋升链。RunLedger 只能采用 observer/draft/lifecycle 分层,禁止这种自动全局发布。
- cost tracker 只保存最后 session 的聚合成本,不是 reserve/commit/refund Budget ledger;graceful shutdown 的超时/错误可被吞并强制退出,不是 durable shutdown receipt。
- `src/server` 是 stub,daemon 主要是进程 supervisor,remote-control state 使用进程内 `Map`,本地 state 只是无原子写/锁/generation/principal 的普通 JSON;ACP pending approval 主要按随机 requestId 关联。这些都不能作为 Phase 10 durable/authenticated Control Plane 证据。
- file history 的注释、默认配置和可启用路径互相冲突,快照只覆盖 tracked files,rewind 还是独立 filesystem side effect;未经过实跑和 untracked/conflict/atomicity 验证前,不能作为 production checkpoint/rewind 基线。

### 1.5 参考机制到实施阶段的追踪矩阵

| 参考来源与机制 | 计划落点 | 采用边界 |
|---|---|---|
| codex rollout/thread-store、fork lineage、projection checkpoint | Phase 1、Phase 10、Phase 11 GC | 采用单 writer、可重建 projection、分页/cursor 与引用感知清理;canonical current 仍必须严格校验而非跳过坏行 |
| codex compatibility/compaction reconstruction、Guardian/model review、managed config/raw trace | Phase 1、Phase 3、Phase 6、Phase 8、Phase 11 + Plan/Context/Compaction/Memory 专项 | 缺 hash、非法 window/world-state、截断 evidence 与解析失败全部 fail closed;replacement durable 后才切 projection;策略 fallback 有 normalization receipt;raw trace 独立于默认 telemetry |
| codex permission/sandbox/tool routing | Phase 2–3 公共契约 + Worktree/Sandbox/Permission 专项 | Runtime 只拥有 envelope/receipt/port;策略合并、审批、broker 和 sandbox 强制由专项实现 |
| codex MCP/Skill/Plugin 与 tool exposure | Phase 5 公共契约 + Plugin/MCP/Skill/Hooks 专项 | 采用 provenance、immutable snapshot、延迟暴露;不把现有 manifest 当作完整供应链信任证明 |
| codex agent graph 与 app-server control plane | Phase 9–10 | 采用 durable parent/child、局部 active-turn precondition、分页/订阅;增加通用 expected revision、有界预算、idempotency、auth 和 workspace identity |
| pi AgentHarness/session/SQLite/save-point/lifecycle | Phase 1、Phase 7、Phase 10–11 | 采用 immutable current provider request、save-point 后重建 next request、append-only leaf marker、SQLite 事务/rollback fixture 与 settlement;canonical 仍用 strict JSONL,SQLite 先作可重建 projection,replacement 必须 prepare-before-teardown + durable fencing switch,不把进程内状态或数据库事务冒充完整 durable recovery |
| pi compaction/context/model switch/RPC | §0.5 parity gate + Phase 6 公共契约 + Plan/Context/Compaction/Memory 专项 + Phase 10 | 采用 cut point、summary chain、单次 overflow retry、adapter-level message normalization 和 correlated RPC;另补 session-level compatibility、handshake、replay 与安全边界 |
| grok-build actor/checkpoint/worktree/permission | Phase 1–4 + Worktree/Sandbox/Permission 专项 | 采用串行 command/event dispatch、crash-atomic replacement 思路、checkpoint mirror/cache rehydrate 结构、受限 mode filtering/child-mode 偏序和 shell 分析;文件层另建 strict EventWriter+durability 与显式 live restore,补逐 capability parent-grant receipt,拒绝 force GC、partial rewind、共享 workspace/无 sandbox 降级 |
| grok-build task/subagent | Phase 7、Phase 9、Phase 11 cost | 采用深度上限、root token budget/high-water 与 cancel/max-turn last-text fallback;升级为结构化 partial Artifact、全维 reserve/commit/refund、durable DAG、独立 lease/session、权限单调收窄与 telemetry 对账 |
| grok-build agent/leader server 与 daemonize | Phase 10 | 采用 authenticated transport、多客户端路由、single-instance/takeover 与 shutdown drain 的测试形状;另建 bounded backpressure、durable cursor/restore、idempotency、principal/tenant binding 与副作用 reconciliation |
| grok-build Plugin/tool protocol、Browser/PR、telemetry | Phase 5、Phase 8、Phase 10–11 + 对应专项 | 采用 canonical containment、handshake/generation/seq、default-off allowlist;路径 trust、自报 scope、prompt browser、只读 PR 扩展和缺 manifest exporter 均不能形成授权、验证或交付证据 |
| claude-code-bun worktree/security | Phase 2–3 + Worktree/Sandbox/Permission 专项 | 采用 slug/root 校验、Git 检查失败/tracked-dirty/unpushed cleanup deny 与 SessionMemory 精确 tool/path 收窄;补 durable owner/session/lease receipt,拒绝 stale GC 的 `-uno`、missing-worktree 回退 parent cwd 与 unsandboxed 降级 |
| claude-code-bun restore/memory/agent/verification/cost/shutdown | Phase 1、Phase 6、Phase 8–9、Phase 11 | 采用服务分层、fork/resume、role profile、cost 与 graceful shutdown;Memory 增加 provenance/审批生命周期,验证必须独立且 telemetry 默认脱敏 |
| `00-reference.md` 的 11 类问题与五项长期资产 | Phase 0–11、§11 总验收 | 逐项映射到 Session、Workspace、Capability、Artifact/Evidence、Harness Regression,不以单一 UI 或模型功能代替 Runtime 门禁 |

## 2. RunLedger 当前能力与差距

### 2.1 可保留的现有基线

- `src/runtime/agent-loop.ts` 已有 outer/inner loop、sequential/parallel tool batch、steer/follow-up、tool hook、truncated tool call fail-closed 和动态 turn update。
- `src/runtime/agent.ts` 已有单活跃 run、interrupt、queue 和 `waitForIdle`。
- `src/runtime/ledger/` 已有 current append-only JSONL、MemoryLedger、lockfile 和 entry-count high-water mark。
- `src/storage/session-codec.ts` 对 current canonical message 无损恢复,legacy retired 只恢复安全文本。
- `src/storage/session-manager.ts` 已有 create/open/continue/fork/list 和整场锁。
- `src/runtime/execution-env.ts`、`tool-context.ts` 已把 fs/shell/cwd 和单次 tool context 抽象出来。
- `src/runtime/tool-registry.ts` 与 stdlib 工具已形成最小可运行工具面。
- `src/runtime/interactive-session-controller.ts` 已统一 provider/model/thinking/session replay 和 TUI 装配。
- `src/runtime/tasks/`、`src/runtime/tools/{multi-edit,web-fetch,skill,notebook-edit,todo-write}.ts`、`src/tui/components/{tool-call,diff-preview,bash-execution}.ts`、`examples/m3-demo.ts` 与 mock-stream phase tests 可作为后续 projection/兼容入口;这些是历史阶段产物,不对应本计划的 Runtime-M0–Runtime-M4 发布里程碑。
- 当前 HEAD 已有 `src/runtime/protocol/`、identity、resource、model/plan/context contract 和 feature flag 的可编译前置 scaffold,且新能力默认关闭;其中仍有明确 TODO、宽 payload guard 和未接入 `npm run check` 的边界脚本,不能据此把 Phase 0 或后续行为阶段标记完成。

### 2.2 对照 11 类治理问题的缺口

| 领域 | 当前缺口 | 进入生产自动化前的硬门槛 | 计划落点 |
|---|---|---|---|
| Workspace identity | ExecutionEnv 只有 cwd/fs/shell;绝对路径、symlink、branch/base/owner 未统一校验 | 每次工具调用必须带并验证 `WorkspaceExecutionEnvelope` | Runtime Phase 2、4 + WorkspaceSecurity-Phase2–WorkspaceSecurity-Phase7 |
| Session integrity | current 无 sequence/hash/payload digest,坏行被跳过,无 stop tombstone;queue payload/claim/cancel 与 root goal/agent lineage 不是可恢复真源 | current strict event log、durability/uncertain barrier、identity/queue replay、corruption fail-closed | Runtime Phase 0–1 |
| Capability kernel | 决策只有 allow/deny,生产默认 `AllowAll` | `deny > ask > allow`、approval receipt、所有副作用只能过 Gateway | Runtime Phase 3 + WorkspaceSecurity-Phase1–WorkspaceSecurity-Phase8 |
| Tool/MCP/Skill/Plugin | 无 manifest trust、签名/digest、变更重批和按需激活 | 可信 Registry、exact identity、capability manifest、sandbox probe | Runtime Phase 5 + Extension-M0–Extension-M7 |
| Deterministic orchestrator | 模型循环没有完整 Goal/Gate 状态机 | build/test/review/complete 由结构化 gate 决定 | Runtime Phase 7–8 |
| Model router | controller 可直接换模型,无兼容检查 | Compatibility Manifest;不兼容切换必须 fork | Runtime Phase 6 + Plan/Context/Compaction/Memory Phase 1、7 |
| Context/Compaction/Memory | 无分层 context、compaction invariant、持久 memory 审批 | 五层 context、taint/trust、摘要前后 invariant | Runtime Phase 6 + Plan/Context/Compaction/Memory Phase 2–10 |
| Multi-Agent | 无 durable DAG、总预算、workspace/capability 子集 | 有界 DAG、独立 lease/session、partial artifact | Runtime Phase 7、9 + WorkspaceSecurity-Phase7 |
| Verification | 无独立 pipeline/finding lifecycle/可信基线 | Builder 自述永远不能形成 pass | Runtime Phase 8、10 + WorkspaceSecurity-Phase7 |
| Artifact/Observability/Cost | 大输出落普通 tmp 文件,无 CAS/retention;OTel 未完整接入 | Artifact digest、默认脱敏、全维度 cost/budget、Episode Manifest | Runtime Phase 4、7、10–11 + WorkspaceSecurity-Phase7 |
| CI/Enterprise | 无 daemon、managed policy、SIEM、runner egress | control plane、策略优先级、可信 gate、最小权限 runner | Runtime Phase 8、10–11 + WorkspaceSecurity-Phase8 + Extension-M7 |

### 2.3 `00-reference.md` 闭环追踪

| `00-reference.md` 要求 | Runtime Phase / 专项 owner | 必需证据对象 | 定向测试与最终 gate |
|---|---|---|---|
| Workspace Identity | P2、P4 / WorkspaceSecurity-P2–P7 | Envelope、binding/lease/path-validation/broker/sandbox receipt、CompositeCheckpoint | `workspace-contracts` 在 Runtime-M0 验 contract;真实 isolation/cleanup 到 WorkspaceSecurity-M5,并作为 Runtime-M1 生产门禁 |
| Session Integrity | P0–P1、P4、P9、P11 / 物理 rewind 依赖 WorkspaceSecurity-P7 | verified event head、DurableEventReceipt/uncertain claim、identity/queue snapshot、stop tombstone、CompositeCheckpoint、partial Artifact、handoff 与 recovery/salvage report | base corruption/replay 为 Runtime-M0;物理 checkpoint 为 Runtime-M1,child partial 为 Runtime-M2,remote handoff 为 Runtime-M4 |
| Capability Kernel | P3 / WorkspaceSecurity-P1–WorkspaceSecurity-P8 | signed/channel-bound request、decision、rate-limit、approval、sandbox execution receipt;credential grant 只由 WorkspaceSecurity-P8 产生 | `security-contracts` 在 Runtime-M0;no-bypass E2E 需 WorkspaceSecurity-M1–WorkspaceSecurity-M5 后进入 Runtime-M1;credential/enterprise gate 到 Runtime-M4 |
| Tool/MCP/Skill/Plugin Supply Chain | P0、P5 / Extension-M0–Extension-M7 | input source/taint、resource snapshot、provenance、approval/revocation/separation-of-duty receipt、invocation result | `resource-contracts` + taint propagation;Extension-M0–Extension-M6 是 Runtime-M1 生产门禁,Extension-M7 在 Runtime-M4 加固 |
| Deterministic Orchestrator | P7 | Goal/Task projection、gate evidence ref、budget reservation/commit | `orchestrator` table/crash/budget tests;Runtime-M1 |
| Model Router | P6 / Plan-Context-Memory P1、P7 | compatibility manifest、route decision/diagnostic、adapter-state receipt | model-routing contract + switch/fork E2E;Runtime-M1 |
| Context/Compaction/Memory | P0、P6 / Plan-Context-Memory P2–P10 | context assembly receipt、source/taint/declassification、compaction checkpoint/invariant、memory proposal/approval | contract + taint-preserving 专项 recovery/security/E2E;Runtime-M1 |
| Multi-Agent | P7、P9 / WorkspaceSecurity-P7 | durable Agent graph、delegation/subset/lease receipt、partial/merge Artifact | `agents` + multi-agent isolation E2E;Runtime-M2 |
| Independent Verification | P8、P10 / WorkspaceSecurity-P7 | GateManifest、Browser evidence、VerificationResult、Finding lifecycle、EpisodeSeal、ChangeProposal/human-gate receipt | core/browser/candidate tamper + WorkspaceSecurity verification E2E 为 Runtime-M1;forge/human-gate E2E 到 Runtime-M3/Runtime-M4 |
| Artifact/Observability/Cost | P4、P7、P10–P11 / checkpoint/cleanup/access 依赖 WorkspaceSecurity-P7 | CAS metadata/transform/checkpoint receipt、CostTrace、RuntimeActivity、Telemetry Manifest | Artifact contract 为 Runtime-M0,Episode/physical checkpoint 为 Runtime-M1,activity/control-plane 为 Runtime-M3,telemetry/cost/retention 为 Runtime-M4 |
| CI/CD 与 Enterprise Governance | P8、P10–P11 / WorkspaceSecurity-P8 + Extension-M7 | dependency-admission/Secret-Scan evidence、handshake/command/ProductionComposition receipt、managed/server-scope policy receipt、remote attestation/handoff、Telemetry Manifest、reference-aware GC tombstone | daemon/managed-policy/harness regression + dependency/secret/remote/CI 联合 E2E;Runtime-M3/Runtime-M4 |

## 3. 目标架构与不可变约束

### 3.1 架构决策

继续使用单包 TypeScript,先构建“模块化单体 Runtime + 可独立进程 daemon”,不立即拆微服务。内部接口保持可替换,为以后把 Event Store、Artifact Store、Executor 或 Verification Runner 移到独立服务保留边界。

```text
TUI / CLI / IDE / CI
        |
        v
Runtime Control Plane  <---->  Event Subscription / Projections
        |
        v
Deterministic Orchestrator
   |          |             |
   v          v             v
Session     Model        Workspace
Kernel      Router       Manager
   \          |             /
    \         |            /
     +---- Capability Gateway ----+
                    |              |
                    v              v
              Tool Runtime    Credential Broker
                    |
                    v
             Verification Pipeline

Canonical Event Store ---> Snapshot / Artifact CAS / OTel-SIEM
```

“唯一事实源”只适用于 Runtime 状态转换,不表示所有数据都塞进 Event Store。Credential Store、organization policy/trust root、Workspace Lease CAS 和 Artifact Blob 是独立权威存储;事件只记录它们的 digest、receipt、fencing token 和状态引用。跨存储变更统一使用:

```text
intent event
  -> idempotent durable object / CAS mutation
  -> committed event
  -> orphan reconciliation on recovery
```

若 durable object 成功而 committed event 失败,对象保持不可见/pending,由 recovery 按 intent id 补记或回收;若 event 已提交而对象不可验证,session 进入 corrupted/paused,不得继续。Secret 永远不能由 event replay 重建。

Runtime-M0 的本地 canonical backend 固定为 strict hash-chained JSONL,避免形成 JSONL/SQLite 双真源;`RuntimeEventStore` contract 保持 backend-neutral。SQLite 可先用于可丢弃、可从 canonical events 重建的分页/物化 projection。若以后把 SQLite 提升为 canonical backend,必须另行设计并通过同一 Event Store conformance/fault suite,至少包含 `WAL`、`synchronous=FULL`、事务内 session/sequence/entry/active-leaf/projection 初始化与更新、原子 fork、writer fencing 和 durable receipt;数据库文件或事务成功本身不等于这些语义已经成立。

### 3.2 Runtime 硬约束

1. 没有有效 Workspace Envelope,任何 Tool Call 都不得开始。
2. event sequence 缺口、hash 断链、中间坏行或未知 schema 默认禁止 resume。
3. tool terminal event 未持久化并 flush 前,不得发起下一次模型请求。
4. 用户 stop 写入 durable tombstone 后,重启不得自动复活。
5. 生产路径不得使用 `AllowAllToolAuthorizationPolicy`,也不得用随机 ID 或本地占位对象伪造 Workspace、Approval、Gateway、Sandbox 或 Verification receipt。
6. `ask` 不能被 auto mode 或低优先级策略降级为 `allow`。
7. sandbox、path guard、policy、credential broker 任一不可用,副作用操作必须失败。
8. Skill 文档可读不等于其脚本可执行;脚本必须单独授权。
9. Repo 内 MCP/Plugin/Instruction 配置默认不可信;digest 或配置变化必须重新审批。
10. 模型不兼容切换只能 fork,不得把 provider 私有 reasoning state 直接交给另一模型。
11. 不可信输入不能自动进入持久 Memory;Memory 变更必须有 diff、来源和批准。
12. Builder 的自然语言声明不能形成 Verification Pass 或 Goal Complete。
13. Candidate branch 不能修改可信 verifier、gate 或评分器。
14. 子 Agent 默认无 spawn/deploy/secret/cross-workspace 权限,且权限只能收窄。
15. 日志默认不保存完整 prompt、tool output、secret 或环境变量。
16. 默认一个 Goal 对应一个 root Session、Branch 和 Worktree;子任务只能使用显式 child session/workspace ref,禁止多个可写 Agent 隐式共享主工作区。
17. 删除 workspace 前必须生成 checkpoint,并重新验证 canonical path 和 owner lease。
18. Issue/PR/comment/webhook、fork branch 和 candidate workflow/config 一律视为 tainted input,不得字符串插入 shell 或定义 trusted gate;CI action、gate executable 和 policy 必须 pin 到可信 digest/commit。
19. 模型猜测出的 package、repository、MCP、Skill、Plugin 或工具 identity 不能触发安装或执行;必须 exact resolve 到受信 registry record、digest 和有效 approval。
20. 新增或修改高权限 Instruction 的 Agent/principal 不能批准自己的变更;必须取得 separation-of-duty receipt 或更高优先级组织策略决定。
21. Goal Completion 必须消费 durable、可验证且无自引用的 EpisodeSeal;自然语言成功声明、单个测试输出或未封存的 Episode Manifest 都不能完成 Goal。

上述是整个产品的安全不变量,不是 Runtime Phase 2/3 的行为实现清单。本计划把它们表达为 schema、event、projection 和 adapter port;其中 workspace/lease/path、permission/approval/credential、Gateway/sandbox 的强制实现与证据归 Worktree/Sandbox/Permission 专项计划。

### 3.3 威胁模型与完整性声明

本计划覆盖进程崩溃、torn write、并发 runtime、恶意或失控模型、受污染的 repo/web/MCP 输入、工具越权、candidate 篡改 gate,以及同用户进程对路径的 race/symlink 替换。root/内核、运行时二进制或受信 helper、签名密钥同时被攻破不在本地单机信任边界内,必须由受管设备、远程 executor 或外部审计系统补强。

| 部署模式 | 信任根与 signer | 主要不可信参与方 | 必须 fail closed 的条件 | 可声明上限 |
|---|---|---|---|---|
| local | 已知 genesis/head、本地文件权限、可选 OS-backed signer | model、repo/tool 输入、同用户并发 runtime | event chain 损坏、writer fencing 过期、必需 receipt 不可用 | 无 signer 时最多 `valid/unattested` |
| managed | 组织 identity/policy authority、版本化组织 signer、SIEM anchor | model、repo/tool 输入、非受管本地策略、过期 principal | managed policy 不可解析、签名无效、tenant correlation 失败 | 只有 signer/anchor 验证通过后才可 `valid/attested` |
| remote | 固定 control-plane trust root、短期 workload identity、executor attestation | 本地 client、网络、未证明 executor、model/repo/tool 输入 | handshake 不兼容、attestation 缺失、tenant/workload receipt 不匹配 | 只有 workload/executor receipt 验证通过后才可 `valid/attested` |

哈希链只能证明“从已知可信 head/genesis 起未发生未检测修改”,不能单独证明整条日志未被有权限的攻击者重写。因此:

- integrity 与 attestation 分开报告:`valid/partial/corrupted` 不等于 `attested/unattested`。
- session genesis、周期 checkpoint 和 terminal event head 可由 OS key、organization signer 或远端 control plane 生成签名 receipt。
- 无可用 signer 时仍可运行本地链校验,但 Episode Manifest 必须标为 `unattested`,不能对外宣称企业级不可抵赖。
- signer rotation、receipt、外部 SIEM anchor 和验证结果本身都以 Artifact/Event 引用,不得覆盖历史 head。

## 4. current 核心协议草案

实现时使用 TypeBox schema + 静态 TypeScript 类型,禁止 `enum`、参数属性、`any` 和动态 import。

下面代码块是用于评审边界的字段轮廓,不是可直接复制的最终规范源。最终规范必须位于 `src/runtime/protocol/{ids,event-catalog,event-payloads,events,schemas}.ts`:所有主键/ref 使用对应 branded ID,并按 authority/tenant scope 组合;每个 event type 对应独立 exact TypeBox payload schema。后续 contract phase 新增事件时,必须在同一 PR 同步更新 catalog、payload union、状态转换、size bound 和 golden fixture,不得把这里的裸 `string` 或 `Record<string, unknown>` 变成生产协议。

```ts
export type RuntimeEventType =
  | "session.created"
  | "session.forked"
  | "session.stop_requested"
  | "session.stopped"
  | "session.closed"
  | "session.corrupted"
  | "session.repair_reported"
  | "session.handoff_requested"
  | "session.handoff_committed"
  | "session.handoff_failed"
  | "session.deletion_planned"
  | "session.deletion_tombstoned"
  | "session.deletion_committed"
  | "session.deletion_failed"
  | "input.source_recorded"
  | "input.declassification_decided"
  | "goal.transitioned"
  | "task.created"
  | "task.definition_revised"
  | "task.transitioned"
  | "task.output_bound"
  | "turn.started"
  | "turn.finished"
  | "turn.interrupted"
  | "turn.failed"
  | "model.routed"
  | "model.requested"
  | "model.finished"
  | "model.failed"
  | "tool.requested"
  | "tool.authorized"
  | "tool.started"
  | "tool.finished"
  | "tool.interrupted"
  | "tool.failed"
  | "permission.requested"
  | "permission.decided"
  | "permission.expired"
  | "permission.revoked"
  | "capability.rate_limit_recorded"
  | "workspace.bound"
  | "workspace.validation_recorded"
  | "workspace.released"
  | "sandbox.resolved"
  | "sandbox.execution_recorded"
  | "queue.enqueued"
  | "queue.claimed"
  | "queue.consumed"
  | "queue.cancelled"
  | "checkpoint.created"
  | "checkpoint.rewound"
  | "artifact.intent_recorded"
  | "artifact.created"
  | "artifact.committed"
  | "episode.manifest_committed"
  | "episode.seal_recorded"
  | "resource.approved"
  | "resource.revoked"
  | "resource.snapshot_acquired"
  | "resource.activated"
  | "resource.deactivated"
  | "resource.failed"
  | "budget.reserved"
  | "budget.committed"
  | "budget.refunded"
  | "budget.exhausted"
  | "verification.started"
  | "verification.finished"
  | "finding.transitioned"
  | "change_proposal.created"
  | "draft_pr.requested"
  | "draft_pr.created"
  | "draft_pr.failed"
  | "human_gate.requested"
  | "human_gate.decided"
  | "command.claimed"
  | "command.applied"
  | "command.rejected"
  | "command.reconciliation_required"
  | "runtime.replacement_prepared"
  | "runtime.generation_activated"
  | "runtime.replacement_failed"
  | "policy.effective_recorded"
  | "policy.normalization_recorded"
  | "cost.recorded"
  | "cost.reconciled"
  | "telemetry.delivery_recorded"
  | "agent.spawn_requested"
  | "agent.spawned"
  | "agent.paused"
  | "agent.stopped"
  | "agent.partial_committed"
  | "agent.handoff_requested"
  | "agent.handoff_committed"
  | "agent.handoff_failed"
  | "agent.merge_requested"
  | "agent.merge_committed"
  | "agent.merge_failed"
  | "agent.finished"
  | "agent.failed"
  | "lease.acquired"
  | "lease.taken_over"
  | "lease.released";

export type MutationEffect = "none" | "committed" | "uncertain";

export interface DurableEventReceipt {
  streamScope: "session" | "authority_tenant";
  streamId: string;
  cursor: string;
  sequence: number;
  eventHash: string;
  writerEpoch: number;
  durableAt: string;
}

export type ProductionFeature =
  | "session_read"
  | "turn_mutation"
  | "resource_invocation"
  | "artifact_access"
  | "trusted_verification"
  | "draft_pr"
  | "human_gate"
  | "remote_execution"
  | "telemetry_export";

export type ProductionAdapterKind =
  | "event_store"
  | "model_provider"
  | "workspace"
  | "capability_gateway"
  | "approval_coordinator"
  | "sandbox"
  | "artifact"
  | "artifact_key_provider"
  | "resource_catalog"
  | "resource_invoker"
  | "verifier_registry"
  | "managed_policy"
  | "credential_broker"
  | "forge_provider"
  | "human_gate"
  | "remote_executor"
  | "telemetry_exporter";

export interface ProductionCompositionReceipt {
  receiptId: string;
  authorityId: string;
  tenantId: string;
  runtimeGeneration: string;
  featureMatrixVersion: number;
  protocolMinimumMatrixDigest: string;
  effectiveRequirementsDigest: string;
  managedPolicyRef?: string;
  enabledFeatures: ProductionFeature[];
  featureRequirements: Array<{
    feature: ProductionFeature;
    requiredAdapters: ProductionAdapterKind[];
    receiptChainDigest: string;
  }>;
  adapters: Array<{
    kind: ProductionAdapterKind;
    adapterIdentity: string;
    adapterGeneration: string;
    configDigest: string;
    healthProbeReceipt: string;
    trustReceipt: string;
  }>;
  compositionDigest: string;
  verifiedAt: string;
  expiresAt: string;
  signerOrAttestationRef: string;
}

export interface SessionCreatedPayload {
  initialGoalId: string;
  rootAgentId: string;
}

export type TaintLabel =
  | "external_untrusted"
  | "repository_controlled"
  | "candidate_controlled"
  | "model_derived"
  | "secret_derived"
  | "executable_instruction";

export interface InputSourceRef {
  sourceId: string;
  kind: "user" | "repository" | "instruction" | "issue" | "pull_request" | "comment" | "webhook" | "web" | "mcp" | "model";
  sourceDigest: string;
  trust: "trusted" | "tainted" | "derived";
  taintLabels: TaintLabel[];
}

export interface DeclassificationReceiptRef {
  receiptId: string;
  sourceId: string;
  allowedSink: "context" | "filesystem" | "shell" | "network" | "credential" | "publication";
  policyDigest: string;
  approverPrincipalId: string;
  expiresAt?: string;
}

export interface QueueItem {
  queueItemId: string;
  sourceCommandId: string;
  kind: "steer" | "follow_up";
  enqueueRevision: number;
  targetTurnId?: string;
  nextTurnPolicy: "current_turn_only" | "next_turn";
  contentDigest: string;
  payload:
    | { storage: "inline"; message: UserAgentMessage }
    | { storage: "artifact"; artifact: ArtifactRef };
  status: "enqueued" | "claimed" | "consumed" | "cancelled";
}

export interface RuntimeEventEnvelope<
  TType extends RuntimeEventType,
  TPayload extends Record<string, unknown>,
> {
  authorityId: string;
  tenantId: string;
  principalId: string;
  eventId: string;
  stream:
    | { scope: "session"; streamId: string; sessionId: string }
    | {
        scope: "authority_tenant";
        streamId: string;
      };
  sequence: number;
  timestamp: string;
  type: TType;
  previousEventHash: string | null;
  payloadDigest: string;
  currentEventHash: string;
  traceId: string;
  payload: TPayload;
}

export interface WorkspaceExecutionEnvelope {
  authorityId: string;
  tenantId: string;
  principalId: string;
  sessionId: string;
  workspaceId: string;
  repositoryId: string;
  worktreePath: string;
  branch: string;
  baseCommit: string;
  agentId: string;
  toolCallId: string;
  traceId: string;
  cwd: string;
  ownerRuntimeId: string;
  leaseRevision: number;
  fencingToken: string;
}

export interface WorkspaceBindingRef {
  workspaceId: string;
  repositoryId: string;
  bindingKind: "source" | "managed_worktree" | "readonly_checkout";
  effectiveCwd: string;
  baseCommit: string;
  worktreeId?: string;
}

export interface WorkspaceLeaseRef {
  workspaceId: string;
  ownerRuntimeId: string;
  leaseRevision: number;
  fencingTokenDigest: string;
  state: "requested" | "active" | "released" | "stale" | "revoked";
}

export interface WorkspaceValidationReceiptRef {
  receiptId: string;
  workspaceId: string;
  envelopeDigest: string;
  validatorId: string;
  validatedAt: string;
  outcome: "valid" | "invalid" | "unavailable";
}

export interface WorkspaceCheckpointDescriptor {
  workspaceId: string;
  eventCursor: string;
  baseCommit: string;
  headCommit: string;
  statusDigest: string;
  snapshotArtifactRef?: string;
  completeness: "metadata_only" | "complete" | "partial";
}

export type CapabilityName =
  | "repository_read"
  | "workspace_write"
  | "dependency_install"
  | "browser"
  | "network"
  | "process"
  | "credential"
  | "deploy"
  | "cross_workspace";

export interface CapabilityClaim {
  name: CapabilityName;
  resourceKind:
    | "filesystem"
    | "network"
    | "process"
    | "credential"
    | "workspace"
    | "native_tool"
    | "browser_tool"
    | "instruction";
  resourceDigest: string;
  constraintsDigest: string;
}

export type CapabilityDecision = "allow" | "ask" | "deny";

export interface CapabilityRequestRef {
  requestId: string;
  authorityId: string;
  tenantId: string;
  principalId: string;
  capability: CapabilityName;
  argumentsDigest: string;
  workspaceEnvelopeDigest: string;
  policyDigest: string;
  nonce: string;
  issuedAt: string;
  expiresAt: string;
  authentication:
    | { kind: "local_channel"; channelBindingDigest: string; eventCursor: string }
    | { kind: "signature"; signerKeyId: string; keyRevision: number; signature: string };
}

export interface RateLimitReceiptRef {
  receiptId: string;
  principalId: string;
  capability: CapabilityName;
  resourceDigest: string;
  windowDigest: string;
  reservation: number;
  outcome: "reserved" | "committed" | "refunded" | "rejected";
}

export interface ApprovalTicket {
  approvalId: string;
  request: CapabilityRequestRef;
  principalId: string;
  scope: "once" | "session" | "project";
  createdAt: string;
  expiresAt?: string;
}

export interface ApprovalReceiptRef {
  approvalId: string;
  decision: "allowed" | "denied" | "cancelled" | "expired" | "revoked";
  decisionRevision: number;
  receiptDigest: string;
}

export interface CredentialGrantRef {
  grantId: string;
  credentialKind: string;
  audienceDigest: string;
  scopeDigest: string;
  expiresAt: string;
  receiptDigest: string;
}

export interface SandboxProfileRef {
  profileId: string;
  requested: "off" | "read-only" | "workspace-write" | "strict" | "external";
  policyDigest: string;
}

export interface SandboxExecutionReceiptRef {
  receiptId: string;
  profileId: string;
  backendId: string;
  enforcement: "enforced" | "degraded" | "unavailable" | "off";
  invocationDigest: string;
}

export interface ToolInvocationRequest {
  requestId: string;
  toolManifestDigest: string;
  rawArguments: unknown;
  envelope: WorkspaceExecutionEnvelope;
}

export interface ArtifactRef {
  authorityId: string;
  tenantId: string;
  storedDigest: string;
  kind:
    | "diff"
    | "tool_output"
    | "log"
    | "test_report"
    | "screenshot"
    | "dom_snapshot"
    | "console_log"
    | "network_trace"
    | "episode_manifest"
    | "change_proposal"
    | "session_report";
  originalSize: number;
  storedSize: number;
  mediaType: string;
  redaction: "metadata_only" | "redacted" | "encrypted_forensic";
  transformReceipt: string;
}
```

上述接口只是公共 envelope/ref,不是 WorktreeManager、PermissionEngine、ApprovalStore、ExecutionGateway 或 SandboxBackend 接口。它们只描述 Runtime 可验证、持久和投影的数据;值如何产生、是否可信以及何时发射事件,归 Worktree/Sandbox/Permission 专项实现负责。实际 `RuntimeEvent` 必须是按 `type` 区分的穷尽联合,每一种 payload 都有独立 TypeBox schema;不得把宽松的 `Record<string, unknown>` 直接暴露为 canonical event。哈希输入使用仓库内唯一 canonical JSON 实现,固定 UTF-8、字段排序、换行与数字规则。`currentEventHash` 覆盖 identity、sequence、type、previous hash 与 payload digest,不得对原始 `JSON.stringify` 输出直接碰运气。

## 5. 目标目录与数据布局

```text
src/runtime/
  protocol/          branded ids、catalog/payload、schema、hash、transition、threat/coordination contracts
    taint.ts            input source、taint propagation 与 declassification receipt
    workspace.ts        envelope、binding/lease/checkpoint/validation refs
    capability.ts       capability/permission/approval/sandbox refs
    security-events.ts  workspace/permission/sandbox event payload schemas
  session/              event store/writer lease、chain/attestation、reducer、snapshot、checkpoint、recovery/salvage
  artifacts/            CAS、metadata、retention、redaction、manifest body/seal
  resources/            动态资源中立 types、schemas、events 与 adapter ports
  model-routing/        Phase 6 只持有 types/schema;加载、profile router 与 adapter state 归专项
  modes/plan/           Phase 6 只持有 mode/plan types/schema;状态机、服务与工具归专项
  context/              Phase 6 只持有 context/compaction/memory types/schema;引擎、存储与算法归专项
  orchestrator/         goal state machine、task DAG、budget、retry
  agents/               delegation、durable graph、supervisor、merge
  verification/         trusted baseline、deterministic gate、finding、evidence、change proposal/human gate contracts
  change-proposals/     Phase 10 durable service 与 human-gate coordinator
  activity/             Phase 10 RuntimeActivity contract 与 projection
  control-plane/        command/query/queue/subscription、composition receipt、JSONL/SSE adapter
  telemetry/            cost、Telemetry Manifest、redaction、OTel/SIEM sink
  lifecycle/            startup recovery、shutdown、GC
src/verification-runner/ 独立 command/browser verifier 进程与 evidence capture
src/integrations/forge/  仅创建 Draft PR 的受限 provider adapter
src/daemon/             headless composition root
tests/runtime-contracts/       contract、failure injection、recovery、security
tests/e2e/              daemon、workspace、verification、multi-agent
```

```text
.runledger/
  sessions/<sessionId>/             当前格式 JSONL；不接受其他格式
  runtime/current/
    authorities/<authorityId>/tenants/<tenantId>/
      lifecycle-events.jsonl        canonical handoff/retention/deletion tombstone stream
    sessions/<sessionId>/
      events.jsonl                  canonical truth
      snapshots/
      episode-manifest.json         immutable pre-seal body
      episode-seal.json             detached signed/attested receipt,由 event 引用
    artifacts/sha256/<aa>/<digest>  content-addressed blobs
    artifact-metadata/
```

本布局只列 Runtime 自身的 canonical event/snapshot/artifact 数据。workspace lease/registry、approval store、security snapshot 和 sandbox backend state 的物理路径由专项计划定义;Runtime event 只保存 ID、digest、revision、receipt 和投影必需字段。Runtime 拥有的所有目录默认 `0700`,敏感元数据文件默认 `0600`。Blob 与 metadata 分离;同 digest blob 可去重,但访问授权按 session/workspace 引用判断。

## 6. 当前格式与回滚策略

### 6.1 Session 与 Runtime 数据

- Session、Runtime event、resource、context、compaction、memory 和 extension 合同各自只有一个当前结构；写入和读取都必须通过该结构的 exact guard。
- 未知字段、缺失必需字段、损坏 JSON、未知 event type 或不完整 entry 一律拒绝；不得跳过、猜测、文本降级或自动修补后继续。
- 当前格式不包含代际号、数字 schema 字段或 session feature flag。能力开关只能表达功能是否已实现，不能改变持久化格式。
- CLI 的 `--continue`、`--resume`、`--session` 与 `--fork` 只接受当前格式；不提供 migrate、旧格式导出兼容或隐式转换入口。

### 6.2 回滚与发布

- 代码回滚必须同时使用仍能校验当前格式的实现；无法校验时启动失败，不降级到另一套 reader/writer。
- Runtime Event Store、Session ledger 和 projection 只保留一个写入真源；不双写、不并行维护另一套格式、不以 shadow projection 授予新权限。
- Workspace、security、artifact、orchestrator、verification 和 daemon 的能力门仍可独立 fail closed，但不得引入格式代际开关。
- 新增字段或改变既有字段时，先更新当前 exact contract、fixture、静态边界检查和所有消费者，再合入实现；不得保留双格式窗口。

### 6.4 明确后置与非目标

| `00-reference.md` 建议 | 本计划 disposition | 重新进入条件 |
|---|---|---|
| Web/Desktop/Mobile 客户端 | 后置;Phase 10 只冻结轻客户端协议并完成 CLI/TUI,不在 Runtime 主计划实现产品 UI | Runtime-M3 control plane、cursor replay、peer identity 与 production composition 全部验收后建立独立客户端计划 |
| WebSocket/ACP transport | 后置;首版只实现共用 schema 上的本地 JSONL/stdio 与 loopback HTTP/SSE | 出现 SSE 无法满足的双向延迟/流控需求,并有 auth、backpressure、reconnect contract tests |
| 团队版 PostgreSQL/Object Store | 后置;本地 Event Store 与 Artifact CAS 先完成,接口保持可替换 | Runtime-M1/Runtime-M3 本地语义稳定,先写跨存储一致性、tenant isolation、migration/rollback 计划 |
| nested Code Mode/WASI/Deno executor | 后置;首版保留 `direct-model-only` exposure 语义并禁止向 child/nested executor 暴露,不把普通 Bash 包装成 Code Mode | 本地 Gateway/Sandbox/Artifact/Verification 联合门禁通过后,为独立进程、WASI/Deno 或受限容器另写 threat model、capability、egress、resource-limit 与 crash-recovery 计划 |
| 一开始拆微服务或换系统语言重写 Runtime Core | 拒绝;当前保持严格 TypeScript 单包模块化单体 + 独立 daemon | 只有 profiling/故障域证据证明单体边界无法满足 SLO,且协议/fixture 可无损迁移时重新决策 |
| SSH/Relay/CI executor 行为实现 | 后置到 Worktree/Sandbox/Permission 专项;Phase 11 只拥有中立 invocation/attestation/result contract | 本地 Workspace/Gateway/Sandbox/Verification 联合门禁通过后,逐 executor 建独立威胁模型与 E2E |

## 7. 分阶段实施计划

统一协议变更 allowlist:Phase 1–11 只要新增或修改 canonical current event,同一 PR 必须同步修改 `src/runtime/protocol/{event-catalog,event-payloads,events,schemas,state-transitions}.ts`、对应领域 schema/type、golden fixture 和 size bound。该 allowlist 是各阶段“计划文件”的窄例外,不授权顺手修改 ID、canonical JSON/hash 或其他阶段行为;若这些基础规则也需变更,先提交独立 Phase 0 protocol revision。任何阶段只改 `events.ts`/`schemas.ts` 或只新增领域私有 event 都不能完成。

### Phase 0:协议冻结、边界检查与测试骨架

目标:在修改行为前固定 current identity、schema、错误模型和模块依赖。

前置:无。

计划文件:

- 收敛现有 scaffold 并补全 `src/runtime/protocol/{ids,event-catalog,event-payloads,events,schemas,errors,canonical-json,event-hash,state-transitions,coordination,taint,threat-model}.ts`。
- 补全 `src/runtime/identity/{types,local-principal}.ts`,提供可持久化的本地 authority/tenant/principal 基线。
- 补全 `src/runtime/runtime-features.ts`、`scripts/{check-runtime-boundaries,check-execution-boundaries}.ts`,并把两项边界检查接入 `npm run check`。
- 修改 `src/runtime/types.ts`、`src/storage/settings-manager.ts`、`src/index.ts`,仅暴露稳定入口。
- 补全 `tests/runtime-contracts/{schema,canonical-json,module-boundaries,fixtures,phase-zero-contracts,reference-snapshots}.test.ts`、固定 canonical vectors 和当前 JSONL fixtures。

任务:

- [ ] 定义所有公开实体的 branded ID、创建/解析与 scoped-key 规则,至少覆盖 Runtime/EventStream/Session/Goal/Turn/ModelRequest/QueueItem/Workspace/Repository/Worktree/Lease/Agent/ToolCall/Trace/Artifact/Approval/Event/Resource/Snapshot/Leaf/Plan/ContextRequest/MemoryProposal/InputSource/Declassification/Command/CompositionReceipt/RateLimit/EpisodeSeal/ChangeProposal/HumanGate。
- [ ] 从 Phase 0 起把 authorityId/tenantId/principalId 纳入所有主键、签名和授权上下文;实现固定 local authority/tenant 与 OS-derived principal。
- [ ] 定义 `InputSourceRef`、有界 `TaintLabel`、传播规则与 `DeclassificationReceiptRef`:Issue/PR/comment/webhook/web/MCP/repo instruction/candidate config 默认 tainted,去污必须绑定独立 policy/human decision、允许 sink、expiry 与 revision。
- [ ] 定义 RuntimeEvent、typed error code、EventCursor、expected revision。
- [ ] `RuntimeEvent` 显式区分 `session` 与 `authority_tenant` stream scope,各自有独立 sequence/hash chain/cursor 和允许 event-type closed set;`EventCursor`、`DurableEventReceipt`、writer lease/epoch/fencing 全部绑定 branded streamId+scope。`subjectSessionId` 只允许作为 authority lifecycle payload/ref,不得替代 stream identity,也不得用全局 cursor 猜跨流顺序。
- [ ] 建立 Phase 0 基础事件的完整 catalog、逐事件 exact payload schema、允许状态转换和 unknown-event field fence,同时固定 event type -> allowed stream scope 映射;`session.handoff_*` 与 `session.deletion_*` 只允许 authority/tenant lifecycle stream。后续阶段增加领域事件时必须同 PR 扩展 catalog/schema/transition/fixture,正文使用的事件不得游离在 catalog 外。
- [ ] 写明本地/受管/远程三种 threat model,区分 chain integrity 与 signed attestation。
- [ ] 定义跨 Event Store/Lease/Artifact/Approval/Trust Store 的 intent-commit-reconcile 协议和 idempotency key。
- [ ] 为 schema 增加 unknown-field、missing-field、oversized-payload fail-closed 测试。
- [ ] 固定 canonical JSON 与 hash test vectors,包含 Unicode、key order、整数边界和换行。
- [ ] 建立模块依赖规则:protocol 不依赖 storage/UI/provider;gateway 不依赖 TUI;projection 不反向写 canonical store。
- [ ] 建立并测试当前格式 × CLI action 的 exact acceptance 表；不支持的输入返回稳定 typed diagnostic。
- [ ] 把四个参考仓库 snapshot 记录为计划证据,不引入源码复制。
- [ ] 对当前 HEAD 已存在的 current/resource/model-plan-context/feature-flag scaffold 做追溯审计:记录引入 commit、实际路径、TODO/宽 guard、测试覆盖、未接入 `npm run check` 的脚本和相对本计划的缺口;这是 Phase 0 输入,不得倒推为历史 gate 已通过。
- [ ] 在任何后续实现 PR 前,让 `runtime/00-reference.md`、本主计划、三份交叉专项 owner 计划与 `development-doc/00-index.md` 作为同一可追踪文档基线存在于目标分支;未跟踪文件或其他 worktree 中的副本不能作为已冻结 contract/owner 证据。

格式策略:本阶段只写当前数据；格式校验失败立即拒绝并保持源文件不变，不提供迁移或兼容写路径。

验证:

- `npm run check`
- `npm test -- tests/runtime-contracts/schema.test.ts tests/runtime-contracts/canonical-json.test.ts tests/runtime-contracts/module-boundaries.test.ts`
- `git diff --check`

完成门槛:

- schema 与 hash vectors 在 Linux/Windows 路径样本上稳定。
- 未知事件、未知字段或破坏性字段不会被宽松 cast。
- 当前 fixture 均通过 exact guard；不支持的输入稳定拒绝。

建议 PR:

1. `runtime: freeze governed current protocol contracts`
2. `runtime: add architecture and compatibility contract tests`

### Phase 1:Session Kernel current、哈希链与可恢复状态

目标:用严格、可重放、可验证的事件内核替代“消息即 session”的假设。

前置:Phase 0。

并行边界:本阶段先完成并冻结对 session/storage/CLI 共享基线的修改,再开放 Worktree/Sandbox/Permission 专项的独占实现窗口;不得与该专项 Phase 5 串行集成并发。

计划文件:

- 新增 `src/runtime/session/{types,event-store,memory-event-store,jsonl-current-store,event-writer,writer-lease,chain-verification,attestation,stop-tombstone,reducer,projections,snapshot,checkpoint,recovery,salvage}.ts`。
- 修改 `src/runtime/ledger/{types,jsonl-ledger,memory-ledger,lockfile}.ts`,保留 legacy adapter。
- 修改 `src/storage/{session-manager,session-codec,path-utils}.ts` 和 `src/cli/{args,main}.ts`。
- 修改 `src/runtime/{agent-loop,agent}.ts`,在 turn/model/tool/queue 边界写 durable event。
- 新增 `tests/runtime-contracts/session/` 下 integrity、replay、crash、fork、rewind、stop 测试。
- 新增可复用的 Event Store conformance/fault fixture,让 memory、JSONL 以及未来 SQLite/remote backend 接受相同的 stream scope/id、sequence、durability、fencing、fork、cross-stream replay rejection 和 corruption 断言。

核心接口:

- `RuntimeEventStore.append/flushThrough/read/subscribe/verify`:所有方法显式接收/返回 branded stream ref;append 只在该 stream 分配并接受 cursor,只有 `flushThrough(streamRef, cursor)` 成功才返回同 stream 的 `DurableEventReceipt`。
- `SessionReducer.reduce(events) -> SessionProjection`。
- `SessionSnapshot` 记录 event sequence/hash、active leaf、initial goal/root agent、完整有序 queue payload/ref 和已知 budget projection;Phase 1 的 logical checkpoint 不包含物理 workspace/CAS。
- `RecoveryDecision = resume | pause_for_approval | reconciliation_required | stopped | corrupted`。

任务:

- [ ] 提供显式异步 `open/restore` factory:调用方先注册 model/tool/resource/provider 等不可序列化依赖,再读取并 reduce durable state、校验 snapshot 中的依赖 identity/generation、reconcile 未完成状态,最后才返回可变 session handle;构造器不得隐式执行异步恢复。
- [ ] 用单 writer queue 保证 sequence 分配和 append 顺序;append 只返回 assigned/accepted cursor,关键调用必须再取得覆盖该 cursor 的 `DurableEventReceipt`,不能把“写入进程缓冲区”称为 durable。
- [ ] 明确任何 stream completion、listener settlement、`EventStream.result()`、pending-write Promise、内存 queue/retry/phase 归零都不能签发 `DurableEventReceipt`;receipt 只能来自 Event Store 的已验证 flush/commit barrier。
- [ ] durable barrier 必须传播 file flush/sync 错误;新建、rename、tombstone/snapshot 切换还要按平台能力同步父目录或明确返回 unsupported/degraded,不能忽略 `sync_all/fsync` 失败后签发 receipt。
- [ ] 定义 `MutationEffect = none | committed | uncertain`:只有 durable receipt 可证明 committed;after-write/before-sync、sync/receipt 丢失或无法证明未落盘的错误一律为 uncertain。uncertain 必须保留 idempotency claim并立即关闭该 session 的 next-mutation gate,直到同进程 reconcile 或重启 recovery 得出唯一结果。
- [ ] 对每条事件校验 schema、stream scope/id、该流 sequence、previous hash、payload digest 和 current hash;session stream 额外校验 sessionId,authority stream 只把 subjectSessionId 当目标 ref 并验证其存在性/最终 head binding。
- [ ] 额外验证 event/turn/model/tool/queue ID 唯一性、parent/leaf 引用存在性和 reducer 图连通性;未知 event/payload 不得 cast 后继续。
- [ ] `session.created` 固定 `initialGoalId` 与 `rootAgentId`;open/resume/snapshot/fork 从 canonical event 恢复身份,不得在每次进程启动时重新生成 goal/agent lineage。
- [ ] session genesis/head receipt 使用可插拔 signer/anchor;没有 signer 时显式记录 unattested,不能伪造 attested 状态。
- [ ] 定义强制 flush 事件:permission decision、tool terminal、checkpoint、stop、verification terminal、session close。
- [ ] 保证 tool result terminal event flush 后才允许下一 model request。
- [ ] recovery 对未完成 tool call 默认写 interrupted/uncertain 并关闭 mutation gate;只有 manifest 明确声明 idempotent/retry-safe、稳定 request/toolCall identity 匹配且 side-effect reconcile 证明可重试时,才允许沿原 idempotency claim 自动重试。
- [ ] 建立 turn/model/tool/queue 的 started/finished/interrupted/failed 成对事件和 crash reducer。
- [ ] 冻结 `QueueItem` exact schema:queueItemId、sourceCommandId、`steer | follow_up` kind、enqueue/target turn revision、next-turn policy、content digest、bounded canonical message、status;Phase 4 前超出 inline 上限的 payload 必须拒绝,不得只持久化 digest 后丢弃正文。Phase 4 冻结 exact `ArtifactRef` 后再增加受限 ref variant。
- [ ] queue 状态至少覆盖 `enqueued -> claimed -> consumed | cancelled`;claim 必须按 queueItemId+kind 精确绑定 turn/modelRequestId,禁止按相同文本 digest 猜测。replay 恢复所有未终结 item 的正文/ref、kind 与顺序;payload 缺失或 claim 结果不确定时 pause/corrupted,不能投影为空队列继续。
- [ ] `queue.cancelled` durable 后才可从 projection/Agent queue 移除;批量 clear 也是逐 item/versioned cancellation,不能用返回空数组的 no-op 伪装成功。
- [ ] 写 durable stop tombstone;startup recovery 先读 tombstone,再判断是否可恢复。
- [ ] snapshot 只作为加速层;加载时从 snapshot cursor 继续重放并验证尾部链。
- [ ] logical checkpoint 只绑定 event cursor、reducer digest、active leaf 和 active plan digest;预留可选 composite checkpoint ref。
- [ ] fork 只允许 stable turn boundary;新链用 `session.forked` 引用父 session/cursor/hash,不复制伪造原 eventId。fork payload 必须显式选择 continue-existing-goal 或 create-child-goal,为新 session 创建 rootAgentId 并记录 parent root agent lineage,不能靠 open 时随机推断。
- [ ] session create 与 fork 以不可见 staging/intent 开始,只有 genesis、writer epoch、初始 sequence/projection 和 lineage 全部 durable 后才原子 publish 为 resumable;任一初始化或逐 entry/import 失败只能清理或留下 failed/tombstoned 目标,不得留下可被 `continueRecent` 识别为完整 session 的半成品。
- [ ] logical rewind 创建新 branch/leaf,不删除旧事件,但在 Phase 4 前不得声称已回退文件系统或开放生产 rewind 命令。
- [ ] 中间坏行、sequence 缺口、hash 断链全部返回 `corrupted`;禁止静默跳过。
- [ ] Phase 1 forensic salvage 只读生成有硬大小上限的 `SalvageReport` 和可选离线 report file+digest,不依赖尚未实现的 Artifact CAS;显式修复始终写新 session。Phase 4 再把该 report 适配为受授权的 Artifact,原始坏日志不原地修改。
- [ ] writer lock 以 stream scope/id 为键,增加 writer epoch/fencing token、ownerRuntimeId、heartbeat 与 stale-owner recovery;每次 append/flush 都校验当前 stream/token,session writer 与 authority lifecycle writer 不能共用未分域的锁或 receipt。
- [ ] CLI 对 `--continue/--resume/--session/--fork` 统一执行当前 exact format 校验；不支持的输入返回稳定拒绝诊断，源文件保持不变。
- [ ] recovery 对 malformed header、未知字段、坏 JSONL 行、sequence 缺口和 hash 断链统一 fail closed；不得提供转换器、旧格式 adapter 或兼容写路径。

故障注入:

- 在 header、event body、after-write/before-sync、durable receipt 返回、snapshot rename、checkpoint bind、stop tombstone 每个边界 kill 进程。
- 在 session/genesis/sequence/initial projection 初始化的每个边界以及 fork staging、lineage bind、逐 entry/import、publish 前后 kill 进程;半初始化 create/fork 永远不能被恢复为 completed/resumable。未来 SQLite backend 还必须在 sessions/sequence/materialized 三表初始化和 fork 中途注入 rollback 故障。
- 注入 torn tail、middle-line corruption、duplicate sequence、reordered event、wrong stream scope/id、wrong sessionId、跨 stream cursor/receipt replay、disk full 和 permission denied。
- Phase 1 先覆盖 checkpoint envelope/digest 与 checkpoint 前后普通坏 JSONL 行,全部停止恢复并进入 corrupted 或只读 forensic salvage。invalid window UUID/chain、损坏 world-state、patch-with-full 缺失等领域 fixture 等 Phase 6 contract 与专项 behavior 就绪后执行,但必须复用同一 fail-closed recovery outcome,不能 warning 后继续。
- 分别并发启动两个同 session stream writer 和两个同 authority lifecycle stream writer,覆盖 stale epoch/fencing token、duplicate idempotency claim 与 takeover race;旧 writer 即使持有可写 fd/DB connection 也不能 append,一个 stream 的 receipt/token 不能用于另一个 stream。
- 覆盖 crash-after-intent-before-effect 与 crash-after-effect-before-committed-event:前者只有 reconcile 证明 `none` 后才可执行,后者保持 `uncertain` 直到按原 idempotency identity 证明 committed/compensated,禁止直接 retry。
- 重复 resume 不得重复 prompt、permission decision 或已开始的副作用工具;不确定副作用必须 pause。
- 在 `queue.enqueued/claimed/consumed/cancelled` 的每个边界 kill 进程;重启后 pending 顺序、kind、payload、goalId/rootAgentId 与 live projection 必须一致,相同文本的 steer/follow-up 不得错绑。
- 构造 Git rewind 成功但 filesystem restore 失败、以及相反顺序的 partial receipt;Phase 1 不激活物理 rewind,Phase 4 联合恢复也必须保持原 leaf/workspace 可追溯。

完成门槛:

- 给定可信 genesis/head anchor 时,任意链内修改都可定位到首个坏 cursor;无 anchor 时只报告 locally-valid/unattested。
- stop 后重启永不自动继续。
- replay、snapshot replay 和 live projection 对同一日志产生相同 digest。
- durable queue 未消费时不得恢复成空队列;uncertain mutation 未 reconcile 前,同进程与重启后的所有新 mutation 都被拒绝。
- open/resume 前后 initialGoalId/rootAgentId 与所有既有 turn/tool lineage 保持连续。
- malformed input 只有一个 durable rejection outcome；重启后不被误判为可 resume，也不会生成部分转换结果。
- stable logical fork、projection rewind 与 crash recovery E2E 全绿;物理 workspace rewind 的门槛归 Phase 4。

建议 PR:

1. `runtime: add strict hash-chained current event store`
2. `runtime: project session state and durable queues from events`
3. `runtime: add logical checkpoints fork projections and crash recovery`

### Phase 2:Workspace Envelope、Receipt 与投影数据结构

目标:只固定 Runtime 表达“哪个 runtime/agent 正在哪个 repository/worktree/base 上操作”所需的数据,不创建、验证或清理任何 workspace/worktree。

前置:Phase 0 可先冻结纯 Workspace contract;event/reducer/projection slice 必须等待 Phase 1 Event Store fixture,因此 Phase 2 整体完成以 Phase 1 为前置。

计划文件:

- 补全现有 `src/runtime/protocol/workspace.ts`,新增 `workspace-events.ts`,并按统一协议变更 allowlist 扩展 `event-catalog.ts`、`event-payloads.ts`、`events.ts`、`schemas.ts`、`state-transitions.ts` 与 fixture。
- 在 `src/runtime/session/` 中只增加 workspace event reducer/projection 数据,不引入 manager 或 filesystem/Git 依赖。
- 新增 `tests/runtime-contracts/workspace-contracts/`。
- 不修改 `execution-env.ts`、`tool-context.ts`、stdlib tools、storage、CLI 或 TUI。

最小数据结构:

- `WorkspaceExecutionEnvelope`、`WorkspaceBindingRef`、`WorkspaceLeaseRef`。
- `WorkspaceValidationReceiptRef`、`WorkspaceCheckpointDescriptor`。
- `workspace.bound`、`workspace.validation_recorded`、`workspace.released`、`lease.*` 的穷尽 payload schema。
- `SessionWorkspaceProjection`,只保存当前 binding/lease/validation/checkpoint refs 与不可用原因。

契约任务:

- [ ] 固定 Workspace/Repository/Worktree/Lease ID、binding kind、canonical/effective cwd、branch/base/head 引用和 owner runtime identity。
- [ ] envelope 必须携带 session/agent/toolCall/trace、workspace/repository、cwd、lease revision 和 fencing token;序列化 schema 不接收缺失字段。
- [ ] validation receipt 区分 `valid/invalid/unavailable`,并绑定 envelope digest、validator identity 和时间;它不自行声称阻止了 TOCTOU。
- [ ] checkpoint descriptor 只表达 event cursor、base/head、status digest、snapshot Artifact ref 和 completeness,不实现 Git 采集、物化、rewind 或 cleanup。
- [ ] reducer 对 stale/revoked lease、无效 validation、binding 替换和 unknown event type 产生确定投影,不调用外部实现。
- [ ] 定义 `WorkspaceServicePort` 的 request/result 数据契约时只暴露 opaque adapter port,不在 Runtime 提供 manager、lease store、path guard 或 broker 实现。

完成门槛:

- schema/type round-trip、golden fixture、unknown-event/field、missing-field、digest-binding 和 reducer replay 测试全绿。
- 架构测试证明 workspace contract 不 import Git、filesystem、`src/security/**` 或 `src/worktree/**`。
- fake adapter 能产生数据并驱动投影,但本阶段不宣称 path isolation、lease enforcement、worktree lifecycle 或安全 cleanup 已实现。

建议 PR:

1. `runtime: define workspace envelope and receipt contracts`
2. `runtime: project workspace references from current events`

### Phase 3:Capability、Approval 与 Sandbox 契约数据结构

目标:只固定 Runtime 记录和交换 permission/capability/approval/sandbox 状态的数据,不评估策略、询问用户、注入凭据或执行工具。

前置:Phase 2。

计划文件:

- 补全现有 `src/runtime/protocol/capability.ts`,新增 `security-events.ts`,并按统一协议变更 allowlist 扩展 `event-catalog.ts`、`event-payloads.ts`、`events.ts`、`schemas.ts`、`state-transitions.ts` 与 fixture。
- 在 `src/runtime/session/` 中只增加 approval/sandbox projection 数据。
- 新增 `tests/runtime-contracts/security-contracts/`。
- 不新增 policy engine、approval store/coordinator、shell classifier、credential broker、gateway 或 sandbox backend,不修改 Tool/CLI/TUI 行为。

最小数据结构:

- `CapabilityName`、`CapabilityClaim`、`CapabilityRequestRef`、`CapabilityDecision`、`RateLimitReceiptRef`、`ToolInvocationRequest`。
- `ApprovalTicket`、`ApprovalReceiptRef`、`CredentialGrantRef`、`SandboxProfileRef`、`SandboxExecutionReceiptRef`。
- `permission.requested/decided/expired/revoked`、`capability.rate_limit_recorded`、`sandbox.resolved/execution_recorded`、`tool.authorized` 的穷尽 payload schema。
- `SessionSecurityProjection`,只保存 pending approval、最终 decision、policy/sandbox/receipt refs 与 degraded/unavailable 原因。

契约任务:

- [ ] 固定 capability 命名、request/arguments/workspace/policy digest 绑定和 `allow | ask | deny` 表达;不在 Runtime contract 内实现 `deny > ask > allow` 合并算法。
- [ ] closed resource taxonomy 至少区分 filesystem/network/process/credential/workspace/native tool/browser tool/instruction;Browser claim 的 constraints 必须分别表达 navigate、DOM read、script、download、upload、cookie/credential 与 network egress,未知 kind/operation fail closed。
- [ ] Capability request 绑定 authority/tenant/principal、nonce、issuedAt/expiry、key revision 与 authenticated channel/signature;本地同进程至少绑定受信 channel+event cursor,managed/remote 必须验证签名。receipt/reducer 可确定拒绝 replay、过期、撤销 key 和跨 tenant 请求。
- [ ] 定义独立于 BudgetGuard 的 Gateway rate-limit request/receipt,至少按 principal、capability、resource/host 与时间窗做 reserve/commit/refund/reject;具体原子 limiter 和策略由 Worktree/Sandbox/Permission 专项实现。
- [ ] ticket/receipt 表达 principal、scope、expiry、decision revision、revocation 和 receipt digest;不定义存储 CAS 或 prompt 生命周期。
- [ ] policy deny、user reject、cancel、follow-up replacement、channel failure 分别具有穷尽 terminal outcome 和状态转换;follow-up 只能创建新的 bounded input/queue item,不能把原 approval 标成 allowed,也不能把 channel failure 投影为普通 user deny。
- [ ] approval correlation 使用 authority/tenant/session/runtime generation/turn/toolCall/approval/request digest/decision revision 的复合绑定;只按 approvalId 查 waiter 不足以接受响应,stale、duplicate、cross-turn、replacement-generation response 必须有稳定 typed rejection。
- [ ] approval/自动预审 request 明确携带 bounded summary、original digest/ref 与 `evidenceComplete`/truncation 状态;证据被截断、缺失或 Artifact 不可解析时,terminal outcome 只能是 deny、cancel 或 transfer-to-human,不得产生 allow receipt。
- [ ] sandbox 数据明确分开 requested profile、resolved policy digest、backend identity、effective enforcement 和 degraded reason。
- [ ] event payload 只保存脱敏 request summary、digest 和 receipt ref,禁止 credential、env value、authorization header 或完整 secret-bearing command。
- [ ] `CapabilityGatewayPort` 的 request 必须携带输入 source/taint refs、目标 sink 与可选 declassification receipt;Gateway adapter 对 filesystem/shell/network/credential/publication sink 强制检查,Runtime 不能用摘要、模型改写或低优先级配置自动清除 taint。
- [ ] reducer 处理 duplicate decision、expiry、revoke、crash 后 pending 和 sandbox unavailable,不因 replay 重新执行决策或副作用。
- [ ] 定义 `CapabilityGatewayPort`、`ApprovalCoordinatorPort`、`SandboxExecutorPort` 的 opaque request/result/cancel 契约,但所有行为实现归专项计划。

完成门槛:

- schema/type round-trip、decision lifecycle、nonce/signature/channel binding、anti-replay、rate-limit receipt、expiry/revoke、truncated-evidence、redaction、unknown-event/field 和 replay projection 测试全绿。
- 架构测试证明 contract 不 import TUI、storage、process/fs/network 或任何具体 security backend。
- fake ports 可验证 Runtime 消费路径;本阶段完成不等于 least-privilege 默认、approval 可交互恢复、Gateway 无旁路、sandbox enforcement 或 credential isolation 已交付。

建议 PR:

1. `runtime: define capability approval and sandbox contracts`
2. `runtime: project security receipts from current events`

### Phase 4:Artifact CAS、脱敏、Retention 与 Episode 骨架

目标:把大输出、diff、日志和验证证据从消息/tmp 文件升级为可寻址、可授权、可清理的 Artifact。

前置:Phase 2、Phase 3 的数据契约。涉及 workspace materialize/rewind/cleanup 或 Artifact 访问授权的行为验收,额外依赖 Worktree/Sandbox/Permission 专项计划对应实现阶段。

计划文件:

- 新增 `src/runtime/artifacts/{types,cas-store,metadata-store,access,key-provider,redaction,retention,episode-manifest}.ts`。
- 对 `src/runtime/tools/tool-support.ts`、stdlib tools 与 `src/storage/paths.ts` 的接线只由 §0.6 I2/WorkspaceSecurity-Phase5 owner 完成;Artifact 模块开发期间不并发修改这些共享文件。
- 新增 `tests/runtime-contracts/artifacts/`。

任务:

- [ ] Blob 以 SHA-256 stored digest 分层存储,临时文件 write+sync+atomic rename,metadata 独立持久化。
- [ ] Artifact 写入遵循 intent event -> pending blob/metadata -> committed event -> visible reference;startup 回收或补记 orphan。
- [ ] external upload/export 状态至少区分 accepted/enqueued、durable、content-verified、externally acknowledged 与 failed;`Enqueued` 永远不能计入 fully uploaded、Episode evidence 或允许本地 cleanup 的 terminal 集合。
- [ ] metadata 记录 kind/media type/size/compression/source session/workspace/producer/references/expiry/redaction,并绑定完整 `InputSourceRef[]`、taint 上界和适用的 `DeclassificationReceiptRef[]`;缺失 lineage 的外部/candidate/model-derived Artifact 只能 quarantine,不能进入危险 sink 或 Verification pass。
- [ ] 同时记录 stored digest、受保护的 source receipt、redaction policy/version 和 transform receipt;transform/summary/merge 只能保留或提高 taint 上界,去污必须引用仍有效且 sink 匹配的 receipt。敏感低熵原文使用 keyed digest,避免普通 source hash 被离线猜测。
- [ ] 定义 ArtifactKeyProvider;本地版只接受 OS keyring-backed versioned key,支持 rotation/loss 状态,不允许 0600 明文 key fallback。Phase 11 仅替换为 KMS provider。
- [ ] tool result 在 prompt 中只保留 bounded summary + ArtifactRef。
- [ ] 写入前运行 secret/credential/path/prompt redaction;默认不保留 raw content。
- [ ] forensic raw 只能在显式授权后加密存储,单独 retention 和 access log。
- [ ] key provider 不可用时禁用 keyed source receipt 和 encrypted forensic raw,仍可保存已脱敏 stored blob,并在 metadata/manifest 明确降级状态。
- [ ] 将 Phase 1 的 bounded `SalvageReport`/offline digest 适配成只读、受授权、带 source digest 与 unattested 标记的 Artifact;CAS 不可用时 Phase 1 仍可完成报告,但最终 governed salvage 验收必须等待该适配。
- [ ] 在 `ArtifactRef` exact schema 冻结后启用 `QueueItem` 的 Artifact-backed payload variant;缺失 blob/ref 的 queue item 只能 pause/corrupted。
- [ ] retention 支持 TTL、pin、reference count、legal hold placeholder 和 dry-run GC。
- [ ] 读取 Artifact 时把 session/workspace/capability refs 交给注入的 `CapabilityGatewayPort` 重新检查,Runtime Artifact 模块不实现权限规则。
- [ ] 初版 Episode Manifest 聚合 identity、event head、workspace/base、artifact refs、permission refs、cost/verification 占位。
- [ ] 对缺少当前 ArtifactRef/digest 的 `tmp/tool-output-*` 只生成不可验证诊断，不导入当前事件或 Artifact 真源。
- [ ] 把 Phase 1 logical checkpoint、Phase 2 WorkspaceCheckpointDescriptor、diff/untracked Artifact 合成 CompositeCheckpoint。
- [ ] 定义版本化 WorkspaceSnapshotManifest 数据结构:HEAD/base、raw index/各 conflict stage、staged/unstaged 状态、tracked/untracked Artifact refs、file mode、symlink target、submodule/LFS/exclusion/size-limit 状态;具体 Git 采集与恢复由专项实现。
- [ ] checkpoint schema 对 ignored exclusion、dirty submodule、缺失 LFS object、超限或不可表示状态表达 `partial`;是否允许物理 rewind 由注入的 Workspace 服务判定。
- [ ] Runtime 只在 Workspace 服务返回可验证 rewind receipt 后激活新 leaf;失败保留原 workspace/leaf。
- [ ] cleanup 只提交 CompositeCheckpointRef、WorkspaceExecutionEnvelope 和预期 lease revision,由 Workspace 服务复核并执行;Runtime 记录返回的 pending-GC/terminal receipt。

故障注入:

- partial blob、metadata 写失败、rename 冲突、disk full、digest mismatch、GC 与并发 read 竞争。
- Workspace 服务返回 partial rewind、Git/FS 结果不一致或 owner/lease 改变时,不得激活新 leaf 或清理原 workspace。
- intent/commit 任一侧 crash、redaction transform 失败、workspace rewind 中断和 cleanup fencing 失效。

完成门槛:

- 相同内容去重且 metadata 引用隔离。
- digest mismatch 永远不返回内容。
- expired/unreferenced blob 可回收,pinned/active evidence 不被删。
- tool output 不再依赖进程相对 `tmp/`。
- Artifact metadata、transform receipt 与 Episode evidence 的 source/taint/declassification 可 round-trip;删除、伪造或跨 sink 复用 lineage 时读取、Gateway 消费和 Verification 都 fail closed。
- WorkspaceSnapshotManifest 的 schema 可无损表达 staged/unstaged/untracked/mode/symlink/conflict index refs;Runtime contract 不以此宣称已能恢复文件系统。
- composite checkpoint/replay contract 全绿;物理 rewind、释放和安全 GC 只在专项计划完成并通过联合 E2E 后对外宣称。

建议 PR:

1. `runtime: store large outputs in a workspace-scoped artifact CAS`
2. `runtime: add artifact redaction retention and access checks`
3. `runtime: bind composite checkpoints to artifact-backed workspace state`
4. `runtime: materialize the initial episode manifest`

### Phase 5:动态资源 Runtime 协议与数据结构

目标:只定义 Tool/MCP/Skill/Hook/Plugin 接入 Runtime 所需的中立、精确、可验证数据结构和 adapter port,不在 Runtime 计划中实现任何具体扩展子系统。

前置:Phase 0,以及 Phase 3 的 `CapabilityClaim` 与 Phase 4 的 `ArtifactRef` contract 已冻结;不等待 Phase 3/4 行为实现完成。resource identity/provenance 的草案可在 Phase 0 后并行准备,但包含 invocation/result/receipt 的 Phase 5 整体不能在上述引用 schema 冻结前完成。具体实现由 [`../plugin-mcp-skill-hooks/01-implementation-plan.md`](../plugin-mcp-skill-hooks/01-implementation-plan.md) Extension-M0–Extension-M6 完成。

计划文件:

- 补全现有 `src/runtime/resources/{types,schemas,ports,events}.ts`,删除 TODO 级宽松合同并与 current exact payload 对齐。
- 补全 `tests/runtime-contracts/resource-contracts/`。
- 不修改 `src/runtime/tool-registry.ts`、`src/runtime/tools/skill.ts`、`src/runtime/agent-loop.ts`、controller、CLI 或 TUI。

最小中立类型:

- `ResourceKind`、`ResourceIdentity`、`ResourceProvenance`、`ResourceManifestDigest`。
- `ResourceTrustState`、`ResourceActivationState`、`ResourceApprovalReceipt`。
- `RuntimeToolDescriptor`、`RuntimeToolInvocation`、`RuntimeToolResult`,并引用 Phase 3 已定义的 `CapabilityClaim`;Phase 5 不重复定义 claim。
- `RuntimeResourceSnapshot`、`ResourceLifecycleEvent` 与对应 TypeBox schemas。
- `RuntimeResourceCatalogPort`、`RuntimeResourceInvocationPort`、`RuntimeResourceEventSink`、`RuntimeResourceSnapshotProvider`。

`ResourceKind` 的 closed taxonomy 至少区分 native tool、browser tool、MCP server/tool、Skill metadata/body/assets/script、Hook、Plugin component 与 repository/user/organization instruction;unknown kind 只能 quarantine,不能当作普通 tool 放行。

契约规则:

- [ ] identity 以 `kind + qualified id + version/source + digest` 精确解析;display name 永远不能成为执行路由键。
- [ ] provenance 可表达 builtin/user/project/plugin/session、canonical locator、publisher/signature 引用和 parent plugin,但不解释具体配置格式。locator 必须 canonicalize 并做 source-root containment;路径 containment 只验证定位,不能单独把 resource 标为 trusted。
- [ ] trust 与 enabled/activation 分离;`untrusted/stale/revoked` 不得表达为 enabled 布尔值。
- [ ] approval receipt 绑定 resource identity、manifest/config/command/assets digest、capability digest、principal、scope、expiry 与 revocation revision;任一绑定字段变化后 receipt 不匹配。
- [ ] descriptor 只声明结构化能力、filesystem/network/process/credential 边界、risk 与 `direct/deferred/direct-model-only/hidden` exposure;不携带函数、client 或进程句柄。首版没有 nested Code Mode 时仍保留第四态并默认不向 child/nested executor 暴露,未知 exposure fail closed。
- [ ] Runtime 只接受 raw invocation input,canonicalization 后由受信 descriptor 推导 `CapabilityClaim[]`;调用方提交的 claim 只能作为请求,不能成为最终授权事实。
- [ ] adapter/tool-server handshake 协商 protocol/schema/features,并把 session binding、adapter generation 和 sequence envelope 固定进 snapshot/invocation/result;对端自报 `ToolCapabilities`/`ToolScope` 只属于不可信 annotation,默认 Read 或 capability bit 不能直接派生 authorization。
- [ ] Hook/adapter 返回 `updatedInput` 后必须把它视为新的 raw invocation:重新 exact-schema validate、canonicalize、派生 capability/workspace/resource claims 并 authorize;改写前的 decision/receipt 立即失效,adapter 不得通过“已处理”标志绕过 Gateway/sandbox。
- [ ] tool invocation stream 固定为零或多个 bounded progress event 加 exactly one terminal result;EOF/cancel/adapter replacement 前缺 terminal 必须生成稳定 failure terminal,duplicate terminal 或 terminal 后 progress 一律拒绝,且 terminal durable 前 Orchestrator 不推进。
- [ ] Skill 的 metadata/body/assets/script 使用不同 resource/capability 标识;正文可读绝不蕴含脚本可执行。
- [ ] Skill catalog list 与 body/assets read 绑定同一 snapshot generation;正文或资产 digest 变化生成新 generation,旧 snapshot 不得读取新内容,metadata/body/assets/script 的所有 context 注入路径共享同一硬字节/条目上限。
- [ ] Instruction 是独立、带 source/digest/taint 的资源;instruction 内容或优先级变化使旧 approval stale,提出变更的 Agent/principal 不能批准自己的高权限 instruction,必须有 separation-of-duty receipt 或更高优先级组织策略。
- [ ] Browser tool 与 native tool 使用不同 resource identity/capability manifest;browser navigation、DOM/script、download/upload、cookie/credential 和 network egress 分别声明能力,不能因“只做验证”绕过 Gateway/sandbox。
- [ ] snapshot 不包含可执行对象,只包含有界 descriptor、diagnostic summary、digest 和 adapter generation id。
- [ ] lifecycle event 只定义 discovered/approved/revoked/activated/deactivated/failed 等中立状态及 receipt refs;Plugin/MCP/Skill/Hooks 领域事件由扩展计划定义并映射。
- [ ] snapshot/invocation 都绑定 adapter generation;reload/replacement 后旧 context 与旧 invocation 必须 fail closed。Hook adapter contract 还要能表达 same-role replacement、tool-result source-order patch、tool-call block short-circuit、system-prompt chain 与 input handled/transform 的确定顺序;具体 reducer 和错误策略由扩展专项实现与验收。
- [ ] MCP annotation（含 `read_only_hint`）只作为不可信 metadata,不能生成 capability decision;remembered approval 每次都重新核对当前 policy/Hook、server config、tool/publisher/digest/generation。生产 composition 必须能证明使用显式安全 client factory 与 authorization adapter,缺失时 fail closed。
- [ ] Hook runner 本身通过 Resource port + Gateway/Sandbox 执行;Hook input/output、stderr 与 diagnostic 都有硬字节上限和写前脱敏,持久 event 默认只保留分类、digest 与 bounded diagnostic ref。具体 runner 行为与联合 E2E 归扩展专项。
- [ ] schemas 拒绝未知字段、缺失 digest、含糊 identity、过期 receipt 和无法穷尽的状态值。
- [ ] port 支持 exact resolve、bounded metadata search、snapshot acquire/release、invoke/cancel 和 event emission;不规定文件扫描、MCP transport、hook runner 或 plugin 安装方式。
- [ ] snapshot/generation/cache ticket 绑定 adapter generation 与 resource digest;cache hit 只代表内容身份匹配,不替代 publisher trust、approval 或 capability decision。

显式不实现:

- Plugin manifest parser/discovery/store/install/update/rollback/marketplace。
- Skill frontmatter/discovery/catalog renderer/body/assets/script loader。
- Hook config/matcher/runner/dispatcher/failure policy。
- MCP config/SDK client/connection manager/catalog/tool adapter/OAuth/pagination。
- extension trust root/key lifecycle/trust store/fingerprint persistence、probe sandbox。
- extension-specific CLI/TUI/modal/doctor/reload 和 `src/extensions/**`。

交接规则:

- 先冻结 exact schema、导出路径和 contract fixtures;扩展线只通过 public port 消费,不 import Runtime 内部 reducer/store。
- 扩展 adapter 将具体 `ExtensionSnapshot` 投影为 `RuntimeResourceSnapshot`,将具体 trust record 投影为 `ResourceApprovalReceipt`,不把 Runtime 类型反向持久化成另一份 extension 真源。
- 任何资源配置变化、批准撤销或 adapter generation 变化,由扩展实现生成新 snapshot/lifecycle event;Runtime 只验证结构、receipt 绑定与 Gateway decision。

完成门槛:

- 所有 TypeBox schema 与静态类型一致,round-trip/golden/unknown-field/invalid-receipt contract tests 全绿。
- fake adapter 可在不读取文件、不启动进程、不访问网络的情况下完成 exact resolve、snapshot 和 invocation contract 测试。
- 架构测试证明本阶段未新增 `src/extensions/**`,且 Runtime resources 模块不依赖 MCP SDK、YAML/semver parser 或具体 Plugin/Skill/Hook 实现。
- 具体资源的发现、信任、执行和 UI 验收只在扩展计划中判定,不得用本阶段完成状态代替。

建议 PR:

1. `runtime: define exact neutral resource contracts`
2. `runtime: add resource adapter ports and contract fixtures`

### Phase 6:Model、Plan、Context、Compaction 与 Memory 公共契约

目标:只冻结专项实现与 Runtime 其他模块共享的中立数据结构、schema、event payload 和 fixture,不改变用户行为。

前置:Phase 0、Phase 1、Phase 3、Phase 4 与 §0.5 `PiAiParityManifest`;resource snapshot/ref 结构依赖 Phase 5 contract。各 contract slice 冻结后,专项计划可在不改写本阶段文件的前提下并行实现。

Runtime contract allowlist:

- 补全现有 `src/runtime/model-routing/{types,schema}.ts`。
- 补全现有 `src/runtime/modes/plan/{types,schema}.ts`。
- 补全现有 `src/runtime/context/{types,schema}.ts`。
- 补全现有 `src/runtime/context/compaction/{types,schema}.ts`。
- 补全现有 `src/runtime/context/memory/{types,schema}.ts`。
- 按统一协议变更 allowlist 扩展 `src/runtime/protocol/{event-catalog,event-payloads,events,schemas,state-transitions}.ts`,只注册本阶段的 payload/catalog/transition 和 size bound。
- 新增 `tests/runtime-contracts/contracts/{model-routing,plan-mode,context,compaction,memory}.test.ts` 与 `tests/runtime-contracts/fixtures/{model-routing,plan-mode,context,compaction,memory}/`。

本阶段禁止修改:

- 不新增 manifest loader、router、profiles、adapter-state service、reducer、ContextEngine、token estimator、compaction planner/summarizer/validator/service、Memory store/index/search/approval 或 Plan Mode 工具。
- 不修改 `src/runtime/{agent-loop,interactive-session-controller}.ts`、`src/models.ts`、`src/models-store.ts`、`src/storage/**`、`src/cli/**`、`src/tui/**` 和 provider adapters。
- 不写 behavior/security/recovery/E2E 测试,不用虚假 implementation 让 fixture 通过。这些任务全部归专项计划。

数据结构任务:

- [ ] 定义 model capability/profile manifest、route request/decision/diagnostic、adapter-state compatibility 与必须 fork reason。
- [ ] model profile 的 provider/api/tool/reasoning/image/context/transport 能力从已验证 `PiAiParityManifest` 和 catalog 生成或核对;未知/缺失能力按 incompatible 处理,不得根据 display name 或 best-effort `transformMessages` 猜测可切换。
- [ ] 定义 `SessionMode`、`PlanModeState`、`ApprovedPlanRef`、mode/plan command、expected revision 与 approval/artifact reference;只表达状态,不实现行为 reducer。
- [ ] 定义 `ContextLayer`、`ContextFragment`、trust/taint/provenance、assembly request/receipt、omission diagnostic 和 bounded budget 字段。
- [ ] Context assembly、compaction summary/checkpoint、model switch、Memory proposal/injection 全程保留 InputSourceRef/TaintLabel 与允许 sink;任何合并/摘要都只能取 taint 上界,去污只接受 Phase 0 的独立 DeclassificationReceipt。
- [ ] 定义 compaction reason、cut/checkpoint/invariant snapshot/ref、validation result、suppression/attempt receipt 和 previous-checkpoint link。
- [ ] compaction checkpoint 携带完整 replacement-history ArtifactRef/digest、被替换范围、previous link 与 surviving suffix cursor;恢复只允许验证 checkpoint 后正向 replay suffix,不能从 UI delta、bounded summary 或最后可解析行猜测 canonical history。
- [ ] 定义 memory scope/status/source/ref、record/proposal/diff/search request/result/receipt、TTL/revocation/approval reference。
- [ ] 复用 Phase 3 capability/effect 和 approval ticket、Phase 4 `ArtifactRef`、Phase 2 workspace identity;不在本阶段重新声明同义类型。
- [ ] 扩展穷尽 current event union,覆盖 model route、mode/plan lifecycle、context receipt、compaction lifecycle 和 memory proposal/approval/publication/search/injection;大正文只保存 Artifact/Memory ref 和 bounded metadata。
- [ ] 为每个类型提供 TypeBox schema、public export 和稳定 discriminant;禁止 `any`、`enum`、宽松 `Record<string, unknown>` canonical payload 和无上界 array/string。
- [ ] fixture 覆盖 compatible/incompatible model switch、approval resume、multi-compaction chain、taint 跨摘要/切模型不丢失、memory revoke/expire、unknown event/field、oversized payload 和 invalid reference。
- [ ] compatibility fixture 对 tool/reasoning/adapter-state/compaction/context/profile/regression 的每一个 hash 分别构造 missing/unknown;任一缺证明均判 incompatible,只能拒绝或显式 fork,不得等同于“hash 未变化”。
- [ ] compaction contract 区分 prepared replacement、durably committed checkpoint 与 live projection installed,并携带 expected projection revision/installation receipt;专项行为必须先 durable commit replacement Artifact、invariant snapshot 和 previous link,再以 CAS 安装 projection。
- [ ] compaction/recovery fixture 覆盖 invalid window UUID/chain、损坏 world-state、patch-without-full、missing replacement、坏 checkpoint 与 checkpoint 外坏 JSONL;每种输入都应有确定 invalid/corrupted 结果,不得通过 optional/default 字段降级为可恢复。
- [ ] compatible-switch fixture 明确验证允许的 reasoning/image/tool-call ID 降级及转换 receipt;incompatible-switch fixture 覆盖 tool schema、private adapter state、compaction format、transport/context profile 不兼容并要求 fork/拒绝。两者都不得以 `transformMessages` 未抛错作为判定依据。
- [ ] contract test 校验 schema/static type 一致、JSON round-trip、unknown-field/event fail closed、budget bound、ID/ref 关系和 current event catalog 穷尽性。
- [ ] 生成 contract ownership manifest,精确列出 Runtime allowlist、专项 behavior path 和 shared integration path;架构测试拒绝专项模块重复定义公共类型。

交接规则:

- 专项 Phase 0 通过 public exports 和 golden fixtures 验证契约,不在其 PR 内修改 allowlist。
- 若行为实现发现字段/状态不足,先在本阶段登记变更理由、exact contract 和 fixture,由独立 contract PR 冻结后再适配 behavior。
- Runtime Phase 6 只回写 contract commit/验证证据;专项最终完成时只在此添加指向专项账本的汇总链接,不把 behavior checklist 搬回本阶段。

完成门槛:

- contract allowlist 中的静态类型、TypeBox schema、event payload、public export 和 fixture 一一对应。
- 全部 contract tests 通过,破坏性 schema 漂移、未知事件/字段、越界 payload 和非法 ref 都 fail closed。
- ownership manifest/架构测试证明 Runtime 与专项没有重叠写入路径,本阶段 diff 不含任何 behavior 或用户面实现。
- 已在本阶段分别记录“contract 已冻结”与“专项实现状态”;不得因 contract 通过就声称模型切换、Plan Mode、compaction 或 memory 可用。

建议 PR:

1. `runtime: freeze model plan and context data contracts`
2. `runtime: add compaction memory schemas and contract fixtures`
3. `runtime: fence contract ownership from behavior implementations`

### Phase 7:确定性 Orchestrator、Task DAG 与 BudgetGuard

目标:让模型负责提出内容,让 Runtime 决定阶段、门禁、重试、预算和完成。

前置:Phase 1–5 和 Phase 6 公共契约。Orchestrator 纯 reducer/budget 可面向契约与专项行为并行开发;任何 model/context/plan/compaction/memory 生产接线和 Runtime-M1 发布承诺仍必须等待专项计划对应门禁完成。

计划文件:

- 新增 `src/runtime/orchestrator/{types,goal-state-machine,turn-orchestrator,save-point,task-dag,budget-guard,retry-policy,loop-breaker}.ts`。
- 修改 `src/runtime/tasks/` 作为 DAG projection adapter。
- 修改 `src/runtime/agent.ts`;对 `interactive-session-controller.ts` 的接线排入已预约的 Runtime 串行集成窗口,不得与安全、扩展或 Context 专项集成并发。
- 新增 `tests/runtime-contracts/orchestrator/`。

核心状态:

```ts
export type GoalPhase =
  | "planning"
  | "awaiting_plan_approval"
  | "implementation"
  | "build"
  | "test"
  | "security_review"
  | "independent_review"
  | "remediation"
  | "reverification"
  | "awaiting_verification"
  | "awaiting_human"
  | "completed"
  | "failed"
  | "stopped";
```

Canonical event/reducer 闭环:

- Task DAG 只由 `task.created`、`task.definition_revised`、`task.transitioned`、`task.output_bound` 重建;dependency/owner/expected Artifact/revision 全在 exact payload 中,不存在只写 tasks sidecar 的旁路。
- Goal、queue、budget 分别复用 `goal.transitioned`、`queue.*`、`budget.*`;`OrchestratorProjection` 以 `(event head, reducer version)` 产生 goal/task/queue/budget/save-point digest,live 与 replay 必须一致。
- 任一 task/goal transition 必须在同一 writer critical section 校验 expected revision 和 required evidence refs 后 append;模型输出、`TaskSnapshot` cache 或 TUI action 不能直接修改 projection。

任务:

- [ ] transition table 明确 allowed transition、required evidence、actor 和 terminal semantics。
- [ ] Plan approval、build、test、security、review、PR/complete 都是系统 gate,模型不能跳过。
- [ ] 在 pi provider-request snapshot/`prepareNextTurn` 模型上强化 save-point:已发出的 provider request 固定 model/tools/resources/config,只有 durable turn 安全点后才对下一次 provider request 应用变更;若定义跨多个 request 的不可变 operation,必须有独立 operationId、开始/终结事件和清晰的本地 divergence 说明。
- [ ] subscriber/hook 必须 awaited settlement;loop terminal、subscriber settled、externally idle、next-mutation-allowed 分成独立状态,任一 listener 不能仅凭 phase=idle 提前驱动下一副作用。
- [ ] durable queue 的 enqueue/claim/consume/cancel 都有 event idempotency;runtime 只按 queueItemId+kind 接受 durable receipt,不按内容 digest 反查。claim 与 `model.requested` 必须在外呼前 durable 绑定同一 modelRequestId,外呼结果不确定时 pause,不得重发旧 prompt。
- [ ] queue item 的 durable accepted、Agent 已开始执行和 turn terminal 是三个独立状态;turn 收尾与本地 `inFlight` 切换期间到达的 item 必须由 canonical projection 在当前或下一 turn 精确消费,不能因最后一次内存轮询已结束而静默丢失。
- [ ] retry policy 区分 network、rate limit、context overflow、tool uncertain outcome;副作用不确定默认 pause。
- [ ] tool retry 还必须同时满足 manifest 的 idempotent/retry-safe 声明、原 request/toolCall/idempotency identity、当前 workspace/capability/resource generation 和 Phase 1 reconcile receipt;任一不匹配只能保持 paused 或要求人工 reconciliation,不能创建新 ID 自动重放。
- [ ] Task DAG 验证无环、依赖、owner、expected artifact 以及 workspace/capability ref 的存在性和版本;具体 workspace 可用性与 capability 子集判定调用注入端口。
- [ ] Budget 覆盖 input/output token、USD、wall time、tool calls、retries、network bytes、storage bytes、artifact count、verification 和 active agents。
- [ ] 每项工作先原子 reserve,执行后 commit 实际用量并 refund 余额;并发 worker 共享 root ledger,不得先执行后抢额度。
- [ ] 对 provider 延迟上报的 token/USD 定义估算上界、允许误差和 reconciliation event;不能承诺物理上的绝对零超支。
- [ ] soft threshold 只产生一次 reminder event;hard threshold 原子停止新工作并保留 partial result。
- [ ] loop breaker 识别重复 tool signature、重复失败、无进展 diff 和 remediation 上限。
- [ ] 工具批次默认 sequential;只有每个调用的 capability claim、workspace target、credential/network/process side effect 均被证明相互独立时才允许 parallel。parallel 模式必须先完成全批 preflight,并分别记录 completion-order terminal event 与 source-order model result projection,crash/replay 后两种顺序都确定。
- [ ] Phase 7 的生产 transition 最远只能到 `awaiting_verification`;`completed` 保持禁用,直到 Phase 8 注册受信 verifier issuer/schema。
- [ ] 状态机单测可使用带 `test-only` issuer 的 Verification fixture,该 issuer 在生产 composition root 必须无法注册。

完成门槛:

- 对所有 phase 转移做 table-driven tests,非法跳转均拒绝。
- crash/replay 后 phase、queue、budget 与 live state 一致。
- hard budget 后无未预留的新副作用;任何 provider/stream 误差都被记录并立即阻止后续工作。
- Agent/TUI 均不能直接写 completed 状态。
- Phase 8 前任何生产 Goal 都无法进入 completed,只能停在 awaiting_verification/awaiting_human/failed/stopped。

建议 PR:

1. `runtime: drive goals with a deterministic state machine`
2. `runtime: add durable save points queues and retry semantics`
3. `runtime: enforce DAG and multidimensional budgets`

### Phase 8:独立 Verification Pipeline、Finding 生命周期与可信基线

目标:把“确实完成”变成独立、可重复、可审计的系统判断。

前置:Phase 2–5、Phase 7 的 Runtime contracts。独立 verifier 模块和 fake-port tests 可在这些 contract 冻结后开发;进入 I5 并把 Phase 8 标记完成,必须同时等待 Phase 7 reducer/budget/transition implementation tests、I4 model/plan/context behavior baseline、Phase 8 独占模块测试,以及 WorkspaceSecurity-Phase7 的真实 trusted-checkout/ExecutionGateway/Sandbox/Artifact adapter 与联合 E2E receipt,不能用 fake port 解锁生产 verifier。

计划文件:

- 新增 `src/runtime/verification/{types,baseline,gate-loader,runner,pipeline,evidence,test-generator,review-evidence,findings,reviewer,security,report}.ts`。
- 新增 `src/verification-runner/` 独立进程入口,以及 `src/verification-runner/browser/{provider,profile,evidence}.ts` 这一仅供 verification gate 使用的内置受限 Browser provider;它不是通用浏览工具或第二套 capability runtime。
- 新增 `src/runtime/change-proposals/{types,ports}.ts`;本阶段只冻结 proposal/human-gate contract,生产 service/provider/coordinator 归 Phase 10。
- 修改 `src/runtime/artifacts/episode-manifest.ts` 和 Orchestrator gate。
- 新增 `tests/runtime-contracts/verification/`、`tests/e2e/verification-trust.test.ts`。

任务:

- [ ] verifier 通过注入的 Workspace 服务申请 trusted-base checkout/materialization receipt,候选分支只作为 input;Runtime verification 模块不创建 worktree。
- [ ] protected gate path、policy 和 schema 由独立 checkout 提供,candidate 修改不影响执行定义。
- [ ] GateManifest 固定 executable digest、typed argv、base-side config、dependency/lockfile policy、env allowlist、sandbox、network 和 expected Artifact schema。
- [ ] 不直接信任 candidate 的 package scripts、test config、PATH shim 或 dependency lifecycle script;candidate 新增测试先作为 untrusted evidence,经独立批准才可升级为 trusted gate。
- [ ] 定义 `DependencyAdmissionPolicy`:lockfile/digest/registry identity、允许源、minimum publish age/cooling period、审批例外和 lifecycle-script deny 均进入 GateManifest;刚发布、来源漂移、lockfile 外或 digest 不匹配的依赖默认阻塞,并产出 bounded evidence。
- [ ] 定义 trusted-base `SecretScanGate`:扫描 candidate diff、tracked/untracked workspace manifest、待发布 Artifact 与生成配置,规则/allowlist 来自 trusted base;命中只保存脱敏 finding 与位置/digest,不得把 secret 本文写入 event、Artifact 或 telemetry。
- [ ] deterministic build/test/lint/security command 生成 typed invocation request、固定 cwd/env-key allowlist/timeout,只调用注入的 CapabilityGateway/Workspace 端口,不直接 spawn 或实现 sandbox。
- [ ] VerificationResult 记录 gate digest、base/candidate identity、command、exit、Artifact refs、started/finished、runner identity。
- [ ] 内置 Browser provider 在独立 verification-runner 进程中实现固定版本/profile、进程生命周期和 evidence capture,所有 launch、filesystem、download/upload、cookie/credential 与 network 行为仍经 Resource port + Gateway/Sandbox;缺真实 backend/receipt 时 Browser gate 返回 unsupported/deny,不得回退宿主直跑。
- [ ] BrowserVerificationGate 固定浏览器/runtime/profile、入口 URL、network policy、step/schema digest 与可信断言;结果至少输出 screenshot、DOM/accessibility snapshot、console 和 bounded network evidence Artifact。
- [ ] 建立受信 verifier issuer registry 与签名/receipt schema;只有该 issuer 的有效 terminal result 才解锁 Orchestrator `completed` transition。
- [ ] Builder、test generator、reviewer、security reviewer 使用隔离 profile;test generator 不接收 Builder 私有 reasoning,只在独立 workspace/ref 中生成 test proposal Artifact,不得修改 trusted gate 或直接签发 pass;其测试只有经独立 policy/human review 纳入下一版 GateManifest 后才成为可信门禁。
- [ ] reviewer 默认 read-only/fresh context,输入绑定 candidate commit、diff digest 与 trusted-base receipt;定义结构化 `ReviewEvidence`/schema,至少记录 diffReadProof、inspectedFiles、verificationArtifacts、reverseAuditHypotheses、verdict、reviewer profile 与 producedAt,并作为 immutable Artifact/event ref 持久化。
- [ ] reviewer 未读完整 diff、证据不覆盖 candidate commit、跨 commit 复用或 inspectedFiles/Artifact 不可解析时 verdict 只能是 `inconclusive`,不能形成 approval 或 deterministic pass。
- [ ] LLM review 只产生 finding candidate,不能产生 deterministic pass;普通文本、解析失败、schema 外字段或看似 JSON 但缺 issuer/evidence binding 的输出统一为 `inconclusive`,不能包装成可信 review result。
- [ ] Finding 生命周期固定为 detected/drafted/verified/published/addressed/reverified/closed。
- [ ] 只有 verified 且满足 policy 的 finding 阻塞;inconclusive 不伪装通过。
- [ ] remediation 有最大轮次和 budget,每轮结束必须 reverification。
- [ ] 定义 `ChangeProposalRef`、`ChangeProposalProviderPort`、`HumanGateCoordinatorPort`、`draft_pr.requested/created/failed` 与 `human_gate.requested/decided` exact schema;本阶段只用 fake adapter 验证 correlation/replay,没有 Phase 10 production service/provider 时 feature 必须是 unsupported。外部 PR 最终只能经 Gateway 授权的 provider adapter,绑定 verified commit/workspace/EpisodeSeal;默认只创建 Draft PR,merge/deploy 必须由独立 human/organization gate 决定,Agent 不能自批 instruction、PR merge 或发布。
- [ ] 把 Episode 收尾拆为无自引用的三步:`EpisodeManifestBody` 固定 evidence/pre-seal head 与 workspace/base/final、artifact、permission、cost、verification、integrity refs;`episode.manifest_committed` 固定 body digest;`EpisodeSeal` 绑定 body digest、evidence head、manifest commit cursor 和 signer/attestation,随后以 `episode.seal_recorded` 持久化引用。
- [ ] Orchestrator 的 completed transition 只接受已 durable、可验证的 EpisodeSeal;completed terminal event 引用该 seal 并成为新的 terminal head,不得回写 manifest body 形成 digest/head 自引用。
- [ ] manifest body 写入后校验所有 digest/ref 可访问;在 body、manifest commit、seal record、completed transition 的每个边界 crash 时,recovery 只能幂等补记或 pause,不能产生两个有效 seal。

攻击测试:

- candidate 修改测试脚本、verification schema、policy、PATH、env 和 output 文本伪造“passed”。
- candidate 引入刚发布/换源/lockfile 外依赖、恶意 lifecycle script,或把 secret 放入 untracked file、生成配置、Artifact、日志与测试快照。
- Builder 提交只打印成功但 exit 非零/未执行测试的脚本。
- Reviewer 未读 diff、复用旧 Artifact、跨 commit result。
- Test generator 读取 Builder 私有 reasoning、修改 trusted gate、把 candidate test 自签为可信,以及 ReviewEvidence 伪造 diffReadProof/inspectedFiles。
- Review model 返回普通文本、markdown fence、伪 JSON/截断 JSON 或复用其他 candidate 的结构化结果;均不能形成 pass。
- Browser gate 伪造截图/DOM/console、复用旧 origin/cookie/commit evidence,或 backend 缺失后请求宿主直跑;ChangeProposal contract 测试 Agent 自批 instruction/PR/merge 与跨 EpisodeSeal 复用。
- 仅配置 `browser_use` prompt 或调用只读 PR status/view/merge-queue adapter,不得被 capability discovery 识别为 Browser verifier、Draft PR provider 或 HumanGate。
- 在 manifest body/commit/seal/completed 四个边界 kill 进程,并注入错误 evidence head、过期 signer 和重复 seal。

完成门槛:

- Builder 自报和伪造 stdout 均不能越过 gate。
- trusted baseline gate 在候选篡改下保持不变。
- 每个 pass 都能从 Episode Manifest 追到可重放 command 与 Artifact。
- Browser pass 可追到固定 gate、origin、browser profile、WorkspaceSecurity execution receipt 和四类证据 Artifact;没有内置 provider 的真实联合 E2E 时 Phase 8 保持未完成。
- ChangeProposal/human-gate schema、port、fake replay tests 完成,但本阶段明确记录 `behavior unavailable`;真实 Draft PR provider、持久 human-gate coordinator 与 credential/organization gate 分别由 Phase 10/11 验收,未获 human gate 永不发生 merge/deploy。
- Test generator 输出与 trusted gate 明确分层;ReviewEvidence 可证明对应 reviewer 确实读取目标 diff、检查指定文件并绑定当前 candidate commit,缺失证据时只能 inconclusive。
- model review 的 plain text、伪 JSON、schema/correlation 失败和截断 evidence 回归均只能产生 candidate/inconclusive;不存在 parser fallback 直接签发 pass 的路径。
- EpisodeManifestBody、seal 与 completed terminal head 可单向验证且没有自引用;任一半提交状态重启后都不会误报 completed。

建议 PR:

1. `runtime: verify candidates against trusted baseline gates`
2. `runtime: persist findings evidence and bounded remediation`
3. `runtime: require a valid episode manifest for completion`

### Phase 9:有界 Multi-Agent、权限与 Workspace 引用

目标:在单 Agent 可靠性和验证闭环成立后,增加有界 DAG 并行,不引入自由递归。

前置:Phase 7、Phase 8。

计划文件:

- 新增 `src/runtime/agents/{types,graph-store,delegation,supervisor,residency,handoff,merge}.ts`。
- 扩展 `src/runtime/orchestrator/task-dag.ts`、`budget-guard.ts`。
- 新增 `tests/runtime-contracts/agents/` 和 `tests/e2e/multi-agent-isolation.test.ts`。

Canonical event/reducer 闭环:

- Spawn/生命周期使用 `agent.spawn_requested`、`agent.spawned`、`agent.paused`、`agent.stopped`、`agent.partial_committed`、`agent.finished`、`agent.failed`;handoff/merge 使用 `agent.handoff_requested`、`agent.handoff_committed`、`agent.handoff_failed`、`agent.merge_requested`、`agent.merge_committed`、`agent.merge_failed`。
- `AgentGraphProjection` 只从上述 Agent events、parent Task/Goal refs、child event head、workspace/capability/budget receipts 与 Artifact refs 重建;residency table 是可丢弃 cache,不能成为 paused/partial/terminal 真源。
- spawn、handoff、merge 均使用 expected graph revision;intent 后 crash 由 stable request id/receipt reconcile,没有 terminal event 的 child 不得被父 projection 猜成 finished。

任务:

- [ ] Spawn 请求必须声明 parent/role/objective/expected Artifact/depth/turn/cost/capability/workspace strategy。
- [ ] 默认 limits:max depth 2、每节点 children 3、total agents 8、root max total cost USD 5、每 Agent max tool calls 40;每次 Spawn 还必须给出 maxTurns/maxCostUsd。实际值只能被更高优先级 policy 收窄;缺少可执行 budget profile 时 fail closed,不得解释为无限额。
- [ ] child 请求只记录 parent grant ref 与 requested capability refs;是否为子集、默认删除哪些能力由注入的 CapabilitySubsetEvaluator 判定并返回 receipt。
- [ ] 每个 builder child 申请独立 session/workspace strategy ref;worktree/lease/readonly checkout 的分配与验证由注入的 Workspace 服务完成。
- [ ] durable Agent graph 记录 parent/child edge、state、cursor、workspace/capability receipt refs、budget 与 artifact contract,不复制外部实现状态。
- [ ] cancellation、timeout、crash、residency eviction 后进入明确 paused/failed/stopped/partial,不能丢失或标 completed。
- [ ] residency eviction 只允许卸载已有 durable terminal/paused snapshot 或可从 child event head 重建的 Agent;interrupted resident 不可重载时必须先持久化 partial/failed 结果并阻止自动恢复,不能永久丢失后仍从 graph 移除。
- [ ] partial result 必须以 ArtifactRef 返回,并标 integrity/verification 状态。
- [ ] merge 只接受声明 Artifact,由父 workspace 的注入服务执行 deterministic apply 并返回 conflict/receipt event;child 不直接写父 worktree。
- [ ] 总并发、总 token/USD/time/tool/network/storage 由 root BudgetGuard 统一扣减。
- [ ] child 默认不能继续 spawn;Runtime 只检查有效 delegation receipt,具体 capability 决策由专项实现。
- [ ] MCP/custom/unknown-kind tool 也必须进入 parent-grant subset evaluation;resume 必须重新校验 delegation/denied-agent/workspace receipts,不能继承 acceptEdits/bypass 或因原 worktree 缺失回退 parent cwd。
- [ ] delegation、child context、partial Artifact、handoff 与 merge 保留所有 InputSourceRef/TaintLabel/declassification refs;父子 Agent 均不得把“模型已阅读/总结”当作去污,合并到危险 sink 前重新经过 Gateway。
- [ ] Runtime contracts 不携带共享 temp、env value、credential 或可写 cwd handle;侧信道隔离由专项实现和联合 E2E 验证。

完成门槛:

- Runtime 单测阻止缺失/过期 receipt、共享 workspace ID、孤儿 Agent 和无限 spawn;capability escalation 与真实共享写隔离依赖专项实现联合测试。
- root crash/replay 后 Agent graph 与每个 child session 一致。
- partial/failed child 不会使父 Goal 自动完成。
- merge conflict 保留双方 Artifact 和可重试状态。

建议 PR:

1. `runtime: persist a bounded delegated agent graph`
2. `runtime: bind child agents to capability and workspace receipts`
3. `runtime: merge only declared verified artifacts`

### Phase 10:Headless Daemon、版本化 Control Plane 与轻客户端

目标:Runtime 成为唯一状态所有者,TUI/CLI 通过协议连接,并冻结供后续 IDE/CI adapter 消费的同一版本化协议;本阶段不交付 IDE/CI client。

边界:本阶段只提供 session/turn/approval/artifact/event/activity 等 Runtime 通用协议。Plugin/MCP/Skill/Hooks 的 list/trust/enable/reload/doctor 命令、query 和界面由扩展计划 Extension-M6 在 adapter 上实现;不得在本阶段复制一套 extension control plane。

前置:Phase 1、Phase 7。session inspect/health/shutdown 可先按已完成能力开放;任何 turn/queue/approval mutation、Artifact 内容读取/写入或副作用能力的生产启用除 Phase 8 外,还必须满足该 feature 的 closed required-adapter matrix 并取得全部真实 receipt。未满足时 daemon 不 advertise 对应 feature,调用只能返回 `unsupported_feature`/deny,不得回退本地 `AllowAll` 或生成占位 receipt。

计划文件:

- 新增 `src/runtime/control-plane/{types,errors,handshake,composition-requirements,command-bus,query-service,subscriptions,idempotency,jsonl-transport,sse-transport}.ts`。
- 新增 `src/runtime/activity/{types,projection}.ts`,在本阶段冻结完整 `RuntimeActivity` schema 并提供单 Agent projection;Phase 11 只做 nested-agent/cost/telemetry enrichment。
- 新增 `src/runtime/change-proposals/{service,human-gate-coordinator}.ts` 与 `src/integrations/forge/{types,github-provider}.ts`;provider 只能创建 Draft PR,凭据只经 Credential Broker/Gateway port 获取。
- 新增 `src/daemon/{main,server,composition-root}.ts` 和 bin 入口。
- 在独占 control-plane/daemon 模块完成后,按 §0.6 I6 窗口修改 `src/cli/main.ts`、`src/runtime/interactive-session-controller.ts` 和 TUI 装配为 client/facade;不得与 WorkspaceSecurity-Phase5、Extension-M6 或 Plan/Context 集成窗口并发。
- 新增 `tests/runtime-contracts/control-plane/`、`tests/e2e/daemon-recovery.test.ts`。

最小 API:

- session:start/resume/fork/stop/inspect
- turn:start/steer/followUp/interrupt
- queue:list/cancel（批量 clear 只是带 expected queue revision 的 cancel 集合）
- approval:resolve（只定义 command/result schema）
- changeProposal:inspect/requestDraftPr、humanGate:resolve（只定义 schema/correlation,实际 provider/decision 走注入端口）
- artifact:read/metadata
- events:subscribe/fromCursor
- activity:get、health、shutdown

Forensic inspect/report 是 daemon 停止后的独占离线管理命令:必须取得目标 session 的 writer/admin lease,只写审计报告或不可验证诊断,不得导入、转换或原地修补 canonical log。daemon 活跃时这些 CLI 明确拒绝而不是并发旁路“唯一状态所有者”。若后续需要在线管理,必须先增加独立 admin handshake/API、高权限 capability、expected revision、idempotency、审计 Artifact 与 crash recovery,不能复用普通 session mutation command。

Canonical event/reducer 闭环:

- mutation lifecycle 使用 `command.claimed`、`command.applied`、`command.rejected`、`command.reconciliation_required`;claim payload 固定 commandId/request digest/idempotency key/principal/generation/domain expected revision。`command.applied` 固定 bounded typed effect、effect digest、applied cursor/revision,`command.rejected` 固定 bounded typed error、error digest与稳定 retryability,`command.reconciliation_required` 固定 reconcile ref;三种 terminal 都必须绑定原 claim/request digest并可独立重放。
- runtime replacement 使用 `runtime.replacement_prepared`、`runtime.generation_activated`、`runtime.replacement_failed`;只有 `runtime.generation_activated` durable 才切换 authoritative generation/fencing,prepared 不是新 authority。
- `ControlPlaneProjection` 与 `RuntimeGenerationProjection` 只从 canonical events 重建 command outcome、queue/activity cursor 与 active generation;idempotency cache、connection waiter 和 process handle 均为可丢弃 runtime state。

任务:

- [ ] handshake 校验 current protocol/schema/features,不满足 exact contract 时返回 typed error。
- [ ] daemon handshake 和任一 tool/resource adapter handshake 都绑定 authenticated session、runtime/adapter generation 与 sequence domain;peer 自报 feature/capability/scope 只影响 discovery proposal,production feature advertisement 与授权仍只来自 `ProductionCompositionReceipt` 和 Gateway receipt。
- [ ] mutation command 带 commandId、request digest、idempotency key 和领域 precondition;重复 commandId 携带不同 payload 必须拒绝。
- [ ] 为 `session:start/resume/fork/stop`、`turn:start/steer/followUp/interrupt`、`queue:cancel`、`approval:resolve`、`changeProposal:requestDraftPr`、`humanGate:resolve` 与 `shutdown` 共 13 类 mutation 建立 closed command -> effect/error mapping。进程重启后只读取 canonical claim+terminal events即可逐字段恢复原成功 effect 或 typed rejection;进程缓存、injected resolver 和外部 waiter 只能加速,不得成为恢复真源。terminal 缺失、digest/cursor/ref 不匹配或 effect 超界只能进入 reconciliation/corrupted,不能返回空对象或重新执行命令。
- [ ] expected session/turn/queue revision 必须在 authoritative 单 writer 的“command claim + compare + append”临界区原子复核,client preflight 只作提示。steer/followUp/interrupt 绑定 expectedTurnId+turnRevision,queue cancel 绑定 queueRevision;响应返回 applied cursor/revision,边界已跨越时返回 stale-turn/revision-conflict,禁止自动改绑到当前或下一 turn。
- [ ] `approval:resolve` 只校验 command schema、expected revision 与 correlation,随后转发到注入的 ApprovalCoordinator;Control Plane 不实现 policy evaluation、approval storage 或 receipt 签发。
- [ ] ChangeProposalService 只接受已验证的 ChangeProposalRef/EpisodeSeal 和 expected revision,持久化 requested/created/failed projection;GitHub provider 通过 Gateway + audience-bound Credential Broker grant 创建 Draft PR,不持有长期 forge credential且没有 merge/deploy API。缺真实 provider/credential receipt 时 `requestDraftPr` 不 advertise。
- [ ] HumanGateCoordinator 把 request/decision 绑定独立 principal/organization policy、EpisodeSeal、proposal revision 与 separation-of-duty receipt;Control Plane 只转发和投影 durable decision,模型、Builder 或 proposal issuer 不能作为 human principal。真实 organization/credential 联合 E2E 等 WorkspaceSecurity-Phase8 与 Phase 11。
- [ ] prompt 只有 server-side precondition 与 `queue.enqueued` durable 后才返回 accepted;accepted 只代表“已持久待处理”,不代表 Agent 已开始。Agent 必须从 canonical projection 领取,不能同时维护另一份不可恢复的 queue 真源。
- [ ] queue:list/cancel 读取并修改同一 projection;只有 `queue.cancelled` durable 后才返回成功。Ctrl-C、dequeue、历史恢复失败或 uncertain 都必须显式显示,不得用空数组/no-op 假装已清队列。
- [ ] 任何 mutation 在 after-write/before-sync 等边界返回 uncertain 时保留 durable command claim并立刻关闭同一进程的 session mutation gate;reconcile 确认 committed/none 前,新 command 不得以新 idempotency key 绕过。
- [ ] event subscription 明确为 at-least-once,带稳定 eventId/sequence cursor;重连不漏事件,客户端按 eventId 去重,不得宣称 transport exactly-once。
- [ ] `RuntimeActivity` schema 覆盖 session/goal/task/tool、waiting permission、nested-agent 列表、last durable cursor 与 heartbeat freshness;Phase 10 单 Agent projection 对 nested-agent 输出空集合而不是省略字段,`activity:get` 与 event replay 产生同一 digest。
- [ ] 需要 exactly-once projection 的内置消费者使用 durable consumer checkpoint,把 projection apply 与 offset commit 放入同一事务/CAS;普通客户端不共享该承诺。
- [ ] per-client bounded buffer、backpressure、slow-consumer disconnect 和 replay recovery。
- [ ] local JSONL/stdio transport 严格 LF framing,支持 CRLF 和 final line,malformed frame 返回 typed error而不是 cast。
- [ ] HTTP/SSE adapter 复用同一 command/query schema;首版只绑定 loopback/local socket。
- [ ] local socket/pipe 权限和 peer identity;远程 auth/tenant 在 Phase 11 前默认关闭。
- [ ] bounded transport input queue 返回 typed overload,不会以断开或静默丢帧伪装 accepted;UDS stale path/startup lock/file mode 只用于本地启动安全,仍必须取得 OS peer credential/channel binding 并映射 principal,不能只信 socket 路径所有权。
- [ ] 在 `composition-requirements.ts` 冻结 `PRODUCTION_FEATURE_REQUIREMENTS` 和 canonical digest,作为协议最低矩阵;至少覆盖 Event Store、model provider、Workspace、Gateway、Approval、Sandbox、Artifact/key provider、resource catalog/invoker、verifier registry,Phase 11 预留 managed policy、credential、forge/human gate、remote executor 与 telemetry exporter。managed policy 只能删除 feature、增加 required adapter/约束或缩短 expiry,不得放宽协议最低矩阵。
- [ ] composition root 生成可校验 `ProductionCompositionReceipt`,绑定 authority/tenant、runtime generation、protocol-minimum digest、effective requirements digest、managed policy ref、每个 adapter identity/generation/config digest/health/trust receipt 与 signer/attestation;任一 adapter generation/health/trust、协议矩阵或 effective digest 变化即失效。feature advertisement 只能由同时满足 protocol minimum 与更严格 effective row 的 receipt 计算,测试 fixture issuer/policy 不得进入生产 registry。
- [ ] composition schema 拒绝 unknown/duplicate feature 或 adapter、同一 feature 多个 requirements row、enabled feature 缺 row/缺 required receipt、receipt adapter 不在当前 generation;requirements 和 adapter kind 按 canonical order 参与 composition digest。
- [ ] downgrade fixtures 覆盖未知/不完整 matrix、伪造 protocol-minimum digest、issuer 删除 minimum adapter、managed policy 放宽 requirements、stale policy ref 与只更新自报 featureRequirements;全部拒绝 startup/advertisement。
- [ ] session replacement 先在关闭 mutation 的候选 generation 中 prepare/validate:注册不可序列化依赖、验证 composition receipt、replay/reconcile durable state 并完成 health probe;在候选未 ready 前,旧 runtime 仍是唯一 authority 且保持可用,不得先 teardown。
- [ ] 候选 ready 后写 durable replacement transition,在同一 lifecycle critical section 原子切换 generation/fencing authority,再 bounded drain/teardown old runtime;commit 后旧 handle 永久失效。factory/open/prepare 在 commit 前失败时保留旧 runtime并记录失败诊断,commit 后才失败则旧 runtime 不得复活,新 generation 必须形成明确 paused/stopped terminal 与 recovery path。
- [ ] idle unload 只针对无 subscriber 且 inactive 的 session,先关闭 mutation gate、取消/持久化 pending request 并 bounded shutdown;subscribe/resume 与 unload 在同一 lifecycle lock 串行,恢复后按 durable cursor 重建 pending 状态。增加 subscribe/resume-vs-unload、pending approval cancel、flush/fencing 与 daemon restart 竞态测试。
- [ ] 每个 session/client handle 绑定 runtime generation 与 fencing token;replacement 后旧 generation 的 command 即使 sessionId 相同也必须拒绝。
- [ ] replacement fault test 覆盖 dependency registration、replay、reconcile、health probe、durable transition、authority swap 与 old-runtime drain 的每个边界;断言 commit 前失败旧 session 仍可用,commit 后失败只有新 generation 的 durable paused/stopped terminal,不存在双 writer、双 authority 或“假装回滚”。
- [ ] shutdown 先关闭 RPC gate拒绝新 mutation,再 bounded drain writer/handler/tool/child,超时项保留 recovery state。
- [ ] TUI 只保留 editor/render/临时动画;queue/retry/compaction/tool/session 状态来自 projection。
- [ ] daemon crash/restart 从 current events 恢复,不会重放已完成副作用。

完成门槛:

- 重复 commandId 不重复副作用。
- 同一 commandId 不同 request digest 被拒绝;uncertain command 在同进程和重启后都形成 reconciliation gate,不会继续接受 mutation。
- 断线/慢消费者/daemon restart 下 at-least-once cursor 语义稳定;重复投递不会造成重复副作用。
- pending queue 可在重启后按原 itemId/kind/order 恢复或取消;turn 尾、interrupt 与 queue cancel 竞态均不会吞消息或把消息移交错误 turn。
- 未满足 feature -> required adapters matrix 时,feature discovery 与实际命令都 fail closed,ledger 中不存在伪造的 authorization/workspace/sandbox/resource/artifact/verification 或 composition receipt。
- `activity:get` 在不依赖 Phase 11 exporter 的情况下可由 canonical projection 回放;heartbeat stale 与 daemon unavailable 明确区分。
- ChangeProposal/human-gate service 的 durable correlation/replay tests 全绿;缺 WorkspaceSecurity-Phase8 credential/organization adapter 时 Draft PR/human gate production feature 保持 unsupported,不能阻塞核心 Runtime-M3 control plane,但最终 Runtime-M4 验收仍必须通过真实联合 E2E。
- old session handle 不能影响 replacement session。
- replacement candidate factory/open 失败时旧 session 仍可接受符合原 revision/fencing 的命令;一旦 replacement commit durable,旧 generation 在同进程与重启后都不可复活。
- TUI 关闭不等于 Runtime 状态丢失,daemon stop 也能正确恢复终端客户端。

建议 PR:

1. `runtime: expose versioned idempotent control-plane contracts`
2. `runtime: run the governed runtime in a headless daemon`
3. `tui: consume runtime projections as a lightweight client`

### Phase 11:Telemetry、企业/远程契约与生命周期加固

目标:在不扩大默认数据暴露的前提下提供运营与生命周期能力,并只定义企业策略、身份、远程/CI 执行需要的 Runtime 数据契约和端口。

前置:Phase 8、Phase 10。Telemetry、identity/executor contract 与核心 lifecycle 可先开发;凡涉及 nested-agent activity、multi-agent isolation 或完整 Harness Regression 的任务还必须等待 Phase 9/Runtime-M2 联合门禁,不能用单 Agent fixture 宣称 Phase 11 整体完成。

计划文件:

- 新增 `src/runtime/telemetry/{types,cost,manifest,redaction,otel,sinks,siem}.ts`,消费 Phase 10 的 `src/runtime/activity/` 公共 contract,不再定义第二份 Activity 类型。
- 新增 `src/runtime/lifecycle/{authority-stream,startup,shutdown,recovery,gc}.ts`;`authority-stream.ts` 只把 authority/tenant-scoped canonical lifecycle events 接入 Phase 1 的 `RuntimeEventStore`,不创建第二种日志协议。
- 扩展 `src/runtime/identity/`,只新增 authentication/authorization/tenant/key receipt 的 types、schemas 与 provider ports。
- 新增 `src/runtime/executors/{types,ports,receipts}.ts`;CI/SSH/relay 的安全执行实现后置到专项实现,Runtime 不实现第二套 sandbox、credential 或 policy。
- managed policy 只以 versioned snapshot/digest/ref 进入 Runtime protocol;不在 `settings-manager.ts` 实现安全策略层。
- 新增 `tests/runtime-contracts/{telemetry,lifecycle,managed-policy}/` 和 harness regression suite。

Canonical event/reducer 闭环:

- handoff 使用 `session.handoff_requested`、`session.handoff_committed`、`session.handoff_failed`;deletion 使用 `session.deletion_planned`、`session.deletion_tombstoned`、`session.deletion_committed`、`session.deletion_failed`。两组事件都只写入同一 `RuntimeEventStore` 抽象下的 authority/tenant lifecycle stream,payload 以 subjectSessionId 绑定 source/target authority、session final head、reference-graph digest、lease transfer/legal-hold decision 与 tombstone;不得在 session stream 复制第二份 handoff/deletion 真源。
- `SessionProjection.lifecycleHeadRef = { authorityStreamId, cursor, eventHash }` 由 authority lifecycle projection join 得出并可缓存进 snapshot;读取/resume/GC 必须重新验证该 ref。session event head 与 lifecycle head 分别单调,不假造跨 stream 全序。
- managed policy/cost/export 使用 `policy.effective_recorded`、`policy.normalization_recorded`、`cost.recorded`、`cost.reconciled`、`telemetry.delivery_recorded`。
- `LifecycleProjection`、`CostProjection`、`TelemetryDeliveryProjection` 均只从 canonical metadata events 重建。exporter spool、raw forensic store、process supervisor state 和外部 policy/lease store 仍是独立外部状态,只通过 receipt ref 关联,不能反向改写 projection。

任务:

- [ ] 在 Phase 10 `RuntimeActivity` 上增加 nested-agent residency/partial state、cost summary 与 exporter health enrichment;同一事件前缀的 live/replay/activity query digest 一致,heartbeat 不可伪造为 durable progress。
- [ ] cost trace 覆盖 token、USD、wall time、tool、network、storage、verification、retry 和 Agent。
- [ ] `CostTrace` 对 root/child、reserve/commit/refund、provider delayed reconciliation 与 Episode Manifest ref 完整对账;无法归属的迟到费用进入显式 reconciliation finding,不能静默丢弃或回填到其他 session。
- [ ] OTel 默认关闭或仅 metadata;content export 同时要求 organization policy 和当前 composition manifest 双重 opt-in,prompt/tool output/model private reasoning 默认一律 redacted。
- [ ] forensic content tracing 使用独立高敏 store/namespace/key/ACL,不得写入默认 OTel/SIEM spool;必须显式、限时、加密、tenant-isolated、可审计,具有单独 retention/legal-hold/crypto-erase 流程,并受 organization policy 禁止。
- [ ] exporter 失败不阻塞 canonical event append,但产生 bounded health event/metric。
- [ ] 默认 metadata-only OTel/SIEM/trace 是可丢弃、可由 canonical metadata events 重建的 projection。高敏 forensic raw 不一定能从脱敏 canonical log 重建,但必须可按 retention 删除、绝不成为恢复/完成所需真源,也不能反向补写 current 审计链。
- [ ] 生成并在 startup/managed-policy 变更时验证 `TelemetryManifest`:列出 event/activity/cost 字段、sink、采样、redaction policy digest、retention、forensic 开关、tenant scope 与 exporter identity;未知字段、未声明 sink 或 manifest drift 使 exporter fail closed,不影响 canonical append。
- [ ] Runtime schema 表达 managed policy source、优先级、snapshot digest 和 effective-policy receipt;优先级合并与执行由专项实现。
- [ ] managed policy contract 逐字段记录 MDM/cloud/system/user/project source attribution、winner/loser、deny union、normalization reason、required-default fallback 和 effective digest;每次 fallback 都必须有 durable normalization receipt,无法验证来源/优先级/结果时 production feature fail closed。
- [ ] I7 每注册 managed-policy、credential-broker、forge-provider、human-gate、remote-executor 或 telemetry-exporter adapter,都从 frozen protocol-minimum matrix 计算同 feature 的严格相等或更窄 effective row 并重新签发 composition receipt;缺任一 required adapter/receipt 时只撤销对应 feature advertisement,不得以已有 Workspace/Gateway 五件套代替,也不得由 managed policy 删除 minimum requirement。
- [ ] policy ref 可关联 tool/resource allowlist、telemetry manifest、retention、budget、executor egress 和 marketplace,但 Runtime 不解析 security.json/MDM 或签发授权。
- [ ] authorization request/receipt 显式携带 `serverScope` 与 resource/command scope,区分 daemon API、extension server、tool server、verification runner 和 remote executor;同 principal 在一个 server 的 grant 不得跨 server 重放。
- [ ] 在 Phase 0 固定的 authority/tenant/principal schema 上定义 service/user、local peer、remote workload 与短期 session credential 的 identity/grant refs,不得在 Runtime event 暴露 credential。
- [ ] RBAC/ABAC 与 separation-of-duty 只通过 authorization request/decision/receipt port 接入;高风险批准的策略与存储由专项实现。
- [ ] tenant namespace 进入 Runtime Event/Artifact/Trust key;Lease/Approval 外部端口必须返回同 tenant receipt,Runtime 做 schema/correlation 校验而不复制其 store。
- [ ] session/artifact metadata 的加密仍属 Runtime Artifact 生命周期;credential metadata、KMS/keyring bootstrap/rotation/revocation/crypto erase 通过专项端口和 receipt 表达。
- [ ] CI/SSH/relay 只在 Runtime 定义 invocation、attestation、Workspace Envelope、lease 和 result receipt schema;runner token/egress/sandbox/credential 强制由专项实现,失败不得回退本地共享执行。
- [ ] session handoff 传递 signed manifest/event head/artifact refs/lease transfer,不复制裸 credential。
- [ ] graceful shutdown 覆盖 signal、stdin EOF、terminal error、uncaught exception、daemon upgrade。
- [ ] startup 先做 Runtime integrity/tombstone scan,并调用 Workspace/Approval ports 校验 lease/decision receipts;未知活跃状态 paused,不自动执行。
- [ ] Runtime GC 只处理 session/artifact refs;workspace、approval 和 orphan process 的实际回收由专项服务执行并返回 receipt。
- [ ] Session retention 建立 fork、handoff、checkpoint、Episode、Artifact 与 legal-hold 引用图;先 dry-run/report,再 archive/export,写 deletion tombstone 后才允许最终清理。存在 descendant、未确认 handoff、活动 writer/lease 或证据引用时拒绝删除,GC crash/replay 必须幂等且 tenant-scoped。
- [ ] exporter delivery 状态区分 accepted/enqueued、durable local spool、sink-acknowledged 与 retention/legal-hold applied;只有绑定 manifest/event range/sink identity 的 terminal delivery receipt 才能声称 SIEM 已接收,且 exporter ack 永远不成为 canonical Event Store 完成前提。
- [ ] 建 Harness Regression CI:session corruption、path escape、policy precedence、credential leak、candidate gate tamper、multi-agent isolation、daemon replay。
- [ ] 将 Phase 8 dependency cooling/admission 与 SecretScanGate 纳入 required CI gate;绕过、规则降级、scanner failure 或只扫描 tracked files 均使 candidate inconclusive/failed,不能由 telemetry redaction 测试代替。
- [ ] 对 Phase 10 GitHub Draft PR provider 与 HumanGateCoordinator 跑真实联合 E2E:短期 audience-bound credential、独立 principal/organization gate、server scope、EpisodeSeal correlation、失败/retry/revoke 均有 receipt;任何 adapter 缺失时 feature 不 advertise。
- [ ] 加入跨租户读取、伪造 principal、越权审批、旧 key/token 重放和 rotation 中断攻击测试。
- [ ] 自动经验只可从 case -> repository rule -> repeated validation -> regression suite -> global rule 逐级提升,不得直接写全局策略。

完成门槛:

- 默认 telemetry 样本不含 prompt、tool output、secret 或完整 env。
- RuntimeActivity、CostTrace 与 TelemetryManifest 对同一 event head 可重建并校验;root/child/late-cost 对账无未解释差额,manifest 外字段和 sink 不会被导出。
- raw forensic bundle 默认禁用,启用时与默认 telemetry 在 store/key/ACL/retention/tenant 上均隔离;关闭或 expiry 后不会继续收集内容。
- managed policy、normalization receipt、principal/tenant/approval/key 与 remote executor 的 schema/port contract tests 全绿;真实 deny precedence、越权防护、key lifecycle 和执行隔离必须再通过专项联合测试。
- dependency cooling、Secret Scan、server-scoped permission 和 Draft PR/human gate 的真实联合测试全绿;scanner/provider/coordinator/credential 任一不可用时对应生产 feature fail closed。
- remote/CI receipt 可关联 workspace、gate、artifact 和 event identity,但本阶段 contract 完成不等于远程 executor 已安全上线。
- Runtime shutdown/restart/upgrade soak test 无 orphan writer 或自动复活 session；tool process/worktree lease 的无孤儿结论必须由专项联合 soak test 证明。
- fork/handoff/checkpoint/legal-hold 引用存在时 session GC 不删除真源;dry-run、tombstone、崩溃恢复和跨 tenant 删除攻击测试全绿。

建议 PR:

1. `runtime: emit privacy-preserving activity cost and audit telemetry`
2. `runtime: define managed identity policy and executor receipts`
3. `runtime: add attested remote executor ports and session handoff schemas`
4. `runtime: harden shutdown recovery GC and harness regressions`

## 8. 阶段依赖与发布里程碑

```text
Phase 0 Protocol
  -> Phase 1 Session Kernel
      -> Phase 2 Workspace Contracts
          -> Phase 3 Security Contracts
              +-> WorkspaceSecurity-Phase0–4（独占实现）-> I2/WorkspaceSecurity-Phase5 集成 -> WorkspaceSecurity-Phase7 verification adapter
              +-> Phase 4 Artifact -> Phase 5 Resource Contracts
              |                   +-> Phase 6 Model/Plan/Context Contracts -> 专项行为
              +-> Phase 7 Orchestrator/Budget implementation（可面向冻结 contract 并行）

[Phase 5/6 + 专项行为 + Extension-M0–Extension-M6 + WorkspaceSecurity-Phase7 + Phase 7 implementation]
  -> production join gate -> Phase 8 Verification/Runtime-M1
       +-> Phase 9 Multi-Agent/Runtime-M2 ------------------+
       +-> Phase 10 Daemon/Clients/Runtime-M3 --------------+-> Phase 11 Enterprise/Remote/Telemetry/Runtime-M4

§0.5 PiAiParityManifest ---------------------> Phase 6 Model/Plan/Context Contracts -> Runtime-M1
```

| 里程碑 | 包含阶段 | 可对外承诺 |
|---|---|---|
| Runtime-M0:Auditable Single Agent Contracts | 0–4 | 单 Agent session、workspace/security refs 与证据协议可验证;这是 contract 里程碑,不承诺真实隔离或强制执行 |
| Runtime-M1:Governed Harness | §0.5 + 5–8 + production join gate | `PiAiParityManifest` 可追踪,Extension-M0–Extension-M6、Plan/Context/Compaction/Memory 行为、WorkspaceSecurity-M5/WorkspaceSecurity-Phase7 adapter、确定性门禁与内置 Browser 独立验证完整 |
| Runtime-M2:Bounded Collaboration | 9 + WorkspaceSecurity-Phase7/WorkspaceSecurity-M6 联合门禁 | 多 Agent DAG、workspace/capability refs 有界且可恢复;真实隔离由专项联合 E2E 证明,不默认远程 |
| Runtime-M3:Headless Runtime | 10 + production composition gate | CLI/TUI 通过同一协议连接 Runtime 真源,版本化协议可供后续 IDE/CI adapter 消费;本阶段不宣称已交付 IDE/CI client。只有持有效 `ProductionCompositionReceipt` 的 capability 才被 advertise,缺真实 adapter 的 mutation/forge 能力保持 unsupported/deny |
| Runtime-M4:Enterprise Runtime | 11 + WorkspaceSecurity-Phase8/WorkspaceSecurity-M6 + Extension-M7 联合门禁 | Runtime activity/cost/Telemetry Manifest/lifecycle 与企业/远程契约完整;managed enforcement、credential、Draft PR/human gate、远程/CI 隔离均有真实联合验收 |

不得为了展示多 Agent 或 Web UI 跳过 Runtime-M0/Runtime-M1。Phase 2/3 contract 冻结后,Worktree/Sandbox/Permission 专项可与 Runtime 的 Artifact、resource/context contract 等独占模块并行;任何涉及共享接线文件的工作都按 §0.6 I0–I7 串行。Phase 7 reducer/budget 可在依赖 contract 冻结后开发独占模块,但其生产激活与 Runtime-M1 必须同时等待 Plan/Context/Compaction/Memory、Extension 和 WorkspaceSecurity join gate。Phase 9 和 Phase 10 可在 Phase 8 后并行实现独占目录,生产启用仍依赖各自消费的真实专项能力。

## 9. 全局验证矩阵

| 测试层 | 必测内容 |
|---|---|
| Unit | schema、hash、reducer、workspace/security refs、budget、state transition;path guard/policy merge 归专项计划 |
| Contract | Event Store、Workspace/Capability ports、Artifact、Model/Plan/Context/Compaction/Memory、Verifier、Control Plane adapter 一致性 |
| Integration | Runtime 使用 fake Workspace/Gateway ports、provider mock stream、resource fake adapter、daemon client;real Git worktree/process/sandbox 归专项联合测试 |
| Fault injection | kill、disk full、torn write、timeout、cancel、network reset、stale lease、slow subscriber |
| Security | Runtime schema 的 receipt replay/redaction/resource confusion/gate tamper;path/symlink、approval/credential/sandbox 绕过归专项计划 |
| Replay | live/replay/snapshot projection digest 一致,重复 resume 无重复副作用 |
| E2E | Runtime 以 fake ports 验证 goal/plan/artifact/verification 契约链;真实 goal -> plan -> edit -> build/test -> verify -> stop/restart 必须同时引用对应专项联合 E2E |
| Cross-platform | Runtime schema/fixture 的路径与 capability 表达;Linux/macOS/Windows 的真实 path/process/lock/sandbox 行为归专项计划 |

持续验证命令基线:

```bash
npm run check
npm test
npm run build
git diff --check
```

若新增模型 catalog 或 provider,额外运行 `npm run generate-models` 并审阅生成物。若某平台 sandbox 不可用,测试结果必须是明确 unsupported/deny,不能以无 sandbox pass。

### 9.1 阶段定向验证与联合门禁

下表命令在对应测试目录创建后执行;每一阶段都必须先跑定向命令,再跑上面的完整基线。`npm test -- <path>` 的完整输出、平台和 test count 一并记录,不得只写“通过”。

| Phase | 定向命令 | 额外联合门禁 |
|---|---|---|
| U0 / §0.5 | `npx tsx scripts/audit-pi-ai-delta.ts --upstream <explicit-pi-path> --commit 3f1762cc7d3af39898aa5d21891335935011287f` + 受影响 provider tests | catalog 变化必须 `npm run generate-models`;manifest adopt/reject/localize、license、RunLedger-side digest 与生成 diff 审阅 |
| 0 | `npm test -- tests/runtime-contracts/schema.test.ts tests/runtime-contracts/canonical-json.test.ts tests/runtime-contracts/module-boundaries.test.ts tests/runtime-contracts/phase-zero-contracts.test.ts tests/runtime-contracts/reference-snapshots.test.ts` | current JSONL fixture;feature-state/current-format/CLI matrix;taint/declassification exact schema;两个 boundary script 必须由 `npm run check` 实际执行 |
| 1 | `npm test -- tests/runtime-contracts/session` | kill/disk-full/torn-write/after-write-before-sync 子进程测试;session/authority stream fencing 与 cross-stream receipt rejection;queue/identity reopen;CLI exact-format rejection/fork |
| 2 | `npm test -- tests/runtime-contracts/workspace-contracts` | fake Workspace port + architecture import deny;不以此宣称真实隔离 |
| 3 | `npm test -- tests/runtime-contracts/security-contracts` | fake Gateway/Approval/Sandbox ports + signed/channel request、anti-replay、rate-limit、taint sink、redaction/replay;不以此宣称生产强制 |
| 4 | `npm test -- tests/runtime-contracts/artifacts` | Phase 4 只跑 fake Workspace/Gateway port、CAS crash/redaction/access contract;真实 checkpoint/rewind/cleanup/access 联合 E2E 在 I2/WorkspaceSecurity-Phase5 后作为 Runtime-M1 join gate,不反向阻塞 Phase 4 contract/Runtime-M0 |
| 5 | `npm test -- tests/runtime-contracts/resource-contracts` | native/browser/instruction taxonomy + Extension-M0 contract consumer;生产能力等 Extension-M0–Extension-M6/Extension-M7 对应门禁 |
| 6 | `npm test -- tests/runtime-contracts/contracts` | taint 跨 context/summary/model-switch fixture + Plan/Context/Compaction/Memory Phase 0 contract consumer;行为等该专项 Phase 1–10 |
| 7 | `npm test -- tests/runtime-contracts/orchestrator` | crash/replay/budget concurrency;Phase 8 前 production `completed` 必须不可达 |
| 8 | `npm test -- tests/runtime-contracts/verification tests/e2e/verification-trust.test.ts` | trusted-base/browser/manifest-seal + WorkspaceSecurity-Phase7 联合 E2E;dependency cooling、Secret Scan、candidate gate tamper;ChangeProposal/human-gate 只跑 fake contract 并记录 behavior unavailable |
| 9 | `npm test -- tests/runtime-contracts/agents tests/e2e/multi-agent-isolation.test.ts` | Worktree/Sandbox/Permission capability 子集、独立 lease/workspace 和侧信道联合 E2E |
| 10 | `npm test -- tests/runtime-contracts/control-plane tests/e2e/daemon-recovery.test.ts` | I6 串行集成;13 类 mutation 的 applied effect/rejected error restart table、atomic revision、queue cancel、uncertain gate、activity replay、ChangeProposal/human-gate durable service、composition minimum/effective matrix downgrade、断线/backpressure/restart/peer identity;缺企业 adapter 时 forge unsupported |
| 11 | `npm test -- tests/runtime-contracts/telemetry tests/runtime-contracts/lifecycle tests/runtime-contracts/managed-policy` | reference-aware GC + WorkspaceSecurity-Phase8、Extension-M7、跨 tenant/credential/forge/remote/CI/harness regression 联合 E2E |

### 9.2 状态证据模板

每个任务或阶段只允许用下面格式回写完成状态;未落入当前目标分支、缺完整基线或只通过 fake contract 的实现保持未完成。

```text
- [x] <任务>
  - commit/worktree: <commit sha + clean/explicit diff paths>
  - targeted: <exact command> -> <platform, N files, N tests, result>
  - full gate: npm run check; npm test; npm run build; git diff --check -> <result>
  - artifacts: <fixture/report/manifest path + digest, if applicable>
  - specialty gate: <plan path + phase + evidence, or N/A>
  - verified_at: <ISO-8601 timestamp>
```

Contract-only 阶段必须在证据中写 `behavior unavailable`。联合门禁未通过时,只能标记 Runtime contract 子任务完成,不得标记里程碑或最终验收完成。

## 10. 风险与决策记录

| 风险 | 处置 |
|---|---|
| 当前格式契约变化导致现有 CLI/TUI 失效 | 先更新 exact contract、fixture 和所有消费者；无法验证的 session 直接拒绝，不提供 adapter、opt-in 或原地转换 |
| JSONL fsync 性能不足 | 先确保安全 barrier,再用 batching/snapshot 优化;不得以吞吐取消 terminal flush |
| hash chain 被有权限进程整体重算 | 区分 local integrity/attestation,用受保护 signer 或外部 SIEM 周期锚定 head |
| Event/Lease/Artifact/Approval 跨存储半提交 | intent -> idempotent durable mutation -> commit event,启动时 reconcile orphan |
| Node 路径 API 存在 TOCTOU | Runtime 只定义 validation/enforcement receipt;descriptor/handle-relative broker 与平台 deny 由专项计划实现 |
| Shell 无法完全解析 | Runtime 只表达 decision/receipt;typed argv、低置信度 ask 与分类器由专项计划实现 |
| Sandbox 跨平台能力不等 | Runtime schema 区分 requested/resolved/effective;probe、fail-closed 与 remote fallback 由专项计划实现 |
| Artifact/telemetry 泄密 | 写前 redaction、默认 metadata-only、forensic 单独加密和授权 |
| 多 Agent 放大成本与冲突 | Verification 先行、root 总预算、独立 worktree、声明式 Artifact merge |
| 延迟 token/USD 账单导致预算小幅超限 | 执行前 reserve 上界,结束 commit/refund,延迟 reconciliation 后停止后续工作 |
| Candidate 操纵测试 | verifier/gate 来自 trusted base 和独立 checkout |
| daemon 成为单点故障 | append-only truth、idempotent command、cursor replay、bounded recovery |
| 参考仓库继续变化 | snapshot 仅作证据;每个移植 PR 重审上游行为和许可证 |

## 11. 最终验收清单

### Session Integrity

- [ ] 每个 current session 或 authority/tenant lifecycle stream 都有独立连续 sequence、payload digest 和完整 hash chain,跨 scope 只通过显式 head/ref 关联。
- [ ] integrity 与 attestation 分开报告;给定可信 anchor 可定位链内修改,无 anchor 不宣称不可抵赖。
- [ ] 中间损坏、未知 schema、hash 断链均停止 resume。
- [ ] stop tombstone 后任何启动路径都不自动复活。
- [ ] snapshot/checkpoint/fork/rewind 与 canonical events 可交叉验证。
- [ ] invalid compaction window/UUID、损坏 world-state、patch-without-full、missing replacement 与 checkpoint 外坏行均停止恢复;prepared/durable/installed 三态和四个 crash point 不产生半安装 history。
- [ ] tool terminal event durable 后才进入下一模型调用。
- [ ] append accepted 与 durable receipt 明确分离;after-write/before-sync 被归类 uncertain 并关闭 mutation gate,不会因重试重复事件或副作用。
- [ ] session.created 的 initialGoalId/rootAgentId 在 reopen/resume/fork 规则下稳定,queue 的 payload/kind/order/claim/cancel 可完整重放。
- [ ] feature-state × current-format × CLI action 矩阵有 golden tests;不支持的 session 输入只有一个 durable rejection outcome,永远不会被误判为可 resume。
- [ ] forensic salvage 始终只读并生成含 source digest、坏 cursor/line、可恢复边界和 unattested 状态的 Artifact 报告;修复写入新 session,不会原地截断或把 salvage 结果当作可信完整历史。
- [ ] task/agent/command/runtime-replacement/handoff/deletion 的每个 durable 状态均有 exact canonical event、expected revision、terminal outcome 与 reducer fixture;不存在 sidecar/cache/process state 才能恢复的隐藏真源。
- [ ] session handoff/deletion 只以 authority/tenant lifecycle stream 为真源,SessionProjection 的 lifecycle head ref 可验证;删除后仍保留绑定 final head/reference graph/legal-hold 的 tombstone,GC crash/replay 不会把已删 session 误判为从未存在或重新复活。

### Workspace Contract 与专项联合门禁

- [ ] Runtime 定义穷尽的 Workspace Envelope、Binding/Lease/Validation/Checkpoint refs、event payload schema 和 projection。
- [ ] Runtime contract 只依赖 protocol 基础类型,fake Workspace port 可驱动 replay,没有 Git/fs/path guard/worktree manager 实现。
- [ ] Runtime 只把可验证 receipt 与 ID 传递给 Orchestrator、Artifact、Verification 和 Multi-Agent,不复制 workspace 状态真源。
- [ ] [联合] 每个 Tool Call 的 envelope、canonical path、branch/base/owner/lease、TOCTOU broker、takeover 和 cleanup 已按专项计划实现与 E2E 验收;未通过前不宣称 workspace isolation。

### Capability Contract 与专项联合门禁

- [ ] Runtime 定义 CapabilityRequest/Decision、ApprovalTicket/Receipt、SandboxProfile/ExecutionReceipt、event schema 和 projection。
- [ ] Runtime contract 只定义 Gateway/Approval/Sandbox ports,不包含 policy merge、prompt/store、shell classifier、credential injection 或 backend spawn。
- [ ] approval 以 authority/tenant/session/runtime generation/turn/toolCall/approval/request digest/decision revision 复合绑定;policy deny、user reject/cancel/follow-up/channel failure、expiry/revoke、sandbox requested/resolved/effective 和脱敏规则有 contract/replay tests。
- [ ] approval/Guardian evidence 被截断、缺失或 ref 不可解析时只能 deny/cancel/转人工,永远不能形成 allow receipt。
- [ ] Capability request 具备 authenticated channel/signature、nonce、expiry、key revision、anti-replay 与独立 Gateway rate-limit receipt;BudgetGuard 不能替代入口限流。
- [ ] [联合] 所有副作用经 Gateway、`deny > ask > allow`、CLI/TUI 审批恢复、secret 最小授权与 sandbox fail-closed 已按专项计划实现与 E2E 验收;未通过前不宣称 capability security。
- [ ] Runtime 中立 resource schema/receipt/port 可表达并验证 exact identity、digest、capability、expiry 与 revocation 绑定,绑定变化后的旧 receipt fixture 必须失配。
- [ ] [联合] 具体发现、信任、重新审批、执行和 UI 只按扩展计划验收,不得以 Runtime contract 测试通过替代。

### Artifact、Checkpoint 与 Episode Lifecycle

- [ ] CAS 对 blob/metadata 做原子写入、digest 校验、引用隔离、TTL/pin/legal-hold 和 crash reconciliation。
- [ ] 默认写前脱敏;source receipt、stored digest、transform/redaction policy 分开表达,forensic raw 只能显式授权、加密、限时保存。
- [ ] Artifact 读取重新校验 session/workspace/capability refs;key provider 不可用时不会退化到明文 key 或未经授权 raw content。
- [ ] CompositeCheckpoint 能关联 event cursor、workspace snapshot、dirty/untracked/conflict 状态和完整性,partial 状态不会被宣称可完整 rewind。
- [ ] Episode Manifest 的每个 event head、workspace、artifact、permission、cost 和 verification ref 均可解析、校验和按 retention 策略处理。
- [ ] Artifact/export 的 accepted/enqueued、durable、content-verified、externally acknowledged 状态不混淆;非 terminal upload 永远不能形成 Episode evidence 或 cleanup 授权。

### Dynamic Resource Supply Chain

- [ ] Resource identity 使用 kind/qualified id/version/source/digest,display name 或模型猜测不能成为安装/执行路由键。
- [ ] canonical path containment 只证明 locator 解析边界;只按路径或 home 来源记录的 trust 不能替代 publisher/signature/version/content digest 与 capability receipt。
- [ ] provenance、trust、activation、approval/revocation、capability 和 exposure 均有独立状态;配置/命令/资产/digest 变化使旧 receipt stale。
- [ ] Skill body/assets/script、MCP server/tool、Hook 与 Plugin component 权限分离,脚本/子进程全部经过 Gateway 与受限 executor。
- [ ] 每次动态 tool invocation 只有一个 durable terminal;缺失/重复 terminal、terminal 后 progress 和 stale adapter generation 均 fail closed。
- [ ] tool/resource handshake 绑定 protocol/schema、session、generation 与 sequence;peer 自报 capability/scope/default Read 只作 annotation,不能成为授权事实。
- [ ] native/browser/instruction 等 resource kind 精确区分;Browser 的 DOM/script/download/cookie/network capability 可独立授权,Instruction 变更需要 taint/provenance 与 separation-of-duty receipt。
- [ ] Issue/PR/comment/webhook/web/MCP/repo instruction 的 InputSourceRef/TaintLabel 经 context、compaction、model switch、delegation、handoff、Artifact 一直传播到 Gateway sink;无有效 DeclassificationReceipt 时不能因摘要或模型重写丢标。
- [ ] [联合] Plugin/MCP/Skill/Hooks 专项对 exact resolution、publisher/signature、staging/probe、cooldown、rollback、UI 和 lifecycle 完成相应门禁。

### Verification Evidence

- [ ] Goal complete 需要 trusted baseline 上的结构化 VerificationResult。
- [ ] Builder/Reviewer 自述不能形成 pass。
- [ ] model reviewer 的普通文本、markdown/伪 JSON、parse fallback、截断或跨 candidate 输出只能形成 finding candidate/`inconclusive`,不能签发可信 pass。
- [ ] Finding 有完整生命周期和 reverification。
- [ ] Episode Manifest 可解析到 event head、workspace、artifact、permission、cost 和 verification。
- [ ] Artifact 可说明 source-to-stored transform、redaction policy 与证据可见性,不会把脱敏 digest 冒充原始证据。
- [ ] EpisodeManifestBody -> manifest commit -> EpisodeSeal -> completed terminal event 无自引用且可 crash reconcile;半提交状态不会解锁 completed。
- [ ] Browser gate 的 screenshot/DOM/console/network evidence 可关联可信 gate、origin、profile 和 candidate identity;旧证据或伪造输出不能形成 pass。
- [ ] Browser provider 由独立 verification-runner 持有,每次 launch/network/download/cookie 访问都有 Workspace/Gateway/Sandbox receipt;backend 不可用时明确 unsupported/deny,不会宿主直跑。
- [ ] DependencyAdmissionPolicy 对来源、digest、lockfile、cooling period 和 lifecycle script fail closed;SecretScanGate 覆盖 diff、tracked/untracked manifest、Artifact 与生成配置,scanner failure 或规则被 candidate 篡改时不能形成 pass,证据不含 secret 本文。
- [ ] 独立 Test Generator 不读取 Builder 私有 reasoning、不修改 trusted gate、不自签 pass;结构化 ReviewEvidence 绑定目标 commit/diff、diffReadProof、inspected files、反向审计假设与 evidence refs,缺失或跨 commit 复用时只能 inconclusive。
- [ ] verified ChangeProposal 只可由 Gateway 授权、使用短期 audience-bound credential 的已注册 forge provider 创建绑定 EpisodeSeal 的 Draft PR;merge/deploy 默认等待独立 human/organization gate,Agent/Builder/proposal issuer 不能自批,跨 server/tenant/revision 重放失败。

### Model/Plan/Context Contract Ownership

- [ ] §0.5 `PiAiParityManifest` 固定 upstream/base/digest、adopt/reject/localize、known delta 与验证证据;provider drift 未 reconcile 时 Phase 6/Runtime-M1 不得完成。
- [ ] Phase 6 contract allowlist 只包含公共类型、schema、event payload、fixture 和 contract tests,没有 router/service/store/UI 行为。
- [ ] 专项实现只通过 public exports 消费契约,没有重复类型、私有 event payload 或反向依赖。
- [ ] Runtime contract 与专项 behavior 各有独立 commit/验证证据,共享集成文件均通过串行 handoff 修改。
- [ ] Model/Plan/Context/Compaction/Memory 行为是否完成只引用专项计划的验收状态,不以 Phase 6 contract 通过代替。

### Model、Plan、Context、Compaction 与 Memory 行为

- [ ] Compatibility Manifest 覆盖 tool/reasoning/adapter-state/compaction/context/profile/regression;不兼容 model switch 只能 fork。
- [ ] Compatibility Manifest 任一必需 hash 缺失或 unknown 时也视为 incompatible,不得把“未检测到变化”解释为兼容。
- [ ] Turn/Session/Workspace/User/Organization 五层 context 有明确 trust/taint/provenance/budget,provider 私有 reasoning state 不跨不兼容 adapter 泄漏。
- [ ] compaction 前后校验 goal/plan/workspace/changed-files/pending-approval/verification 等 invariant,replacement-history Artifact/digest/previous link 与 surviving suffix 可验证;失败保留原上下文并暂停。
- [ ] compaction 先 durable commit replacement/invariant/previous-link,再按 expected revision CAS 安装 live projection;任一边界 crash 后都只有旧投影或完整新投影。
- [ ] derived/untrusted 内容不能自动发布为持久 Memory;proposal/diff/approval/TTL/revoke/delete/search/injection 均可审计。

### Deterministic Orchestrator 与 Budget

- [ ] Goal transition table、required evidence、actor 和 terminal semantics 穷尽;模型、TUI 和普通 adapter 均不能直接写 completed。
- [ ] Plan/build/test/security/review/remediation/reverification/human gate 顺序由系统状态机决定,crash/replay 后保持同一 phase、queue 和 budget projection。
- [ ] token/USD/time/tool/network/storage/artifact/verification/agent 预算执行 reserve/commit/refund;hard stop 后无未预留新副作用。
- [ ] retry/loop breaker 对 rate limit、overflow、重复 tool signature、无进展和 uncertain side effect 有确定结果;不确定副作用进入 paused。
- [ ] parallel tool batch 先完成全批 capability/workspace/resource preflight,仅独立调用并发;completion-order terminal 与 source-order model result 在 replay 后保持确定。
- [ ] Task DAG 无环、依赖完整、expected Artifact 明确;partial/failed child 或 merge conflict 不会使父 Goal 自动完成。
- [ ] Multi-Agent 默认 depth/children/total-agent/total-cost/per-agent-tool-call 上限均生效,缺失 root budget profile 时不允许 Spawn;更低优先级配置不能放宽组织上限,interrupted resident 在 durable partial/paused snapshot 或可重建 head 形成前不得 eviction。

### Activity、Cost 与 Telemetry

- [ ] Phase 10 `RuntimeActivity` 对 session/goal/task/tool、waiting permission、nested agents、last durable cursor 与 heartbeat freshness 有稳定 schema;单 Agent 和 Multi-Agent live/replay/query projection digest 一致。
- [ ] `CostTrace` 覆盖 token、USD、wall time、tool、network、storage、verification、retry、root/child Agent 与 reserve/commit/refund;迟到 provider 账单可 reconciliation,Episode 对账无未解释差额。
- [ ] `TelemetryManifest` 固定允许字段、sink、采样、redaction policy digest、retention、forensic 开关、tenant scope 与 exporter identity;startup/policy 变更会验证,manifest 外字段或 sink fail closed。
- [ ] raw request/response/tool/reasoning trace 使用独立高敏 store/key/ACL/tenant/retention,默认关闭且不能进入默认 OTel/SIEM spool。
- [ ] canonical event/activity/cost 到 OTel/SIEM 的映射有完整字段覆盖和脱敏 fixture;exporter failure 只产生 bounded health signal,不阻塞或反向补写 canonical Event Store。
- [ ] telemetry delivery 区分 accepted/enqueued、durable spool、sink acknowledged 与 retention/legal-hold applied;只有 terminal delivery receipt 才能声称 SIEM 已接收。

### Control Plane 与 Lifecycle

- [ ] handshake、typed error、expected revision、idempotent command、at-least-once cursor 和 durable consumer checkpoint 语义有 contract/E2E 证据。
- [ ] 13 类 mutation 的成功 effect 与 typed rejection 都能仅凭 canonical claim+terminal events 在重启后逐字段恢复;cache/resolver/waiter 清空不改变重复 command 的返回值,缺失或伪造 terminal 只进入 reconciliation/corrupted且不重放副作用。
- [ ] command claim/revision compare/event append 在单 writer 临界区完成;turn/queue 使用各自 revision,stale command 不会自动改绑。
- [ ] Queue list/cancel 是 durable API;Ctrl-C/dequeue、turn 尾与 restart 竞态不丢输入、不重复消费、不把失败伪装为空队列。
- [ ] daemon feature advertisement 来自可校验 ProductionCompositionReceipt 的 closed feature -> required adapters matrix;Event Store/model/Workspace/Gateway/Approval/Sandbox/Artifact+key/resource/verifier 以及对应 feature 所需 policy/credential/forge/human-gate/executor/exporter 任一缺失时,该 feature 明确 unsupported/deny且不生成假 receipt。
- [ ] composition receipt 绑定仓内冻结的 protocol-minimum matrix digest 与 effective policy ref/digest;effective requirements 只能相等或更窄,未知矩阵、伪 digest、删 minimum adapter 或 policy downgrade fixture 均拒绝。
- [ ] slow consumer/backpressure/typed overload/disconnect/resync、idle unload/resume、daemon crash/restart 和 session replacement 不丢事件、不重复副作用,旧 handle 失效。
- [ ] 本阶段交付的 TUI/CLI 只消费同一 projection/API,TUI 不再私有持有 queue/retry/compaction/tool/session 真源;后续 IDE/CI adapter 必须消费同一版本化协议,但不以本计划宣称其 client 已交付。
- [ ] shutdown 先关 mutation gate,再 bounded drain writer/tool/child/exporter;startup 先校验 integrity/tombstone/外部 receipt,未知状态只进入 paused。
- [ ] §0.6 I0–I7 的 baseline/owner/允许路径/handoff commit/完整验证记录齐全;controller、CLI、TUI 与 composition root 没有并行双 owner 或自动冲突选择合并。

### Enterprise、Remote 与 CI

- [ ] managed policy 优先级、principal/tenant、RBAC/ABAC、separation-of-duty 和 effective receipt 已由专项实现;低优先级配置不能覆盖 deny。
- [ ] managed policy 每字段保留 source/winner/loser/deny-union/normalization/fallback receipt;MDM/cloud/system 来源或 effective value 无法验证时 fail closed。
- [ ] server-scoped permission 明确区分 daemon API、extension/tool server、verification runner 与 remote executor;grant 绑定 server/resource/command scope,不能跨 server、tenant 或 generation 重放。
- [ ] credential 只以最小、短期、audience-bound grant 注入 executor,不进入 event、Artifact、日志、telemetry 或无关子进程环境。
- [ ] CI/SSH/relay invocation 绑定 workspace/lease/gate/artifact/event/principal/tenant/attestation;任一验证失败不回退本地共享执行。
- [ ] fork PR、Issue/评论/webhook、candidate workflow/config 和依赖脚本的 taint/egress/secret 攻击矩阵通过;trusted action/gate/policy 均固定 digest/commit。
- [ ] CI required gates 明确包含 dependency cooling/admission 与 Secret Scan;禁用 scanner、缩小到 tracked-only、规则降级或依赖来源漂移都使构建失败/inconclusive,不能由普通 lint 或 telemetry redaction 冒充通过。
- [ ] 默认 OTel/SIEM 与 RuntimeActivity 只含允许的 metadata;forensic tracing 显式、限时、加密、可审计且可被 managed policy 禁止。
- [ ] Session GC 遵守 fork/handoff/checkpoint/Episode/Artifact/legal-hold 引用图与 tenant 边界;先 dry-run/archive/tombstone,存在 descendant 或未确认 handoff 时拒绝删除。

### Harness Regression

- [ ] 全维度 BudgetGuard 可 hard stop 并保留 partial result。
- [ ] Multi-Agent 深度、数量、并发、权限和 workspace 均受限。
- [ ] daemon 断线/restart/replay 不丢失、不重复副作用。
- [ ] 默认 OTel/SIEM 样本无 prompt、tool output、secret 和完整 env。
- [ ] dependency poisoning、secret in untracked/generated/artifact、server-scope replay、forge credential/revoke 和 human-gate separation-of-duty 回归集全绿。
- [ ] authority/tenant/principal 从 current genesis 起贯穿 Event、Lease、Artifact、Approval 和 Trust key。
- [ ] `npm run check`、`npm test`、`npm run build`、`git diff --check` 全绿。

只有以上清单全部完成并附证据,RunLedger 才能把本计划状态改为“完成”。在此之前,对外应准确描述为“最小 Agent Runtime 正在升级为可治理 Harness”,不能把未实现的安全与验证边界写成现有能力。
