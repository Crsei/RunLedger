# oh-my-pi 工具面对齐更新计划

> 状态：**实施中**。范围已由用户裁定（见 §1.4）。参考基线：本机 oh-my-pi `3b3a6dc9bb`（`packages/coding-agent` v18.1.17）与当前 RunLedger 工作树。历史 pi 移植说明不代表当前完成状态；实现进度以代码与门禁为准。

## 0. 结论

差异分四类，只有前两类是本计划的主体：

| 类别 | 内容 | 处置 |
|---|---|---|
| **A 接线缺陷** | 已组合的工具被 admission 名单拒绝（`spawn_agent`、`memory_*`）；已声明可达的工具实际不存在（TodoWrite/Task*）；TUI/Web 对新工具静默降级；legacy Host 与 Session domain 两套组合分叉；`terminate`/`addedToolNames`/`isReadOnly` 声明但 loop 不消费 | **P0，先修，不新增能力** |
| **B 模型面参数/语义对齐** | `read` 只有 `offset/limit`，无选择器；`todo` 是整盘覆写而非 op 模型；`bash` 缺 `env/cwd/pty`；`edit` 字段名与 omp 不同；`grep` 缺 `skip`；`find`/`glob` 职责重叠 | **P1，纯 TS，低风险** |
| **C 需要新 host port 或依赖决策** | internal-URL namespace、sqlite/archive/pdf 读取、`ast_grep`/`ast_edit`、`edit` 模式（hashline 等）、`web_search`/`github`/`ask`/`debug`/`eval`/memory/`checkpoint`+`rewind` | **P2/P3，按收益排序，逐项裁定** |
| **D 与已冻结边界冲突** | omp `task` 的 batch/workpool/worktree isolation/IRC/hub、可写 child、DAG、cost | **不移植**，见 §6 |

**结构性结论**：RunLedger 增加一个 model-facing 工具目前要协调 14 处硬编码点（§7），其中 `GOVERNED_TOOL_NAMES` 是静默拒绝、`ToolRegistry.register` 是静默丢弃。`spawn_agent` 已经因此失效。**P0.1 必须先把「工具名单」从字符串字面量改为组合期派生的实例集合**，否则后续每个新工具都会重演同类故障。

## 1. 事实基线

### 1.1 当前生产 model-facing 工具面

standard profile 的标准 Session 实际组合（`tests/runtime/session-runtime/harness-profile-standard.test.ts:47-60` 冻结为 golden，canonical digest `66d5088d…`）：

```text
read, write, edit, MultiEdit, bash, grep, find, glob, ls, WebFetch
+ lsp                       （仅 tools.mode === "standard"，src/runtime/session-runtime/domain.ts:222/628）
+ plan_read/plan_write/enter_plan_mode/exit_plan_mode   （domain.ts:230）
+ Skill / mcp_catalog / mcp_search / mcp_call           （extension-composition.ts:156-159）
+ spawn_agent               （multi-agent 双门禁开启时，domain.ts:449）
```

不在生产面：`TodoWrite`、`Task`/`TaskUpdate`/`TaskList`、`NotebookEdit`、`echo`（`domain.ts:618-619` 显式排除后两者）。`createExtendedTools`（`src/runtime/tools/index.ts:191`，唯一注册 TodoWrite 的工厂）在 `src/` 内**零调用者**。

### 1.2 逐工具差异（omp 基线 → RunLedger 现状）

