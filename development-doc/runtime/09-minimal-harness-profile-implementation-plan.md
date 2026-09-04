# RunLedger 会话级极简 Harness Profile 实施计划

> 文档状态：in progress；P0–P4 implemented，P5 not started
> 基线复核：2026-09-04，`rollback/before-composer-shape@cc827e67e81b`
> 实施工作树：`RunLedger-minimal-harness-profile` / `feat/minimal-harness-profile`
> 目标入口：标准 `runledger` CLI 的 `main.ts → createEmbeddedSessionRuntime() → assembleSessionDomain()`
> 参考实现：`deepseek-harness/apps/cli/config/agent-presets/minimal/agent.cordis.yml`
> 相关权威边界：[`04-governed-agent-harness-runtime-plan.md`](04-governed-agent-harness-runtime-plan.md)、[`06-session-owner-runtime-replacement-plan.md`](06-session-owner-runtime-replacement-plan.md)、[`08-bounded-multi-agent-system-plan.md`](08-bounded-multi-agent-system-plan.md)、[Permission presets](../worktree-sandbox-permisson/07-three-permission-presets-and-tui-settings-plan.md)

P0 fresh evidence（2026-09-04）：builtin descriptor/ref exact guards、canonical digest golden、minimal fixed prompt/two-tool allowlist 与当前 standard prompt/base-tool manifest 已冻结；focused 3 files / 8 tests、`npm run check`、runtime bucket 101 files / 649 tests 均通过。P0 尚未接入生产 composition，因此不改变运行时行为；没有 commit 或 push。

P1 fresh evidence（2026-09-04）：Session Store 已升级为 V4，catalog row 以三个 `NOT NULL` 字段和 insert/update invariant triggers 保存 exact builtin ref；revision 3 → V4 只允许零 active owner 的 offline migration，旧 row 固定回填 `standard@1`。`CreateSessionInput.harnessProfile` 为必填且经 runtime resolver 校验；专用 `ForkSessionInput` 在同一 `BEGIN IMMEDIATE` 内复制 source workspace/repository/settings/source locator/title/profile，resume、attach 与 takeover 继续读取同一 durable row。P1 RED 为 focused 5 files / 54 tests 中 8 个预期失败；GREEN/Stable Green 同组 5 files / 54 tests 通过。fresh 门禁为 `npm run test:inventory` 489 owned files / 0 diagnostics、`npm run check`、runtime bucket 125 files / 650 tests、完整 `npm test`（Vitest 468 files / 2896 passed / 3 macOS-only skipped；Bun TUI-native 19 files / 138 passed）、`npm run build`、`npm run test:smoke` 与 `git diff --check` 全部通过。标准 PATH 链接解析到本工作树，built CLI 的 version/help、隔离 `RUNLEDGER_DIR` 的真实 tmux TTY startup/clean exit 均通过；P2 production profile-aware composition 尚未开始，因此这项 smoke 只证明当前 standard 路径。没有 commit 或 push。

P2 fresh evidence（2026-09-04）：`assembleSessionDomain()` 现在先解析 catalog 的 durable ref，再从同一 governed stdlib capability catalog 投影 profile。`standard@1` 保持 assembled prompt、完整 stdlib/LSP/Extension/MCP/Skill/Hook 和 policy-gated multi-agent；`minimal@1` 固定完整 prompt，provider-facing manifest 按顺序严格为 `bash`、`edit`，manifest digest 固定为 `3325e5598de3f84582ef89c65532a6c969355c3eb4821bd19c4529ea7bdacafc`。minimal bash delegate 只收窄 schema 并移除 `run_in_background`，执行仍委托 governed bash；edit 直接复用 governed tool。minimal 不创建/启动 extension lifecycle、不注入 extension context/hook、不创建 child runtime 或 multi-agent domain，同时继续保留 Security、managed process、Attempt Gateway、owner fence、security settings、trace 与 title lifecycle。每个 owned generation 在 controller/model call 前写入 bounded、owner-fenced `harness.composed` receipt；Trace factory 同时携带 profile/version/composition digest metadata，不保存 prompt 正文。RED 分别观察到旧 assembled prompt、schema drift 未拒绝、receipt 缺失与 composition 失败后 owner 未释放；GREEN 后 focused production suites 41 files / 245 tests 通过，runtime bucket 在完整门禁中为 127 files / 658 tests。fresh 门禁为 `npm run test:inventory` 491 owned files / 0 diagnostics、`npm run check`、`npm run test:security-storage` 98 files / 589 passed / 3 macOS-only skipped、完整 `npm test`（Vitest 470 files / 2904 passed / 3 macOS-only skipped；Bun TUI-native 19 files / 138 passed）、`npm run build`、`npm run test:smoke` 与 `git diff --check` 全部通过。全局 `runledger` 解析到本工作树，隔离 `RUNLEDGER_DIR` 的真实 tmux TTY startup/clean exit 通过；P3 尚未实现，因此该 PATH smoke 仍只走默认 standard create，不能作为 minimal CLI 选择证据。没有 commit 或 push。

