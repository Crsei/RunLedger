# omp 工具面扩展与呈现层实施计划

> 状态：**in progress（Stage A 实施中）**。
> 上游基线：`oh-my-pi` `1c0303b1f2ec515cbf4b44a9a49d68a029531aac`（`packages/coding-agent` v18.2.4）；`packages/utils/src/ar/**`、`packages/coding-agent/src/markit/**`。
> 目标基线：RunLedger 分支 `rollback/before-composer-shape`，HEAD `23a3729`。
> 依据：[`parity/02 omp 工具注册与呈现机制`](../parity/02-oh-my-pi-tool-registration-and-presentation.md) §8（机制对照与唯一前瞻提示）、[`parity/00`](../parity/00-oh-my-pi-coding-agent-module-gap-report.md) §4 `tools/` 与 §8（P0 低成本项）、[`parity/01`](../parity/01-oh-my-pi-monorepo-package-and-crate-gap-report.md)。
> 相关既有裁定：[Plan 16](16-omp-tool-parity-update-plan.md) §1.3 裁定 4（`ast_grep`/`ast_edit` 先不实现、不搭依赖脚手架）、§5 P3（依赖岔口）。

---

## 0. 结论与范围

### 0.1 为什么立项

parity/02 §8 的结论是：RunLedger 当前**不需要** omp 的呈现层，因为它没有 100+ 工具面（26 vs 159 文件）；但当 `tools/` 缺口被填补（parity/00 §8 的 P0 项）后，「逐工具 schema 预算」会从不需要变成必须有。本计划按该因果顺序交付：**先补工具面，再按实测压力引入呈现层**。

### 0.2 取证纠正了 parity 00 的三处描述

实施前必须纠正（否则计划会建在错误前提上）：

| parity/00 的写法 | 实测事实 | 影响 |
|---|---|---|
| §3 #24 列出 `tools/read-pdf.ts`、`read-archive.ts`、`sqlite-reader.ts` 为「工具」 | **它们不是工具**，是 `read` 的 helper 模块：`sqlite-reader.ts`(927 行，`bun:sqlite`)、`read-sqlite.ts`(215，read 侧分支)、`read-archive.ts`(194)、`read-pdf.ts`(140) | 本计划对应项是**给 `read` 加类型分支**，不是新增工具；不需要新工具准入 |
| §3 #6 把 `rewind` 列为独立工具 | `tools/rewind.ts` **不存在**；`CheckpointTool` 与 `RewindTool` 同在 `tools/checkpoint.ts:54` / `:89`（全文 130 行，纯编排） | 两个工具一个文件；且都是 session 树分支语义（见 §3 B1） |
| §8 P0 把 `read-pdf` 列为低成本项 | `read-pdf.ts` 是 **Chromium 截图渲染器**（`renderPdfPageScreenshot`，走 browser registry + tab-supervisor），不是文本抽取；文本抽取的 `pdfToMarkdown` 在 `packages/utils` 是 **native**（`pi_natives` → `pdf-inspector` crate） | PDF **不是**低成本项，属依赖决策（§3 B3） |

### 0.3 范围

| 阶段 | 内容 | 依赖决策 | 状态 |
|---|---|---|---|
| **A1** | `read` 的类型分派层 + sqlite 分支 + archive 分支 | 无（archive 解码器纯 TS） | **已实现**（证据见 §5.1） |
| **A2** | `ask` 工具 + 通用反向请求 kind | 无新外部依赖 | **已实现**（证据见 §5.2） |
| **B1** | `checkpoint` / `rewind` 语义 | 已裁定：**复用现有 fork 语义**（新会话） | planned |
| **B2** | `ast_grep` / `ast_edit` | 已裁定：**不做**（保持 Plan 16 裁定 4） | 不做 |
| **B3** | `read` 的 PDF 分支 / markit 文档转换 | 已裁定：**不做** | 不做 |
| **C** | 工具呈现层（schema 预算 / 按需加载） | **实测未达触发条件**（见 §5.3），暂不实施 | 评估完成 |

