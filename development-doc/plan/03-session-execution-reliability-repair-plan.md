# RunLedger Session 执行可靠性修复计划

> 文档状态：implementing。P0、P2–P6 已实现并通过 focused 回归；P1 的
> sandbox-off/foreground/background/pipe/PTY 共享工具链与环境已实现，限制性
> sandbox runtime mounts 受 ADR 04 冻结而 blocked；P7 已完成本地全量门禁，
> candidate/linked CLI/TTY 仍 blocked/pending，R8 与 human acceptance 未完成。
>
> 建立日期：2026-08-12。
>
> 代码基线：`session-owner-runtime@0b608b1e871d`。
>
> 事故样本：`session_cwd-_data2-HDD-SATA-20T_Digital_avatar_haowe-mspqa46s`。
>
> 文档职责：编排一次跨 Session Runtime、Security/Sandbox、Process、Trace 与 Storage 的可靠性修复；不替代各领域权威文档。

## 1. 目标与权威边界

本计划把一次真实 Session 审计中暴露的问题转成可分阶段执行、回归和验收的修复工作。目标不是只让一条 `npm` 命令偶然成功，而是让标准 `runledger` 的 Session Owner 生产路径满足以下结果：

1. 受治理 Bash 能在不挂载真实用户 home、不复制父进程全部环境的前提下，稳定运行仓库声明的 Node/npm/Bun 工具链和 package-local binaries。
2. Approval/Credential 等人工等待由 Session Runtime 统一计时，等待时间不计入 `activeDurationMs`。
3. 每次用户请求拥有明确的 model/tool/时间/重复失败预算，不会因模型持续返回 `toolUse` 而无限循环。
4. `agent_end`、checkpoint、Session catalog、owner 状态与 replay projection 对同一事实给出一致结果。
5. 主 Trace 与 managed-process Trace 均有终态；流式事件写入随正文长度近似线性增长，不再重复持久化不断增大的完整 partial。
6. 最终以隔离 `RUNLEDGER_DIR`、标准 Session Owner production composition 和真实 `npm run check`/`npm test` 闭环，而不是只验证 helper、fake port 或 source import。

领域权威仍是：

- Session Owner 与恢复：[`../runtime/06-session-owner-runtime-replacement-plan.md`](../runtime/06-session-owner-runtime-replacement-plan.md)
- Security/Sandbox/Permission：[`../worktree-sandbox-permisson/00-worktree-sandbox-permission-plan.md`](../worktree-sandbox-permisson/00-worktree-sandbox-permission-plan.md)
- Trace/Event/Artifact：[`../runtime/trace/README.md`](../runtime/trace/README.md)
- TUI streaming projection：[`../tui/18-opentui-streaming-performance-ux-plan.md`](../tui/18-opentui-streaming-performance-ux-plan.md)
- 跨领域 Session/TUI 接线：[`01-tui-session-runtime-integration-repair-plan.md`](01-tui-session-runtime-integration-repair-plan.md)

本文件只负责编排阶段、依赖、停止规则和联合门禁。每个阶段完成后，必须把实际状态与 fresh evidence 回写对应领域权威；不能只勾选本文就宣称 Session Owner R8 完成。

### 1.1 2026-08-12 当前实施状态

