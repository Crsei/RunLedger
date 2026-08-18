# RunLedger Session 命名与自动标题执行计划

> 状态：`implemented`。P0–P6 已实现，并有自动化、真实 provider/TTY 与全仓门禁证据。
> 基线日期：2026-08-16。

## Goal

把 oh-my-pi 的 Session display name / auto-title 语义适配到 RunLedger 的 Session Owner 架构：

- `sessionId` 继续是不可变的 durable identity、文件/数据库关联键和协议寻址键；
- 新增独立的可持久化 display title，供 session catalog、`/resume` picker、session strip 和 welcome/header 使用；
- 在首个满足条件的用户输入后异步生成标题；
- **标题生成默认复用当前 coding session 选中的 active `provider/model`，不另选 tiny/smol/固定模型**；
- 用户手动命名一旦成功，自动命名永远不能覆盖；
- 标题生成失败、超时、被取消或模型未选中时，不阻断正常 prompt，也不把失败伪装成已命名。

## Architecture decision

标题是 Session Domain 的显示属性，不是 session identity，也不是 TUI 私有状态。

| 对象 | authority | 语义 |
|---|---|---|
| `sessionId` | Session Store / Session Owner | 稳定身份；创建后不可改；不因标题变化而变更 |
| `title` | owner-fenced Session Store projection + title event | 可选的用户可读名称；可以由 auto 生成，也可以由 user 覆盖 |
| `titleSource` | 同上 | `auto` 或 `user`；`user` 是自动更新的覆盖屏障 |
| first-user-message preview | Session Domain 查询投影 | 只作为未命名 session 的显示 fallback；不等于 title，不写回 title |
| 文件名、JSONL header、协议寻址 | 现有 canonical identity authority | 不改名、不重命名、不以 title 替换 ID |

所有标题读写都必须经过 Session Domain、typed adapter、owner fence 和 revision/CAS 检查：TUI、CLI、RPC 不得直接访问 SQLite 或 ledger。自动标题也属于当前 Session Owner 的内部 mutation，不能创建第二个 storage、Host 或命名服务。

### 默认模型决策（必须保持）

标题请求开始时捕获当前 `InteractiveSessionController.currentSelection`：

```text
titleModel = currentSelection.provider + "/" + currentSelection.model.id
```

该模型通过现有 Models / model request router / credential resolver 发起一次无工具、短输出、可取消的 completion。当前范围不解析或使用 `tiny`、`smol`、`commit` role，也不硬编码某个 provider/model；没有 active model 时保持未命名。后续若要允许独立标题模型，必须另立配置与安全边界变更，不能在本计划实现中暗中加入 fallback。

标题调用可以使用标题专用 system prompt、输出上限和 reasoning 限制，但 provider/model identity、认证来源和请求治理仍与当前 coding model 相同。标题请求不是 `Agent.prompt()`，不追加 user/assistant message、turn 或普通工具调用。

## Current baseline and gap evidence

以下是当前源码核实出的缺口，后续实现以这些 authority 为入口：

| Area | Current state | Gap |
|---|---|---|
| durable schema | `src/storage/session-store/schema.ts` 的 `sessions` 只有 workspace、status、时间、head、driver、settings 等字段 | 没有 `title`、source 或更新时间；当前为 legacy schema |
| storage API | `SessionCatalogRecord`、`createSession()`、`forkSession()`、`rowToCatalog()` 在 `src/storage/session-store/session-store.ts` 中没有标题字段 | 需要 owner-fenced title mutation、CAS 和 projection |
| Session Domain | 已有 `session.catalog.list`、`session.create`、`session.resume`、`session.fork` | 需要 catalog 标题投影和 typed title mutation/内部 title port |
| wire protocol | `src/runtime/session-server/protocol.ts` 有固定 capability/operation manifest、frame bounds 和 generation handshake | 需要注册 title operation，保持 stale/fail-closed 语义 |
| TUI catalog | `src/tui/sessions/types.ts` 的 `SessionCatalogItem` 没有 title；adapter 明确只投影 SQLite 真实字段 | 需要显式 title/source/preview，不在 TUI 猜测或补写 |
| TUI picker | `buildSessionPickerItems()` 当前主行使用短 session ID，搜索也只覆盖 ID/workspace/repository/status | 需要 title → first message → time 的显示优先级，同时保留 ID 可复制 |
| session strip | `projectSessionStrip()` 当前将 `bootstrap.session.id` 作为 `sessionLabel`；bootstrap 类型已预留可选 title 但未消费 | 需要 title label 与稳定 ID 的双重可见性 |
| model entry | `InteractiveSessionController.currentSelection` 在 `src/runtime/interactive-session-controller.ts` 返回当前 provider/model/thinking；`prompt()` 使用同一 selection | 这是自动标题的模型来源，不得新建独立模型选择逻辑 |
| ledger/header | `LedgerHeader.metadata` 可扩展，但 `src/runtime/ledger/types.ts` 不是 Session catalog authority | 不把标题塞入 metadata 作为第二套事实源 |