**范围外**：`eval`（模型侧代码执行内核，parity/00 §6 明确不移植）、`internal-urls`（同上）、`edit` 多模式 hashline（Plan 16 裁定 4）。

---

## 1. 事实基线

### 1.1 上游各工具的精确契约（取自实际读取）

| 上游文件 | 工具名 | 输入 schema | 关键元数据 | 依赖真相 |
|---|---|---|---|---|
| `tools/ast-grep.ts`(548) | `ast_grep` | `{pat, path?, lang?, skip?}` | approval `read`、strict、`loadMode:"discoverable"` | **100% N-API Rust**：`import { astGrep } from "@oh-my-pi/pi-natives"` |
| `tools/ast-edit.ts`(722) | `ast_edit` | `{ops:[{pat,out}]≥1, paths[]≥1}` | approval 动态 `read\|write`、deferrable | **同上**：`astEdit` |
| `tools/ask.ts`(1670) | `ask` | `{questions:[{id,question,header?,options[{label,description?,preview?}],multi?,recommended?}]}` | approval `read`、`concurrency:"exclusive"`、`createIf` 需 `canPromptUser ?? hasUI` | 宿主 UI：`context.ui`（`ExtensionUIContext`）的 `select`/`editor`/`askDialog` |
| `tools/checkpoint.ts`(130) | `checkpoint` + `rewind` | `{goal}` / `{report}` | 两者 approval `read`、`createIf` | 纯编排：`sessionManager.branchWithSummary`（**session 树分支，非 git 快照**） |
| `tools/sqlite-reader.ts`(927) | —（helper） | — | — | `bun:sqlite`；magic sniff `looksLikeSqlite`、`openSqliteReadConnection`、pipe-table 渲染 |
| `tools/read-archive.ts`(194) | —（helper） | — | — | `@oh-my-pi/pi-utils/ar`（`openArchive`/`formatArchiveEntryLines`） |
| `tools/read-pdf.ts`(140) | —（helper） | — | — | **Chromium 截图**（`renderPdfPageScreenshot`） |
| `tools/read.ts`(2967) | `read` | `{path}` | `loadMode:"essential"` | 分派顺序：archive → sqlite → pdf → notebook |

**ast_grep/ast_edit 无回退**：`packages/natives/native/loader-state.js:895-897` 在缺 addon 时**直接抛错**，无 WASM/JS 回退；Rust 侧 `crates/pi-natives/src/ast.rs` 用 `ast-grep-core 0.39.9` + `pi_ast` grammars。

### 1.2 归档解码器的可移植性（关键结论）

`packages/utils/src/ar/**` **36 个文件全部是纯 TS**：只依赖 `node:` 内建 + pi-utils 内两个纯 TS 模块（`../format`、`../lru`），**无 npm/native import**。覆盖 zip/tar/7z/iso/rar/lzh/cab/cpio/rpm/deb/asar/arj/unix-ar，含自实现的 bzip2、XZ、LZMA 解码；上限常量集中在 `ar/limits.ts`（`maxEntries 1e6`、`maxInMemorySize 256MiB`、`maxMemberSize 64MiB` 等）。

→ **archive 分支零依赖可移植**，是本计划唯一「直接复制」项。

### 1.3 markit（PDF 之外的转换器）

`markit/registry.ts` 注册 5 个 converter：DOCX/PPTX/XLSX/EPUB **全为纯 TS**（依赖 pi-utils 的 ar/xml/docx/turndown 重写），**PDF 必须 native**（`converters/pdf/index.ts:1` → `@oh-my-pi/pi-natives` 的 `pdfToMarkdown` → `crates/pi-natives/src/pdf.rs` → crates.io `pdf-inspector`）。`markit/NOTICE`：MIT（markit-ai, Michael Liv），仅覆盖 registry/types+4 converter，PDF 明确非派生。

