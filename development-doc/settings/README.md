# RunLedger Settings 补全计划

> 状态：partial（本地分支含 settings/runtime candidate commits；整体尚未验收）
>
> 本计划以 `development-doc/notez/00-settings-gap-vs-oh-my-pi.md` 的正文差距为输入，并以 oh-my-pi `06aecdd51f07` 的 coding-agent settings 实现为参照。RunLedger 当前基线为 `b23b900921f9`；本地 settings/runtime candidate commits 不代表已合并或已接受。

## 1. 计划入口

| 难度 | 文档 | 目标 |
|---|---|---|
| 低 | [`01-low-complexity-settings-plan.md`](01-low-complexity-settings-plan.md) | 建立可复用 settings schema/resolver/config surface，并把已有的外观、启动、运维能力配置化 |
| 中 | [`02-medium-complexity-runtime-settings-plan.md`](02-medium-complexity-runtime-settings-plan.md) | 为已有 retry、compaction、memory、工具、provider、workspace/session Runtime 补齐有效配置和跨模块接线 |
| 高 | [`03-high-complexity-capability-settings-plan.md`](03-high-complexity-capability-settings-plan.md) | 处理需要新增 Runtime 能力、外部服务、跨进程状态、敏感数据或安全审计的 settings |
| H0 inventory | [`05-high-complexity-capability-inventory.md`](05-high-complexity-capability-inventory.md) | 逐 capability 区分 settings missing、capability missing、owner/consumer、外部 effect、durability/recovery、证据与解封条件 |
| 验收矩阵 | [`04-settings-acceptance-matrix.md`](04-settings-acceptance-matrix.md) | 逐 group 区分 production consumer、schema/projection only、deferred、blocked/pending acceptance 与 fail-closed；不把计划或 schema 当完成证据 |

实施顺序是低 → 中 → 高；每一份计划可以拆成多个小提交，但不能跳过前一层的 settings contract、authority 和测试门。

### H0：Capability inventory 与解封清单

H0 的逐 capability 盘点见 [`05-high-complexity-capability-inventory.md`](05-high-complexity-capability-inventory.md)。在 owner、authority、durability、受控外部证据闭合前，H1–H5 保持 deferred；不为缺失能力新增空 schema 字段。

当前每个 group 的事实状态、provider retry 证据边界、明确 deferred 项和本轮 fresh validation 统一看 [`04-settings-acceptance-matrix.md`](04-settings-acceptance-matrix.md)。高复杂度 capability 的逐项解封前盘点看 [`05-high-complexity-capability-inventory.md`](05-high-complexity-capability-inventory.md)。本 README 负责总体范围和交接，三份专题计划负责实施边界，inventory 负责 H0 缺口判定，矩阵负责验收判定。

## 2. 范围与明确延期

### 2.1 本轮纳入

纳入差距分析正文的第 1–10 节：重试/回退、压缩、记忆/学习、工具、Provider/服务、TUI/外观、启动/更新、协作/共享、会话/工程、运维。正文中已经存在但只缺 settings 接线的能力，按低或中难度处理；正文中连能力也不存在的项目，按高难度处理。

### 2.2 附录不实现

以下内容不进入任何实施批次，也不因为出现在 oh-my-pi schema 中就提前加入 RunLedger：

- 附录 A 的模型/采样/思考/提示词/循环保护核实项，包括 `modelRoles`、`defaultThinkingLevel`、`thinkingBudgets.*`、`temperature`、`topP`、`topK`、`minP`、`presencePenalty`、`repetitionPenalty`、`textVerbosity`、`externalThinking`、`omitThinking`、`proseOnlyThinking`、`personality`、`inlineToolDescriptors`、`includeModelInPrompt`、`includeWorkspaceTree`、`model.loopGuard.*`、`model.toolCallLoopGuard.*` 等。
- `provider.appendOnlyContext` 虽在正文 Provider 表中重复出现，但同时属于附录 A 待核实项；本轮按附录延期处理。
- 附录 B 的后续落位约束不拆为实施任务，不计入本轮完成度。真正实施时仍必须遵守 RunLedger 当前已经存在的 user/workspace authority、fail-closed、安全路径和文件权限规则；这不是把附录 B 提前实现。

