# 21 · Mermaid 图表终端渲染完整实现计划

> 状态：**M0–M7 自动门禁与标准 PATH smoke 已完成；R1 人工视觉验收待维护者确认**
>
> 记录日期：2026-08-12
>
> RunLedger 基线：`session-owner-runtime@255d07c229bfe76b69c4ffe3d6240b2a03507234`
>
> 参考基线：`grok-build/main@c68e39f60462f28d9be5e683d9cbe2c57b1a5027`
>
> 实施入口：先完成 R1 Unicode 内联渲染；R2 PNG/外部查看器必须通过独立 ADR 与跨平台安全门，不能阻塞 R1。

### 当前 M7 复核快照

- 工作树：`RunLedger-tui-mermaid`；分支：`worktree/tui-mermaid-diagram-rendering`。
- 当前 `HEAD`：`3742be4f7e55c372905a64acf36be6df21b7b255`；M3–M7 实现仍是未提交工作树变更，未提交、未推送。
- M0–M6 的纯函数、OpenTUI native、缓存/预算与 adversarial 证据已具备；M7 负责全量门禁、标准 PATH smoke 和文档状态回写。
- 2026-08-12 review 修复已闭合：无空格/链式 flowchart edge、class 八成员展示、class/ER 端点语义/cardinality/association 方向、dotted/thick glyph、sequence source order/block scope/else-option 分支、独立 state start/end、后创建 Mermaid block 的主题继承，以及 128-node/512-edge near-limit 同步预算。
- R1 尚不能标记为最终完成：license formal review、人工 dark/light、鼠标选择/复制和真实终端 resize 的视觉验收仍待维护者确认。自动化测试与标准 PATH smoke 不替代这些人工门禁。

## 0. 结论先行

`grok-build` 的 Mermaid 能力可以应用到 RunLedger TUI，但不能把
`crates/codegen/xai-grok-mermaid` 原样接到 OpenTUI 后就宣称完成。
参考实现实际上有两套不同能力：

1. `xai-grok-markdown/src/mermaid.rs` 是面向终端的 Unicode 图表 parser、layout、routing 与 canvas renderer；
2. `xai-grok-mermaid/` 是 Mermaid source → SVG → PNG 的 raster engine，pager 只在用户点击后异步生成图片并交给外部查看器，未在终端中内联 PNG。

RunLedger 应分两层交付：

| 层级 | 结果 | 本计划结论 |
|---|---|---|
| R1：Unicode inline | 在 `language=mermaid` 的 fenced block 原位显示可选择、可复制的 Unicode 图；失败时完整回退到原源码 | **必做，当前 OpenTUI 0.4.5 已有正式接缝，可直接实施** |
| R2：PNG artifact | 生成高质量 PNG，提供 `[Open Image]` / `[Save Image]` / `[Copy Source]` | **条件性专项；必须由 Session Runtime 与 ExecutionGateway 治理，不得由 TUI 直接 spawn 或暴露本机路径** |

完成 R1 就能解决“模型输出 Mermaid 但 TUI 只显示源码”的核心体验问题。R2 是增强能力，不是 R1 的依赖，也不是 R1 的完成条件。

---

## 1. 文档权威与基线

### 1.1 专项权威边界

本计划只拥有 Mermaid 展示专项，不替换既有文档：

| 领域 | 权威文档 | Plan 21 的边界 |
|---|---|---|
| OpenTUI renderer、生命周期、native frame | [`17-opentui-refactor-plan.md`](17-opentui-refactor-plan.md) | 只通过既有 `MarkdownRenderable` 接缝增加 fenced-code renderer |
| 流式、缓存、长会话、viewport、背压 | [`18-opentui-streaming-performance-ux-plan.md`](18-opentui-streaming-performance-ux-plan.md) | 复用其 scheduler、窗口化和可重建缓存原则，不创建第二套全局调度器 |
| application state、reducer、EffectRunner、Runtime authority | [`19-passive-contract-integration-plan.md`](19-passive-contract-integration-plan.md) | R1 是纯 projection；R2 用户动作必须进入既有 action/effect/port 链 |
| slash command registry 与派发 | [`20-codex-slash-command-adaptation-plan.md`](20-codex-slash-command-adaptation-plan.md) | 不新增 Mermaid slash-command 平行入口 |
| Session Owner、attachment、recovery、managed process | [`../runtime/06-session-owner-runtime-replacement-plan.md`](../runtime/06-session-owner-runtime-replacement-plan.md) | R2 sidecar 的 owner、fencing、终止与恢复必须回写 Runtime 06 |
| ExecutionGateway、Permission、平台 process adapter | [`../worktree-sandbox-permisson/00-worktree-sandbox-permission-plan.md`](../worktree-sandbox-permisson/00-worktree-sandbox-permission-plan.md) | R2 helper/open/save 全部受其约束；本计划不授予 raw process/fs 权限 |
| Trace 与 Artifact Store | [`../runtime/trace/README.md`](../runtime/trace/README.md) | PNG 默认是可删除 cache，不因渲染自动升级为审计 artifact |

冲突时以上游领域文档和当前代码为准。Plan 21 不得借 Mermaid 展示需求绕过尚未闭合的 Runtime R6/R8、跨平台或安全门禁。

### 1.2 当前 HEAD 与未提交工作树

记录本计划时：

- 当前分支：`session-owner-runtime`；
- 当前 HEAD：`255d07c229bfe76b69c4ffe3d6240b2a03507234`；
- `@opentui/core`：`0.4.5`；
- `string-width`：`7.2.0`；
- RunLedger package license：MIT；
- 下列文件已有其他任务的未提交修改，本专项必须保留且不得暂存：
  - `AGENTS.md`
  - `development-doc/worktree-sandbox-permisson/00-worktree-sandbox-permission-plan.md`
  - `src/cli/embedded-session-runtime.ts`
  - `src/cli/main.ts`
  - `src/storage/session-store/session-store.ts`
  - `tests/cli/session-owner-cli.test.ts`
  - `tests/cli/session-owner-lifecycle.test.ts`
  - `tests/storage/session-store/session-store.test.ts`

本节只是 2026-08-11 的 planning snapshot。实施前必须重新执行 `git status --short`、`git branch --show-current` 与 `git rev-parse HEAD`，不能把本节当作未来 worktree 事实。

### 1.3 当前生产接缝

当前标准链路为：

```text
bin/runledger.js
  -> src/cli/main.ts
  -> InteractiveSessionController
  -> src/tui/interactive-mode.ts
  -> src/tui/opentui/component-runtime.ts
  -> @opentui/core MarkdownRenderable
```

`src/tui/opentui/component-runtime.ts` 当前在创建 `MarkdownRenderable` 时只传入
`content`、`streaming` 与 `syntaxStyle`，没有传入 `renderNode`。因此
`language=mermaid` 的 fenced block 只按普通代码显示。

OpenTUI 0.4.5 已提供：