### 1.4 RunLedger 现状（集成面）

| 面 | 事实 |
|---|---|
| `read` 的类型分支 | **完全没有**：`read.ts:183-201` 是唯一取数路径，`readFile → Buffer → toString("utf8")`，无 magic/后缀嗅探、无二进制拒绝。`:img`/`:conflicts` 显式报错（`read-selector.ts:120,143-145`） |
| 分派窗口 | 新分支只能插在 `read.ts:169-182`（`splitPathAndSel`/`parseSel`/`resolveToCwd`）与 `183` 之间 |
| **选择器陷阱** | 拆解发生在类型判定**之前**：`db.sqlite:42` 的 `:42` 会被 `isRangeOrTailChunk`（`read-selector.ts:196-204`）当成**行选择器**，路径变 `db.sqlite`；`x.sqlite:users:42` 同理。新语法必须在拆解前或拆解中分派 |
| 缓存约束 | mtime LRU 缓存值类型是 `{mtimeMs,text}`（`read.ts:84-87`）；二进制/sqlite 分支必须绕过它 |
| sqlite 先例 | `database.ts:24-39` 用 `createRequire` 在 `node:sqlite`(readOnly)/`bun:sqlite`(readonly) 间分支；`:169` `PRAGMA query_only=ON`；`history-reader.ts:36-48` 是只读消费先例（不建 schema、不迁移、不 claim owner） |
| 反向请求 | 三条通路共用 `reverse_request` 帧（帧体是**不透明** `Record<string,unknown>`，新 kind **不需要**改帧 schema）：`approval_prompt`、`credential_prompt/event`、`request_permissions`。TUI 单分派点 `approval-workflow.ts:41-53` |
| **headless 陷阱** | 无 `reverseRequestHandler` 时回 `reverse_request_unhandled`（`client-transport.ts:217-219`），但 `SessionReverseApprovalPrompter` 会**按 25-250ms 轮询重试到 deadline**（`approval-reverse-request.ts:261-264,281-293`）；若 `expiresAt === undefined` 则是**无限等待**。新 ask 端口必须显式区分「无 handler」并立即 typed fail |
| session 回退 | 事件 append-only + `previous_event_hash` CAS（`event-append.ts:85-88`）+ `head_sequence` 单调（`:128-131`）；全仓**无** `DELETE/UPDATE session_events`。唯一回退机制是 `forkSession({throughSequence})` → **新 sessionId**，且边界须是「已完成、无 toolCall 的 assistant 轮次」（`fork-projector.ts:105-117`） |

### 1.5 呈现层的既有种子（Stage C 的起点，非空白）

RL **已有** provider-gated 的 deferred tool loading：`src/utils/deferred-tools.ts` 的 `splitDeferredTools` 被三个 adapter 使用（`api/anthropic-messages/params.ts:81`、`api/openai-codex-responses/request.ts:43`、`api/openai-responses.ts:245`），按 `compat.supportsToolSearch` / `supportsToolReferences` 与**历史 `addedToolNames`** 决定哪些工具进 `immediate` 还是延迟。

与 omp 的差异是结构性的：omp 是 **provider-agnostic 的 `xd://` 挂载**（`read`/`write` 充当传输层，任何模型可用），RL 是**依赖 provider 能力位 + 历史信号**。且 RL 生产工具**没有任何一个产出 `addedToolNames`**（已核实），即这条通道目前**无生产者**。

---

## 2. 阶段 A1：`read` 的类型分派 + sqlite + archive

### 2.1 设计

**新增 `src/runtime/tools/read-dispatch.ts`**（新文件）：在 `read.ts` 的拆解与取数之间插入类型判定，返回一个「读取计划」。

