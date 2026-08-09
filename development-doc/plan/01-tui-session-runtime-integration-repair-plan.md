# RunLedger TUI 与 Session Runtime 全链路接入修复计划

> 文档状态：implementing（S0–S6 complete；S7 pending）<br>
> 记录日期：2026-08-09<br>
> 记录基线：`session-owner-runtime@c608c77`，记录时工作区干净；S3 实施起点：`2c5a7be`<br>
> 文档职责：跨领域执行编排，不替代各专项的状态与设计权威

## 1. 文档权威与目标

本计划负责把 TUI 接口、Session Owner Runtime、真实 CLI composition 与最终清理排成一条可执行路径。各领域的详细合同、状态复选框和验收证据仍回写到以下权威文档：

- Session Owner Runtime：[`../runtime/06-session-owner-runtime-replacement-plan.md`](../runtime/06-session-owner-runtime-replacement-plan.md)
- TUI passive contract 接线：[`../tui/19-passive-contract-integration-plan.md`](../tui/19-passive-contract-integration-plan.md)
- Plugin/MCP/Hook/Skill：[`../plugin-mcp-skill-hooks/01-implementation-plan.md`](../plugin-mcp-skill-hooks/01-implementation-plan.md)
- Worktree/Security/Permission：[`../worktree-sandbox-permisson/00-worktree-sandbox-permission-plan.md`](../worktree-sandbox-permisson/00-worktree-sandbox-permission-plan.md)
- Trace：[`../runtime/trace/README.md`](../runtime/trace/README.md)

目标是将现有生产链：

```text
bin/runledger.js
  -> cli/main.ts
  -> SessionInteractiveController
  -> InteractiveMode
  -> OpenTuiComponentRuntime
  -> @opentui/core
```

从“合同存在但部分能力虚报”修复为真实、可恢复、可审计的闭环。完成后：

1. TUI 只展示握手协商且后端真实支持的 operation。
2. Session 新建、恢复、分叉可在同一 CLI 进程中完成转场。
3. Process/PTY、Approval、Security、Worktree、Trace、Extension/MCP/Hook/Skill/Plugin 接入 Session Owner Runtime。
4. Prompt Template、用户 Keymap、Durable Queue、Task/Goal、Multi-agent、Runtime Snapshot、Update 在没有真实 authority 时继续明确为 `unavailable`。
5. Timeline 达到旧 message/tool/bash/diff/background 组件的信息等价后，才删除旧组件。
6. TUI 保持 CLI 内部实现，不增加根导出或 `./tui` npm export。

## 2. S0 基线缺口

1. `SessionHandshakeResponse.protocolCapabilities` 已存在，但 RuntimeServer 仍只报告固定的 `session.core`，不能描述真实 domain operation。
2. TUI 仍可能依据 controller 是否存在构造 domain port，从而把不存在的 Session catalog/mutation authority 标为可用。
3. domain query/command 仍残留 Host 命名和旧 Host controller 假设；Session Owner composition 没有对应真实方法时只会返回 unavailable。
4. 标准 CLI 尚未完整装配 process overlay、Trace factory、通用 approval reverse handler、worktree cold resume 和扩展生命周期。
5. `SessionProcessRegistry` 只有容量与状态投影，不拥有真实 process/PTY 生命周期。
6. Session Security 仍缺 Session-scoped durable approval receipt 与可重连 reverse request。
7. `/new`、`/resume`、`/fork` 只存在于启动参数或文档语义，未形成 TUI 内真实转场。
8. quit 绕过伪 `ShutdownWorkflowPort`；该 port 返回 accepted 但没有真实 lifecycle authority。
9. `normalize-action.ts`、`presentation/projectors.ts` 等 canonical 接缝尚未成为唯一生产路径。
10. Timeline 尚未证明对旧工具、Bash、Diff 组件的信息等价，旧组件不能直接删除。

## 3. 接口与合同调整

### 3.1 Capability negotiation

定义只读 `SessionProtocolCapability`：

```ts
type SessionProtocolCapability =
  | "session.core"
  | "session.catalog"
  | "session.process"
  | "session.plan"
  | "session.extensions"
  | "session.mcp"
  | "session.hooks"
  | "session.skills"
  | "session.plugins"
  | "session.credential.reverse"
  | "session.approval.reverse"
  | "session.security.inspect"
  | "session.workspace"
  | "session.trace.local";
```