计划中出现“schema”时，含义是把已经确认的正文能力暴露为 settings；不是为了填满 oh-my-pi 的约 230 个键而创建无消费者的占位字段。任何没有真实消费者、测试和安全边界的键都必须停在高难度计划的 `deferred` 状态。

## 3. 两个仓库的实现基线

### 3.1 RunLedger 当前设置 authority

当前 `src/storage/settings-manager.ts` 已经具备：

- canonical user settings：`layout.settings`，默认用户目录由 `RunledgerLayout` 决定；
- canonical workspace settings：`layout.projects/<workspaceKey>/settings.json`；
- JSON 解析、已知字段清洗、未知/legacy 字段丢弃、`0o600` 文件和 `0o700` 目录；
- `recording` 只能由 user settings 持有；`multiAgent` 已有 user/workspace 分层诊断与收窄语义；
- recap、provider/model/thinking、theme、enabledModels、队列模式、autoTitle、hideThinking、logo、skills 等已存在字段。

本 worktree 的 candidate 另外新增了 `src/storage/settings-schema.ts`、`settings-resolver.ts`、`settings-policies.ts`、`settings-service.ts`，以及 retry、compaction、tool output、provider concurrency/filter、local memory gate 的候选接线。此前 candidate 的 check/test/build 与 smoke 记录不等于本 worktree 当前 fresh acceptance；各 group 仍需逐项 authority、production composition 和 human acceptance 审阅后才能标为 implemented。

当前已经有真实 consumer 的展示/启动接线包括 `symbolPreset`、`colorBlindMode`、`display.cacheMissMarker`、`tui.renderMermaid`、`startup.quiet`、`startup.showSplash` 与用户级 `shellPath`。其中 symbol preset 只切换状态指示器符号，color-blind mode 只替换语义色；cache miss marker 只在 warm cache 后连续 cold turn 的边界显示一次，Mermaid 关闭时回退 fenced Markdown source；这些都只改变 presentation，不改变 ledger、prompt 或 provider request。`InteractiveMode` 的 `/settings` 通过 `SettingsPanel` 和 typed editor port 接入，`SettingsRuntimeStore` 负责 set/reset 后 reload/subscription，已应用的 live display path 通知当前 TUI；startup path 保留为 pending 值，下一次 Session/TUI startup 才采用。工具侧 `tools.read.renderMarkdown` 已由 `ToolPolicy` 注入 `createReadTool`，再经 read result projector 生成 TUI Markdown body；它只改变展示 projection，不改变模型可见正文。

当前明确不宣称完成的边界：

- `tools.approvalMode` 只生成 RunLedger approval projection，不能覆盖 Security/ExecutionGateway 的最终 deny；
- retry 目前通过 Session 的 root/child/title/summarizer request seam 注入；OpenAI/Anthropic/Azure 的 SDK 主要只证明 `maxRetries`，Codex adapter 才消费独立的 retry count/base/max delay，Google/Vertex/Bedrock/Mistral 等 transport 尚无统一 retry settings consumer；
- provider in-flight gate 现在由同一 Session 的 root/child/title/summarizer 共享；这不代表全 provider retry/fallback parity，也不代表跨 Session 或运行中 reload；
- `providers.imageOrder` 没有图片生成选择 consumer，已从 canonical schema/provider projection 移除并保持 deferred，不再重排 chat 默认模型；
- `symbolPreset` 与 `colorBlindMode` 已进入 canonical schema、effective display projection 和 InteractiveMode；它们是 startup-only presentation settings，仍需标准 TTY/人工视觉验收后才能脱离 partial；
- `workspace.additionalDirectories` 已经经过 canonical path adapter 接入 Session Security roots；公共投影仍只暴露 root 数量/digest，越界、symlink 和跨 root 输入 fail closed；
- `task.*` 不能扩大 bounded multi-agent 的递归、并行或 authority；`plan.enabled` 与 `plan.defaultOnStartup` 已有 Host/Session candidate consumer，但仍需整体 production/human acceptance；
- `goal.enabled`、`goal.statusInFooter`、`goal.continuationModes`、`title.refreshOnReplan`、`tasks.todoClearDelay` 没有完整 production consumer，已从 canonical schema 移除并保持 deferred；unknown-path 测试锁定 fail closed；
- `display.collapseCompacted`、`startup.changelogMode` 以及 startup projection 中没有真实 consumer 的 `setupWizard`/`checkUpdate` 已从 candidate schema 移除；unknown-path 测试锁定 fail closed；
- `gc.*` 尚未进入 schema。现有 `storage prune-legacy` 是显式迁移归档删除，不是自动 GC/retention worker，不能用它宣称 GC settings 已接线；
- Plan 的 `defaultOnStartup` 只让没有 Plan snapshot 的新 Session 以 `pending` 开始，首次 `plan.activate` 后才持久化；恢复已有 snapshot 时不覆盖 durable state，且 `plan.enabled=false` 同时关闭 Host Plan operation、context fragment 和 Session Plan capability；
- 只有存在真实 consumer、组合测试和安全边界的字段才能从 candidate/partial 进入 implemented。

