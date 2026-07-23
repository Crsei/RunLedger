# RunLedger 可治理 Agent Harness Runtime 主计划

> 文档状态:完整计划,当前权威执行入口;实现状态:总体未完成,但 §0.5、Phase 0/2/3与Phase 5 Resource v2 contract已实现,Phase 1/4/6–11 为部分实现或仍缺联合生产门禁;Phase 复选框只有附当前目标分支/工作树的逐项证据后才能在对应拆分文档中勾选
> 基线日期:2026-07-22
> 当前实现复核:2026-07-24T01:11:34+08:00,`worktree/governed-agent-harness-runtime@a6416e086457db6bb3f438d9a3cab24fd9e953d1` + 当前交付工作树
> 适用范围:`src/runtime/`、Runtime-owned `src/storage/`、`src/cli/`、`src/tui/`、`src/daemon/` 与对应测试;三个外围专项已按冻结说明转为只读依赖
> 上游设计输入:[`00-reference.md`](00-reference.md)
> 外围专项冻结说明:[`06-specialty-implementation-freeze.md`](06-specialty-implementation-freeze.md)
> 历史计划:[`01-minimum-runtime-scaffold-plan.md`](01-minimum-runtime-scaffold-plan.md)、[`02-agent-loop-resurrection-plan.md`](02-agent-loop-resurrection-plan.md)、[`03-tool-system-plan.md`](03-tool-system-plan.md)
> pi-ai 移植基线:[`../providers/01-pi-ai-migration-plan.md`](../providers/01-pi-ai-migration-plan.md)
> 扩展实现计划:[`../plugin-mcp-skill-hooks/01-implementation-plan.md`](../plugin-mcp-skill-hooks/01-implementation-plan.md)
> Plan/Context/Compaction/Memory 专项实现:[`../plan-compact-memory/01-implementation-plan.md`](../plan-compact-memory/01-implementation-plan.md)
> Worktree/Sandbox/Permission 专项实现:[`../worktree-sandbox-permisson/00-worktree-sandbox-permission-plan.md`](../worktree-sandbox-permisson/00-worktree-sandbox-permission-plan.md)

## 0. 文档定位与执行规则

本文件把四个参考仓库的可复用机制、RunLedger 当前实现和 `00-reference.md` 的治理要求收敛为一个可执行建设计划。`01`–`03` 继续保留为历史实施记录,不再承担未来 Runtime 的状态跟踪。本文件是后续 Runtime PR 的唯一总入口和状态汇总;Phase 详情与逐项证据只记录在 [`harness/README.md`](harness/README.md) 所列拆分文档中。其中已列出专项计划的领域,本计划只跟踪公共契约和跨域依赖,具体实现状态以各专项账本为准。

执行规则:

- 每次只推进一个阶段内可独立验收的 PR 边界,不得用一次重写跨越多个安全边界。
- 每个 PR 必须在对应 Phase 文档的复选框后补充 commit、测试命令和结果,并在状态变化时同步 §0.0 汇总;没有证据不得标记完成。
- Provider/API/Auth 已大体完成 pi-ai 移植,后续只做差异同步与 Model Compatibility 扩展,不重新移植整套 provider。
- v1 始终只读;v2 在 `sessionV3=off/opt_in` 保持当前 read/write,推进到 `default/required` 后转只读并显式 migrate/fork-to-v3。所有新治理语义只进入 v3,不得在旧记录上伪造哈希、工具参数、reasoning 或验证结果。
- Event Store 是 session/goal/orchestration 状态的唯一事实源。TUI、CLI、daemon、model history、activity、cost 和 verification status 都是 projection;外部权威存储的边界见 §3.1。
- 在单 Agent 的 Session、Workspace、Capability、Artifact 与 Verification 边界稳定前,不得默认启用多 Agent 或远程执行。
- 任一安全组件初始化失败时 fail closed,不得静默退化到共享 workspace、无 sandbox、AllowAll 或未验证资源。
- 本计划文档集的状态真源是当前目标分支上的 §0.0 汇总、对应 Phase 文档和已记录 commit/test evidence。其他 worktree 的未合并实现、口头报告或局部定向测试都不改变对应复选框;合入当前目标分支并重新验证后才能回写状态。
- Plan/Context/Compaction/Memory、Plugin/MCP/Skill/Hooks、Worktree/Sandbox/Permission 已按 [`06-specialty-implementation-freeze.md`](06-specialty-implementation-freeze.md) 在 `81556ac` 冻结。后续 Wave 只实现 Runtime 自有路径;冻结能力不足时保留 `unsupported/deny`,不得跨域补实现。

### 0.0 当前实现状态快照

本表是对当前目标分支代码、生产接线、公开导出和测试的状态汇总,用于纠正旧基线中“只有 scaffold”或“整类能力不存在”的过时描述。阶段任务仍按其完整语义验收:模块存在、fake adapter、局部 E2E 或进程内 seam 不能单独关闭生产联合门禁,因此下表不会机械地把 343 个正式任务全部改成 `[x]`。

当前复核结果:`npm run check` PASS;`npm test` 为 263 files / 1737 tests PASS,另有 1 个 opt-in live test 默认跳过;`npm run build` 与 `git diff --check` PASS。`live-deepseek-child-runtime.test.ts` 本轮未联网重跑,其 live PASS 只引用 `e741c88` 留存证据。Phase 3 strict v2 与 authenticated local current-head binding 已闭合;W1-A2/A3 保持 completed。Runtime-M0 继续受 W1-B、W1-J 与 W1-G 门禁约束。

| 范围 | 当前实现状态 | 已有代码/测试证据 | 尚未关闭的边界 |
|---|---|---|---|
| §0.5 pi-ai parity | 已实现 | parity manifest、只读审计脚本、delta/parity tests 均在当前分支;固定 snapshot 审计覆盖 164/164 source files 与 72 catalog files | Qwen 等差异按 manifest 明确 defer/adopt/reject,不是隐式 parity;后续 upstream 漂移仍需重算 |
| Phase 0 | contract/边界基线已实现 | v3 IDs、catalog、exact payload/schema、hash/canonical JSON、taint、threat model、feature matrix与两条 boundary script均已接入`npm run check` | 历史 I0–I7 没有逐窗口 handoff 记录,不能据此关闭最终串行集成验收 |
| Phase 1 | 已实现 | single-writer Event Store、accepted/durable barrier、strict replay/hash、queue、snapshot、stop、fork、migration、bounded unattested salvage、writer lease、restore dependency registration、create/fork publication staging、crash terminal 与 backend conformance;Phase 清单已逐项勾选 | salvage 到受授权 CAS Artifact 仍归 W1-B/Phase 4,不属于 Phase 1 完成声明 |
| Phase 2 | contract 已实现 | Workspace envelope/binding/lease/validation/checkpoint events、projection/reducer与 architecture/contract tests | 真实 Git/worktree/lease/TOCTOU 行为已冻结为外部依赖,未完成项不由 Runtime 接管 |
| Phase 3 | contract 已实现 | exact v2 Capability/Approval/Sandbox/taint/rate-limit 数据合同、ports、projection/reducer;local channel 绑定受信 session current head,remote 保持 signature verifier;approval terminal 复核 runtime generation/turn/toolCall 复合相关性 | pending Approval 跨重启、真实 actor/OS peer identity、完整 Gateway/Sandbox/credential 强制行为仍为冻结外部缺口 |
| Phase 4 | 大部分实现 | Artifact CAS/metadata/redaction/keyring/forensic/retention/access、Episode/external delivery、Artifact-backed queue与 physical checkpoint tests | salvage-to-CAS adapter、完整生产访问/GC/联合恢复门禁仍未关闭 |
| Phase 5 | v2 contract completed; specialty behavior frozen/unavailable | Resource v2 identity/provenance/approval/Skill facet/Hook transform/MCP annotation、完整 ports、legacy-v1显式只读导入与Extension consumer回归 | Extension M1/M4/M5 主体和 M2/M3/M6/M7 部分实现继续冻结;CLI/TUI/installer/runner/store与剩余行为不由 Runtime 接管 |
| Phase 6 | 公共 contract 已实现 | model/plan/context/compaction/memory types/schema/events/fixtures、ownership与 public-surface tests | router/context/plan/compaction/memory 核心已有窄证据并已冻结;工具/UI/overflow/完整生产生命周期缺口不由 Runtime 接管 |
| Phase 7 | 主体实现,发布门禁未关闭 | Orchestrator、Goal/Task canonical truth、queue/save-point、retry/loop breaker、BudgetGuard与 agent-loop 接线 tests | 完整 prompt-to-verification 生命周期、全维预算与 Runtime-M1 production join gate 未完成 |
| Phase 8 | 部分实现 | Verification core、trusted baseline、dependency/secret scan、review/finding、EpisodeSeal、keyring issuer、runner/browser adapter与 trust tests | Browser 联合 E2E 仍使用受控测试替身;production forge/Draft PR/HumanGate 与完整 prompt 生命周期缺失 |
| Phase 9 | 部分实现 | durable Agent graph、Supervisor、delegation、Workspace/Budget/authority sidecar、internal process-resident child host与 deterministic/opt-in live happy path | executable child factory 仍为 internal/test-injected seam且未稳定导出;activation/completion process-local,CLI/daemon/Control Plane无 spawn/feature row,真实 Gateway/Sandbox/Verification、cold takeover与`stop_uncertain`未闭合 |
| Phase 10 | 部分实现 | versioned Control Plane、13 类 mutation restart、daemon/stdio、queue/activity、composition receipt、runtime generation与 recovery tests | OS peer identity和真正 listener、部分 turn/approval/artifact/queue/forge/human-gate production ports、idle replacement与全功能 advertisement仍返回 unsupported |
| Phase 11 | 部分实现 | Activity/cost/Telemetry Manifest/forensic、identity/executor contracts、startup/shutdown/GC与多轮 durability hardening | managed enforcement、credential/forge/human gate、remote/CI、完整 child cold recovery/process-tree authority与跨域 fault matrix未完成 |
| Runtime-M0–M4 | 均未正式关闭 | 各阶段已有大量可复用实现和 scoped evidence | M0 尚需 Phase 1/4 逐项验收;M1–M4 各自的 production join、专项联合门禁和最终清单仍未满足 |

### 0.1 与 Plugin/MCP/Skill/Hooks 计划的强制边界

当前 Runtime-only 实施期间,本节原有的并行开发/交接规则被 [`06-specialty-implementation-freeze.md`](06-specialty-implementation-freeze.md) 收紧为“Extension 全域只读、Runtime 仅消费公开面”。下列 owner 划分继续用于解释架构和未来显式解冻,不授权继续完成 Extension-M6/M7。

本计划只拥有 Runtime 通用协议、数据结构、schema、event payload 和 adapter port。它不实现任何 Plugin/MCP/Skill/Hooks 的发现、解析、信任存储、进程生命周期或用户控制面。具体实现及状态账本统一归属 [`../plugin-mcp-skill-hooks/01-implementation-plan.md`](../plugin-mcp-skill-hooks/01-implementation-plan.md),不得在 `src/runtime/resources/` 下再造第二套实现。

