# Plan 22：配置格式 YAML 支持与 settings 参数扩展

> **口径**：上游 = oh-my-pi `packages/coding-agent/src/config/settings-schema.ts`（459 项，YAML 层级 global > project > agent）；目标 = RunLedger 当前工作树，核对日期 **2026-09-18**。
> **本文定位**：跨领域实施计划。参数映射是**本计划范围内的现状事实**，不是独立 parity 报告；实施时原地维护阶段状态，不另建重复状态文件。
> **关联**：[Plan 16 工具对齐](16-omp-tool-parity-update-plan.md)（工具面裁定）、[Plan 17 loop/goal](17-omp-loop-goal-mode-adaptation-plan.md)、[Plan 19](19-omp-tool-surface-expansion-plan.md)/[Plan 20](20-omp-implementable-tools-port-plan.md)、[parity/00–02](../parity/README.md)、[plugin-mcp-skill-hooks/01](../plugin-mcp-skill-hooks/01-implementation-plan.md)（YAML 依赖决策的原始记录）、[docs/configuration.md](../../docs/configuration.md)（当前配置面用户文档）。

---

## 0. 结论摘要（先读这一节）

1. **参数映射：459 项中只有约 90 项在 RunLedger 有落点。** 其中约 40 项已对等（只是命名/层级不同），约 50 项「能力已在、可新增配置暴露」。其余约 370 项要么 RunLedger 没有对应产品面（不移植），要么与既有裁定冲突（须先裁定）。
2. **RunLedger 的配置面比 omp 小一个数量级**，差异不是「缺配置项」，而是**缺产品能力**。因此本计划的重点应放在「把已有能力暴露成配置」，而不是照搬 omp 的键名。
3. **YAML 不是格式替换，而是新增一层解析入口。** 现有全部配置载体（8 类文件）都是 JSON，且多数走 `JSON.parse` 后接**结构化清洗**（sanitizer）或 **exact schema 校验**（fail closed）。YAML 必须在**不改变任何 authority 规则**的前提下接入。
4. **有三项必须用户裁定后才能动代码**，见 §8：D1 YAML 解析器选型、D2 YAML 与 JSON 的关系、D3 参数扩展范围。其中 D1 在 `plugin-mcp-skill-hooks/01` §648/§656 已有「**未引入 YAML parser**」的历史决定，重新开启需要显式裁定。
5. **不建议一次性实现 459 项。** 建议按 §5 的 Y0–Y6 分阶段：先把 YAML 通道打通（Y1–Y3），再按收益逐批暴露参数（Y4–Y6）。

---

## 1. 上游口径

| 项 | 事实 |
|---|---|
| 参数总数 | 459（用户提供的清单，含跨分类重复项） |
| 定义位置 | `packages/coding-agent/src/config/settings-schema.ts` |
| 存储格式 | **YAML** |
| 层级与优先级 | agent config（`~/.agent/config.yml`）> project config（`.omp/config.yml`）> global config（`~/.omp/config.yml`） |
| 类型 | boolean / string / number / enum / array / record |
| 取值方式 | 每项有默认值，用户配置覆盖 |

**口径限制**：上游清单是「命名空间 + 键名」的平铺列表，未附类型、默认值与语义。因此本文的逐项判定基于**命名空间语义 + RunLedger 定向代码探查**，标注为 `EXPOSABLE` / `NEW-CAPABILITY` 的项在 Y1 需逐项回读上游实现确认默认值与边界，不得凭键名推测。

---

## 2. RunLedger 现有配置面基线

（详细字段见 [docs/configuration.md](../../docs/configuration.md)，此处只列判定依据）

