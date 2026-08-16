# RunLedger TUI Codex 语法高亮完整复刻计划

> 状态：**planned，尚未实现**
>
> 计划日期：2026-08-12
>
> RunLedger 基线：`session-owner-runtime@d2c2709f49fbfc333bdd566058a1ff5b8e6b65b6`
>
> Codex 固定参照：`main@0b175e6439a8608ba7726ee153fd8590619e8f34`
>
> 交付性质：本文只冻结实现路线、边界、阶段与验收；不代表依赖、native addon、主题、Markdown、命令或状态栏能力已经落地。

---

## 0. 权威边界与工作树事实

### 0.1 本计划拥有的范围

本文是以下能力的唯一实施入口：

- Markdown fenced code 的 Codex 等价语法高亮；
- exec / Bash 工具 / 审批命令预览的 Bash 高亮；
- cwd、project root、branch、model、state 等状态栏语义色；
- `syntect` / `two-face` 主题、别名、输入护栏、TextMate scope 查询和主题 revision；
- syntect 颜色到 OpenTUI `StyledText` / `RGBA` 的无损适配；
- diff 背景 scope 与 Codex 通用 UI 语义色收敛；
- native highlighter 的构建、预编译包、Host build identity、降级与跨平台证据。

本文不替换以下既有权威：

| 专项 | 继续拥有的 authority | 本计划的接缝 |
|---|---|---|
| [`17-opentui-refactor-plan.md`](17-opentui-refactor-plan.md) | OpenTUI renderer 与稳定 renderable 生命周期 | 只增加高亮 service、组合 code-block renderer 和 styled projection |
| [`18-opentui-streaming-performance-ux-plan.md`](18-opentui-streaming-performance-ux-plan.md) | 流式合并、可见区、背压、输入公平性、长会话预算 | 高亮任务必须服从 generation fencing、有界队列和缓存预算 |
| [`19-passive-contract-integration-plan.md`](19-passive-contract-integration-plan.md) | Timeline、safe presentation、reducer/effect/adapter 生产接入 | 命令、工具结果与状态栏改为结构化 passive presentation，不建立第二状态源 |
| [`21-mermaid-diagram-rendering-implementation-plan.md`](21-mermaid-diagram-rendering-implementation-plan.md) | Mermaid Unicode projection、源码 fallback 与 R2 artifact 边界 | `mermaid` fence 先交给 Mermaid renderer，其余 fence 才进入通用高亮 |
| [`22-opencode-conversation-scrollbar-adaptation-plan.md`](22-opencode-conversation-scrollbar-adaptation-plan.md) | transcript scrollbar、sticky/new-content/selection | 高亮完成不得改变滚动 authority 或替换 transcript owner |
| `runtime/06-session-owner-runtime-replacement-plan.md` | Session owner、cwd/worktree 私有路径、recovery/fencing | TUI 只消费安全展示标签，不放宽 native path DTO 边界 |

### 0.2 当前工作树边界

计划编写时仓库存在大量与本专项无关的未提交改动。特别是下列文件已被其他工作修改：

- `development-doc/00-index.md`；
- `development-doc/tui/00-overview.md`；
- `src/cli/main.ts`；
- `src/tui/interactive-mode.ts`；
- 多个 Session Runtime、Extension、Skill、MCP 文件及测试。

本轮文档只新增本文，并在两个索引中追加最小导航。未来执行本文时也必须逐路径审阅和暂存，不得把共享工作树中的其他修改归入本专项。

### 0.3 证据口径

- `HEAD` 只说明已提交基线，不包含当前工作树候选；
- 本文的 RunLedger 现状来自 2026-08-12 对当前源文件、依赖和测试的只读检查；
- Codex 行为以固定参照 commit 的源码为准，不以描述性总结代替；
- 自动测试、跨平台 runner、标准 PATH TTY 与人工视觉验收必须分开记录；
- 任一阶段只在 fresh evidence 完成后更新状态，不沿用旧计划或旧 commit 的绿色结果。

---

## 1. 目标、等价定义与非目标

### 1.1 最终目标

在不 fork OpenTUI、不改变 Session/ledger 正文 authority 的前提下，让 RunLedger TUI 在下列链路上复现 Codex 的高亮语义：

1. 代码与命令使用 `syntect 5.3.x` + `two-face 0.5.1` 的扩展语法库和内置主题；
2. fenced code、Bash command、状态栏 scope、diff scope 共用同一 active syntax theme；
3. ANSI indexed、terminal default 和 RGB 三类颜色在 OpenTUI 中保持各自意图；
4. 主题可自适应、配置、预览、确认、取消恢复，并以 revision 统一失效缓存；
5. unknown、oversize、native unavailable、timeout、队列压力和 stale generation 都安全回退到可选择、可复制的完整纯文本；
6. 高亮只是可删除、可重建的 presentation，原始 Markdown、命令和工具输出仍是 authority；
7. Linux、macOS、Windows 的声明严格受预编译 addon 和真实 runner 证据约束。

### 1.2 “完整复刻”的判定

完整复刻不是“看起来颜色接近”，而是同时满足：

- 同一 grammar/theme 数据源；
- 相同语言 token 提取、别名和 lookup 顺序；
- 相同 512 KiB / 10,000 行护栏；
- 相同 alpha 编码解释；
- 代码仅保留 foreground + bold；
- 相同主题名称、adaptive default、custom theme 与 revision 生命周期；
- 命令提示符、状态、输出、cwd、diff 的语义规则一致；
- RunLedger 特有的 OpenTUI、Session privacy、流式调度和跨平台交付边界闭合。

若只能用另一套 grammar/theme 引擎做近似着色，应标记为“非等价方案”，不得把它命名为 Codex 复刻完成。

### 1.3 非目标