| 工具 | omp | RunLedger | 差距性质 |
|---|---|---|---|
| `read` | 仅 `{path}`，选择器内联：`file:A-B` / `:raw` / `:-N` / `:conflicts` / `:img` / `?q=`，另有 sqlite/archive/pdf/notebook/目录/内部 URL/SSH 分支（`tools/read.ts:1266` cascade） | `{path, offset?, limit?, lineNumbers?, noCache?}`，纯文本，无选择器与多模态（`src/runtime/tools/read.ts:29-42`） | B（选择器）+ C（多模态） |
| `edit` | 5 模式，默认 `hashline` `{input}`；replace 模式字段为 `old_string/new_string/replace_all`（`edit/schemas.ts:3`，`utils/edit-mode.ts:6`） | 单模式 `{path, edits:[{oldText,newText,replaceAll?,findActualString?}]}`（`src/runtime/tools/edit.ts:37-45`） | B（字段名）+ P3（模式需 native） |
| `MultiEdit` | 无此工具 | `{filePath, edits:[{oldString,newString,replaceAll?}]}`（`src/runtime/tools/multi-edit.ts:21-36`）——同仓库内 `oldText` / `oldString` 两套命名 | B |
| `bash` | `{command, env?, timeout?, cwd?, pty?}`（`tools/bash.ts:321`） | `{command, timeout?, stdin?, run_in_background?, output_format?}`（`src/runtime/tools/bash.ts:21-42`） | B（受治理约束裁定） |
| `grep` | `{pattern, path?, case?, gitignore?, skip?}`，自持 Rust regex + PCRE2、`\n` 跨行、内部 URL | `{pattern, path?, glob?, ignoreCase?, literal?, context?, afterContext?, beforeContext?, multiline?, outputFormat?, limit?}`，shell 出 `rg` 并回退 `grep -rn`（`src/runtime/tools/grep.ts`） | B（补 `skip`） |
| `glob` | `{path?, hidden?, gitignore?, limit?}`；`find` 只是别名（`tools/builtin-names.ts:38`） | `find`（`fd --glob` 退 `find -name`）与 `glob`（手写 `**` 递归、跳 `.git/node_modules`、mtime desc）**两个工具共存** | B（合并，破坏性） |
| `todo` | `{op: init\|start\|done\|rm\|drop\|block\|unblock\|append\|view, list?, task?, phase?, items?, reason?}` + phase 模型 + 单 in_progress 不变量（`tools/todo.ts:23/32`） | `TodoWrite{todos:[{content,status,priority?}]}` 整盘覆写（`src/runtime/tools/todo-write.ts:25`），且**未接入生产** | B + P0 |
| `ls` | 无独立工具 | 有（`src/runtime/tools/ls.ts`） | RunLedger 更宽，保留 |
| `WebFetch` | 无（有 `web_search` + 内部 URL 抓取） | `{url, prompt, maxBytes?}` 走 governed network（`src/runtime/tools/web-fetch.ts`） | 保留；`web_search` 属 P2 |
| `lsp` | 同源 schema，`timeout` 5–300s | 同源，1–300s（`src/lsp/types.ts:265-275`） | 一致 |
| 缺失 | `ast_grep`/`ast_edit`/`ask`/`debug`/`eval`/`github`/`web_search`/`security_scan`/`checkpoint`/`rewind`/`context_notes`/`new_context`/memory 四件套/`manage_skill`/`learn`、隐藏 `yield`/`goal`/`think` | 无 | C（§5） |
| RunLedger 独有 | — | `MultiEdit`、`ls`、`echo`、`process_output`/`process_wait`/`write_stdin`/`process_stop`/`process_resize`、`request_permissions` | 保留，是治理资产 |

### 1.3 用户裁定（2026-09-16）

1. **`find` 与 `glob` 合并为单一 `glob`**，`find` 保留为调用名别名（不新增注册条目）。
2. **`TodoWrite` 替换为 omp 的 `todo` op 模型**；`Task`/`TaskUpdate`/`TaskList` 随之退役。
3. **legacy Host 按 Runtime 06 删除**，本计划不修。
4. **hashline / `ast_edit` / `ast_grep` 先不实现** —— 它们同属 native addon 依赖（§5），本期不做，也不为其搭依赖脚手架。

### 1.4 实施结果（本次）