| 载体 | 位置 | 解析方式 | 清洗/校验 |
|---|---|---|---|
| user settings | `<home>/settings.json` | `JSON.parse` | `sanitizeProjectSettings()` 逐字段白名单；未知键丢弃 |
| workspace settings | `<home>/projects/<wsKey>/settings.json` | 同上 | 同函数，`allowRecording=false`；部分字段**抛错** |
| security 段 | 同一 `settings.json#security` | `JSON.parse` | typebox `additionalProperties: false`，**fail closed** |
| managed security | `/etc/runledger/security.json` | `jsonFileSource()` | 同 schema + managed 收紧校验 |
| models.json | `<home>/models.json` | `JSON.parse` | 逐 provider `parseProxyProviderConfig()` |
| TUI 偏好 | `<home>/state/tui-preferences.json` | `JSON.parse` | 版本 + 枚举校验，失败回退默认 |
| MCP | `<home>/state/extensions/{user,workspaces/<wsKey>}/mcp.json` | `JSON.parse` | 严格字段白名单 + `${ENV_VAR}` 模板（拒绝 `RUNLEDGER_`） |
| Hooks | `hooks.json` | `JSON.parse` | exact keys 校验 |
| LSP | `<cwd>/lsp.json`、`.lsp.json` | `JSON.parse` | 浅合并；**注释明确「JSON only，无 YAML」** |
| marketplace catalog | `.runledger-plugin/marketplace.json` 等 | `JSON.parse` | 字节上限 + 结构校验 |
| 插件 settings | `package.json#runledger` | 包管理读取 | 声明式 schema |

**关键约束（YAML 接入不得破坏）**

- **authority 分层**：`recording` / `compaction` / `agentMode` / `marketplace` / `uiTheme` **仅 user 层**；workspace 只能**收窄**；managed 只声明 ceiling。YAML 必须复用同一 sanitizer，不得为 YAML 另写一套规则。
- **fail closed**：security 段任何未知字段使整段失效；`settings.json` 解析失败时 recording 降级为 `off` 并写 stderr。YAML 必须保持同等失败语义。
- **`sessionDir` 一律拒绝**，且不得被持久化。
- **`resolve-config-value.ts` 只支持字面值与 `${ENV_VAR}`**，不引入 `$(cmd)`。YAML 的 anchor/alias 不得成为新的求值通道。
- **沙箱冻结**：`isolation.backend` 等沙箱相关项**不新增**（AGENTS.md §2）。
- 依赖变更需审阅 `package-lock.json`；模型 catalog 变更走 `npm run generate-models`。

---

## 3. 参数映射矩阵

判定码：

| 码 | 含义 |
|---|---|
| `MAPPED` | RunLedger 已有对等设置（命名/层级不同），只需在文档或 YAML 中给出对照 |
| `EXPOSABLE` | 底层能力已在 RunLedger 中，但当前未暴露为配置 → 可直接新增字段 |
| `NEW-CAPABILITY` | 能力缺失，加配置等于新建功能 → 需独立裁定与立项 |
| `BLOCKED` | 与 RunLedger 既有裁定/非目标冲突 → 须先撤销或修改原裁定 |
| `OUT-OF-SCOPE` | RunLedger 无对应产品面，按现状不移植 |

### 3.1 已对等（`MAPPED`，约 40 项）

