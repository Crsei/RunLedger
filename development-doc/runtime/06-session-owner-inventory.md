# Session Owner Runtime:consumer/delete inventory(R0 冻结)

> 状态：**R0 冻结（2026-08-07）**；基线 commit `563b21c`
> 权威：本文是 [`06-session-owner-runtime-replacement-plan.md`](06-session-owner-runtime-replacement-plan.md) R0 的当前 code consumer/delete inventory，只读记录，不授权删除或迁移。
> 方法：用 `scripts/check-session-owner-boundaries.ts` 的 import 解析规则（import/export-from 语句、相对路径解析）全量扫描 `src/`，与文档交叉核对。

## 1. 总览

| 分类 | 数量 | 处置 |
|---|---|---|
| legacy Host 内部文件 | 26 | R9 从生产删除（§9.3） |
| legacy Host 外部消费者 | 19 | R6 迁移到 session scope；R0-frozen allowlist 冻结 |
| 复用（不删） | 12+ | §3 列出，改绑 session scope |
| pure algorithm 迁移 | 6 | §4 列出，去 Host identity 后迁入新目录 |

## 2. legacy Host 内部文件（26，R9 删除）

全部位于 `src/runtime/host/`、`src/storage/host/`、`src/cli/runtime-host*` 与 Host 运维入口。对应 §9.3 删除清单已逐项核实存在：

- `src/runtime/host/`：`lifecycle.ts`、`types.ts`、`client.ts`、`resident-sessions.ts`、`contracts.ts`、`driver.ts`、`remote-session.ts`、`composition.ts`、`peer-attestation.ts`、`router.ts`
- `src/storage/host/`：`startup-election.ts`、`linux-process-identity.ts`、`event-store.ts`、`runtime-event-store.ts`、`domain-revision-store.ts`、`shutdown-intent-store.ts`、`approval-store.ts`、`store-path-safety.ts`、`recovery-marker.ts`、`writer-lease.ts`、`endpoint-store.ts`、`command-store.ts`、`host-generation-store.ts`
- `src/cli/`：`host-command.ts`、`linux-peer-attestor.ts`、`reconnecting-host-bridge.ts`、`runtime-host.ts`、`runtime-host-binding.ts`、`runtime-host-client.ts`、`runtime-host-composition.ts`、`runtime-host-domains.ts`、`runtime-host-hooks.ts`、`runtime-host-mcp.ts`、`runtime-host-model-context.ts`、`runtime-host-model-router.ts`、`runtime-host-process.ts`、`runtime-host-production.ts`、`runtime-host-security.ts`、`runtime-host-service.ts`、`runtime-host-session.ts`、`runtime-host-transport.ts`、`runtime-host-skills.ts`、`runtime-host-summarizer.ts`、`runtime-host-model-manifest.ts`、`host-build-identity.ts`
- 附加删除项（§9.3 已列）：`scripts/build-linux-peer-credential-helper.ts`、`scripts/generate-host-build-manifest.ts`、`scripts/runtime-host-audit.ts`、`scripts/verify-host-build-replacement.ts`、`scripts/verify-runtime-host-audit.ts`、`scripts/verify-multi-client-host.ts`、`native/linux-peer-credential.c`；package scripts `verify:multi-client-host`、`verify:host-build-replacement`、`verify:runtime-host-audit`；locators `hostEndpointRelativeLocator`、`hostSocketRelativeLocator`、`hostStartupElectionRelativeLocator`、`hostStateRelativeLocator`；CLI `host list|status|stop|restart`

## 3. legacy Host 外部消费者（19，R0-frozen allowlist）

以下文件是 R0 冻结的既有消费者，`check:session-owner-boundaries` 只允许它们引用 legacy Host；R7 前不得新增条目。

