# 09 · 远程控制桥与进程级 singleton handle(远期设计)

> 本文件描述 RunLedger 未来如何让**非 TUI 代码**(daemon、`runledger remote send` CLI 子命令、外部 IDE 插件等)反向操作当前运行的 InteractiveMode。
>
> **本期 M0–M7 不实现**;本文件作为"远期契约位"留存,日后再决定落实时直接对照本文执行。

---

## 1. 范围与非目标

### 1.1 范围(未来需要支持的能力)

- 多个进程间通过 single-instance + 进程级单例 handle 通信;
- `runledger remote send "<text>"` 在已有运行中的 InteractiveMode 上发起一次 prompt;
- `runledger remote interrupt` 中断当前 turn;
- `runledger remote set-model <modelId>` 切换模型;
- `runledger remote set-thinking off|low|medium|high` 切换 thinking 模式;
- daemon(`runledger daemon`)启动后通过同 handle 接收外部事件、转投 InteractiveMode。

### 1.2 非目标(本远期范围**外**)

- 不引入 WebSocket / SSE / 长轮询 跨网络远程控制(对照 `08-cross-project-lessons.md` §4 不采纳条款);
- 不实现多用户多 session 协同(单一 InteractiveMode 即单一 handle);
- 不引入 RBAC / 多租户(由 `runledger` CLI 入口侧权限模型负责,本桥只走单用户 single-process 假设)。

---

## 2. 触发场景(3 个用例驱动)

### 用例 1:daemon 内存清理通知

`runledger daemon` 长期运行,内存超阈值后通过 `ReplHandle.interrupt()` 让 InteractiveMode 中断当前 turn 以释放 task buffer;不通过 SIGINT 是为了不打断 spinner 子进程。

### 用例 2:CLI 远程命令切换 session

用户在终端 A 跑着 InteractiveMode,在终端 B 跑 `runledger remote open-session <id>`,经 handle 切换 InteractiveMode 当前活跃 ledger session(在 InteractiveMode 看来是一次 `agent_end` + `new Agent(...)` + `agent.subscribe`)。

### 用例 3:外部 IDE 触发 prompt

IDE 集成插件(VS Code 等)通过 IPC 文件信号触发 `ReplHandle.sendText(text)`,把 IDE 选中的代码片段作为用户 prompt 注入 InteractiveMode。本远期任务**不**承诺 IPC 协议细节,只承诺 handle 接口。

---

## 3. 接口契约(草案)

### 3.1 `src/tui/runtime/repl-handle.ts`(本期不创建)

```ts
/**
 * 进程级 singleton handle:让非 TUI 代码反向操作当前活跃 InteractiveMode。
 *
 * 拆分理由:职责边界(对照 claude-code-bun src/bridge/replBridgeHandle.ts)
 *   - 单例 handle 与 TUI 本身解耦:TUI 启动后注册,退出时清空;
 *   - 桥的非 TUI 调用方(IDE / daemon / CLI remote)无需依赖 pi-tui 类型;
 *   - 测试边界:singleton 文件可独立 mock,handle 不持有任何 pi-tui 引用。
 *
 * 本期不创建此文件,远期落地按本契约实施。
 */

import type { Agent } from "../../runtime/agent.ts";

/** 暴露给非 TUI 代码的接口。所有方法必须同步返回 { ok: true } | { ok: false; error }。 */
export interface ReplHandle {
  /** 把文本作为用户 prompt 注入 InteractiveMode;返回是否成功投递。 */
  sendText(_text: string): { ok: true } | { ok: false; error: string };

  /** 中断当前 turn;若无活跃 turn,返回 ok 仍 true 但 error 为 "no-active-turn"。 */
  interrupt(): { ok: true } | { ok: false; error: string };

  /** 切换模型;若 modelId 未知返回 ok: false;error: "model-not-found"。 */
  setModel(_modelId: string): { ok: true } | { ok: false; error: string };

  /** 切换 thinking 模式;mode 取值固化为 4 个字符串之一。 */
  setThinking(_mode: "off" | "low" | "medium" | "high"): { ok: true } | { ok: false; error: string };

  /** dispose 后所有方法返回 ok: false;error: "disposed"。 */
  dispose(): void;
}

/** 取当前活跃 InteractiveMode 的 handle;无活跃实例返回 null。 */
export function getReplHandle(): ReplHandle | null;

/** InteractiveMode.run() 入口注册 handle;退出时清 null。 */
export function setReplHandle(_handle: ReplHandle | null): void;
```

### 3.2 注册时机

- `InteractiveMode.run()` 入口第一步:`setReplHandle(buildReplHandle(this))`;
- `InteractiveMode.run()` 末尾(`ui.start()` resolve 后):`setReplHandle(null)`;
- `quit()` 内部不直接 setReplHandle(null);由 `run()` 末尾统一清空,避免提前让外部调用方拿不到 handle。

### 3.3 `buildReplHandle(mode: InteractiveMode): ReplHandle`

handle 是 InteractiveMode 内部 builder 函数返回的轻对象,只暴露 §3.1 中的 5 个方法;**不**暴露 `mode` 引用、**不**暴露 pi-tui Container / 组件树 / theme。这条边界保证:

1. 远程调用方无法绕过 mutation 协议直接 mutate 组件;
2. handle 单测时只需 mock InteractiveMode 的 5 个公共方法,不需要 pi-tui runtime。

---

## 4. 边界