| omp 参数 | RunLedger 对应 | 备注 |
|---|---|---|
| `default` | `settings.model` + `settings.provider` | 拆成两个字段 |
| `debug.enabled` | `RUNLEDGER_DEBUG=1` / `--debug` | 环境变量而非 settings |
| `recap.enabled`、`recap.idleSeconds` | `recap.enabled`、`recap.idleSeconds` | 默认值一致（true / 240） |
| `compaction.*`（21 项） | `compaction.*`（19 项） | 命名不同：`keepRecentTokens`↔`retainRecentTokens`、`thresholdPercent`↔`threshold`、`supersedeReads`↔`pruneSuperseded`；RunLedger 多 `strategy`/`maxLevels`/`summaryModel` |
| `marketplace.autoUpdate` | `marketplace.autoUpdate` | 取值 `off\|notify\|auto` 一致 |
| `security.enabled` | `settings.security` 段 | RunLedger 无总开关，靠 schema fail closed |
| `bashInterceptor.enabled`、`bashInterceptor.patterns` | `settings.security.bashAnalyzerMode` + `--bash-analyzer` | RunLedger 为 `legacy\|shadow\|ast` 三态 |
| `providers.webSearchOrder`、`webSearchExclude`、`webSearchTimeoutSeconds` | `settings.webSearch.order` / `.exclude` / `.timeoutSeconds` | ⚠️ 见 §7 风险 R1：该字段当前被 sanitizer 丢弃 |
| `searxng.*`（8 项） | `settings.webSearch.searxng.*` | 字段一一对应 |
| `exa.enabled`、`exa.searchDelayMs` | `websource` 的 `ExaSettings` | 库层已有类型，settings 未接线 |
| `worktree.base`、`cleanSource`、`clone` | `--worktree` / `--worktree-ref` / `--worktree-branch` | RunLedger 为 CLI 参数 + 持久化绑定 |
| `theme.dark`、`theme.light` | `settings.theme`（syntax）+ `settings.uiTheme` | RunLedger 拆成高亮主题与界面配色 |
| `display.shimmer` | `state/tui-preferences.json#display.shimmer` | 取值 `classic\|kitt\|disabled` |
| `commands.enableClaudeUser` / `enableClaudeProject` | `settings.skills.providers`（`claude-user` / `claude-project`） | RunLedger 走统一 provider 开关 |
| `loop.mode`、`loop.conditionTimeoutMs` | `settings.loop.enabled` / `.conditionEnabled` | 语义不同：RunLedger 是总闸 + 条件开关，不是 mode |
| `auth.broker.url`、`auth.broker.token` | `runledger auth-gateway`（`--bind`、token 存储） | 形态不同：RunLedger 是独立子命令而非 settings |
| `mcp.enableProjectConfig` | MCP `workspace` 来源 | RunLedger 的 project ≈ workspace |

### 3.2 能力已在、可新增暴露（`EXPOSABLE`，约 50 项）

| omp 参数 | RunLedger 落点 | 说明 |
|---|---|---|
| `read.defaultLimit`、`read.toolResultPreview`、`read.renderMarkdown` | `src/runtime/tools/read.ts` | 现有 `DEFAULT_MAX_LINES` / `DEFAULT_MAX_BYTES` 为硬编码常量 |
| `read.summarize.*`（6 项） | read 工具 | 无摘要分支，需先建能力（可降级为 `NEW-CAPABILITY`） |
| `todo.enabled`、`todo.eager`、`todo.reminders`、`todo.remindersMax`、`tasks.todoClearDelay` | `todo` 工具 | 工具已注册，无配置面 |
| `checkpoint.enabled` | `checkpoint` / `rewind` 工具 | 工具已注册 |
| `plan.enabled`、`plan.autosave`、`plan.autosaveDir`、`plan.defaultOnStartup` | Plan Mode + `<home>/plans` | 已有 plan 工具与投影根 |
| `ask.enabled`、`ask.notify`、`ask.timeout` | `ask` 工具 + `askPort` | 工具已注册 |
| `github.enabled`、`github.cache.enabled` / `softTtlSec` / `hardTtlSec` | `github` 工具 | 工具已注册，无缓存配置面 |
| `generate_image.enabled` | `image_gen` 工具 + `imageGeneration` port | 工具已注册 |
| `web_search.enabled` | `web_search` 工具 | 工具已注册 |
| `glob.enabled` | `glob` 工具 | 工具已注册 |
| `bash.enabled`、`bash.allowCompoundCommands`、`bash.patterns`、`bash.direnv`、`bash.direnvLoadTimeoutMs` | `bash` 工具 + `shell-analyzer` | 分析器已有命令白名单 |
| `tools.maxTimeout`、`tools.outputMaxColumns`、`tools.format`、`tools.intentTracing`、`tools.abortOnFabricatedResult` | `src/runtime/tools/` 与 ExecutionGateway | 部分已有硬编码上限 |
| `tools.approval`、`tools.approvalMode` | `settings.security.approvalPolicy` / `--approval-policy` | 已对等，属命名差异 |
| `thinkingBudgets.*`（6 项） | `src/api/anthropic-messages/params.ts` | 已有 `options.thinkingBudgetTokens`，缺省硬编码 `1024`；可按 thinking level 建表 |
| `providers.cacheRetention` | `src/api/anthropic-messages/`（`cache_control`） | 缓存已实现，无配置面 |
| `providers.imageOrder` | image models 注册 | 已有 image model catalog |
| `extensionHandlers.toolCallTimeoutMs` | 扩展运行时 | MCP 已有 `toolTimeoutMs`，扩展面缺统一超时 |
| `statusLine.*`（11 项） | `src/tui/components/footer.ts` + Plan 08 | footer 已存在，无配置面 |
| `composer.recallClearedDrafts`、`composer.tokenRate`、`paste.largeMenuThreshold` | TUI composer | 组件已有，无配置面 |
| `display.showTokenUsage`、`display.showTurnTime`、`display.hideToolActivity`、`display.collapseCompacted`、`display.smoothStreaming`、`display.cacheMissMarker`、`display.pinnedAgents` | TUI 展示层 | 与 `hideThinkingBlock` 同类 |
| `tui.hyperlinks`、`tui.mouse`、`tui.tight`、`tui.titleSpinner`、`tui.titleState`、`tui.resizeScrollback`、`tui.imeSafeCursor` | `src/tui/primitives.ts` 等 | 终端能力已在，无配置面 |
| `error.notify`、`completion.notify` | TUI 通知 | 无配置面 |
| `terminal.showImages`、`terminal.showProgress` | TUI | 无配置面 |
| `collab.autoStart`、`collab.displayName`、`collab.relayUrl`、`collab.webUrl` | `packages/collab-web` + `runledger web --port` | RunLedger 是本地只读看板，无 relay/web 概念 → 仅 `--port` 对等 |
| `async.enabled`、`async.maxJobs` | `process_*` 工具 + 后台执行 | 无配置面 |
| `skills.customDirectories`、`skills.ignoredSkills`、`skills.includeSkills`、`skills.enable*` | `settings.skills` | RunLedger 用 `providers` map 表达 enable*；custom/ignored 缺 |