P3 fresh evidence（2026-09-04）：CLI 新增仅限 fresh create 的 `--harness-profile standard|minimal`，缺值、未知值以及 open/resume/continue/fork override 均 fail closed；默认 create 写入 `standard@1`，显式 minimal 写入 `minimal@1`。Session Domain 的 create 可继承当前 profile 或显式选择 builtin ID，fork 继续由原子事务复制 source ref；catalog、create/resume/fork response 与 snapshot 均投影 profile ID/version。TUI `/new`、`/new standard`、`/new minimal` 已接线，未知参数在 mutation 前拒绝；普通/dense/expanded catalog 行和永久只读 header 分别显示 Harness，并与 Permission、Thinking 分栏，未新增 profile mutation operation。RED 为首轮 8 files / 114 tests 中 13 个预期失败，普通 catalog 行另观察到 1 个预期失败；GREEN 为 9 files / 122 tests，广覆盖 Stable Green 为 64 files / 467 tests。fresh 门禁为 `npm run test:inventory` 493 owned files / 0 diagnostics、`npm run check`、完整 `npm test`（全部 Vitest buckets 与 Bun TUI-native 19 files / 138 tests）、`npm run build`、`npm run test:smoke` 和 `git diff --check` 全部通过。全局 `runledger` 及 npm global link 均解析到本工作树；无凭据、隔离 `RUNLEDGER_DIR` 的真实 120-column tmux TTY 分别验证默认 standard 与显式 minimal fresh create、exact catalog ref/digest、durable user message 后 clean exit 和新进程 `--resume`，恢复前后 session ID/ref/digest 与 `Harness`/`Permission`/`Thinking` header 一致。该证据不覆盖 P4 的 crash takeover/checkpoint/receipt recovery 矩阵，也不替代 dark/light、80/143 列、真实 IME 等人工验收。没有 commit 或 push。

提交更新（2026-09-04）：以上“没有 commit”均记录对应阶段取得门禁证据时的状态；P0–P3 实现与测试随后统一提交为 `1dba2d3`（`feat(runtime): preserve immutable harness profiles per session`），尚未 push。P4–P5 不在该提交中。

P4 fresh evidence（2026-09-04）：`restoreSession()` 现在先解析 catalog 的 exact builtin ref，再校验 durable event hash chain 和所有 `harness.composed` receipt，最后才使用可丢弃 checkpoint cache；malformed/session/generation/profile/composition-digest/duplicate-generation 均返回 typed diagnostic，catalog ref 损坏返回 `harness_profile_corruption`。healthy minimal attach 不产生 client-side receipt；真实多进程 minimal governed `bash` 在 Attempt Gateway 内阻塞后 SIGKILL，takeover generation 1 → 2 保持 ref/composition digest，recovery barrier 保持 open 且新增副作用 `spawnCount=0`；clean resume 的 checkpoint hit/corrupt/deleted 三路径一致，旧 generation 写 receipt 被 owner fence 拒绝。RED 为 1 file / 4 个预期失败；GREEN 扩展为 9 tests，生产多进程 suite 10 tests 通过；focused 10 files / 93 tests 通过。`npm run check`、runtime bucket 128 files / 669 tests 与 security-storage bucket 98 files / 589 passed / 3 macOS-only skipped 均连续两轮通过。实现提交为 `1dccaa4`（`feat(runtime): audit harness composition across recovery`），尚未 push；P5 最终全量门禁与 built CLI 矩阵不在该提交中。

## 0. 结论

RunLedger 的“极简模式”应实现为不可变的**会话级 Harness Profile**，而不是 Permission Profile、模型 thinking level、Agent Loop 内布尔分支或旧 Runtime Host feature flag。

首版只提供两个内置 profile：

| Profile | 模型 system prompt | 模型可见工具 | 扩展 context / hook | Multi-Agent | Host 治理层 |
|---|---|---|---|---|---|
| `standard@1` | 保持现有 `buildSystemPrompt()` 与 AGENTS 拼接 | 保持当前 governed stdlib、LSP、Skill/MCP 和按策略启用的 `spawn_agent` | 保持现状 | 按现有双门禁 | 全部保留 |
| `minimal@1` | 固定完整 prompt：`You are a helpful software engineer assistant.` | 严格只有 `bash`、`edit` | 不装配模型侧 extension context、hook、Skill/MCP lifecycle | 禁用 | 全部保留 |

“只有两个工具”是模型表面约束，不是削弱安全边界。`minimal` 下的 `bash` 和 `edit` 仍必须来自同一受治理 `ExecutionEnv`，经过 Authorization、ExecutionGateway、Attempt Gateway、owner fence、ledger 与 Runtime Trace。Profile 只能缩小能力，不能新增能力或放宽 Permission Profile。

首版必须在 Session 创建时冻结 profile。resume、continue、fork、健康 attach 和 crash takeover 都从 Session Store 恢复同一 profile；不得使用当前 settings、CLI 默认值或 checkpoint cache 猜测。