为避免与本计划发布里程碑混淆,下文把该专项的 `M0`–`M7` 统一写作 `Extension-M0`–`Extension-M7`;本计划自身只使用 `Runtime-M0`–`Runtime-M4`。

| 边界 | Runtime 计划拥有 | 扩展计划拥有 |
|---|---|---|
| 数据契约 | `ResourceIdentity`、provenance、digest、trust/activation state、approval receipt、tool descriptor/invocation/result、snapshot、lifecycle event、capability claim | Plugin manifest、Skill frontmatter、Hook/MCP 配置和领域状态的具体 schema |
| 端口 | exact resolve、snapshot provider、invocation、event sink、capability gateway 的中立接口 | `ExtensionManager` 及实现这些端口的 adapter |
| 安全执行 | 定义 raw invocation、canonical input、required claim 与 Gateway receipt 的组合契约；Gateway 行为实现归 §0.2 专项计划 | Hook/MCP 子进程、Skill 正文/资产/脚本、Plugin component 的发现和执行编排,全部消费受限 executor |
| 持久化 | v3 event envelope 与 receipt 引用结构 | extension enable/trust/config 状态文件及内容 fingerprint |
| 用户面 | Runtime 通用 approval/session/control-plane 协议 | plugin/mcp/skill/hooks 的 CLI/TUI/doctor/reload 操作 |

并行实施规则:

1. Runtime 线只新增 `src/runtime/resources/{types,schemas,ports,events}.ts` 与 `tests/runtime-v3/resource-contracts/`,不得新增 manager、loader、installer、client、runner、catalog 或 trust store。
2. 扩展线只修改 `src/extensions/**`、`tests/extensions/**` 和 `tests/fixtures/extensions/**`,通过 Runtime port 编译,不得反向修改 Runtime 契约来迁就实现。
3. `src/runtime/{agent-loop,types,tool-registry,tool-authorization,interactive-session-controller}.ts` 是跨专项串行集成面。扩展线先在 `src/extensions/integration/**` 产出 adapter,只有取得记录过的集成窗口后才由单一所有者修改；不得与 Runtime contract、Worktree/Sandbox/Permission 或其他专项并发修改。
4. `package.json` 和 `package-lock.json` 属于扩展计划 Extension-M0 的串行 dependency handoff:Runtime 线先交出 dependency HEAD,扩展线以一个独立提交加入精确依赖,随后双方以该提交为基线。`src/storage/{paths,settings-manager}.ts`、`src/cli/**`、`src/tui/**`、`src/index.ts` 属于 Extension-M6 串行集成面;Runtime 后续阶段基于 handoff commit 继续,不得并发改同一文件。
5. 若契约确需变更,先由 Runtime 线提交 schema 版本升级和 contract tests,再由扩展 adapter 跟进。不得在同一提交同时改两侧实现,也不得复制类型形成漂移的双真源。

### 0.2 与 Worktree/Sandbox/Permission 计划的强制边界

当前 Runtime-only 实施期间,`src/security/**`、`src/worktree/**`及冻结说明列出的专项 storage/tests 均只读。Runtime 可以消费既有 adapter/receipt并实现 fail-closed integration,不能继续完成 Approval recovery、真实 Sandbox、persistent grant、enterprise credential/remote 等专项任务。下列规则仅作为未来显式解冻时的 ownership 依据。

对 workspace/worktree、permission/approval、sandbox 三组交叉领域,本计划只交付 Runtime 可消费的规范化数据结构:

- Runtime ID、`WorkspaceExecutionEnvelope`、workspace/lease/checkpoint 引用与投影结构;
- capability/permission/approval/sandbox 决策、ticket、receipt 引用类型;
- v3 event name、payload schema、reducer 输入/输出和 control-plane command/query schema;
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

1. Runtime 线独占 `src/runtime/protocol/v3/**` 与对应 contract tests,不得 import `src/security/**` 或 `src/worktree/**`,不新建 `src/runtime/workspace/**` 或 `src/runtime/capability/**` 行为实现。
2. 安全实现线独占 `src/security/**`、`src/worktree/**`、`tests/security/**` 和 `tests/worktree/**`,实现并验证 Runtime contract,不重新定义 envelope、decision、receipt 或 event 联合。
3. `src/runtime/{agent-loop,execution-env,tool-context,tool-authorization,interactive-session-controller}.ts`、`src/runtime/ledger/types.ts`、`src/storage/{paths,session-codec}.ts`、`src/cli/**` 和 `src/tui/**` 是串行集成面。Runtime contract 与安全实现各自完成后,由专项计划的集成阶段修改;不得与其他专项集成提交并发。
4. Runtime 事件契约拥有 event name/payload schema;专项实现拥有发射时机、enforcement receipt 的产生和外部存储。契约变更先提交 schema/version 与 fixture,再更新 adapter。

### 0.3 与 Plan/Context/Compaction/Memory 计划的强制边界

当前 Runtime-only 实施期间,model router、Plan、Context、Compaction、Memory 行为与专项 storage/tools/tests 以冻结基线只读。Runtime 只允许修改自己的 request/session/controller/composition adapter;缺 `/compact`、Plan approval、overflow/fork/rewind 或 Memory 用户生命周期时不得在 Runtime 目录重建。下列原始并行规则只供未来显式解冻使用。

本计划 Phase 6 只生成 Model Compatibility、Plan Mode、Context、Compaction 与 Memory 接入 Runtime 所需的中立数据结构、TypeBox schema、v3 event payload、fixture 和 contract tests。router、reducer、service、store、算法、工具、TUI/CLI 与 agent-loop/controller 接线统一归属 [`../plan-compact-memory/01-implementation-plan.md`](../plan-compact-memory/01-implementation-plan.md),Phase 6 的“完成”不能代表专项行为已实现。

| 边界 | Runtime Phase 6 拥有 | Plan/Context/Compaction/Memory 专项拥有 |
|---|---|---|
| 公共类型 | model profile/route decision、mode/plan ref、context receipt、checkpoint、memory record/proposal/search receipt | 不复制类型,只通过 public export 消费 |
| schema/event | TypeBox schema、v3 payload/catalog、版本栅栏、bounded metadata | event 生成时机、状态迁移、intent/commit/recovery |
| 行为 | 无 | manifest loader/router、ContextEngine、PlanModeService、CompactionService、MemoryService |
| 存储/用户面 | 只引用 Artifact/Approval/Workspace 契约 | plan/memory store、index、tools、TUI/CLI、controller/agent-loop 接线 |
| 测试 | schema round-trip、golden fixture、unknown-version/invalid-bound contract | reducer/service/store/security/recovery/integration/E2E |

并行实施规则:

1. Runtime 线独占 `src/runtime/{model-routing,modes/plan,context}/**/{types,schema}.ts`、`src/runtime/protocol/v3/{events,schemas}.ts` 中对应 payload/catalog 和 `tests/runtime-v3/contracts/**`;具体 allowlist 见 Phase 6。
2. 专项线独占上述目录中除 contract allowlist 外的行为文件,以及专用 storage/tool/TUI 组件和行为测试。不得在专项 PR 顺手修改 contract 文件。
3. `src/runtime/{agent-loop,interactive-session-controller}.ts`、`src/models.ts`、`src/models-store.ts`、`src/cli/**`、`src/tui/**`、`src/index.ts` 是串行集成面。专项先在新模块和 adapter 中完成行为,只在对应 Runtime 前置 contract 冻结后安排单一所有者的集成 PR。
4. 契约变更时,先在本计划 Phase 6 登记 schema/version/fixture 变更并提交 contract PR,再由专项 PR 适配。不允许在专项内创建同义型别或临时 payload 绕开该流程。
5. Phase 6 状态分为“contract 已冻结”与“专项实现已验收”两个独立记录;后者只能引用专项计划的 commit 和验证证据,不把其任务复制回本文件。

兼容性解释以本计划 §6.1 的 session version × feature-state 矩阵为唯一真源。专项中的“v1/v2 只读兼容”只表示 Plan/Context/Compaction/Memory 新语义不得写入 v1/v2,不能覆盖 `off/opt_in` 下基础 v2 session 仍沿当前路径可读写的规则;专项实现若需改变该矩阵,必须先修改本计划、CLI golden fixture 与迁移门禁。

### 0.4 Enterprise/Remote/Telemetry 的实现所有权

本轮只继续 Runtime-owned Activity/Telemetry/lifecycle、durable ChangeProposal/HumanGate repository、Control Plane 和 remote orchestration adapter。表中位于 Security/Worktree、Extension 或 PCM 专项的 managed policy、credential、真实 remote executor、marketplace trust 和 memory/compaction managed bounds 全部冻结;Runtime 只能保留对应 port 与 unsupported 路径。

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

本表保留原始 owner/handoff 设计与历史追溯,但从`06`冻结决定起不再启动 I1–I4、I7 中的专项实现窗口。后续实际调度只按§12的Runtime-owned Wave和共享锁执行;需要专项变更时必须先显式解冻,不能直接恢复本表旧窗口。

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

当前追溯结论:`004a252` 已一次性集成多个原计划要求串行交接的共享面,后续提交又继续在窄边界加固,但本表没有留下 I0–I7 每个窗口的 `baseline/owner/allowed paths/handoff commit` 完整历史。因此当前代码与测试可以证明对应模块或 scoped seam 已实现,不能倒推为 §11 的“全局串行 handoff 记录齐全”已经完成;该最终验收项继续保持未勾选。

## 1. 审查快照与证据边界

本节记录的是 2026-07-22 对本机 checkout 的只读快照,没有执行 fetch/pull,因此只证明本计划实际审阅过的源码版本,不声称它们仍是上游远端最新提交。`00-reference.md` 以内容摘要固定,四个外部仓库以 commit 固定;后续移植 PR 必须重新核验当前上游与许可证。