- `createMarkdownCodeBlockRenderer(...)`：按规范化后的 fenced language 替换特定 code block；
- `MarkdownOptions.renderNode`：自定义 token renderer；
- `Renderable.onSizeChange`：组件真实尺寸变化接缝；
- `@opentui/core/testing#createTestRenderer()`：native in-memory renderer 测试。

这说明 R1 不需要 fork OpenTUI、不需要替换 Markdown parser，也不需要引入 React/Solid。

---

## 2. 参考实现审计

### 2.1 两套能力不能混称

| 能力 | 参考文件 | 真实行为 | RunLedger 取舍 |
|---|---|---|---|
| 终端 Unicode 图 | `crates/codegen/xai-grok-markdown/src/mermaid.rs`（5237 行） | 自包含 parser、布局、连线路由、宽字符 canvas；支持 flowchart/state/class/ER/sequence；不支持时画源码 fallback box | 受控移植为 TypeScript，适配 OpenTUI styled text/renderable |
| Mermaid → SVG | `crates/codegen/xai-grok-mermaid/src/{pure,engine}.rs` + vendored `mermaid-to-svg` | 纯 Rust engine，应用 source limit、parse/layout error taxonomy | 只在 R2 评估，不能进入 R1 依赖 |
| SVG → PNG | `crates/codegen/xai-grok-mermaid/src/raster.rs` | `resvg/usvg/tiny-skia` raster；限制像素/轴长；禁用外部 image resolver | R2 sidecar 的安全参考 |
| 异步 worker/cache | `crates/codegen/xai-grok-pager/src/app/mermaid_worker.rs` | 短生命周期子进程、3s timeout、kill/reap、磁盘 cache | 架构原则可复用，但必须走 RunLedger Runtime/ExecutionGateway |
| pager 展示 | `crates/codegen/xai-grok-pager/src/scrollback/blocks/mermaid_content.rs` | finished Markdown 才检测；点击后 Open/Copy path；PNG 不内联终端 | 不复制 `Copy path`，改用 opaque artifact handle |

因此，“参考 `xai-grok-mermaid`”在本项目中应理解为：

- R1 主要参考 `xai-grok-markdown/src/mermaid.rs`；
- R2 才参考 `xai-grok-mermaid` 与 pager worker；
- 不引入 `mermaid` npm package、`mmdc`、Playwright 或 headless Chromium 作为隐式 fallback。

### 2.2 Unicode renderer 可复用的设计

参考实现已有以下成熟策略：

- parser 按 diagram kind 分流，而不是尝试完整实现 Mermaid grammar；
- flowchart 支持 `TD/TB/BT/LR/RL`、常见 node shape、edge/head/label、subgraph；
- state、class、ER、sequence 使用各自严格 parser；
- label 按 display width wrap，而不是按 UTF-16 length；
- layout 先生成语义 graph/sequence IR，再写入二维 canvas；
- canvas 为 glyph/class/mask/style/occupied 的并行数组，不给每个 cell 创建对象；
- node、edge、group、depth、label 与 canvas cells 均有硬上限；
- parser 无法完整理解、超宽或超预算时回退源码，不输出“看起来成功但语义缺失”的图。

参考限制包括：

| 项 | 参考值 |
|---|---:|
| source | 64 KiB（PNG engine） |
| nodes | 128 |
| edges/items | 512 |
| groups | 24 |
| group depth | 6 |
| class/ER members | 8 |
| label max | 28 display columns |
| label wrap | 24 columns × 4 lines |
| Rust canvas | `2^21` cells |

TypeScript/Bun 不能盲抄 Rust canvas 的 `2^21`：JS 运行时、字符串 intern table 与 OpenTUI renderable 同时占用内存。R1 初始上限应降到 524,288 cells，经 benchmark 与 heap evidence 后才能上调。

### 2.3 PNG 管线可复用的安全原则

参考 raster/worker 的关键不是“能生成图片”，而是：

- 对不可信模型输出先做 source-size 拒绝；
- parse/layout/raster 在独立进程运行，panic/abort 不拖垮 TUI；
- 强制 wall-clock timeout，并杀死、回收整个进程组；
- raster 限制总像素、单轴、目标高度与输出字节；
- SVG image resolver 禁止 `file://`、`http://` 与本地路径读取；
- 文件名只含 source hash、theme、quality、width bucket、renderer revision；
- cache 可删除、可重建，不成为行为 authority。

RunLedger 还必须额外满足：

- TUI 目录受 `check:execution-boundaries` 约束，不能 import `node:child_process`；
- helper 启动、OS open 与 save 必须进入 Session Runtime/ExecutionGateway；
- TUI 只收到 artifact handle，不能收到 cache 绝对路径；
- attachment/recovery/fencing 必须遵守 Session Owner 生命周期；
- Windows 没有 Job Object 等价终止证据时保持 `unavailable`。

### 2.4 License 与 attribution

- `xai-grok-markdown`：Apache-2.0；
- `xai-grok-mermaid`：Apache-2.0；
- vendored `mermaid-to-svg`：MIT，并带自己的 third-party notices；
- RunLedger：MIT。

如果从参考实现移植或翻译代码，不能删除原 copyright/license notice，也不能把衍生文件简单重标为 RunLedger MIT。M0 必须先形成 license manifest，并按实际采用方式：

1. 在移植文件保留明确的 Apache-2.0 attribution/SPDX 信息；
2. 在仓库分发物中加入对应 LICENSE/NOTICE/THIRD-PARTY-NOTICES；
3. R2 vendored engine、字体与依赖各自列出来源、版本、license 与修改说明；
4. 构建产物携带 notices，测试 source tar/npm files 不漏掉；
5. 未通过项目维护者的 license review 前，不合并移植代码。

本计划不把“行为相似”自动判断为 clean-room，也不替代正式法律审阅。

---

## 3. 目标、不变量与非目标

### 3.1 R1 用户目标

模型输出闭合的 Mermaid fenced block 后：

- TUI 在原 fenced block 位置显示 Unicode 图；
- 窄终端重新布局或完整回退源码，不横向破坏整个 transcript；
- dark/light theme 下语义色正确；
- Unicode art 可被 OpenTUI selection 选择，并通过现有 OSC 52 链复制；
- 原始 Markdown 仍是 session replay authority；重新打开 session 可确定性重建图；
- parser、layout、cache 失败不影响同一消息其他 Markdown block。

### 3.2 R1 架构不变量

1. **原始 Markdown 是唯一 authority。** 不把 Unicode art 写回 ledger、SessionStore、Trace event 或 `PresentationBlock`。
2. **Mermaid 是可删除 projection。** cache 丢失后必须从 source 重建相同语义结果。
3. **只渲染闭合 fence。** streaming 中开放的 Mermaid fence 继续显示源码；闭合后再原位替换。
4. **完整理解或完整 fallback。** 任何结构性语句无法识别时，整个 block 调用 OpenTUI `context.defaultRender()`；禁止丢语句后继续画图。
5. **同步路径有硬预算。** R1 不启动 worker，不进行 fs/network/process I/O。
6. **不创建第二套 scheduler。** resize 走 `onSizeChange`，更新走现有 frame scheduler。
7. **不改变上游合同。** 不扩展 `PresentationBlock`、AgentEvent、ledger/session schema。
8. **只实例化可见投影。** 长会话窗口化仍由 Plan 18 控制，Mermaid 不在 viewport 外预渲染全历史。

