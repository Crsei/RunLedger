# `/dump` 命令实施计划（输出组装后的完整系统提示词）

> **状态：** `planned`（仅冻结设计与验收口径，尚未写任何生产代码）
>
> **创建日期：** 2026-09-10
>
> **参考实现：** oh-my-pi `omp 18.1.14` —— 本机安装路径 `~/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent/src/` 下的 `slash-commands/builtin-collaboration.ts`（`dump` 命令）、`session/agent-session.ts`（`formatSessionAsText` / `dumpLlmRequestToTmpDir`）、`session/session-dump-format.ts`（`renderDumpHeader`）。上游仓库对应路径为 `packages/coding-agent/src/<同上>`。
>
> **权威边界：** 本计划拥有 `/dump` 命令本体、只读 domain operation `session.prompt.inspect`、组装结果的运行时捕获点、剪贴板写出 port、侧车 JSON 端口与 headless 对应物。
> 不拥有：Ctrl+T transcript 投影与 exploration 摘要（[24](24-codex-session-display-replication-plan.md) / [26](26-codex-exploration-output-summary-plan.md)）、OpenTUI renderer 与 selection/OSC 52 原语（[17](17-opentui-refactor-plan.md) / [18](18-opentui-streaming-performance-ux-plan.md)）、主题色槽（[27](27-configurable-ui-theme-and-thinking-color-plan.md)）、slash 命令注册表与输入期 popup 链路（[20](20-codex-slash-command-adaptation-plan.md)）、resident Host 路径（[runtime 06](../runtime/06-session-owner-runtime-replacement-plan.md)）、各 provider 的 wire 工具 schema 编码（`src/api/**`）。

## 0. 执行结论

omp 的 `/dump` 是「把当前 provider 面请求快照原样交出来」：文本（系统提示词 + 配置 + 工具清单 + 转录）进剪贴板，同一个请求的另一份以 JSON 落 `os.tmpdir()`。RunLedger 不能照抄的地方只有一处，但它是核心：**omp 的 `agent.state.systemPrompt` 是常驻可读状态，RunLedger 组装后的提示词只活在一个 turn 的局部变量里**。

事实（源码核对见 §2）：

1. 最终 provider 面提示词只在 `src/runtime/agent-loop/loop-runner.ts:202-211` 的 `llmContext` 局部变量中出现一次，随后传给 trace recorder 与 `streamFn`；默认 `recording.mode="events"` 时 trace 只落 digest（`src/storage/settings-manager.ts:114-117`、`src/runtime/trace/recorder.ts:484-495`）。
2. 可读的候选全部是 assembler **之前**的基座：`InteractiveSessionController.systemPrompt`（`src/runtime/interactive-session-controller.ts:217`，private）、`Agent.state.systemPrompt`（assembler 前）、`HarnessCompositionReceipt`（只有 digest）。
3. TUI 侧既无提示词、也无剪贴板 port、也无文件写能力；`SessionInteractiveSnapshot`（`src/cli/session-interactive-controller.ts:38-51`）只带 `messages/selection/toolCount/harnessToolNames`。
4. `update` 记录：`harness.composed` 事件只存 receipt（digest + 工具名），**不能重建文本**。

因此本计划的最小完整链路是四段：

```
controller 捕获每 turn 装配结果  →  只读 domain operation session.prompt.inspect
        →  TUI /dump（overlay + 剪贴板 + 侧车 JSON）  →  headless runledger dump
```

## 1. omp `/dump` 参考剖析

### 1.1 命令契约

`dump` 是内置命令（`builtin-collaboration.ts`），TUI 与 headless 共用同一个 `handle`：

- `handle`（headless/ACP）：`session.formatSessionAsText()` → 空则回 `No messages to dump yet.`；否则尝试 `session.dumpLlmRequestToTmpDir()`，把路径追加到文本末尾，作为 `command_output` 返回。
- `handleTui`：同一份文本 `copyToClipboard(doc)`，再 `showStatus("Session copied to clipboard" + "LLM request JSON: <path>")`。
- 无参数、无门控、无 session 副作用（不追加任何持久化 entry）。