- handle **不**持有 React tree / pi-tui 子组件引用(对照 `claude-code-bun` `replBridgeHandle.ts` 设计);
- 调用方在 handle 路径上**不**触发 mutation,而是把请求转 `EventTarget` 风格事件,InteractiveMode 在 `handleEvent` 路径同步消费:
  - `sendText(text)` → 内部 enqueue 一条合成 `Event:{kind:"remote-prompt", text}`,InteractiveMode 监听该 synth 事件后走与本地 `Enter` 同一路径;
  - `interrupt()` → 调用 `agent.abort()`,与 Esc 路径合成同一信号;
  - `setModel(modelId)` → 调 `agent.setModel(modelId)`,不可逆操作直接写 Agent state(对照 §01-architecture §6.1 单一状态源);
  - `setThinking(mode)` → 同上;
- `ReplHandle.dispose()` 不解除 `agent.subscribe`,只让 handle 自身进入 disposed 状态,后续方法返回 `error: "disposed"`。

这条边界对应 `claude-code-bun` 的 `replBridgeHandle.ts` 进程级 singleton 思想,以及 `initReplBridge.ts` / `replBridge.ts` 拆分有据的工程分割(handle 与具体协议解耦)。

---

## 5. 文件拆分预案(拆分有据 → 08 §3 规则 4)

远程控制桥若最终落地,文件拆分预案如下,每个文件首段注释必须写明拆分理由,格式见 `02-component-spec.md` §1.1:

| 文件 | 行数级 | 拆分理由 | 对照原项目位置 |
|------|--------|----------|-----------------|
| `src/tui/runtime/repl-handle.ts` | ~36 | 职责边界 + 测试边界:进程级单例 + getter/setter,无业务 | `src/bridge/replBridgeHandle.ts` |
| `src/tui/runtime/init-bridge.ts` | ~100 | bundle 边界:bootstrap-only 路径,daemon 路径不走 | `src/bridge/initReplBridge.ts:1-13` |
| `src/tui/runtime/bridge-core.ts` | ~250-400 | 测试边界:无 bootstrap 依赖,纯逻辑 + 协议 | `src/bridge/replBridge.ts` |
| `src/tui/runtime/bridge-transport.ts` | ~150 | 职责边界:IPC / 文件信号 / stdin 多 transport 实现 | `src/bridge/transports/*`(若有) |

每个文件首段保留如下注释:

```ts
/**
 * <file 做什么,一句话>
 *
 * 拆分理由:<bundle 边界 | 职责边界 | 测试边界>
 *
 * 从 <原文件路径> 移出,原因:<具体说明>。
 * 对照 claude-code-bun:<原项目相对路径>:<起讫行>
 */
```

---

## 6. 失败护栏预案

| 常量 | 值 | 含义 | 出处对照 |
|------|----|------|----------|
| `MAX_CONSECUTIVE_BRIDGE_INIT_FAILURES` | `3` | bridge init 阶段连续失败次数上限 | 对照 `claude-code-bun` 同名常量 |
| `BRIDGE_FAILURE_DISMISS_MS` | `10_000` | 连续失败后下一次重试的最短间隔 | 对照 `claude-code-bun` `BRIDGE_FAILURE_DISMISS_MS = 10_000` |

bridge init 失败 stalled 警报:Datadog 2026-03-08 数据显示某 stuck client 一天发 2879 次 401,占该路由 17% 401。RunLedger 沿用同一上限防止类似 storm。

`MAX_CONSECUTIVE_BRIDGE_INIT_FAILURES = 3` / `BRIDGE_FAILURE_DISMISS_MS = 10_000` 与 `03-event-binding.md` §5.1 的 init 阶段护栏形成两级:一层守 InteractiveMode 自身 init,一层守 bridge init 附加层。

---

## 7. 与 M0–M7 的非冲突性

本期所有组件树装配**不读取** `repl-handle`,文件**不创建**则:

- `getReplHandle()` 不需要 import,因本期不存在 `runtime/repl-handle.ts`;
- `InteractiveMode` 不调用 `setReplHandle(...)`,handle 在本期不存在;
- typecheck 不受影响:本文件中的所有 type 草图为远期 form,无文件落地即无符号泄漏;
- `src/tui/index.ts` barrel **本期不导出** handle 相关 API。

M8 任务开始时,新建 `src/tui/runtime/repl-handle.ts` 一文件即可启 kep,无需改动任何主流程组件;handle 的 5 个方法 dispatch 到现有 `agent.prompt` / `agent.abort` / `agent.setModel` / `agent.setThinking` 已有接口。

---

## 8. 决策点(M8 落地前需要确认)

| 决策点 | 候选 |
|--------|------|
| transport 协议 | (a) stdin 信号(最轻,只支持本地 CLI);(b) IPC 文件(支持本地 daemon);(c) WebSocket(支持远程,**违反 §1.2 非目标排除**) |
| handle 是否跨进程 | (a) 同进程内单例(本期实现成本最低);(b) PID 隔离 + IPC 文件交换 handle(支持 daemon) |
| handle 是否支持广播 | (a) 单一活跃 handle(简单);(b) 多订阅(支持多终端协同,**违反 §1.2 非目标排除**) |
| 与 `feature-adapters.ts` 关系 | bridge 是否应作为可选 feature adapter?是则在 `feature-adapters.ts` 中暴露 `RemoteControlAdapter`,本期 no-op,M8 时换真实实现 |

M8 任务到来时,需先解决上述 4 个决策点再加代码。本远期文档保留作为契约位,**不**在 M0–M7 阶段做决策。

---

## 9. 验收(远期 M8 落地时)

- `npm run check` 通过;
- 单测覆盖 `bridge-core.ts` ≥ 80%;
- 端到端:`runledger daemon` + `runledger remote send "hello"` 触发当前活跃 InteractiveMode 一次 prompt,无 hang;
- 失败护栏生效:模拟 init 失败 4 次,RunLedger 在第 3 次后停止重试并 stderr 一句"Bridge init failed 3 consecutive times, dismiss for 10s"。