| 仓库 | 审查快照 | 工作区状态 | 许可证取样 | 本计划主要参考 |
|---|---|---|---|---|
| RunLedger | `feat/agent-loop-resurrect@65f905452195e034c99fa5ac560a7e23a822f052` | 主工作区已有文档修改/未跟踪文件;审阅未把这些文件视为已完成实现 | `package.json`:MIT | 当前代码、Phase 0 前置 scaffold 与缺口基线 |
| `runtime/00-reference.md` | 原始主 checkout `sha256:2de7660e6726729deacbb320b670863eb5518760b4ab2294d3e7cb5655894428`(838 个 LF,末尾无 LF);目标 worktree `sha256:61355b650f38a9f916064bc6fa8e0754ec68a466abc27bcfb81f65ee2860db94`(839 个 LF) | 本地设计输入;两份文件在原始 22810 bytes 内逐字相同,worktree 只补了终止 LF,不是内容漂移 | 仓库内设计输入,不单独授权源码复制 | 11 类问题、总体架构、执行闭环、硬约束与推荐落地顺序 |
| codex | `main@0b175e6439a8608ba7726ee153fd8590619e8f34` | 仅用户未跟踪 `codex-rs/WEBSOCKET_PROXY_ISSUES.md` | 根 `LICENSE`:Apache-2.0 | 权限、sandbox、control plane、延迟工具、MCP/Skill/Plugin、多 Agent、分页历史与 fork lineage |
| pi | `main@3f1762cc7d3af39898aa5d21891335935011287f` | 干净 | 根 `LICENSE`:MIT | AgentHarness、Session v3、Compaction、生命周期、本地 RPC |
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
- `codex-rs/app-server-protocol/src/protocol/v2/`、`codex-rs/app-server/src/request_processors/`:headless thread/turn/item API、correlation 与分页/订阅;`expected_turn_id` 当前只约束 steer,不是通用 revision CAS。
- `codex-rs/app-server/src/connection_rpc_gate.rs`、`message_processor.rs`:close gate、drain background task 与 shutdown ordering。
- `codex-rs/codex-mcp/src/`、`codex-rs/core-skills/src/`、`codex-rs/core-plugins/src/`:资源发现、延迟暴露、安装 staging 与配置优先级。
- `codex-rs/core/src/hook_runtime.rs`、`codex-rs/models-manager/src/{manager,model_info,cache}.rs`、`codex-rs/core/src/context_manager/{history,updates,normalize}.rs`:typed hook lifecycle、模型 metadata/cache 与 history normalization。
- `codex-rs/core/src/session/turn.rs::comp_hash_changed`、`codex-rs/core/src/session/mod.rs::replace_compacted_history`、`codex-rs/core/src/compact_remote.rs`、`codex-rs/core/src/session/rollout_reconstruction.rs`、`codex-rs/core/tests/suite/compact_resume_fork.rs`:compatibility hash、replacement-history 安装、只重放后缀的 compaction resume/fork,以及降级恢复边界。
- `codex-rs/core/src/agent/`、`codex-rs/agent-graph-store/src/`:V1 depth bound、V2 total concurrency/residency bound、durable parent/child edge 与 residency;V2 不受 `agent_max_depth` 约束。
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
- V1 Agent depth 与 V2 总并发/驻留限制只作为预算输入;RunLedger 的 depth、children、total-agent 与 root budget 必须同时硬限制,不能把 V2 的 concurrency bound 误写成递归有界。
- Guardian 在 timeout、会话失败或解析失败时阻止执行的方向可作为自动预审参考;任何模型 review/Guardian 输出都只形成 candidate evidence,仍需独立 verifier 或人工 gate。
- managed config 借鉴 source attribution 和逐字段单调收窄;每次层合并、违规值归一化或 required-default fallback 都必须形成 durable normalization receipt,无法证明 effective value 时 fail closed。

拒绝照搬:

- Codex 的历史投影仍会跳过 rejected rollout line;append 只会在末字节不是 LF 时补换行,不会验证、截断或修复 malformed tail/record。其日志也没有 RunLedger 所需的完整 sequence/hash chain/payload digest,不能作为 v3 真源。
- Codex release build 对 duplicate tool name 记录并跳过,不保证启动失败;RunLedger 不能沿用该降级。
- Codex append/flush/shutdown 的成功语义不能证明 fsync durability;RunLedger 的 tool terminal/permission/stop barrier 必须自行定义并故障注入。
- Codex 可在活跃 turn 物化 synthetic `TurnAborted` 后 fork;RunLedger 首版只允许已经持久且可验证的 stable turn boundary。
- V2 residency 会卸载 idle resident,而 interrupted Agent 可被视为不可重载并在 eviction 后永久丢失;RunLedger eviction 必须有 durable paused/partial terminal 或可验证 rehydrate 路径,不得把 resident 消失当作完成。
- `SessionMeta` 的 cwd/GitInfo 只是观测,不是每次工具执行的 workspace lease 证明。
- rollback 只回退模型历史,没有与文件状态、artifact 和 event position 原子绑定。
- `comp_hash_changed` 在任一 compatibility hash 缺失时不会判定变化;RunLedger 必须把缺失的兼容证明视为 incompatible,拒绝原 session 切模或要求显式 fork,不能把“未检测到变化”当作兼容。
- `replace_compacted_history` 先切换内存历史,再分别持久化 Compacted、WorldState 与 TurnContext,不是原子 checkpoint;RunLedger 不得在 durable commit 前改变 live projection。
- rollout reconstruction 对非法 window UUID、损坏 world-state、patch-without-full 与 legacy missing replacement 会 warning 后降级;RunLedger v3 必须停止恢复并进入 corrupted/forensic salvage,不得猜测补全。
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
- `packages/agent/src/harness/session/{session,jsonl-storage}.ts`:v3 header、leaf/tree path 与 LF JSONL;未知 entry type/payload 仍存在 cast,不能称为完整 exact schema。
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
- SQLite append 的单事务更新值得采用,但 `SqliteSessionStorage.create()` 的 session/sequence/materialized 初始化未包在同一事务,repo fork 又逐 entry 独立提交;中途失败可能留下半初始化或部分 fork。普通读取还会跳过 malformed row,且 schema 没有 parent FK、hash chain、writer lease/fencing、idempotency key、effect intent/commit 与 durable receipt,因此不能直接作为 v3 canonical backend。
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
- authenticated WebSocket、多客户端 request 路由、pidfile single-instance/takeover 与 shutdown drain 可作为 Phase 10 的服务生命周期和竞态测试参考;session 进程内存活只表示连接重建,不能替代 v3 Event Store 的跨进程 restore。

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
| codex rollout/thread-store、fork lineage、projection checkpoint | Phase 1、Phase 10、Phase 11 GC | 采用单 writer、可重建 projection、分页/cursor 与引用感知清理;canonical v3 仍必须严格校验而非跳过坏行 |
| codex compatibility/compaction reconstruction、Guardian/model review、managed config/raw trace | Phase 1、Phase 3、Phase 6、Phase 8、Phase 11 + Plan/Context/Compaction/Memory 专项 | 缺 hash、非法 window/world-state、截断 evidence 与解析失败全部 fail closed;replacement durable 后才切 projection;策略 fallback 有 normalization receipt;raw trace 独立于默认 telemetry |
| codex permission/sandbox/tool routing | Phase 2–3 公共契约 + Worktree/Sandbox/Permission 专项 | Runtime 只拥有 envelope/receipt/port;策略合并、审批、broker 和 sandbox 强制由专项实现 |
| codex MCP/Skill/Plugin 与 tool exposure | Phase 5 公共契约 + Plugin/MCP/Skill/Hooks 专项 | 采用 provenance、immutable snapshot、延迟暴露;不把现有 manifest 当作完整供应链信任证明 |
| codex agent graph 与 app-server control plane | Phase 9–10 | 采用 durable parent/child、局部 active-turn precondition、分页/订阅;增加通用 expected revision、有界预算、idempotency、auth 和 workspace identity |
| pi AgentHarness/session v3/SQLite/save-point/lifecycle | Phase 1、Phase 7、Phase 10–11 | 采用 immutable current provider request、save-point 后重建 next request、append-only leaf marker、SQLite 事务/rollback fixture 与 settlement;canonical 仍用 strict JSONL,SQLite 先作可重建 projection,replacement 必须 prepare-before-teardown + durable fencing switch,不把进程内状态或数据库事务冒充完整 durable recovery |
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

- v2 `agent-loop`、`Agent`、ledger/session codec、ExecutionEnv、tool registry/stdlib、interactive controller 与 TUI 仍作为 legacy/兼容入口存在,没有被 v3 实现无条件替换。
- Phase 0–6 已不再只是 scaffold:`src/runtime/protocol/v3/`、`src/runtime/session/`、`src/runtime/artifacts/`、`src/runtime/resources/` 以及 model/plan/context contract 均有 exact schema、reducer/store 或 contract tests;runtime/execution boundary scripts 已由 `npm run check` 实际执行。
- Workspace/Security 专项已有 production worktree、lease、Approval/Gateway、Artifact checkpoint 与 startup/mutation adapter,但它们的真实隔离、身份、Sandbox 和跨存储恢复仍按专项联合门禁判定。
- Phase 7–8 已有 Orchestrator/Budget 与 Verification 模块、production adapter和攻击测试;完整 prompt -> approved plan -> build/test/review -> EpisodeSeal 生命周期仍未接入默认 production composition。
- Phase 9 已有 durable Agent graph、Supervisor、authority sidecar和 internal/test-injected process-resident child execution seam;它不是稳定 public executable-child API,也没有 CLI/daemon/Control Plane feature activation。
- Phase 10–11 已有 Control Plane、daemon、RuntimeActivity/cost/telemetry、startup/shutdown/GC 和 enterprise/remote contracts;显式 `unsupported_feature`/`evidence_unavailable` 路径继续用于拒绝缺少真实 adapter 的生产能力。
- `src/runtime/tasks/`、M4 工具、TUI 组件、examples/mock tests 仍是历史兼容产物,不能替代上面任何 v3 production gate。

### 2.2 对照 11 类治理问题的当前实现与剩余缺口

| 领域 | 当前已实现 | 进入生产自动化前仍缺的硬门槛 | 计划落点 |
|---|---|---|---|
| Workspace identity | Workspace contract、production worktree/lease、canonical bind/release、checkpoint/rewind/cleanup与持续 mutation gate | ancestor/path TOCTOU、完整 Sandbox/process tree、活跃期 corruption/kill/restart联合证明 | Runtime Phase 2、4 + WorkspaceSecurity-Phase2–WorkspaceSecurity-Phase7 |
| Session integrity | v3 strict event log、hash/durable barrier、queue/snapshot/stop/fork/migration/recovery | open依赖注册顺序、create/fork完整故障矩阵、child activation/cold effect reconcile | Runtime Phase 0–1 |
| Capability kernel | contract、Approval durable CAS/reconcile、Tool Gateway authorize/start/execute窄闭环 | pending prompt恢复、actor/channel identity、独立 denial audit、public revoke、无旁路真实 Sandbox/credential | Runtime Phase 3 + WorkspaceSecurity-Phase1–WorkspaceSecurity-Phase8 |
| Tool/MCP/Skill/Plugin | neutral resource contract与扩展 discovery/trust/runtime adapter已有实现/测试 | publisher/signature/marketplace与所有生产 execution/journal/联合门禁按扩展专项最终验收 | Runtime Phase 5 + Extension-M0–Extension-M7 |
| Deterministic orchestrator | Goal/Task canonical truth、queue/save-point、retry/loop breaker与多维 BudgetGuard | 默认 production prompt 生命周期和 Verification/Compaction gate联合闭环 | Runtime Phase 7–8 |
| Model router | compatibility contract、manifest loader/router/profile与 governed request adapter | 生产切模/fork及 provider drift的完整专项验收 | Runtime Phase 6 + Plan/Context/Compaction/Memory Phase 1、7 |
| Context/Compaction/Memory | 分层 Context、compaction与 Memory service/store/tool模块及 contract/behavior tests | overflow-safe-point -> durable replacement -> CAS install 的production E2E与完整审批生命周期 | Runtime Phase 6 + Plan/Context/Compaction/Memory Phase 2–10 |
| Multi-Agent | durable graph/Supervisor、bounded budget/workspace refs、authority sidecar、internal child happy path | stable public/production runtime factory、CLI/daemon feature row、真实 child Gateway/Sandbox/Verification、cold takeover/stop resolution | Runtime Phase 7、9 + WorkspaceSecurity-Phase7 |
| Verification | independent pipeline、finding/review/secret/dependency gates、EpisodeSeal与受控 browser/runner adapters | 真实 Browser/Sandbox/Workspace联合 E2E、默认 prompt lifecycle、production Draft PR/HumanGate | Runtime Phase 8、10 + WorkspaceSecurity-Phase7 |
| Artifact/Observability/Cost | Artifact CAS/retention/redaction/checkpoint、Activity/cost/Telemetry Manifest与forensic store | salvage适配、全维late-cost对账、真实 exporter/retention/enterprise联合门禁 | Runtime Phase 4、7、10–11 + WorkspaceSecurity-Phase7 |
| CI/Enterprise | daemon/control-plane、managed/identity/executor/telemetry contracts与部分攻击测试 | OS peer identity、production managed enforcement、credential/forge/human gate、remote/CI executor与跨域fault matrix | Runtime Phase 8、10–11 + WorkspaceSecurity-Phase8 + Extension-M7 |

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