### 1.2 数据来源

| 片段 | 来源 | 形态 |
|---|---|---|
| 系统提示词 | `formatSessionDumpText({ systemPrompt: agent.state.systemPrompt })` | `## System Prompt` + `### System Prompt N` 逐块（`session-dump-format.ts` `renderDumpHeader`） |
| 配置 | 同一 header | `## Configuration`：`Model: provider/id`、`Thinking Level: …` |
| 工具 | `renderToolInventory` | 文本清单（name/description/参数） |
| 转录 | `appendMarkdownTranscript` | `## User` / `## Assistant` / `### Tool Call` / `### Tool Result` |
| 侧车 JSON | `dumpLlmRequestToTmpDir()` | `{ model, thinkingLevel, serviceTier, systemPrompt, tools[wire schema], messages[convertToLlm 之后] }` → `/tmp/omp-llm-request-<snowflake>.json` |

关键性质：文本与侧车来自**同一份已组装的 provider 上下文**，不是渲染层重建；侧车写失败不阻断文本输出（best-effort）。

### 1.3 可借鉴 / 不照搬

| 项 | 决定 | 理由 |
|---|---|---|
| 「文本 + JSON 侧车」双输出 | 照搬 | 与人读、与机器审计两种用途正交 |
| 文本含转录 | **不照搬** | RunLedger 的 TUI 转录是有界安全投影（`presentationTruncated`、exec 200 行上限），provider 面精确转录需要独立渲染器；见 §6 |
| provider wire 工具 schema | **不照搬** | RunLedger 无统一入口，需按 `model.api` 分派 6 个 `convertTools`；本期输出 runtime 形态 `{name,description,parameters}` |
| 输出到剪贴板 | 照搬（能力受限） | 见 D8：OSC 52「已写出」≠ 系统剪贴板已更新，文案必须诚实 |
| 落盘目录 | 换成本仓约定 | `os.tmpdir()` → `RunledgerLayout.tmp`（`src/runtime/contracts/storage-layout.ts:59-83`） |

## 2. RunLedger 现状与差距

| 能力 | omp | RunLedger 现状 | 缺口 |
|---|---|---|---|
| 组装后系统提示词 | `agent.state.systemPrompt` 常驻可读 | 只存在于 `loop-runner.ts:202-211` 局部变量 | **无读取点**（本计划 P0/P1） |
| 组装时机 | 生成时即最终 | assembler 每 turn 追加 `session-effective-permissions` / `skill-catalog` 等 fragment 后 `\n\n` join（`src/runtime/context/model-request-adapter.ts:82-84`） | 需要捕获「某一次真实装配」而不是预测 |
| TUI 可达性 | 同进程 | Session Owner 经 TCP；`domainSnapshot()`（`src/runtime/session-runtime/session-runtime.ts:412-427`）不含提示词 | 需要新只读 operation |
| 命令注册 | 内置表 | `src/tui/commands/registry.ts:28-60` `SlashCommandActionType` + `:138` `builtinCommandDescriptors()` | 新增 `ui.dump`（P2） |
| 多行输出 | 剪贴板 | `showNotice` 支持 `\n` 但语义是单行告警；多行正文只有 `SecondarySelectionView.detailLines`（24 列/4 行分页，不可用）与 `TranscriptOverlayComponent`（j/k/PgUp/PgDn，可复用） | 复用 pager + 加标题参数（P2） |
| 剪贴板 | `copyToClipboard` | 唯一实现是 `src/tui/opentui/component-runtime/index.ts:154-158` 的 selection → `renderer.copyToClipboardOSC52`，未上抛、返回值被丢弃 | 新增 `copyText` 通道（P3） |
| 文件写 | `os.tmpdir()` JSON | TUI 无 fs；CLI 组合层注入端口的范式是 `src/cli/tui-preferences.ts:17-30` + `src/storage/tui-preferences.ts:34-66` 原子写 | 新增 `PromptDumpPort`（P4） |
| headless | `handle` 共用 | `runControlCommand` + `writeControlResult`（`src/cli/main.ts:624/666`）+ `ControlGroup` 词表（`src/cli/control-commands.ts:12`） | 新增 `dump` 组（P5） |
| 持久化 | 无 | `harness.composed` 只有 digest；trace 默认 `digest_only` | 本计划**不新增持久化 authority**（D6） |

