# Bounded Subagents

Bounded Subagents 是 Session-owned 的可选 root delegation 能力：注册一个 root Agent，按策略启动进程内 child Agent，给 child 投影受治理的只读工具，持久化 graph/attempt/report，并在 owner takeover 时做确定性恢复。它不是通用 DAG scheduler。

源码入口：[`src/runtime/agents/`](../../src/runtime/agents)、[`src/runtime/session-runtime/domain.ts`](../../src/runtime/session-runtime/domain.ts)、[`src/runtime/session-server/protocol.ts`](../../src/runtime/session-server/protocol.ts)。

## Enablement 与 policy

能力默认关闭。effective enablement 同时要求 CLI runtime gate、用户 settings 显式启用、workspace 未禁用且所有 policy source 有效。workspace source 可以收窄限制，不能扩大用户上限。

解析结果生成 `MultiAgentPolicyReceipt`，记录 runtime gate、source digests、effective limits、diagnostics 和 resolver identity；receipt 必须先进入 Session event stream，再注册 root。相同 Session 中已存在不同 receipt 时 fail closed。

## Root ownership

每个 Session 只有一个派生 root Agent id。`AgentSupervisor` 只接受 `parentAgentId === rootAgentId` 的 spawn，因此 child 不能再次委托。root registration、spawn identity 和 graph revision 都是 durable facts。

同一 root 同时最多一个 active child；这里的 active 指任一非终态 child，包括 requested、prepared、running 和 recovery_required，而不只是正在执行模型 turn 的 child。任一 recovery_required node 还会打开 graph recovery barrier。terminal child 不从 graph 删除，`maxChildrenPerRoot` 与包含 root 的 `maxTotalAgents` 都按 Session 生命周期累计节点计数。child tool execution 固定 sequential。

## 请求与能力投影

Spawn request 只包含 role、objective、requested read capabilities、进一步收窄的 budget 和 report output limit。role、objective UTF-8 长度、capability 名称和所有数值都在启动前验证；未知字段或超 ceiling 请求被拒绝。

当前 child capabilities 只有 workspace read、search 和 list。它们分别映射到 read、grep/find/glob、ls；请求省略或传空 capability 列表时默认展开为这三个只读 capability。工具只从注册过的 Session production tool source 派生，每个候选工具必须：

1. 明确声明只读；
2. 拥有 invocation-scoped repository-read claim；
3. 在 subset 派生时用空参数预检当前 Session `ToolAuthorizationPolicy`，实际调用时再由 `beforeToolCall` 授权；
4. 继续使用同一个 governed `ExecutionEnv`。

因此 child 看不到 write/edit/bash/web/MCP/plugin mutation；隐藏工具同时从 schema 和 executable set 消失。

## Child lifecycle

```text
spawn request
  -> derive idempotent command/attempt/agent identity
  -> begin agent_spawn attempt
  -> commit agent.spawn_requested
  -> prepare child runtime
  -> commit agent.spawned + descriptor digest
  -> activate child Agent
  -> commit agent.activated + activation receipt digest
  -> run within model/tool/time budget
  -> commit terminal report + usage
  -> dispose child runtime
  -> settle agent_spawn attempt
```

prepare 与 activate 分开，使 activation 已发生但 durable event 未确认的情况可以标记 `activation_uncertain`。同一 resident operation 的重复调用复用同一个 Promise；已有 durable terminal 时返回 byte-identical report；只有 durable request 而没有 resident operation/terminal 时返回 `recovery_required`，不会重跑 child。相同 effect identity 携带不同 request digest 时是 idempotency conflict。

## Graph、report 与 API

Agent graph 由 Session events 投影 root/child node、state、request/descriptor/activation digests、usage 和 terminal report。`agent.inspect` 是 read query；`agent.spawn` 与 `agent.cancel` 是受 driver、expected revision 和 recovery barrier 保护的 mutation。模型侧 `spawn_agent` tool 复用同一 domain。

Child 只返回一种 bounded report。report 保存 UTF-8 byte count、digest、outcome、usage 与可选 terminal reason；超过上限时生成空 report，并以 `outcome=failed`、`reasonCode=report_limit_exceeded` 收束，不截成一个看似成功的结果。

## Takeover recovery

新 owner 从 graph 与未决 `agent_spawn` attempt 重建状态。previous owner 为 alive/unknown 时，prepared/running 记录 reconciliation，所有非终态 child 保持 recovery required；只有 previous owner 可验证为 dead 时，requested/prepared/running 才能收束为 owner-takeover stopped terminal，避免双重执行。

requested、prepared、activation uncertain、running、terminal-before-settle 等阶段分别由 graph evidence 和 attempt receipt reconcile。未决 attempt 若没有 durable request 则以 rejected 收束；已有 terminal evidence 时按 terminal settle；有 request 无 terminal 时保持 unresolved/recovery required。缺少 terminal graph evidence 的 committed attempt 也进入 recovery required，而不是重跑 child。

## 稳定边界

- 不支持 child 再委托、DAG、并行 active children、跨进程热替换或独立 worktree。
- child 没有 write、shell、network、MCP、Hook、Skill 或 Plugin 能力。
- child transcript 不作为可冷续聊的独立 Session；持久对象是 root-owned graph 与 terminal report。
- provider/model/authority/idempotency 字段由 Session composition 派生，不暴露给模型 schema。