因此本计划不再引入 oh-my-pi 的 YAML 文件、其 agent-dir 路径或第二套持久化 authority。需要借鉴的是 oh-my-pi 的 schema、有效值解析、分层合并、运行时读取和 consumer 接线方式。

### 3.2 oh-my-pi 的可复用实现链

oh-my-pi 当前实现不是“只在 schema 加字段”，而是下面的闭环：

```text
SETTINGS_SCHEMA
  -> Settings.#load / #rebuildMerged
  -> Settings.get / getGroup / isConfigured
  -> SettingHook 或具体 session/tool/provider consumer
  -> config CLI 与 settings panel
  -> focused tests + feature tests
```

对应源码入口如下：

| 责任 | oh-my-pi 参照 |
|---|---|
| 类型、默认值、枚举、UI metadata、credential marker | `packages/coding-agent/src/config/settings-schema.ts`：`SETTINGS_SCHEMA`、`SettingPath`、`SettingValue`、`getDefault()`、`getUi()`、`isCredential()` |
| global/project/override 合并与默认值 | `packages/coding-agent/src/config/settings.ts`：`Settings.get()`、`set()`、`override()`、`#load()`、`#rebuildMerged()`、`#deepMerge()` |
| 文件加载、旧配置迁移、加锁写回、保留外部修改 | `packages/coding-agent/src/config/settings.ts`：`#loadGlobalSettings()`、`#loadProjectSettings()`、`#saveNow()`、`#saveProjectNow()` |
| 动态 config CLI、值解析、credential 脱敏 | `packages/coding-agent/src/cli/config-cli.ts`：`parseAndSetValue()`、list/get/set/reset 路径处理 |
| 设置面板 | oh-my-pi：`packages/coding-agent/src/modes/components/settings-defs.ts`、`settings-selector.ts`；RunLedger：`src/tui/components/settings-panel.ts`、`src/tui/settings-selector.ts`、`src/tui/interactive-mode.ts` 的 `/settings` port；面板由 schema metadata 驱动，写入仍回到 SettingsService/RuntimeStore |
| 运行时设置副作用 | `packages/coding-agent/src/config/settings.ts` 的 `SETTING_HOOKS`；例如 theme、symbol、color-blind、provider semaphore、credential redaction |
| 请求层投影 | `packages/coding-agent/src/session/settings-stream-fn.ts`；每次请求读取 provider routing、timeout、retry delay、in-flight 和 server fallback |
| 具体 feature consumer | `session/session-maintenance.ts`、`session/retry-fallback-chains.ts`、`session/agent-session.ts`、`tools/index.ts` 及各工具、`config/provider-globals.ts`、`modes/interactive-mode.ts` |

RunLedger 的实施必须保留同一条“schema → resolver → consumer → surface → test”追踪关系；只把文件格式和安全 authority 换成 RunLedger 已冻结的 JSON/layout/Host 组合。

## 4. 难度划分和正文映射

| 计划 | 判定标准 | 正文差距映射 |
|---|---|---|
| 低 | 能力已经在 RunLedger 中存在，只需 schema/default/normalize、既有入口读取和单一持久化；不新增 provider 协议、外部服务或 durable domain | 第 6 节主要外观展示、第 7 节已有 CLI 启动项、第 10 节 shell/git/GC；设置内核和通用 config surface |
| 中 | 能力已经存在，但需要多个 Runtime/Host/provider/tool 模块共同消费同一 effective snapshot，或需要把硬编码阈值/策略变成可验证配置 | 第 1 节基础 retry、第 2 节基础 compaction、第 3 节 local memory backend、第 4 节已有工具与 task/LSP、第 5 节已有 provider catalog/request limits、第 9 节 workspace/plan/goal/title |
| 高 | 缺少能力本体，或涉及外部网络/凭据/进程/跨客户端 durable 状态/安全授权；settings 只是其中一个入口 | 第 1 节 model/usage-aware fallback、第 2 节 idle/remote/snapcompact/loop、第 3 节 autolearn/mnemopi/hindsight、第 4 节新工具与 eval/speech/browser、第 5 节 search/broker/codex reset、第 7 节 marketplace/notify、第 8 节 collab/share、第 9 节 branch/commit map-reduce、第 10 节 secrets/autoqa |