## 3. 冻结设计决策

**D1 —— 语义：报告最近一次真实装配，而不是「下一次会发什么」。**
operation 返回 `{ systemPrompt, tools, source, turn?, capturedAtMs?, assembledPromptDigest }`。`source: "assembled"` 表示来自真实 turn；尚未发生 turn 时 `source: "base"` 并回退基座提示词（`controller.systemPrompt`）。理由：`prepareNextTurn` 在生产中无人使用，但权限 fragment 会随 security revision 变化，预测会撒谎；报告事实不会。

**D2 —— 捕获点在 `InteractiveSessionController`，包裹 `modelContextAssembler`。**
两条 live 路径（embedded Session Owner 与 resident Host）都经 `InteractiveSessionController.create` / `ensureAgent`（`src/runtime/interactive-session-controller.ts:504-563`），是唯一共享收口。捕获在 wrapper 内完成，不改变 assembler 语义、不新增事件、不落盘。

**D3 —— 传输用只读 domain operation `session.prompt.inspect`，不新增 query kind。**
复用现成四件套：router manifest 协商（`domain-router.ts:84-108` → `session-runtime.ts:370-385`）、`requiredOperation` 门控（`registry.ts:339-341`）、typed adapter（`src/tui/adapters/session-domain.ts:43`）、headless（`runControlCommand`）。新增 query kind 还要改 `runtime-server.ts:815` 的 kind→operation 映射与 core manifest，收益为零。

**D4 —— 工具只输出 runtime 形态。** `{ name, description, parameters }`，与 `model-request-adapter.ts:62` 的 `toolDefinitions` 投影同形。provider wire 形态列入 §6 deferred。

**D5 —— 单帧上限 fail closed，不静默截断。** 传输上限 `SESSION_PROTOCOL_BOUNDS.maxFrameBytes = 256 KiB`（`src/runtime/session-server/protocol.ts:110-126`）。operation 自检 `SESSION_PROMPT_INSPECTION_MAX_BYTES = 192 * 1024`，超限返回 `{ ok: false, code: "prompt_inspect_too_large", bytes, limit }`；`/dump` 报错并给出字节数。截断一份号称「完整」的提示词是更坏的失败。

**D6 —— 只读。** 不 append ledger/session 事件、不建 attempt、不碰 security revision、不要求 driver。旁证：`/dump` 在 observer 连接上也应可用。

**D7 —— 写盘在 CLI 组合层。** TUI 不持有 layout/fs（`interactive-mode.ts:148-152` 的既有边界）。`createCliPromptDumpPort(layout)` 注入 `InteractiveModeOptions`，与 `preferencesPort` 同构；`/dump` 只调端口。

**D8 —— 输出通道三件套，且文案诚实。** ① pager overlay（复用 `TranscriptOverlayComponent`，新增 `title` 选项）；② OSC 52 剪贴板，成功文案为「已写出 OSC 52 序列」，并提示终端可能不支持；③ 侧车 JSON 路径 + 原始字节数。转录不在本期输出（§6）。

## 4. 实施步骤

### P0 运行时捕获点

**目标：** 组装结果在 runtime 侧可读，且不改变现有装配语义。

**改动文件**

- `src/runtime/types.ts`：新增 DTO