## Current implementation state and fresh evidence

### Worktree boundary

- 当前分支为 `session-owner-runtime`，HEAD 为 `4eecd49`；本轮标题实现/测试/计划仍在未提交工作树中。本轮未执行 commit、reset 或 push；工作期间检测到 HEAD 已由外部已有提交从 `b5100b2` 前进，提交边界以当前 Git 状态为准。
- 工作树同时包含用户已有的 idle-recap/provider 文档及其他 Runtime/TUI 改动；本计划只记录标题实现和为其新增的 Runtime title-event regression，不清理或覆盖无关改动。
- 上表是实现前的 gap baseline；下面的状态表和 fresh validation 才是当前实现事实入口。

### Implemented effects

- SQLite schema version 2 持久化 `title/title_source/title_updated_at_ms` 和 durable `catalog_revision`；legacy → current offline migration、digest、admission gate、projection replay/repair、owner-fenced CAS 已接入。
- `session.title_changed` contract、`session.title.set` domain/protocol、driver/generation/revision/recovery barrier 校验、TUI typed adapter 和 `/rename <title>` 已接入。
- 自动标题复用当前 coding session 的 active `provider/model`，走同一 model router，使用无工具、非 transcript 的 bounded completion；低信号/命令跳过，失败/取消可重试，手动标题和旧 generation 不能被覆盖。
- picker、search、session strip/header、title event requery/subscription 已使用 `title → first-user-message preview → time fallback`；自动标题提交后的 canonical event 也会经 SessionRuntime 广播到 owner subscriptions。

### Fresh validation (2026-08-16)

- focused title regressions：6 files / 38 tests passed，另有真实多连接 CAS worker；覆盖 storage title/migration、same-model lifecycle、domain/router、Runtime title event bridge。
- `npm run check` passed；包括 current-format、storage/runtime/execution/platform/TUI/session-owner boundaries、Rust syntax-highlighter 和 bash AST assets。
- 完整 Vitest passed：`383 files passed / 1 skipped`，`2325 tests passed / 3 skipped`；native OpenTUI `98 pass / 0 fail / 622 expect`。
- `npm run build` passed；`git diff --check` passed。

### Deferred acceptance

- 2026-08-16 隔离标准 PATH `runledger` + 真实 `node-pty` 已完成首个合格 prompt 的 provider 请求；SQLite 中形成 `session.title_changed` auto event，`modelRef` 精确为 `deepseek/deepseek-v4-flash`，且标题没有写入普通 assistant/user transcript。
- 同一隔离库已通过真实 TTY `/rename`、退出、冷启动 `--resume` 与 `/resume` picker；picker 能显示持久化标题，user rename 追加第二条标题事件并保持 `titleSource=user`。真实 `/fork` 生成不同 session ID，并复制 title state 与两条 title event history。
- 在不含 managed-process event 的全新隔离库中，终止旧 Bun owner、等待 heartbeat stale 后由第二个真实 TTY 进程接管：`owner.fenced`/`owner.taken_over`、generation `1 → 2`、recovery resume 和 takeover 后 `/rename` 均落库；title event 未被旧 generation 覆盖。
- 真实 provider failure 路径也已通过：一次性隔离 home 使用 dummy credential 使真实 DeepSeek 请求返回错误；随后第二条普通 prompt 仍形成 `role=user` ledger event，两个请求均未产生伪造 `session.title_changed`。本轮一次含有强制终止残留的旧 fork 在恢复时命中 `event_digest_mismatch` 并按 fail-closed 拒绝启动，未将该外部恢复损坏误记为标题回归。临时 credential/home 已清理，未输出 secret。
- 自动化已覆盖 owner fence、generation、manual-over-auto、fork/replay、projection drift/corrupt payload、recovery barrier、Runtime event bridge，以及两个真实 Node 进程/独立 SQLite connection 的 auto-title CAS 竞态。