| 阶段 | 状态 | 当前证据与边界 |
|---|---|---|
| P0 | implemented | 脱敏 incident manifest 已固定错误计数、完整性与 executable provenance；不含 Session 正文、reasoning、credential 或 Artifact。 |
| P1 | partial / blocked | `SessionToolchainSnapshot`、最小 child env、私有 `0700` HOME/cache/tmp、环境/toolchain digest、spawn 前 identity 复验和 off-plan immutable launch plan 已接入 production Session domain。真实本机 off-plan 已运行 Node 22.23.1、npm 10.9.8、Bun 1.3.14 与 workspace-local `tsx`；parent secret/proxy 不继承。限制性 Linux runtime mounts、identity files 与 macOS/Windows 等价证据会扩大已冻结 sandbox 能力面，必须等待 ADR 04 的新 unfreeze ADR。 |
| P2 | implemented | Approval reverse request 与 Credential login 共用 `SessionRuntime.withHumanInputWait()`；allow/deny/timeout/abort/reconnect 与 nested wait 有 durable pause/resume 回归。 |
| P3 | implemented | per-prompt run budget 已覆盖 model/tool/active-time/repeated-failure/approval-expiration，预算终止用 `stopReason="length"` + typed `terminationReason`。 |
| P4 | implemented | `agent_end.messageCountAtEnd`、owner/catalog lifecycle projection 与 replay 一致；versioned projection repair 只在 matching migration gate + zero active owner 下修复 cache，不改写 event。 |
| P5 | implemented | `RuntimeTraceRecorder.finishRun()` 幂等闭合 process trace；normal/failed/timed-out/killed/lost/uncertain 与 takeover 均有终态，terminal 后移除 recorder。 |
| P6 | implemented | durable delta 50 ms/4 KiB 合并，移除 cumulative `partial`，保存 aggregate digest/size；边界强制 flush，content end/dispose 释放 state，新 message start 前不丢 pending delta。 |
| P7 | partial / blocked | 当前工作树的 `npm run check`、完整 `npm test`、`npm run build` 与 diff hygiene 已通过；尚未重链标准 CLI，restrictive candidate-domain、TTY、人审与三平台 evidence 均未执行。 |

2026-08-12 fresh 本地证据：P2–P6 focused matrix 为 15 files / 109 tests；收尾
重构后的跨域 focused matrix 为 5 files / 21 tests。`npm run check` 通过；完整
Vitest 为 297 files / 1724 passed，另有 1 file / 3 macOS-only tests skipped；
Bun/OpenTUI 为 3 files / 44 passed / 222 assertions；`npm run build` 与
`git diff --check` 通过。上述结果证明当前 checkout 的源码与构建门禁，不替代
restrictive sandbox、联合 candidate、linked CLI/TTY、三平台或 R8 人工接受证据。

## 2. 事故基线与已确认事实

审计只读检查了用户级 `/home/nzq/.runledger/state.db`、Trace/Artifact 文件和当前生产源码，没有修改数据库、设置、进程或工作树。事故样本的关键事实如下：

证据 provenance 另有一个必须先隔离的问题：截至 2026-08-12，`/home/nzq/.npm-global/bin/runledger` 解析到 sibling checkout `/data2-HDD-SATA-20T/Digital_avatar/haoweiyao/RunLedger-tui-mermaid/bin/runledger.js`，而不是本文代码基线所在仓库。因此，现有 linked CLI/TTY 结果不能证明 `session-owner-runtime@0b608b1e871d` 的行为。本次规划不修改全局链接；P0 必须记录解析后的绝对入口与 checkout HEAD，P7 验收前再按仓库规则明确重链并复核，避免混用两个工作树的构建产物。

| 维度 | 已确认事实 | 直接影响 |
|---|---|---|
| 用户请求 | `在这个项目中运行npm相关测试` | 至少应得到 `npm run check` 与 `npm test` 的明确结果 |
| 最终结果 | 12 个 model turn、11 次 Bash、约 240 秒后 `aborted`；`npm test` 未调用 | 用户任务未完成且没有可信最终答复 |
| 工具环境 | `HOME`/`USER` 为空，UID 1031 无 identity；先命中 Node 16.20.2，package-local `tsx` 不可执行 | 当前 governed process environment 不能支撑普通 npm 工作流 |
| Approval | 9 次 requested，7 次 decided/revoked，最后 2 次各约 30 秒超时 | reverse request 可等待，但没有纳入 Runtime 计时边界 |
| Run timing | 没有 `agent_work_pause/resume`；`elapsedMs=activeDurationMs=239757` | TUI 和 replay 的 active time 高估 |
| Run 终态 | `agent_end.messageCountAtEnd=0`，有效 paused checkpoint 有 24 条消息 | durable run summary 与恢复上下文矛盾 |
| Session 状态 | catalog=`active`，owner=`unowned`，current checkpoint=`paused` | catalog projection 漂移；同库 11 个 Session 有同类状态 |
| Trace | 主 Trace 86 events 且闭合；9 个 process Trace 均只有 started/started/output 三条 | process trace tree 永久显示未结束 |
| Event 成本 | 2437 个 SQLite events，约 2.4 MB payload；2122 个 `message_update` 占约 2.18 MB | 单次短任务产生明显写放大 |
| 完整性 | sequence/hash chain/checkpoint digest 全部有效；11 个 tool call 均有 result；9 个 process attempt 均 committed | 不应把问题误诊为 SQLite corruption 或副作用未结算 |

