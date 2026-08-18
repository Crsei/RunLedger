# RunLedger Idle Recap 复刻计划

> 状态：`partial`（P0–P3 `implemented`；P4–P6 `partial`）。本文是 oh-my-pi idle recap 的行为复刻计划；RunLedger 已完成核心 owner/runtime 复刻，但真实模型、TTY 和人工验收仍未闭合。
>
> 计划编写基线：RunLedger `session-owner-runtime` / `b5100b29624bfb04cf0ea5bcb48d80a9b3e39387`，2026-08-16。2026-08-17 修复与 fresh validation 基于当前 HEAD `4eecd499e715f3d588388fdbde937ec4699d9ab0` 的未提交工作树；不得把这些工作树结果表述为已提交状态。
>
> 复刻原则：只复刻可观察行为和必要的运行时合同，不复制 oh-my-pi 的 JSONL/session 文件格式，也不把 recap 伪装成正常 Agent turn、消息或 durable session 数据。

## 0. 结论先行

oh-my-pi 的 recap 是一个“会话空闲后触发的 ephemeral side-channel completion”，不是第二个 Agent、不是普通 prompt、也不是 session title。它在当前 session 有模型且存在历史消息时，使用当前 model、system prompt、历史快照和工具 catalog 发起一次短请求；模型返回的工具调用会被丢弃，回复只作为一行临时 status 展示。

当前 oh-my-pi 能直接配置的 recap 专属参数只有：

| 参数 | 当前行为 | 配置位置 |
|---|---|---|
| `recap.enabled` | 默认 `true`；关闭后不 arm timer | `~/.omp/agent/config.yml`，兼容读取 `config.yaml`；`PI_CODING_AGENT_DIR` 可改变 agent 目录 |
| `recap.idleSeconds` | 默认 `240` 秒；实际使用时限制到 `1–3600` 秒 | 同上 |

oh-my-pi 没有 `recap.model`、`recap.provider`、`recap.thinkingLevel`、`recap.temperature`、`recap.maxTokens` 或 `recap.timeout` 配置项。recap 请求取当前 session 的 active model；thinking level、凭据解析和 provider request pipeline 沿用当前会话，但 side-channel 代码没有设置一套 recap 专属 sampling/timeout 覆盖值。通用 provider/watchdog 设置可能间接影响请求，但不能称为 recap 独立配置。

oh-my-pi 的实际配置入口：

```text
omp config set recap.idleSeconds 600
omp config set recap.enabled false
omp config get recap.idleSeconds
omp config path
```

TUI 入口是 `/settings` → `Interaction` → `Notifications` → `Idle Recap` / `Idle Recap Delay`。

RunLedger 当前实现的配置入口是 canonical user settings：默认 `~/.runledger/settings.json`，设置 `RUNLEDGER_DIR` 时为 `<RUNLEDGER_DIR>/settings.json`。当前可配置形状为：

```json
{
  "recap": {
    "enabled": true,
    "idleSeconds": 240
  }
}
```

`recap.idleSeconds` 在运行时截断并限制到 `1–3600` 秒；当前没有独立的 RunLedger `recap.model`、`recap.provider`、`recap.thinkingLevel`、`recap.temperature`、`recap.maxTokens` 或 `recap.timeout` 配置，也没有 recap 专用 CLI/TUI 写入命令。recap 复用 Session 当前选中的 provider/model/thinking level 和 Host model router；当前模型选择仍由 session 配置、`--provider`、`--model`、`--thinking` 入口决定。

RunLedger 已补齐 `ProjectSettings.recap`、`IdleRecapCoordinator`、Agent ephemeral turn seam、Session Owner/TCP transient `session.idle_recap` 事件和 TUI status slot；这些状态不进入 transcript、ledger、replay 或 durable session store。

2026-08-17 implementation review 后补齐了四个生产缺口：Editor Enter 清空后的最终 activity 保持 `editorEmpty=true`；标准 CLI Session Owner composition 注入 model compatibility route gate 和 canonical `model.routed` receipt；idle recap 固定使用 `maxTokens=128`、`timeoutMs=30000`、`maxRetries=0`，router 的 required output budget 同为 128；默认 request ID 以及 provider/route lineage 纳入 owner/activity generation，owner 重建不再从可碰撞的 `idle-recap-1` 开始。canonical model compatibility manifest 缺失或无效时，标准 CLI route gate fail closed，并先写 bounded deny receipt，不回退为未经治理的 provider dispatch。

## 1. 参考实现证据

以下引用均来自本机工作区 `/data2-HDD-SATA-20T/Digital_avatar/haoweiyao/oh-my-pi`，实现阶段应重新核对行号，不得只依据本计划的结论：