握手同时返回不可变 capability 集合和精确 operation manifest。宽泛 capability 只用于协议族兼容判断；TUI 是否构造 port、是否发送 effect，必须检查精确 operation。

`OwnedSessionHandle` 固化握手结果，`SessionController.supports(operation)` 成为生产 adapter 的唯一判断入口。握手后不能由 UI 或业务 adapter 动态追加能力。

### 3.2 Session domain envelope

将 `queryHostDomain`、`commandHostDomain` 及 Host-oriented UI 类型迁移为 Session 命名。query 与 mutation 都携带：

- `sessionId`
- `generation`
- `correlationId`
- `effectId`
- operation-specific payload

mutation 额外携带 `expectedRevision`。结果必须区分 `ok`、`unavailable`、`denied`、`stale`、`failed` 和 `recovery_required`，并在适用时返回 settled revision/receipt ref。

未协商 operation 必须由客户端本地返回 typed `unavailable`，不得发送 protocol frame。

### 3.3 CLI/TUI 生命周期

`InteractiveMode.run()` 返回：

```ts
type InteractiveExitIntent =
  | { readonly kind: "quit" }
  | {
      readonly kind: "switch";
      readonly action: "new" | "resume" | "fork";
      readonly target: SessionSwitchTarget;
    };
```

CLI composition root 负责 detach、open/attach、renderer 销毁和下一轮 TUI 启动。TUI 不直接关闭 Runtime、数据库或其他 attached client。

### 3.4 新增内部端口

- Session-scoped `DomainRouter`：统一 query、mutation、revision fence、driver fence、attempt receipt 和 recovery barrier。
- `SessionProcessClient`：提供只读 process/output subscription 和受 driver fence 保护的 stdin/resize/stop。
- Session durable approval adapter：Event Store 保存 request、decision、receipt、allow-once revoke 与恢复状态。
- `handleSessionReverseRequest()`：统一 credential 与 permission 请求分派。

这些接口属于内部实现，不从包根或 npm subpath 导出。

## 4. 分阶段实施

### S0：冻结基线、RED 证据与文档路由

1. 固定分支、HEAD、真实 bin/PATH、production composition 和用户改动边界。
2. 增加 RED 测试证明：固定 capability、controller-presence 虚假可用、未接 domain、缺失 session 命令、假 shutdown、未接 process/trace/approval/worktree。
3. 在 Runtime 06、TUI 19 及各领域权威计划中登记本批状态；不以本文件替代专项复选框。
4. 分开记录 contract、生产 composition、自动化证据、平台证据和 human acceptance。

退出条件：每个已识别缺口都有失败测试或可复现的 production inspection；没有把 adapter/fake port 当成真实 authority。

### S1：真实 capability negotiation 与 Session Domain Router

1. SessionRuntime composition 生成 capability/operation manifest，RuntimeServer 只转发该不可变结果。
2. `OwnedSessionHandle` 保存协商结果；controller 暴露 `supports(operation)`。
3. Domain Router 统一 query、mutation、driver fencing、domain revision、attempt receipt 与 recovery barrier。
4. TUI 只为已协商 operation 构造端口，不能根据 controller 是否存在推断能力。
5. observer 只获得只读 operation；mutation 在客户端发送前拒绝。

退出条件：unsupported operation 不发 frame；capability 在 handle 生命周期内不可变；driver/observer、revision 和 generation 测试全绿。

#### S0–S2 执行记录（2026-08-09）