### 3.3 R2 架构不变量

1. TUI 只依赖注入的 `MermaidRasterPort`；TUI 代码不得 import raw fs/process/network。
2. helper 输入只走有界 stdin，不把 source 放入 argv、environment、临时 source 文件或日志。
3. helper 输出必须经过协议版本、build digest、PNG signature、尺寸、字节数与 digest 校验。
4. cache 位于 canonical `RunledgerLayout.cache` 下，不引入 workspace `.runledger` authority。
5. `Open Image` 与 `Save Image` 是显式用户 intent；缺少能力时返回 typed `unavailable`，不做 raw fallback。
6. TUI 不显示或复制 cache path，只持有 owner/session-scoped opaque handle。
7. R2 不改变 recording authority。只有 Trace 专项显式接线时，cache PNG 才可另行登记为审计 artifact。

### 3.4 非目标

- 不完整实现 Mermaid 官方 grammar；
- 不在 R1 支持 gantt、pie、mindmap、timeline、gitGraph、journey、quadrant、requirement、C4；
- 不执行 Mermaid `click`、链接、callback、HTML、JavaScript 或任何交互脚本；
- 不加载 Mermaid theme CSS、远程图片、远程字体或本机文件；
- 不在 OpenTUI 中新建 PNG `ImageRenderable`；当前依赖没有该能力，参考 pager 也未内联 PNG；
- 不新增 `/mermaid` slash command；
- 不因 R2 缺少某个平台证据而降低 R1 的完成状态；
- 不借本专项删除 Legacy Host 或关闭 Runtime 06 的未完成门禁。

---

## 4. R1 目标架构

### 4.1 数据流

```text
authoritative Markdown source
          |
          v
OpenTUI Markdown token (code, language=mermaid)
          |
          +-- fence open / over budget / unsupported ----------+
          |                                                     |
          v                                                     v
strict bounded parser                                     defaultRender()
          |
          v
framework-neutral Mermaid IR
          |
          v
width-bucketed layout + typed-array canvas
          |
          v
semantic styled-line projection
          |
          v
MermaidBlockRenderable -> OpenTUI native frame/selection
```

parser/layout/render 不接触 Session Runtime；OpenTUI adapter 不重新解析 session 数据；default fallback 仍由 OpenTUI 原生 code block renderer 负责。

### 4.2 建议目录

```text
src/tui/mermaid/
  types.ts                         Mermaid kind、IR、result、diagnostic 类型
  limits.ts                        单一资源限制与 render revision
  display-width.ts                 grapheme/display-width/wrap 原语
  fence.ts                         info string 与闭合 fence 判定
  parse.ts                         kind dispatch + strict failure contract
  parser/
    shared.ts                      bounded statement/token helpers
    flowchart.ts                   graph/flowchart + subgraph
    state.ts                       stateDiagram/stateDiagram-v2
    class.ts                       classDiagram
    er.ts                          erDiagram
    sequence.ts                    sequenceDiagram
  layout/
    canvas.ts                      typed-array canvas、glyph intern、line masks
    graph.ts                       rank/order/position/router
    grouped.ts                     subgraph frame 与嵌套布局
    class.ts                       class/ER box section layout
    sequence.ts                    actor lane/message/note/block layout
  render.ts                        IR -> semantic styled lines
  cache.ts                         复用 RenderCache 的 Mermaid bounded wrapper
  index.ts                         仅导出 framework-neutral surface
src/tui/opentui/
  mermaid-code-block-renderer.ts   OpenTUI fenced-code adapter
  mermaid-block-renderable.ts      width/theme/selection projection
tests/tui/mermaid/
  fence.test.ts
  flowchart.test.ts
  state.test.ts
  class.test.ts
  er.test.ts
  sequence.test.ts
  layout.test.ts
  limits.test.ts
  cache.test.ts
  adversarial.test.ts
tests/tui/
  opentui-mermaid.bun.test.ts      native frame/resize/theme/selection/streaming
```

不要把 parser/layout 塞进 `component-runtime.ts`。该文件只负责组装 renderer 与维护 renderable identity。

### 4.3 核心合同

合同使用可擦除 TypeScript、字符串 literal union 与显式 `import type`，禁止 `enum`、`namespace`、参数属性和 `any`。

建议最小 surface：

```ts
export type MermaidDiagramKind =
  | "flowchart"
  | "state"
  | "class"
  | "er"
  | "sequence";

export type MermaidFallbackReason =
  | "open_fence"
  | "blank_source"
  | "source_limit"
  | "unsupported_kind"
  | "unsupported_syntax"
  | "malformed_source"
  | "node_limit"
  | "edge_limit"
  | "group_limit"
  | "depth_limit"
  | "canvas_limit"
  | "width_limit";

export type MermaidParseResult =
  | { readonly ok: true; readonly diagram: MermaidDiagram }
  | { readonly ok: false; readonly reason: MermaidFallbackReason };

export type MermaidProjectionResult =
  | {
      readonly ok: true;
      readonly width: number;
      readonly height: number;
      readonly lines: readonly MermaidStyledLine[];
      readonly estimatedBytes: number;
    }
  | { readonly ok: false; readonly reason: MermaidFallbackReason };
```

约束：

- diagnostic 默认只记录 kind、reason、source bytes、node/edge/cell counts 与耗时 bucket，不记录 source/label；
- IR 中保存 display label，但不外泄到错误日志；
- 所有 `Result` 都是同步、无抛错业务结果；programmer invariant 才允许测试中抛错；
- parser 遇到未知结构性语句立即返回 failure，不积累“部分成功”图。

### 4.4 支持矩阵

M0 先把支持子集固化成 fixture，不在实现中凭感觉扩展。

| kind | R1 必须支持 | 必须 fallback 的首批内容 |
|---|---|---|
| flowchart/graph | `TD/TB/BT/LR/RL`；rect/round/diamond；常见 solid/dotted/thick edge 与 arrow/circle/cross；edge label；subgraph；HTML entity 与简单 Markdown label 清洗 | 无法配对的 node/edge；未知结构语句；超深 subgraph；交互 `click`；会改变结构但未实现的 directive |
| state | `stateDiagram`/`stateDiagram-v2`；start/end；transition label；`state "label" as id`；description；direction；choice；首批 composite state fixture | 未闭合 composite/note；未知 transition operator；并行/并发语义未实现时整体 fallback |
| class | class declaration；最多 8 member；inheritance/composition/aggregation/dependency/association；label/cardinality；generic display | 无法识别的 relation/member；namespace/annotation 改变结构且未实现 |
| ER | entity、最多 8 attribute、PK/FK/UK 展示、常见 cardinality/identifying/non-identifying relation | 不完整 entity block、未知 cardinality/operator、垃圾 statement |
| sequence | participant/actor；同步/异步/虚线/丢失消息；self message；note；loop/alt/opt/critical/box；autonumber；activation marker 的已声明降级语义 | orphan arrow；未知 block/statement；未闭合 block；无法安全布局的跨 lane 内容 |