| 行为 | 参考源码 |
|---|---|
| idle timer 的最小/最大值、arm/cancel、idle gate、成功 status | `packages/coding-agent/src/modes/controllers/event-controller.ts:60-61,2039-2143` |
| recap 在每个正常 turn 结束后被安排 | `packages/coding-agent/src/modes/controllers/event-controller.ts:1762-1771` |
| dispose、auto-compaction、活动事件取消 recap | `packages/coding-agent/src/modes/controllers/event-controller.ts:286-305,1813-1852` 以及同文件中 `#cancelIdleRecap()` 的调用点 |
| recap prompt 约束：少于 40 words、1–2 句、纯文本、目标/当前任务/下一步 | `packages/coding-agent/src/prompts/system/recap-user.md:1-9` |
| ephemeral request：当前 model、snapshot、system prompt、tool catalog、无工具提醒、AbortSignal、独立 side request lineage | `packages/coding-agent/src/session/agent-session.ts:7341-7440,7442-7491` |
| side request context 复用 system prompt 和规范化 tool catalog，但不触碰 append-only log | `packages/agent/src/agent.ts:752-781` |
| side reply 去重与约 4 KiB bound | `packages/coding-agent/src/session/messages.ts:82-112` |
| status preview 上限 280 | `packages/coding-agent/src/tools/render-utils.ts:80-89` |
| recap schema、默认值、TUI 分组和可选值 | `packages/coding-agent/src/config/settings-schema.ts:1981-2008,5695-5698,5848-5853` |
| 配置目录和主配置文件名 | `packages/utils/src/dirs.ts:1-26,348-401,495-498`；主文件为 `config.yml`，`config.yaml` 是兼容 fallback |
| `omp config` 的 get/set/path 入口 | `packages/coding-agent/src/cli/config-cli.ts:340-430` |
| 通用 temperature 设定存在，但属于 Agent/全局 sampling，不是 `recap.*` | `packages/coding-agent/src/config/settings-schema.ts:1307-1324`、`packages/coding-agent/src/sdk.ts:3168-3224` |
| side stream wrapper 复用 provider routing、watchdog、并发和 loop guard 等通用设置 | `packages/coding-agent/src/session/settings-stream-fn.ts:24-79`、`packages/coding-agent/src/sdk.ts:3168-3178,3414-3420` |

### 1.1 oh-my-pi 的实际流程

```text
正常 Agent turn 结束
        │
        ▼
取消旧 timer/旧 side request
        │
        ├─ compacting / editor 非空 / recap disabled ──► 不 arm
        │
        ▼
setTimeout(clamp(idleSeconds, 1, 3600))
        │
        ▼
再次检查：not streaming ∧ not compacting ∧ editor empty
        │
        ├─ 无 active model 或 history 为空 ──► 静默结束
        │
        ▼
runEphemeralTurn(current model, system prompt, history, tool catalog)
        │       └─ tool call 不执行；history/ledger/session 不变
        │
        ▼
Abort/generation/idle gate 再检查
        │
        ├─ 任一不满足 ──► 丢弃回复
        └─ 满足 ──► 去重、截断，展示单行 `※ recap: ...` status
```

一个 recap request 只对应一个 idle epoch；它不会因为 status 仍可见而持续定时重复生成。新 turn、输入草稿、compaction、session 切换或 dispose 会使旧 request 失效。

## 2. RunLedger 基线和 dirty boundary

### 2.1 计划编写基线与当前修复 HEAD

本计划最初审计的 HEAD 为 `b5100b29624bfb04cf0ea5bcb48d80a9b3e39387`，分支为 `session-owner-runtime`。2026-08-17 修复时当前 HEAD 已为 `4eecd499e715f3d588388fdbde937ec4699d9ab0`；下表是计划编写时的历史缺口，不代表修复后的当前实现：

| 接缝 | 已有能力 | recap 缺口 |
|---|---|---|
| active selection | `InteractiveSessionController.currentSelection` 暴露 provider/model/thinking level | 没有 side request 的快照/返回合同 |
| 正常模型调用 | `createSessionModelStreamFn()` → `ModelRequestRouter` → `Models.streamSimple()` | 不能直接复用 `Agent.prompt()`，否则会追加消息、ledger event 和正常 turn |
| Agent | `src/runtime/agent.ts` 只有普通 `prompt/steer/followUp/interrupt` 路径 | 没有 `runEphemeralTurn` |
| Session Owner | `SessionRuntime` 持有一个 controller、一个 Agent、一个 owner fence/generation，并通过 localhost TCP facade 服务 TUI | 没有 recap lifecycle、activity generation 或 ephemeral status channel |
| TUI editor | `InteractiveMode` 的 `CustomEditor` 已有 `onChange`、`onSubmit`，且当前 `onChange` 主要同步 slash popup | 没有向 owner 发布 editor draft/idle activity |
| TUI status | `StatusComponent`、footer、timeline projector 可展示正常运行状态/notice | 没有不进入 transcript/timeline 的 recap status slot |
| compaction | 当前 `src/runtime/tool-context.ts` 明确没有暴露 compaction 能力 | 没有与 oh-my-pi 相同的 `isCompacting` authority；不能假装已有 compaction parity |
| settings | `ProjectSettings` 由 `RunledgerLayout` 注入，默认用户级 `layout.settings`；CLI 参数覆盖 provider/model/thinking | 没有 `ProjectSettings.recap`，也没有 recap 专用 CLI/TUI 配置面 |
| durable session | `SessionStore`/event hash/owner fence/driver revision/recovery barrier 已存在 | recap 不应新增 durable session/message/title/schema 字段 |

当前生产组合必须继续保持：

```text
bin/runledger.js
  -> src/cli/main.ts
  -> createEmbeddedSessionRuntime()
  -> SessionOwner / SessionRuntime
  -> InteractiveSessionController
  -> one Agent / one runAgentLoop
  -> existing model/router/credential pipeline
```

### 2.2 必须保留的未提交改动

本次只新增文档；以下是开始本计划时已经存在的 dirty worktree，不能 reset、stash、覆盖或宽泛 staging：