### 3.3 需先建能力（`NEW-CAPABILITY`）

| 组 | 数量 | 说明 |
|---|---|---|
| `model.loopGuard.*`、`model.toolCallLoopGuard.*` | 6 | RunLedger 无循环检测 |
| `retry.*` | 12 | 无重试/回退策略（仅 API 层零散错误处理） |
| `providers.streamFirstEventTimeoutSeconds`、`streamIdleTimeoutSeconds`、`maxInFlightRequests`、`fetch` | 4 | 无并发/超时配置面 |
| `providers.anthropic.serverSideFallback`、`provider.appendOnlyContext`、`features.unexpectedStopDetection`、`providers.unexpectedStopModel` | 4 | 无对应机制 |
| `shellMinimizer.*` | 7 | 无输出压缩器 |
| `tools.artifactSpillThreshold`、`artifactHeadBytes`、`artifactTailBytes`、`artifactTailLines` | 4 | 无 artifact spill |
| `gc.*` | 6 | 无 GC（只有 `storage prune-legacy` 显式删除） |
| `images.autoResize`、`blockImages`、`describeForTextModels`、`questionTimeoutMs` | 4 | 无图片后处理策略 |
| `contextPromotion.enabled` | 1 | 无上下文提升 |
| `startup.*`、`update.channel` | 6 | 无启动向导/自更新 |
| `read.summarize.*` | 6 | 见 §3.2 |

### 3.4 与既有裁定冲突（`BLOCKED`）