- 不复制 Codex 的 ratatui widget、Markdown parser 或完整 TUI；
- 不 fork `@opentui/core`；
- 不把 Rust renderer 引入 RunLedger，Rust 仅承担纯高亮/theme 计算；
- 不在 TUI render path 读取文件、访问网络或 spawn 高亮子进程；
- 不在运行时下载 grammar、theme 或 native binary；
- 不对 stdout/stderr 做语言猜测或任意语法高亮；
- 不把 syntax theme 变成 Runtime durable state 或 ledger 正文；
- 不借 cwd 展示放宽公共 `WorkspaceExecutionEnvelope` 的 native path 脱敏规则；
- 不在本专项重新设计 Mermaid parser、scrollbar、Session owner 或 tool execution authority。

---

## 2. 固定参照源码与 RunLedger 当前差距

### 2.1 Codex 源码地图

| 能力 | 固定参照路径 | 核心事实 |
|---|---|---|
| 高亮引擎 | `codex-rs/tui/src/render/highlight.rs` | `syntect` + `two-face`、主题单例、revision、别名、护栏、scope API、颜色转换 |
| Markdown fence | `codex-rs/tui/src/markdown_render.rs` | info string token 提取，结束 fence 后批量高亮，失败回退纯文本 |
| exec cell | `codex-rs/tui/src/exec_cell/render.rs` | 精确剥离 Bash wrapper、Bash 高亮、`$ ` magenta、输出 dim、状态/耗时 |
| cwd 来源 | `codex-rs/tui/src/chatwidget/status_surfaces.rs`、`status/helpers.rs` | current dir 取值、home-relative `~`、project root 标签 |
| 状态栏色 | `codex-rs/tui/src/bottom_pane/status_line_style.rs` | item→accent→TextMate scopes，fallback 与 RGB softening |
| 主题选择 | `codex-rs/tui/src/theme_picker.rs`、`render/highlight.rs` | 32 内置主题、自定义 `.tmTheme`、预览/取消/确认 |
| 配置 | `codex-rs/core/src/config/edit.rs` | `[tui].theme` 的持久化编辑 |
| diff | `codex-rs/tui/src/diff_render.rs` | inserted/deleted scope 背景与 fallback |
| 通用色规范 | `codex-rs/tui/styles.md`、`codex-rs/tui/clippy.toml` | ANSI 命名色语义与违规静态约束 |

依赖证据：参照 lockfile 中 `syntect 5.3.0`、`two-face 0.5.1`；许可证分别为 MIT 与 MIT OR Apache-2.0。内嵌 grammar/theme 的上游 attribution 仍需 H0 独立审计，不能只凭 crate 顶层许可证下结论。

### 2.2 RunLedger 当前链路

| 维度 | 当前实现 | 差距 |
|---|---|---|
| Markdown | `component-runtime.ts` 为每个 `MarkdownRenderable` 注入固定 `SyntaxStyle` | 只有静态 Tokyo Night-like 颜色，不是 Codex theme/grammar |
| grammar | OpenTUI 0.4.5 默认资产仅含 JavaScript、TypeScript、Markdown/inline、Zig | Bash、Python、Rust、Go、C# 等识别名最终仍会因 parser 缺失回退纯文本 |
| Mermaid | 已有 `renderNode: mermaidRenderNode` | 新 renderer 必须组合，不能覆盖 Mermaid 接缝 |
| theme mode | `theme_mode` 时重建同一 `SyntaxStyle` | 只有 dark/light mode，不存在 syntax theme 名、scope API 或 revision |
| settings | `ProjectSettings.theme?: "dark" | "light"` | 标准 CLI 没有把它传入 `InteractiveMode`；也不等于 Codex syntax theme |
| tool/exec | `timeline/selectors.ts` 把完整 tool row 压为一个 `kind: "text"` block | `$`、command、status、output、duration 都失去结构，无法分别着色 |
| output | safe projector 目前把 ANSI 剥离后再输出纯文本 | 不能实现“保留安全 SGR 前景，再统一 DIM” |
| process overlay | `ansiToStyledText` 保留安全 SGR | 只处理输出，不高亮命令 |
| approval | 通用 selection modal 只展示标题/摘要 | 没有复用命令高亮视图 |
| cwd/project | Footer 不展示 cwd/project root；生产 bootstrap 的 `workspaceLabel` 为 `unknown` | 缺展示 authority，且不能直接拿 public digest 反推路径 |
| diff | safe diff 已结构化，但 selector 再压平成普通文本 | 未从 syntax theme 查询 inserted/deleted 背景 |
| build | TypeScript + Linux C helper；无 Rust/N-API pipeline | native addon 的构建、签名、package matrix、manifest 全部缺失 |
| Host manifest | 只纳入 `.js`、`.json` 和 Linux helper | addon binary / platform package identity 尚未被覆盖 |

### 2.3 不采用的替代路线

| 方案 | 可取之处 | 不作为 canonical 复刻的理由 |
|---|---|---|
| 继续用 OpenTUI Tree-sitter | 已集成、支持 streaming | 默认 grammar 数量远少于 two-face；查询与主题行为不同；扩 grammar 会引入另一套资产/下载问题 |
| Shiki | TextMate grammar/theme 生态丰富 | 不是 two-face syntax set，也不是 syntect 的匹配与样式结果；只能算近似实现 |
| npm `syntect` | JavaScript API | 包陈旧且不等于 Codex 使用的 Rust crate |
| 外部 Rust CLI/sidecar | 容易做 spike | 每个 TUI 运行都多进程，增加超时/回收/路径/签名面；违反 render path 不 spawn |
| 运行时下载 grammar/addon | 初始包更小 | 不可审计、离线失败、供应链风险；明确禁止 |

---

## 3. 冻结决策与停止条件

### D1：canonical engine 使用同源 Rust bridge

新增 in-process native bridge，固定使用：

- `syntect 5.3.x`；
- `two-face 0.5.1`；
- `two_face::syntax::extra_newlines()`；
- `two_face::theme::extra()`；
- 与参照源码一致的 lookup、limit、scope 与 color conversion 规则。