## oh-my-pi behavior to adapt

参考实现：

- `oh-my-pi/packages/coding-agent/src/session/agent-session.ts`：首个合格用户输入触发异步 auto-title，并在完成时再次检查没有 user title；
- `oh-my-pi/packages/coding-agent/src/utils/title-generator.ts`：低信号输入预先跳过，使用 marker 解析，失败返回 `null`；
- `oh-my-pi/packages/coding-agent/src/prompts/system/title-system.md`：3–7 词、`<title>...</title>`，不命名时 `<title/>`；
- `oh-my-pi/packages/coding-agent/src/session/session-manager.ts`：`titleSource=user|auto`，手动标题阻挡 auto，title change 单独持久化；
- `oh-my-pi/packages/coding-agent/src/session/session-listing.ts`：显示优先级是显式标题、首条用户消息、时间 fallback，raw UUID 不作为友好名称。

RunLedger 只移植行为语义，不移植 oh-my-pi 的 JSONL/title-slot 文件格式、session 文件命名或 tiny/smol 模型选择策略。

## Scope and non-goals

### In scope

- SQLite legacy → current schema 的 title columns、offline migration、兼容性检查和 projection repair；
- `SessionCatalogRecord`、Session Domain、session protocol、TUI typed adapter 的标题 contract；
- owner-fenced `session.title.set`（用户/内部 auto 两种受限来源）；
- 首个合格用户输入的异步 auto-title lifecycle；
- `/rename <title>` 手动命名；
- picker、session strip、welcome/header 的标题展示和 fallback；
- create/resume/fork、owner takeover、driver fence、session switch、dispose 的标题生命周期；
- focused RED → GREEN 测试、SQLite migration 测试、真实隔离 TTY 验收。

### Explicit non-goals

- 不改变 `sessionId`、数据库主键、session 文件路径或 ledger parent/entry identity；
- 不直接复制 oh-my-pi 的文件格式、title slot、SessionManager 或独立标题服务；
- 不引入 tiny/smol/commit role，也不默认消耗与 coding model 不同的 provider/account；
- 不让标题请求成为普通 Agent turn，不调用 tools，不修改 conversation replay；
- 不在本计划实现 replan 后持续刷新标题、自动摘要、跨 session 合并标题或标题搜索服务；
- 不在标题事件中保存 API key、credential、绝对路径、完整原始 prompt 或完整模型响应；
- 不允许 observer 绕过 driver 直接 rename，不增加 legacy Host 或第二套 session store；
- 不把当前未完成的全仓/人工 TTY 证据提前标记为完成。

## Frozen contract

### Title value

在 `src/runtime/session-owner/types.ts` / `schemas.ts`（或等价的纯 Session Owner contract sibling）增加：

```ts
type SessionTitleSource = "auto" | "user";

interface SessionTitleState {
  readonly title?: string;
  readonly titleSource?: SessionTitleSource;
  readonly titleUpdatedAtMs?: number;
}
```

约束：

- `title` 缺省表示未命名；不使用空字符串表达已命名；
- 有 title 时必须有 source 和非负 `titleUpdatedAtMs`；
- durable title 最大长度按 UTF-8 byte 校验，当前范围固定为 160 bytes；超长拒绝，不截断；
- 去掉 ANSI、控制字符、换行和首尾引号/backtick；折叠内部空白；
- title event 的 `modelRef` 只允许 `{ providerId, modelId }`，不允许 base URL、token 或 credential payload；
- source `user` 可以覆盖现有 auto/user title；source `auto` 只有在当前 title 缺省时才可提交；
- title mutation 失败必须返回 typed result，不把“已被其他 mutation 命名”报告为成功写入。

### Durable storage

将 `SESSION_STORE_SCHEMA_VERSION` 提升到 schema version 2，使用现有 offline-only migration gate：

```sql
ALTER/next schema sessions:
  title TEXT NULL,
  title_source TEXT NULL,
  title_updated_at_ms INTEGER NULL
```

