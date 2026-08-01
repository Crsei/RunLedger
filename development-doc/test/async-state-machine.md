# 异步状态机的确定性测试

deadline、熔断冷却窗口、退避、debounce、重连和取消都属于时序逻辑。若测试通过真实 `sleep` 等待状态迁移,测试会同时受墙上时钟、事件循环调度、机器负载和 CI 抖动影响,既慢又容易出现偶发失败。

本附录先提炼 Grok Build 的做法,再给出 RunLedger 在 TypeScript + Vitest 下的对应测试约定。这里描述的是测试方法和后续新增测试的准入规则,不表示 RunLedger 当前已经拥有统一的 `Clock` 或 `Scheduler` 抽象。

## 1. Grok Build 的方法

### 1.1 暂停时钟并显式推进

Grok Build 使用 `#[tokio::test(start_paused = true)]` 暂停 Tokio 时钟,再用 `tokio::time::advance(duration)` 精确推进。当前源码快照中 `start_paused = true` 共 94 处,分布于 25 个 Rust 文件,已经形成稳定的测试方法。

MCP stdio server 的自动重启测试是最直接的例子:

- 生产退避序列是 `1s / 4s / 16s`;
- 测试先断言 `t=0` 没有重启;
- 依次推进 `1s`、`4s`、`16s`;
- 分别在累计时间 `t=1s`、`t=5s`、`t=21s` 断言第 1、2、3 次重启。

源码位置:`grok-build/crates/codegen/xai-grok-shell/src/session/mcp_restart.rs:827-864`。这类测试执行时不需要等待 21 秒真实时间,并且明确覆盖每一个时间边界。

### 1.2 推进时间后显式 settle

虚拟时间只负责让 timer 到期,不保证 timer 唤醒后的整个异步任务图已经跑到稳定态。Grok Build 的 dispatcher E2E 测试使用以下组合:

```text
start_paused = true + current_thread
              + 真实 dispatcher 循环
              + mock 传输边界
              + 显式 advance
              + 固定步数 settle
              + 状态与 wire 双重断言
```

该测试中的 `settle()` 连续执行 8 次 `yield_now()`。源码注释列出了从 coalesce timer 唤醒到 dispatcher、client teardown、flush、spawn restart、backoff、guard、respawn 和 status push 的最长任务链,并据此选择 8 作为有依据的固定上限,而不是用真实 `sleep` 猜测任务是否已经完成。

源码位置:

- 测试约束:`grok-build/crates/codegen/xai-grok-shell/src/session/mcp_dispatcher_e2e_tests.rs:20-24`;
- `settle()` 的任务链说明:`grok-build/crates/codegen/xai-grok-shell/src/session/mcp_dispatcher_e2e_tests.rs:190-213`;
- 完整 crash → drop → restart 场景:`grok-build/crates/codegen/xai-grok-shell/src/session/mcp_dispatcher_e2e_tests.rs:256-328`。

这里的关键不是照搬“8”,而是把时间推进和任务调度都变成测试显式控制的输入。若被测任务图更短或更长,测试必须按自己的任务链选择同步点或固定步数,并写明依据。

## 2. RunLedger 中的等价物

RunLedger 使用 Vitest 2.1。Tokio 方法在本项目中的对应关系如下:

| Grok Build / Tokio | RunLedger / Vitest | 项目约定 |
|---|---|---|
| `start_paused = true` | `vi.useFakeTimers()` | 只在需要控制时间的测试中启用,不做全套件全局默认 |
| `tokio::time::advance(d)` | `await vi.advanceTimersByTimeAsync(ms)` | 异步 timer callback 一律使用 `Async` 版本 |
| 固定时刻 | `vi.setSystemTime(fixedDate)` | 同时固定 `Date.now()` 和消息、ledger 时间戳 |
| `yield_now()` | `await vi.advanceTimersByTimeAsync(0)` 或显式 gate | 优先等待可观察的 `started` / `release` gate;跨不透明任务链时才使用局部 `settle()` |
| `current_thread` | 单个测试内的 Node event loop | 不使用 `it.concurrent`;fake timers 属于测试 worker 的全局状态 |
| mock transport | `StreamFn`、`ExecutionEnv`、`Terminal` test double | mock 外部边界,保留真实 Agent / controller / TUI 状态机 |
| production state + wire | Agent state + events + ledger / terminal writes | 至少断言状态和一个外部可观察结果 |

Vitest 的 `vi.setSystemTime()` 只修改当前时间,不会触发 timer。状态迁移必须由 `advanceTimersByTimeAsync()` 推进。不要用 `runAllTimersAsync()` 代替边界测试;它适合“有限任务最终全部完成”的测试,不适合退避、周期任务或需要验证 `t-1` 与 `t` 差异的状态机。

## 3. 文件内的基础配方

需要虚拟时间的测试文件使用局部 setup 和 cleanup:

```ts
import { afterEach, beforeEach, vi } from "vitest";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});
```

只有当一次时间推进会跨多个、无法直接观察的异步任务时,才在该测试文件内定义 `settle()`:

```ts
async function settle(turns = 8): Promise<void> {
  for (let i = 0; i < turns; i++) {
    await vi.advanceTimersByTimeAsync(0);
  }
}
```

规则如下:

1. `settle()` 保持 file-local,除非多个测试文件已经证明共享相同任务拓扑;
2. 注释列出要排空的任务链,说明 `turns` 的来源;
3. 能暴露 `started: Promise<void>`、`release()` 或事件回调时,优先等待这些确定同步点;
4. `settle()` 之后仍要断言状态,不能把“没有继续报错”当成稳定态证明;
5. 测试结束时清理 timer、subscription、AbortController、后台任务和临时目录。