- `development-doc/00-index.md` 已有 provider checklist 和 Session Naming / Auto Title 导航改动；本次只在同一文件追加本计划行和目录树行。
- `development-doc/plan/06-session-naming-and-auto-title-plan.md`、`development-doc/providers/02-oh-my-pi-provider-port-execution-checklist.md` 是未跟踪文档。
- 多处 `src/`/`tests/` 有未提交实现和测试，包括 Session Store schema/migration、workspace display、footer 等。
- 另有未跟踪的 Session title 相关代码与测试：`src/runtime/session-owner/title.ts`、`src/runtime/session-runtime/title-generator.ts` 及对应 tests。

特别注意：dirty worktree 已经出现一组 Session title/schema v2 的进行中改动；它们属于 Plan 06 的边界，不是本计划的 recap 实现证据。本计划在实现时应复用 title 计划确定的 ephemeral model seam，但不能把 recap reply 写进 title，也不能把 recap 的 timer/状态和 title state 合并。

## 3. 复刻决策

### 3.1 Durable / ephemeral 边界

recap 只能是 Session-scoped ephemeral request：

- 不追加 `user` 或 `assistant` message；
- 不产生正常 `turn_start` / `turn_end`、`ledger.message`、普通 tool event 或 session head 变化；
- 不改变 replay、checkpoint、session title、session ID、driver revision 或 durable settings；
- 不把原始 recap prompt、完整模型回复、credential、base URL 或 provider payload 写入 durable session；
- 如现有 Trace 必须记录 provider 调用，只允许使用已有脱敏 trace/artifact policy，并显式标记 `requestKind: "idle-recap"`，不能把它投影成普通 Agent turn；
- status 只存在于当前 TUI 的 transient projection，session 切换或新 activity 后清除。

### 3.2 模型和请求参数决策

v1 默认不增加独立 recap model。请求开始时捕获：

```text
recapModel = currentSelection.model
recapProvider = currentSelection.provider
recapThinking = currentSelection.thinkingLevel
```

具体规则：

1. 无 active model 时不请求、不报错给用户；
2. `provider/model`、credential resolver、模型 catalog、Host model router 仍走当前生产管线；
3. thinking level 使用 request 开始时的 selection 快照，不能在完成时读取新 selection 后“拼接”成另一个请求；
4. side request 必须有独立 request/lineage ID，避免复用 provider append-only conversation state；prompt cache/context digest 可以按 provider 能力复用；
5. tool catalog 可以进入 provider context 以保持 system prompt/prefix 兼容，但 side channel 必须带 no-tools reminder，所有 tool call 都丢弃且绝不进入 `ExecutionGateway`；
6. v1 不提供 `recap.model`、`recap.temperature`、`recap.maxTokens`、`recap.timeout`。如果后续需要独立模型或采样参数，必须另立 settings/schema、auth/cost/trace/approval 边界，不得通过未命名字段或 tiny/smol fallback 偷加；
7. request 的内部安全上限是 `maxTokens=128`、`timeoutMs=30000`、`maxRetries=0`，在 Agent/provider options 和 route required output budget 中保持一致；它们是实现常量并由 contract tests 固定，不是用户可配置的 oh-my-pi recap 参数。

### 3.3 配置 authority 和优先级

RunLedger v1 将 recap 配置纳入现有 `ProjectSettings` 类型，但 canonical 持久化 authority 是用户级 `RunledgerLayout.settings`：

```text
默认：<userHome>/.runledger/settings.json
显式 RUNLEDGER_DIR：<RUNLEDGER_DIR>/settings.json
```

建议的 JSON 形状：

```json
{
  "recap": {
    "enabled": true,
    "idleSeconds": 240
  }
}
```

有效值解析：

| 层级 | 优先级 | 说明 |
|---|---:|---|
| owner/runtime hard gate | 最高 | recovery、fenced、无 driver、无 model、busy/unknown、editor 非空时一律不请求 |
| 未来的显式 CLI/session override | 高 | 当前尚不存在；若添加必须有 typed contract 和 tests |
| canonical user `ProjectSettings.recap` | 中 | `enabled` 默认 `true`，`idleSeconds` 默认 `240` |
| built-in default | 低 | 不依赖 TUI 私有默认值 |

v1 不把 workspace settings 私下当作 recap authority。若要支持 workspace 级配置，必须在 `loadLayeredProjectSettings()`、权限/优先级和“workspace 只能收窄”规则中单独冻结；不能仅仅让 sanitizer 接受字段而没有有效 precedence。这样可以避免同一 Session 因 cwd/worktree 变化而无证据地切换 recap 行为。

实现时应扩展：

- `src/storage/settings-manager.ts` 的 `ProjectSettings`、sanitize/validation 和 effective resolver；
- `src/cli/main.ts` 的 canonical settings 注入链；
- 如新增 CLI 面：使用独立 `config get/set/path` 命令，不让 TUI 直接写 JSON；
- settings tests：缺失、错误类型、非有限数、边界值、权限模式和 `RUNLEDGER_DIR` 隔离。

## 4. Frozen contract

### 4.1 Settings contract

实现时建议采用“存储可选、运行时完整”的形态：

```ts
export interface RecapSettings {
  readonly enabled?: boolean;
  readonly idleSeconds?: number;
}

export interface EffectiveRecapSettings {
  readonly enabled: boolean;
  readonly idleSeconds: number;
}

export const DEFAULT_RECAP_SETTINGS = Object.freeze({
  enabled: true,
  idleSeconds: 240,
});
```

约束：