---

## 1. 当前实现审计

### 1.1 当前生产链

标准 CLI 当前实际链路为：

```text
src/cli/main.ts
  resolveSessionId()                         create/open/resume/fork catalog row
  openView()
    createEmbeddedSessionRuntime()
      SessionOwner.open()                    attach 或 claim/takeover
      restoreSession()                       authority events + cache acceleration
      assembleSessionDomain()                当前生产 composition root
        createSessionSecurity()
        createSessionProcessComposition()
        gatedExecutionEnv()
        productionSessionTools()
        createProductionSessionExtensionComposition()
        InteractiveSessionController.create()
        createMultiAgentDomain()
          Agent(initialState)
```

`src/cli/runtime-host*.ts` 仍在仓库中，但标准入口明确不 import/call 它们。极简模式不得接到旧 Host，也不得创建第二条生产 composition。

### 1.2 当前模型表面

`src/runtime/session-runtime/domain.ts` 当前一次性完成安全、进程、工具、扩展、context 和 Agent 组装：

- `productionSessionTools()` 从 `createStdlibTools()` 取得 `read`、`write`、`edit`、`MultiEdit`、`bash`、`grep`、`find`、`glob`、`ls`、`WebFetch`、可选 `request_permissions`、process 工具，再加入 `lsp`；
- production extension composition 加入 `Skill`、MCP 工具、Skill catalog context、Pre/PostToolUse hook 与 turn lifecycle；
- multi-agent policy 成功时，在 controller 创建后追加 `spawn_agent`；
- `buildSystemPrompt()` 拼接 workspace 与用户级 AGENTS；
- `assembleAgentModelContext()` 负责按 context window 选择 system/history/extension fragments，并产生 receipt；
- `InteractiveSessionController.ensureAgent()` 最终冻结一个 Agent 的 system prompt、tools、model、authorization hooks 和 context assembler。

当前 Session Owner 生产链没有把 `plan_write`、`memory_search`、`memory_get`、`memory_propose` 接入模型工具；这些工具目前只在旧 `runtime-host-session.ts` 使用。`minimal@1` 仍应显式拒绝未来把 Plan/Memory 工具自动加入其模型表面，避免后续标准 profile 扩展时发生回归。

### 1.3 当前持久化缺口

`sessions` catalog row 目前保存 workspace/repository/status/worktree、`settings_digest`、title 等，但没有 Harness Profile 字段。当前创建与 fork 路径也只复制 `settingsDigest`：

- CLI fresh create 在 `resolveSessionId()` 写入新 row；
- CLI fork 和 Session Domain `session.fork` 在事务外读取 source，再把部分字段传给 `forkSession()`；
- resume/continue/attach/takeover 仅按 session ID 打开 row；
- checkpoint snapshot 只保存 replay acceleration state，删除后必须可从 durable truth 重建。

`settingsDigest` 不能替代 Harness Profile identity：设置内容可以变化，且当前摘要不表达固定 prompt、工具 allowlist、context policy 或 profile definition version。

### 1.4 DeepSeek Harness 可借鉴与不可照搬的部分

DeepSeek Harness 的 `minimal` 是一个会话级 preset composition：complete persona、`includeRuntimeContext: false`、持久 `bash`、`str_replace_editor`，且不装配 compaction。其 E2E 对 exact prompt、exact 两工具、schema 和 compaction absence 做断言。

RunLedger 应借鉴：

- profile 在会话级选择并持久恢复；
- complete prompt 不接受后续 AGENTS/runtime context 拼接；
- exact tool name/schema 测试，不使用 `arrayContaining`；
- standard 与 minimal 同时存在时，Session 间不泄漏组合；
- profile definition、选择记录和实际模型表面有可审计 digest。

RunLedger 不应照搬：

- 不使用 DeepSeek preset 的裸 `fs-local`；必须保留 RunLedger governed `ExecutionEnv`；
- 当前 `bash` 是一次调用一次受管执行，不是跨调用持久 PTY；首版不得宣传“持久 Shell”；
- 当前 `edit` 只修改已有文件，不等于可查看文件的 `str_replace_editor`；读取通过 `bash` 完成；
- `minimal` 不改变 Permission Profile。是否允许网络、写入或需要审批，仍由 Security composition 决定；仅隐藏 `WebFetch` 不等于网络必然关闭。

---

## 2. 冻结术语、合同与不变量

### 2.1 命名

- 产品名：极简模式 / Minimal Harness。
- 代码名：`HarnessProfile`、`HarnessProfileId`、`HarnessProfileRef`。
- 禁止称为 Permission Preset、Security Profile、Sandbox Profile、Model Profile 或 thinking `minimal`。
- CLI 参数使用 `--harness-profile minimal`，避免与现有 `--permission-profile`、`--thinking minimal` 混淆。

### 2.2 被动合同

在 `src/runtime/harness-profiles/` 建立单一 registry/resolver：