| omp 参数 | 冲突的既有裁定 | 需要的动作 |
|---|---|---|
| `edit.fuzzyMatch`、`edit.fuzzyThreshold` | `src/runtime/tools/edit.ts` 头注释：**「不引 fuzzy / line-ending 自动归一化」** | 修改 edit 工具设计前提，需显式裁定 |
| `edit.mode`（hashline / patch / apply_patch / sloppy）、`astEdit.enabled`、`astGrep.enabled` | [Plan 16](16-omp-tool-parity-update-plan.md) **裁定 4**：`hashline`/`ast_edit`/`ast_grep` 本期不实现，且不搭依赖脚手架；§152 给出 a/b/c 三选项**待用户裁定** | 先完成 Plan 16 §152 的三选一裁定 |
| `isolation.backend` | AGENTS.md §2：沙箱实现冻结，不新增/扩展/移植 | 需用户明确启动独立 sandbox 专项 |
| `workspace.additionalDirectories` | 工作区路径边界经 `src/workspace/` adapter 收敛；AGENTS.md §2 要求平台差异只走 adapter | 需先评估是否破坏 containment 语义 |
| `memories.*`、`memory.backend`、`mnemopi.*` | `plan-compact-memory/01` §0.2：Memory 当前 **core partial / Session Owner production unavailable** | 随 Memory 专项推进，不单独开配置 |

### 3.5 明确不移植（`OUT-OF-SCOPE`，约 300 项）

按命名空间成组列出；**组内逐项不逐一判定**，因为它们依赖 RunLedger 不存在的产品面：

| 命名空间 | 数量 | 不移植理由 |
|---|---|---|
| `hindsight.*` | 26 | 外部记忆服务集成，RunLedger 无此 provider |
| `mnemopi.*` | 26 | 同上（本地向量记忆） |
| `memories.*` | 16 | 见 §3.4（随 Memory 专项） |
| `speech.*`、`stt.*`、`ttsr.*`、`tts.*`、`speechgen.*`、`live.voice` | ~19 | 语音输入/输出，RunLedger 无音频面 |
| `images.urls.*` | 12 | 内网图片 URL 服务，RunLedger 无此服务 |
| `browser.*` | 10 | [Plan 18](18-omp-web-capability-port-plan.md) 已裁定不纳入浏览器兜底 |
| `eval.*`、`python.*` | 9 | [Plan 19](19-omp-tool-surface-expansion-plan.md)/[Plan 20](20-omp-implementable-tools-port-plan.md) 明确排除 eval |
| `commit.*` | 6 | RunLedger 无内置 commit 功能（提交由外部 git 流程负责） |
| `share.*` | 3 | 无分享服务；本地看板不等价 |
| `computer.*` | 4 | 桌面自动化，无此面 |
| `advisor.*`、`autolearn.*`、`sharpshooter.*`、`spelling.*`、`dev.autoqa*`、`magicKeywords.*`、`codexResets.*`、`snapcompact.*`、`prewalk.*`、`launch.enabled`、`vault.enabled`、`secrets.enabled`、`power.sleepPrevention`、`irc.timeoutMs` | ~40 | omp 专有增强功能，RunLedger 无对应模块 |
| `providers.tinyModel*`、`providers.tts`、`providers.judgmentProvider`、`providers.openaiWebsockets`、`providers.fireworksTier`、`providers.kimiApiFormat`、`providers.openrouterVariant`、`providers.antigravityEndpoint`、`providers.memoryModel`、`providers.autoThinking*` | ~13 | provider 专属开关，RunLedger 对应 provider 走各自 catalog/compat 配置 |
| `git.enabled` | 1 | RunLedger 无 `git` 工具（worktree 走 workspace adapter） |
| `tui.codexResetFireworks`、`tui.reactions`、`tui.maxInlineImage*`、`tui.textSizing`、`tui.vimMode*` | ~8 | omp TUI 专有交互，RunLedger TUI 无对应组件 |

### 3.6 统计

| 判定 | 约数 |
|---|---|
| `MAPPED` | 40 |
| `EXPOSABLE` | 50 |
| `NEW-CAPABILITY` | 40 |
| `BLOCKED` | 12 |
| `OUT-OF-SCOPE` | 300+ |
| 跨分类重复（清单内同一键出现在多个分类） | 计一次 |

---

## 4. YAML 配置格式设计

### 4.1 目标形态