- `enabled` 只能是 boolean；
- `idleSeconds` 必须是有限 number，effective 值取整数秒并限制到 `1–3600`，与 oh-my-pi 的 timer 行为一致；
- 缺失字段走默认值；未知 `recap` 子字段被丢弃或 typed reject，不能进入 model request；
- settings 读写必须经过 `RunledgerLayout`，不读取 cwd 下的旧 `.runledger/settings.json` 或 TUI 私有文件；
- v1 不改变 Session Store schema version，不为 recap 新增 SQLite/JSONL durable row。

### 4.2 Idle state contract

Idle coordinator 的状态必须是纯运行时状态，不写入 session store：

```ts
type IdleRecapState =
  | "disabled"
  | "disarmed"
  | "armed"
  | "running"
  | "settled"
  | "cancelled";

interface IdleRecapActivity {
  readonly sessionId: string;
  readonly ownerGeneration: number;
  readonly activityGeneration: number;
  readonly driverRevision: number;
  readonly editorEmpty: boolean;
  readonly streaming: boolean;
  readonly maintenance: "idle" | "busy" | "unknown";
}
```

idle gate 必须全部满足：

```text
settings.enabled
∧ current attachment is a valid driver
∧ owner generation/fence is current
∧ no active Agent stream
∧ maintenance == idle
∧ editorEmpty == true
∧ active model exists
∧ session history has at least one durable/in-memory message
∧ current idle epoch has not already settled/been cancelled
```

RunLedger 当前没有 compaction authority，因此 v1 不能直接读取一个不存在的 `isCompacting`。在 coordinator 中使用 `maintenance: "unknown"` 时必须 fail closed；只有在现有 run state 明确为 idle，或未来 compaction contract 明确报告 idle，才允许 arm/fire。未来加入 compaction 时，`compaction.start`、`compaction.end`、handoff/reset 都必须调用同一个 cancel path。

### 4.3 Ephemeral request contract

建议在 `src/runtime/session-runtime/` 与 `src/runtime/agent.ts` 之间建立 typed port，而不是让 TUI 直接持有第二个 Agent：

```ts
interface EphemeralTurnRequest {
  readonly requestId: string;
  readonly kind: "idle-recap";
  readonly sessionId: string;
  readonly ownerGeneration: number;
  readonly activityGeneration: number;
  readonly modelRef: { readonly providerId: string; readonly modelId: string };
  readonly thinkingLevel: ModelThinkingLevel;
  readonly promptText: string;
  readonly expectedSelectionDigest: string;
  readonly signal: AbortSignal;
}

interface EphemeralTurnResult {
  readonly requestId: string;
  readonly replyText: string;
  readonly modelRef: { readonly providerId: string; readonly modelId: string };
  readonly usage?: Readonly<Record<string, number>>;
}
```

`Agent.runEphemeralTurn()` 或等价的 SessionRuntime-owned service 必须满足：

1. 从当前 Agent state 复制 system prompt、history 和 tool descriptors；
2. 追加 virtual developer no-tools reminder 与 recap prompt，仅用于本次 provider context；
3. 通过现有 `createSessionModelStreamFn()`/`ModelRequestRouter`/credential resolver 发起请求；
4. 使用 unique side request lineage，同时向 router 提供 `requestKind: "idle-recap"`、session ID、model ref、context digest 和 required output budget；
5. 不调用 `Agent.prompt()`，不执行 tool loop，不调用 `ExecutionGateway`，不 append ledger；
6. 接收 provider text/assistant result 后过滤 tool call；provider 错误、abort、malformed result 都返回 typed failure 或 `null`，不抛到正常 prompt 生命周期；
7. side request 在正常 Agent turn 运行时可以并发存在，但两者不能共享会被 provider 当作 append-only conversation 的 mutable request/session ID；
8. request 完成后由 coordinator 再做 owner/activity/selection/idle gate，`EphemeralTurnResult` 不是自动可见结果。

### 4.4 Prompt and output contract

RunLedger v1 使用独立的 recap prompt resource，行为对齐 oh-my-pi：

```text
User stepped away; returning. Recap: fewer than 40 words, 1–2 plain sentences, no markdown.
Lead with the overall goal, current task, and one next action. Skip root-cause narrative,
implementation details, and secondary to-dos.
```

若 RunLedger 已有可靠的 goal/task projection，可将其作为 bounded hint；没有时不要伪造“当前任务”字段，也不要从 TUI 私有状态读取未验证的数据。recap 只以当前 conversation/history 为最低输入。

纯函数输出处理顺序：

1. 收集 text blocks，丢弃 thinking/tool-call 内容；
2. 去 ANSI、控制字符、换行和明显 markdown fence；
3. 折叠重复连续行，复刻 ephemeral reply 的约 4 KiB byte cap；
4. 取第一行并按 terminal display cells 限制到约 280 cells；
5. 空结果、provider error、abort、超预算结果不展示；
6. 不把原始回复作为 notice/timeline message 写回 durable history。

### 4.5 Owner/driver/protocol contract

Idle recap 不是一个让 observer 能发起的任意 model command：