```ts
export type HarnessProfileId = "standard" | "minimal";

export interface HarnessProfileRef {
  readonly id: HarnessProfileId;
  readonly version: 1;
  readonly descriptorDigest: RuntimeDigest;
}

export interface HarnessProfileDescriptor {
  readonly id: HarnessProfileId;
  readonly version: 1;
  readonly prompt: {
    readonly mode: "assembled" | "complete";
    readonly text?: string;
  };
  readonly tools: {
    readonly mode: "standard" | "allowlist";
    readonly allowlist: readonly string[];
    readonly allowBackgroundHandle: boolean;
  };
  readonly extensions: {
    readonly tools: boolean;
    readonly context: boolean;
    readonly hooks: boolean;
    readonly lifecycle: boolean;
  };
  readonly multiAgent: boolean;
}

export interface ResolvedHarnessComposition {
  readonly ref: HarnessProfileRef;
  readonly systemPrompt: string;
  readonly tools: readonly AgentTool[];
  readonly promptDigest: RuntimeDigest;
  readonly toolManifestDigest: RuntimeDigest;
  readonly contextPolicyDigest: RuntimeDigest;
  readonly compositionDigest: RuntimeDigest;
}
```

实现时可按现有 contract 习惯拆分 exact schema/guard，但不能允许任意 string profile ID、unknown field 或用户提供可执行 descriptor。`descriptorDigest` 对 canonical descriptor 计算；profile 行为发生任何模型可见变化时必须新增 version，不能原地改写 `minimal@1`。

### 2.3 全局不变量

1. `standard@1` 在未选择极简模式时保持当前行为；现有测试的 prompt、tool、extension 和 multi-agent 语义不得漂移。
2. `minimal@1` 的 provider-facing tool names 按顺序精确等于 `['bash', 'edit']`，无第三个工具。
3. `minimal@1` 的 system prompt 字节精确等于固定常量，不拼接 cwd、workspace/user AGENTS、Skill catalog、Plan、Memory 或 extension additional context。
4. profile 投影是 governed capability catalog 的交集；resolver 不得自行创建 raw filesystem、shell、network 或 process adapter。
5. profile 不能修改 Permission Profile、Approval Policy、Sandbox、Network Policy 或 managed constraints。
6. `request_permissions` 在 minimal 模型表面不可见，但现有工具授权仍可触发 Host/TUI approval reverse request；工具被拒绝时不得因缺少该工具而自动允许。
7. fork 在同一数据库事务内继承 source profile ref；首版不允许 fork 时改 profile。
8. attach、resume 与 takeover 只读取 target Session 的 durable ref。CLI flag 与 stored ref 冲突时 fail closed。
9. checkpoint 不是 profile authority。可在 cache state 冗余保存 profile digest 用于失效判断，但 cache 缺失、损坏或被删除不能改变 profile。
10. `minimal` 与 `standard` 两个 Session 同进程运行时，tool registry、prompt、extension state 和 child runtime 不得交叉污染。

---

## 3. 首版行为规格

### 3.1 `standard@1`

`standard@1` 是显式 profile，不是“未传 profile”分支：

- 使用现有 `buildSystemPrompt()`；
- 使用现有 production base tools、LSP、extensions 和 policy-gated multi-agent；
- 使用 extension context sources 与 hooks；
- 保持 Security、process、trace、title、resource domains 和 model router 现状；
- 对当前 surface 建立 golden digest，后续改变必须有 profile version 决策。

旧 Session Store 迁移时全部显式回填为冻结的 `standard@1` ref，不能保留 NULL 后在每次启动时动态取默认值。

### 3.2 `minimal@1`

`minimal@1` 的模型表面：

```text
system prompt: You are a helpful software engineer assistant.
tools:         bash, edit
context:       selected conversation history only; no extension source
hooks:         none from Plugin/Skill/MCP extension subsystem
subagents:     unavailable
```

保留 `assembleAgentModelContext()` 用于 context-window budgeting、历史选择和 receipt；传入的 `sources` 必须是空数组。这里的“无 runtime context”指不追加 AGENTS、Skill catalog、Plan/Memory 和 extension fragment，不是绕开上下文预算或审计。

`bash` 使用已经经过 `gatedExecutionEnv`、Security 与 managed foreground process 的实现。由于当前 `run_in_background` 会返回需要 `process_output/process_wait/...` 管理的 handle，而这些工具在 minimal 中不可见，必须提供一个无副作用的 profile wrapper：

- provider-facing schema 不暴露 `run_in_background`；
- wrapper 只收窄参数并委托同一个 governed `bash.execute()`；
- 不复制 shell 执行、authorization、attempt 或 output truncation 逻辑；
- raw `command &` 的最终行为仍由现有 shell/sandbox/security 约束，本专项不声称完全禁止 OS 后台进程。

`edit` 直接投影现有 governed tool；它不增加 read/create 能力。模型需要查看文件或创建文件时使用 `bash`。