只允许对“纯表现、不改变拓扑”的 directive 建立显式 no-op allowlist。allowlist 外未知语句一律 fallback；每个 no-op 都必须有测试证明 source 中其他结构没有被吞掉。

### 4.5 display width 与 canvas

R1 使用 `string-width@7.2.0` 作为 display-column authority，并用 `Intl.Segmenter(..., { granularity: "grapheme" })` 生成 grapheme。不得用 `string.length` 布局 CJK、emoji 或 combining marks。

Canvas 使用并行 typed array：

- `Uint32Array glyphIndex`：索引到 per-canvas grapheme intern table；
- `Uint8Array semanticClass`：empty/border/node/edge/edge-label/title；
- `Uint8Array directionMask`：up/down/left/right；
- `Uint8Array lineStyle`：solid/dotted/thick；
- `Uint8Array occupied`：node/frame 占位；
- wide grapheme trailing cell 使用专用 sentinel，不输出第二次字符。

禁止 `Array<{ char, style, ... }>` 这类 per-cell object。每次分配前用
`width * height <= maxCanvasCells` 做 overflow-safe 检查；布局 scratch memory 也要纳入 `estimatedBytes`。

### 4.6 初始硬限制

| 限制 | R1 初始值 | 行为 |
|---|---:|---|
| source bytes | 65,536 | 在 parser 前 fallback |
| nodes/actors | 128 | 整体 fallback |
| edges/sequence items | 512 | 整体 fallback |
| groups | 24 | 整体 fallback |
| nesting depth | 6 | 整体 fallback |
| class/ER members per entity | 8 | 第 9 项不静默截断；整体 fallback，除非 fixture 明确采用带省略标记的语义 |
| label display width | 28 | 有界 wrap/ellipsis |
| label wrap | 24 × 4 lines | 最后一行使用 ellipsis，测试不能丢失宽度边界 |
| canvas cells | 524,288 | 分配前 fallback |
| canvas draw operations | 20,000 | 逐 cell 绘制前估算，超预算完整 fallback |
| width bucket | 8 columns | 只有跨 bucket 才重新 layout |
| projection cache | 64 entries / 8 MiB | LRU eviction；超大单项不缓存 |

这些值只在 `limits.ts` 定义一次。任何上调都要附 heap、latency、native frame 与长会话证据。

### 4.7 OpenTUI adapter

`mermaid-code-block-renderer.ts` 使用
`createMarkdownCodeBlockRenderer({ mermaid: ... })` 生成稳定 `renderNode`，并在每个新
`MarkdownRenderable` 构造时注入。至少覆盖：

- `mermaid`、`Mermaid` 与 `mermaid theme=base` info string；
- backtick 与 tilde fence；
- opening marker 长度与 closing marker 长度匹配；
- token raw 尚未出现合法 closing fence 时调用 `context.defaultRender()`；
- blank、oversize、parse/layout failure 调用 `context.defaultRender()`；
- 成功时返回一个 `MermaidBlockRenderable`，不替换整个 assistant message。

`component-runtime.ts` 保持当前 Markdown identity/finalization 流程。开放 fence → 闭合 fence 的 token 替换由 OpenTUI block reconciliation 完成，不在 RunLedger 新建轮询器。

### 4.8 resize、theme、selection

`MermaidBlockRenderable` 只监听自身 `onSizeChange`：

1. 读取实际 content width；
2. 扣除自身 border/padding；
3. 计算 8-column width bucket；
4. bucket 未变时只更新 OpenTUI 尺寸，不重新 parse/layout；
5. bucket 变化时查 projection cache，miss 才重新布局；
6. 更新 child rows 与自身 measured height；
7. 通过现有 OpenTUI dirty/requestRender 路径提交，不创建 timer。

主题色使用语义 class 映射：`border`、`nodeText`、`edge`、`edgeLabel`、`title`。
cache 保存 geometry/semantic class，不保存最终 RGBA，因此 dark/light 切换只重新投影样式，不重新 parse/layout。

selection 行为：

- 原生 mouse selection 选中可见 Unicode art；
- Ctrl+C/selection 继续走当前 `component-runtime.ts` 的 OSC 52 路径；
- 不嵌入 ANSI control bytes 到纯文本 glyph；
- 原 source 始终保留在 authoritative Markdown；R2 的 `[Copy Source]` 再提供显式原文动作。

### 4.9 cache 与长会话

Mermaid cache 复用 `src/tui/opentui/render-cache.ts`，不另造无界 Map：

```text
entryId          = source SHA-256 digest
width            = floor(contentWidth / 8) * 8
contentGeneration= MERMAID_RENDER_REVISION
themeGeneration  = 0（geometry 不含最终 theme）
```

- digest 只用于内存 cache identity，不写日志；
- `estimatedBytes` 包括 typed arrays、IR arrays、interned strings 与 styled-line text；
- source 自身由 authoritative Markdown 持有，cache 不重复保存第二份大 source；
- block destroy 时不要求逐项清 cache，但全局 LRU 必须守住 entries/bytes；
- renderer destroy 时释放 Mermaid cache 与所有 renderables；
- viewport 外 block 不实例化，遵守 Plan 18 的 timeline/window owner。

---

## 5. R1 Unicode 实施阶段（M0–M7）

每个阶段遵循 RED → GREEN → refactor；阶段提交只包含本阶段明确文件。任何一个阶段失败都保留普通 Mermaid 源码显示，不引入半成品 renderer。

### M0：冻结 corpus、许可与基线

任务：

1. 重新记录 branch/HEAD/worktree、OpenTUI/string-width/Bun/Node 版本；
2. 从参考实现提取最小行为 fixture，按 flowchart/state/class/ER/sequence 分类；
3. 每类建立 success、unsupported、malformed、oversize、CJK fixture；
4. 建立 license/NOTICE 清单，决定哪些文件是翻译移植、哪些是 RunLedger adapter；
5. 写 RED contract tests，证明当前 `language=mermaid` fenced block 仍显示源码且没有自定义 renderer；
6. 固化资源限制与 render revision，禁止实现阶段散落 magic number。

交付：

- `tests/tui/mermaid/fixtures/*`；
- `tests/tui/mermaid/fence.test.ts` 的 RED 用例；
- license/attribution 变更；
- 当前 native frame baseline（40/80/120 columns）。

退出条件：fixture 和 license review 得到维护者认可；未认可不得复制参考源码。