bridge 构建为 Bun/Node 可加载的 N-API 兼容 native addon。具体 binding crate 与 ABI level 在 H0 spike 后冻结；不得先把 `napi-rs`、Neon 或自定义 FFI 之一写成未经验证的产品事实。

### D2：OpenTUI 只做适配，不拥有 syntax truth

Rust 返回稳定、框架无关的 span DTO；TypeScript 把它转为 OpenTUI `StyledText`。OpenTUI 继续拥有：

- renderable tree；
- width-aware wrapping；
- selection/copy；
- viewport、scroll 与 native frame；
- terminal palette 的最终解析。

不得把约 250 种 grammar 再翻译成 `SyntaxStyle`，也不得让 OpenTUI Tree-sitter 与 syntect 对同一 fence 竞争。

### D3：原文是 authority，高亮是 derived cache

所有 highlighter input 必须来自已经存在的 safe/original presentation source。缓存只保存：

- source digest；
- language token；
- theme revision；
- styled spans；
- bounded diagnostic/metrics。

缓存可随时删除，不进入 session、ledger、trace 正文或恢复协议。

### D4：theme controller 是唯一 active syntax theme owner

`SyntaxThemeController` 统一拥有：

- configured theme 名；
- active theme snapshot；
- preview 状态；
- monotonic revision；
- built-in/custom metadata；
- foreground/diff scope 查询；
- cache invalidation 通知。

`component-runtime.ts`、Footer、diff renderer 和 picker 不各自保存第二份主题状态。

### D5：native failure 永远 plaintext，不切换引擎

下列情况全部返回 typed fallback，并显示完整纯文本：

- addon 不存在、ABI 不匹配或加载失败；
- theme 无效；
- language unknown；
- 输入为空、超限或解析失败；
- async task timeout / scheduler pressure；
- session/content/theme generation 已过期；
- 平台没有已验证 prebuild。

不得在失败时自动改用 Shiki、Tree-sitter 下载、外部命令或网络服务。

### D6：跨平台 packaging 是启用门，不是发布后补项

production enablement 前必须具备并验证以下 prebuild：

| OS | libc | arch |
|---|---|---|
| Linux | glibc | x64、arm64 |
| Linux | musl | x64、arm64 |
| macOS | system | x64、arm64 |
| Windows | MSVC | x64、arm64 |

允许 H0/H1 在 Linux 做 developer spike，但若完整 matrix、CI runner、package selection、checksum 和 Host manifest 方案不能闭合，实施必须停在 feature-disabled 状态，并把 capability 报为 `native_unavailable`。不能发布“仅当前开发机可用”的默认高亮。

### D7：cwd 展示不放宽 native path privacy

状态栏只消费 `WorkspaceDisplayLabel`：

- current dir：可信 composition 根据真实 effective cwd 生成的 home-relative label；
- project root：root basename 或明确批准的安全 label；
- branch：Git safe label；
- unavailable：显示空缺/`unknown`，绝不从 digest 猜路径。

原始绝对路径继续只存在于 Host-private execution context。若远程 attachment 没有同等可信的本地 composition，则 cwd label 为 unavailable；不得为了状态栏新增公开绝对路径字段。

### D8：UI 语义色与 syntax theme 分层

- syntax/code/diff/path scope 可使用 theme 提供的 indexed/RGB 色；
- 固定 UI 元素使用 terminal palette intent：cyan、green、red、magenta 与 DIM；
- 不把 theme RGB 展开成硬编码的“相近” ANSI 色；
- blue/yellow 不用于普通 UI 状态；black/white 不作普通前景；
- terminal output 自带安全 SGR 与用户 custom theme 是例外，不受普通 UI 色禁令替换。

---

## 4. 目标架构

```text
canonical settings + terminal background + validated custom theme bytes
                              │
                              ▼
                   SyntaxThemeController
                  name / preview / revision
                    │          │
          scope API │          │ async highlight request
                    ▼          ▼
            status/diff     SyntaxHighlightService
                                  │
                                  ▼
                       in-process Rust addon
                 syntect + two-face + bounded worker
                                  │
                     HighlightResult / fallback
                                  ▼
                    OpenTUI StyledText adapter
                    │             │             │
             Markdown fence    exec/tool     approval view
                    │
       Mermaid first ─ generic code second ─ plaintext last
```

### 4.1 Rust bridge 职责

建议目录：`native/syntax-highlighter/`。bridge 仅负责纯计算：

- 初始化 immutable syntax set；
- 解析 built-in/custom theme；
- 原子切换 active theme、返回 revision；
- 高亮一段 source；
- 查询前景 scope 与 diff 背景 scope；
- 暴露 build/version/theme/grammar inventory；
- 执行输入大小、行数、span 数与输出字节护栏。

bridge 不负责：

- filesystem path resolution；
- settings I/O；
- network；
- runtime binary download；
- shell/process；
- OpenTUI renderable；
- Session state 或 Trace 写入。

### 4.2 TypeScript service 职责

建议目录：`src/tui/highlight/`。

`SyntaxHighlightService`：

- loader capability 探测一次；
- typed request/result；
- stable-key scheduler；
- timeout、queue pressure、generation fencing；
- bounded LRU；
- metrics；
- plaintext fallback。

`SyntaxThemeController`：

- 组合 root 注入 initial theme；
- adaptive default；
- preview/restore/commit；
- revision event；
- scope query cache；
- custom theme 只接收 storage boundary 已验证的 bytes。

`OpenTuiHighlightAdapter`：

- `indexed` → `RGBA.fromIndex(index)`，保留 terminal palette intent；
- `default` → chunk 不设置 `fg`；
- `rgb` → `RGBA.fromInts(r, g, b)`；
- bold → `TextAttributes.BOLD`；
- 不投影 background/italic/underline；
- 保留每个 source line、空行与换行；
- 生成 selectable `StyledText`。

### 4.3 组合 renderer

`MarkdownRenderable.renderNode` 不能被第二个 renderer 覆盖。目标适配器是一个组合链：