```yaml
# <home>/settings.yaml —— 与 settings.json 等价的另一入口（形态示意）
model: claude-opus-4-6
provider: anthropic
thinkingLevel: high

recap:
  enabled: true
  idleSeconds: 240

compaction:
  threshold: 0.85
  retainRecentTokens: 20000

security:
  approvalPolicy: on-request
  network:
    mode: allowlist
    allowedHosts: [example.com]
```

**要点**：YAML 只承担**语法层**替代，**字段名、层级、authority、校验规则与 JSON 完全一致**。不引入 YAML 专属的键名映射，避免出现两套 schema。

### 4.2 解析器选型（待裁定 D1）

| 方案 | 优点 | 缺点 |
|---|---|---|
| **A. 引入成熟解析库**（`yaml`，MIT，零依赖，ESM） | 语义完整（anchor/alias/多行/注释/流式）；`plugin-mcp-skill-hooks/01` §407 原定方案；不手写解析器的长期维护负担 | 新增生产依赖，需 `package-lock.json` 审阅；该决策在 §648/§656 曾被明确**推迟**，重开需裁定 |
| **B. 自写有界子集 parser** | 零依赖，与 `src/extensions/skills/frontmatter.ts` 先例一致；边界可控 | 只能覆盖标量/列表/映射；用户写标准 YAML 会踩到「看起来对但不支持」的坑；配置面比 frontmatter 大得多，维护成本高 |
| **C. 不引入 YAML，只做 JSON + 注释友好格式** | 零风险 | 不满足本次需求 |

**建议：A。** 理由：配置面（含 `security` fail-closed 段）比 SKILL.md frontmatter 复杂得多，自写子集 parser 的「静默不支持」会直接变成用户配置失效；`yaml` 包零依赖、许可证干净，符合「依赖沿用仓库版本约束」的可审阅要求。若坚持零依赖，则必须选 B **并把支持的子集写进用户文档**，且对超出子集的语法**显式报错**（不静默忽略）。

### 4.3 YAML 与 JSON 的关系（待裁定 D2）

| 方案 | 行为 | 风险 |
|---|---|---|
| **A. 双读 + JSON 优先** | 两者都存在时读 JSON，并对 YAML 写 stderr 诊断 | 最保守，兼容现有用户；可能造成「改了 YAML 没生效」的困惑 |
| **B. 双读 + YAML 优先** | YAML 覆盖 JSON | 符合「新格式优先」直觉；但对已有 JSON 用户是隐式行为变更 |
| **C. 只读 YAML（一次性切换）** | 移除 JSON 读取 | 破坏性；与 `migrate` 的显式迁移原则冲突 |

**建议：A**，并把「双文件同时存在」作为**显式诊断**（不是静默）输出；后续如要切换优先级，另开显式迁移入口。

### 4.4 文件候选与作用域

| 现有 JSON | 新增 YAML 候选 | 作用域 |
|---|---|---|
| `<home>/settings.json` | `<home>/settings.yaml`、`<home>/settings.yml` | user settings |
| `<home>/projects/<wsKey>/settings.json` | 同目录 `settings.yaml` / `.yml` | workspace settings |
| `<home>/models.json` | `<home>/models.yaml` / `.yml` | 自定义 provider |
| `<home>/state/tui-preferences.json` | `tui-preferences.yaml` / `.yml` | TUI 偏好 |
| `<home>/state/extensions/user/mcp.json` | `mcp.yaml` / `.yml` | MCP（user/workspace 两处） |
| `hooks.json` | `hooks.yaml` / `.yml` | Hooks |
| `<cwd>/lsp.json`、`.lsp.json` | `<cwd>/lsp.yaml`、`.lsp.yaml` | LSP |
| `/etc/runledger/security.json` | `/etc/runledger/security.yaml` | managed security |

**不纳入 YAML 的载体**：`package.json#runledger`（插件声明式 settings，由包管理读取）、marketplace catalog 与 `plugins/registry.json`（机器写入的账本，非用户手写）、`auth.json`（凭据，避免引入新的凭据解析路径）。