- 只有当前 driver attachment 可以发布 editor activity 和 idle intent；
- SessionRuntime 在 owner fence、generation、driver revision 和 runtime state 上再次校验，不能相信 TUI 传来的 `streaming=false`；
- `sessionId`、`expectedGeneration`、`driverRevision`、`requestId`、`activityGeneration` 必须包含在 request/response correlation 中；
- owner takeover、driver release、connection close、session switch 和 process shutdown 都必须取消当前 request；
- 若未来通过 TCP 传输 `recap.start`/`recap.cancel`，必须同步更新 `runtime-server.ts`、`protocol.ts`、client capability check、operation manifest 和 unsupported tests；
- ephemeral status 可以使用专门的 non-durable subscription payload，不能复用会进入 replay/timeline 的 `ledger.*` 或普通 message event；
- recovery barrier、fenced、generation mismatch、driver missing、operation unsupported 都是明确的“不展示/丢弃”，不能让 TUI 继续显示旧 recap。

## 5. 生命周期和竞态规则

### 5.1 Arm/fire/cancel

| 事件 | 动作 |
|---|---|
| 正常 Agent turn 结束 | 若当前 driver/editor/maintenance gate 满足，取消旧 timer，按 effective `idleSeconds` arm；否则 disarm |
| editor `onChange` 且内容非空 | `activityGeneration++`，取消 timer 和 in-flight request，清除 recap status |
| editor `onChange` 回到空文本 | 只允许在当前 turn 已结束、maintenance idle 且 driver 有效时重新 arm；不能无条件立即请求 |
| 新 prompt/steer/follow-up accepted | 在发送给 Agent 前先使旧 idle epoch 失效；正常 prompt 不被 recap 阻塞 |
| Agent stream start | cancel；recap 不得与新 turn 的 idle epoch 共享 token |
| compaction/maintenance start | cancel；未知 maintenance state 按 busy 处理 |
| session switch/resume/fork | 取消旧 session coordinator，释放 status；新 session 从自己的 owner generation/history 重新 arm |
| driver release/owner takeover | cancel；新 driver 必须重新发布 editor activity/idle state |
| dispose/process shutdown | abort signal、clear timer、清空 transient status |
| provider/model/thinking selection 改变 | cancel；新 selection 需要新的 idle epoch，旧 reply 即使返回也丢弃 |
| provider error/timeout | 静默失败并记录 bounded diagnostic；不自动重试，不影响正常 prompt |
| recap 成功 | 只展示一次，标记 idle epoch settled；没有新 activity 不重复生成 |

### 5.2 Completion acceptance predicate

收到 provider result 后，只有以下条件全部满足才可投影 status：

```text
requestId == coordinator.inFlight.requestId
∧ ownerGeneration == current owner generation
∧ activityGeneration == current activity generation
∧ driverRevision == current driver revision
∧ sessionId == current session id
∧ currentSelectionDigest == expectedSelectionDigest
∧ editorEmpty
∧ maintenance == idle
∧ streaming == false
∧ signal.aborted == false
∧ normalized reply is non-empty
```

任一条件失败都只做 discard，并且不得以失败结果覆盖新 status。`AbortController.abort()` 只能减少请求；不能取代完成时的 generation/CAS 检查，因为 provider 可能已经在 abort 前返回或网络层可能忽略 abort。

## 6. 文件/模块实施地图

下表是候选责任边界；实现阶段可在不改变 authority 的前提下调整文件名。

| 模块 | 候选文件 | 责任 |
|---|---|---|
| settings | `src/storage/settings-manager.ts`、`src/cli/main.ts` | `ProjectSettings.recap`、默认值、边界校验、canonical user settings 注入 |
| pure recap text | `src/runtime/session-runtime/idle-recap.ts` 或 sibling | prompt、normalization、dedupe、byte/cell budget、纯函数测试 |
| ephemeral Agent seam | `src/runtime/agent.ts`、`src/runtime/types.ts`、必要时 `src/runtime/agent-loop.ts` | snapshot、side request、no ledger/no tool execution、AbortSignal |
| model/router | `src/runtime/agents/child-model-runtime.ts`、`src/runtime/interactive-session-controller.ts`、Host model router | active selection、credential、unique side lineage、request kind/route evidence |
| owner lifecycle | `src/runtime/session-runtime/session-runtime.ts`、`src/runtime/session-runtime/domain.ts` 或专用 coordinator | timer、activity generation、owner/driver gate、completion predicate、cancel |
| session protocol | `src/runtime/session-server/runtime-server.ts`、`src/runtime/session-server/protocol.ts`、client adapter | 仅在需要跨 TCP 的 activity/status path 上注册 typed operation；保持 manifest fail-closed |
| TUI input | `src/tui/interactive-mode.ts`、`src/tui/components/custom-editor.ts` | 发布 editor activity，处理 session boundary，不能发起直接 model call |
| TUI status | `src/tui/components/status.ts`、`src/tui/presentation.ts` 或现有 status projection seam | transient 单行 recap status；不进入 transcript/timeline/replay |
| tests | `tests/runtime/session-runtime/`、`tests/runtime/`、`tests/storage/`、`tests/cli/`、`tests/tui/`、Bun OpenTUI tests | 分层 RED/GREEN 和真实 composition 验收 |

不应修改的 authority：

- 不在 TUI 中 new 一个第二 `Agent` 或直接调用 `Models.streamSimple()`；
- 不把 recap 状态塞进 `SessionStore.sessions`、`session_events` 的普通 ledger projection 或 Plan 06 title 字段；
- 不把 recap 回复伪装成 `AgentEvent.message_end`；
- 不用旧 JSONL/session 文件格式作为新功能的持久化后门。

## 7. 分阶段执行（RED-first）

### P0 · Evidence freeze and contract tests