1. 若 fence language 为 `mermaid`，调用 Plan 21 renderer；
2. 若为 fenced code 且可提取 language token，创建稳定的 `SyntectCodeBlockRenderable`；
3. 若 unknown/unavailable/oversize，交回 OpenTUI 默认源码 block；
4. indented code 与没有 language 的 fence 保持完整纯文本，除非参照行为和测试另行证明应选择 syntax。

异步完成只更新同一稳定 renderable 的 derived content，不重建 transcript，不改变 block id，不滚动到尾部，不覆盖 selection。

---

## 5. 精确合同

### 5.1 框架无关 span DTO

```ts
export type HighlightColor =
  | { readonly kind: "default" }
  | { readonly kind: "indexed"; readonly index: number }
  | { readonly kind: "rgb"; readonly r: number; readonly g: number; readonly b: number };

export interface HighlightSpan {
  readonly text: string;
  readonly foreground: HighlightColor;
  readonly bold: boolean;
}

export interface HighlightLine {
  readonly spans: readonly HighlightSpan[];
}

export type HighlightFallbackReason =
  | "empty"
  | "unknown_language"
  | "oversize_bytes"
  | "oversize_lines"
  | "native_unavailable"
  | "theme_invalid"
  | "highlight_error"
  | "timeout"
  | "queue_pressure"
  | "stale_generation";

export type HighlightResult =
  | { readonly ok: true; readonly lines: readonly HighlightLine[]; readonly themeRevision: number }
  | { readonly ok: false; readonly reason: HighlightFallbackReason };
```

约束：

- DTO 不含 raw pointer、native handle、filesystem path 或 arbitrary ANSI；
- `text` 拼接必须与 source 去除行终止符后的逐行文本相同；
- 空 source 返回 fallback，调用方生成一个空 plain line；
- bridge 必须限制单 span 文本、总 span 数和返回总字节，防止合法 source 产生病态碎片；
- TypeScript 不接受 bridge 返回的额外字段或越界 index/RGB。

### 5.2 language token 与 lookup

Markdown info string 只取按 `,`、space、Tab 分隔后的第一段：

```text
rust,no_run        -> rust
rust no_run        -> rust
rust title=demo    -> rust
```

别名补丁固定为：

| 输入 | 查找 token |
|---|---|
| `csharp`、`c-sharp` | `c#` |
| `cppm`、`cxxm`、`ixx` | `cpp` |
| `golang` | `go` |
| `python3` | `python` |
| `shell` | `bash` |

查找顺序固定：

1. `find_syntax_by_token(patched)`；
2. exact syntax name；
3. case-insensitive syntax name；
4. raw input extension。

任何新增 alias 必须先在 Codex 参照或 two-face 缺口中给出证据，不能凭产品偏好随意扩展。

### 5.3 高亮护栏

- source bytes `> 512 * 1024`：plaintext；
- actual lines `> 10_000`：plaintext；
- 必须按真实行数计算，覆盖“最后一行没有 newline”的 off-by-one；
- CRLF 的 `\r\n` 行终止符不进入 span 文本；
- aggregate diff 高亮先检查总 bytes/lines，不能逐行绕过总上限；
- 调用方不得截断 source 后对局部内容着色并伪装完整结果。

### 5.4 syntect 颜色转换

bridge 按 alpha 解码：

| alpha | 语义 | DTO |
|---|---|---|
| `0x00` | `r` 是 ANSI palette index | `{ kind: "indexed", index: r }` |
| `0x01` | terminal default foreground | `{ kind: "default" }` |
| `0xFF` | true RGB | `{ kind: "rgb", r, g, b }` |
| 其他 | 参照行为按 RGB | `{ kind: "rgb", r, g, b }` |

代码 style 只保留 foreground 与 BOLD。背景、italic、underline 全部丢弃，原因与 Codex 一致：避免覆盖终端背景和减少 theme 在类型/module scope 上的视觉干扰。

对于 ANSI 0–7，OpenTUI 适配必须保留 indexed intent，不能先换算成硬编码 RGB；终端 palette 与 bold/bright 处理才是最终 authority。

### 5.5 status scope 与 softening

`StatusLineItem` 到 scope 的映射按 Codex 对齐：

| accent | scopes（按顺序） | fallback |
|---|---|---|
| Model | `entity.name.type`、`support.type`、`variable` | cyan |
| Path | `string`、`markup.underline.link` | green |
| Branch | `entity.name.function`、`entity.name.tag` | magenta |
| State | `keyword.control`、`keyword` | cyan |
| Usage | `constant.numeric`、`constant` | green |
| Limit | `constant.language`、`storage.type` | magenta |
| Metadata | `comment`、`constant.other` | cyan |
| Mode | `storage.modifier`、`keyword.operator` | cyan |
| Thread | `markup.heading`、`entity.name.section` | magenta |
| Progress | `markup.inserted`、`constant.numeric` | green |

RGB softening 公式保持一致：

```text
luma = (77*r + 150*g + 29*b) / 256
channel' = (channel*85 + luma*15 + 50) / 100
brightness = 100%
```

bright named colors 降为对应普通 ANSI 色，white 降为 gray；普通 named/indexed 色保持 palette intent。分隔符 ` · ` 使用 DIM，不给普通 segment 整体加 DIM。

### 5.6 diff scope

背景查询顺序：

- inserted：`markup.inserted` → `diff.inserted`；
- deleted：`markup.deleted` → `diff.deleted`。

theme 没有定义时使用经 dark/light/terminal capability 验证的既有 fallback palette。diff background 可保留；普通 fenced code 仍不使用 background。

---

## 6. 主题配置与生命周期

### 6.1 32 个内置主题

名称与 Codex 完全一致并按 picker 稳定排序：