minimal 下不创建或启动模型侧 extension/MCP/Skill lifecycle，也不把 extension resources、context、hook runtime 接到 controller。Security settings、Session catalog、process recovery、trace 等 Host-owned Domain 可以继续存在，但不能变成模型工具。若产品需要在 minimal 中管理 extensions，应另行设计“control-plane only”composition，不能通过悄悄启动完整 extension composition 实现。

### 3.3 选择、继承与显示

| 入口 | 规则 |
|---|---|
| `runledger` | 新建 `standard@1` |
| `runledger --harness-profile minimal` | 新建 `minimal@1` |
| `--session-id` / `--resume` / `--continue` | stored profile 唯一生效；若同时传 profile flag，拒绝而非覆盖 |
| CLI `--fork` | 原子继承 source profile；拒绝 profile flag |
| TUI `/new` | 默认继承当前 Session profile |
| TUI `/new standard` / `/new minimal` | 创建期显式选择；完成前不切换当前 Session |
| TUI `/fork` | 原子继承；不接受 profile 参数 |
| attach / takeover | durable ref 唯一生效 |

TUI 至少提供两个只读可见点：当前 Session header/详情显示 `Harness: standard|minimal`，session catalog item 显示 profile。不得把它放入 Permission Preset 下拉框，也不得显示成 `thinking=minimal`。

首版不提供 `session.harness.set` mutation。可增加 `session.harness.inspect` query 或在既有 snapshot/catalog 投影中携带 `profileId/profileVersion`；任何“切换”控件都属于非目标。

---

## 4. 存储、恢复与审计设计

### 4.1 Session Store schema

将 Store schema 从 revision 3 升至 V4，在 `sessions` 增加：

```sql
harness_profile_id TEXT NOT NULL,
harness_profile_version INTEGER NOT NULL,
harness_profile_digest TEXT NOT NULL
```

约束：

- ID、version、64 位 sha256 hex 均做 SQL 与 runtime 双重校验；
- revision 3 → V4 migration 用冻结的 `standard@1` ref 回填全部旧 row；
- migration SQL、format digest、`SESSION_STORE_SCHEMA_MIN/MAX`、current installer 和 compatibility tests 同步更新；
- 是否允许 active owner 期间做 additive migration，必须先用双进程测试证明旧 owner 的 insert/update 与 V4 default/ref 语义不会生成未冻结 row；不能仅因 `ALTER TABLE ADD COLUMN` 可执行就宣称 online-safe。若不能证明，使用现有 offline admission gate。

为避免隐式默认，V4 runtime 的 `CreateSessionInput.harnessProfile` 必填。数据库 DEFAULT 只允许服务于经过验证的 revision 3 migration/旧二进制兼容窗口，不能成为新代码遗漏 profile 的兜底。

### 4.2 create/fork 原子性

- fresh create：CLI/TUI 先由 registry 解析 builtin profile，再把完整 ref 与 catalog row 在同一事务写入；
- `/new`：Domain payload 只允许 builtin ID，不接受 descriptor/digest；resolver 生成 ref；
- fork：拆分专用 `ForkSessionInput`，在 `BEGIN IMMEDIATE` 内从 source row 读取并复制 `settings_digest`、workspace binding、title 与完整 profile ref；调用方不得把事务外读取的 profile 重新传回；
- resume/open：catalog mapper 返回 exact `HarnessProfileRef`，缺失/非法/unknown version/digest mismatch 均返回 typed failure；
- takeover：沿用同一 row，不写新 profile，不按当前 binary default 改写。

### 4.3 checkpoint 与 replay

Profile ref 的 authority 是 `sessions` row，不是 checkpoint 或聊天 ledger。恢复顺序固定为：

```text
read + validate catalog profile ref
  → resolve exact builtin descriptor/version/digest
  → validate authority event chain / attempt receipts
  → optionally use checkpoint cache
  → assemble governed runtime
  → project profile-specific model surface
```

如果 checkpoint 冗余保存 `harnessProfileDigest`，不一致只使 cache miss 并回退 genesis replay；绝不能据 cache 覆盖 catalog。历史 tool calls 可正常留在消息历史中，但首版禁止把已有 Session 从 standard 改成 minimal，避免同一线性 Session 的模型 surface 中途改变。

### 4.4 composition receipt

首次 owned composition 以及每次新 owner generation 恢复时，在首个模型请求前生成 bounded `HarnessCompositionReceipt`：

- `sessionId`、`ownerGeneration`；
- profile ref；
- prompt digest；
- ordered tool name + description + parameter schema digest；
- context policy digest；
- extension/multi-agent enabled bits；
- final composition digest。

receipt 通过 owner-fenced Session event 与 Runtime Trace 记录，不保存 secret、完整 AGENTS 或动态 prompt 正文。相同 generation + digest 重试幂等；同一 generation 出现不同 digest fail closed。catalog ref 是选择 authority，receipt 是实际组装证据，二者职责不得混用。

---

## 5. Composition 重构方案