- S0 已重新固定 `session-owner-runtime@c608c77`、标准 PATH（`/home/nzq/.npm-global/bin/runledger` → 本仓库 `bin/runledger.js`）、`runledger 0.0.1`、production composition 与实施前用户文档改动边界。
- Session wire protocol 升级为 version 3；握手返回严格枚举的 `protocolCapabilities` 与精确 `operationManifest`，descriptor 显式区分 `read|mutate`，并声明 `session.run-timing`。RuntimeServer 在 activate 前冻结 controller manifest，握手后不允许替换 controller。
- `OwnedSessionHandle` 深冻结协商结果并提供 `supports(operation)`；`SessionInteractiveController` 对未协商 domain operation 本地返回 `operation_unavailable`，不发送 protocol frame。
- RuntimeServer 在 controller dispatch 前再次校验 operation manifest；未协商 operation fail closed，observer 只允许 manifest 标记为 read 且 controller 未标记为 mutation 的请求。
- `SessionDomainRouter` 成为 Session catalog 的唯一生产路由，typed envelope/result 覆盖 `sessionId + generation + correlationId + effectId + operation + payload`，mutation 额外校验 `expectedRevision`；结果区分 `ok/unavailable/denied/stale/failed/recovery_required`。
- catalog/create/resume/fork 的 generation、driver/observer、catalog revision 与 fork source-head fence 已闭合；create/fork 在 SQLite mutation 前后写 append-only attempt receipt，recovery barrier 打开时不执行 mutation。生产 TUI 接缝已迁移为 `querySessionDomain`/`commandSessionDomain`，legacy Host 命名只留在 R9 前不可达的旧 Host 安全窗口。
- TUI 不再以 controller 是否存在推断 Session catalog/mutation；`session-domain.ts` 只投影 SQLite canonical 字段并按精确 operation 构造 `SessionWorkflowPort`，无真实 lifecycle operation 时不再构造伪 `ShutdownWorkflowPort`。
- `InteractiveMode` 已接 `/sessions`、`/new`、`/resume [sessionId]`、`/fork`，返回 typed `quit|switch` intent；CLI 负责严格的 detach-before-attach、目标失败后 canonical reopen 原 Session，以及 remote attachment 存在时的 headless owned-runtime 保活。
- RED/GREEN 证据集中在 `domain-router.test.ts`、`session-domain.test.ts`、`session-workflows.test.ts` 与 `session-transition-loop.test.ts`；renderer 启动/运行异常后的 detach 也有回归覆盖。
- 全量并发门禁曾稳定暴露多进程同时 open SQLite 时重复执行 `PRAGMA journal_mode = WAL` 的竞态，以及 claim writer busy 未映射 `owner_store_busy`；新增既有 WAL 并发 open 与双连接 writer-lock RED 后，open 改为只读校验既有 WAL、claim busy 返回 retryable typed result，真实四进程 claim 转绿。
- 阶段收口证据：`npm run check`、`npm test`、`npm run build`、`git diff --check` 全绿；完整 `npm test` 为 Vitest 269 files passed / 1 skipped、1506 tests passed / 3 skipped，以及 Bun OpenTUI 32 tests / 179 assertions passed。该自动化证据只支持 S0–S2 与 run timing/TUI stop marker，不替代标准 PATH fault rehearsal、macOS/Windows runner、独立审计或 human acceptance。

### S2：SQLite Session 工作流与 CLI 转场循环

1. Session catalog view 直接投影 SQLite canonical 字段，禁止伪造 title、path 或 cwd。
2. 实现真实 catalog/create/open-resume/fork effect：
   - `/sessions` 打开 catalog；
   - `/new` 在当前 workspace 创建 Session；
   - `/resume` 选择并打开已有 Session；
   - `/fork` 从当前 Session durable head 分叉并校验 source-head fence。
3. `main.ts` 形成 `open -> TUI -> detach -> switch/quit` 循环；切换时必须先 detach 当前 view，再 attach 目标。
4. 打开目标失败时，只能经同一 Session Owner canonical open 路径重新打开原 Session；禁止 JSONL、旧 controller 或 source checkout fallback。
5. CLI 维护 owned-runtime registry：仍有 remote attachment 的旧 Session 保持 headless；attachment 归零后才 checkpoint、pause、release。

退出条件：同一进程连续创建、恢复、分叉多个 Session；detach-before-attach 可观察；失败转场不会形成双 owner 或双数据库 authority。

### S3：Worktree、Trace、Approval 与 Security