```ts
/** provider 面工具描述（runtime 形态）。 */
export interface PromptInspectionTool {
  readonly name: string;
  readonly description: string;
  readonly parameters: unknown;
}

/** 最近一次真实模型请求的 provider 面投影。 */
export interface PromptInspection {
  readonly systemPrompt: string;
  readonly tools: readonly PromptInspectionTool[];
  /** assembled = 来自真实 turn 的 assembler 输出；base = 尚未发生 turn，回退基座提示词。 */
  readonly source: "assembled" | "base";
  readonly turn?: number;
  readonly capturedAtMs?: number;
  readonly assembledPromptDigest: RuntimeDigest;
}
```

- `src/runtime/interactive-session-controller.ts`：
  - 私有字段 `private providerInspection: PromptInspection | undefined;`
  - `ensureAgent()` 中构造 `loopConfig` 前包裹 assembler（局部变量，不改 `this.modelContextAssembler` 的 readonly 语义）：

```ts
const assembler = this.modelContextAssembler;
const wrappedAssembler: ModelContextAssembler | undefined = assembler === undefined
  ? undefined
  : async (input) => {
      const assembled = await assembler(input);
      this.providerInspection = {
        systemPrompt: assembled.context.systemPrompt ?? this.systemPrompt,
        tools: (assembled.context.tools ?? []).map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters })),
        source: "assembled",
        turn: input.turn,
        capturedAtMs: Date.now(),
        assembledPromptDigest: runtimeDigest(assembled.context.systemPrompt ?? ""),
      };
      return assembled;
    };
```

  注意：`modelContextAssembler` 可能为 `undefined`（低层 fixture / 测试），此时捕获点不存在，`providerInspection` 保持 `undefined`。
  - 公开 getter：

```ts
/** 无真实 turn 时回退基座提示词；调用方据 source 字段区分。 */
public get promptInspection(): PromptInspection {
  if (this.providerInspection !== undefined) return this.providerInspection;
  return {
    systemPrompt: this.systemPrompt,
    tools: this.tools.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters })),
    source: "base",
    assembledPromptDigest: runtimeDigest(this.systemPrompt),
  };
}
```

**验证：** `tests/runtime/interactive-session-controller.test.ts`（按现有 controller 测试文件落位）新增两条：① 传入 stub assembler 跑一个 turn 后 `promptInspection.source === "assembled"` 且 `turn === 1`、`systemPrompt` 等于 stub 输出；② 未装配时 `source === "base"` 且 `tools` 与 `opts.tools` 同序同名。`npm run check`。

### P1 只读 domain operation `session.prompt.inspect`

**目标：** 组装结果可经 Session Owner 的既有只读通道取出，含大小护栏。

**改动文件**

- `src/runtime/session-runtime/domain-router.ts`：
  - 新增常量 `export const SESSION_PROMPT_INSPECTION_MAX_BYTES = 192 * 1024;`（注释写明 framed under `SESSION_PROTOCOL_BOUNDS.maxFrameBytes`）。
  - `SessionDomainRouterOptions` 增加 `readonly promptInspection?: () => PromptInspection;`
  - `operationManifest`（`:94-108`）追加条件项：`{ operation: "session.prompt.inspect", capability: "session.prompt.inspect", access: "read" }`（`promptInspection === undefined` 时不登记）。
  - `query()` 增加分支（与 `session.security.inspect` / `plan.inspect` 同形）：

```ts
if (operation === "session.prompt.inspect" && this.promptInspection !== undefined) {
  const value = this.promptInspection();
  const bytes = Buffer.byteLength(JSON.stringify(value), "utf8");
  if (bytes > SESSION_PROMPT_INSPECTION_MAX_BYTES) {
    return { ok: false, status: "failed", code: "prompt_inspect_too_large", operation };
  }
  return { ok: true, status: "ok", operation, domainRevision: this.generation, value };
}
```

- `src/runtime/session-runtime/domain.ts`：
  - `assembleSessionDomain` 的返回对象增加 `promptInspection: () => controller.promptInspection`（并把它拼进最终 `value` 的 prompt digest 字段：`basePromptDigest: finalComposition.promptDigest`、`compositionDigest: finalComposition.compositionDigest`）。
  - 若 DTO 需要 `promptDigest/compositionDigest`，在 domain 层补齐（`finalComposition` 在 `:392-396` 已在作用域内）。