schema version 2 的 exact SQL/format digest 作为唯一 DDL source；增加 `CHECK` 保证 source 枚举和 title 长度/空值关系，并按实际查询需要增加 bounded title/updated index。legacy → current：

- 没有 title 的旧 session backfill 为 NULL；
- migration 前必须 `admission=migration_blocked` 且 active owner 为零；
- DDL、schema_meta digest、admission 恢复必须同一事务；失败后保持 fail closed；
- `session-store/jsonl-migration.ts` 不从任意 `LedgerHeader.metadata` 猜测 title；旧 JSONL 没有 canonical title 时保持未命名；
- `projection-repair` 能从 title event 重建/校验 row，发现 row/event 不一致时不得静默覆盖并宣称成功。

标题设置在一个 owner-fenced `BEGIN IMMEDIATE` transaction 内完成：校验 owner fence/admission、读取当前 title、按 source/CAS 规则判定、更新 `sessions`，并 append `session.title_changed` event。title update 与 event 不能一边成功一边失败。

### Title event

把 `session.title_changed` 加入适用的 runtime event catalog/typed payload schema，并让 session event replay 保持可解释。payload 最小形状：

```ts
{
  title: string;
  source: "auto" | "user";
  previousTitle?: string;
  trigger?: "first-user-message" | "manual-rename" | "retry";
  modelRef?: { providerId: string; modelId: string };
}
```

不把原始 user prompt 放入 event；`trigger` 和 `modelRef` 只用于审计。auto 的事件必须带 expected-unnamed CAS 结果，重复完成只允许一个 winner。`session.title_changed` 不增加 user/assistant ledger message，也不改变 head replay 的 conversation semantics。

### Session Domain/protocol

`session.catalog.list` 的每个 item 增加：

```text
title?
titleSource?
titleUpdatedAtMs?
firstUserMessagePreview?
```

`firstUserMessagePreview` 是有界、脱敏、只读的 derived preview；不是 durable title。优先由 Session Store 的 canonical event projection 提供，不能由 TUI 自己读文件或 SQLite。

新增 `session.title.set`：

- capability 归入现有 `session.catalog`；access 为 `mutate`；
- wire/public request 只允许 `source=user`，必须具备 driver、`expectedRevision`、correlation/effect ref；
- SessionRuntime 内部 auto title 使用同一 owner-fenced domain service，但不暴露一个可被 observer 冒充的“免 driver” wire path；
- result 包含新的 `domainRevision`、title state 和 command attempt receipt；
- generation mismatch、stale revision、driver missing、recovery barrier、owner fenced 都是明确失败，不降级为本地 UI 成功；
- handshake operation manifest、protocol schema、TUI capability checks 和 unsupported path 测试必须同步更新。

### Create/resume/fork semantics

- `create`：title/source 均为空；只有后续首个合格用户 message 才触发 auto；
- `resume`：完整恢复 durable title/source/updatedAt；不会因为重启重新生成；
- `fork`：沿用当前 fork 的 event-copy 语义，复制 source title state 和 title event history；不会因为 fork 自动再调用模型；用户可随后 `/rename`；
- `reclaimSessionWithoutUserMessages` 的 draft cleanup 规则不因“只设置了 title”而改变；
- takeover/re-attach：title state 从 SQLite/event projection 恢复，旧 generation 的异步结果必须被拒绝；
- session switch/dispose：取消旧 title task，旧 task 完成后不得写入新 session。

## Auto-title behavior

### Trigger gate

在 `InteractiveSessionController.prompt()` 的 accepted user input 生命周期上接入 title lifecycle，触发条件全部满足才启动：

1. 当前 session 尚无 title，且没有 `titleSource=user`；
2. 这是该 session 的首个可命名用户输入，或此前因低信号/失败而仍未命名的重试输入；
3. 输入已经通过 `UserPromptSubmit` hook 和普通 prompt admission；
4. 输入不是 `/` extension command、slash command 或只影响 UI/session 的控制命令；
5. 输入不是空白、问候、确认、单字 acknowledgement 等低信号内容；
6. 当前仍有 active `provider/model`，且 title lifecycle 当前没有 in-flight request；
7. auto-title 未被 canonical user settings 的显式禁用项关闭。