另有一个命令表达问题：`npm run check ...; echo "CHECK_EXIT=$?"` 会让 shell 最终返回 `echo` 的 0，导致工具 `isError=false`，即使正文里的真实 check exit 是 254 或 127。修复不得靠解析任意 stdout 中的 `CHECK_EXIT=` 字样猜状态；自动门禁必须直接执行目标命令，若要打印状态必须显式保存后 `exit "$status"`。

## 3. 不可破坏的设计约束

1. **单一生产 authority**：继续使用 `SessionOwner -> SessionRuntime -> InteractiveSessionController -> governed ExecutionGateway`；不得回退 legacy Host、raw shell 或 unsandboxed fallback。
2. **不挂载真实 home**：不得为修 npm 而把 `/home/nzq`、`~/.npm`、凭据目录或父进程全部环境暴露给 sandbox。
3. **不自动安装/切换工具链**：Runtime 不执行 `n`、`nvm`、`npm install -g`、Corepack mutation 或下载 Node/Bun；缺失或版本不符必须在 spawn 前 typed fail closed。
4. **环境也是执行决策的一部分**：规范化 env、toolchain、runtime mounts、cwd、policy 与 sandbox plan 都必须进入 request/plan digest；final leaf 不能在校验后替换它们。
5. **人工等待只有一个计时 authority**：Approval 和 Credential 都通过 `SessionRuntime.withHumanInputWait()`；TUI 不自行推算或扣减时间。
6. **事件是事实，checkpoint 是 cache**：状态修复不能把 checkpoint 变成新 authority；删除 checkpoint 后仍能从 Event + Receipt 重建。
7. **预算停止不是 provider 错误**：保留 pi-ai `StopReason` 集合；RunLedger 另记录结构化 termination reason，不能把本地预算耗尽伪装成 provider `error`。
8. **实时显示与 durable replay 分层但不失真**：允许对 streaming 降频/合并，最终 message、tool、turn 和 run 边界必须 durable，断线重连不得重复或丢失已确认内容。
9. **真实用户数据不进入 fixture**：回归测试只使用合成事件、脱敏错误码和隔离 `RUNLEDGER_DIR`；不得复制事故 Session 的正文、reasoning、credential 或 Artifact 到仓库。

## 4. 目标结构

```text
CLI composition root
  -> resolve/attest SessionToolchainSnapshot
  -> build GovernedProcessEnvironment
       HOME=/tmp/runledger-home
       TMPDIR=/tmp
       USER/LOGNAME=runledger
       PATH=<workspace node_modules/.bin>:<attested toolchain bins>:<fixed system bins>
  -> Security snapshot + SandboxPrepareRequest
  -> immutable SandboxLaunchPlan
       runtime mounts + identity files + env + command + cwd + digests
  -> Session-owned managed process

SessionRuntime
  -> LateBoundHumanInputWaitPort
       approval/credential -> pause/resume -> durable agent event
  -> AgentRunBudget
       model turns/tool turns/active time/repeated failures/approval expiry
  -> authoritative agent_end + lifecycle projection
  -> bounded streaming event coalescer
  -> main trace + process trace terminal settlement
```

### 4.1 `SessionToolchainSnapshot`

建议新增 Host-private、不可变的工具链快照，至少包含：

```ts
interface SessionToolchainSnapshot {
  readonly node: ExecutableAttestation;
  readonly npm: ExecutableAttestation;
  readonly bun: ExecutableAttestation;
  readonly packageBinDirectory: string;
  readonly packageRoot: string;
  readonly snapshotDigest: RuntimeDigest;
}
```

`ExecutableAttestation` 至少绑定 canonical executable/root、版本、文件 identity/digest 与 probe time。Node 必须满足当前 `package.json#engines.node >=22.19.0`，Bun 必须满足 `>=1.3.0`；npm 必须能由 attested Node 执行。只验证 npm 脚本时不能因为 `npm test` 内部需要 Bun 而漏挂 Bun。