| 项 | 结果 |
|---|---|
| P0.1 admission | `GovernedToolAuthorizationPolicy` 改为按组合实例身份判定 `admittedTools`；`spawn_agent` 经完整 Session 链路复现放行（`tests/integration/multi-agent-bounded.test.ts` 新增用例） |
| P0.2/P1.4 `todo` | `src/runtime/tools/todo.ts` 新增 op 模型；接入 `createStdlibTools`（ledger 选项）与 standard profile；`TodoWrite`、`Task*` 及其专用测试删除 |
| P0.3 展示层 | `todo` 走 plan renderer；`find` 从 renderer/exploration/web 表移除（别名调用解析到 glob 实例） |
| P0.4 冲突可见性 | `ToolRegistry.listConflicts()` + `registerStrict()`；legacy Host 组合点改用 strict |
| P1.1 `read` 选择器 | `src/runtime/tools/read-selector.ts`（`:N-M` / `:N+K` / `:N-` / `:-N` / 多段合并 / `:raw`；`:conflicts`/`:img` 显式报错） |
| P1.2 `edit`/`MultiEdit` | 字段统一为 `oldText`/`newText`；`prepareArguments` 兼容 `old_string`/`new_string`/`replace_all` |
| P1.3 `grep` | 新增 `skip`（按命中文件翻页） |
| P1.6 `glob` | 承接 `find` 语义（无 `/` 的 pattern 任意深度）、`;` 多 pattern、`hidden`、`gitignore`（根 `.gitignore` 子集） |
| profile 版本 | `plan@2` 新增并成为 live plan profile；`plan@1` 与冻结摘要保留供既有 Session 重放；冻结值收敛到 `frozen-manifests.ts` 单一来源 |
| P0.5 死字段 | `AgentToolResult`/`ToolResultContent`/`AfterToolCallResult` 的 `terminate` 删除（从未被读），loop 透传逻辑一并移除；`addedToolNames`/`isReadOnly`/`isConcurrencySafe` 的注释改为写实 |
| 存储 schema | V6 → V7 离线迁移把 plan@2 triple 加入 `sessions_harness_profile_invariant_*` 白名单；`SESSION_STORE_SCHEMA_VERSION=7`、`MAX=7`、`CURRENT=7` |

未做（按裁定 4）：`edit` 多模式（hashline/patch/apply_patch/sloppy）、`ast_grep`、`ast_edit`。

## 2. P0：接线与事实修正（不新增能力）

### P0.1 `spawn_agent` 与 `memory_*` 在生产必然被拒

事实：`GovernedToolAuthorizationPolicy.applyGovernedCeiling` 在 `request.tool.name ∉ GOVERNED_TOOL_NAMES` 时无条件返回 deny（`src/security/integration/runtime-tool-authorization.ts:82-84`，名单 `:21-50`），与 Plan Mode 无关。而 `spawn_agent`（`src/runtime/agents/spawn-tool.ts:58`）由 `controller.addTools`（`src/runtime/session-runtime/domain.ts:449`）注入，policy 正是这个 governed policy（`domain.ts:333-336`），`beforeToolCall` 会执行它（`src/runtime/interactive-session-controller.ts:639-647`）。

已复现：把 `spawn_agent` 工具实例喂给 `new GovernedToolAuthorizationPolicy()`，得到
`{"decision":"deny","reason":"tool spawn_agent is not admitted by the governed composition"}`。

现有集成测试没暴露它，因为 `tests/integration/multi-agent-bounded.test.ts:202` 直接调 `childTool.execute(...)`，绕过了 `beforeToolCall`。`memory_search`/`memory_get`/`memory_propose`（`src/runtime/tools/plan-memory-tools.ts:114/152/185`，由 `src/cli/runtime-host-session.ts:225-227` 注册）同样缺席。

修法（结构性，不是再补 4 个字符串）：`GovernedToolAuthorizationPolicy` 改为由 composition 注入**该 Session 实际组合出的工具实例/名单**（与 plan 工件工具已采用的按对象身份判定一致，`runtime-tool-authorization.ts:86-93`），静态字面量名单删除或降级为「未注入时的保守默认」。

- RED：`tests/security/plan-mode-tool-admission.test.ts` 增加"组合出的每个工具都必须被 allow"用例，参数化覆盖 `spawn_agent` 与 `memory_*`；再补一条走真实 `beforeToolCall` 的 `spawn_agent` 拒绝/放行断言（替换现有绕过路径的结论）。
- GREEN：policy 构造签名 + 全部 4 个构造点（`session-security.ts:253`、`session-runtime/domain.ts:333`、`cli/runtime-host-session.ts:231`、`cli/runtime-host-security.ts:241`）。
- DoD：`spawn_agent` 在 multi-agent 双门禁开启时通过 admission；关闭时不注册且无 admission 记录。

### P0.2 TodoWrite / Task* 的文档与实现不一致