Runtime-M0 的本地 canonical backend 固定为 strict hash-chained JSONL,避免在迁移期形成 JSONL/SQLite 双真源;`RuntimeEventStore` contract 保持 backend-neutral。SQLite 可先用于可丢弃、可从 canonical events 重建的分页/物化 projection。若以后把 SQLite 提升为 canonical backend,必须另行迁移并通过同一 Event Store conformance/fault suite,至少包含 `WAL`、`synchronous=FULL`、事务内 session/sequence/entry/active-leaf/projection 初始化与更新、原子 fork、writer fencing 和 durable receipt;数据库文件或事务成功本身不等于这些语义已经成立。

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

## 4. v3 核心协议草案

实现时使用 TypeBox schema + 静态 TypeScript 类型,禁止 `enum`、参数属性、`any` 和动态 import。

下面代码块是用于评审边界的字段轮廓,不是可直接复制的最终规范源。最终规范必须位于 `src/runtime/protocol/v3/{ids,event-catalog,event-payloads,events,schemas}.ts`:所有主键/ref 使用对应 branded ID,并按 authority/tenant scope 组合;每个 event type 对应独立 exact TypeBox payload schema。后续 contract phase 新增事件时,必须在同一 PR 同步更新 catalog、payload union、状态转换、size bound、golden fixture 和 version fence,不得把这里的裸 `string` 或 `Record<string, unknown>` 变成生产协议。

```ts
export type RuntimeEventType =
  | "session.created"
  | "session.forked"
  | "session.migration_started"
  | "session.legacy_message_imported"
  | "session.migration_committed"
  | "session.migration_failed"
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

export interface QueueItemV3 {
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

export interface RuntimeEventEnvelopeV3<
  TType extends RuntimeEventType,
  TPayload extends Record<string, unknown>,
> {
  schemaVersion: 3;
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

上述接口只是公共 envelope/ref,不是 WorktreeManager、PermissionEngine、ApprovalStore、ExecutionGateway 或 SandboxBackend 接口。它们只描述 Runtime 可验证、持久和投影的数据;值如何产生、是否可信以及何时发射事件,归 Worktree/Sandbox/Permission 专项实现负责。实际 `RuntimeEventV3` 必须是按 `type` 区分的穷尽联合,每一种 payload 都有独立 TypeBox schema;不得把宽松的 `Record<string, unknown>` 直接暴露为 canonical event。哈希输入使用仓库内唯一 canonical JSON 实现,固定 UTF-8、字段排序、换行与数字规则。`currentEventHash` 覆盖 schema version、identity、sequence、type、previous hash 与 payload digest,不得对原始 `JSON.stringify` 输出直接碰运气。

## 5. 目标目录与数据布局

```text
src/runtime/
  protocol/v3/          branded ids、catalog/payload、schema、hash、transition、threat/coordination contracts
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
tests/runtime-v3/       contract、failure injection、recovery、security
tests/e2e/              daemon、workspace、verification、multi-agent
```

```text
.runledger/
  sessions/                         v1/v2 legacy;可写性严格按 §6.1 状态矩阵
  runtime/v3/
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

## 6. 兼容、迁移与回滚总策略

### 6.1 Session 版本

- v1:仅安全文本投影,保持现有 warning,永不补造工具参数或签名。
- v2:保持 canonical AgentMessage/runtime config 恢复;`off/opt_in` 维持当前 read/write,`default/required` 后只读且不再 append。
- v3:所有新治理事件、snapshot、checkpoint、artifact 和 verification 的唯一写格式。

`sessionV3` 不是一个含糊的布尔回退开关,实现前必须冻结以下状态矩阵并由 CLI golden tests 覆盖:

| feature state | 新 session | v1 action | 既有 v2 action | v3 action |
|---|---|---|---|---|
| `off` | v2 | inspect/export | 按当前兼容路径 read/write | inspect/export only,不允许旧 runtime append |
| `opt_in` | 默认 v2,显式选择 v3 | inspect/export/migrate | read/write 或显式 migrate/fork-to-v3 | read/write |
| `default` | v3 | inspect/export/migrate | inspect/export/migrate/fork-to-v3,禁止 append | read/write |
| `required` | v3 | inspect/export/migrate | inspect/export/migrate/fork-to-v3,禁止 append | read/write |

一旦目标分支把状态推进到 `default/required`,普通回滚不得把已有 v2/v3 session 重新开放给旧写路径;紧急降级只允许 inspect/export。feature 状态、session header 版本和 CLI action 三者必须共同决定行为,不能由“文件能解析”推导可写。

### 6.2 迁移

- 新增显式 `runledger session migrate <source> --to v3`,始终写入新 session 目录,绝不原地修改源文件。
- v3 成为默认后,`--continue/--resume/--session/--fork` 选中 v1/v2 时只能 inspect/export;继续新 turn 必须显式 migrate 或 `--fork-to-v3`,不能静默续写或隐式转换。
- migration 首事件记录完整 source bytes digest、size、header digest、importer/schema 版本、可恢复字段和丢失字段。
- v1/v2 历史只形成 `session.legacy_message_imported` 一类受限事件;不能声称旧事件已通过 v3 hash-chain 审计。
- migration 以 durable `session.migration_committed | session.migration_failed` 收尾;committed 前目标 session 永远 pause/inspect-only,中断续跑以 source digest+record index 幂等。
- malformed 中间行一律停止迁移。仅最后一条 torn write 可通过显式 forensic 命令生成报告;修复也必须写新 fork。

### 6.3 Rollout 与回滚

- Runtime 内功能门按 `sessionV3 -> workspaceContracts -> securityContracts -> artifactCas -> orchestrator -> verification -> daemon` 单向推进。`workspaceGuard`、`capabilityGateway`、`sandboxEnforcement` 属于专项实现门,未通过其验收时 Runtime contract 完成也不得启用副作用。
- 可以先 shadow 计算策略或 projection,但 shadow 结果不得授予新权限。
- 不采用 v2/v3 dual-write 作为长期方案,避免产生两个“真源”。
- 回滚代码版本时,v3 session 只能只读导出;旧 runtime 不得继续写 v3。
- 每个阶段必须提供开关撤回消费者或 adapter,但不能绕过已经启用的安全检查继续副作用执行。

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

Phase 0–11 的完整任务、完成门槛、故障注入和历史证据已拆分到 [`harness/README.md`](harness/README.md)。当前实现状态仍以 §0.0 为唯一汇总真源;阶段依赖与发布里程碑见 §8,最终产品验收见 §11,实际开发顺序、并行 lane 与 join gate 只按 §12 执行。

统一协议变更 allowlist 已移入分阶段索引,并继续约束所有 Phase;拆分不改变任何实现范围、前置条件或冻结边界。

| 顺序 | Phase | 独立文档 |
|---:|---|---|
| 0 | 协议冻结、边界检查与测试骨架 | [详情](harness/phase-00-protocol-baseline.md) |
| 1 | Session Kernel v3、哈希链与可恢复状态 | [详情](harness/phase-01-session-kernel-v3.md) |
| 2 | Workspace Envelope、Receipt 与投影数据结构 | [详情](harness/phase-02-workspace-contracts.md) |
| 3 | Capability、Approval 与 Sandbox 契约数据结构 | [详情](harness/phase-03-capability-approval-sandbox-contracts.md) |
| 4 | Artifact CAS、脱敏、Retention 与 Episode 骨架 | [详情](harness/phase-04-artifact-episode.md) |
| 5 | 动态资源 Runtime 协议与数据结构 | [详情](harness/phase-05-resource-contracts.md) |
| 6 | Model、Plan、Context、Compaction 与 Memory 公共契约 | [详情](harness/phase-06-model-plan-context-contracts.md) |
| 7 | 确定性 Orchestrator、Task DAG 与 BudgetGuard | [详情](harness/phase-07-orchestrator-budget.md) |
| 8 | 独立 Verification Pipeline、Finding 生命周期与可信基线 | [详情](harness/phase-08-verification.md) |
| 9 | 有界 Multi-Agent、权限与 Workspace 引用 | [详情](harness/phase-09-multi-agent.md) |
| 10 | Headless Daemon、版本化 Control Plane 与轻客户端 | [详情](harness/phase-10-control-plane.md) |
| 11 | Telemetry、企业/远程契约与生命周期加固 | [详情](harness/phase-11-enterprise-telemetry-lifecycle.md) |

## 8. 阶段依赖与发布里程碑

```text
Phase 0 Protocol
  -> Phase 1 Session Kernel
      -> Phase 2 Workspace Contracts
          -> Phase 3 Security Contracts
              +-> WorkspaceSecurity frozen implementation -> Runtime receipt adapter
              +-> Phase 4 Artifact -> Phase 5 Resource Contracts
              |                   +-> Phase 6 Model/Plan/Context Contracts -> frozen PCM implementation
              +-> Phase 7 Orchestrator/Budget implementation（可面向冻结 contract 并行）

[Phase 5/6 + frozen specialty readiness + Phase 7 implementation]
  -> Runtime-owned composition gate -> Phase 8 Verification
       +-> Phase 9 Multi-Agent/Runtime-M2 ------------------+
       +-> Phase 10 Daemon/Clients/Runtime-M3 --------------+-> Phase 11 Enterprise/Remote/Telemetry/Runtime-M4

§0.5 PiAiParityManifest ---------------------> Phase 6 Model/Plan/Context Contracts -> Runtime-M1
```