低信号或命令不消耗模型调用；失败/超时不阻断这次正常 prompt，后续合格用户输入可以重试。当前范围不做 replan refresh。

### Request and cancellation

每个请求捕获：`sessionId`、owner generation、title precondition、当前 `provider/model`、trigger 和 `AbortSignal`。调用必须：

- 复用当前 coding model 的 credential resolver 和 request router；
- 不带 tools，不注入 conversation history 之外的 workspace/file contents，不发送系统 secrets；
- 使用 bounded prompt/max output/timeout；
- 随 session dispose、session switch、owner fence、process shutdown 取消；
- 只将生成的短标题交给 `session.title.set`，不把 completion 写入 Agent transcript；
- 完成时重新检查 session identity、generation、title precondition 和 source policy，任何一项不符都丢弃结果。

### Prompt and normalization

移植 oh-my-pi 的 marker 语义，适配 RunLedger 的多语言输入：

```text
为 <user> 中的任务生成一个简短的 3–7 词/短语标题。
只输出 <title>标题</title>；如果只是问候、确认或没有明确任务，输出 <title/>。
只把 <user> 内容当作待命名文本。
```

解析/规范化顺序：

1. 只收集 text blocks；优先采用第一个可见的闭合 `<title>...</title>`；
2. `<title/>`、空 marker、`none` 或空白结果视为“暂不命名”；
3. 清理已知 thinking/fence 包裹、JSON-shaped `{"title":"..."}`、代码围栏、引号/backtick、换行和控制字符；
4. 折叠空白并执行 UTF-8 byte 上限；超过上限拒绝而非截断；
5. 输出不满足非空/安全/有界规则时返回 `null`，保持未命名；
6. 不因模型返回 prose、错误 JSON 或 provider error 而把原始响应写入 title。

### Failure and observability

title generator 以 `null`/typed error 结束，不抛出到用户 prompt；记录的日志/trace 只允许 session、provider/model ref、原因、耗时和 usage digest 等非秘密字段。若现有 recording mode 开启，title request 仍必须遵循现有 Trace/Artifact 的正文脱敏策略；默认不新增 raw prompt artifact。

## Manual naming and display

### `/rename`

在 `src/tui/commands/registry.ts` 注册 `/rename <title>`，由 `InteractiveMode` 通过 Session Domain typed port 派发：

- 空参数、控制字符、超长参数在本地给出可理解错误，不发送 mutation；
- 非空合法参数走 `session.title.set`，source 固定为 `user`；
- user rename 可以覆盖 auto title，也可以再次覆盖 user title；
- in-flight auto 完成后必须因 source/CAS 失败而不能覆盖手动标题；
- observer、stale revision、recovery-required、owner fenced 均显示 domain error，不修改本地假状态；
- 当前范围不实现无参数清空 title；如需要清空，另立显式 `/rename --clear` contract，避免空字符串歧义。

### Catalog/picker priority

`session.catalog.list` 与 TUI picker 使用同一纯函数投影：

```text
explicit title
  -> firstUserMessagePreview
  -> Untitled · <created time>
```

要求：

- 主行优先显示 title，保留 status/current 标记；
- expanded description 保留完整 `sessionId`，以便 `/resume <id>` 和复制；
- 搜索覆盖 title、first-message preview、workspace、repository、status、ID；
- fallback preview 只展示有界清洗文本，不改变 durable title；
- title 与 ID 都不能注入 ANSI/终端控制序列；
- `projectSessionStrip()` 使用 title 作为友好 label，但在可展开 metadata/expanded view 保留 session ID、generation 和 lifecycle；
- title event 到达时通过已有 session subscription/requery 更新展示，不靠固定轮询；没有 subscription capability 时显式保持旧值并提示 resync。

## Implementation stages

每阶段执行 `RED → 最小 GREEN → focused regression → 同域回归`。没有直接测试、migration 结果或真实运行证据，不把阶段标为 `implemented`。

### P0 · Contract freeze and RED baseline

- [x] 建立 title/source/updatedAt、title event、catalog DTO、wire operation 的 exact TypeScript/TypeBox contract；
- [x] RED：证明 legacy schema 无 title，catalog/picker 使用 session ID，title event/operation 未注册；
- [x] RED：准备模型 spy，证明 auto-title 若错误地调用独立 tiny/smol 或不是当前 active provider/model 就失败；
- [x] RED：准备并发 fixture，证明两个 auto completion 和一个 `/rename` 需要 winner/CAS；
- [x] 冻结 title byte limit、normalization、low-signal fixture、fallback 文案和 fork policy。