目标：先冻结参考行为、当前 HEAD/dirty boundary 和 proposed contract。

工作：

- 为 oh-my-pi source refs 建立本地 evidence note 或测试注释；实现前重新确认 recap 调度、side request 和 config path；
- 冻结 `RecapSettings`、effective resolver、idle state、ephemeral request/result 和 transient status 类型；
- 明确当前 RunLedger compaction 缺口：`unknown` 不得 fire；
- 写出失败矩阵：无 model、无 history、非空 editor、streaming、owner takeover、abort、stale selection、provider error。

验证：

- pure contract tests 先 RED：当前缺少 settings field、ephemeral API、status projection 的证据必须保留；
- `git diff --check`；只审阅本任务文档/contract，不把现有 dirty title 改动当成 recap GREEN。

### P1 · Canonical settings and idle coordinator

目标：能够在 RunLedger canonical user settings 中控制 enabled/delay，并由唯一 owner coordinator 管理 idle epoch。

工作：

- 扩展 `ProjectSettings` 和 sanitizer/effective resolver；默认 `true/240`；effective delay 限制 `1–3600`；
- 在 `SessionRuntime`/owner scope 建立 monotonic timer、activity generation、driver/generation fence；
- TUI editor `onChange`、turn start/end、session switch、dispose 接入统一 activity/cancel port；
- 先使用 `maintenance: unknown` fail closed，不实现或假造 compaction；
- 不触发模型请求，只验证 arm/disarm/cancel。

RED/GREEN：

- `settings-manager`：缺失/合法/非法/边界/`RUNLEDGER_DIR` 隔离；
- fake clock：默认 240 秒、`1`/`3600` 边界、超界 clamp、disabled 不 arm；
- editor draft、turn start、driver release、generation change、dispose 能清 timer 和 generation；
- 同一 idle epoch 不重复 arm/fire。

### P2 · Ephemeral model request seam

目标：提供不改变 Agent state/ledger 的最小 side-channel completion。

工作：

- 为 Agent 增加 `runEphemeralTurn` 或等价 port；
- 复用当前 system prompt/history/tool descriptors，追加 no-tools reminder + recap prompt；
- 复用 `createSessionModelStreamFn` 和 Host router，但为 request 创建独立 lineage/request kind；
- 捕获当前 model/thinking/selection digest；无 model/history 返回 typed suppression；
- provider context 可带 tools，但 tool call 只过滤、不执行、不写 event；
- 做 bounded dedupe/normalization，不把 side response 追加到 `state.messages` 或 `LedgerSink`。

RED/GREEN：

- provider fixture 断言 model/provider/thinking、credential resolver、context/system/tools、unique request lineage；
- 断言 `Agent.state.messages`、ledger entry、run timing、tool invocation 次数均不变；
- fixture 返回 tool call 时断言 `ExecutionGateway`/tool execute 未被调用；
- fixture 返回重复行、4 KiB+、空文本、malformed content、error、abort 时断言 typed result；
- 并发正常 Agent turn 时 side request 不污染主 turn 的 state。

### P3 · Owner production composition

目标：在真实 `SessionOwner -> SessionRuntime -> InteractiveSessionController` 中连接 P1/P2，TUI 仍只有 client/facade。

工作：

- owner coordinator 在 request 前后二次校验 runtime state、fence、driver、selection 和 history；
- `SessionRuntime.handleCommand` 或内部 typed port 处理 recap start/cancel/activity；若跨 TCP，更新 protocol manifest/capability/schema/client；
- side request 不走 normal `prompt` command，不进入 `turn.started`/Agent event；
- owner shutdown/takeover/recovery barrier 对 recap 一律 abort/discard；
- 对 no driver、observer、reconnect、stale generation 给出 fail-closed 结果。

RED/GREEN：

- 真实 Session Owner worker fixture：driver 才能 arm，observer 不能发起；
- owner generation 变化后旧 request 完成不产生 status；
- connection close/driver release/`SessionRuntime.close()` 后 provider fixture 收到 abort 或 result 被丢弃；
- protocol operation manifest 新旧 client/unsupported path 明确通过/拒绝。

### P4 · TUI transient status projection

目标：复刻 oh-my-pi 的单行 `※ recap: ...` 体验，但不写 timeline。

工作：

- 在 `StatusComponent` 或现有 status projection 中增加 `idleRecap?: string`；
- owner 通过 ephemeral status payload/结果通知 driver，TUI 按 generation/requestId 投影；
- 新输入、turn start、session switch、dispose 清除 status；
- 应用 dim/italic 语义、单行显示和约 280 display-cell 限制；窄终端/CJK/emoji 使用现有 cell-width helper；
- provider failure/abort 不显示错误 toast，保持与 oh-my-pi 一样静默；诊断只留 bounded debug/trace。

RED/GREEN：

- TUI status pure tests：成功显示、空结果不显示、activity 清除、stale result 不覆盖；
- Bun `createTestRenderer()`：宽度 80/143、CJK/emoji/ANSI、status 不新增 transcript row；
- 真实 TTY/tmux：正常 prompt 完成后等待短配置延迟，看到单行 recap；输入一个字符后 recap 被取消且不会覆盖新工作。

### P5 · Race, recovery and provider governance hardening

目标：证明 recap 是可取消、不可越权、不可污染 durable runtime 的 side channel。

工作：