- `src/runtime/session-runtime/session-runtime.ts`：`new SessionDomainRouter(...)` 选项传入 `...(options.domain?.promptInspection === undefined ? {} : { promptInspection: options.domain.promptInspection })`，与 `securityInspection`/`planInspection` 完全同构。

**验证：** `tests/runtime/session-runtime/domain-router.test.ts` 新增：① manifest 含 `session.prompt.inspect`/`read`；② 未注入 `promptInspection` 时返回 `operation_unavailable`；③ 超限返回 `prompt_inspect_too_large`；④ stale generation 仍返回 `generation_mismatch`。`npm run check`。

### P2 TUI `/dump`

**目标：** `/dump` 在 TUI 中取出、渲染、复制并落盘，全链路只读。

**改动文件**

- `src/tui/commands/registry.ts`：
  - `SlashCommandActionType` 增加 `"ui.dump"`。
  - `builtinCommandDescriptors()` 末尾（`scrollbar` 的 order 27 之后）新增：

```ts
command("dump", "Dump the assembled system prompt", 28, {
  actionType: "ui.dump",
  category: "ui",
  policy: READONLY_POLICY,
  requiredOperation: "session.prompt.inspect",
  unavailableHint: "Use /trajectory to inspect recorded runtime events.",
}),
```

  `supportsInlineArgs: false`、`availableDuringTask` 默认 `true`：turn 进行中读到的就是本次请求实际使用的提示词，拒绝反而更不诚实。
- `src/tui/interactive-mode.ts`：
  - `dispatchCommand`（`:1143`，无 `default`，漏加会被 TS 抓）增加 `case "ui.dump": void this.promptDumpWorkflow.run(arg); return;`
  - 新增 workflow 字段（与 `planWorkflow` / `extensionWorkflow` 同处装配），并把 `promptDumpPort` 从 `InteractiveModeOptions` 透传给 `InteractiveModePorts`。
- `src/tui/interactive/prompt-dump-workflow.ts`（新增）：

```ts
export class PromptDumpWorkflow {
  public constructor(private readonly port: InteractiveModePorts) {}

  public async run(arg: string): Promise<void> {
    if (arg.trim().length > 0) { this.port.showNotice("Usage: /dump", "error"); return; }
    const context = { correlationId: `corr-${this.port.nextCorrelationId()}`, effectId: `effect-${this.port.nextEffectId()}` };
    const result = await querySessionController(this.port.controller, "session.prompt.inspect", {}, context).catch(() => undefined);
    if (result === undefined) { this.port.showNotice("/dump failed: session query rejected", "error"); return; }
    if (!result.ok) {
      this.port.showNotice(result.code === "operation_unavailable"
        ? unavailableCommandMessage("/dump")
        : `/dump failed: ${result.code}${result.code === "prompt_inspect_too_large" ? " (prompt exceeds the single-frame budget)" : ""}`, "error");
      return;
    }
    const text = renderPromptDumpText(result.value, this.port);
    this.port.showOverlayModal(makePromptDumpOverlay(text, this.port), { anchor: "center", variant: "transcript" }, "prompt-dump");
    const copied = this.port.writeClipboard?.(text) ?? false;
    const written = await this.port.promptDumpPort?.write(buildPromptDumpDocument(result.value, this.port)).catch(() => undefined);
    this.port.showNotice([
      `/dump: ${result.value.source === "assembled" ? `assembled @ turn ${result.value.turn}` : "base prompt (no turn yet)"} · ${formatByteCount(text.length)}`,
      copied ? "Clipboard: OSC 52 sequence written (terminal support varies)." : "Clipboard: unavailable in this terminal; use the overlay or the JSON path.",
      written?.ok === true ? `JSON: ${written.path}` : "JSON: not written.",
    ].join("\n"), "note");
  }
}
```

  - `renderPromptDumpText(value, port): string` —— 纯函数，输出 `## System Prompt` / `## Configuration`（Harness、provider/model、thinking、prompt 来源与 turn、digest 前缀）/ `## Tools`（`- name — description`，空描述省略）。控制字符按 `plan-workflow.ts:66` 的既有清理口径处理；不展开工具 `parameters`（进 JSON）。
  - overlay 复用：`TranscriptOverlayComponent` 接受合成 view `{ rows: [{ kind: "text", content: text }], timelineGeneration: 0, committedRevision: "prompt-dump", activeRevision: "prompt-dump", themeGeneration: 0 }`。