## 4. RunLedger 的工作示例

### 4.1 精确测试 mock stream 的取消边界

`src/runtime/providers/mock-stream.ts` 通过 `queueMicrotask()` 启动流,首个文本阶段前有 20ms timer,之后每个字符有 5ms timer。当前 `tests/runtime/mock-stream-phase.test.ts` 会真实等待这些延迟。使用虚拟时间后,可以直接验证“已启动但尚未到检查点 → abort → 下一检查点以 aborted 结束”的状态迁移:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  mockModel,
  mockStreamFn,
} from "../../src/runtime/providers/mock-stream.ts";
import type { LlmContext } from "../../src/runtime/types.ts";
import type { AssistantMessageEvent } from "../../src/types.ts";

async function settle(turns = 8): Promise<void> {
  for (let i = 0; i < turns; i++) {
    await vi.advanceTimersByTimeAsync(0);
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("mockStreamFn cancellation", () => {
  it("在首个 20ms 检查点把流终止为 aborted", async () => {
    const abort = new AbortController();
    const context: LlmContext = {
      systemPrompt: "test",
      messages: [{
        role: "user",
        content: [{ type: "text", text: "hello" }],
        timestamp: Date.now(),
      }],
      tools: [],
    };
    const stream = mockStreamFn(mockModel, context, { signal: abort.signal });
    const events: AssistantMessageEvent[] = [];
    const completed = (async () => {
      for await (const event of stream) events.push(event);
    })();

    await settle();
    expect(events.map((event) => event.type)).toEqual(["start"]);

    abort.abort();
    await vi.advanceTimersByTimeAsync(19);
    await settle();
    expect(events.at(-1)?.type).toBe("start");

    await vi.advanceTimersByTimeAsync(1);
    await completed;
    expect(events.at(-1)).toMatchObject({ type: "error", reason: "aborted" });
    expect(vi.getTimerCount()).toBe(0);
  });
});
```

这个测试同时覆盖了状态、时间边界和对外事件,而不是只断言 `prompt()` 最终 resolve。若测试只关心 phase detection 纯函数,仍应保持同步测试,不必引入 fake timers。

### 4.2 顺序状态机优先使用显式 gate

不是所有异步状态机都需要虚拟时间。`tests/runtime/agent-queue-thinking.test.ts` 中的 `controlledStream()` 已经使用了更强的同步方式:

- `started` 明确表示首个 stream 已进入受控点;
- `release()` 明确允许首个 stream 继续;
- 测试在两者之间注入 steering 和 follow-up;
- 最终断言每一轮看到的 user message 序列和 queue 清空状态。

`tests/tui/interactive-controls.test.ts` 的 `interruptibleStream()` 也通过 `started` 和捕获到的 `AbortSignal` 验证 Ctrl+C。这两类测试的迁移原则是保留 gate,不要为了形式统一改成 `advance(0)` 或真实 `sleep`。

当状态转换由业务输入触发而非时间触发时,gate 是首选;当转换条件本身是 deadline、退避或 debounce 时,才使用 fake timers。一个测试同时涉及两者时,使用“gate 到达已知状态 → advance 时间 → gate/事件确认新状态”的组合。

### 4.3 保留真实状态机,只 mock 外部边界

Grok Build 的 E2E 测试运行真实 dispatcher,只 mock transport。RunLedger 对应测试应采用同样边界:

- Agent 测试运行真实 `Agent` 和 `runAgentLoop`,mock `StreamFn` 与工具执行边界;
- controller 测试运行真实 `InteractiveSessionController`,mock provider API 和 auth interaction;
- TUI 测试运行真实 `InteractiveMode`,mock `Terminal` 并检查 writes / start / stop;
- ExecutionEnv 测试按目标选择 mock `FileSystem` / `Shell`,不要 mock 掉工具自身状态机;
- 审计测试同时检查 `AgentEvent` 和 ledger entry,相当于生产状态与 wire 双重观察。

现有 `tests/agent-loop.test.ts` 已经同时断言事件序列和 ledger,边界选择正确;但它使用带真实延迟的 `mockStreamFn`。后续若优化测试耗时,应给该文件启用 fake timers 或改用零延迟受控 stream,不能删除事件或 ledger 任一侧的断言来换取速度。

## 5. 当前代码中的应用清单

| 位置 | 当前时序来源 | 推荐方法 |
|---|---|---|
| `tests/runtime/mock-stream-phase.test.ts` | mock stream 的 `20ms / 5ms / 10ms` delay | fake timers;完成型用 `runAllTimersAsync()`,边界型用精确 `advanceTimersByTimeAsync()` |
| `tests/runtime/agent-interrupt.test.ts` | microtask 启动、延迟检查 AbortSignal | 使用 `started` gate 或 4.1 的精确时间边界;加强 aborted event / message / ledger 断言 |
| `tests/runtime/agent-queue-thinking.test.ts` | 并发 prompt、steering、follow-up 顺序 | 保留 `started / release` gate,无需 fake timers |
| `tests/tui/interactive-controls.test.ts` | Ctrl+C 与 provider abort 顺序 | 保留 `interruptibleStream.started`,检查 signal 与 TUI 生命周期 |
| `src/tui/session-selector.ts` | 选择完成后延迟 25ms render | 新增 fake timer 测试,分别断言 24ms 尚未 stop、25ms stop |
| `src/tui/theme/osc-detector.ts` | OSC 11 的 100ms fallback | 新增 fake timer 测试,分别断言 99ms pending、100ms 返回 dark |
| `src/runtime/ledger/lockfile.ts` | 每次 lock retry 间隔 50ms | retry 调度用 fake timers;proper-lockfile 互斥与 stale 行为保留真实文件系统集成测试 |
| `tests/storage/session-manager.test.ts` | 两处真实 30ms sleep 用来制造 mtime 顺序 | 不用 fake timers;改用 `utimes`/显式 mtime fixture,因为 OS 文件时间不受 Vitest 时钟控制 |
| `src/runtime/execution-env.ts` | 子进程 timeout 与 kill | 单元层 mock child/scheduler;真实 shell 集成层使用短真实 timeout,不能假设 fake timer 会推进 OS 进程 |
| OAuth / fetch / websocket | `AbortSignal.timeout`、网络重试、idle timer | 注入 signal/timer/transport 后做虚拟时间单测;网络协议另保留集成测试 |

该表是采用顺序,不是要求在一个变更里一次迁移所有测试。每次实现新的 deadline、cooldown、lease、retry 或 debounce 时,对应确定性时序测试应与生产逻辑同一变更提交。

## 6. 虚拟时间的边界

Vitest fake timers 能控制 JavaScript 的 timer 与 `Date`,但不能自动控制所有外部世界:

- `vi.setSystemTime()` 不会修改真实文件 mtime;
- libuv 文件 I/O、子进程退出、PTY、socket 和远端响应不随 fake clock 自动前进;
- Node 内部实现的 `AbortSignal.timeout()` 不应未经验证就假定受 fake timers 完整控制;
- proper-lockfile 的 stale 判断同时依赖文件系统状态,不能只靠 fake `Date.now()` 证明;
- 无限 interval、常驻 daemon 或持续重连循环不能使用 `runAllTimersAsync()` 排空。

因此测试分两层:

1. **确定性单元/组件测试**:虚拟时间 + 可注入依赖 + 明确 gate,覆盖所有状态转换边界;
2. **少量真实集成测试**:真实文件系统、子进程、PTY 或网络,只验证虚拟时钟无法覆盖的适配边界,并使用短 timeout 和完整 cleanup。

若一个新状态机同时直接调用 `Date.now()`、`setTimeout()`、文件系统和网络,应先把外部操作收敛到窄接口。对于后续 governed runtime 的 deadline、lease、cooldown 和 retry,建议注入最小依赖:

```ts
export interface Scheduler {
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}
```

生产实现使用系统时间,测试实现由 fake timers 或手动 scheduler 驱动。不要为了普通时间戳格式化引入全局 Clock;只在时间会改变状态迁移结果时建立该边界。

## 7. 时序测试准入检查

新增或修改异步状态机测试时,逐项确认:

- 没有用真实 `sleep` 等待 JavaScript timer 状态迁移;
- 明确断言 deadline 前一刻与到期时刻;
- 使用 `advanceTimersByTimeAsync`,而非同步推进异步 callback;
- 时间推进后通过 gate、局部 `settle()` 或具体事件确认任务图稳定;
- mock 的是 transport / clock / shell 等外部边界,不是被测状态机;
- 至少断言内部状态和一个外部可观察结果,如 event、ledger、terminal write 或 provider call;
- 取消路径断言最终 `stopReason = "aborted"` 或等价审计结果;
- 测试结束恢复 real timers 并释放 subscription、lock、进程和临时文件;
- 涉及文件 mtime、子进程或网络时,明确哪些结论来自真实集成层;
- 测试名称表达状态转换和触发条件,而不是笼统写“works”。

这套方法的核心可以归纳为一句话:把时间、调度和外部输入都变成测试能够显式控制的依赖,然后按时间边界断言唯一的状态与输出。

## 8. Agent Runtime 测试指导方案

本节把前面的确定性异步测试方法落实到 RunLedger Agent Runtime。它是测试设计与评审指南,不是第二份实施状态账本。[Runtime contract 计划](../runtime/04-governed-agent-harness-runtime-plan.md)只规定公共协议与被动状态;具体行为完成状态以对应专项计划、当前代码/tests 和验证证据为准。本节只规定“实现某项运行时能力时,测试应如何构建、观察和验收”。

### 8.1 测试范围

当前 Agent Runtime 测试范围分为三层:

| 层级 | 生产模块 | 测试责任 |
|---|---|---|
| Runtime core | `agent-loop.ts`、`agent.ts`、`types.ts` | turn、stream、queue、hook、取消、工具批次和生命周期状态机 |
| Runtime services | `tool-authorization.ts`、`tool-context.ts`、`tool-registry.ts`、`ledger/`、`tasks/` | 权限、执行上下文、审计、重放、锁和 task projection |
| Runtime adapters | `interactive-session-controller.ts`、`stdlib-stream.ts`、`execution-env.ts` | model/auth/session 装配、事件转发、文件系统和 shell 边界 |

TUI 与 CLI 只验证 adapter 行为,不在 UI 测试中重复证明 Agent core。真实 provider 调用属于 opt-in smoke test,不得进入默认 `npm test`;默认套件必须在无 API key、无外网的环境中稳定运行。

后续 Session、Workspace、Gateway、Artifact、Orchestrator 和 Verifier 落地时,继续复用本节的 fixture、故障注入和多观察面规则,但具体安全不变量仍由权威 runtime 计划定义。

### 8.2 核心不变量

Agent Runtime 的测试不是只证明“最后返回了一条 assistant 消息”,而是证明以下不变量在成功、失败和取消路径中都成立:

1. **单飞**:同一个 `Agent` 同时最多有一个活跃 `prompt()`;第二个 prompt 被拒绝,steering/follow-up 只能进入队列;
2. **有界终止**:每个合规 stream 最终进入 `stop`、`error` 或 `aborted`;`waitForIdle()` 最终返回,`inFlight` 复位;
3. **顺序确定**:turn、message、tool 和 queue 事件满足协议偏序,不依赖墙上时钟或 CI 调度;
4. **上下文一致**:下一轮 LLM 所见 messages、system prompt、model、thinking level 和 tools 与上一轮状态转换一致;
5. **工具至多一次**:被 allow 且 schema 有效的 tool call 执行一次;unknown、deny、invalid、length-truncated 或 pre-aborted call 执行零次;
6. **结果同序**:同一批次的 tool result 与原始 tool call 可稳定关联,并保留 `toolCallId`、`toolName`、`isError` 和结构化 details;
7. **取消传播**:同一个 AbortSignal 到达 provider、hook 和 tool context;取消后不得启动新的副作用;
8. **审计对应**:关键 event 有对应 ledger entry,sessionId 一致,high-water mark 单调增长;
9. **故障收敛**:provider error、tool throw、hook throw、subscriber throw 和持久化失败遵守各自契约,不会留下错误的 active 状态;
10. **资源释放**:测试结束时没有遗留 timer、listener、lock、child process、临时目录或未处理 Promise。

### 8.3 测试观察模型

`Agent` 当前没有公开的多值 state enum,测试使用下列观察状态,不要为了测试把它们直接新增为生产枚举:

| 观察状态 | 进入条件 | 必须观察的证据 |
|---|---|---|
| Idle | 构造完成或一次 run 已收敛 | `inFlight=false`;无 active promise 可见行为;冷态 interrupt 为 no-op |
| Running | 调用 `prompt()` | `inFlight=true`;一次 `agent_start`;初始 user message 已进入事件流 |
| Streaming | provider 发出 `start` / delta | assistant `message_start/update`;尚无 tool execution |
| ToolPreparing | assistant 以 tool call 结束 | `tool_execution_start`;tool lookup、prepareArguments、schema、before hook |
| ToolExecuting | allow 且参数有效 | tool gate 已进入;可产生零到多条 update;AbortSignal 与 ToolContext 可观察 |
| ToolFinalizing | execute 已完成或已合成 error | after hook;`tool_execution_end`;tool result event/ledger/message |
| NextTurn | toolUse、steering 或 follow-up 要求继续 | `turn_end(n)` 之后出现 `turn_start(n+1)`;新 context 正确 |
| Aborting | active run 收到 interrupt / external abort | signal 只触发一次;最终 stopReason 为 `aborted`;不再启动新 tool |
| Terminal | stop/error/aborted 或 stop hook | `agent_end`;最终 messages 与 ledger 收敛;随后回到 Idle |

queue 是 Running 的正交状态,需要单独观察 `empty / steering pending / follow-up pending / both pending`。测试必须覆盖 steering 优先、`one-at-a-time` 和 `all` 三种有效组合,不能只从最终文本猜测队列是否正确 drain。

### 8.4 每个测试使用哪些 oracle

Runtime core 测试从五个观察面选取证据:

| Oracle | 内容 | 典型断言 |
|---|---|---|
| Return/state | `prompt()` 返回值、`Agent.state`、`inFlight`、queues | role/content、最终 stopReason、队列为空、state copy 不被外部修改 |
| Events | `AgentEvent[]` | 类型偏序、次数、toolCallId、turn number、update 在 end 前 |
| Ledger | `LedgerEntry[]`、`lastError`、high-water mark | entry 类型、payload、sessionId、单调性、重放一致性 |
| Boundary calls | provider/tool/auth/shell test double 的调用记录 | 次数、参数、signal、并发重叠、没有越权调用 |
| Resource state | timer/listener/lock/process/temp path | `vi.getTimerCount()===0`、release/dispose 已调用、目录清理 |

断言规则:

- 纯 reducer/schema 测试可只使用一个 oracle;
- Agent component 测试至少使用 Return/state + Events;
- 声称“可审计”的路径必须再加入 Ledger;
- 涉及工具、provider 或 shell 副作用时必须加入 Boundary calls;
- 涉及 timeout、取消或后台任务时必须加入 Resource state;
- 随机 id 和时间戳先归一化再比较,不使用覆盖整份对象的脆弱 snapshot;
- fake clock 下多个事件可有相同 timestamp,只断言非递减或固定值,不要求严格递增。

当前 event 与 ledger 的对应关系如下,新增测试应以此为基线:

| Event | 当前 ledger entry | 说明 |
|---|---|---|
| `agent_start / agent_end` | `agent_event` | terminal 路径应成对 |
| user / assistant `message_end` | `message` | assistant 保存 provider metadata 与 stopReason |
| `turn_start / turn_end` | `turn` | 同一 turn 应有 start/end |
| `tool_execution_start` | `tool_call` | 发生在 lookup/schema/authorization 结果之前 |
| `tool_execution_update` | 无 | 当前只发给 subscriber,不要误写为已有 durable audit |
| `tool_execution_end` | `tool_result` | error 也必须落 terminal result |
| tool result 回灌 context | `message` | 供 session replay 恢复 canonical message |
| `queue_update` | 无 | 当前是易失 runtime event |

### 8.5 测试 fixture 架构

新测试不要在每个文件里重复拼装 model、usage、event stream 和手写 Promise gate。先构建以下 file-local helper;同一 helper 在三个以上测试文件稳定使用后,再提升到 `tests/runtime/helpers/`:

```text
tests/runtime/helpers/
├── runtime-fixtures.ts      固定 Model、usage、message 和 toolCall builder
├── controlled-stream.ts     可脚本化 StreamFn、turn gate、事件注入和调用记录
├── controlled-tool.ts       execute gate、update、throw、abort 和并发探针
├── event-recorder.ts        事件收集、类型序列和偏序断言
├── fault-ledger.ts          可延迟/失败的 LedgerSink test double
├── ledger-assertions.ts     event ↔ entry 对应与 session/high-water 断言
└── time.ts                  fake timer setup、局部 settle 和 timer cleanup
```

fixture 必须满足以下约束:

- builder 默认生成固定 model/provider/id/usage,测试只覆写与场景有关的字段;
- controlled stream 暴露 `entered(turn)` 与 `release(turn)` gate,并记录每轮 LLM context 和 options;
- stream error 通过 `AssistantMessageEventStream` 的 `error` 事件表达;另设“违反 StreamFn 契约而 throw”的专门 fixture;
- controlled tool 记录 `executeCount`、args、ToolContext 和 signal,支持手动 `resolve/reject/update`;
- 并发测试使用 barrier 证明两个 execute 同时进入,不通过运行耗时推断并发;
- fault ledger 默认遵守 `append()` 不抛的 `LedgerSink` 契约,把失败写入 `lastError`;只有防御性契约测试才使用 throwing sink;
- helper 不读取真实环境变量、不访问网络、不共享固定临时目录或端口;
- helper 代码同样受 `strict`、`erasableSyntaxOnly`、`.ts` import 和禁止 `any` 约束。

推荐的 scripted stream 能表达以下动作,但无需一次实现成通用 DSL:

```text
enter turn -> emit start -> emit text/thinking/toolcall
           -> wait gate -> emit done/error -> end
```

测试若只需一个同步点,直接使用一个 `started` Promise 比引入 DSL 更清晰。helper 的目的是消除不确定性和重复,不是建立新的测试框架。

## 9. Agent Runtime 测试矩阵

以下状态标签只描述测试建设动作:

- **现有**:已有测试可以作为证据;
- **补强**:已有测试方向正确,但 oracle 或边界不完整;
- **新增**:当前缺少直接测试;
- **契约决策**:代码与注释或异常语义尚未统一,先决定规范再写回归测试。

### 9.1 Agent 生命周期与 queue

| 场景 | 状态 | 测试方法与验收证据 | 建议位置 |
|---|---|---|---|
| idle → prompt → idle happy path | 补强 | gate 控制 stream;断言 `inFlight false→true→false`、agent start/end 各一次、state messages 更新 | `agent-lifecycle.test.ts` |
| 第二个 active prompt | 现有 | 首个 stream 停在 gate;第二个 prompt 精确 reject;首个仍可继续完成 | `agent-queue-thinking.test.ts` |
| cold interrupt | 现有 | 不产生事件、不污染下一次 prompt | `agent-interrupt.test.ts` |
| stream 中 interrupt | 补强 | 在 `start` 后 abort;断言 provider signal、assistant aborted、turn_end/agent_end、ledger 和 idle | `agent-interrupt.test.ts` |
| tool execute 中 interrupt | 新增 | tool 停在 gate 并监听 signal;interrupt 后零新增副作用,tool terminal result 与 agent terminal 状态一致 | `agent-interrupt.test.ts` |
| external signal 已预先 aborted | 新增 | prompt 启动后不调用 provider/tool,最终稳定返回或按明确契约 reject | `agent-lifecycle.test.ts` |
| `waitForIdle()` success/rejection | 新增 | 分别让 stream 正常完成和违反契约 throw;两条路径都必须解除 active 状态 | `agent-lifecycle.test.ts` |
| state getter 防御性 copy | 新增 | 修改返回的 messages/tools 不影响 Agent 内部状态 | `agent-lifecycle.test.ts` |
| subscriber throw | 新增 | 一个 listener throw、另一个仍收到事件,run 不失败 | `agent-events.test.ts` |
| slow subscriber | 新增 | 用 gate 证明 runtime 当前等待 subscriber;不得用 5ms sleep 模拟慢订阅者 | `agent-events.test.ts` |
| queue update 与 clear | 补强 | 断言每次 enqueue/drain/clear 的完整 snapshot,unsubscribe 后不再收到事件 | `agent-queue-thinking.test.ts` |
| steering/follow-up 组合矩阵 | 补强 | `one-at-a-time/all` × only steering/only follow-up/both;断言 LLM contexts | `agent-queue-thinking.test.ts` |

### 9.2 Stream、message 与 turn 协议

| 场景 | 状态 | 测试方法与验收证据 | 建议位置 |
|---|---|---|---|
| 非 user prompt | 新增 | 断言明确错误及最终 runtime 清理;terminal audit 语义先按 10.1 决定 | `agent-loop-protocol.test.ts` |
| 缺少 streamFn | 新增 | 直接测试 `runAgentLoop`;错误文本稳定,不误调用工具 | `agent-loop-protocol.test.ts` |
| text delta 合并 | 新增 | 多个相邻 delta 合并为一个 text block,遇 thinking/toolCall 不丢 provider content | `agent-loop-protocol.test.ts` |
| thinking/signature/provider metadata | 新增 | done message 的完整 content、usage、api/provider/model/timestamp 无损进入 AgentMessage 和 ledger | `agent-loop-protocol.test.ts` |
| provider `stop` | 现有 | 一轮结束,无 tool execution,事件与 ledger 成对 | `agent-loop.test.ts` |
| provider `error` | 新增 | error message 入 context,不执行 tool,turn/agent terminal stopReason 正确 | `agent-loop-errors.test.ts` |
| provider `aborted` | 补强 | 与主动 abort 分开测试 provider 主动返回 aborted | `agent-loop-errors.test.ts` |
| `length + toolCall` | 新增 | 每个 call 合成 isError result,executeCount=0,下一轮 context 可读错误 | `agent-loop-errors.test.ts` |
| toolUse 多轮 | 现有 | mock echo 完整循环;补充精确 turn 次数和 context | `agent-loop.test.ts` |
| `convertToLlm` | 新增 | user/assistant/toolResult 角色、metadata、addedToolNames 和时间字段逐项断言 | `agent-message-conversion.test.ts` |
| `prepareNextTurn` | 新增 | 下一轮收到更新后的 model/thinking/systemPrompt/tools,当前轮不被追溯修改 | `agent-loop-hooks.test.ts` |
| `shouldStopAfterTurn` | 新增 | toolUse 后被 hook 停止,不发起下一轮 stream;terminal 事件仍完整 | `agent-loop-hooks.test.ts` |
| steering 优先于 follow-up | 现有 | 同一批次结束后先 drain steering,没有 tool/steering 时才 drain follow-up | `agent-queue-thinking.test.ts` |
| malformed stream | 新增 | done-before-start、无 terminal、重复 terminal 分别定义防御性行为;不得与合规 provider 测试混写 | `agent-loop-contract-violations.test.ts` |

### 9.3 工具 prepare → execute → finalize

| 场景 | 状态 | 测试方法与验收证据 | 建议位置 |
|---|---|---|---|
| unknown tool | 新增 | start/end 与 ledger 仍完整,executeCount=0,result 为 `Tool not found` | `tool-pipeline.test.ts` |
| `prepareArguments` | 新增 | raw args 先归一化再 schema validate,tool 收到 normalized args | `tool-pipeline.test.ts` |
| schema invalid | 新增 | before hook 和 execute 都不调用,错误 result 可审计 | `tool-pipeline.test.ts` |
| before allow/deny | 补强 | allow 执行一次;deny 执行零次;request 包含 assistant/context/tool/args/signal | `tool-events-authorization.test.ts` |
| before hook throw | 新增 | 按 block 处理并保留 reason,主 loop 不 reject | `tool-pipeline.test.ts` |
| tool throw | 新增 | 转 isError tool result;update chain 先完成;下一轮能看到错误 | `tool-pipeline.test.ts` |
| zero/multiple update | 补强 | update 按调用顺序、全部在 end 前;慢 listener 用 gate | `tool-events-authorization.test.ts` |
| after hook shallow override | 新增 | content/details/isError/terminate 按字段整体替换,未提供字段保留原值 | `tool-pipeline.test.ts` |
| after hook throw | 新增 | 吞掉 hook error,沿用 execute result | `tool-pipeline.test.ts` |
| ToolContext 完整性 | 补强 | cwd/env/ledger/envVars/signal/sessionId/toolCallId 与本次调用一致 | `tool-context.test.ts` + runtime integration |
| 大结果预算 | 新增 | 恰好 max 不落盘;max+1 产生 hint;图像保留;不可写路径走 inline truncate | `tool-result-budget.test.ts` |
| sequential | 新增 | 第二个 tool 只能在第一个 release 后进入;start/update/end 偏序稳定 | `tool-concurrency.test.ts` |
| parallel-safe | 新增 | 两个 tool 同时到达 barrier;结果与原 call 正确关联 | `tool-concurrency.test.ts` |
| unsafe 降级 | 新增 | 任一 tool `executionMode=sequential` 或 `isConcurrencySafe()!=true` 时整批串行 | `tool-concurrency.test.ts` |
| cancelled batch | 新增 | 取消后尚未开始的 call 不产生副作用;已开始 call 收到 signal | `tool-concurrency.test.ts` |
| late update | 契约决策 | tool promise settle 后保存的 onUpdate 再调用;规范要求忽略,当前实现需先核对 | `tool-pipeline.test.ts` |

### 9.4 Ledger、task 与 replay

| 场景 | 状态 | 测试方法与验收证据 | 建议位置 |
|---|---|---|---|
| event ↔ ledger 完整映射 | 补强 | 使用 8.4 映射逐项核对次数、payload 和 sessionId | `agent-ledger-audit.test.ts` |
| high-water 单调与重启继承 | 现有 | Memory/JSONL 均覆盖;新增 Agent turn 后的增量断言 | `ledger-highwater.test.ts` |
| append 失败 | 补强 | JsonlLedger 保留内存 entry 并设置 `lastError`;runtime 不伪造持久化成功 | `agent-ledger-faults.test.ts` |
| corrupt tail / unknown entry | 新增 | 当前格式对损坏或未知输入立即拒绝;用严格 integrity 测试固定 fail-closed 行为 | `agent-ledger-faults.test.ts` |
| sessionId mismatch | 新增 | initialize 记录 lastError,不把别的 session entries 当作本 session | `agent-ledger-faults.test.ts` |
| lock retry 时间边界 | 新增 | JS retry scheduler 用 fake time;proper-lockfile 行为保留真实 fs 测试 | `lockfile.test.ts` |
| task create/update/list | 现有 | 保留 projection 与 in_progress 排他测试 | `task.test.ts` |
| task replay permutation | 补强 | duplicate、unknown、update-before-create、deleted 后 update 等表驱动测试 | `task.test.ts` |
| live 与 replay 等价 | 新增 | 同一 canonical entries 的 live snapshot 与 replay snapshot 深度一致 | `task-replay-equivalence.test.ts` |

### 9.5 Controller 与 adapter

| 场景 | 状态 | 测试方法与验收证据 | 建议位置 |
|---|---|---|---|
| selection 优先级 | 补强 | 已覆盖 CLI > session > settings;补 ambiguous/unknown model error | `interactive-session-controller.test.ts` |
| login/select/thinking/logout | 现有 | auth、settings、runtime.config ledger 与 prompt 贯通 | `interactive-session-controller.test.ts` |
| active prompt 的 steer/followUp | 新增 | controller 在 inFlight 时不启动第二个 prompt,按 behavior 入正确队列 | `interactive-session-controller.test.ts` |
| event forwarding | 新增 | Agent event 到所有 controller listener;throwing listener 不影响其他 listener | `interactive-session-controller.test.ts` |
| dispose | 新增 | unsubscribe 后不再转发,listener 集合清空,不影响已完成 messages | `interactive-session-controller.test.ts` |
| model/thinking hot update | 新增 | 下一次 provider call 使用新 model/options;不重建丢失 replay state | `interactive-session-controller.test.ts` |
| stdlib bridge | 补强 | 默认工具清单、cwd、ledger、streamFn 注入与完整 turn | `stdlib-agent.test.ts` |
| ExecutionEnv | 现有/补强 | fs/shell 基础集成已覆盖;timeout/abort/large output 需 mock + real boundary 分层 | `execution-env.test.ts` |
| real provider | 手工 smoke | 显式 opt-in,凭据不打印、不写 fixture;不作为 PR 必过 gate | 独立 smoke 命令/说明 |

## 10. 先冻结契约,再写回归测试

以下位置当前存在注释、类型或异常语义尚未完全统一的情况。实施测试前应先在同一个小变更中决定期望行为;可以先写标记为 characterization 的当前行为测试,但不能把它称为最终规范。

### 10.1 当前需要决策的契约点

| 契约点 | 当前证据 | 测试前要决定的问题 |
|---|---|---|
| `terminate` | `AgentToolResult` 注释声明“批次全部 true 时早停”,`agent-loop.ts` 当前只透传字段 | 是实现批次早停,还是删除/降级该承诺 |
| parallel finalize 顺序 | 注释写“按实际完成顺序”,实现等待 `Promise.all` 后按输入索引 finalize | 事件/ledger/result 应采用调用顺序还是完成顺序 |
| late `onUpdate` | 类型注释要求 tool promise settle 后忽略,当前 callback 没有 closed guard | late update 是否必须丢弃并记录诊断 |
| deferred tools | `addedToolNames` 当前只透传,不会修改 `AgentContext.tools` | 维持 passthrough 还是在下一 turn 激活 |
| StreamFn throw | 类型契约要求 error 编码进 stream,但 JS 实现仍可能同步/异步 throw | Agent 仅清理 inFlight,还是还要合成 terminal event/ledger |
| invalid prompt / missing stream | `agent_start` 可能已发出后抛错,未必有 `agent_end` | 初始化错误是否属于已开始 run,terminal audit 如何闭合 |
| non-throw ledger | `LedgerSink` 约定 append 不抛,第三方实现仍可能违约 | runtime fail closed、吞错诊断还是直接 reject |
| slow subscriber | `Agent.dispatch()` 当前 await 全部 listener | subscriber backpressure 是契约还是未来要隔离/限时 |
| durable updates | `tool_execution_update` 与 `queue_update` 当前不进 ledger | 保持易失还是纳入 canonical event |

契约决策完成后,必须同时更新类型注释、生产实现、对应测试和权威 runtime 计划中的能力边界。不要只改测试期望来绕过不一致。

## 11. 故障注入与竞态测试

Agent Runtime 的错误路径使用可控故障点,不依赖随机 sleep:

| 故障点 | 注入方式 | 必须断言 |
|---|---|---|
| provider error | scripted stream 发 `error` 后 end | error message、无工具副作用、terminal event/ledger、idle |
| provider contract violation | StreamFn throw / malformed stream | 明确 rejection/diagnostic、资源清理、不得挂起 |
| tool error | controlled tool reject | isError result、end event、下一轮 context、无 unhandled rejection |
| authorization failure | deny 或 hook throw | executeCount=0、可审计 reason |
| cancellation race | 在 stream start、tool prepare、execute、finalize 各 gate abort | 每个 gate 的副作用上界、唯一 terminal 状态 |
| slow event sink | listener gate | 证明当前 backpressure 行为;release 后事件不乱序 |
| ledger write failure | fault ledger / 不可写 JSONL path | lastError、内存证据、runtime 的已决定故障策略 |
| timer boundary | fake timers 推进到 `deadline-1` 和 `deadline` | 前一刻不迁移,到期只迁移一次 |
| parallel tools | barrier + 独立 release order | 真正重叠、关联不串线、取消不启动新副作用 |
| cleanup failure | release/close test double throw | 主要 terminal 结果与 cleanup 诊断符合契约 |

竞态测试至少覆盖以下 schedule,且每个 schedule 用 gate 精确构造:

1. abort 发生在 provider `start` 前;
2. abort 发生在 `start` 后、第一个 delta 前;
3. abort 发生在 tool start 后、execute 副作用前;
4. abort 与 tool resolve 排在同一 microtask checkpoint;
5. steering 与当前 tool batch 完成同时到达;
6. follow-up 与 stop terminal 同时到达;
7. parallel batch 中一个成功、一个失败、一个等待 abort;
8. listener unsubscribe 与事件 fan-out 同时发生;
9. ledger append 失败与 provider terminal 同时发生;
10. waitForIdle 注册在 run 完成前后两个边界。

禁止通过重复跑几百次来替代这些可枚举 schedule。重复执行可以作为额外 soak,但确定性 gate 测试才是正确性证据。

## 12. 分层执行方案

测试建设按以下顺序推进,每一波都保持可独立 review 和提交:

### Wave A:契约冻结与 helper

- 对 10.1 的契约点逐项形成明确结论;
- 先实现固定 model/message builder、controlled stream/tool、event recorder;
- 引入 file-local fake-time helper,不要全局开启 fake timers;
- 不迁移与当前目标无关的既有测试文件。

退出条件:helper 自身有最小自测,且一个 happy-path Agent 测试证明 fixtures 可同时观察 state、events、ledger 和 boundary calls。

### Wave B:生命周期、错误与取消

- 完成 9.1 和 9.2 的新增/补强项;
- 把 `agent-interrupt.test.ts` 的宽松断言改为精确 aborted 证据;
- 为 success/error/aborted/contract-throw 分别证明 `inFlight` 和 `waitForIdle` 收敛;
- 使用 4.1 的 fake-time 方法替换 mock stream 的真实延迟。

退出条件:所有 active 状态都有成功、失败、取消到 Terminal/Idle 的确定路径,没有依赖真实 JS sleep 的 core 测试。

### Wave C:工具流水线与并发

- 完成 prepare/execute/finalize 分支矩阵;
- 使用 barrier 证明 sequential/parallel/unsafe downgrade;
- 覆盖 authorization、schema、throw、update、after hook 和大结果预算;
- 冻结 late update、terminate 和 finalize order 契约。

退出条件:每种“执行一次/执行零次”路径都有 boundary call 计数,每个 terminal tool result 都能与 event/ledger/message 对应。

### Wave D:审计、重放与 controller

- 建 event ↔ ledger assertion helper;
- 覆盖 JSONL lastError、high-water、重启和损坏输入;
- 补 controller queue、event forwarding、dispose 和 hot update;
- 建 live/replay 等价测试,为 Session resume/fork 建立 oracle。

退出条件:同一场景的 live state、events、ledger 和 replay projection 一致;失败时不会伪造“已持久化”。

### Wave E:真实 adapter 与后续 governed runtime

- 对 child process、real fs、lock、PTY 只保留少量真实集成测试;
- 新增 timeout/cancel 的 mock 单元层,避免长真实等待;
- 按 runtime 权威计划逐步增加 Event Store、Workspace lease、Gateway、Artifact、Orchestrator 和 Verifier 的 contract/fault/replay/security 测试;
- 默认套件继续禁止真实 provider 网络调用。

退出条件:单元层证明状态机,集成层只证明 adapter;unsupported sandbox/platform 明确返回 unsupported/deny,不得静默 pass。

## 13. 文件组织与命名

不要求一次性重命名现有测试。新增测试按责任拆分,已有文件在触及相同责任时逐步迁移:

```text
tests/runtime/
├── agent-lifecycle.test.ts
├── agent-events.test.ts
├── agent-queue-thinking.test.ts
├── agent-loop-protocol.test.ts
├── agent-loop-errors.test.ts
├── agent-loop-hooks.test.ts
├── agent-message-conversion.test.ts
├── agent-interrupt.test.ts
├── tool-pipeline.test.ts
├── tool-concurrency.test.ts
├── tool-events-authorization.test.ts
├── tool-result-budget.test.ts
├── agent-ledger-audit.test.ts
├── agent-ledger-faults.test.ts
├── interactive-session-controller.test.ts
└── helpers/
```

测试名称使用“触发条件 + 状态转换 + 可观察结果”,例如:

```text
stream start 后 interrupt → assistant aborted 且 agent 回到 idle
parallel-safe batch → 两个 execute 同时进入且 result 保持 toolCall 关联
schema invalid → before hook/execute 均不调用并写 isError audit
deadline-1 不重试,deadline 时只发起一次 retry
```

避免使用 `works`、`handles error`、`test agent` 这类无法说明状态边界的名称。

## 14. 验证命令与完成定义

开发单个测试切片时先跑精确文件,再跑全量门禁:

```bash
npx vitest run tests/runtime/agent-queue-thinking.test.ts --reporter=verbose
npm run check
npm test
git diff --check
```

若修改了编译输出、CLI bin 或发布边界,再运行 `npm run build`;若修改 provider/model catalog,按仓库规则额外运行 `npm run generate-models` 并审阅生成物。测试命令必须保留完整输出。

Agent Runtime 测试指导方案的完成定义:

- 8.2 的每条核心不变量至少有一个直接测试;
- 9.1–9.5 中所有“新增/补强”项已实现或在权威计划中明确延期理由;
- 10.1 的契约点没有“注释承诺一种行为、测试固化另一种行为”的漂移;
- deadline/backoff/debounce 使用虚拟时间并断言边界前后;
- ordering/concurrency/cancel 使用 gate/barrier,不使用真实 sleep 猜测;
- core 测试无网络、无 API key、无共享固定路径、无执行顺序依赖;
- success/error/aborted 均能收敛到 terminal audit 与 `inFlight=false`;
- event、ledger、boundary call 和 replay 的关键关联可由 helper 统一验证;
- 测试结束没有遗留 timer、listener、lock、child process 或临时文件;
- `npm run check`、`npm test` 和 `git diff --check` 全部通过。