事实：`src/runtime/tools/index.ts:191` 的 `createExtendedTools` 无 `src/` 调用者；生产不注册 TodoWrite；但 `src/cli/runtime-host.ts:329` 的 `currentTools` 仍列 `Task/TaskList/TaskUpdate`，`src/tui/components/tips.txt:83-84` 声称 `createExtendedTools` 会注入 TodoWrite 与 Task 三件套，`docs/subsystems/tools.md:15` 与 `src/runtime/session-runtime/domain.ts:610` 的注释也列举 todo/task。

处置：与 P1.4 合并——把 todo 按 omp op 模型实现并真正接入 standard profile；`Task`/`TaskUpdate`/`TaskList` 作为 todo 的内部实现保留（现状即如此），不再出现在任何面向模型的名单里；同步删除 `createExtendedTools` 或改为 todo 的工厂入口。

### P0.3 新工具在展示层静默降级

- `src/tui/presentation/tools/projector.ts:102` `rendererForTool` 的 `default: generic`，`:347` `projectToolResultMetadata` 同样 `default {kind:"generic"}`；新工具只拿到标题 + 原始文本。
- `web/src/tool-render/registry.tsx:13` 的 `RENDERERS` 表缺新工具即回退 generic；更严重的是 `src/web/timeline-projector.ts:41` 的 `inputPreview` **恒为空**，所以 Web 侧所有工具的输入都无法显示。

处置：把 `exploration.ts:13/92`、`projector.ts:102/347`、`web/src/tool-render/registry.tsx:13` 的覆盖情况纳入 §7 checklist，并在 `tests/tui/presentation/tools/projector.test.ts` 增加"每个生产工具名都有非 generic renderer 或显式登记为 generic"的表驱动用例；`inputPreview` 为空是独立缺陷，单列修复。

### P0.4 legacy Host 与 Session domain 组合分叉

`src/cli/runtime-host-session.ts:212-216` 的 `createStdlibTools` **不排除** `Skill`/`NotebookEdit`/`echo`（与 `domain.ts:618-619` 相反），并额外注册 `plan-memory-tools.ts`；其中 `plan_write`（`plan-memory-tools.ts:68`）与 `src/runtime/session-runtime/plan-tools.ts:71` 同名。`ToolRegistry.register` 对同名是 first-wins **静默丢弃**（`src/runtime/tool-registry.ts:56-65`），而 `controller.addTools` 抛错（`interactive-session-controller.ts:422-424`）——同一冲突在两条路径下行为不同。

处置：按 Runtime 06 的既有方向删除 legacy Host；在删除落地前，把 `ToolRegistry.register` 的冲突改为显式诊断（保留 first-wins 但返回可观测结果），并让两个组合的同名工具不再并存。

### P0.5 声明但未实现的契约字段

证据汇总：

| 字段 | 声明 | loop 实际行为 |
|---|---|---|
| `AgentToolResult.terminate` | `src/runtime/types.ts:147`、`ToolResultContent.terminate` `:195` | 全程透传（`tool-call-execution.ts:103` → `tool-call-finalization.ts:38/51/69/90`），**从未被读**；续跑只由 `loop-runner.ts:565-566` 决定。生产工具一律硬编码 `terminate: false` |
| `AgentToolResult.addedToolNames` | `types.ts:146`，注释称"请把列出的工具加入 `AgentContext.tools`" | loop 不改 `context.tools`（唯一改写点 `loop-runner.ts:601-608`）；只有 wire 层按历史 `addedToolNames` 做 deferred loading（`src/utils/deferred-tools.ts:8-37`） |
| `AgentTool.isReadOnly` | `types.ts:111`，注释称"预算与 ledger 主动记账看 isReadOnly" | loop 不消费；真实消费者只有 child subset（`agents/capability-subset.ts:114-119`）与 MCP 描述符 |
| `executionMode`/`isConcurrencySafe` | 已实现批量降级（`tool-call-preparation.ts:85-105`） | 所有生产组合传 `toolExecution: "sequential"`（`interactive-session-controller.ts:677`、`agent.ts:169`、`agents/child-runtime.ts:216`）→ 并行分支不可达 |

处置遵循 Runtime 08 §9「不得以空字段或 placeholder 提前进入 public contract」：要么实现（`terminate` 的批次早停语义简单，可做），要么删除字段与误导性注释（`addedToolNames` loop 级、`isReadOnly` 预算说法）。并行调度是否启用属独立决策，本计划不改。