### 4.2 `GovernedProcessEnvironment`

第一版固定由 production composition 生成，不新增环境变量或 CLI flag authority：

- `HOME=/tmp/runledger-home`，由 sandbox backend 创建为本次 process 私有可写目录；
- `TMPDIR=/tmp`、`XDG_CACHE_HOME=/tmp/runledger-cache`、`npm_config_cache=/tmp/runledger-npm-cache`；
- `USER=runledger`、`LOGNAME=runledger`、`SHELL=<validated shell>`；
- `PATH` 只含 workspace `node_modules/.bin`、attested Node/npm/Bun bin 和固定系统目录；
- 可透传的 locale/terminal 字段采用明确 allowlist；API key、auth、proxy、任意 `*_TOKEN` 不自动进入工具进程；
- 显式 tool env override 继续经过 policy、normalization 和 digest，不允许覆盖 `HOME/PATH/USER` 等保留键。

Linux bwrap 增加独立的 `runtimeMounts` 概念，和用户 read/write permission roots 分开：只读挂载已证明的 Node/npm/Bun installation root、必要共享库及按 network policy 选择的系统 trust/resolver 文件；生成最小 passwd/group identity 文件并只读挂到 sandbox。所有 mount 都进入 launch plan digest。macOS/Windows 由各自 adapter 产生等价能力证据；无证据的平台返回 typed `unverified_platform`，不能静默落到 Host 环境。

## 5. 分阶段实施

### P0：冻结事故证据与建立 RED 回归

目标：先证明当前 production composition 会复现问题，并把每个缺口拆成窄失败测试。

工作项：

1. 冻结 executable provenance：保存 `which runledger`、`readlink -f`、目标 checkout HEAD 与当前测试 checkout HEAD；在入口未指向本 checkout 时，所有 linked CLI/TTY evidence 标为 invalid，不得用于关闭阶段。
2. 新增脱敏 incident manifest，只保存计数、错误码、状态组合和 digest，不保存模型 reasoning/正文。
3. 使用隔离 `RUNLEDGER_DIR` 与临时 workspace 构造以下 RED：
   - governed Bash 内 `HOME/USER/PATH` 和 Node/npm/Bun contract 不满足；
   - `npm run check` fixture 无法解析 package-local `tsx`；
   - approval timeout 没有产生 pause/resume，active time 未扣除；
   - 连续 `toolUse` 不触发 bounded stop；
   - `agent_end` 把 24-message run 归一化成 0；
   - `owner.released(reason=paused)` 后 catalog 仍 active；
   - process Trace 缺 `agent.finished/trace.finished`；
   - N 个单字符 delta 产生 O(N²) 级 payload。
4. 用仓库 `SessionStore.replaySessionEvents()` 和 `validateCheckpointCache()` 验证 fixture hash/checkpoint，防止把编码差异误报为 corruption。

建议测试路径：

```text
tests/runtime/session-runtime/session-execution-environment.test.ts
tests/runtime/session-runtime/approval-run-timing-integration.test.ts
tests/runtime/session-runtime/run-budget.test.ts
tests/runtime/session-runtime/lifecycle-consistency.test.ts
tests/runtime/session-runtime/process-trace-lifecycle.test.ts
tests/runtime/session-runtime/stream-event-compaction.test.ts
```

退出条件：上述失败都能稳定复现且原因单一；现有完整性测试继续证明 sequence/hash/checkpoint/receipt 没有损坏。RED 输出先记录，阶段实现转绿前不把默认分支留在失败状态。

### P1：受治理执行环境与工具链证明（部分实现，限制性 sandbox blocked）

目标：让 foreground/background Bash、pipe/PTY 和 sandbox on/off 共用同一份受治理环境，不再依赖偶然的 shell 默认值。

工作项：

1. 在 CLI composition root 解析一次 `SessionToolchainSnapshot`；禁止在每个 tool call 内重新探测或修改全局 PATH。
2. 新增 `GovernedProcessEnvironment` builder，拒绝保留键冲突、相对 PATH、不可达 executable、版本不符和 symlink identity 漂移。
3. 扩展 `SandboxPrepareRequest/SandboxLaunchPlan/BackendLaunchPlan`，明确携带：
   - runtime mounts；
   - generated identity files；
   - normalized environment；
   - toolchain snapshot digest。