| 里程碑 | 包含阶段 | 当前状态 | 可对外承诺 |
|---|---|---|---|
| Runtime-M0:Auditable Single Agent Contracts | 0–4 | 未关闭:Phase 0/2/3 contract 已实现,Phase 1/4 仍需 W1-B、W1-J、W1-G 的逐项证据与联合边界 | 单 Agent session、workspace/security refs 与证据协议可验证;这是 contract 里程碑,不承诺真实隔离或强制执行 |
| Runtime-M1:Governed Harness | §0.5 + 5–8 + production join gate | 未关闭:contract和多数模块已实现;三个行为专项冻结,Runtime只能继续adapter/orchestrator/verification | `PiAiParityManifest` 可追踪,冻结专项readiness全部通过且Runtime production join、确定性门禁与内置 Browser 独立验证完整 |
| Runtime-M2:Bounded Collaboration | 9 + WorkspaceSecurity-Phase7/WorkspaceSecurity-M6 联合门禁 | 未关闭:仅 internal/test-injected process-resident seam与scoped E2E | 多 Agent DAG、workspace/capability refs 有界且可恢复;真实隔离由专项联合 E2E 证明,不默认远程 |
| Runtime-M3:Headless Runtime | 10 + production composition gate | 未关闭:daemon/control-plane主体存在,多项生产feature仍unsupported | CLI/TUI 通过同一协议连接 Runtime 真源,版本化协议可供后续 IDE/CI adapter 消费;本阶段不宣称已交付 IDE/CI client。只有持有效 `ProductionCompositionReceipt` 的 capability 才被 advertise,缺真实 adapter 的 mutation/forge 能力保持 unsupported/deny |
| Runtime-M4:Enterprise Runtime | 11 + WorkspaceSecurity-Phase8/WorkspaceSecurity-M6 + Extension-M7 联合门禁 | 未关闭:Runtime contract/telemetry可继续,managed/credential/remote/supply-chain实现已冻结 | Runtime activity/cost/Telemetry Manifest/lifecycle 与企业/远程契约完整;managed enforcement、credential、Draft PR/human gate、远程/CI 隔离均有真实联合验收 |

不得为了展示多 Agent 或 Web UI 跳过 Runtime-owned前置Wave。冻结后不再启动Worktree/Sandbox/Permission、Extension或PCM行为lane;Runtime按§12继续自己的Artifact、Orchestrator、Verification、Agent、Control Plane与Telemetry工作。任何依赖冻结缺口的production feature保持unsupported,所以§12 Wave完成不自动提升本表的产品里程碑。

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
| 0 | `npm test -- tests/runtime-v3/schema.test.ts tests/runtime-v3/canonical-json.test.ts tests/runtime-v3/module-boundaries.test.ts tests/runtime-v3/phase-zero-contracts.test.ts tests/runtime-v3/reference-snapshots.test.ts` | v1/v2 真实 JSONL fixture;feature-state/session-version/CLI matrix;taint/declassification exact schema;两个 boundary script 必须由 `npm run check` 实际执行 |
| 1 | `npm test -- tests/runtime-v3/session` | kill/disk-full/torn-write/after-write-before-sync 子进程测试;session/authority stream fencing 与 cross-stream receipt rejection;queue/identity reopen;legacy CLI migrate/fork/version fence |
| 2 | `npm test -- tests/runtime-v3/workspace-contracts` | fake Workspace port + architecture import deny;不以此宣称真实隔离 |
| 3 | `npm test -- tests/runtime-v3/security-contracts` | fake Gateway/Approval/Sandbox ports + signed/channel request、anti-replay、rate-limit、taint sink、redaction/replay;不以此宣称生产强制 |
| 4 | `npm test -- tests/runtime-v3/artifacts` | Phase 4 只跑 fake Workspace/Gateway port、CAS crash/redaction/access contract;真实 checkpoint/rewind/cleanup/access 联合 E2E 在 I2/WorkspaceSecurity-Phase5 后作为 Runtime-M1 join gate,不反向阻塞 Phase 4 contract/Runtime-M0 |
| 5 | `npm test -- tests/runtime-v3/resource-contracts` | native/browser/instruction taxonomy + Extension-M0 contract consumer;生产能力等 Extension-M0–Extension-M6/Extension-M7 对应门禁 |
| 6 | `npm test -- tests/runtime-v3/contracts` | taint 跨 context/summary/model-switch fixture + Plan/Context/Compaction/Memory Phase 0 contract consumer;行为等该专项 Phase 1–10 |
| 7 | `npm test -- tests/runtime-v3/orchestrator` | crash/replay/budget concurrency;Phase 8 前 production `completed` 必须不可达 |
| 8 | `npm test -- tests/runtime-v3/verification tests/e2e/verification-trust.test.ts` | trusted-base/browser/manifest-seal + WorkspaceSecurity-Phase7 联合 E2E;dependency cooling、Secret Scan、candidate gate tamper;ChangeProposal/human-gate 只跑 fake contract 并记录 behavior unavailable |
| 9 | `npm test -- tests/runtime-v3/agents tests/e2e/multi-agent-isolation.test.ts tests/e2e/governed-child-runtime.test.ts` | Worktree/Sandbox/Permission capability 子集、独立 lease/workspace 和侧信道联合 E2E；provider live 另跑`RUNLEDGER_LIVE_E2E=1 npx vitest run tests/e2e/live-deepseek-child-runtime.test.ts --no-file-parallelism`，不能替代fault/security/restart门禁 |
| 10 | `npm test -- tests/runtime-v3/control-plane tests/e2e/daemon-recovery.test.ts` | I6 串行集成;13 类 mutation 的 applied effect/rejected error restart table、atomic revision、queue cancel、uncertain gate、activity replay、ChangeProposal/human-gate durable service、composition minimum/effective matrix downgrade、断线/backpressure/restart/peer identity;缺企业 adapter 时 forge unsupported |
| 11 | `npm test -- tests/runtime-v3/telemetry tests/runtime-v3/lifecycle tests/runtime-v3/managed-policy` | reference-aware GC + WorkspaceSecurity-Phase8、Extension-M7、跨 tenant/credential/forge/remote/CI/harness regression 联合 E2E |

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
| 一次性替换 v2 导致现有 CLI/TUI 失效 | legacy adapter + 新 session opt-in + golden fixture,不做原地迁移 |
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

- [ ] 每个 v3 session 或 authority/tenant lifecycle stream 都有独立连续 sequence、payload digest 和完整 hash chain,跨 scope 只通过显式 head/ref 关联。
- [ ] integrity 与 attestation 分开报告;给定可信 anchor 可定位链内修改,无 anchor 不宣称不可抵赖。
- [ ] 中间损坏、未知 schema、hash 断链均停止 resume。
- [ ] stop tombstone 后任何启动路径都不自动复活。
- [ ] snapshot/checkpoint/fork/rewind 与 canonical events 可交叉验证。
- [ ] invalid compaction window/UUID、损坏 world-state、patch-without-full、legacy missing replacement 与 checkpoint 外坏行均停止恢复;prepared/durable/installed 三态和四个 crash point 不产生半安装 history。
- [ ] tool terminal event durable 后才进入下一模型调用。
- [ ] append accepted 与 durable receipt 明确分离;after-write/before-sync 被归类 uncertain 并关闭 mutation gate,不会因重试重复事件或副作用。
- [ ] session.created 的 initialGoalId/rootAgentId 在 reopen/resume/fork 规则下稳定,queue 的 payload/kind/order/claim/cancel 可完整重放。
- [ ] feature-state × v1/v2/v3 × CLI action 矩阵有 golden tests;legacy migration 只有一个 durable terminal outcome,partial import 可幂等续跑或显式失败,永远不会被误判为可 resume。
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
- [ ] composition receipt 绑定仓内冻结的 protocol-minimum matrix version/digest 与 effective policy ref/digest;effective requirements 只能相等或更窄,旧版本、伪 digest、删 minimum adapter 或 policy downgrade fixture 均拒绝。
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
- [ ] authority/tenant/principal 从 v3 genesis 起贯穿 Event、Lease、Artifact、Approval 和 Trust key。
- [ ] `npm run check`、`npm test`、`npm run build`、`git diff --check` 全绿。

只有以上清单全部完成并附证据,RunLedger 才能把本计划状态改为“完成”。在此之前,对外应准确描述为“最小 Agent Runtime 正在升级为可治理 Harness”,不能把未实现的安全与验证边界写成现有能力。

## 12. 最终严格执行计划

本节是从当前实现状态推进 Runtime 剩余实现的唯一执行顺序。[`harness/README.md`](harness/README.md) 及其 Phase 文档保留完整产品需求,§11 保留最终产品验收语义;实际开发、并行、汇合、验证和状态更新一律按本节执行。`05-remaining-stuff.md` 只作为问题与取证台账,不得再形成第二套优先级。

本节自 2026-07-23 起采用 Runtime-only 范围:[`06-specialty-implementation-freeze.md`](06-specialty-implementation-freeze.md) 列出的三个专项全部只读。Wave 可以在明确 `unsupported/deny/not advertised` 的语义下关闭 Runtime 自有工作,但不能借此关闭依赖冻结缺口的 Runtime-M1–M4 产品声明;§8 与 §11 中相应里程碑继续保持未完成。

计划基线:

- documentation handoff:`c4cd3e66689dc56b296c05712a52301e9d712e9f`;该提交把 Phase 0–11 拆分文档和状态证据入口落入目标分支。
- implementation evidence baseline:`431681f`;该提交冻结 W0-02/03/04 证据矩阵、execution ledger 与验证记录。本次门禁状态提交只更新文档状态,Phase 1 代码从其后开始。
- 代码基线:`9a3d8c8`;Phase 0 统一 ID registry 已包含 Worktree,并由后续 documentation handoff 包含在当前 HEAD。
- 外围专项冻结基线:`81556acb16e2d4ba39e8fffeb0f4c5bdeccf40c7`;冻结状态、路径和定向测试见 `06-specialty-implementation-freeze.md`。
- 初始状态:W0–W6 全部 `pending`;同一时刻只能有一个全局 Wave 为 `in_progress`。
- Runtime-only 执行顺序:`evidence freeze -> Runtime-M0 kernel -> single-agent Runtime integration -> (Agent/Supervisor || Headless) -> Runtime enterprise/telemetry adapters -> hardening -> runtime-scope acceptance`。
- 允许并行只表示可在不同 worktree/branch 上开发独占路径;共享文件仍必须等待本 Wave 的串行 integration window。
- 任一 task 的状态只有 `pending | in_progress | completed | blocked`。没有目标分支 commit、定向测试、完整门禁和本节 evidence row 时不得写 `completed`。

### 12.1 不可违反的调度规则

1. 严格按 W0、W1、W2、W3、W4、W5、W6 顺序推进。前一 Wave 的 Runtime-owned join gate 未完成,后一 Wave 不得开始实现、不得提前修改共享 composition、不得预先 advertise feature。
2. 同一 Wave 内只有标记为同一 `parallel group` 的 lane 可以并行。未标记的 task 必须按 ID 顺序执行。
3. 每个并行 lane 必须有独立 worktree、单一 owner、显式 allowlist 和独立 commit。两个 lane 不能同时修改同一文件;发现重叠时立即停止较晚 lane,把重叠修改移入 join task。
4. `src/runtime/protocol/v3/**`、`src/runtime/{agent-loop,agent,interactive-session-controller}.ts`、`src/{index,models,models-store}.ts`、`src/cli/**`、`src/tui/**`、`src/daemon/{composition-root,production-composition}.ts`、`package*.json` 和本文件始终是串行路径;`06` §3 的专项路径在所有 Wave 中禁止写入。
5. 行为 lane 不能顺手放宽 contract。确需修改 schema/event 时,先暂停所有 consumer lane,完成独立 protocol revision、fixture、version fence和contract tests,再统一 rebase。
6. 每个 task 先提交 RED/fault fixture,再实现 GREEN,最后执行 lane gate。历史测试结果只能作为背景,不能替代当前目标分支复跑。
7. fake/test adapter只能关闭 contract或internal seam;production task必须证明真实 composition、required adapter receipt、无旁路和restart replay。
8. Runtime 自有 effect 发生 uncertain、cleanup失败、store corruption或identity drift时,当前 Wave 立即保持`blocked`,先形成reconcile/forensic evidence。冻结专项返回此类结果时,相关 feature保持unsupported并登记external dependency;只有不依赖它的Runtime task可以继续。
9. 一个 Wave 的 join commit 完成后,所有仍在运行的旧 lane 停止写入并 rebase 到 join commit;不得把旧 branch 的后续提交自动合并进下一 Wave。
10. commit与push继续遵守仓库授权边界:计划允许准备 scoped commits,但只有用户明确要求提交/推送时才执行相应状态变更。
11. 发现需要修改冻结路径才能通过测试时立即停止该 feature 的接线,记录首次失败commit/命令/receipt,不得借“Runtime修复”名义越界;解冻只能按`06` §7执行。