建议 commit：`test(tui): freeze bounded mermaid rendering corpus`

### M1：fence 与 OpenTUI fallback 接缝

任务：

1. 实现 `limits.ts`、`fence.ts` 与最小 result types；
2. 实现 `mermaid-code-block-renderer.ts`，初始成功路径可返回固定测试 renderable；
3. 将稳定 `renderNode` 注入 `component-runtime.ts` 的每个 MarkdownRenderable；
4. 确保普通 code fence 完全不变；
5. 确保 open fence、blank、unsupported、oversize 都走 `context.defaultRender()`；
6. 覆盖 streaming open → append → close → finalized 的 identity 与 frame 行为。

RED：closed Mermaid 仍是源码。

GREEN：仅受支持的闭合 Mermaid fixture 被自定义 block 替换，普通/开放/失败 fence 仍显示原源码。

退出条件：Bun native test 在 40/80/120 宽度均不崩溃，测试 `finally` 中调用 `renderer.destroy()`。

建议 commit：`feat(tui): add a fail-safe mermaid code-block seam`

### M2：typed-array engine 与 flowchart

任务：

1. 实现 grapheme/display-width、bounded tokenizer、graph IR；
2. 实现 flowchart/graph directions、node shapes、edge operators/labels；
3. 实现 rank、barycenter ordering、TD/LR placement 与 forward/back/self-edge routing；
4. 实现 typed-array canvas、junction mask、wide glyph sentinel；
5. 实现 subgraph/group frame 与深度限制；
6. 输出 semantic styled lines，不依赖 OpenTUI 类型。

测试：

- TD/TB/BT/LR/RL；
- self/back/cross edge；
- subgraph 嵌套；
- HTML entity、简单 Markdown label 清洗；
- CJK/emoji/combining width；
- 127/128/129 nodes，511/512/513 edges；
- canvas 临界值与 multiplication overflow；
- 未知结构 statement 整体 fallback。

退出条件：pure Vitest snapshot/structural assertions 与 native projection frame 同时通过；不得只验证字符串包含关系。

建议 commit：`feat(tui): render bounded flowcharts as unicode`

### M3：state、class 与 ER

任务：

1. `state.ts`：state declarations、start/end、transition/label、direction、choice、首批 composite；
2. `class.ts`：class/member、常见 relation head/line、generic/cardinality；
3. `er.ts`：entity/attribute 与 cardinality operator；
4. 复用 graph/class box layout，不复制 canvas/routing；
5. 对尚未支持的 note/namespace/并行语义 fail closed。

测试：每类 success corpus、garbage statement、unclosed block、member limit、CJK label、窄宽 fallback。

退出条件：三个 parser 均证明“未知结构语句不会被静默丢弃”；fallback frame 保留完整源码。

建议 commit：`feat(tui): add strict state class and er diagrams`

### M4：sequenceDiagram

任务：

1. actor/participant declaration 与声明顺序；
2. 同步/异步/虚线/cross/self message；
3. note over/left/right；
4. loop/alt/opt/critical/option/box/rect 与嵌套 end；
5. autonumber；
6. activation marker 只按 fixture 中声明的降级语义处理；
7. actor gap、message label、note geometry 与 canvas limit。

测试：orphan arrow、unknown statement、unclosed block、long label、nested blocks、512/513 items、rows rectangular、wide glyph sentinel 不外泄。

退出条件：未知/不完整 sequence 永远 fallback；不会输出参与者缺失或消息顺序错误的“部分图”。

建议 commit：`feat(tui): render strict sequence diagrams in terminal`

### M5：production OpenTUI 行为

任务：

1. 用真实 engine 替换 M1 stub；
2. 保持 current Markdown streaming → finalization identity；
3. 接入 `onSizeChange` 与 width bucket；
4. 接入 dark/light semantic theme；
5. 验证 selection、OSC 52、scroll、viewport window、body node destroy；
6. mixed Markdown 中只替换 Mermaid block，heading/list/table/普通 code 不变；
7. 同一 assistant message 多个 Mermaid block 独立 fallback。

native tests 必须覆盖：

- width 40 → 80 → 120 → 40；
- open fence → closed fence；
- dark → light；
- selection 完整覆盖 Unicode glyph；
- 两个成功图 + 一个失败图；
- 更新前后非 Mermaid sibling identity 不被无意义替换。

退出条件：`createTestRenderer()` frame 与 styled span assertions 通过，所有 renderer 均在 `finally` destroy。

建议 commit：`feat(tui): integrate mermaid projections with opentui lifecycle`

### M6：预算、cache、adversarial 与性能

任务：

1. 使用 bounded `RenderCache`，加入 hit/miss/eviction/oversized metrics；
2. source digest + 8-column bucket + revision key；
3. 200 个不同 diagram 长会话下证明 cache 不超过 64 entries/8 MiB；
4. mutation corpus：随机删字符、重复 edge、极长 token、深层 group、零宽/控制字符、CRLF；
5. benchmark simple、dense、near-limit、fallback；
6. 确认 parser/layout 不访问 fs/network/process，不写日志 source；
7. 把 Mermaid cache/latency 纳入既有 TUI performance observer，避免平行 telemetry。

性能目标在 M0 记录的同一机器上验收：

- warm cache p95 ≤ 2 ms；
- 典型 80-column cold render p95 ≤ 16 ms；
- near-limit 输入在硬预算内结束，不阻塞超过 50 ms；
- cache eviction 后 heap 回落，无随 session length 单调增长；
- resize 在同一 width bucket 内不增加 parse/layout 计数。

如机器差异导致时间阈值不稳定，以 operation/resource cap 为自动门禁，并保留带硬件信息的 benchmark artifact 供人工验收；不得删除预算测试来“修复”慢测试。

建议 commit：`perf(tui): bound mermaid layout and projection caches`

### M7：完整门禁、真实 TTY 与状态回写

按顺序执行：

```bash
npx vitest run tests/tui/mermaid
npm run test:tui-native
npm run check
npm test
npm run build
which runledger
npm ls -g --depth=0
runledger
```

#### M7 fresh evidence（2026-08-12）

| 门禁 | 结果 | 证据边界 |
|---|---|---|
| `npx vitest run tests/tui/mermaid` | PASS | 12 files / 58 tests；覆盖五类 parser、布局、fallback、宽度、限制、cache、review 回归与 adversarial corpus |
| `npm run test:tui-native` | PASS | 58 tests / 270 assertions；新增“先切 light、后创建 Mermaid block”的 palette 回归，并覆盖 40/80/120 列、streaming、selection/OSC52、fallback、destroy 与 cache |
| `npm test` | PASS | 303 Vitest files passed / 1 skipped；1745 tests passed / 3 skipped；Bun native 58 tests passed |
| `npm run check` | PASS | current-format、boundary scripts、contract consumers 与 TypeScript 全部通过；`stateDiagram-v2` 误报已有回归测试 |
| `npm run build` | PASS | `dist/` 编译与 host build manifest 生成通过 |
| 标准 PATH `runledger` smoke | PASS | `npm link` 后全局链接指向本 worktree；本轮以隔离 `/tmp/runledger-mermaid-smoke-*` 启动真实 tmux TTY，确认 0600 auth/SQLite 文件与 Ctrl+D 干净退出；此前 40/80/120、closed Mermaid 与 malformed fallback 证据仍保留，但不重标为本轮 fresh |