```
read.ts execute()
  169-172  splitPathAndSel / parseSel          ← 现有
  NEW      resolveMediaReadTarget(path, sel)   ← 新：类型判定 + 自有语法
  NEW  ├─ kind:"text"     → 现有 183-201 路径（含 LRU 缓存）
       ├─ kind:"sqlite"   → read-sqlite 分支（新）
       └─ kind:"archive"  → read-archive 分支（新）
```

判定规则（对齐上游 `read.ts:1690/1707` 的顺序：archive → sqlite）：

- **archive**：后缀命中 `ARCHIVE_EXTENSION_ALTERNATION`（从移植的 `ar/registry.ts` 取）或 magic sniff。
- **sqlite**：`looksLikeSqlite` magic（前 16 字节 `SQLite format 3\0`）。
- 两者都不命中 → 保持现有文本路径，**行为完全不变**。

### 2.2 选择器语法冲突的处理（必须解决）

上游的 sqlite/archive 有**自有冒号语法**（如 `db.sqlite:users`、`a.tar:inner/path`），而 RL 的 `splitPathAndSel` 会把末段当行选择器。

**裁定**：判定**先于**现有拆解。即先用「整个 raw path 的扩展名/magic」决定是不是 sqlite/archive；是则把剩余部分交给该分支自己的解析器；否则走现有 `splitPathAndSel`。

理由：不能把新语法塞进 `ParsedSelector`（那会让 `db.sqlite:42` 与 `.ts:42` 的歧义无法在类型层面消解）；也不能只按后缀判定后再看选择器（因为 `x.sqlite:users` 的后缀是 `.sqlite:users`，不是 `.sqlite`）。

### 2.3 移植清单

| 上游 | 目标 | 处置 |
|---|---|---|
| `packages/utils/src/ar/**`（36 文件） | `src/websource/internal/ar/**` | **直接复制**（纯 TS），加来源注释；删掉 `http` source（受治 port 才有出站） |
| `tools/sqlite-reader.ts`(927) | `src/runtime/tools/read-sqlite.ts` | 重写：`bun:sqlite` → RL 的双运行时 `createRequire` 分支 + `readOnly` + `query_only`（复用 `database.ts` 的思路，但**不得**触碰 session store） |
| `tools/read-archive.ts`(194) | `src/runtime/tools/read-archive.ts` | 复制 + 改 import |
| `tools/read-sqlite.ts`(215) | 合并进上面的 `read-sqlite.ts` | 复制 |

### 2.4 治理与冻结物

- `read` 的 schema **不变**（类型靠路径判定，不新增字段）⇒ **standard golden digest 不变**。这是本阶段的设计目标：不因为内部新增分支而改模型面契约。
- `read` 的 `capabilityClaims` 不变（仍是 `repository_read`）⇒ `plan-mode-tool-admission` 不变。
- **新增**：sqlite/archive 分支读的是**工作区文件**，必须经 governed fs port（`ReadOperations.readFile`），不得直接用 `node:fs`。静态门禁 `check:execution-boundaries` 已覆盖 `src/runtime/tools`。
- 需同步：`docs/subsystems/tools.md` 的 read 段落（新增两类分支与语法）、`tests/read-selector.test.ts` 或新增 `tests/runtime/tools/read-media.test.ts`。

### 2.5 验收

- 行为：`read` 对 `.sqlite` 返回表清单/schema/行/query 的 Markdown 表；对 `.zip`/`.tar.gz` 返回条目清单与成员读取；对普通文本**逐字节不变**（现有 `tests/stdlib-tools.test.ts:54-115` 必须全绿）。
- 陷阱回归：`db.sqlite:42` 必须解析为「sqlite 表的行选择」而**不是**「文件第 42 行」；`a.zip` 与 `a.zip:inner` 分别返回清单与成员。
- 只读性：sqlite 分支必须以只读方式打开（构造期断言 `query_only`），不得对工作区库文件产生写副作用。
- `npm run check`、`npm run test:runtime`、`npm run build`。

---

## 3. 需要裁定的三项（B 阶段）