## 3. P1：纯 TS 的模型面参数对齐

前置约束：**先做 P0 的名单收敛**。任何工具名/`description`/`parameters` 变化都会改变 `toolManifestDigest`/`compositionDigest`（`src/runtime/harness-profiles/tool-receipt-table.ts:6`、`composition.ts`），而 minimal/plan 的 manifest 是**冻结 pin**（`tool-projection.ts:7-10`、`composition-receipt.ts:99/102-108`），不同步就 replay fail closed。每个 P1 项必须同一 commit 内更新 golden 与 pin。

- **P1.1 `read` 选择器**：移植 omp 的纯 TS 选择器（`tools/read-selector.ts:70 parseSel`、`tools/path-utils.ts:243/276/311`、`splitPathAndSel:349`），支持 `path:A-B`、`path:raw`、`path:-N`、`path:conflicts`，保留既有 `offset/limit` 作为等价写法。`read` 的 capability claim 与 approval 分级不变。这是收益最高、依赖最少的一项。
- **P1.2 `edit` / `MultiEdit` 字段归一**：在既有 `prepareArguments` 垫片（`src/runtime/tools/edit.ts:62-117`）里同时接受 `old_string/new_string/replace_all`，并统一 `MultiEdit` 的 `oldString` → `oldText`。schema 主字段保持 RunLedger 现名，避免破坏 golden；`prepareArguments` 是契约内允许的兼容垫片。
- **P1.3 `grep` 补 `skip`**：对齐 omp 的翻页语义（`tools/grep.ts` 的 `skip` 描述），实现沿用现有 `rg` 调用加结果偏移，保留 RunLedger 已有的 context/literal/outputFormat。
- **P1.4 `todo` op 模型替换 `TodoWrite`**：op 集合与 phase 模型按 omp（`tools/todo.ts:23/32`），持久化走 RunLedger 既有 `LedgerSink`（`src/runtime/tools/todo-write.ts:46-48` 现有接线），并把完成转移作为可观测 `details` 返回。同时补齐 P0.2 的生产接入与文案。
- **P1.5 `bash` 参数**：`env`/`cwd` 会触及 workspace containment 与 Security 约束（`src/workspace/`、`src/security/`），**不得直接透传**。先出结论：要么在 governed 层做显式收窄（`cwd` 必须落在 workspace 内、`env` 过既有 env 白名单），要么在文档中明确拒绝并说明理由。不允许以"参数对齐"为由绕过治理。
- **P1.6 `find`/`glob` 合并**：依赖 §1.3 决策 1。若合并，按 omp 的 `LEGACY_BUILTIN_TOOL_NAME_ALIASES` 做法（`tools/builtin-names.ts:38`）保留 `find` 输入别名，同步 TUI renderer、web registry、golden 与 manifest pin。

## 4. P2：需要新 host port

按收益/成本排序，每项独立裁定：

| 项 | omp 机制 | RunLedger 需要的 port | 备注 |
|---|---|---|---|
| internal-URL namespace 注册表 | `internal-urls/router.ts:32`（15 handler）+ handler 契约 `internal-urls/types.ts:197` | 新增 router port；`read`/`write` 走 `resolve` | RunLedger 已有 `local://`（plan 沙箱）与 trace CAS，可先接 `artifact://`/`skill://`/`memory://` |
| sqlite 读取 | `tools/sqlite-reader.ts`（`bun:sqlite` + query_only + ASCII 表） | 无新 port | RunLedger 是 Node/Bun 双运行时（`engines: node>=22.19, bun>=1.3`），已有 `node:sqlite` 适配（`src/storage/session-store/database.ts:18-33`），可复用该运行时分支模式 |
| archive / pdf / docx 读取 | `read-archive.ts` + `utils/src/ar/*`（纯 TS 解码器）+ markit（pdf 走 native `pdfToMarkdown`） | 文档转换 port | 纯 TS 部分可移植；pdf 需 P3 的依赖决策 |
| `web_search` | `web/search/index.ts`（17 provider + fallback 链） | governed network 通道 + provider 凭据解析 | RunLedger 已有 `WebFetch` 的 network claim 与 gateway 路径，可复用 |
| `github` | `tools/gh.ts`（shell 出 `gh` CLI） | managed process（已有）+ `gh` 二进制 | 也可改走 REST API 免二进制依赖 |
| `ask` | `tools/ask.ts`（多问题、超时默认选项、自定义输入窗口） | TUI 问答 port | 可复用既有 reverse-request 机制（`session.approval.reverse` 同款模式） |
| `checkpoint` / `rewind` | 工具本身极薄；实质是 session 树分支 + summary（`sessionManager.branchWithSummary`） | 可分支 session store | RunLedger 是 hash-chain events + checkpoint cache，分支是新增能力，**风险最高，建议最后做** |