- `src/tui/transcript-view.ts`：`TranscriptOverlayOptions` 增加可选 `title?: string` 与 `closeHint?: string`，`render()` 的 header/footer 用它们替换硬编码的 `Transcript …` / `Read-only transcript · Ctrl+T close`（默认值保持现状，零回归）。
- `src/tui/interactive/types.ts`：`InteractiveModePorts` 增加 `readonly promptDumpPort?: PromptDumpPort;` 与 `writeClipboard?(text: string): boolean;`。

**验证：** `tests/tui/prompt-dump.test.ts`（照 `tests/tui/command-capabilities.test.ts` 的 `withMode` + `notices()` 范式）：① contract controller 声明 `session.prompt.inspect` 时，`/dump` 产生包含 `## System Prompt` 的 notice；② 未声明时给 `unavailableCommandMessage` 文案；③ 带参数给 usage；④ 结果 `code: "prompt_inspect_too_large"` 时给超限文案。`tests/tui/commands/registry.test.ts` 断言新命令无重复名与顺序稳定。

### P3 剪贴板通道

**目标：** 命令层能主动写 OSC 52，并能区分「写出」与「不可用」。

**改动文件**

- `src/tui/opentui/component-runtime/index.ts`：返回体（`:222-233`）增加 `copyText: (text: string): boolean => copySelection(text)`（复用既有 `copySelection`，`renderer.copyToClipboardOSC52` 的返回值仍然不可信，**不**把它当成功依据；`false` 只代表文本为空或运行时缺失）。
- `src/tui/opentui/component-runtime/types.ts`：`OpenTuiComponentRuntime` 增加 `copyText(text: string): boolean;`。
- `src/tui/primitives.ts`：`TUI` 增加 `public writeClipboard(text: string): boolean`，转发到 runtime；非 `ProcessTerminal`/demo 注入场景返回 `false`，不抛错。

**验证：** `tests/tui/opentui-component-runtime.bun.test.ts` 增加一条：`copyText("x")` 触发 `renderer.copyToClipboardOSC52`（`spyOn(...).mockReturnValue(true)` 既有范式），空字符串返回 `false` 且不触发。

### P4 侧车 JSON（CLI 组合层注入端口）

**目标：** 与文本同源的 JSON 落盘，路径可控、权限合规、失败不阻断。

**改动文件**

- `src/tui/interactive/types.ts`：新增

```ts
export interface PromptDumpDocument {
  readonly schemaVersion: 1;
  readonly kind: "runledger.prompt-dump";
  readonly sessionId: string;
  readonly harnessProfile?: { readonly id: string; readonly version: number };
  readonly permissionProfile?: string;
  readonly selection: { readonly provider?: string; readonly model?: string; readonly thinkingLevel: string };
  readonly prompt: PromptInspection & { readonly basePromptDigest?: RuntimeDigest; readonly compositionDigest?: RuntimeDigest };
}
export interface PromptDumpPort {
  write(doc: PromptDumpDocument): Promise<{ ok: true; path: string } | { ok: false; code: string }>;
}
```