### B1 `checkpoint` / `rewind` 的语义（已裁定：复用 fork 语义）

**上游事实**：`checkpoint`/`rewind` 是 `sessionManager.branchWithSummary` —— **session 树分支**，不是 git 快照、也不是文件回滚。

**RunLedger 事实**：事件是 append-only hash 链 + CAS，**同会话内无法回退**；唯一回退是 `forkSession({throughSequence})`（新 sessionId，边界须为「已完成无 toolCall 的 assistant 轮次」）。CLI `--fork --fork-at`、TUI `/fork --at=`、域操作 `session.fork` **已存在**。

**缺口（若要做真 rewind）**：① store 层 head 回退/重放截断能力（或改语义为 fork+切换）；② `session.*` 域操作（带 catalog/head CAS + attempt 收口）；③ controller 的**运行中**状态重物化入口（现在只有构造期一次性 replay）；④ TUI/web 入口与回执。

**裁定（2026-09-18）：选 (a)** —— 以现有 fork 语义交付，**不**新增同会话回退能力。

**已确认的下一步**：以 `src/runtime/loop/handoff.ts` 的 `LoopResetHandoff` 为模板，让 `rewind` 工具/命令产出「请求切到 fork 后的新会话」的意图，client 侧收到后执行 `session.fork`（`throughSequence`）并切换会话。runtime 不自行新建会话（那会越过 driver admission 改变会话身份），与 loop reset 同款分层。

**尚未实现**，因为 `checkpoint` 工具本身还缺一个前置：上游的 `checkpoint` 是「给当前边界打标记 + 写 summary」，而 RL 的 checkpoint 是**纯前进加速 cache**（`restoreCheckpointReplay` 只做 tail 续接，边界白名单在 `session-owner/types.ts`），用户可见的「标记」还不是一等对象。要做需要先把「会话内的命名检查点」建成 durable 记录，再让 rewind 引用它。

### B2 `ast_grep` / `ast_edit`

**上游事实**：100% N-API Rust（`ast-grep-core 0.39.9` + `tree-sitter` + `pi_ast` grammars），**无 TS/WASM 回退**。

**RunLedger 事实**：现有 tree-sitter 资产**只有 bash 一份**（`assets/tree-sitter/tree-sitter-bash.wasm` + `web-tree-sitter.wasm`），用于 `src/security/permission/bash-ast/` 的 WASM worker。要支持 ast-grep 需要**几十份 grammar**。

**冲突**：**Plan 16 §1.3 裁定 4（用户决定）明确「`hashline`/`ast_edit`/`ast_grep` 先不实现……也不为其搭依赖脚手架」**。因此本阶段默认**不做**。

**待裁定**（若要做）：(a) 自建 ast-grep crate（napi-rs 先例：`native/syntax-highlighter`）；(b) 用既有 WASM tree-sitter + 自实现 pattern 匹配（**无 `$$$` metavariable 语义**，能力缩水）；(c) 维持不做。**需先撤销/修订 Plan 16 裁定 4。**

### B3 PDF

**上游事实**：`read` 的 PDF 分支是 **Chromium 截图**（RL 无 browser）；文本抽取的 `pdfToMarkdown` 是 **native**（`pdf-inspector` crate）。

**待裁定**：(a) 引入 native PDF crate（新增 build/边界脚本负担，与 B2 同类）；(b) 只做「PDF 元信息 + 不可读提示」的降级分支；(c) 不做。
markit 的 DOCX/PPTX/XLSX/EPUB 是**纯 TS**，可独立于 PDF 立项（属 parity 00 §3 #9 `markit/` 的独立专题，**不在本计划**）。

---

## 4. 阶段 C：工具呈现层

**触发条件**：A/B 落地后，`standard` 的工具数接近 provider 上下文预算时。parity/02 §8 的判断是当前**不需要**；本计划不提前实现。

**设计输入**（已取证）：