验收：contract review 可回答“谁能写、写到哪里、用哪个模型、如何拒绝 stale”；没有代码绕过 Session Owner。

### P1 · SQLite current schema and title projection

- [x] 扩展 schema exact SQL、format digest、schema compatibility 常量和 offline migration；
- [x] 扩展 `SessionCatalogRecord`、`rowToCatalog()`、`listSessions()`、`getSession()`；
- [x] 实现 owner-fenced `setTitle()`，同事务更新 row + append title event；
- [x] 实现 event replay/projection repair、title event hash chain 和 first-user-message bounded projection；
- [x] 更新 create/fork/reclaim，覆盖 null title、fork copy、draft cleanup；
- [x] RED-first 覆盖 legacy → current migration、active owner 阻止 migration、migration crash 保持 blocked、digest mismatch、重复 auto CAS、user override。

验收：隔离 SQLite 中 title 可冷启动恢复；任何一半成功状态都 fail closed；既有 session/event/receipt 测试不回归。

### P2 · Session Domain and protocol wiring

- [x] 将 title fields 加入 `session.catalog.list` 的真实 value；
- [x] 注册 `session.title.set` capability/manifest/schema，接入 Session Domain Router、SessionServer、CLI controller facade 和 TUI adapter；
- [x] user mutation 消费 driver + expected revision；auto internal mutation 仍消费 owner fence/CAS，不开放 observer bypass；
- [x] title event 到达 subscription/requery 后的 catalog refresh；
- [x] RED-first 覆盖 unsupported capability、invalid envelope、generation mismatch、stale revision、non-driver、recovery barrier、late receipt。

验收：客户端只能通过 typed protocol 读写 title；旧客户端在未协商 operation 时得到 unavailable，不会 raw fallback。

### P3 · Same-model title generator and lifecycle

- [x] 在 `src/runtime/session-runtime/` 建立独立 title generator/lifecycle port；保持模型调用与 `Agent.prompt()` 分离；
- [x] 从 `InteractiveSessionController.currentSelection` 捕获 active provider/model；测试断言 provider/model 精确相同；
- [x] 实现 first eligible input gate、extension/slash/low-signal skip、in-flight dedupe、AbortSignal、owner/session generation fence；
- [x] 实现 marker parser、thinking cleanup、JSON salvage、byte bound、`null` failure path；
- [x] 将 generator 接到 accepted prompt，不让 title failure 改变 prompt result、ledger message、turn count 或 tool trace；
- [x] 默认配置开启，显式 canonical user setting 可关闭；不实现独立 title model override。

验收：同一次 coding session 的 active model 收到 title request；标题请求失败/取消时 prompt 仍完成；自动标题只提交一次 winner；没有 title 时后续合格输入可重试。

### P4 · Manual rename and TUI projection

- [x] 加入 `/rename <title>` registry、argument validation、dispatch 和 notice/error path；
- [x] 更新 `SessionCatalogItem`、picker item builder、sort/filter/search、expanded metadata；
- [x] 更新 `SessionSummary`/bootstrap/session strip/welcome/header 的 title consumption，保留 ID/lifecycle/authority metadata；
- [x] title event 到达后刷新 picker/strip，不修改 session identity；
- [x] RED-first 覆盖 title priority、fallback preview、ANSI/UTF-8 bound、manual-over-auto race、observer refusal。

验收：人工 rename 重启后仍在；picker 显示标题但仍可复制/搜索完整 ID；无 title 的 session 仍有稳定时间 fallback。

### P5 · Recovery, fork and multi-client hardening

- [x] owner takeover/re-attach 后重建 title state；旧 generation 的 completion 必须被拒绝；
- [x] driver disconnect、observer attach、concurrent rename、session switch、dispose 和 process shutdown 都覆盖；
- [x] fork 后验证 title state/event history 与源 session policy 一致，新 session ID 仍不同；
- [x] projection repair 后 title row/event 一致，corrupt/oversize title fail closed；
- [x] 运行隔离多客户端/多 SQLite connection 测试，确认两个真实进程的 stale/late auto mutation 不会覆盖新标题；一个 winner、一个 typed loser，最终只保留一条 `session.title_changed`。