## 5. P3：依赖决策（唯二岔口）

1. **`ast_grep` / `ast_edit`**：omp 全靠 native（`pi_natives`，`ast-grep-core 0.39.9` + `tree-sitter 0.25.10` + ~40 grammar）。RunLedger 已有两条先例：napi-rs 自建 crate（`native/syntax-highlighter`，`npm run build:native`）与 **WASM tree-sitter worker**（`src/security/permission/bash-ast/`，依赖 `web-tree-sitter`/`tree-sitter-bash`）。选项：(a) 自建 ast-grep crate（能力最全，新增 build/边界脚本负担）；(b) 用既有 WASM tree-sitter 自实现 pattern 匹配（无 metavariable `$$$` 语义，能力缩水）；(c) 不做。需要用户裁定。
2. **`edit` 多模式（hashline/patch/apply_patch/sloppy）**：omp 的行寻址与 wire grammar 在 native（`EditSession`/`editGrammar`/`EditStore`），且 hashline 是默认模式。纯 TS 只可等价实现 `replace`（RunLedger 已是等价物）与 `sloppy`。在没有 native 的前提下 **不建议** 先做 hashline；`patch`/`apply_patch` 可作为纯 TS 增量（差异格式明确）。

依赖决策落地时，必须同步：`native/` 新 crate 的 build 脚本、`scripts/check-*-boundaries.ts` 静态边界、`npm run build:native` 与 CI 分组。

## 6. 不移植（与已冻结边界冲突）

以下 omp 能力与仓库既有边界直接冲突，本计划不纳入，且不得以"对齐 omp"为由顺带引入：

| omp 能力 | 冲突来源 |
|---|---|
| `task` 的 batch 形态 / `workpool` / 并行 spawn / DAG / 递归委派 | `AGENTS.md` §2「产品内 child 委派保持默认关闭、root-owned sequential readonly、depth=1、同一 root 最多一个 child」；Runtime 08 §9 非目标 |
| child 可写工作区 / worktree isolation / apply-merge | Runtime 08 §9「可写 child / 独立 worktree」「Artifact/CAS/handoff/merge」 |
| `hub`（IRC + 跨 session 消息 + 进程监督） | 属跨 session 协调，超出 root-owned 单 child 边界 |
| cost / USD 预算 | Runtime 08 §9「USD 成本限制」 |
| sandbox 相关的 read/write 分支 | `AGENTS.md` §2 Sandbox 段 |
| `xd://` 设备挂载、INTENT_FIELD `i` 注入、TTSR 流式匹配 | 均是**全局 wire/prompt 变更**（影响所有 provider 与 grammar），收益与风险不成比例。列为远期候选，本计划不含 |

## 7. 新工具准入 checklist（P0.1 完成后收敛为 6 步）

现状 14 处（`GOVERNED_TOOL_NAMES`、`CHILD_CAPABILITY_TOOL_NAMES`、`capabilities.ts` 三张表、harness allowlist + 冻结 digest、`MINIMAL_MANIFESTS`、`composition-receipt` pin、TUI renderer/types/exploration、web RENDERERS、legacy `currentTools`、prompt 文本、docs）；P0.1/P0.4 落地后应只剩：