- RL 已有 `splitDeferredTools`（provider-gated + 历史 `addedToolNames`），但**无生产者**。
- 与 omp 的差异：omp 的 `xd://` 是 provider-agnostic（`read`/`write` 当传输层），RL 若要达同等需新增 `read`/`write` 的设备寻址语义 + 文档内联预算（上游 `XDEV_DOCS_TOTAL_BUDGET=48_000`、`XDEV_DOCS_PER_DEVICE_CAP=10_000`、`XDEV_EXTERNAL_DESCRIPTION_CAP=200`）。
- 上游不可下沉的 12 个 essential 与 5 个 `XDEV_KEEP_TOP_LEVEL`（`todo`/`yield`/`ask`/`grep`/`web_search`）可作为名单设计的参考，但 **RL 的对应集合必须按 RL 的实际工具表重新判定**，不得照抄。
- RL 的 Harness Profile（`standard` 直通 / `minimal`·`plan` allowlist + 冻结 digest）是**整体替换**语义；呈现层是**逐工具预算**语义，两者正交，不能互相替代。

**待办**：实测工具 schema 的 token 占用 → 定阈值 → 选机制（扩展 deferred 通道 vs 引入 `loadMode` 等价物）→ 单独阶段文档。

---

## 5. 验收与证据

| 阶段 | 证据 |
|---|---|
| A1 | 见 §5.1（已取得：92 项定向测试、`tsc` src+tests 0 错、`check:execution-boundaries` 通过）|
| A2 | 工具级测试（含 headless fail-fast）+ TUI 分派测试；真实 TTY 提问一次 |
| B* | 依裁定结果另立 |
| C | 依实测数据另立 |

---

## 5.1 A1 落地结果（2026-09-18）

| 交付物 | 说明 |
|---|---|
| `src/websource/internal/ar/**`（36 → 35 文件）+ `internal/lru.ts` | 自 `packages/utils/src/ar/**` 复制。裁剪：删 `write.ts`（归档创建，read 不需要）、删 `fileByteSource`/`httpByteSource`（raw-fs 与出站旁路）、`ArchiveSource` 收窄为「字节」或「显式 ByteSource」、`extractArchive` 删除（解压写盘不属于 read）。Bun API 换实现：`Bun.CryptoHasher`→`node:crypto`、`Bun.hash.crc32`→纯 TS 表驱动、`Bun.file`（unpacked ASAR member）→ typed 拒绝 |
| `src/runtime/tools/read-archive.ts` | 新文件。`parseArchiveReadTarget`（形状判定，处理 `a.zip:inner` 的冒号歧义）+ `looksLikeArchiveBytes`（字节嗅探）+ `readArchiveBytes`（清单/成员/二进制三类渲染） |
| `src/runtime/tools/read-sqlite.ts` | 新文件。`parseSqliteReadTarget`（扩展名边界切分，处理 `db.sqlite:users:1`）+ `looksLikeSqlite`（魔数）+ `readSqliteBytes`（selector 解析与渲染，939 行） |
| `src/storage/readonly-sqlite.ts` | 新文件。驱动适配器（node/bun 分支、只读打开、`query_only`、Node 临时文件反序列化）。**放在 storage 层的原因**：它需要 `node:fs`，而 `src/runtime/tools/**` 被 `check:execution-boundaries` 禁止 raw fs——与 `session-store/database.ts` 同层同理由 |
| `src/runtime/tools/read.ts` | 在 `splitPathAndSel` **之前**插入两条分派；`ReadToolDetails` 增加 `media?: "sqlite" \| "archive"`。**schema 与 claim 未变**（故 standard golden digest 不变） |
| `tests/runtime/tools/{read-archive,read-sqlite,read-dispatch}.test.ts` | 41 项（13+17+11）|

**验证证据**