### 5.1 插入点

在 `assembleSessionDomain()` 内按以下顺序拆分，不改变 Agent Loop：

```text
catalog + HarnessProfileRef validation
  → toolchain/process environment
  → Session Security
  → managed process + gated ExecutionEnv
  → governed base capability catalog
  → resolve HarnessProfile descriptor
  → profile-specific extension/lsp/multi-agent composition
  → project exact model prompt/tools/context/hooks
  → persist HarnessCompositionReceipt
  → InteractiveSessionController.create()
```

建议新增窄模块：

```text
src/runtime/harness-profiles/
├── types.ts                 passive types and exact guards
├── builtins.ts              immutable standard@1/minimal@1 descriptors
├── resolver.ts              ref validation and descriptor lookup
├── tool-projection.ts       governed catalog intersection + exact manifests
├── minimal-bash.ts          schema-narrowing delegate only
├── composition-receipt.ts   bounded audit receipt/digests
└── index.ts
```

`domain.ts` 仍是 production composition root。新增模块不得 import raw `node:fs`/`child_process`、创建本地 shell、打开数据库或读取 settings；这些 authority 都由 composition root 注入。

### 5.2 Standard 稳定性

先用 characterization tests 冻结当前 standard 行为，再做抽取。重构后 `standard@1` 的：

- prompt bytes；
- base/extension/LSP tool 顺序与 schema；
- extension startup/shutdown 与 hook 顺序；
- context source注入；
- multi-agent 双门禁；
- Security/Attempt/Trace wiring；

必须与基线相同。不能以“极简测试通过”掩盖 standard 回归。

### 5.3 Fail-closed 条件

以下任一情况必须在 Agent 创建/首个模型请求前失败：

- unknown profile ID/version；
- stored descriptor digest 与 registry 不一致；
- minimal allowlist 中 `bash` 或 `edit` 缺失/重复；
- projected tool names/schema digest 与 `minimal@1` golden 不一致；
- minimal 收到非固定 system prompt override；
- minimal composition 产生 extension context/hook/tool 或 child-agent capability；
- composition receipt 与同 generation 已有 receipt 冲突；
- governed ExecutionEnv、Authorization、Attempt Gateway 或 owner fence 缺失。

---

## 6. TDD 实施阶段

阶段顺序不可跳过。每阶段都先提交能因目标缺口稳定失败的 RED，再实现 GREEN，最后在重复/更宽门禁下取得 Stable Green。

### P0：Baseline characterization 与合同冻结

状态：implemented（2026-09-04）。

目标：先证明当前 standard surface，并冻结两个 builtin descriptors。

RED tests：

- 新建 `tests/runtime/harness-profiles/contracts.test.ts`：profile ref/schema、unknown fields、digest、version；
- 新建 `tests/runtime/harness-profiles/builtins.test.ts`：`minimal@1` complete prompt 与 two-tool allowlist；
- 新建 `tests/runtime/session-runtime/harness-profile-standard.test.ts`：当前 standard prompt/tool/context/hook characterization。

GREEN：实现 `types.ts`、`builtins.ts`、`resolver.ts`，不接生产入口。

DoD：descriptor canonical digest golden 固定；`standard@1` characterization 通过；没有运行时行为变化。

提交边界：`test(runtime): freeze harness profile contracts`。

### P1：V4 durable identity 与原子 fork

状态：implemented（2026-09-04）。

目标：profile 成为 Session catalog durable truth。

RED tests：

- `tests/storage/session-store/schema.test.ts`：V4 exact SQL/format digest；
- `tests/storage/session-store/migration.test.ts`：schema revisions 1/2/3 → V4 全路径、old rows → `standard@1`；
- `tests/storage/session-store/schema-compatibility.test.ts`：active-owner migration decision 与 crash recovery；
- `tests/storage/session-store/session-store.test.ts`：create 必填 ref、invalid digest 拒绝、fork 原子继承；
- `tests/runtime/session-owner/takeover.test.ts`：generation 增加但 profile 不变。

GREEN：更新 schema、compatibility、catalog repository/mapper、SessionStore inputs 和所有生产/fixture create call sites。测试 helper 可提供显式 `standardHarnessProfileRef()`，业务 API 不得使用 optional profile。

Stable Green：清空 checkpoint 后 profile 仍一致；并发 rename/fork/create 不产生 mixed ref；若选择 online additive migration，必须有真实第二连接/进程证据。

完成效果：V4 current/max contract、exact schema/format digest、SQL/runtime ref invariant、offline-only revision 3 → V4 migration、revision 3 existing rows 的 `standard@1` backfill、必填 create ref、catalog mapping、原子 fork inheritance 和 takeover preservation 已闭合。CLI fresh create 与 Session Domain `/new` 当前显式写入/继承 `standard@1`，仅用于保持 P2/P3 前的现有行为；用户可选 `minimal` 的 CLI/TUI surface 仍属于 P3。

提交边界：`feat(storage): freeze harness profile per session`。