**managed 层**：`/etc/runledger/security.yaml` 允许，但必须与 `.json` 同 schema、同收紧校验（§2 约束不放松）。

### 4.5 迁移与兼容

- **不做自动迁移**：不把 `settings.json` 转写成 YAML（与「旧数据迁移必须走显式迁移入口」一致）。
- 提供可选的 `runledger config convert --to yaml [--scope user|workspace]`（**待裁定**是否纳入本期）：只做格式转换，不改变 authority，输出前打印 diff 摘要，要求显式 `--confirm`。
- `docs/configuration.md` 需把「配置格式：仅 JSON，不支持 YAML」一节改写为双格式说明，并明确优先级与诊断行为。

### 4.6 涉及文件清单

| 文件 | 改动 |
|---|---|
| `src/storage/settings-manager.ts` | 新增 YAML 候选解析 + 复用 `sanitizeProjectSettings` |
| `src/storage/tui-preferences.ts` | 同上（复用 `parsePreferences`） |
| `src/storage/security-settings-port.ts` | 读写路径候选 + 复用 `parseSecurityConfigLayer` |
| `src/security/composition/snapshot-loader.ts`、`src/cli/runtime-host-security.ts` | `jsonFileSource` → 通用 `configFileSource`（JSON/YAML 双候选） |
| `src/providers/configured-proxy.ts` | `readModelsConfig` 双候选 |
| `src/extensions/mcp/config.ts` | `readCanonicalFile` 双候选 |
| `src/extensions/hooks/parser.ts` | `sourcePath` 候选与调用方 |
| `src/lsp/config.ts` | `["lsp.json", ".lsp.json"]` → 追加 YAML 候选；头注释更新 |
| `src/storage/resolve-config-value.ts` | **不改**（保持字面量 + `${ENV_VAR}`）；若选 D1-A，需确认 YAML anchor 不进入该通道 |
| `package.json` / `package-lock.json` | 仅 D1-A 需要新增依赖 |
| `docs/configuration.md`、`docs/subsystems/*` | 文档同步 |

---

## 5. 分阶段实施

| 阶段 | 内容 | 前置 | 验收 |
|---|---|---|---|
| **Y0** | 冻结 D1/D2/D3 裁定；把 §3 的 `EXPOSABLE` 清单逐项回读上游确认默认值与边界 | D1–D3 | 裁定记录写入本文 §8 |
| **Y1** | 解析层：新增统一的 `parseConfigText(text, format)` 与 `resolveConfigCandidates(basePath)`，只做「文本 → 未知对象」，不碰 schema | Y0 | 单测覆盖 JSON/YAML 等价性、非法输入、BOM、CRLF、空文件 |
| **Y2** | 接入 `settings`（user + workspace）与 `security` 段；**authority 与 fail-closed 语义不变** | Y1 | 现有 `settings`/`security` 测试全绿；新增 YAML 等价性测试；workspace 层 `compaction`/`agentMode` 仍抛错 |
| **Y3** | 接入其余载体（`models`、`tui-preferences`、`mcp`、`hooks`、`lsp`、managed security） | Y2 | 各载体等价性测试；managed YAML 的收紧校验与 JSON 一致 |
| **Y4** | 暴露 `MAPPED` 对照文档 + 修复 `webSearch` 未接线（§7 R1） | Y3 | `docs/configuration.md` 双格式章节；`webSearch` 可实际生效 |
| **Y5** | 按收益暴露第一批 `EXPOSABLE`：read/todo/checkpoint/plan/ask/github/image_gen/web_search/bash/tools/thinkingBudgets/display/tui | Y4 | 每项有独立字段表 + 定向测试；不改变默认行为 |
| **Y6** | 视裁定处理 `NEW-CAPABILITY` 与 `BLOCKED` 项 | 各专项裁定 | 按专项计划验收 |

**阶段纪律**：每个阶段独立可交付、可回滚；Y1–Y3 只改**解析入口**，不改任何字段语义——这是保证 authority 不被破坏的关键。