- 完成 requestId/activityGeneration/ownerGeneration/selectionDigest completion predicate；
- 统一 abort sources：editor activity、new turn、compaction/maintenance、session transition、model switch、driver loss、dispose；
- provider request 经过既有 auth/route/concurrency/trace policy；不新增 raw credential/path payload；
- 若现有 trace 记录 side request，加入 `idle-recap` kind、redaction 和 bounded body policy；
- 不做失败自动重试，不让 recap 失败阻塞正常 prompt。

RED/GREEN：

- 延迟 provider fixture 在每个 abort/race 点分别验证旧结果丢弃；
- model switch race、session switch race、owner takeover race、driver reconnect race；
- durable DB/event/ledger digest 前后相等；
- recovery barrier active 时没有 provider dispatch；
- router deny、auth missing、provider timeout 都只产生 typed diagnostic，不产生 UI 假成功。

### P6 · Full gates, real model and documentation closure

目标：把自动证据、真实 CLI/TUI 证据和人工验收分开记录。

自动门禁：

- recap focused Vitest/Bun tests；
- `npm run check`；
- `npm test`；
- `npm run build`；
- `git diff --check`；
- 如协议/Session Owner 变更，运行对应 `verify:session-owner-*` 和真实 worker/transport tests。

真实 composition：

- 使用隔离 `RUNLEDGER_DIR`，不触碰真实 `~/.runledger`、auth 或 session；
- `./bin/runledger.js --version`、`--help` 和标准 PATH `runledger` provenance 先核对到当前 checkout；
- 用真实 TTY/tmux 验证 80/143 列、输入取消、session switch、退出清理；
- 使用已配置的真实 model 做至少一次 recap，记录 provider/model/think level/request kind 的非秘密证据；不打印 token、API key、完整 prompt 或 credential 文件；
- 人工确认 recap 是 status 而非 transcript，模型无工具 side effect，provider usage/成本策略符合预期。

文档回写：

- 在本文状态表逐阶段记录 `planned/partial/implemented/blocked` 和 fresh evidence；
- 必要时更新 `development-doc/00-index.md`，但不把 Plan 06 title 的实现状态或历史 commit 伪装成 recap 证据；
- 如果独立模型/temperature/maxTokens/timeout 被提出，另开 ADR/plan，不在 P6 默默扩大范围。

## 8. 测试矩阵

| 场景 | 必须证明 | 层级 |
|---|---|---|
| 默认配置 | enabled=true、delay=240、effective clamp 1–3600 | pure/settings |
| disabled | 不 arm、不 dispatch、不显示 | settings/coordinator |
| idle gate | streaming、maintenance、editor、model、history 各一项缺失都不请求 | coordinator |
| timer reset | 每次 turn 结束先 cancel 旧 timer；单 epoch 不重复 | fake clock |
| active model | recap 使用 request 开始时的 provider/model/thinking；无 model 静默 | controller/provider fixture |
| context | system prompt/history/tool catalog 快照正确；goal/task 只取 bounded authority | Agent side request |
| no durable mutation | messages/ledger/session DB/head/replay digest 不变 | Agent + SQLite/session integration |
| no tool execution | tool calls 被丢弃，ExecutionGateway/stdlib tool 次数为 0 | provider fixture + integration |
| output bound | 重复行、4 KiB byte cap、280 display cells、ANSI/CJK/emoji | pure + Bun |
| abort | editor activity/new turn/compaction/switch/dispose 都取消或丢弃 | delayed provider fixture |
| stale result | requestId/activityGeneration/ownerGeneration/selection digest 任一过期都不显示 | coordinator |
| driver | observer/无 driver/release/takeover 不能产生 recap | Session Owner worker |
| protocol | manifest/capability/unsupported/old-client behavior fail closed | protocol/transport |
| TUI | status 单行、非 timeline、activity 清除、窄终端稳定 | Bun OpenTUI + real TTY |
| provider failure | auth/router/timeout/malformed response 不阻塞正常 prompt、不显示假成功 | provider fixture + real pipeline |
| real model | 当前 active model 能真实完成一次 recap，退出后无残留 timer/process | isolated CLI/TTY |

## 9. 非目标和停止条件

### Explicit non-goals

- 不实现或复制 oh-my-pi 的 session JSONL/title slot；
- 不把 recap 当成 Plan 06 的 auto-title、summary、memory 或 durable session metadata；
- 不新增 tiny/smol/commit role，也不为 recap 隐式选择便宜模型；
- 不增加 `recap.model`、`recap.temperature`、`recap.maxTokens`、`recap.timeout`，除非另有批准的配置/认证/成本/trace plan；
- 不执行 side-channel tool call、MCP、bash、filesystem 或任意 ExecutionGateway side effect；
- 不在本计划内补齐 RunLedger 的 compaction 机制；只为未来 compaction 保留明确的 maintenance gate；
- 不让 TUI 直接调用 provider 或创建第二个 Agent/SessionRuntime；
- 不做 recap 失败自动重试或持续周期性 recap；
- 不把 status 复制成 transcript/timeline message；
- 不将未跑的真实 model/TTY/human evidence 标记为完成。

### Stop/block conditions

遇到以下任一情况必须暂停实现并回写阻断证据，不得用 mock-only 结果宣称完成：