1. 在 `src/runtime/tools/<name>.ts` 定义 `AgentTool`，声明 `capabilityClaims`（缺 claim ⇒ Plan Mode 一律 `plan_mode_unknown_effect` 拒绝，`src/runtime/modes/plan/policy.ts:51-59`）。
2. 在 `createStdlibTools`（`src/runtime/tools/index.ts:67`）注册，或在组合点显式注入（`domain.ts:230` / `:257-260` / `controller.addTools`）。
3. 判定是否需要进入 minimal/plan allowlist；若需要，同步冻结 manifest digest 与 receipt pin。
4. 判定 access classification（`src/security/permission/access-resolver.ts:33/36/45`），否则落进不透明的 `{kind:"tool"}` 分支，filesystem/network 规则不再适用。
5. 补展示：TUI `rendererForTool` + `SafeTool*` 联合类型 +（读类工具）`explorationKindForTool`；Web `RENDERERS`。
6. 更新 golden/digest 测试与 `docs/subsystems/tools.md`。

## 7.1 本次验证证据

| 项 | 证据 |
|---|---|
| `npm run check` | 全绿（含 boundaries、`check:consumers` 643 consumers / 0 diagnostics、`tsc -p tsconfig.json`） |
| `npm run test:runtime` | 全绿 |
| `npm run test:security-storage` | 全绿 |
| `npm run test:integration` | 全绿（含新增的 `spawn_agent` 经生产 `beforeToolCall` 放行用例） |
| `npm run build` | 通过 |
| 真实 CLI：plan@2 | 隔离 `RUNLEDGER_DIR` 下 `runledger --mode plan`，TUI 显示 `Harness: plan@2`；durable `harness.composed` receipt 记录 profile `plan@2`（digest `673c04aa…`）与工具表 `read, glob, ls, plan_read, plan_write` |
| 真实 CLI：schema V7 | 全新隔离 home 由 built CLI 安装 `schema_meta.schema_version = 7` |

**未取得的证据**：standard profile 的 prompt 驱动 receipt 需要可用模型凭据（TUI 只在首个 prompt 后提交 session 行），本次未做；standard 工具表由 golden 测试与生产 controller 集成测试覆盖，不等同于 built-CLI 人工确认。

## 8. 验收与证据

每阶段按仓库既有纪律：先提交能稳定失败的 RED，再 GREEN，最后在重复/更宽门下取 Stable Green。

```bash
npm run check                    # 含 storage/runtime/contract/execution/platform/session-owner/package boundaries
npm run test:runtime             # tests/runtime/** 桶
npm run test:security-storage    # admission / capability / claim 变更
npm run test:integration         # multi-agent 端到端
npm run build                    # P3 触碰 native 或 dist 时必需
```

必须同步更新的冻结物（任一项遗漏即 fail closed）：

- `tests/runtime/session-runtime/harness-profile-standard.test.ts:47-60`（生产工具名有序 golden + canonical digest）
- `tests/runtime/harness-profiles/tool-projection.test.ts:7`（`MINIMAL_TOOL_MANIFEST_DIGEST`）与 `tests/runtime/harness-profiles/standard-plan-tool-guard.test.ts:13`
- `src/runtime/harness-profiles/tool-projection.ts:7-10`、`composition-receipt.ts:99/102-108`
- `tests/stdlib-tools.test.ts:313-336`（registry size 与 `has()` 显式清单）
- `tests/security/current-boundary.test.ts:44-51`（静态边界扫描，对新增 `createStdlibTools(cwd)` 调用点敏感）

真实 CLI/TUI 证据按 `AGENTS.md` §5：改运行时代码后 `npm run build`，用隔离 `RUNLEDGER_DIR` 与真实 TTY/tmux 验证；自动化通过不等于 human-verified。

## 9. 风险与依赖

- **冻结 digest 是最大的连带面**：P1 任一项都会改 golden 与 pin，必须同 commit 完成，不能拆。
- **P0.1 是其他一切的前置**：在名单仍是字符串字面量时新增工具，等于新增一个必然被拒的工具。
- **P0.4 与 Runtime 06 重叠**：legacy Host 的删除已在 Runtime 06 范围，本计划只提出"删除前先 fail closed"，不重复实现 Runtime 06 的验收。
- **P3 依赖决策阻塞 P2 的两项**（pdf 转换、ast 工具）；`web_search`/`github`/`ask`/sqlite/archive 不被阻塞。
- **不得以对齐为由绕过治理**：任何新工具必须走 `capabilityClaims` + `ExecutionGateway`，不得新开 raw I/O 或 AllowAll fallback（`AGENTS.md` §2）。