自动化和标准 PATH smoke 已完成，但以下项目仍保持 pending：

- license/NOTICE 的正式维护者审阅；当前仅证明没有引入参考实现源代码、Mermaid npm package、Chromium、外部字体或 R2 资产；
- 人工 dark/light 对比度与颜色观感；
- 人工鼠标选择、复制结果与 Unicode art 一致性；
- 真实终端 resize 往返后的视觉稳定性、scroll/focus/editor 行为；Bun native resize 已通过，但 tmux 2.6 无法改变已创建 server window 宽度，未形成有效的真实 resize 视觉证据；
- 真实终端中五类图表逐类的维护者视觉确认。

真实 TTY/tmux 至少验证：

1. 40/80/120 列；
2. dark/light terminal；
3. 流式响应中的开放 fence 不闪成半图；
4. closed flowchart/state/class/ER/sequence；
5. 鼠标选择并复制 Unicode art；
6. terminal resize 后 scroll/focus/editor 不跳；
7. malformed/oversize input 只回退源码；
8. Ctrl+D/退出后终端状态恢复。

最后更新：

- 本文状态表与 fresh evidence；
- `00-overview.md`；
- `development-doc/00-index.md`；
- license/notices；
- 必要的用户文档与 Mermaid 支持矩阵。

R1 只有在 focused、native、全量、build、标准 PATH PTY 与 human visual acceptance 全部有 fresh evidence 后才能标记完成。当前仅达到前五项自动门禁和标准 PATH smoke；人工验收与 license formal review 尚未闭合。

建议 commit：`docs(tui): record accepted mermaid terminal rendering evidence`

---

## 6. R2 PNG/外部查看器条件性专项

### 6.1 为什么不能直接放进 R1

当前 OpenTUI 0.4.5 没有仓库可用的 PNG `ImageRenderable`，而参考 pager 也不内联 PNG。PNG 带来 native build、字体、进程隔离、缓存文件、OS opener、save destination、跨平台终止和 artifact authority，风险远高于同步 Unicode projection。

所以 R2 必须满足：

- 不改变 R1 parser/Unicode fallback；
- sidecar 缺失、失败或平台 unsupported 时，R1 仍完整可用；
- R2 每一项用户动作都走 application action → EffectRunner → injected port → Session Runtime；
- 不能以“只打开图片”为理由让 TUI 获得 raw process/fs 权限。

### 6.2 推荐组件边界

```text
MermaidBlockRenderable action
        |
        v
TuiAction / EffectRunner
        |
        v
MermaidRasterPort (TUI contract only)
        |
        v
Session controller command/query
        |
        v
Session Runtime raster service
        |
        +--> ExecutionGateway / managed process adapter --> pinned Rust sidecar
        |
        +--> RunledgerLayout.cache/mermaid (private, bounded, atomic)
        |
        +--> platform opener / governed save adapter
        |
        v
opaque MermaidArtifactHandle -> TUI
```

建议 port：

```ts
export interface MermaidRasterPort {
  render(request: MermaidRasterRequest): Promise<MermaidRasterResult>;
  open(handle: MermaidArtifactHandle): Promise<MermaidRasterActionResult>;
  save(handle: MermaidArtifactHandle, destination: GovernedSaveIntent): Promise<MermaidRasterActionResult>;
}
```

`MermaidArtifactHandle` 只含 session-scoped opaque id、content digest、media type、pixel dimensions、quality 与 renderer revision；不含 absolute path。Source copy 走现有 clipboard capability，不要求生成 PNG。

### 6.3 sidecar 协议与资源边界

推荐 Rust sidecar，不推荐 headless browser：

- source 与参数通过单个 bounded stdin frame；source 不进入 argv/env；
- stdin 使用 versioned length-prefixed protocol，先拒绝超过 96 KiB 的 frame；
- stdout 使用 versioned header + bounded PNG bytes；stderr 最多保留 16 KiB 分类诊断；
- handshake 固定 `protocolVersion`、`rendererRevision`、platform/arch 与 `buildDigest`；
- parent 在接收前验证 host build manifest 中的 sidecar digest；
- timeout 初始 3s；Unix 回收 process group，Windows 必须有 Job Object；
- source 64 KiB、单轴 16,384 px、总像素最多 32 MP、PNG bytes 最多 64 MiB；
- parent 验证 8-byte PNG signature、IHDR width/height、实际 bytes、digest 与 header 一致；
- SVG raster 禁用 file/http/local path resolver、脚本、外部资源；
- 字体只用随 sidecar 分发且 license 已审阅的 bundled fonts，不从系统字体目录动态加载；
- 不检测/调用全局 `mmdc`，不下载 Chromium，不做网络 fallback。

若 CJK bundled font 的体积/license/coverage 未解决，R2 不得用系统字体偷偷补齐；保持 R2 unavailable 或明确只在已覆盖字符集提供能力。R1 Unicode 不受影响。

### 6.4 cache 合同

内部 cache 根：`<RunledgerLayout.cache>/mermaid/`。

文件名只允许：

```text
<source-digest>-<theme>-<quality>-<width-bucket>-r<revision>-<build-digest>.png
```

要求：

- root/subdirectory `0700`，file `0600`；
- 同目录 temporary file + fsync/close + atomic rename；
- source 不写盘；metadata 不含 label/source snippet；
- 写后重新读 header/digest 验证；
- 全局初始 cap 200 MiB，按最后访问/创建时间清理；单文件仍受 64 MiB cap；
- corruption 当 cache miss，删除动作由 storage adapter 完成，不在 TUI；
- handle 解析必须重新校验 canonical containment，不接受 caller-supplied path；
- cache 可整体删除，不影响 session replay 或 R1。

### 6.5 UX

R2 成功能力可用时，图表下方展示：

```text
[Open Image] [Save Image] [Copy Source]
```

行为：

- `Open Image`：lazy render；cache hit 直接走受治理 opener；
- `Save Image`：lazy render 后走 governed destination/write；禁止由模型提供未确认目标路径；
- `Copy Source`：复制 authoritative Mermaid source，不生成 PNG；
- rendering/failed/unavailable 使用可访问文本状态，不用只有颜色的反馈；
- 同一 key 的并发点击 coalesce；action 完成/失败后清 pending 状态；
- 不提供 `[Copy Image Path]`，因为路径是本机实现细节、远程 attachment 下不可移植，也会泄露 home/cache layout。

### 6.6 R2 阶段（P0–P5）

#### P0：ADR、license、platform 与 authority gate

先完成 ADR，明确：