4. 修正 `offPlan` 和 restrictive plan 的共同环境语义：sandbox=off 只表示不启用 OS 隔离，不表示把 child env 置空或绕过工具链校验。
5. Linux bwrap 创建私有 HOME/cache/tmp，不挂真实 home；验证 `node -v`、`npm -v`、`bun --version`、`npm exec -- tsx --version` 和 fixture `npm run check/test`。
6. process/PTY 使用完全相同的 attested descriptor；不得让 PTY 走另一套 ambient env。

退出条件：

- 在 restrictive Linux sandbox 中，Node/npm/Bun 版本满足 engines，package-local `tsx/vitest/tsc` 可执行；
- `whoami` 或等价 identity probe 有稳定结果，HOME 可写但进程看不到真实用户 home；
- 故意移除 Bun、放入旧 Node、替换 executable identity 或篡改 plan env 时，spawn 前 typed fail closed；
- 网络 deny 时仍无网络；增加 runtime mount 不会扩大 workspace write roots。

### P2：统一人工等待与命令结果语义（implemented）

目标：Approval/Credential 的等待生命周期完整、可回放，并防止自动验收把被 shell 尾命令覆盖的状态当成功。

工作项：

1. 新增 `LateBoundHumanInputWaitPort`，解决 approval ports 在 `SessionRuntime` 构造前创建的循环依赖，装配方式与现有 `LateBoundAttemptPort` 一致。
2. `SessionReverseApprovalPrompter.request()` 用 stable wait ID 包裹整个逻辑 approval 生命周期，包括 driver 断线轮询、重连、allow/deny、timeout、abort 和 channel failure；`finally` 必须关闭最后一个 wait。
3. Credential login 改用同一 port，不保留第二套直接调用计时器。
4. nested waits 只在第一个 wait 时 pause、最后一个 wait 完成时 resume；旧 generation response 不得关闭新 generation 的 wait。
5. `agent_end` 在尚有 open wait 时以最后一次 active 累计值收口；recovery projection 不补造不存在的 pause/resume。
6. 更新 Bash 工具描述与 agent system prompt：自动门禁直接执行目标命令；需要打印 exit 时使用 `status=$?; ...; exit "$status"`。不在 Bash tool 中启用 stdout heuristic，也不全局强塞 `set -e` 改变用户 shell 语义。

退出条件：allow、deny、timeout、abort、driver disconnect/reconnect、nested approval+credential 都有 durable pause/resume；`elapsedMs - activeDurationMs` 与受控人工等待窗口一致。真实 gate 只有 process exit 0 才算通过。

### P3：每请求运行预算与重复失败止损（implemented）

目标：production Agent Loop 必须有默认、不可绕过的有界停止条件。

第一版引入 Runtime-owned `AgentRunBudget`，不从额外环境变量读取：

```ts
interface AgentRunBudget {
  readonly maxModelTurns: 32;
  readonly maxToolTurns: 16;
  readonly maxActiveDurationMs: 900_000;
  readonly maxRepeatedFailureFingerprint: 3;
  readonly maxApprovalExpirations: 2;
}
```

工作项：

1. 预算在 Session production composition 注入，`InteractiveSessionController` 不得省略；低层 Agent 单测仍可显式覆盖。
2. `runAgentLoop` 在 model dispatch 前、工具批次后和下一 turn 前检查预算；中断仍优先于预算。
3. failure fingerprint 只使用 tool name、typed error code、exit/signal、policy/request digest 等安全字段，不 hash 整段 stdout、绝对路径或 secret。
4. 达到预算时不再调用下一次 model/tool，追加结构化 `terminationReason`：
   - `model_turn_limit`
   - `tool_turn_limit`
   - `active_duration_limit`
   - `repeated_tool_failure`
   - `approval_expiration_limit`
5. 保持 `StopReason` 与 pi-ai 兼容：预算停止使用 `stopReason="length"`，并以独立 `terminationReason` 表达本地原因；TUI 显示可操作说明。
6. steering/follow-up 不重置同一个用户请求的预算；新用户 prompt 才开始新 run/budget。