## 5. 通用实施门

每一个 settings group 在进入 `implemented` 前必须具备以下证据：

1. schema 定义了类型、默认值、合法范围/枚举、user/workspace/session/CLI authority；没有默认值猜测。
2. loader/resolver 能处理缺失、非法、越界、未知字段，并输出稳定的 effective snapshot；非法安全策略必须 fail closed。
3. 至少一个真实 production consumer 使用 snapshot。只在 `ProjectSettings` 或 JSON 中保存、但 Runtime 仍读硬编码，不算完成。
4. consumer 的行为测试覆盖默认、合法覆盖、非法回退、层级优先级和 CLI/runtime override；涉及 TUI/CLI 的项目再做隔离 `RUNLEDGER_DIR` smoke。
5. provider、工具、compaction、memory、Host/Session 等跨模块项必须有组合链测试；不能只通过 settings-manager 单测。
6. 文档只记录 fresh validation；历史提交、oh-my-pi 源码测试或已有 TUI 截图不能冒充 RunLedger 当前验收。

基础命令仍按 RunLedger `AGENTS.md` 执行：纯文档变更至少 `git diff --check`；代码阶段依次执行 `npm run check`、相关 focused tests、`npm test`、`npm run build`，涉及 CLI/TUI 时用隔离 `RUNLEDGER_DIR` 验证真实编译产物。

## 6. 总体 stop rules

- 不把 oh-my-pi 的一对一键名映射当作设计完成；先确认 RunLedger 的 authority 和真实 consumer。
- 不把新 schema 键当成未实现能力的占位宣传；能力缺失时进入 `deferred`，并写明解封条件。
- 不让 settings 绕过 ExecutionGateway、Approval、Workspace containment、Session Owner 或 credential redaction。
- 不在本次计划中推进附录 A/B；需要模型/采样核实时另开专项，不向本计划追加隐式范围。
- 每个实现提交只覆盖一个小 settings slice；保留当前工作树无关改动，禁止宽泛暂存。

## 7. Candidate validation（2026-08-22）

本 worktree 的 settings candidate fresh validation（2026-08-22）记录如下；完整逐组判定和仍未接受的 capability gap 以 [`04-settings-acceptance-matrix.md`](04-settings-acceptance-matrix.md) 为准：

- `git diff --check`、`npm run check`、settings/runtime/TUI focused tests（22 files / 198 tests）和 `npm run build` 通过；
- `npm test` 通过：Vitest 463 files passed、1 skipped，2877 tests passed、3 skipped；随后 Bun/OpenTUI 128 tests、1024 assertions 通过；
- 隔离 `RUNLEDGER_DIR` 下用当前 `dist`/`bin/runledger.js` 实测 `--version`、`--help`、`symbolPreset`/`colorBlindMode` 的 settings `get/set/reset`，并确认 settings 文件为 `0600`；
- `which runledger` 与 `readlink -f` 确认全局 shim 指向本 worktree 的 `bin/runledger.js`；
- 隔离 `RUNLEDGER_DIR` 的 tmux TTY 启动 frame 已观察到；当前自动探针在 Esc、Esc、Ctrl+D 后仍保持运行，未将强制终止新建 session 计为 clean exit。标准 PATH PTY、Ctrl+D clean exit 和人工视觉验收仍 pending，已有自动 TTY/视觉记录不能代替 human acceptance。

这些是当前本地分支 candidate 的仓库级 fresh gates，不等于各 settings group 已完成 production/TTY/human acceptance；标准 TTY/human gate、逐组状态和 provider 矩阵以 [`04-settings-acceptance-matrix.md`](04-settings-acceptance-matrix.md) 为准，H0 解封边界以 [`05-high-complexity-capability-inventory.md`](05-high-complexity-capability-inventory.md) 为准。