- Rust sidecar vs 其他 engine；
- source/PNG protocol；
- bundled font 方案；
- cache vs Trace artifact；
- Session Runtime operation/capability 名称；
- approval/open/save policy；
- Linux/macOS/Windows build、签名、终止与 package matrix；
- Runtime 06、Worktree/Security、Trace 文档同步项。

停止条件：任一 authority 不清楚、license 未审、Windows 无 Job Object 方案、macOS/Windows 无 packaging owner 时，不进入对应平台实现。可以只批准 Linux candidate，但 capability 必须诚实标记其他平台 unavailable。

#### P1：isolated renderer sidecar

TDD 实现 protocol、pure engine、SVG→PNG、bundled fonts、resolver deny、limits、panic/abort/timeout fixture。sidecar 单测与进程级集成测试必须验证 malformed frame、oversize、garbage SVG、PNG cap、timeout、kill/reap、stderr cap 与 source-free logs。

sidecar build 产物不得依赖系统 `mmdc`/Chromium；build digest 写入 manifest。

#### P2：Runtime raster service 与 private cache

在 Session Runtime owner 中增加 typed capability 与 command/query：

- driver/fencing/correlation 校验；
- request coalescing；
- managed process attempt receipt；
- cache containment/mode/atomicity；
- owner fenced/detach/shutdown 时取消 pending request 并回收 helper；
- opaque handle registry；
- opener/save adapter 的 permission/approval 与 typed failure。

恢复语义：PNG 是 cache，不 replay “正在渲染”；takeover 后未完成 action 返回中断/可重试，不伪造 success。若 action 产生 durable side effect（save/open receipt），按 ExecutionGateway 规则记录 attempt/settlement。

#### P3：TUI action/effect/port

增加 framework-neutral action/effect/result，`MermaidBlockRenderable` 只发 intent。EffectRunner 调 injected `MermaidRasterPort`；controller adapter 做协议映射。覆盖 unavailable、loading、ready、failed、aborted、stale result 与同-key coalesce。

TUI 测试使用 fake port；native renderer 测试不得启动真实 sidecar。

#### P4：跨平台 package 与 fault rehearsal

每个平台必须有独立 runner evidence：

- sidecar 定位与 build digest；
- filenames/permissions/atomic rename；
- timeout 后无 orphan child/grandchild；
- terminal exit、owner fenced、Ctrl+C、crash 后回收；
- opener 命令不经 shell 拼接；
- save destination containment/approval；
- standard PATH 不依赖开发工具链；
- package 安装后 notices/fonts/sidecar 齐全。

Linux process group 通过不代表 Windows Job Object 或 macOS package 通过。未验证平台保持 typed `unavailable`。

#### P5：验收与渐进启用

先默认 capability detection + R1 fallback，不以 hidden env 绕过 authority。完成 focused、Runtime recovery、security negative、full test、build、真实 PATH TTY、三平台 runner（或明确 supported platform matrix）、独立安全审计与 human acceptance 后，才能把 R2 在对应平台标记 available。

R2 失败率、timeout、cache hit/eviction、output size 只记录分类与数值，不记录 source。出现 crash/orphan/path escape/source leak 时立即关闭 R2 capability，不回滚 R1。

---

## 7. 测试矩阵

### 7.1 R1 pure tests

| 维度 | 必测内容 |
|---|---|
| fence | backtick/tilde、3+ marker、case-insensitive info、attributes、开放/闭合、CRLF |
| parser | 五类成功 corpus、unknown statement、malformed、空白/comments、entity/Markdown label |
| topology | ranks、direction、self/back/cross edge、group nesting、sequence order |
| width | ASCII、CJK、emoji ZWJ、combining marks、zero-width/control chars |
| limits | source/node/edge/group/depth/member/cell 的 below/equal/above |
| fallback | 整个 source 保留；不残留部分 graph；reason 分类不含 source |
| cache | digest、bucket、revision、hit/miss、LRU、byte cap、oversized item、theme reuse |
| determinism | 相同 source/width/revision 产生相同 plain lines 与 semantic classes |

### 7.2 R1 native OpenTUI tests

使用 Bun `createTestRenderer()`，每个 setup 必须：

```ts
const setup = await createTestRenderer({ width: 80, height: 30 });
try {
  // assertions
} finally {
  setup.renderer.destroy();
}
```

覆盖：

- 40/80/120 columns char frame；
- `captureSpans()` 的 dark/light semantic color；
- `resize()` 往返与 measured height；
- open → closed streaming；
- normal code block 不变；
- mixed Markdown block 顺序；
- mouse selection/OSC 52；
- viewport/scroll/focus/editor 回归；
- renderer destroy 后无 callback/cache 持有；
- 200 diagram long-session bounded behavior。

### 7.3 R2 tests

| 层 | 必测内容 |
|---|---|
| protocol | truncated/oversize/wrong version/wrong digest/extra stdout/large stderr |
| engine | parse/layout/raster error、resolver deny、bundled font、PNG dimensions/bytes |
| process | timeout、panic/abort、child+grandchild reap、owner fence、shutdown |
| cache | 0700/0600、atomic rename、containment、corruption、eviction、concurrent same key |
| Runtime | driver/fencing/correlation、attempt receipt、takeover、stale handle、unavailable platform |
| TUI | fake port、loading/result/stale/abort、Open/Save/Copy Source、无 path 泄露 |
| package | standard PATH、sidecar/build manifest/notices/fonts、supported triplets |

### 7.4 人工视觉验收

人工验收不能用 snapshot 代替，至少检查：

- node/edge/junction 在常用字体下没有断裂；
- CJK label 对齐；
- narrow fallback 信息可读；
- selected art 与复制结果一致；
- dark/light 对比度；
- resize 不闪烁、不重复插入 block；
- R2 外部图片清晰、背景与 theme 一致、CJK 字体可读；
- R2 unavailable/timeout 时 TUI 仍可继续输入和退出。

---

## 8. 安全、资源与观测门禁

| 风险 | R1 防线 | R2 追加防线 |
|---|---|---|
| 不可信 source CPU/内存 | 64 KiB + graph/canvas limits + strict parser + sync budget | 独立进程 + 3s timeout + kill/reap |
| 语义误画 | unknown structural statement 整体 fallback | engine error 仍回退 R1/source |
| 宽字符错位 | grapheme + `string-width` + sentinel | bundled font + pixel dimension validation |
| 长会话内存 | viewport owner + 64 entries/8 MiB LRU | 200 MiB private disk cache cap |
| 本机文件/网络读取 | R1 无 I/O | resolver deny + ExecutionGateway + no mmdc/browser fallback |
| path 泄露 | 无路径 | opaque handle；无 Copy Image Path；source-free logs |
| crash/orphan | 无 child | sidecar isolation、process group/Job Object、owner cleanup |
| 权限绕过 | pure projection | explicit action/effect/port + approval/receipt |
| replay 混乱 | source 是 authority，art 是 projection | PNG 是 cache，不伪造 durable render state |
| 许可遗漏 | M0 attribution gate | engine/font/dependency/package notices gate |