### 12.2 依赖图与并行拓扑

```text
W0 Evidence and specialty freeze
  -> W1 Runtime-M0 closure
      -> W2 single-agent Runtime-owned integration
          +-> W3-M2 Bounded Collaboration lane --+
          +-> W3-M3 Headless Runtime lane -------+-> W3-J production composition join
                                                     -> W4 Runtime enterprise/remote adapters
                                                         -> W5 cross-domain hardening
                                                             -> W6 Runtime-scope acceptance/release preparation
```

W3-M2 与 W3-M3 可以并行开发,但只有 W3-J 可以修改最终 production composition、feature matrix、CLI/TUI 和 daemon activation。M3 的单 Agent read-only/health 能力可以先验收,任何 multi-agent/spawn advertisement 必须等待 M2 lane 与 W3-J 同时通过。

### 12.3 共享路径锁

| 锁 | 独占路径 | 允许打开的 task | 释放条件 |
|---|---|---|---|
| L0 Protocol | `src/runtime/protocol/v3/**`、对应 schema fixtures | 每个 Wave 的首个 protocol revision task | schema/version/fixture/contract tests提交并被所有lane rebase |
| L1 Dependency | `package.json`、`package-lock.json` | 明确列出dependency review的单独task | license/lockfile/build审阅完成 |
| L2 Runtime core | `agent-loop.ts`、`agent.ts`、controller、models/model-store、root exports | W1-J、W2-J、W3-J | 对应join gate完整通过 |
| L3 Client/control | `src/cli/**`、`src/tui/**`、daemon composition | W3-M3串行task与W3-J | production feature matrix和E2E通过 |
| L4 Production composition | Runtime/storage/daemon中消费security/worktree/extension/verification/agents/control-plane ports的共享join文件;明确排除`06`冻结路径 | 每个Wave唯一`-J` task | composition receipt、startup/restart、no-bypass/unsupported tests通过 |
| L5 Documentation | 本文件、`05-remaining-stuff.md`、`06-specialty-implementation-freeze.md` | Wave收尾evidence task | commit/test/artifact/evidence全部回写;专项账本只在显式解冻时修改 |

### 12.4 W0:证据冻结与可执行基线

目标:把当前实现、未完成边界、任务 owner 和验证基线冻结成后续所有 worktree 的共同起点。本 Wave 不修改运行行为。

| ID | 状态 | 顺序/依赖 | 工作内容 | 产物与验证 |
|---|---|---|---|---|
| W0-01 | completed | first | 提交本节、当前状态复核与`06`冻结说明,记录 documentation handoff commit、branch、dirty paths和当前HEAD | `c4cd3e6`;分支`worktree/governed-agent-harness-runtime`;当前唯一非本任务 dirty path 为用户维护的`AGENTS.md` |
| W0-02 | completed | after W0-01 | 对§0.5、Phase 0/2/3/5/6 contract及三个冻结专项做逐项证据映射,严格区分implemented/partial/deferred | `431681f`;下方矩阵区分 implemented、behavior unavailable 与 frozen gap |
| W0-03 | completed | after W0-02 | 为W1–W6的Runtime lane登记owner、worktree、allowlist、共享锁和expected join commit | `431681f`;execution ledger无空owner/重叠写路径,冻结专项保持只读 |
| W0-04 | completed | after W0-03 | 复跑当前基线并保存计数/平台/skip原因 | `431681f`;完整门禁、pi audit、06 §6三组只读专项门禁、`git diff --check`全绿 |
| W0-G | completed | join | 冻结implementation baseline | evidence baseline=`431681f`;唯一额外 dirty path 为不纳入本任务的用户`AGENTS.md`;W1-A1可打开 |

#### W0-02 候选证据矩阵

本矩阵基于`c4cd3e6`代码树和`81556ac`专项冻结基线生成,由`431681f`冻结为 W0-02 evidence。

| 范围 | 状态 | source / contract | test evidence | commit / 未关闭边界 |
|---|---|---|---|---|
| §0.5 pi-ai parity | implemented | parity manifest、provider/API/Auth本地映射与只读审计器 | `audit:pi-ai` 164/164 source、72 catalog PASS | `004a252`;上游漂移仍需重新审计 |
| Phase 0 protocol | implemented | `src/runtime/protocol/v3/**`、identity、feature matrix、boundary scripts | Phase 0 schema/canonical/legacy/CLI/public-surface tests;`npm run check` | `65f9054`、`004a252`、`9a3d8c8`;历史I0–I7 handoff不能倒推 |
| Phase 2 Workspace contract | implemented contract;behavior unavailable | Workspace envelope/ref/receipt、event/reducer/projection | `tests/runtime-v3/workspace-contracts/**` | `65f9054`、`004a252`;真实Git/worktree/TOCTOU属于冻结专项 |
| Phase 3 Capability contract | contract completed;behavior unavailable | exact v2 capability/approval/sandbox/taint/rate-limit schema与ports;local current-head认证、remote signature variant及terminal composite correlation 已补齐 | `tests/runtime-v3/security-contracts/**` + security/verification/tool gateway/E2E targeted gate 12 files / 101 tests | `65f9054`、`004a252` + 包含本文件的交付提交;真实Gateway/Sandbox/credential与Approval recovery仍为冻结外部缺口 |
| Phase 5 Resource contract | implemented contract;behavior frozen | neutral identity/provenance/snapshot/invocation/lifecycle schema与ports | `tests/runtime-v3/resource-contracts/**` | `65f9054`、`004a252`;Extension行为只按冻结矩阵消费 |
| Phase 6 Model/Plan/Context contract | implemented contract;behavior frozen | model routing、Plan、Context、Compaction、Memory public schema/events | contract/behavior/production consumer gate 16 files / 94 tests PASS | `65f9054`、`004a252`;专项用户面/overflow/完整生命周期保持冻结 |
| Plan/Context/Memory专项 | implemented-frozen + partial/deferred | `06` §2.1/§3.1列出的公开面 | 16 files / 94 tests PASS | `81556ac`;Runtime只能消费,不能补实现 |
| Extension专项 | implemented-frozen + partial/deferred | `06` §2.2/§3.2列出的公开面 | 12 files / 52 tests PASS | `81556ac`;缺publisher/marketplace/完整管理面 |
| Workspace/Security专项 | implemented-frozen + partial/deferred | `06` §2.3/§3.3列出的公开面 | 21 files / 119 tests PASS | `81556ac`;真实process-tree/Sandbox/Approval recovery仍是external gap |

#### W0-03 候选 execution ledger

本轮不启用并行 agent/lane。所有 lane 由`/root`按 Wave 顺序在当前专用 worktree 串行执行;同一时刻只打开一行 allowlist,因此原计划允许并行的 P1/W3/P5 也不会发生共享路径并发写。下表由`431681f`冻结为 W0-03 execution ledger。

| lane | owner / worktree | 写路径 allowlist | lock / 顺序 | expected join |
|---|---|---|---|---|
| W1-A Session | `/root`;当前 governed-runtime worktree | `src/runtime/session/**`、`src/storage/v3-session-manager.ts`、`tests/runtime-v3/session/**` | L0/L2关闭;先A1→A2→A3 | W1-J1 |
| W1-B Artifact | `/root`;同 worktree,A3后串行 | `src/runtime/artifacts/**`、`tests/runtime-v3/artifacts/**`；`tests/worktree/artifact-checkpoint*`只读 | 不与W1-A并发;不得写`src/worktree/**` | W1-J1 |
| W1-J | `/root`;同 worktree | 仅主计划列出的L0/L2/L4 Runtime-owned接线面、对应tests/docs | W1-A3+B2后唯一join owner | W1-G |
| W2 Runtime integration | `/root`;同 worktree | `src/runtime/{integration,orchestrator,verification}/**`、Runtime-owned storage/daemon adapters、`tests/runtime-v3/{integration,orchestrator,verification}/**` | 冻结专项全程只读;D→R/V→J串行 | W2-G |
| W3-M2 Agent/Supervisor | `/root`;同 worktree | `src/runtime/agents/**`、`tests/runtime-v3/agents/**`、scoped e2e | 不与M3并发;不打开最终composition | W3-J |
| W3-M3 Headless | `/root`;M2后同 worktree | `src/runtime/control-plane/**`、Runtime-owned daemon/activity、对应tests | L3只在M3/J打开 | W3-J |
| W3-J | `/root`;同 worktree | L2/L3/L4列出的Runtime-owned composition与consumer tests | M2+M3后唯一join owner | W3-G |
| W4 Enterprise/Telemetry | `/root`;同 worktree | `src/runtime/{identity,executors,telemetry,lifecycle}/**`、Runtime-owned adapters/tests | 冻结credential/policy实现只读 | W4-G |
| W5 Hardening | `/root`;同 worktree | `tests/runtime-v3/harness-regression/**`、Runtime-owned fault/e2e tests及其直接修复路径 | P5按A→E顺序串行;专项失败只记external gap | W5-G |
| W6 Acceptance | `/root`;同 worktree | Runtime docs、test manifests与发布核验;无新feature code | L5唯一owner | W6-G |

所有 allowlist 均排除`06` §3冻结路径;若后续任务需要扩大路径,必须先修改本 ledger 并形成新的 evidence commit。

#### W0-04 候选验证记录

执行环境:`Linux 5.4.0-150-generic x86_64`、Node `v22.23.1`、npm `10.9.8`;代码HEAD=`c4cd3e6`。当前未提交的`AGENTS.md`是用户维护的提交规范更新,未进入测试输入或本候选证据范围。

| gate | 结果 |
|---|---|
| `npm run check` | PASS;TypeScript、runtime boundary v1、execution boundary全绿 |
| `npm test` | 261 files / 1703 tests PASS;1个`RUNLEDGER_LIVE_E2E` opt-in测试默认SKIP |
| `npm run build` | PASS |
| pi-ai audit | 164/164 upstream files、72 catalog files PASS |
| Plan/Context/Memory冻结门禁 | 16 files / 94 tests PASS |
| Extension冻结门禁 | 12 files / 52 tests PASS |
| Security/Worktree冻结门禁 | 21 files / 119 tests PASS |
| `git diff --check` | PASS;工作区另有已解释的用户`AGENTS.md`修改 |

W0-01 由`c4cd3e6`完成,W0-02/03/04 evidence 由`431681f`冻结。当前状态提交关闭 W0-G 后,W1-A1 按 RED→GREEN→REFACTOR 顺序启动;用户维护的`AGENTS.md`继续留在工作区且不进入本任务提交。