1. Session 持久化 current versioned `worktree_locator_json`；resume 重验 platform、root、Git registration、lease、symlink containment 和 effective cwd。
2. 将 `--worktree`、`--no-worktree` 接入标准 composition；存在 locator 时验证失败必须 fail closed，不回退 source checkout。
3. fork 不继承旧 lease 或 process handle；需要隔离时创建独立 managed worktree。
4. `main.ts` 注入 CLI Trace recorder factory；Trace 绑定 `sessionId + ownerGeneration`，遵守 `off/events/events_and_artifacts` 和 failure policy。
5. 使用 Session Event Store 保存 approval request、decision、receipt、allow-once revoke 和恢复状态，不复用 legacy Host JSON 或仅内存 store。
6. driver 断线时保留有界 reverse-request waiter；新 driver 可在超时前接管。重复、过期或旧 generation 响应必须拒绝。
7. TUI 统一处理 credential 与 permission reverse request；本批只开放 `session.security.inspect`，security mutation 继续 `unavailable`。

退出条件：worktree cold resume、Trace 三模式、approval reconnect/timeout/stale response 和 Security fail-closed 测试全绿。

#### S3 执行记录（2026-08-09）

- Session row 的 `worktree_locator_json` 已保存 current versioned private locator；canonical target 固定为 `<runledgerHome>/worktrees/<sessionId>`。owner-fenced transaction 同步提交 locator、repository identity 与安全的 workspace event；cold resume 重验 platform/version、realpath/symlink identity、Git registration、HEAD/base commit、effective cwd containment、registry record 与 active lease。
- 标准 CLI 已接 `--worktree`、`--worktree-ref`、`--worktree-branch` 与 `--no-worktree`；已有 locator 时禁用或验证失败均 fail closed，不回退 source checkout。clean shutdown 释放 lease，下一 generation 重新获取；fork 不继承 locator/lease。
- `main.ts` 注入 `composeCliTraceRecorderFactory(layout, settings)`；domain 覆盖 recorder 的 `sessionId + ownerGeneration`，继续遵守 `off|events|events_and_artifacts`、正文清洗与 `best_effort|fail_closed`。
- `approval-reverse-request.ts` 以 Session Event Store 为 durable truth 保存 `approval.requested/decided/revoked` 与 receipt CAS；driver 断线后在 expiry 内轮询当前 driver，旧 generation response、timeout 与 abort 均 fail closed。attach-only client 不创建本地 approval authority。
- 真实 domain composition 才协商 `session.approval.reverse` 与 `session.security.inspect`；后者只投影 profile、approval/filesystem/network/sandbox mode、policy digest 与 source count，不返回 native path。未装配 domain 的 test/recovery Runtime 不虚报这两项，security mutation 在客户端本地 `unavailable` 且不发 frame。
- `InteractiveMode.handleSessionReverseRequest()` 统一分派 approval 与 credential，复用同一个 approval modal decision authority；标准 CLI 不再只注册 credential handler。legacy Host handler 仅保留到 R9 安全窗口。
- focused 证据：13 files / 84 tests 全绿，覆盖 worktree cold resume/drift、Trace store/recorder/composition、approval reconnect/timeout/stale/abort、capability/readonly security、TUI adapter 与 reverse handler。完整门禁：`npm run check`、`npm run build`、Vitest 271 files passed / 1 skipped、1521 tests passed / 3 skipped，以及 Bun OpenTUI 4 files / 32 tests / 179 assertions 全绿；该证据不提升 S4–S9、R6.5/R8、跨平台或 human acceptance。

### S4：真实 Process/PTY/output

1. 复用 legacy managed-process 的纯实现，但全部改绑 `SessionId + OwnerFence`，移除 Host scope、hostGeneration 和旧状态自动读取。
2. 建立 Session 隔离的 process state，接通 pipe、PTY、output cursor、stdin、resize、stop、completion、Trace 和 Security final leaf。
3. crash takeover 不重生、猜测或重新认领外部进程；状态标记为 `lost/uncertain`，执行 best-effort cleanup，并保持 recovery barrier 等待显式处理。
4. Session controller 仅在 `session.process` 协商成功时提供 process overlay client。
5. observer 可读取状态和输出，不能执行 stdin、resize、stop。

退出条件：真实 pipe/PTY/output/input/resize/stop、observer denial、crash uncertain 和跨 Session capacity 隔离全绿。

#### S4 执行记录（2026-08-09）