观测字段只允许：diagram kind、fallback reason、source byte bucket、node/edge/cell bucket、width bucket、cache hit/miss、duration bucket、PNG dimensions/bytes、timeout/error category、build revision。禁止 source、label、cache path、argv/env 与 stderr 原文进入默认日志。

---

## 9. 提交、回滚与并发工作树边界

### 9.1 提交规则

- 每个 M/P 阶段一个小提交，先 review 明确路径；
- 只用 `git add -- <explicit-paths>`；删除单独 `git add -u -- <path>`；
- 不使用 `git add .`、`git add -A`、`git commit -a`、`--no-verify`；
- 未经用户明确要求不 commit；未经单独明确要求不 push；
- 开始阶段前重新检查并发修改，禁止覆盖本计划 §1.2 或未来新增的无关 worktree 变更。

### 9.2 回滚单位

- R1 adapter 可单独关闭：不注入 Mermaid `renderNode` 即恢复普通 code block；
- 每个 diagram parser 可从支持矩阵移除并整体 fallback，不影响其他 kind；
- cache 可整体清空，不影响 source/replay；
- R2 capability 可按 platform/build revision 关闭，R1 保持；
- 不保留双 renderer 长期 fallback；唯一 fallback 是 OpenTUI 原生源码 code block。

### 9.3 停止条件

遇到以下任一情况立即停止扩大 scope：

1. 需要修改 ledger/session schema 才能完成 R1；
2. parser 只能忽略未知结构语句才能“看起来工作”；
3. source/canvas 超限仍会分配大对象；
4. OpenTUI custom renderer 导致非 Mermaid Markdown identity/streaming 回归；
5. license/NOTICE 无法确认；
6. R2 需要 TUI raw spawn/fs/network；
7. sidecar 无法被 timeout 后完整回收；
8. cache path 或 source 出现在公共 DTO/default logs；
9. Windows 无 Job Object 等价能力却被标记 available；
10. R2 package 依赖系统 `mmdc`、Chromium、网络下载或未固定字体。

停止后保持源码 fallback，记录 typed gap，不用 catch-all、静默降级或扩大 allowlist 掩盖问题。

---

## 10. 完成定义

### 10.1 R1 完成

- [x] 五类 diagram 的冻结子集全部实现；
- [x] unsupported/malformed/oversize 全部完整 fallback；
- [x] 原始 Markdown 仍是唯一 replay authority；
- [x] source/node/edge/group/depth/member/canvas/cache 限制有边界测试；
- [x] CJK/emoji/combining width 有 pure + native evidence；
- [x] streaming open→closed、resize 40/80/120、dark/light semantic spans、selection/OSC52 已有自动化 evidence；
- [x] long-session cache/heap/latency 预算通过；
- [ ] license/NOTICE 正式维护者审阅通过；当前清单只记录依赖和“未引入参考源代码”的实现边界；
- [x] focused、native、`npm run check`、`npm test`、`npm run build` 全绿；
- [x] 标准 PATH `runledger` 隔离 smoke 通过；
- [ ] 人工 dark/light、鼠标选择/复制、真实 resize 和五类图表的视觉验收通过；
- [x] 本文与两级索引已回写 fresh evidence。

### 10.2 R2 完成

- [ ] P0 ADR 与跨领域 authority 已批准；
- [ ] sidecar protocol/build/font/license 固定；
- [ ] source 只走 bounded stdin；resolver deny；PNG 全量校验；
- [ ] Session Runtime/ExecutionGateway/managed process/fencing/recovery 接线完成；
- [ ] cache 0700/0600、atomic、contained、bounded、source-free；
- [ ] TUI 只持 opaque handle，无 raw path/process/fs；
- [ ] `[Open Image] [Save Image] [Copy Source]` 的 action/effect/port 测试通过；
- [ ] supported platform 的 timeout/orphan/package evidence 通过；未支持平台诚实 unavailable；
- [ ] focused、security negative、Runtime recovery、full test、build、真实 PATH TTY 通过；
- [ ] 独立安全审计与 human acceptance 通过；
- [ ] R2 失败/关闭时 R1 仍完整工作。

R1 与 R2 分别验收。R2 未完成不能把 R1 降为 partial；同样，R1 未通过不能用外部 PNG 查看器冒充终端 Mermaid 支持。

---

## 11. 实施前复核清单

```bash
cd /data2-HDD-SATA-20T/Digital_avatar/haoweiyao/RunLedger
git status --short
git branch --show-current
git rev-parse HEAD
node -p 'require("./package.json").dependencies["@opentui/core"]'
node -p 'require("./package.json").dependencies["string-width"]'
rg -n "new MarkdownRenderable|createMarkdownCodeBlockRenderer" src/tui node_modules/@opentui/core
rg -n "node:child_process|node:fs|fetch\\(" src/tui
```

参考实现也必须固定到记录 commit 后再移植：

```bash
cd /data2-HDD-SATA-20T/Digital_avatar/haoweiyao/grok-build
git status --short
git rev-parse HEAD
git diff -- crates/codegen/xai-grok-markdown/src/mermaid.rs \
  crates/codegen/xai-grok-mermaid \
  crates/codegen/xai-grok-pager/src/scrollback/blocks/mermaid_content.rs \
  crates/codegen/xai-grok-pager/src/app/mermaid_worker.rs
```

如果参考 worktree 不再是 clean `c68e39f60462...`，先重新审计差异并更新本文 snapshot，不能默默混用新旧实现。

---

## 12. 参考文件

RunLedger：

- `src/tui/opentui/component-runtime.ts`
- `src/tui/opentui/markdown-budget.ts`
- `src/tui/opentui/render-cache.ts`
- `src/tui/opentui/frame-scheduler.ts`
- `src/tui/opentui/performance-observer.ts`
- `scripts/check-execution-boundaries.ts`
- `scripts/check-tui-boundaries.ts`
- `src/runtime/contracts/storage-layout.ts`
- `tests/tui/opentui-component-runtime.bun.test.ts`
- `tests/tui/opentui-streaming.test.ts`

OpenTUI 0.4.5：

- `node_modules/@opentui/core/renderables/Markdown.d.ts`
- `node_modules/@opentui/core/Renderable.d.ts`
- OpenTUI skill docs：Markdown、Layout、Testing、Renderer

grok-build：

- `crates/codegen/xai-grok-markdown/src/mermaid.rs`
- `crates/codegen/xai-grok-mermaid/src/{engine,pure,raster,subprocess}.rs`
- `crates/codegen/xai-grok-pager/src/scrollback/blocks/mermaid_content.rs`
- `crates/codegen/xai-grok-pager/src/app/mermaid_worker.rs`
- `third_party/mermaid-to-svg/`
- `third_party/NOTICE`
- `THIRD-PARTY-NOTICES`