### P2：Profile-aware production composition

状态：implemented（2026-09-04）。

目标：从同一 governed capability 平面投影 standard/minimal。

RED tests：

- `tests/runtime/session-runtime/harness-profile-minimal.test.ts`：exact prompt bytes、exact ordered tool names、exact tool schemas；
- 验证 minimal 无 LSP、WebFetch、Skill、MCP、process helpers、`request_permissions`、Plan/Memory、`spawn_agent`；
- 验证 extension context source/hook/start 不被调用；
- 验证 `assembleAgentModelContext()` 仍产生 receipt，只含 fixed prompt + selected history；
- `tests/runtime/session-runtime/security-composition.test.ts`：minimal bash/edit 仍走 authorization、approval、attempt receipts 与 governed env；
- `tests/runtime/session-runtime/multi-agent-composition.test.ts`：即使 settings/CLI 双门禁为 true，minimal 仍无 child domain/tool；
- 两 Session 并存隔离测试：standard 保持完整，minimal 保持两工具。

GREEN：引入 resolver、tool projection、minimal bash delegate、conditional extension/multi-agent composition，并把 receipt 写入 owned Session。

Stable Green：在真实 `createEmbeddedSessionRuntime()` 路径断言 snapshot/tool count/trace receipt；模拟 missing tool、schema drift、digest conflict 均在 model call 前 fail closed。

完成效果：production composition 已由 durable catalog ref 驱动。minimal 的 fixed prompt、`bash/edit` exact order/schema、空 extension sources、无 hook/lifecycle/MCP/Skill/LSP/process helper/request-permissions/Plan/Memory/spawn-agent surface、Security/Attempt receipts、trace metadata、required MCP 不启动、multi-agent 全门禁开启仍禁用，以及 standard/minimal 同进程隔离均已有直接测试。missing/duplicate governed tool、tool manifest drift、profile digest mismatch 和 prompt override 在 controller/model call 前 fail closed；composition 阶段失败会释放刚 claim 的 owner。composition receipt 的跨 generation recovery/幂等冲突矩阵仍按 P4 扩展，不在 P2 中提前宣称 recovery closure。

提交边界：`feat(runtime): compose minimal governed harness`。

### P3：CLI、Session Domain 与 TUI 选择/显示

状态：implemented（2026-09-04）。

目标：只在创建期选择，其他路径只恢复。

RED tests：

- `tests/cli/args.test.ts`：`--harness-profile standard|minimal` 与 unknown/missing value；
- `tests/cli/session-workspace-identity.test.ts` 或新的 `session-harness-profile.test.ts`：fresh create、resume conflict、fork inherit；
- `tests/runtime/session-runtime/domain-router.test.ts`：`session.create` profile payload/CAS，fork ignores overrides；
- `tests/tui/adapters/session-domain.test.ts`、`tests/tui/session-workflows.test.ts`：`/new` inherit、显式 standard/minimal、catalog projection；
- header/catalog presentation tests：Harness 与 Permission/Thinking 分栏且只读。

GREEN：更新 args/usage、`resolveSessionId()`、Domain request/response、catalog/snapshot DTO、TUI workflow 和只读显示。不得增加 profile mutation operation。

Stable Green：standard PATH built CLI 与 minimal PATH built CLI 各创建一次隔离 Session，退出再 resume，显示和 durable ref 均一致。

提交边界：`feat(cli): select harness profile at session creation`。

完成效果：CLI、Session Domain 和 TUI 只在创建期接受 builtin profile ID；其他 open/recovery 路径只消费 durable ref。`/new` 默认继承当前 Session，显式 standard/minimal 可创建目标 profile，catalog 与当前 Session header 均提供只读身份显示。unknown/missing/额外 descriptor 字段在 mutation/attempt 前拒绝，fork payload 不能覆盖 source profile；未增加 `session.harness.set` 或其他 profile mutation。退出后新进程 resume 的 built CLI 证据已覆盖 standard/minimal，但 crash takeover、checkpoint cache 分支与 composition receipt recovery 仍属于 P4。

### P4：恢复、故障与审计闭环

状态：implemented（`1dccaa4`）；最终全量生产验收仍由 P5 收口。

目标：attach/takeover/checkpoint/trace 不发生模式漂移。

RED tests：

- healthy attach 不在 client 侧重组/覆盖 profile；
- clean resume 与 crash takeover 使用相同 ref/composition digest；
- checkpoint hit、cache corrupt、cache deletion 三条路径一致；
- composition receipt generation/digest 幂等与冲突拒绝；
- minimal tool crash 仍打开现有 recovery barrier；旧 generation 不得写 receipt；
- fork lineage 与 target catalog profile 一致。

GREEN：补齐 restore validation、receipt persistence/trace projection 和 typed diagnostics。

Stable Green：Session Owner focused suite、runtime/security/storage buckets 连续两次通过；进程级 takeover fixture 验证实际 SQLite durability。

提交边界：`feat(runtime): audit harness composition across recovery`。