- `SessionManagedProcessComposition` 在每个 owned Session 内独立装配真实 pipe/POSIX PTY、bounded output cursor、stdin/EOF/resize/stop/wait、per-Session capacity 与 graceful terminal drain；stdlib background Bash 复用同一 process client。
- process transition、spawn claim/receipt、constraint snapshot 与 completion queue/suppression 全部写入 owner-fenced Session Event Store；payload 只保存 `SessionId + OwnerFence` 语义，不保存 Host scope、`hostGeneration`、authority/tenant/workspace 字段。filesystem 只保留 private output/content 与 Trace Artifact。
- process domain revision 由 owner-fenced Session Event Store 单独提交并在重启后精确恢复，不再从 handle revision 推算；副作用成功但 revision commit 失败时返回 typed `recovery_required`，且 `process_spawn` attempt 保持 unresolved。attempt 从 spawn 前保持 unresolved，自动或显式 terminal truth 提交后才结算。crash takeover 不按 PID/PTY reattach 或 respawn，旧非 terminal execution 投影为 `lost/uncertain` 并保持 recovery barrier。
- Trace `events|events_and_artifacts` 按 Session owner generation materialize bounded output；Security prepare/final-leaf/complete 贯穿 process 生命周期，自动 terminal 也完成 approval/authorization settlement。
- 标准 CLI 只在精确协商 `session.process.list/output` 时构造 Session overlay client；driver mutation 按精确 operation 注入，observer 在客户端/TCP/server 两层拒绝且不触达 backend。
- focused 证据：Session process domain/composition/security/TUI adapter/control-plane 5 files / 36 tests 全绿（含真实 TCP observer、durable revision 重启恢复与 commit uncertain 回归）。全量门禁：`npm run check`、`npm run build`、Vitest 273 files passed / 1 skipped、1539 tests passed / 3 skipped，Bun OpenTUI 4 files / 32 tests / 179 assertions 全绿；隔离 Linux candidate 基础 fault/latency/security runner再次 ALL PASS。
- candidate runner 本身仍未新增真实 model/MCP/process/PTY/worktree/Trace/approval 组合场景；macOS/Windows、标准 PATH fault rehearsal、独立审计与 human acceptance 仍 pending，因此不提升 R6.5/R8，也不启动 S9/R9。

### S5：Extension/MCP/Hook/Skill/Plugin

1. 复用 `src/extensions/**` 的纯 manager，将 `runtime-host-{mcp,hooks,skills}` composition 迁移为 Session-scoped 实现。
2. 每个 SessionRuntime 独立拥有 manager、registry、snapshot、MCP connections、hooks、plugins 和 cleanup。
3. MCP、Hook、Plugin 副作用统一经过 Gateway、attempt receipt 和 recovery barrier。
4. Skill 恢复执行前重验来源信任、digest 和 `allowedTools`；不得因加载 Skill 自动获得脚本执行权。
5. required startup extension 失败时 typed fail closed；optional 项记录可审计失败。
6. shutdown 顺序固定为：停止新请求 -> settle/barrier -> 关闭 MCP/hooks/plugins -> cleanup resources -> checkpoint -> release owner。

退出条件：不同 Session 的扩展状态、MCP connection 和失败互不污染；required/optional 语义、shutdown 和 crash recovery 有直接证据。

### S6：TUI 状态、输入与展示接线

1. OpenTUI `keypress`、`paste`、focus、resize 事件统一进入 `normalize-action.ts`，不保留第二套快捷键解释器。
2. footer、status、welcome、composer 和 Timeline 使用 `presentation/projectors.ts`；删除重复 mutable presentation owner。
3. capability view 同时依赖 handshake operation manifest 和已注入端口。
4. 接入 `/sessions`、`/new`、`/resume`、`/fork`；不支持的占位命令显示 `unavailable` 且不产生 effect。
5. quit 只产生 typed exit intent，由 CLI detach 并销毁 renderer；删除伪造 accepted 的 `ShutdownWorkflowPort`。
6. 删除未使用的 `debug`、`modelRegistry`、`initialThinkingLevel`、`onThinkingChange` 等 option；若发现真实唯一 authority，则先补合同和测试后接线，不能继续静默接受。

退出条件：输入、paste、resize、focus、session workflow、process overlay 和 approval overlay 都通过真实 OpenTUI renderer 测试。

#### S5–S6 执行记录（2026-08-09）