```text
1337
ansi
base16
base16-256
base16-eighties-dark
base16-mocha-dark
base16-ocean-dark
base16-ocean-light
catppuccin-frappe
catppuccin-latte
catppuccin-macchiato
catppuccin-mocha
coldark-cold
coldark-dark
dark-neon
dracula
github
gruvbox-dark
gruvbox-light
inspired-github
monokai-extended
monokai-extended-bright
monokai-extended-light
monokai-extended-origin
nord
one-half-dark
one-half-light
solarized-dark
solarized-light
sublime-snazzy
two-dark
zenburn
```

### 6.2 RunLedger settings 迁移

当前 `ProjectSettings.theme` 的 `dark|light` 只表达旧 UI mode。目标把 canonical user setting 的 `theme` 定义为 syntax theme name：

- 缺省：adaptive default；
- 旧值 `dark`：读时映射 `catppuccin-mocha`，不立即重写磁盘；
- 旧值 `light`：读时映射 `catppuccin-latte`，不立即重写磁盘；
- 用户在 `/theme` confirm 后才写 canonical 名；
- workspace settings 不拥有 user syntax theme authority；
- UI chrome dark/light 继续由 OpenTUI terminal background observation 驱动，不再与 syntax theme setting 混为一件事。

迁移必须有 storage schema、sanitize、round-trip 与 legacy characterization tests。若产品决定保留旧 `theme` 字段语义，则必须改用明确的 `syntaxTheme` 新字段并更新本文；不能让一个字段同时表示两类 authority。

### 6.3 adaptive default

- terminal background 判定为 light：`catppuccin-latte`；
- dark 或 unknown：`catppuccin-mocha`；
- adaptive selection 只在没有有效 user override 时发生；
- terminal background 后到达时，可在启动窗口内完成一次默认选择，但不得覆盖已确认配置；
- selection 触发 revision 并使 code/status/diff cache 一起失效。

### 6.4 custom theme

路径固定为：

```text
<runledgerHome>/themes/<name>.tmTheme
```

storage/composition boundary 负责：

- theme name 只允许安全 basename，不含 separator、`..`、NUL；
- containment 与 symlink/regular-file 策略；
- bounded read；
- 文件 digest；
- 把 bytes + safe name 传给 controller。

renderer 和 native highlight job 不读文件。invalid/unreadable custom theme 给出一次可行动 warning，并回退 adaptive default；不能每帧打印日志。

### 6.5 `/theme` picker

行为：

1. 打开时保存 active theme snapshot/name/revision；
2. 光标移动实时 preview；
3. preview 使 code/status/diff 一起变色；
4. Esc/cancel 恢复打开前 snapshot；
5. Enter/confirm 先持久化，成功后设 configured active theme；
6. 持久化失败恢复原主题并展示 bounded error；
7. custom 与 built-in 一起 case-insensitive 稳定排序；
8. 列表显示当前、custom/built-in 和 load error，但不显示绝对路径。

每次真实 active theme swap 都递增 revision。仅重复选择相同已加载主题不得制造无限 revision churn。

---

## 7. 各展示面的目标行为

### 7.1 Markdown fenced code

- streaming 中先显示完整 plaintext，不能等待高亮才出现内容；
- 在 newline/fence/finalization 等稳定边界调度 async highlight；
- final fence 到达时取消/覆盖旧 partial job，只保留 latest queued；
- outer `MarkdownRenderable` 与 code block renderable identity 保持稳定；
- theme swap 后可先显示旧 text/无色 text，再异步重建，不能闪空；
- source selection/copy 始终得到原始文本，不夹杂颜色控制字符；
- 不对结构化 Markdown/code block 使用 `fitToWidth`；换行由 OpenTUI width-aware layout 完成；
- Mermaid fence 保持 Plan 21 优先权和原源码 fallback。

### 7.2 exec/tool 命令

Timeline 不再把 tool row 压成一个普通字符串。新增结构化 presentation，至少保留：

- stable tool call id；
- lifecycle status；
- safe shell kind；
- exact display script；
- background 标记；
- stdout/stderr styled chunks；
- exit code、duration、truncation；
- bounded error；
- safe diff document。

显示规则：

- command 使用 `bash` syntax；
- `$ ` 固定 ANSI magenta，不受 syntax theme 影响；
- command wrapper 只在有结构化 argv/shell metadata 时精确剥离；
- 不用 regex 改写任意 Windows command string；无法证明 wrapper 时显示原文；
- success `✓` 为 green + bold；failure `✗` 为 red + bold；
- duration 前 `•` 与时长为 DIM；
- pending/running 保持可识别但不新增自定义 RGB；
- background 显示 `(bg)`，不改变 command authority。

### 7.3 stdout/stderr

- 不做语法高亮；
- safe presentation boundary 只接受 SGR，丢弃 OSC/APC/未知 CSI/C0；
- 将 SGR 解析为 typed styled chunks，而不是把 raw ANSI 放进 state；
- renderer 在每个输出 chunk 原有 foreground/attributes 基础上叠加 DIM；
- stdout/stderr 的文本、顺序、截断标记与 current safe-tool bounds 不变；
- malformed ANSI 不能造成 style 泄漏到下一行或后续 block。

### 7.4 approval 与 process overlay

- shell approval 若含 safe command presentation，复用同一 command renderable；
- approval 没有命令或字段被治理层隐藏时，只显示 summary，不尝试恢复 raw args；
- process overlay header/command 使用同一 highlighter；output 继续复用安全 SGR parser；
- full-screen exec 视图与 inline tool row 使用同一 theme revision，不能各自维护颜色副本。

### 7.5 cwd / project root / footer

新增结构化 `StatusLineSegment[]`，不再让 Footer 先拼一条 ANSI string：

```ts
export interface StatusLineSegment {
  readonly item: StatusLineItem;
  readonly text: string;
}
```

来源与展示：