退出条件：无限 `toolUse`、重复 `approval_stale`、相同工具失败和 active-time 超限均确定性停止；停止后有非空 assistant/system completion summary，且不会启动额外副作用 attempt。

### P4：Run 终态、Session catalog 与 replay 一致性（implemented）

目标：一次 run/session 生命周期只存在一份可重建事实，缓存列与 checkpoint 只是正确投影。

工作项：

1. 修复 `messageCountAtEnd`：current `agent_end.messageCountAtEnd` 已由 loop 基于最终 messages 生成，`AgentRunTimingTracker.accept()` 应优先验证并保留该值；只对 legacy 缺字段事件使用 snapshot count fallback。
2. 增加真实 `Agent -> SessionRuntime` 集成回归，断言 abort/error/normal/budget stop 的 durable count 与 final controller/checkpoint messages 一致。
3. 明确现有 owner lifecycle 到 Session status 的投影：
   - `owner.claimed/taken_over + running` -> `active`；
   - `owner.released(reason=paused|detached)` -> `paused`；
   - `owner.released(reason=error)` -> `failed`；
   - fenced/crash takeover -> `recovery_required`，直到显式 recovery decision。
4. owner claim/release audit event、owner row 和 `sessions.status` 必须在同一 SQLite transaction 更新；不得先写 cache 再异步补 event。
5. `rebuildFromEvents()` 消费同一 lifecycle mapping，删除 checkpoint 后结果必须等于缓存 projection。
6. 为既有 drift row 增加版本化、幂等的 projection repair：只根据已校验 Event/Owner truth 修正 `sessions.status`，不重写事件、不伪造历史、不读取 checkpoint 作为 authority。先在数据库副本验证，再通过正常 schema migration 运行；不得用一次性手工 SQL 修改真实用户库。

退出条件：catalog、owner、checkpoint、full replay 对 active/paused/failed/recovery_required 一致；事故形态 `active + unowned + paused` 的合成 fixture 被修复，重复 migration 无变化。

### P5：Process Trace 生命周期闭合（implemented）

目标：每个创建的 Trace root 最终都进入 finished/interrupted/failed 之一，且 recorder 不泄漏。

工作项：

1. 给 `RuntimeTraceRecorder` 增加幂等的显式终态 API，不能由 process composition 调用 private 方法或伪造普通 AgentEvent。
2. process terminal callback 在 output materialization 完成后结束 agent/trace node；failed/timed_out/killed/lost/uncertain 映射到准确 phase/error certainty。
3. orderly Session shutdown 先 flush output/materializer，再结束 process trace；随后才 checkpoint/release owner。
4. crash takeover 根据 durable process projection 查找确定性 trace ID，把遗留 started trace 结为 interrupted/uncertain；不能猜测进程成功或重新连接 child handle。
5. 每个 recorder terminal 后从 `processTraceRecorders` 删除；重复 terminal/output callback 幂等，不追加第二个 terminal event。
6. `best_effort` 只降级 Trace，不改变 process truth；`fail_closed` 在无法持久化要求的 trace terminal 时阻止宣称完整收口。

退出条件：正常、失败、超时、kill、Session pause、crash takeover 六类场景中，每个 trace tree 都没有无解释的 started root；主 Trace 行为不回归。

### P6：Streaming durable 写入线性化（implemented）

目标：消除每 token 重复写入完整 `partial.content` 导致的 O(N²) 写放大，同时保持 TUI streaming 和 reconnect replay 正确。

实施顺序：

1. 冻结 current `message_update` consumer 清单，先给 TUI projector 增加 delta-only 输入能力；不得先删 `partial` 再让 renderer 丢内容。
2. 在 Session Runtime 增加有序 coalescer：同一 content index 的 delta 最快每 50ms 或累计 4KiB flush 一次；`message_end/tool_execution_start/turn_end/agent_end/checkpoint/shutdown` 前强制 flush。
3. durable `message_update` 只保存 bounded delta、content index、stream subtype、aggregate digest/size 和必要 tool-call identity，不保存随每个 token 增长的完整 partial。
4. `message_end` 保存最终 authoritative message；TUI 用最终 message 替换临时组装值。
5. reconnect 从 durable deltas 重建 active message；超过 subscription replay bound 时使用 snapshot + bounded active-progress descriptor resync，不回退读取 Trace Artifact 当会话事实。
6. 对 event count、payload bytes、flush latency、shutdown flush 和 cursor ACK 建立性能/正确性测试。