---

## 6. 验收门槛

- **YAML 与 JSON 等价性**：同一语义的 `.json` 与 `.yaml` 必须产生**逐字段相同**的解析结果（含诊断），用属性测试覆盖。
- **authority 不回归**：`recording`/`compaction`/`agentMode`/`marketplace` 仍仅 user 层；workspace 收窄规则不变；`sessionDir` 仍被拒绝。
- **fail closed 不放松**：security 段未知字段仍使整段失效；managed 层仍不得声明 profile/network/sandbox。
- **`RUNLEDGER_DIR` 与 `RUNLEDGER_SESSION_DIR` 语义不变**。
- 代码变更按 AGENTS.md §5：`npm run check` + 受影响测试；进入 `dist/` 的改动追加 `npm run build` 与真实 `runledger` 路径验证。
- 文档：`docs/configuration.md`、`docs/subsystems/{persistence,tools,extensions}.md` 同步；新增依赖需审阅 `package-lock.json`。

---

## 7. 风险

| 编号 | 风险 | 处置 |
|---|---|---|
| **R1** | `settings.webSearch` 被 `sanitizeProjectSettings()` 丢弃（已实测：写入 `settings.json` 后 `loadProjectSettings()` 不返回该字段），而 `session-runtime/domain.ts` 会消费它 | Y4 修复：补齐 sanitizer 分支。**这是现存缺陷，与 YAML 无关，应优先于 YAML 单独修复** |
| **R2** | YAML 的 anchor/alias/多行/类型隐式转换（`yes`/`on`/`1.0`）可能产生与 JSON 不同的值语义 | 选 D1-A 时禁用隐式类型转换或显式声明；选 D1-B 时直接拒绝这些语法并报错 |
| **R3** | 双格式并存导致「改了不生效」 | §4.3 的显式诊断 + 文档前置说明 |
| **R4** | 引入依赖后进入 `dist/`，影响打包与边界脚本 | 依赖审阅 + `check:*` 全跑；确认不新增 `process.platform` 分支 |
| **R5** | 照搬 omp 键名会与 RunLedger 语义冲突（如 `edit.fuzzyMatch`） | §3 判定码强制区分；`BLOCKED` 项未裁定前不动代码 |
| **R6** | 参数扩展被误当作「工具面扩展」 | 明确：本计划只暴露**已有能力**的配置；新增能力走各自专项（Plan 16/19/20） |

---

## 8. 待裁定

| 编号 | 问题 | 选项 | 建议 |
|---|---|---|---|
| **D1** | YAML 解析器选型 | A 引入 `yaml` 包 / B 自写有界子集 parser / C 不做 | **A**（见 §4.2）；注意 `plugin-mcp-skill-hooks/01` §648/§656 的「未引入」决定需显式撤销 |
| **D2** | YAML 与 JSON 的关系 | A 双读 + JSON 优先 / B 双读 + YAML 优先 / C 只读 YAML | **A** |
| **D3** | 参数扩展范围 | (a) 只做 `MAPPED`+`EXPOSABLE`（约 90 项）/ (b) 追加 `NEW-CAPABILITY`（约 40 项）/ (c) 全量对齐 | **(a)**；`NEW-CAPABILITY` 与 `BLOCKED` 逐项另立专项 |
| **D4** | 是否提供 `config convert` 迁移命令 | 是 / 否 | 否（本期），避免与「显式迁移入口」原则混淆 |
| **D5** | 是否同步修复 §7 R1（`webSearch` 未接线） | 是 / 否 | **是**，且建议先于 YAML 单独提交 |

---

## 9. 登记

- 本计划在 [`plan/README.md`](README.md) 与 [`development-doc/00-index.md`](../00-index.md) 登记。
- `docs/configuration.md` 的「配置格式：仅 JSON，不支持 YAML」小节在 Y3 完成后改写。
- 上游参数清单如推进到新 commit，需按 [parity 使用约定](../parity/README.md)重新生成事实，不在旧结论上增量推测。