- `CurrentDir`：Session effective cwd 的安全 home-relative label；
- home 相等显示 `~`，home 子目录显示 `~/...`；
- `ProjectRoot`：Git root basename 或 approved safe label；
- `GitBranch`：独立 segment；
- invalid/unavailable 不显示伪路径；
- label 先做 terminal control stripping 和 byte bound；
- status scope 首选 theme，失败 fallback Path=green、Branch=magenta、Model/State=cyan；
- 主题色启用时按 softening 公式处理，separator DIM。

必须先写 privacy/authority test，证明 public runtime protocol、ledger、Trace 和 persisted binding 没有新增 absolute path。

### 7.6 通用 UI 色收敛

目标规范：

| 语义 | 颜色/属性 |
|---|---|
| title | bold |
| secondary / description / output | DIM |
| selection / prompt / active state | cyan |
| success / add | green |
| error / failure / delete | red |
| RunLedger brand / `$ ` / branch fallback | magenta |

扩展 `check:tui-boundaries` 或新增 focused static check：普通 UI presentation 中禁止新硬编码 foreground RGB、black/white、blue/yellow；允许 syntax theme projection、diff background、editor background blending、Mermaid 专项与终端安全 SGR 的精确白名单。

---

## 8. 流式、调度、缓存与失败模型

### 8.1 generation key

每个 job 至少绑定：

```text
sessionId
authorityGeneration
blockId/toolCallId
contentRevision
sourceDigest
language
themeRevision
```

completion 只有在所有字段仍匹配时才能写入 derived presentation。session switch、resume/rebind、theme preview、block replacement、stream finalization 任一发生后，旧 completion 都只能丢弃。

### 8.2 scheduler

- 每个 stable key 最多一个 active job + 一个 latest queued job；
- 新请求替换同 key 的 queued job，不丢失最新正文；
- global worker concurrency 初始上限为 2，H0 benchmark 后只可用证据调整；
- global queue 同时按 job count 和 source bytes 设硬上限；
- viewport 外 block 可延迟或 plaintext，进入 viewport 后再调度；
- 用户输入、resize、selection 和 scroll 优先于 highlight completion repaint；
- scheduler pressure 返回 typed fallback/延后，不阻塞 event loop。

### 8.3 cache

cache key：`engineBuildId + sourceDigest + language + themeRevision`。

要求：

- entry count、span count 与 estimated bytes 三重上限；
- theme revision 变化后旧 entry 不可命中；
- session 结束与 runtime destroy 释放 scheduler/cache/listener；
- cache 不重复持有大段 source；
- plaintext fallback 不缓存无界错误对象；
- native addon unload 不作为正常生命周期要求，但 service destroy 后不得再接受 completion。

### 8.4 observability

只记录聚合指标，不记录源码正文：

- request/ok/fallback count；
- fallback reason；
- queue wait / native duration / adapter duration；
- input bytes/lines bucket；
- cache hit/miss/eviction；
- stale completion count；
- active/queued jobs；
- theme revision。

指标接入现有 `TuiPerformanceObserver`，不得默认进入网络 exporter。

---

## 9. 实施阶段（严格 RED → GREEN）

### H0：baseline、provenance、license 与 native packaging spike

**RED**

- characterization 证明 Bash/Python/Rust fence 当前无 Codex 等价 spans；
- characterization 证明 tool command/current footer 为 plain text；
- addon load matrix/manifest test 先失败；
- 固定 Codex fixtures 与 source provenance manifest。

**GREEN**

- 建立 `native/syntax-highlighter/` 最小 addon spike，只暴露 engine info 与一个固定 Rust snippet；
- 验证 Bun production loader、Node build tooling、ABI、async task、destroy 行为；
- 冻结 prebuild package 命名、optional dependency selection、CI matrix、checksum；
- 更新 `files`、build scripts 与 Host build identity 设计；
- 完成 syntect、two-face、grammar/theme bundle 的 license/NOTICE review；
- 记录二进制体积、冷加载时间、32 KiB/512 KiB source benchmark。

**停止门**

下列任一不能闭合则停止后续 production enablement：

- Bun 不能稳定加载所选 ABI；
- 完整 OS/libc/arch prebuild 无可执行发布方案；
- embedded grammar/theme license 无法满足分发；
- Host build identity 无法纳入 binary；
- addon 只能依赖 runtime network/build/spawn。

### H1：Rust syntax/theme core

**RED**

- alias、lookup order、CRLF、unknown、empty、byte/line limit、无尾换行 10,001 行测试；
- 32 themes inventory 与 adaptive pair 测试；
- bridge output bound/fuzz tests。

**GREEN**

- `extra_newlines()` syntax singleton；
- exact alias/lookup；
- HighlightLines + LinesWithEndings；
- built-in/custom theme parse；
- typed results，无 panic 跨 FFI；
- engine build id/version/inventory API。

### H2：颜色、scope 与 TypeScript adapter

**RED**

- alpha `00/01/FF/other` fixtures；
- low indexed color intent、bold-only、background/italic/underline suppression；
- status scope fallback/softening 与 diff scope priority；
- malformed bridge DTO rejection。

**GREEN**

- Rust color DTO；
- `RGBA.fromIndex` / default / RGB adapter；
- `StyledText` line join；
- `SyntaxThemeController` revision 与 scope cache；
- pure unit tests 与 native parity fixtures。

### H3：Markdown fenced code 接入

**RED**

- `rust,no_run`、`python3`、`csharp`、unknown、oversize、CRLF、open streaming fence；
- Mermaid precedence；
- theme switch stale completion；
- selection/copy/resize；
- native `captureSpans()` 证明真实颜色 intent，而不只对文本 snapshot。

**GREEN**

- composite `renderNode`；
- stable `SyntectCodeBlockRenderable`；
- plaintext-first async update；
- streaming finalization 与 generation fencing；
- OpenTUI default code fallback；
- outer Markdown identity 不变。

### H4：exec/tool/approval/process 结构化渲染

**RED**

- selector flattening characterization；
- `$ ` magenta、Bash tokens、success/failure/duration spans；
- stdout safe SGR + DIM；
- malformed ANSI isolation；
- structured wrapper strip 与 Windows raw-string no-strip；
- approval/process reuse。