- `src/cli/prompt-dump-artifacts.ts`（新增）：`createCliPromptDumpPort(layout: RunledgerLayout): PromptDumpPort`
  - 目标 `join(layout.tmp, "dump", `prompt-dump-${sessionId}-${Date.now()}.json`)`；`mkdir 0700` → 拒 symlink → 包含性检查（`isContainedRuntimePath`）→ `wx` + `0600` 写临时文件 → `rename` → `chmod 0600`，与 `src/storage/tui-preferences.ts:34-66` 同序（lockfile 可选：单写者、文件名含时间戳，冲突概率为零，本期不加锁）。
  - 失败以 `{ ok: false, code }` 返回，不抛错（仓库约定）。
- `src/cli/main.ts`：`new InteractiveMode({...})`（`:394-416`）传入 `promptDumpPort: createCliPromptDumpPort(layout)`。

**契约（JSON 形态，冻结）**

```jsonc
{
  "schemaVersion": 1,
  "kind": "runledger.prompt-dump",
  "sessionId": "sess_…",
  "harnessProfile": { "id": "standard", "version": 1 },
  "permissionProfile": "default",
  "selection": { "provider": "anthropic", "model": "claude-…", "thinkingLevel": "high" },
  "prompt": {
    "source": "assembled",
    "turn": 7,
    "capturedAtMs": 1757499999000,
    "assembledPromptDigest": { "algorithm": "sha256", "digest": "…" },
    "basePromptDigest": { "algorithm": "sha256", "digest": "…" },
    "compositionDigest": { "algorithm": "sha256", "digest": "…" },
    "systemPrompt": "…完整文本…",
    "tools": [{ "name": "read", "description": "…", "parameters": { "type": "object", "properties": {} } }]
  }
}
```

与 `docs/system-prompts.json`（`schemaVersion: 2`）**不共用**：那份记录的是 legacy Host / 本地 HTTP 端点的手工抓取，字段语义（`capture`/`redactions`/`findings`）不同；本计划只在自己的 JSON 里给出 source 引用，跨文档关系在 §P6 补一句交叉链接。

**验证：** `tests/cli/prompt-dump-artifacts.test.ts`：① 写入成功返回 0600 文件、目录 0700、内容可 `JSON.parse`；② `layout.tmp` 存在 symlink 时返回 `{ ok: false }` 而非跟随。`npm run check`。

### P5 headless `runledger dump`

**目标：** 同一个数据源在非交互路径可用，并给自动门禁提供端到端证据。

**改动文件**

- `src/cli/control-commands.ts`：`ControlGroup`（`:12`）增加 `"dump"`；`GROUPS`/`DEFAULT_ACTIONS.dump = "inspect"`/`ACTIONS.dump = ["inspect"]`；`controlCommandRequest`（`:152`）映射 `dump.inspect → { operation: "session.prompt.inspect", body: {}, mutation: false }`；`controlCommandQueryOperation`（`:248`）同值；`controlCommandHelp` 增行。
- `src/cli/main.ts`：无需新分支——`runControlCommand`（`:624`）已按 mutation=false 走 `controller.querySessionDomain`，`writeControlResult`（`:666`）打一行 JSON，`!ok → exitCode 1`。
- `docs/cli.md`：控制子命令表（`:113-117` 一带）增 `dump [inspect]` 行。

**验证：** `tests/cli/control-command-execution.test.ts` 增加一条真实 spawn 用例（沿用该文件的 `fixture()` + 隔离 `RUNLEDGER_DIR`/`HOME`）：新建 session 后执行 `runledger dump`，断言 stdout JSON `prompt.systemPrompt` 非空、`prompt.source ∈ {"base","assembled"}`、退出码 0。

### P6 文档与索引同步

- `development-doc/tui/00-overview.md`：§4 文档表增 `28-system-prompt-dump-plan.md` 行；表前的「只以 Plan NN 为权威」段落补一段（列出本计划拥有的范围与不替换的 authority）；文末阅读顺序段补指路。
- `development-doc/00-index.md`：模块导航表增 `TUI / System Prompt Dump` 行；文末 `## 目录结构` 的 `└── tui/` 段补文件名（该树目前止于 `26-…` 且漏列 `27-…`，一并补全，属索引维护而非范围扩张）。
- `docs/cli.md` + `docs/README.md`：控制子命令表加 `dump`，与源码同源。
- `docs/system-prompts.md`：开头加一句「活会话的实时获取用 `/dump` 或 `runledger dump`；本页保留 legacy 端点的抓取方法」。