| 文件 | 消费内容 | R6/R7 处置 |
|---|---|---|
| `src/cli/main.ts` | remote-session/host types、production composition、host-command、host-build-identity | 改为 resolve store → attach/claim → local TCP facade |
| `src/runtime/contracts/public.ts` | 再导出 host types/contracts | R9 移除 re-export（legacy 窗口后） |
| `src/index.ts` | 再导出 host 模块 | R9 移除 |
| `src/tui/interactive-mode.ts` | host types | 改为消费 SessionRuntime facade |
| `src/extensions/hooks/host-runner.ts` | host types | R6 改绑 SessionRuntime owner |
| `src/extensions/integration/runtime-events.ts` | runtime-event-store | R6 改绑 session store |
| `src/extensions/turn-lifecycle.ts` | host-manager | R6 改绑 session scope |
| `src/security/integration/runtime-security-events.ts` | runtime-event-store | R6 改绑 session store |
| `src/worktree/integration/runtime-workspace-events.ts` | runtime-event-store、host-binding | R6 改绑 session store + worktree session locator |
| `src/runtime/process/{manager,schemas,wait-coordinator,completion-reconciler}.ts` | `RUNTIME_HOST_BOUNDS`/host types | §9.2 复用并改绑 session scope；bounds 改引 `SESSION_PROTOCOL_BOUNDS` |
| `src/runtime/tools/{process-tool-support,process-wait}.ts` | `RUNTIME_HOST_BOUNDS` | 同上 |
| `src/storage/process/{process-backend,pty-backend,control-plane,completion-queue}.ts` | host types | §9.2 复用并改绑 session scope（owner 从 Host 改为 SessionRuntime） |

## 4. pure algorithm 迁移清单（去 Host identity 后迁入新目录）

| 现有实现 | 迁移目标 | 说明 |
|---|---|---|
| `src/runtime/host/{types,contracts}.ts` 的 bounded frame/version/bounds | `src/runtime/session-server/protocol.ts` | 已完成 R0：`SESSION_PROTOCOL_BOUNDS`/`SessionFrameEnvelope`/handshake，去掉 `maxProcessesPerHost` 与 peer attestor |
| `src/runtime/host/driver.ts` 的 driver state machine | `src/runtime/session-server/driver.ts`(R4) | connection-scoped：claim/transfer/release/observer fence，disconnect/takeover → NONE + revision event |
| `src/runtime/host/router.ts` 的 subscription cursor/ACK/replay 纯逻辑 | `src/runtime/session-server/subscription.ts`(R4) | 保留 cursor、bounded replay、dedupe、resync |
| `src/storage/host/{command-store,domain-revision-store}.ts` 的 receipt/command 纯语义 | `src/storage/session-store/{session-store,owner-store}.ts`(R2/R3) | owner-fenced transaction、origin/settled generation |
| `src/runtime/host/remote-session.ts` 的 snapshot→replay→live 投影 | `src/runtime/session-runtime/restore.ts`(R5) | 加 checkpoint cache 校验与 full replay 回退 |
| `src/storage/host/{endpoint-store,writer-lease,startup-election,host-generation-store}.ts` | `src/storage/session-store/owner-store.ts`(R3) | `BEGIN IMMEDIATE` claim CAS + heartbeat 取代 election/lease |

## 5. 复用清单（§9.2，改绑 session scope，不迁移文件）

- `src/runtime/{agent,agent-loop,interactive-session-controller}.ts`
- `src/runtime/process/**`、`src/storage/process/**`（进程能力 owner 改绑 SessionRuntime）
- `src/runtime/context/**`、`modes/**`、`resources/**`、`trace/**`
- `src/security/**`、`src/worktree/**`（fence 改绑 `sessionId + generation`）
- `src/extensions/**`（每个 owned SessionRuntime 自装配）
- `src/tui/**`

## 6. 冻结规则

- 新 session 模块（`src/runtime/session-owner/`、`session-runtime/`、`session-server/`、`src/storage/session-store/`、`src/cli/session-client.ts`、`embedded-session-runtime.ts`）禁止消费 legacy Host、TUI、machine leader/daemon/UDS/Named Pipe 与 non-loopback bind；Client 禁止 direct controller。
- 任何新增 legacy Host 消费者都需要修改 `06` 计划并重跑本 inventory，不能只改 allowlist。
- R7 切换后本清单的消费者条目随生产接线迁移；R9 删除后本清单与 §2/§3 归档为历史。