- `npx vitest run tests/runtime/tools/ tests/stdlib-tools.test.ts tests/read-selector.test.ts` → 7 文件 / **92 项全绿**（含既有 read 行为用例，无回归）。
- `npx tsc -p tsconfig.json --noEmit` 与 `tsconfig.tests.json` → **0 错**。
- `npm run check:execution-boundaries` → 通过（sqlite 的 `node:fs` 已移出工具层）。
- `read-dispatch.test.ts` 是本阶段的核心回归：证明 `db.sqlite:users`、`db.sqlite:users:2`、`db.sqlite?q=…`、`a.zip:member.txt`、`a.zip:nested/deep.txt` 都走到正确分支，且 `.db` 后缀的纯文本文件回落文本。

**实施中修正的设计点**（原计划未预见的两个坑）

1. **归档形状判定的前置门是错的**：原打算用「整串以归档扩展名结尾」做门，但 `a.zip:inner` 的末尾是成员名，该门会把所有带成员的读取挡掉。改为直接用 `parseArchiveReadTarget` 作形状判定。
2. **两条分支都要字节嗅探兜底**：只有扩展名/形状不足以判定类型（`notes.db`/`notes.zip` 可能是文本），因此命中形状后仍需魔数/嗅探确认，失败即回落文本路径。

**已知边界**（由子实现者如实记录，非本次可修）

- **WAL 侧车不可见**：只拿到主库字节，见不到 `-wal`/`-shm`；若最新事务未 checkpoint，读到的是旧快照（表现为「表不存在」而非报错）。这是「字节输入」契约的固有限制（上游能直读文件+侧车）。
- `?` 之后按 URL query 解码（上游同款）：`+` 会被解成空格，字面量需写 `%2B`。
- `sqlite_stat1` 的估计分支只在表行数 > 50k 时生效，测试未覆盖。

---

## 6. 复现命令

```sh
OMP=/data2-HDD-SATA-20T/Digital_avatar/haoweiyao/oh-my-pi
# 纠正 parity 00 的三处描述
ls $OMP/packages/coding-agent/src/tools/{rewind.ts,read-pdf.ts} 2>&1   # rewind 不存在；read-pdf 是 helper
grep -n "renderPdfPageScreenshot\|splitPdfImageReadPath" $OMP/packages/coding-agent/src/tools/read-pdf.ts
grep -n "class RewindTool\|class CheckpointTool" $OMP/packages/coding-agent/src/tools/checkpoint.ts

# ast 依赖真相（无回退）
grep -n "from \"@oh-my-pi/pi-natives\"" $OMP/packages/coding-agent/src/tools/ast-{grep,edit}.ts
grep -n "Failed to load pi_natives" $OMP/packages/natives/native/loader-state.js

# archive 解码器纯 TS
grep -rn "from \"" $OMP/packages/utils/src/ar/*.ts | grep -v '"\./\|\.\./format\|\.\./lru\|node:' | head

# markit PDF 是否 native
head -3 $OMP/packages/coding-agent/src/markit/converters/pdf/index.ts

# RL 侧
rg -n "splitPathAndSel|isRangeOrTailChunk" src/runtime/tools/read-selector.ts
rg -n "splitDeferredTools" src/api/
rg -n "reverse_request_unhandled|pollIntervalMs" src/runtime/session-server/client-transport.ts src/runtime/session-runtime/approval-reverse-request.ts
rg -n "isStableForkBoundary" src/storage/session-store/fork-projector.ts
```

---

## 5.2 A2 落地结果（2026-09-18）