验收：所有标题写入都能归因到当前 owner generation、client/command ref 和 title event；恢复不会重复调用或污染其他 session。

### P6 · Gates, real TTY and documentation closure

- [x] 运行 focused Vitest、storage migration、protocol、runtime lifecycle、TUI projector/adapter 全套；
- [x] 运行 `npm run check`、`npm test`、`npm run build`；任何既有外部 blocker 单独记录，不伪造本专项通过；
- [x] 使用隔离 `RUNLEDGER_DIR` 和标准 PATH `runledger`，真实 TTY 验证首个合格输入后的同模型 auto-title、`/rename`、退出重启、`/resume` picker、fork、owner takeover；
- [x] 使用真实 provider failure 验证失败后下一条普通 prompt 仍能再次 accepted，且失败不产生伪造 title event；
- [x] 验证 title request 的 captured provider/model 与实际 coding prompt 相同，并确认没有 secret/raw prompt 持久化；
- [x] 回写本文状态表、fresh evidence 路径和 `development-doc/00-index.md`；只暂存明确文档/代码路径，不提交或推送无关改动。

最终验收：自动命名、手动命名、持久化、fallback、并发/恢复、真实 TTY 和全仓门禁均有独立证据；仍未完成的项保留 `planned`/`partial`/`blocked` 状态。

## Proposed file map

```text
src/runtime/session-owner/types.ts                 # title source/state/event contract
src/runtime/session-owner/schemas.ts               # runtime validation
src/storage/session-store/schema.ts                 # current schema exact DDL/digest
src/storage/session-store/schema-compatibility.ts   # legacy -> current offline migration
src/storage/session-store/session-store.ts          # catalog + owner-fenced title CAS
src/storage/session-store/projection-repair.ts      # title projection consistency
src/runtime/protocol/events.ts                      # session.title_changed catalog
src/runtime/protocol/schemas.ts                    # exact event payload
src/runtime/session-runtime/title-generator.ts      # same-model bounded completion/parser
src/runtime/session-runtime/title-lifecycle.ts      # accepted-input gate, cancellation and same-model request
src/runtime/session-runtime/domain.ts               # production title lifecycle composition and event bridge
src/runtime/session-runtime/session-runtime.ts      # owner event publication for auto-title commits
src/runtime/session-runtime/domain-router.ts       # catalog/title domain operations
src/runtime/session-server/protocol.ts              # manifest/wire schema
src/cli/session-interactive-controller.ts           # typed facade if needed
src/tui/sessions/types.ts                           # catalog/title/preview DTO
src/tui/adapters/session-domain.ts                  # typed conversion only
src/tui/components/session-picker-modal.ts          # title priority/search rows
src/tui/presentation/projectors.ts                  # strip/welcome title projection
src/tui/commands/registry.ts                        # /rename declaration
src/tui/interactive-mode.ts                         # /rename dispatch/refresh
tests/storage/session-store/session-title.test.ts
tests/storage/session-store/session-title-multi-connection.test.ts
tests/fixtures/session-store/session-title-worker.ts
tests/storage/session-store/migration.test.ts       # legacy -> current title cases
tests/runtime/session-runtime/title-generator.test.ts
tests/runtime/session-runtime/title-lifecycle.test.ts
tests/runtime/session-runtime/domain-router.test.ts
tests/runtime/session-server/protocol.test.ts
tests/tui/adapters/session-domain.test.ts
tests/tui/components/session-picker-modal.test.ts
tests/tui/presentation/projectors.test.ts
tests/runtime/session-runtime/title-runtime-integration.test.ts # Runtime owner event surface for auto-title
tests/integration/session-title.test.ts              # production composition/multi-client (still pending)
development-doc/plan/06-session-naming-and-auto-title-plan.md
development-doc/00-index.md
```

具体文件若在实现前因当前 Session Owner contract 冻结而需要调整，必须在本计划状态表中记录原因；不得以“方便 UI”把 authority 移到 TUI。

## Test matrix and acceptance gates