量化门禁：

- N 与 2N 字符的 synthetic stream，durable payload 增长比不超过 2.5；
- durable `message_update` 中不再出现 cumulative `partial.content`；
- 1 字符 delta 风暴下 TUI 首次可见更新不超过 100ms，最终正文逐字节一致；
- message/tool/turn/run 边界顺序、hash chain、subscription cursor 和 replay 无缺失/重复。

### P7：联合 candidate、真实 npm 验收与 rollout（not started）

目标：在不操作真实用户 Session 数据的情况下，用生产 factory 证明修复闭环，再做一次受控真实交互验收。

自动化 candidate 使用隔离 `RUNLEDGER_DIR`，至少包含：

1. **toolchain**：restrictive sandbox 内运行 Node/npm/Bun/package-local binaries，验证无真实 home 可见。
2. **approval timing**：人为保持 approval 2 秒后 allow，断言 `elapsedMs - activeDurationMs >= 2s`；再覆盖 timeout/abort。
3. **run budget**：scripted provider 无限返回 tool call，验证预算停止且无额外 attempt。
4. **npm gates**：直接执行当前 checkout 的 `npm run check` 与 `npm test`，分别保存 exit、duration、output digest；不能使用尾随 `echo` 覆盖状态。
5. **lifecycle**：最后 attachment 退出后 owner=unowned、session=paused、checkpoint replay-ready、message count 一致。
6. **trace**：主 Trace 和所有 process Trace 有终态，Artifact ref/digest 可验证。
7. **write budget**：event/payload 指标满足 P6 线性门禁。
8. **recovery**：在 approval wait、model turn、process output 三个边界分别 fault，验证 takeover 不重复副作用且 run/session 状态可解释。

production smoke：

```bash
npm run check
npm test
npm run build
which runledger
npm ls -g --depth=0 | grep runledger
```

`which` 与 `npm ls -g` 只证明命令名/包链接存在，必须再用 `readlink -f "$(which runledger)"` 证明最终入口属于本 checkout，并记录该 checkout HEAD 与 build manifest；若仍指向 `RunLedger-tui-mermaid` 或其他工作树则立即停止，不运行或采纳 linked smoke。确认 provenance 后，再用隔离 `RUNLEDGER_DIR` 和真实 TTY 启动 linked `runledger`，提交“在这个项目中运行npm相关测试”，确认 approval modal、Working/Waiting 计时、check/test 结果、非空最终答复和退出后的 paused catalog。真实 provider smoke 是 opt-in，不进入默认测试；证据只保存 provider/model ID、结果摘要和 digest，不保存凭据或 private reasoning。

退出条件：candidate 全部通过；标准 PATH 指向本 checkout；当前全量 gate 通过；真人确认 TUI 等待/停止/最终结果可理解。只有这些 evidence 回写 Runtime 06、Security、Trace 和 TUI 权威文档后，才可把本计划标为 implemented。

## 6. 验证矩阵

| 风险 | 最低测试层 | Production evidence |
|---|---|---|
| 空 HOME/PATH/identity | environment builder + Linux bwrap integration | linked Session Bash 运行 Node/npm/Bun |
| 旧 Node/缺 Bun/toolchain 漂移 | attestation/final-leaf negative tests | spawn 前 typed rejection |
| Approval time 未扣除 | run timing integration | TUI Waiting + durable pause/resume |
| 无限 tool loop | scripted stream budget tests | candidate 无人工 abort 自动停止 |
| message count=0 | Agent/SessionRuntime/checkpoint integration | final count 与 paused checkpoint 一致 |
| catalog active/unowned | owner transaction + migration + replay | linked CLI 退出后 catalog paused |
| process trace 未闭合 | recorder/process terminal/fault tests | 每个 trace root 有 terminal phase |
| message_update O(N²) | synthetic N/2N benchmark | candidate payload budget |
| shell 尾命令掩盖 exit | Bash/system-prompt regression | gate 命令直接 exit 0 才通过 |
| 数据损坏误报 | native hash/checkpoint verifier | candidate 与数据库副本完整性通过 |