## 5. 回归清单（P2 完成时逐条过）

- 注册表：`/commands` 弹窗新增 `/dump`，不改变既有 30 条的顺序、别名与 `requiredOperation`。
- 既有命令逐条不受影响：`/clear`、`/theme`、`/scrollbar`、`/hide-thinking`、`/trajectory`、`/compact`、`/memory`、`/remember`、`/plan`、`/permissions`、`/resume`、`/quit`。
- Ctrl+T transcript overlay 的 header/footer 文案与键位不变（`title`/`closeHint` 默认值兜底）。
- 鼠标选区复制与 Ctrl+C 复制路径不变（`copyText` 是新增出口，不接管既有 selection 事件）。
- `session.prompt.inspect` 未声明时 `/dump` 走 `unavailableCommandMessage`，不 panic、不抛错。
- 无 model / 刚创建 session 时 `/dump` 返回 `source: "base"`，不报错。
- turn 进行中执行 `/dump` 不打断 turn（只读查询）。
- 侧车写失败（只读 FS / 权限不足）时文本与剪贴板仍可用。

## 6. 不做 / deferred

| 项 | 状态 | 理由 |
|---|---|---|
| 转录文本（omp 的 `## User` / `### Tool Call` 段） | deferred | TUI 转录是有界安全投影（`sourceTruncated`/`presentationTruncated`、exec 200 行），做成「完整」会撒谎；provider 面精确转录需 `defaultConvertToLlm` + 独立渲染器，属独立专题 |
| provider wire 工具 schema | deferred | 需按 `model.api` 分派 6 个 `convertTools`（`src/api/**`）；本期 runtime 形态已足够审计 |
| legacy resident Host 路径（`src/cli/runtime-host.ts`）的 `/dump` 暴露 | deferred | 该路径不写 `harness.composed`、不经 harness composition；其移除由 [runtime 06](../runtime/06-session-owner-runtime-replacement-plan.md) 拥有 |
| 超大提示词的分块/分页读取 | deferred | D5 先 fail closed；>192 KiB 的提示词若出现，走独立设计 |
| 侧车自动清理 / 保留 N 份 | deferred | `layout.tmp` 今天没有 TTL/GC；文件路径明确回报给用户，先不引入删除语义 |
| 脱敏（AGENTS.md 正文替换为 digest） | deferred | `/dump` 的目的就是看原文；`docs/system-prompts.json` 的 `redactions[]` 口径属分享/导出场景 |
| `/dump --copy-only` / `--json-only` 等参数 | deferred | 无证据表明需要；`supportsInlineArgs` 保持 false |
| HTML 导出 | 不做 | 与本计划正交，仓库无既有实现可复用 |

## 7. 门禁

- 每阶段：`npm run check`（完整输出，不截断）全绿；相关 `npm test` 全绿。
- 进入 `dist/` 后：`npm run build` + 标准 PATH 隔离 `RUNLEDGER_DIR` 的真实 `runledger` 验证。
- P2/P4 合并节点：隔离 `RUNLEDGER_DIR` 的临时目录内，真实 TTY（tmux 独立会话）执行 `/dump`，确认：overlay 可 j/k/PgUp/PgDn 翻阅、Esc 关闭、notice 报出 `source` 与 JSON 路径、退出用 Ctrl+D 干净退出。
- P5 节点：`tests/cli/control-command-execution.test.ts` 的真实 spawn 用例。
- 证据口径：自动化 / 构建后 CLI / 真实 TTY / 人工视觉 / 跨平台是不同证据；PTY 或 tmux 捕获通过不等于 human-verified。

## 8. 实现记录与证据

（待实现后按阶段回填：日期、commit、命令、证据路径、以及未关闭的门禁。）