- `extension-composition.ts` 已成为 production owned Session 的扩展组合根：每个 Session 独立创建 `ExtensionManager`、`PluginManager`、Skill resolver、Hook turn lifecycle 和 `McpConnectionManager`，读取各自 workspace MCP 配置，不存在跨 Session mutable registry 或 connection 复用。中立实现已迁到 `src/extensions/manager.ts`，`host-manager.ts` 只保留 R9 前兼容重导出，Session Owner 边界检查不再需要 legacy Host import 豁免。
- required MCP 启动失败会在 Runtime activate 前 typed fail closed、写审计并释放 owner；optional 失败写 `extension.mcp.optional_failed` 后允许启动。MCP catalog discovery 失败会关闭已连接 transport；`mcp_call` 在接触 transport 前先进入 attempt gateway/recovery barrier，Hook managed process 在 barrier 拒绝后不会读取输出或执行 wait/stop。
- Skill 正文继续通过 trust/digest/`allowedTools` 重验后按需加载；Plugin 只贡献已启用且受信的 Skill/Hook/MCP descriptor。当前支持的外部 lifecycle 在 checkpoint 与 owner release 前按 MCP -> Hook -> Plugin -> cleanup 顺序关闭，生产测试直接观察该顺序。
- OpenTUI keypress、paste、resize、focus/blur 已统一进入 `normalize-action.ts`；第二套 app key interpreter 已删除。reducer 新增 normalized focus/viewport state，`projectInteractivePresentation()` 一次性投影 Timeline、session strip、active/status、footer、welcome 与 composer，`InteractiveMode` 不再直接解释 Timeline。
- TUI capability view 只有在握手精确协商 operation 且 composition 注入对应 port 时才可用；既有 `/sessions`、`/new`、`/resume`、`/fork` 转场继续通过 typed Session intent，quit 仍只返回 typed exit intent。未使用的 InteractiveMode options 已删除。
- 原生 OpenTUI 回归证明 key/paste/focus/resize、process overlay 与 approval overlay 都走真实 renderer；approval selector 依照 OpenTUI 每 option 两行的布局合同计算高度，`Allow once` 与 `Deny` 同时可见，renderer destroy 仍由 owner 控制。
- focused GREEN：S5/S6 11 files / 94 tests；Extension manager/lifecycle/runtime 3 files / 15 tests；Bun OpenTUI 4 files / 33 tests / 187 assertions。全量 `npm test` exit 0，Vitest JSON reporter 为 627 suites / 1558 tests（1555 passed、3 skipped、0 failed）；`npm run check` 与 `npm run build` 通过。
- 本批闭合 S5、S6 与 Runtime R6 的 MCP/Hook/Skill/Plugin production blocking gap，但不把 Extension 专项的完整 CLI mutation、trust/enable/reload、plugin fixture、MCP OAuth 等剩余范围标为完成。candidate runner 仍未覆盖真实 model/MCP/process/PTY/worktree/Trace/approval 组合，macOS/Windows、标准 PATH fault rehearsal、独立审计和 human acceptance 仍 pending，因此 R6.5/R8 不接受，S7 尚未开始，S9/R9 不启动。

### S7：Timeline 等价性与 TUI 清理

先增加旧组件与 Timeline 的等价性测试，覆盖：

1. user/assistant 多行、OpenTUI 原生换行与 thinking；
2. tool pending/running/ok/error、参数摘要、结果和错误；
3. Bash stdout/stderr、tail、background、exit code、duration；
4. Diff before/after/error。

等价通过后：

1. 删除未挂载的旧 message/tool/bash/diff/background 组件及对应旧测试；
2. 删除旧 JSONL session selector、未使用 specialized selectors、重复 TimelineStore、alternate renderer、stub feature adapter 和 runtime repl handle；
3. 保留并正式接入 projector、normalizer 和 canonical Timeline。

退出条件：旧组件没有生产引用；Timeline 回归覆盖被删除组件的全部安全展示信息；删除不会恢复 raw args、secret 或无界 output。

### S8：联合验收

1. 完成全量自动化、真实 PATH、PTY、多窗口、跨平台和独立审计。
2. Linux candidate 通过不能替代 macOS、Windows、标准 PATH、独立审计或真人验收。
3. 任一真实领域仍依赖 legacy Host 时，Runtime 06 的 R8 保持 not accepted。