每个代码阶段至少执行受影响 focused tests、`npm run check`、`npm test`、`npm run build` 和 `git diff --check`。仅文档阶段至少执行链接检查与 `git diff --check`。模型 catalog 未变更时不运行 `npm run generate-models`。

## 7. 建议提交边界

| 顺序 | 单一目的 | 主要范围 |
|---|---|---|
| 1 | 记录事故驱动的修复路线 | 本计划 + `development-doc/00-index.md` |
| 2 | 固定可靠性 RED fixtures | 新 focused tests/脱敏 manifest |
| 3 | 证明并注入 governed toolchain environment | Session composition、sandbox plan、process adapters、tests |
| 4 | 把 approval/credential 统一接入 Runtime wait timing | approval reverse、SessionRuntime、run timing tests |
| 5 | 为 production Agent run 增加预算 | Agent loop/controller/types/TUI projection、tests |
| 6 | 修正 run/session lifecycle projection | timing、owner/store migration/replay、tests |
| 7 | 闭合 process Trace | recorder/process composition/recovery、tests |
| 8 | 线性化 streaming durable events | SessionRuntime/client/TUI projector/benchmark、tests |
| 9 | 加入联合 candidate 并回写权威文档 | scripts、candidate tests、Runtime/Security/Trace/TUI docs |

每个阶段内部先运行 RED，再做最小 GREEN；除非用户明确要求独立 RED commit，否则只在阶段门禁恢复为绿后提交。暂存必须逐路径进行，不带入当前工作树中其他任务的代码或文档。

## 8. 停止规则

出现下列任一情况，停止当前阶段并保留 fail-closed 行为，不进入下一阶段：

1. 工具链修复需要挂载真实 home、复制 auth/env 或绕过 ExecutionGateway。
2. final leaf 无法证明 executable、env 或 runtime mounts 与已审批 plan 一致。
3. approval pause/resume 可能跨 generation 错配，或 timeout/abort 后 wait 未在 `finally` 闭合。
4. 预算停止会遗漏未结算 tool result/attempt，或可能重复执行副作用。
5. Session status repair 需要改写/伪造历史事件，或不能从 Event + Receipt 重建。
6. process Trace 收口被用来覆盖 `lost/uncertain`，从而伪造外部副作用结果。
7. streaming 优化导致最终内容、事件顺序、cursor 或 reconnect projection 不一致。
8. focused tests 通过但标准 production composition、linked CLI 或真实 npm gate 仍失败。
9. 发现与本计划无关的用户改动冲突；必须保留并请求重新划定范围，不能 stash/reset/覆盖。

## 9. 完成定义

- [~] Governed Bash 的 sandbox-off、foreground/background、pipe/PTY 消费同一 attested Node/npm/Bun environment；restrictive sandbox runtime mounts 等待解封 ADR。
- [~] sandbox-off 不继承真实 home、credential、ambient token，缺失/旧版/identity drift fail closed；restrictive sandbox 与三平台 evidence 尚缺。
- [x] Approval/Credential 所有已接终态都有成对 durable pause/resume，active time 正确。
- [x] 每请求默认预算生效，重复失败无需用户手动 abort 即能停止并解释原因。
- [x] `agent_end.messageCountAtEnd` 与 controller/checkpoint/full replay 一致。
- [x] owner release/claim、catalog status 与 lifecycle event 同事务一致；既有 drift projection 有幂等 offline 修复。
- [x] 主 Trace 与所有已接 process Trace 都有可解释终态；recorder map terminal 后释放。
- [x] streaming durable payload 线性增长，最终正文、边界 flush、hash chain 与 replay focused 回归通过。
- [x] 当前 checkout 的 `npm run check`、完整 `npm test`、`npm run build` 与 `git diff --check` 全绿。
- [ ] restrictive sandbox 联合 candidate、linked CLI 与真实 TTY smoke 全绿。
- [x] Runtime 06、Security、Trace、TUI 权威文档已回写本批实现边界与本地 fresh evidence。
- [ ] R6.5/R8、三平台、独立审计与 human acceptance 按各自门禁闭合。