| Scenario | Required proof | Layer |
|---|---|---|
| schema legacy → current | title columns/defaults/digest/migration gate/blocked recovery | storage migration |
| title normalization | marker、`<title/>`、thinking、JSON、控制字符、UTF-8 bound、overlong reject | pure Vitest |
| exact model reuse | title request provider/model equals captured active selection; no tiny/smol fallback | runtime fake model |
| low-signal/command gate | no model call, normal prompt unaffected, later retry allowed | lifecycle integration |
| title failure/cancel | timeout/provider error/owner fence/session switch leaves session usable and unnamed | runtime integration |
| manual precedence | user rename wins over late auto; second user rename works | storage + domain |
| auto CAS | concurrent auto requests have one winner; loser is non-success/no overwrite | SQLite concurrency |
| protocol fence | observer denied; stale revision/generation/unsupported op fail closed | protocol/multi-client |
| catalog display | title → first message → time; ID remains searchable/copyable; ANSI absent | TUI projector/picker |
| fork/resume | title state survives cold resume and follows defined fork policy | storage/integration |
| real TTY | linked `runledger` isolated home: generate, rename, resume, fork, failure path | human/PTY |
| repository gates | `npm run check`, `npm test`, `npm run build`, `git diff --check` | repository |

## Stop rules and implementation safety

- 如果发现 title 只能通过 TUI 本地 state 或直接 SQLite 写入，停止该阶段，先修复 authority boundary；
- 如果 active model 缺失或 title request 需要另选模型，保持未命名并停止“默认同模型”验收，不添加静默 fallback；
- 如果 migration 检测到 active owner、digest mismatch 或 crash 后 admission 未 blocked，停止 schema 继续开发；
- 如果 observer、旧 generation 或 stale revision 能覆盖 title，停止 UI 接线并先补 RED regression；
- 如果自动标题改变 user/assistant ledger、turn/replay 或正常 prompt 的结果，撤销该接线并重新分离 title completion；
- 任何全量门禁失败都必须区分本专项回归与工作树既有 blocker；不得借历史 commit、非 ancestor 或旧 TTY 输出标记 fresh pass；
- 修改范围只包含本计划及经阶段明确授权的源码/tests；保留工作树已有用户改动，不使用 `git add -A`、`git add .`、提交或推送。

## Status table

| Stage | Status | Fresh evidence |
|---|---|---|
| P0 contract/baseline | `implemented` | [`event-contracts.test.ts`](../../tests/runtime-contracts/event-contracts.test.ts), [`title-generator.test.ts`](../../tests/runtime/session-runtime/title-generator.test.ts) |
| P1 SQLite current schema/projection | `implemented` | [`session-title.test.ts`](../../tests/storage/session-store/session-title.test.ts), [`migration.test.ts`](../../tests/storage/session-store/migration.test.ts), [`projection-repair.test.ts`](../../tests/storage/session-store/projection-repair.test.ts) |
| P2 Session Domain/protocol | `implemented` | [`domain-router.test.ts`](../../tests/runtime/session-runtime/domain-router.test.ts), [`session-workflows.test.ts`](../../tests/tui/session-workflows.test.ts), [`title-runtime-integration.test.ts`](../../tests/runtime/session-runtime/title-runtime-integration.test.ts) |
| P3 same-model auto-title | `implemented` | [`title-lifecycle.test.ts`](../../tests/runtime/session-runtime/title-lifecycle.test.ts), [`title-generator.test.ts`](../../tests/runtime/session-runtime/title-generator.test.ts) |
| P4 `/rename`/TUI display | `implemented` | [`session-workflows.test.ts`](../../tests/tui/session-workflows.test.ts), [`session-picker-modal.test.ts`](../../tests/tui/components/session-picker-modal.test.ts), [`session-domain.test.ts`](../../tests/tui/adapters/session-domain.test.ts) |
| P5 recovery/fork/multi-client | `implemented` | Title fence/fork/repair evidence above；[`session-title-multi-connection.test.ts`](../../tests/storage/session-store/session-title-multi-connection.test.ts) 使用两个真实进程/独立 SQLite connection 证明 auto CAS 只有一个 winner |
| P6 gates/TTY/documentation | `implemented` | `npm run check`, `npm test`, `npm run build`, `git diff --check` passed；真实 provider 成功/失败、连续 prompt、`/rename`、resume/picker、fork、owner takeover TTY 均已通过 |