退出条件：Runtime 06 R8 的自动、平台、独立审计和 human acceptance 全部签收。

### S9：Legacy Host 删除

仅在 S8/R8 全部签收后执行：

1. 删除 `runtime/host/**`、`storage/host/**`、`runtime-host*.ts` 和 Host scripts/native helper；
2. 删除对应 package scripts、build manifest 和兼容 alias；
3. 静态边界测试确认标准 CLI、TUI、Session Owner、process、MCP、worktree、Trace、approval 均无法再引用 Host；
4. 删除后重新执行全部 S8 门禁。

退出条件：全仓只剩 Session Owner production authority；任何回归都阻止 R9 完成，不恢复双 authority。

## 5. 测试矩阵

### 5.1 Protocol 与 Runtime

- capability schema、immutable handle、unsupported operation 不发 frame；
- driver/observer、domain revision、generation、correlation/effect fencing；
- recovery barrier、attempt receipt、stale result 和重复 response；
- Session create/resume/fork、多 Session 同进程、detach-before-attach。

### 5.2 Approval、Security、Worktree、Trace

- approval reconnect、timeout、丢失响应恢复、allow-once revoke；
- Security final leaf 与 unavailable mutation；
- worktree drift、symlink/junction、Git registration、lease fail closed；
- Trace off/events/artifacts、正文清洗、owner generation、best-effort/fail-closed。

### 5.3 Process 与扩展

- 真实 pipe/PTY/output cursor/stdin/resize/stop/completion；
- observer mutation denial、crash uncertain、best-effort cleanup；
- MCP/Hook/Skill/Plugin Session 隔离、required failure 和有序关闭。

### 5.4 OpenTUI 原生测试

- 一律使用 `@opentui/core/testing#createTestRenderer()`；
- 验证真实 frame、keypress、bracketed paste、resize、focus、selection 和 overlay；
- 每个测试在 `finally` 中调用 `setup.renderer.destroy()`；若测试另有 runtime owner，也在同一 `finally` 中销毁；
- renderer 销毁先于自定义 transport 关闭，避免终端状态或输出 ownership 泄漏。

### 5.5 全量与真实入口

每阶段先增加 RED，再完成 focused GREEN。S2、S4、S6、S7、S9 必须运行：

```bash
npm run check
npm test
npm run build
git diff --check
```

最终还必须覆盖：

- 隔离 Session Owner candidate；
- PATH 上真实 `runledger --help`、`runledger --version` 和无参数 TUI；
- 真实 PTY 下同 Session 多窗口、不同 Session 并行、crash takeover；
- macOS/Windows 同路径 runner；
- 独立只读审计和真人 acceptance。

## 6. 阶段停止规则

出现以下任一情况，立即停止后续阶段并保留当前 authority：

1. TUI 暴露未协商或无后端实现的 capability；
2. unsupported operation 仍发送 protocol frame；
3. mutation 缺 receipt、revision 或 generation fence；
4. side effect 绕过 Gateway 或 recovery barrier；
5. Session/worktree 恢复回退旧 JSONL、旧 controller 或 source checkout；
6. 同一领域出现 Session Owner 与 legacy Host 双 production authority；
7. crash 后自动重放 uncertain side effect；
8. 原生 OpenTUI 测试未显式销毁 renderer；
9. macOS/Windows、独立审计或 human acceptance 缺失却准备执行 R9。

## 7. 固定假设与非目标

1. 以 `session-owner-runtime@c608c77` 作为本文记录基线；实施前必须重新核对 HEAD、worktree 和标准 PATH。
2. TUI 继续作为 CLI 内部实现，不增加 npm TUI export。
3. 没有真实 authority 的 Prompt Template、用户 Keymap、Durable Queue、Task/Goal、Multi-agent、Runtime Snapshot、Update 保持 `unavailable`。
4. 不新增第二套 Session 存储、兼容 fallback、daemon、machine leader、Unix Socket、Named Pipe 或 OS service。
5. 被 Timeline 替代的旧组件必须先完成等价性回归，才能删除。
6. 本计划不授权提前执行 Runtime 06 R9。
7. 实施提交按领域拆分，只暂存明确路径；未经用户明确要求不提交、不推送。