完成效果：catalog ref、durable event chain 与 bounded composition receipt 在 checkpoint cache 之前完成 authority-first 校验；receipt 的 exact schema、Session、owner generation、catalog profile、composition digest 与 generation uniqueness 均 fail closed。真实 SQLite 多进程 fixture 已覆盖 healthy attach、minimal governed bash 崩溃、generation takeover、recovery barrier，以及 checkpoint hit/corrupt/deleted 的 ref/digest 稳定性；旧 owner 无法追加 receipt。fork lineage 的原子 profile 继承继续由 P1/P3 的 Store/CLI/Session Domain 直接测试覆盖。

### P5：生产验收与文档收口

状态：not started。

自动门禁：

```bash
npm run test:inventory
npx vitest run \
  tests/runtime/harness-profiles \
  tests/storage/session-store \
  tests/runtime/session-owner \
  tests/runtime/session-runtime \
  tests/cli/args.test.ts \
  tests/cli/session-workspace-identity.test.ts \
  tests/tui/adapters/session-domain.test.ts \
  tests/tui/session-workflows.test.ts
npm run test:runtime
npm run test:security-storage
npm run test:tui-native
npm run check
npm test
npm run build
npm run test:smoke
git diff --check
```

生产证据必须来自构建后的 `bin/runledger.js → dist/cli/cli.js`，使用隔离 `RUNLEDGER_DIR`，不能用 `tsx src/cli/cli.ts` 代替。

最小 E2E 矩阵：

| Case | 必须证明 |
|---|---|
| fresh standard | 未显式选择时行为与基线一致 |
| fresh minimal | provider request 只含固定 prompt 与 `bash/edit` schema |
| minimal resume | 新进程、当前 settings/AGENTS 改变后仍保持 minimal |
| minimal fork | target 原子继承 minimal |
| minimal takeover | owner crash 后 generation 增加，profile/composition 不漂移 |
| restrictive permission + minimal | 工具拒绝/审批/receipt 正常，profile 不放宽权限 |
| permissive permission + minimal | 仍只有两个模型工具，profile 不因权限宽而扩张 |
| standard + minimal 并存 | 两个 Session 的 prompt/tool/context/lifecycle 隔离 |

人工验收只记录产品显示：dark/light、80/143 列、真实键盘输入、中文 IME、干净退出。自动 PTY/frame 测试不能标记为 human verified。

---

## 7. Stop rules

出现以下任一项时停止合并，不得以降级或跳测继续：

1. standard characterization 发生非预期变化；
2. minimal provider request 出现第三个 tool 或附加 prompt fragment；
3. minimal tool 绕开 Authorization、Attempt Gateway、managed process 或 owner fence；
4. legacy row、fork、resume 或 takeover 依赖当前 settings 猜 profile；
5. migration 在 active owner 场景缺少证明却被标记 online-safe；
6. profile digest mismatch 被静默更新、clamp 或回退 standard；
7. checkpoint 成为 profile authority；
8. `--harness-profile` 可覆盖已有 Session；
9. minimal 启动 MCP/Skill/Hook 或注册 child Agent；
10. 只验证源码/单测，未验证构建后的标准 CLI。

---

## 8. 显式非目标与后续能力

首版不实现：

- 跨调用持久 PTY/Shell；
- 复制 DeepSeek `str_replace_editor` 或新增查看型 editor；
- 用户自定义 profile、任意 tool allowlist、profile 文件 discovery/marketplace；
- Session 首个模型 turn 后切换 profile；
- fork 时改变 profile；
- profile 独立修改 permission/sandbox/network/approval；
- minimal 专属模型、thinking、温度、token budget 或 provider 路由；
- 新的 compaction/Plan/Memory 实现；
- extension control-plane-only 管理模式；
- macOS/Windows 真实 runner 已验证声明。

后续若需要持久 Shell，应单独建立 governed PTY 专项，覆盖 handle ownership、输入输出 cursor、crash/takeover、sandbox、secret redaction、容量与清理；不能把当前一次性 `bash` 重命名为 persistent 来满足验收。

---

## 9. 完成定义

本计划只有同时满足以下条件才可标记 implemented：

- `standard@1`/`minimal@1` exact contracts、digests 和 public boundary 完成；
- V4 migration、create/fork/resume/attach/takeover durable semantics 完成；
- minimal 的 fixed prompt、exact two-tool schema、zero extension context/hook/multi-agent 由真实 production composition 证明；
- Security/ExecutionGateway/Attempt Gateway/owner fencing/ledger/trace negative evidence 通过；
- 标准构建 CLI 的 fresh/resume/fork/takeover E2E 通过；
- focused、bucket、full test、check、build、smoke 与 `git diff --check` 全部通过；
- 未完成的真实跨平台/人工视觉验收继续标记 pending，不以自动证据替代。

完成状态必须回写本文档的阶段表、fresh evidence、commit SHA 与未完成门禁；历史基线测试数量不能当作新实现证据。