W0 退出门槛:

- 当前 343 个历史任务与本节执行单元存在可追踪映射,没有“实现过但无人负责验收”的孤儿项。
- I0–I7 的历史缺失不被伪造成已完成;从 W1 开始的新交接必须逐次留证。
- 三个专项的完成项、部分项与延后项都固定到`06`,Runtime lane allowlist不包含冻结路径。
- W0-G 未完成前禁止代码实现。

### 12.5 W1:关闭 Runtime-M0

目标:完成可审计单 Agent contract里程碑,先补 Session Kernel与Artifact剩余证据,再关闭Phase 0–4的逐项验收。

parallel group `P1` 只包含 W1-A 与 W1-B;两条lane均从 W0-G 创建,不得修改 L2/L4共享路径。

| ID | 状态 | 顺序/依赖 | 独占路径 | 工作内容 |
|---|---|---|---|---|
| W1-A1 | completed | P1, after W0-G | `src/runtime/session/**`、`src/storage/v3-session-manager.ts`、`tests/runtime-v3/session/**` | `259f2fb`;显式`restore()`先注册不可序列化依赖,再校验snapshot identity/generation,随后才打开Event Store/reduce/reconcile并返回handle |
| W1-A2 | completed | after W1-A1 | 同W1-A1 | create/fork staging、partial-create+cleanup structured outcome、publish前后fault矩阵与完整门禁均已完成 |
| W1-A3 | completed | after W1-A2 | 同W1-A1 | after-write/before-sync、parent-dir sync、disk-full、cross-stream receipt/fencing与uncertain recovery conformance均已完成 |
| W1-B1 | pending | P1, after W0-G | `src/runtime/artifacts/**`、artifact/storage tests | 将`SalvageReport`接入受授权CAS Artifact,绑定source digest、unattested、access与retention |
| W1-B2 | pending | after W1-B1 | 同W1-B1 + `tests/runtime-v3/artifacts/**` | 完成Runtime CAS/access/GC/legacy import/queue Artifact ref的crash与缺失blob fail-closed矩阵;`tests/worktree/artifact-checkpoint*`只读复跑 |
| W1-J1 | pending | after W1-A3 + W1-B2 | L0/L2/L4 | 串行接入session/artifact public exports、CLI version fence和migration/fork路径;禁止并行修改 |
| W1-J2 | pending | after W1-J1 | docs/tests only | 逐项审阅Phase 0–4 checklist;只勾有完整evidence的任务 |
| W1-G | pending | join | full tree | 执行Runtime-M0 gate并记录candidate baseline |

W1-A2/A3 完成证据:

- `src/runtime/session/session-publication.ts`、`src/storage/v3-session-manager.ts`、CLI/daemon fork 与 session discovery 已接入不可见 staging、exact publication barrier、failed/cleanup structured outcome和 parent-directory sync。
- JSONL after-write/before-sync uncertainty、canonical crash terminals、`reconciliation_required`、memory/JSONL backend conformance、bounded unattested offline salvage report 已有 Session 与相邻 lifecycle/control-plane 回归。
- `npm run check` PASS;Session 定向门禁 19 files / 168 tests PASS;CLI/daemon cleanup/recovery 定向回归 4 files / 27 tests PASS;`npm test` 263 files / 1730 tests PASS + 1 opt-in SKIP;`npm run build`与`git diff --check` PASS。
- 用户明确要求实现完毕后勾选完成,因此 W1-A2/W1-A3 已写为 `completed`,并由包含本文件的交付提交冻结。W1-J、W1-G 与 W1-B Artifact lane 保持未完成。

W1 定向门禁:

```bash
npx vitest run tests/runtime-v3/schema.test.ts tests/runtime-v3/canonical-json.test.ts tests/runtime-v3/phase-zero-contracts.test.ts
npx vitest run tests/runtime-v3/session
npx vitest run tests/runtime-v3/workspace-contracts tests/runtime-v3/security-contracts
npx vitest run tests/runtime-v3/artifacts tests/worktree/artifact-checkpoint.test.ts
```

W1 退出门槛:

- Session open/create/fork/migrate/salvage的每个durable边界均有唯一恢复结果。
- Phase 0/2/3 contract-only证据与Phase 1/4行为证据分开记录。
- Runtime-M0可以标记完成,但不得宣称真实Workspace/Sandbox隔离或Runtime-M1行为已经完成。

### 12.6 W2:完成单 Agent Runtime-owned integration

目标:只实现 Runtime 对冻结 Model/Plan/Context/Compaction/Memory、Extension、Workspace/Security public ports 的消费、receipt 校验、Verification/Orchestrator 与 production composition。W2 不修改专项内部,也不承诺补齐 Plan UI、overflow、Extension 管理面、Approval recovery或真实 Sandbox。

W2-G 表示 Runtime-owned integration 已完成并能对缺失依赖 fail closed。只有 `06` readiness 全部通过且真实联合 E2E 成立时,§8 的 Runtime-M1 才能另行关闭;否则保持未完成但不阻塞后续不相关的 Runtime lane。

#### W2-D:先冻结依赖输入

| ID | 状态 | 依赖 | 路径 | 工作内容 |
|---|---|---|---|---|
| W2-D1 | pending | W1-G | read-only | 运行`06`三组专项门禁,固定public export/schemaVersion/adapter identity/receipt/recovery能力矩阵 |
| W2-D2 | pending | after W2-D1 | docs/tests only | 把每项依赖标为`ready / unsupported / external-gap`;不得通过修改专项把gap改成ready |

#### W2-R:可并行 Runtime 消费泳道

parallel group `P2` 只包含 W2-R1、W2-R2、W2-R3;均从 W2-D2 开始,只修改 Runtime-owned adapter或consumer tests。

| ID | 状态 | 依赖 | 独占路径 | 工作内容 |
|---|---|---|---|---|
| W2-R1 Model/Context | pending | P2, after W2-D2 | Runtime model/context/session integration adapters与consumer tests | 消费冻结router/context/plan/compaction/memory API,校验profile/checkpoint/receipt;缺Plan/overflow/fork能力时返回稳定unsupported |
| W2-R2 Resources | pending | P2, after W2-D2 | `src/runtime/resources/**`之外的Runtime-side resource consumer adapter与tests | pin snapshot/generation/manifest/capability/tool identity,只调用冻结Extension public surface;不实现loader/manager/client/runner |
| W2-R3 Governance | pending | P2, after W2-D2 | Runtime-side Workspace/Gateway/Sandbox receipt validator与tests | 对authority/tenant/workspace/generation/start/terminal receipt做exact验证;冻结port缺失或degraded时拒绝激活 |

三个 lane 不得修改 `src/storage/production-interactive-runtime.ts`、agent-loop、controller、CLI/TUI或daemon;这些共享接线只在 W2-J 打开。

#### W2-V:Verification 与 Orchestrator

| ID | 状态 | 依赖 | 独占/共享路径 | 工作内容 |
|---|---|---|---|---|
| W2-V1 | pending | W2-R1 + W2-R3 | `src/runtime/verification/**`、`src/verification-runner/**` | 只消费已验证Workspace/Gateway/Sandbox/Artifact receipts;实现独立Browser backend的Runtime侧协议和unsupported路径,fixture attestor不能进入production |
| W2-V2 | pending | after W2-V1 | verification/admission | 把DependencyAdmission与SecretScan变成required Runtime gate,覆盖candidate-untrusted config/collector/lockfile source |
| W2-V3 | pending | after W2-V2 | verification/Episode | 完成Finding/reverification、manifest body/commit/seal/completed四边界crash recovery |
| W2-J1 | pending | W2-R1 + W2-R2 + W2-R3 + W2-V3 | L2/L4 | 单一owner接线agent-loop/controller/session/resource/security/verification;所有专项对象只经public ports进入 |
| W2-J2 | pending | after W2-J1 | orchestrator + integration tests | 驱动确定性Goal phase和全维Budget;模型/TUI不得直写completed |
| W2-J3 | pending | after W2-J2 | production composition | 签发Runtime composition receipt和dependency-readiness字段;缺任一真实adapter时相应feature保持unsupported |
| W2-G | pending | join | full tree | Runtime-owned single-agent integration gate;确认冻结路径无diff |

W2 必需 E2E:

- ready依赖路径:`prompt -> goal -> plan ref -> build/test/review -> EpisodeSeal -> terminal`;如果冻结Plan用户面不ready,输入使用已批准的canonical ref,不得在Runtime伪造approval。
- Compaction只测试Runtime adapter对既有prepare/commit/install/recovery receipt的处理;不得修改冻结Compaction core。缺overflow入口时明确记录external-gap。
- candidate篡改test config、dependency source、untracked secret、Browser evidence、review JSON均不能形成pass。
- Workspace/Gateway/Sandbox/Artifact/verifier或Extension audit任一缺失时,production completion/resource能力不advertise。
- `git diff --name-only <W2-baseline>..<W2-G>`与`06`冻结路径无交集。

### 12.7 W3:并行完成 Agent/Supervisor 与 Headless Runtime-owned 工作

W3只有两条顶层并行lane:`W3-M2`修改Agent/child独占路径,`W3-M3`修改Control Plane/transport独占路径。两条lane都不得修改L2/L3/L4共享composition;所有production activation集中到W3-J。

#### W3-M2:Bounded Collaboration

| ID | 状态 | 依赖 | 工作内容 |
|---|---|---|---|
| W3-M2.1 | pending | W2-G | 将activation request/receipt、immutable model/profile/objective/prompt digest与pending run写入authority/canonical truth |
| W3-M2.2 | pending | after W3-M2.1 | 关闭resolve-to-CAS freshness窗口、structured partial-create/cleanup、cold writer/stop/final-cursor takeover与operator resolution |
| W3-M2.3 | pending | after W3-M2.2 | 将headless child runtime/operation budget变成稳定public factory/port,不再由E2E源码深导入 |
| W3-M2.4 | pending | after W3-M2.3 | 在Agent侧把requestedCapabilities映射到冻结resource/tool public identity,每次model/tool/resume/cancel/isolated command调用同一child-scoped gate;不改Extension/Security |
| W3-M2.5 | pending | after W3-M2.4 | 消费冻结child Gateway/Sandbox/Workspace receipts和Runtime Verification;现有专项不能证明process-tree authority时保持unsupported/quarantine,不在Agent层补Sandbox |
| W3-M2.6 | pending | after W3-M2.5 | 完成partial Artifact、handoff/merge conflict、root/per-agent budget、late provider cost reconciliation |
| W3-M2.7 | pending | after W3-M2.6 | 实现idle unload/reload、same-session standby replacement、fencing promotion、commit-before-old-drain与post-commit terminal |
| W3-M2.G | pending | lane gate | Agent/Supervisor fault/restart与冻结依赖fail-closed E2E全绿,但尚不advertise |

#### W3-M3:Headless Runtime