1. 不能在现有 owner/runtime model pipeline 中生成 unique side request lineage；
2. 不能证明 credential/auth/router 仍由 Host authority 管理；
3. provider fixture 无法区分正常 prompt 与 recap side request；
4. side request 会修改 Agent messages、ledger、session head 或触发 tool execution；
5. editor activity 无法可靠取消旧 request，或 owner generation 无法拒绝 stale completion；
6. protocol/client capability 不一致导致旧 client 把 recap command 当作普通 mutation；
7. 当前 compaction/maintenance state 仍为 unknown 却尝试 fire；
8. 真实 TTY 中 status 覆盖新工作、写入 transcript 或退出后留下 owner/timer/process；
9. full gates 受任务外 dirty 改动阻塞时，必须分开记录 blocker，不能把 focused recap tests 伪装成全仓通过。

## 10. 与现有 Plan 06 的关系

Plan 06（Session Naming / Auto Title）和本计划都可能使用 side-channel model request，但语义必须分离：

| 维度 | Auto Title | Idle Recap |
|---|---|---|
| 输出 | durable `title/titleSource/titleUpdatedAtMs` | transient status text |
| 触发 | 首个合格用户输入/显式 rename 规则 | turn 结束后 idle timer |
| 存储 | Session Store + title event | 不存储、不改 head |
| CAS | unnamed/user-title fence | request/activity/owner/selection fence |
| UI | catalog/picker/header/strip | 单行 status/footer |
| 失败 | 保持未命名，后续可重试 | 静默丢弃，不阻塞 prompt |
| 模型 | Plan 06 决定默认复用 active coding model | 本计划同样复用 active model；不共享输出或生命周期 |

两者可以共享一个经过 Host 治理的 `EphemeralModelRequestPort`，但必须使用不同的 `requestKind`、prompt policy、output normalizer、cancellation owner 和 durable write adapter。绝不能因为 Plan 06 已有 title generator，就把 recap 文本直接交给 title setter；也不能因为 dirty worktree 已经包含 title schema v2，就为 recap 增加第二套 recap/session schema。

## 11. 状态表

| 阶段 | 状态 | Fresh evidence |
|---|---|---|
| P0 evidence/contract freeze | `implemented` | 2026-08-16 复核 oh-my-pi `event-controller.ts`、`agent-session.ts`、`settings-schema.ts`、`recap-user.md`；RunLedger 合同见本文 §4 |
| P1 settings/idle coordinator | `implemented` | 2026-08-17：`tests/storage/settings-manager.test.ts`、`tests/runtime/session-runtime/idle-recap.test.ts` 通过；新增跨 owner generation 默认 request lineage 回归 |
| P2 ephemeral model seam | `implemented` | 2026-08-17：`tests/agent-loop.test.ts` 10 项通过，固定 128-token/30s/零重试 provider options 和 provider session lineage；`tests/runtime/model-routing/host-dispatch.test.ts` 3 项通过，固定 128 required output tokens 与 owner/activity route lineage；`tests/cli/multi-client/runtime-host-model-router.test.ts` 2 项通过 |
| P3 Session Owner production composition | `implemented` | 2026-08-17：新增 `tests/cli/session-model-router.test.ts` 2 项，证明标准 CLI 注入 fail-closed route gate 并落 bounded `model.routed` receipt；`tests/runtime/session-runtime/idle-recap-integration.test.ts` 2 项继续通过，覆盖真实 SessionOwner → SessionRuntime → TCP、driver/observer、transient/replay、selection race |
| P4 TUI transient status | `partial` | 2026-08-17：`tests/tui/status.test.ts`、`tests/tui/session-workflows.test.ts` 通过；新增真实 Editor → InteractiveMode → SessionInteractiveController transport 的 Enter activity 顺序回归，最终 `editorEmpty=true`。2026-08-19：修正 `StatusComponent` 在 TUI 组件树中的位置，使 recap 进入 editor 后的 footer 分区而不进入 transcript body；新增 `tests/tui/session-workflows.test.ts` 回归与 `tests/tui/opentui-idle-recap-status.bun.test.ts` 的 80/143 列、CJK/emoji/ANSI frame 验证。Bun/OpenTUI 全套 104 tests / 654 assertions 通过；真实 TTY 与人工视觉验收仍未完成 |
| P5 race/recovery/provider hardening | `partial` | 2026-08-17：已覆盖 editor/driver/selection/dispose 取消、stale completion、Agent provider error/abort、route manifest 缺失 fail-closed 与 receipt；2026-08-19：新增 router deny/auth missing/provider timeout 的 bounded typed diagnostic，沿 Session Owner TCP transient path 只通知 driver、不投影 text，durable replay 前后 digest 不变；尚缺 recovery barrier 禁 dispatch、真实 auth/provider timeout 和真实模型 route evidence |
| P6 full/real/human acceptance | `partial` | 2026-08-17 fresh：focused 11 files / 91 tests，`npm run check`，Vitest 384 passed / 1 skipped（2329 passed / 3 skipped），Bun/OpenTUI 12 files / 98 tests / 622 assertions，`npm run build`，`git diff --check` 全部通过；全局 `runledger` 链接到当前 checkout，隔离 `RUNLEDGER_DIR` 的 `--version`/`--help` 与 tmux TTY 启动、Ctrl+D 清理通过。tmux 未捕获可用视觉帧，真实模型和人工视觉验收仍未完成 |

计划完成的最低定义是：P0–P5 有 focused RED→GREEN 和真实 Owner/provider fixture 证据，P6 的自动门禁、隔离 CLI/TTY、真实 model 与人工视觉验收分别记录；任何一类缺失都只能写 `partial`，不能写 `implemented/accepted`。