**GREEN**

- `PresentationBlock` 增加 typed tool/exec block；
- Timeline selector 不再把 shell/diff 压成 plain text；
- command renderable 与 safe output chunks；
- approval/full-screen overlay 复用；
- unknown native addon 时 command 完整 plaintext。

### H5：cwd/project root 与 status line

**RED**

- production bootstrap 当前 `unknown` characterization；
- home/root/subdir/Windows path label tests；
- public DTO、ledger、Trace 无 absolute path static tests；
- path/theme/fallback/softening span tests。

**GREEN**

- composition-owned `WorkspaceDisplayLabel`；
- Session switch/resume/rebind 时刷新；
- structured Footer segments；
- CurrentDir/ProjectRoot/GitBranch scopes；
- unavailable fail closed；
- 60/80/143 columns 不挤掉核心状态。

### H6：settings、adaptive default 与 `/theme`

**RED**

- old dark/light mapping；
- invalid/unknown/custom missing；
- terminal light/dark/unknown；
- preview → cancel restore；
- preview → confirm persist；
- persist failure restore；
- theme revision invalidates code/status/diff cache。

**GREEN**

- canonical schema 与 storage validation；
- composition 读取 custom theme bytes；
- 32 themes + custom picker；
- active/configured/preview 三态；
- standard CLI 注入 controller；
- warning 单次、无绝对路径泄露。

### H7：diff 与 UI semantic color 收敛

**RED**

- inserted/deleted scope priority；
- no-scope fallback；
- static color violations；
- dark/light/ANSI/custom theme snapshots。

**GREEN**

- structured diff renderable 使用 theme backgrounds；
- 普通 UI 固定 ANSI semantic palette；
- DIM/title/status 规范；
- 精确白名单的静态 gate；
- 不影响 editor background、Mermaid、safe terminal output。

### H8：压力、缓存、销毁与性能预算

**RED**

- rapid partial updates、theme scrubbing、session switch、resize storm；
- one active + latest queued；
- queue byte pressure；
- cache eviction；
- runtime destroy 后 completion；
- 512 KiB / 10,000 行边界 benchmark。

**GREEN**

- bounded scheduler/LRU；
- latest-wins 只作用于 derived highlight job，不丢正文 delta；
- stale result drop；
- viewport-aware scheduling；
- `TuiPerformanceObserver` 指标；
- renderer/service/native owners 在 `finally`/destroy 中清理。

初始性能门槛：

- render thread 不执行 syntax parse；
- 32 KiB visible snippet 的 highlight completion p95 ≤ 50 ms（标准 CI runner，warm addon）；
- theme swap 后首屏 visible blocks p95 ≤ 100 ms；
- highlight queue/cache 超限时 event loop 仍可在 33 ms 内处理输入帧；
- 512 KiB 边界内存峰值与 cache 总预算由 H0 实测冻结，不允许无上限增长。

门槛可在 H0 用真实基线收紧；如需放宽，必须记录 runner、样本与原因，不能静默改数值。

### H9：完整门禁、分发与人工验收

自动门禁：

- Rust unit/integration/fuzz corpus；
- TypeScript focused tests；
- Bun native `captureSpans()` tests；
- `npm run check`；
- focused TUI tests；
- `npm test`；
- `npm run build`；
- Host build manifest verify/replacement；
- package pack/install smoke；
- Linux glibc/musl、macOS、Windows prebuild runner；
- `git diff --check`。

真实运行：

- `which runledger` 与 global link provenance；
- 隔离 `RUNLEDGER_DIR`；
- standard PATH `runledger`；
- tmux/PTY 60、80、143 columns；
- dark terminal、light terminal、ANSI theme、RGB theme、custom theme；
- Markdown streaming、tool command、approval、process overlay、cwd、diff；
- selection/copy、mouse scroll、resize、theme preview/cancel。

人工验收必须单列签字：

- syntax 可读性；
- status 对比度；
- ANSI palette 尊重终端主题；
- custom theme 行为；
- no flicker/no stale recolor；
- cwd privacy 展示；
- Windows/macOS 真实终端而非仅交叉编译。

---

## 10. 预计文件变更清单

### 10.1 新增

```text
native/syntax-highlighter/
  Cargo.toml
  src/lib.rs
  src/color.rs
  src/language.rs
  src/theme.rs
  tests/fixtures/...

src/tui/highlight/
  contracts.ts
  native-loader.ts
  service.ts
  scheduler.ts
  cache.ts
  theme-controller.ts
  opentui-styled-text.ts
  status-style.ts

src/tui/opentui/
  syntect-code-block-renderer.ts
  syntect-code-block-renderable.ts
  exec-renderable.ts

tests/tui/
  syntax-highlight*.test.ts
  syntax-highlight*.bun.test.ts
  status-line-style*.test.ts
  exec-highlight*.bun.test.ts

development-doc/tui/
  23-codex-syntax-highlighting-license-manifest.md
```

实际拆分以 H0 spike 为准；不把 parser、scheduler、theme controller 堆进 `component-runtime.ts`。

### 10.2 修改