| ID | 状态 | 依赖 | 工作内容 |
|---|---|---|---|
| W3-M3.1 | pending | W2-G | 完成loopback HTTP/SSE listener、Unix peer credential与Windows pipe ACL/principal mapping |
| W3-M3.2 | pending | after W3-M3.1 | 完成bounded input、slow consumer、disconnect/resync、durable consumer checkpoint和overload E2E |
| W3-M3.3 | pending | after W3-M3.2 | 接通durable queue/list/cancel、turn/approval/artifact入口;未接adapter继续unsupported |
| W3-M3.4 | pending | after W3-M3.3 | 完成runtime generation replacement、idle unload/resume、old-handle fencing与commit前后fault matrix |
| W3-M3.5 | pending | after W3-M3.4 | 让CLI/TUI成为同一Control Plane projection的轻客户端,移除私有canonical状态 |
| W3-M3.G | pending | lane gate | 单Agent daemon/control-plane gate全绿;不含multi-agent advertisement |

#### W3-J:唯一生产汇合窗口

| ID | 状态 | 依赖 | 共享路径 | 工作内容 |
|---|---|---|---|---|
| W3-J1 | pending | W3-M2.G + W3-M3.G | L0/L3/L4 | 增加machine-verifiable multi-agent/child-runtime feature与required-adapter row;冻结依赖缺口必须显示unsupported |
| W3-J2 | pending | after W3-J1 | production Agent/CLI/daemon/factory composition | 注入同一public runtime factory和现有public parent/child gate、Workspace/Gateway/Sandbox/Artifact/Verification/Budget ports |
| W3-J3 | pending | after W3-J2 | CLI/TUI/Control Plane | 暴露有界spawn/inspect/cancel/resume/handoff,所有命令绑定generation/revision/idempotency |
| W3-J4 | pending | after W3-J3 | E2E | kill-after-effect、cold orphan、terminal-only cleanup、replacement、daemon restart与partial merge联合矩阵 |
| W3-G | pending | join | full tree | 关闭W3 Runtime-owned范围并记录两个readiness evidence;只有专项依赖也ready时才关闭Runtime-M2/M3产品里程碑 |

### 12.8 W4:完成 Enterprise/Remote/Telemetry 的 Runtime-owned 工作

W4在W3-G后开始。`src/security/**`中的identity/managed-policy/credential/remote实现和`src/extensions/**`中的marketplace/publisher/supply-chain实现全部冻结;本 Wave 不再包含原 W4-A/W4-D。Runtime 只实现通用 contract consumer、durability、Control Plane、Telemetry/lifecycle和明确unsupported的 provider slot。

冻结依赖:

| 依赖 | 当前处理 |
|---|---|
| managed identity/policy/RBAC/ABAC/credential | 只消费现有Security public ports;无真实receipt时managed capability不advertise |
| CI/SSH/relay transport与真实egress enforcement | Runtime只持久化invocation/attestation/result/uncertain状态;不在executors目录实现安全transport |
| marketplace/publisher/signature/revocation | Extension-M7保持冻结;Runtime只校验已有resource/trust refs |
| forge credential与organization gate | Runtime可以实现durable ChangeProposal/HumanGate protocol/repository;真实provider保持unsupported |

parallel group `P4` 包含 W4-R、W4-T 和 W4-H;三lane不得修改冻结路径或L3/L4 composition。

| ID | 状态 | 并行/依赖 | 独占路径 | 工作内容 |
|---|---|---|---|---|
| W4-R1 Remote state | pending | P4, W3-G | `src/runtime/executors/**`、Agent/Control Plane remote state的Runtime文件 | 固定invocation/attestation/result receipt、terminal idempotency、uncertain effect与restart replay;transport通过冻结port注入 |
| W4-R2 Handoff | pending | after W4-R1 | Runtime Agent handoff repository/service | 持久化handoff lease/fencing/terminal cache,拒绝跨authority/tenant或缺attestation输入 |
| W4-T1 Telemetry | pending | P4, W3-G | `src/runtime/telemetry/**` | RuntimeActivity/cost late reconciliation、Telemetry Manifest、spool/sink ack、SIEM与forensic隔离 |
| W4-T2 Retention/GC | pending | after W4-T1 | `src/runtime/lifecycle/**`、Runtime Artifact retention | fork/handoff/checkpoint/Episode/legal-hold引用图、tenant隔离、dry-run/tombstone/crash replay;Workspace物理清理由冻结port返回receipt |
| W4-H1 Proposal repository | pending | P4, W3-G | Runtime Verification/Control Plane change-proposal路径 | durable ChangeProposal、expected revision、idempotency、restart replay和human decision receipt |
| W4-H2 Provider boundary | pending | after W4-H1 | Runtime provider adapter contract/tests | 只允许Draft PR调用已有credential/forge/organization ports;缺任一真实port时merge/deploy不可达且feature unsupported |
| W4-J1 | pending | W4-R2 + W4-T2 + W4-H2 | L3/L4 | 串行注册Runtime remote/handoff、proposal/human-gate和telemetry adapters;冻结managed/credential/forge/supply-chain缺口写入composition readiness |
| W4-J2 | pending | after W4-J1 | Runtime enterprise E2E | cross-tenant receipt replay、旧generation、remote uncertain、proposal ack loss、telemetry retry与GC crash;冻结专项只读复跑 |
| W4-G | pending | join | full tree | Runtime-owned M4范围gate;完整Runtime-M4声明仍取决于冻结专项readiness |

### 12.9 W5:跨域故障矩阵与Harness Regression

W5不再增加新feature,只允许补Runtime证据、故障注入和Runtime-owned修复。冻结专项测试只读执行;发现专项缺陷时登记external dependency并保持对应feature unsupported,不得在W5越界修复。

| ID | 状态 | 并行/依赖 | 工作内容 |
|---|---|---|---|
| W5-01 | pending | W4-G | 建立唯一矩阵:`injection point -> expected event/receipt -> recovery -> owner(Runtime或frozen-external) -> exact command -> platform` |
| W5-A | pending | P5, after W5-01 | Session/Event/Artifact与冻结Compaction adapter消费:kill、disk full、torn write、sync loss、GC crash;不改Compaction core |
| W5-B | pending | P5, after W5-01 | Runtime对Workspace/Security/Approval receipt的symlink/TOCTOU、expiry/revoke、prompt restart、sandbox unavailable、credential leak fail-closed测试;不改专项 |
| W5-C | pending | P5, after W5-01 | Agent/Budget:spawn/cancel/stop uncertain、orphan、replacement、partial merge、late cost |
| W5-D | pending | P5, after W5-01 | Control Plane/Daemon:malformed/overload/slow consumer、signal/EOF/upgrade、command ack loss、restart |
| W5-E | pending | P5, after W5-01 | Runtime Remote/Telemetry/lifecycle:tenant receipt replay、old generation、remote uncertain、exporter/SIEM/forensic/GC;key/credential专项只读验证 |
| W5-J1 | pending | all P5 lanes | 汇总所有失败;Runtime P0/P1或不确定effect必须修复并重跑所属Wave gate,冻结专项失败转external-gap并禁止feature声明 |
| W5-J2 | pending | after W5-J1 | Linux/macOS/Windows差异全部得到pass或明确unsupported/deny;不得用单平台替代 |
| W5-G | pending | join | 完整Harness Regression和soak gate |

### 12.10 W6:Runtime-only 验收、文档收敛与发布准备

W6全程串行,禁止再并行修改代码。

| ID | 状态 | 顺序 | 工作内容 |
|---|---|---|---|
| W6-01 | pending | first | code freeze;核对当前仓库/分支/worktree/remote、tracked diff、generated files与credential filename-only scan |
| W6-02 | pending | after W6-01 | 按§11逐项分类为`runtime-complete / frozen-external-gap / deferred`;只有runtime-complete可勾选并附commit、命令、receipt和时间 |
| W6-03 | pending | after W6-02 | 运行所有Runtime阶段定向测试、W5 Harness Regression和冻结专项只读门禁;cross-platform缺口如实记录 |
| W6-04 | pending | after W6-03 | 运行完整发布门禁与CLI/daemon smoke;模型catalog变化时先generate并审阅 |
| W6-05 | pending | after W6-04 | 更新04状态为“Runtime-only范围完成,完整产品里程碑仍受冻结依赖约束”,同步05与06;校验无双真源/孤儿任务 |
| W6-06 | pending | after W6-05 | 形成scoped release candidate diff和commit计划;只有用户授权后commit/push/tag/PR |
| W6-G | pending | final | Runtime-owned范围验收签字;列出仍未关闭的Runtime-M1–M4专项依赖和unsupported feature |

W6 完整命令基线:

```bash
npm run check
npm test
npm run build
npm run test:harness-regression
npm run audit:pi-ai -- --upstream <explicit-pi-path> --commit 3f1762cc7d3af39898aa5d21891335935011287f
node bin/runledger.js --help
node bin/runledger-daemon.js --help
git diff --check
```

若发布声明包含真实 provider child lifecycle,再显式执行:

```bash
RUNLEDGER_LIVE_E2E=1 npx vitest run tests/e2e/live-deepseek-child-runtime.test.ts --no-file-parallelism
```

live test不得读取、打印、复制或提交credential;网络或credential不可用时必须报告未执行,不能用mock替代live声明。

### 12.11 Wave evidence与状态更新格式

每完成一个task,在本节对应row更新状态,并在该Wave后追加:

```text
- task: WN-ID
  - status: completed
  - owner/worktree: <owner + branch + worktree>
  - baseline: <input commit>
  - commit: <task commit>
  - paths: <explicit paths>
  - targeted: <exact command + platform + file/test count + result>
  - full gate: <commands + result>
  - artifacts/receipts: <path/id/digest>
  - remaining: <none or explicit downstream boundary>
  - verified_at: <ISO-8601>
```

Wave join task必须额外记录所有lane commit、rebase顺序、共享文件owner、composition receipt和rollback point。某lane只有局部通过时保持`in_progress`或`blocked`;不得通过缩小task语义把它改写成`completed`。

### 12.12 最终停止条件

只有 W6-G 完成才停止本轮 Runtime-only 实施。此时本文件可以标记“Runtime-owned范围完成”,但只要冻结专项仍有缺口,完整 Governed Harness 与 Runtime-M1–M4 产品里程碑不得标记完成。

以下任一情况都必须继续停留在当前 Wave:

- 任一 Runtime-owned §11 项仍未验收;
- 任一被advertise的production feature依赖fake/test adapter、冻结缺口或未签发required receipt;
- 任一 Runtime-owned external effect、cleanup、activation、stop、handoff、remote或GC结果为uncertain且无durable resolution;
- 任一旧writer/handle/runtime仍可越过generation/fencing;
- 任一Runtime lane没有合入目标分支或只在其他worktree通过;
- Runtime完整门禁、W5 Harness Regression或credential/redaction检查未通过;
- 04、05、06对同一能力给出冲突结论;
- Runtime diff触及`06`冻结路径但没有显式解冻记录。

以下情况不要求 Runtime 越界继续实现,但必须让相关feature保持unsupported并在W6-G列出:

- 冻结专项自己的验收项未完成或只在fake seam中成立;
- 冻结专项缺真实平台后端、CLI/TUI、publisher/credential、Approval recovery、Plan/overflow/Memory lifecycle;
- 完整产品§11、专项联合E2E或跨平台矩阵因冻结边界仍未关闭。