| 交付物 | 说明 |
|---|---|
| `src/runtime/session-runtime/ask-reverse-request.ts` | 新文件。`ask_prompt` 帧的编解码 + `AskPort` + `createReverseRequestAskPort`。复用 credential 通道的同一个 `ReverseRequestSender`，**每次调用只投递一帧**：`reverse_request_unhandled` → 立即抛（不重试），`aborted` → cancelled，答案不匹配 → invalid_response。`timeoutMs` 只是投递上限（缺省 `null` = 无 deadline，由 abort/断线释放），**从不当作重试周期** |
| `src/runtime/tools/ask.ts` | 新文件。TypeBox schema（1–4 问、每问 1–8 选项）+ 答案摘要渲染。**无 port 时硬失败**（throw）而不是返回「已询问」 |
| `src/runtime/tools/capabilities.ts` | `ask` 归入只读 tier（与 `read`/`grep`/`glob`/`ls` 同 claim 桶）——它是纯交互、无文件/进程/网络副作用 |
| `src/runtime/tools/index.ts` | `StdlibToolsOptions.askPort` + 条件注册（与 `web_search`/`request_permissions` 同款三态写法） |
| `src/cli/embedded-session-runtime.ts` + `src/runtime/session-runtime/domain.ts` | **生产接线**：在 owner claim 后构造 `createReverseRequestAskPort({ sender: server, connectionId: () => server.driverConnectionId() })`，经 `SessionDomainCompositionOptions.askPort` → `productionSessionTools` → 注册 |
| `src/tui/interactive/approval-workflow.ts` | `handleSessionReverseRequest` 新增 `ask_prompt` 分支（复用 `SelectorModal`；多选时重建 modal 保留光标） |
| `tests/runtime/tools/ask.test.ts`(12) + `tests/tui/ask-reverse-request.test.ts`(6) | 18 项 |

### 子实现者未接线，由我补上（值得记录）

`AskTool` 交付时**只提供了 `askPort` 选项，没有构造它**——`grep createReverseRequestAskPort` 在生产零命中，意味着 `ask` 在任何真实会话里都不会注册。这正是 Plan 16 §1.1 记载的「已声明但实际不存在」那类缺陷（`TodoWrite`/`Task*` 当年同样如此）。我按 approval 通道的既有分层补了生产接线，并用真实 CLI 的 durable `harness.composed` receipt 验证：`standard@2` 的工具表从 27 → **28**，`ask` 在列。

### 验证证据

- `npx vitest run tests/runtime/tools/ask.test.ts tests/tui/ask-reverse-request.test.ts tests/stdlib-tools.test.ts tests/security/plan-mode-tool-admission.test.ts` → 56 项全绿；ask 两文件 **68ms**（证明无重试等待）。
- `npm run check` 全链 0 错（**730** consumers / 0 diagnostics）。
- `npm run build` 通过；真实 CLI 隔离 `RUNLEDGER_DIR` 下 `ask` 出现在组合表中。

---

## 5.3 Stage C 触发条件评估（结论：暂不实施）

parity/02 §8 的触发条件是「工具数接近 provider 的 schema 预算」。**实测（2026-09-18）**：

| 度量 | 值 |
|---|---|
| `createStdlibTools` 工具数 / 序列化 schema 字节 | 14 个 / 8,447 B（≈2,112–2,347 tokens）|
| `productionSessionTools` | 11 个 / 7,402 B（≈1,851 tokens）|
| **真实 standard@2 完整表（27 个工具，含 plan/goal/Skill/mcp_*）** | **≈4,543 tokens** |
| 占 200k 上下文 | **≈2.27%** |

度量方式：对每个工具取 `JSON.stringify({name, description, parameters}).length` 求和，再用 bytes/4 与 bytes/3.6 给出 token 区间（中英混排的上/下界）。

**结论**：工具 schema 只占上下文的 ~2.3%，离任何 provider 的预算上限都很远。A1/A2 之后表只增 1 个工具（`ask`）。因此**呈现层（`ToolLoadMode` / `xd://` 等价物）当前没有收益**，不实施；parity/02 §8 的判断经实测成立。

**重新评估的触发条件**（写入本计划，供后续引用）：真实 standard 表的 schema 超过上下文窗口的 ~15%，或 provider 明确报 schema 长度错误时，再启动 Stage C；设计输入已备（见 §4）。