| 路径 | 目的 |
|---|---|
| `src/tui/opentui/component-runtime.ts` | 注入 controller/service、组合 code renderer、stable lifecycle、styled footer/tool blocks |
| `src/tui/opentui/mermaid-code-block-renderer.ts` | 只增加组合接缝，不改 Mermaid authority |
| `src/tui/opentui/syntax-style.ts` | 最终移除固定代码主题；保留 Markdown 非 code scopes 所需最小样式或重命名拆分 |
| `src/tui/presentation.ts` | typed exec/tool/status presentation block |
| `src/tui/timeline/selectors.ts` | 保留 shell/diff 结构，不再 flatten |
| `src/tui/presentation/tools/{types,projector}.ts` | safe command、safe SGR chunks、diff metadata |
| `src/tui/components/footer.ts` | 输出 structured segments |
| `src/tui/interactive-mode.ts` | controller 生命周期、`/theme`、workspace display facts |
| `src/tui/theme/*` | 区分 UI chrome 与 syntax theme，语义色收敛 |
| `src/storage/settings-manager.ts` | theme schema、legacy mapping、custom selection 持久化 |
| `src/cli/main.ts` | composition 注入 settings/theme/workspace display；不暴露 raw path |
| `src/cli/host-build-identity.ts` | addon/prebuild artifact identity |
| `scripts/generate-host-build-manifest.ts` | 新 native artifacts 纳入构建清单 |
| `scripts/check-tui-boundaries.ts` | UI foreground 静态规则与 bridge boundary |
| `scripts/run-tui-bun-tests.mjs` | 如需显式 addon/prebuild fixture 环境 |
| `package.json` / lockfile | exact dependencies、scripts、optional prebuild packages |
| CI/release workflows | Rust toolchain、matrix build、package smoke、checksum/signing |
| `development-doc/tui/00-overview.md` / `development-doc/00-index.md` | 状态与导航同步 |

任何 package-lock、binary、generated manifest 变更都按代码审阅，不视为机械产物跳过。

---

## 11. 测试矩阵

### 11.1 纯 engine/contract

- 每个 alias 正反例；
- token/name/case-insensitive/extension lookup order；
- empty/unknown/CRLF/no trailing newline；
- 512 KiB 前后边界；
- 10,000/10,001 lines；
- alpha color 四分支；
- indexed 0–7、8–255；
- bold-only；
- custom invalid/valid theme；
- 32 built-ins；
- status/diff scopes；
- span count/bytes bound；
- malformed FFI input 不 panic。

### 11.2 OpenTUI native

- `createTestRenderer()` + `captureSpans()` 校验 text、fg intent、attributes；
- 每个测试 `finally` destroy renderer/service；
- Markdown stable identity；
- Mermaid priority；
- streaming open/final fence；
- theme revision update；
- stale async completion；
- tool command + output DIM；
- footer/path spans；
- diff background；
- selection text 不含 ANSI；
- 60/80/143 width；
- mouse/scroll/resize 不改变内容 authority。

### 11.3 settings/composition/privacy

- user setting owns theme，workspace setting 不覆盖；
- dark/light legacy mapping；
- custom name traversal/symlink/oversize rejection；
- standard CLI 真正注入 resolved theme；
- session switch/rebind 刷新 workspace label；
- public Runtime schema、ledger JSONL、Trace event 不出现 native absolute cwd；
- addon missing/ABI mismatch/platform unsupported 返回 plaintext capability。

### 11.4 package/platform

- 每个 prebuild 能在 clean runner load；
- wrong-platform package 不被选择；
- missing optional package 不网络下载；
- `npm pack` 后 binary/theme inventory 完整；
- Host manifest 包含并验证 selected addon；
- binary 替换触发 digest mismatch；
- Linux glibc/musl、macOS x64/arm64、Windows x64/arm64；
- Bun 支持矩阵与最低版本一致。

---

## 12. 安全、许可证与运维边界

### 12.1 安全

- native bridge 所有输入长度先校验再分配；
- Rust error 转 typed result，不跨 FFI unwind；
- custom theme 解析有 byte/time bound；
- theme name 不参与任意 path join；
- highlighter 不解析/执行代码，不读取 include/import；
- 无网络、无 subprocess、无 runtime build；
- TUI state 不保存 raw ANSI、credential、env、absolute path；
- metrics 不含 source、command/output 正文；
- addon capability 失败不影响对话和工具执行，只影响 presentation。

### 12.2 许可证

H0 产出独立 manifest，至少记录：

- crate/version/source URL/commit；
- direct/transitive license；
- embedded grammar/theme 的来源和 attribution；
- 是否修改参考代码；
- NOTICE/LICENSE/package files；
- fixture 来源与生成方式；
- binary package 中实际包含的资产。

未经 formal review，不得把 Codex 源码、tests snapshots、two-face bundled assets 的复制内容直接提交到 RunLedger。

### 12.3 运维

- addon load error 每进程最多一条 actionable diagnostic；
- `/theme` invalid warning 不刷屏；
- debug metrics 可查看 capability/build id/fallback reason，不打印正文；
- crash report 只记 addon build id、platform、operation 与 bounded error；
- plaintext fallback 永远可用，用户无需修复 theme 才能继续会话。

---

## 13. 完成定义

| DoD | 完成条件 |
|---|---|
| Engine parity | 固定 Codex fixtures 在 aliases、limits、colors、themes、scopes 上一致 |
| Markdown | 常用 two-face languages 真高亮；unknown/oversize/native failure 完整 plaintext；Mermaid 不回归 |
| Exec | Bash command、`$ `、status、duration、safe output DIM 在 inline/approval/process 三处一致 |
| Status | cwd/project/branch/model/state 使用 scope + fallback + softening，且无 path privacy 回归 |
| Theme | 32 built-ins、adaptive default、custom theme、preview/cancel/confirm、revision 全闭合 |
| Diff/UI | inserted/deleted backgrounds 与固定 semantic ANSI colors 通过静态和 native tests |
| Streaming | stable identity、one active + latest queued、bounded cache、stale drop、input fairness 达标 |
| Packaging | 完整 prebuild matrix、clean install、Host manifest、checksum/license 证据齐全 |
| Validation | check、focused/full tests、build、package、standard PATH PTY 全部 fresh green |
| Human | dark/light/ANSI/custom、三宽度、三平台真实终端视觉验收签字 |
| Documentation | 本文状态、overview、总索引、license manifest 与实际能力同步 |

只有全部 DoD 满足，才能把状态从 `planned` 更新为 `implemented/accepted`。Linux 本地 addon、单一主题截图、TypeScript typecheck、纯文本 snapshot 或旧测试结果都不足以宣称“全面复刻 Codex 高亮”完成。
