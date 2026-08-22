# Settings 补全计划 01：低难度——设置内核与已有能力

> 状态：partial（candidate contract/CLI、symbol/color-blind presentation、cache miss marker、Mermaid 开关、startup quiet/splash 与 shellPath 已有接线；更广泛的 TUI 外观、图片/终端能力、启动迁移与 GC 仍 planned/deferred）
>
> 本计划先建立所有后续批次共用的 settings contract，再接入不需要新增 Runtime domain、外部服务或 provider 协议的现有能力。参照 oh-my-pi `06aecdd51f07`；差距来源为 `notez/00-settings-gap-vs-oh-my-pi.md` 正文第 6、7、10 节以及各节中已经存在的 RunLedger 能力。

## 1. 目标与边界

完成后，RunLedger 应能用一个 typed/effective settings snapshot 驱动当前已有的 TUI 外观、启动行为、shell/git/GC 等能力；用户可以通过统一 config surface 读取和修改这些值，workspace 只能影响被允许的非敏感设置。

本计划不做：

- retry、compaction、memory、provider concurrency、task policy 等跨 Runtime 参数化；这些进入计划 02；
- marketplace、通知、协作、分享、浏览器、语音、secrets、外部 search 等新能力；这些进入计划 03；
- 附录 A 的模型/采样/思考/提示词项和附录 B 的后续约束实现；
- 覆盖当前未提交的 `logo`/Welcome/TUI 改动。本计划把它们视为现有工作树基线，后续只补通用 settings 接线。

## 2. oh-my-pi 对应实现

低难度批次必须沿用下面的具体模式，而不是在 RunLedger 各个组件里各写一套 JSON 读取：

| oh-my-pi 实现 | 对 RunLedger 的对应要求 |
|---|---|
| `settings-schema.ts` 的 `SETTINGS_SCHEMA` 为唯一键、类型、default、UI metadata 来源 | 新增 `src/storage/settings-schema.ts` 或等价单一模块；`ProjectSettings` 不再承担所有 default/validation 逻辑 |
| `settings.ts` 的 `Settings.get()` 先查 merged，再回退 `getDefault()` | 提供 `SettingsResolver.get(path)`/`getGroup(prefix)`；consumer 不直接读取 raw user/workspace JSON |
| `Settings.set()` 修改 global、记录 modified path、异步保存，并由 `SETTING_HOOKS` 触发副作用 | 设置修改走 composition 注入的 settings service；TUI/CLI 不直接写 JSON；副作用要有明确 hook/事件，不在渲染组件中隐式保存 |
| `#load()` 按 global → project → override 合并，`#deepMerge()` 对对象递归、对数组整体替换 | RunLedger 保留 user → workspace → session/CLI override 的优先级；workspace key 必须来自已验证 layout，禁止 cwd 任意路径成为新的 authority |
| `config-cli.ts` 根据 schema 自动列出路径、按类型解析值、对 credential 脱敏 | 增加 `runledger settings list|get|set|reset`（或同等既有 CLI command registry），值解析、错误码、输出脱敏统一复用 schema |
| `settings-defs.ts` + `settings-selector.ts` 根据 `ui.tab/group/options/condition` 渲染 | 先实现可测试的 metadata projection；TUI selector 只调用 settings service，不能直接修改 settings 文件 |

## 3. 低难度键和 RunLedger 目标 consumer

| 差距域 | 本计划首批键/设置组 | oh-my-pi 的读取链 | RunLedger 目标接线 |
|---|---|---|---|
| TUI 外观 | `symbolPreset`、`colorBlindMode`、`statusLine.preset`、`separator`、`sessionAccent`、`transparent`、`compactThinkingLevel`、`showHookStatus` | `settings-schema.ts` → `settings.ts` hooks → `modes/theme/theme.ts`、`modes/components/status-line/component.ts`、`interactive-mode.ts` | `symbolPreset` 已接入 `InteractiveMode → projectStatusIndicator`；`colorBlindMode` 已接入 `loadTheme → applyColorBlindMode → applyEnvOverrides`；其余未有 consumer 的键继续 deferred。设置变更通知只刷新已允许的 projection，不改变 session truth |
| TUI 展示 | `display.smoothStreaming`、`hideToolActivity`、`showTokenUsage`、`cacheMissMarker`；保留已完成的 `display.shimmer` 语义 | schema → `interactive-mode.ts` / transcript/status components → TUI | 复用现有 OpenTUI footer/timeline 组件；cache miss marker 已接入主 Timeline 与 transcript overlay，只改变展示 |
| 图片/终端展示 | `terminal.showImages`、`terminal.showProgress`、`images.autoResize`、`images.blockImages`、`images.describeForTextModels`、`tui.maxInlineImageColumns/Rows/Images`、`textSizing`、`hyperlinks`、`tight`、`scrollbackRebuild`、`imeSafeCursor` | schema → `interactive-mode.ts`、`tools/render-utils.ts`、`tools/inspect-image.ts` | 只配置 RunLedger 当前已注册的 images、inline renderer 和 terminal capability；不存在的 image/tool 不添加空键 |
| 其他外观 | `tui.renderMermaid`（已有 Mermaid 能力时只补开关）、`power.sleepPrevention`、`paste.largeMenuThreshold` | schema → `session/agent-session.ts`、`interactive-mode.ts`、输入控制器 | 通过既有 `src/tui`/`src/runtime` adapter 消费；平台不支持时返回明确 no-op/unsupported，不伪造启用 |
| 启动行为 | `autoResume`、`startup.quiet`、`startup.showSplash` | schema → `interactive-mode.ts`、`src/cli/main.ts` | quiet/splash 已由 startup projection 消费；`setupWizard`、`checkUpdate`、`changelogMode` 没有真实 consumer，已从 candidate schema 移除；CLI flag/runtime override 优先 |
| 本地工具外壳 | `shellPath`、`git.enabled` | schema → `settings.ts` shell config hook、git/status consumers | `src/workspace`/`src/utils/shell.ts`/现有 Git porcelain consumer；shell path 只影响受治理的 process adapter，不能绕过 ExecutionGateway |
| 本地 GC | `gc.*` 暂不纳入 schema | 未来需先有明确 GC/retention worker 和删除范围 contract | `storage prune-legacy` 只是显式迁移归档删除；本 candidate 不把它包装成 GC settings，也不在启动时自动删除数据 |

`statusLine`、`display`、`tui` 的键应按 group 形成一个 immutable snapshot，避免同一帧从多个 mutable 字段读取产生半更新布局。`logo`、`theme`、`hideThinkingBlock` 等当前已有字段继续由现有清洗和 composition 处理，不在本计划重命名。

## 4. 分阶段执行

### L0：冻结 schema 与 effective settings contract

1. 盘点当前 `ProjectSettings` 字段、workspace/user authority 和 CLI override，建立 `SettingPath`、`SettingValue`、`SettingDef`、`SettingGroup` 的最小类型。
2. 为本计划的键定义默认值、合法类型、数值边界、枚举值和 `scope`；将敏感字段标记为不可 list/export。默认值必须来自 RunLedger 当前行为或 oh-my-pi 对应 schema 的明确 default，不从 UI 猜测。
3. 把 `sanitizeProjectSettings` 拆成“解析 raw → 单键 normalize → 生成 effective snapshot”的可测试步骤；保留未知字段丢弃和非法输入安全回退。
4. 定义优先级：显式 CLI/session override > workspace settings > user settings > schema default。`recording`、credential、security policy 等已有特殊 authority 不因通用 resolver 而放宽。
5. 为每次有效配置生成稳定 digest，供后续 Session/Host command、trace 和复现使用；digest 不包含 credential 明文或绝对路径。

### L1：统一 config surface

1. 增加只读 `list/get` 和可写 `set/reset` 的 typed command；`set` 必须先 normalize，再原子保存，失败时保持原文件。
2. 输出分为人读和 JSON 两种；未知 path、类型错误、越界、scope 不允许分别返回稳定错误码。
3. TUI 后续只调用同一 service；如果本批次暂不交付完整多 tab selector，至少交付 schema-to-options projection 和单项设置入口，不能新增第二套 JSON writer。
4. 明确设置变更订阅/重新加载边界：`SettingsRuntimeStore` 负责 typed service 写回后的 reload/subscription；live display path 可通知当前 TUI，startup path 和已发出的 active turn 保持 pending/immutable，下一次启动或 turn boundary 才采用。仍未由此宣称所有 Runtime group 支持任意时刻热刷新。

### L2：接入外观与启动

1. 在 `src/cli/main.ts` composition root 解析一次 settings，并把 snapshot/service 注入 InteractiveMode、theme controller、footer/status 和已有 startup controller。
2. 将低难度表中的硬编码默认替换为 `settings.get`/group snapshot；每个 consumer 至少有默认和 override 两条测试。
3. 任何纯 TUI setting 只能改变 presentation：不能改变 timeline、reasoning 正文、ledger、provider request 或 security decision。
4. `autoResume`、quiet/splash 由 startup policy 读取；命令行显式选择优先于 settings。wizard/update/changelog 没有真实 consumer，不通过 schema 占位。

### L3：接入 shell/git/GC

1. `shellPath` 通过既有 shell/process adapter 解析，路径非法或不可执行时 fail closed 并保留诊断。
2. `git.enabled` 只关闭已有 metadata/status consumer，不影响 workspace identity、Git containment 或安全 gate。
3. `gc.*` 保持 deferred；在有独立 GC/retention worker、删除范围和恢复证据前，不从 settings 选择或触发破坏性清理。

## 5. 测试与验收

### Focused tests

- `tests/storage/settings-manager.test.ts`：schema defaults、unknown/legacy drop、类型/边界、user/workspace/override precedence、digest、权限和原子写回。
- 新增 `tests/storage/settings-resolver.test.ts`：group snapshot、静态/动态生效标记、credential redaction、invalid fail-closed。
- 新增/扩展 `tests/cli/settings.test.ts`：list/get/set/reset、错误码、JSON output、无 secret 泄露。
- 现有 `tests/tui/**`：theme/display/status/startup override 的真实 projection；当前 Logo/Welcome 测试保持不变并避免覆盖工作树改动。
- GC 保持 deferred；现有迁移测试只证明 `storage prune-legacy` 的显式 source deletion 范围，不为尚不存在的 `gc.*` settings 增加占位测试。

### Gate

低难度计划完成必须同时满足：

1. `npm run check`、focused tests、`npm test`、`npm run build` 和 `git diff --check` 通过；既有无关失败单独记录。
2. 用临时目录作为 `RUNLEDGER_DIR`，通过编译后的 `dist/cli/cli.js` 验证 settings 文件定位、权限、CLI get/set 和 TUI 启动默认值。
3. 对 TUI/CLI 改动完成真实隔离 TTY smoke；不得以 source-only 或未链接的 sibling worktree 作为证据。
4. 变更清单只包含本计划的 settings contract/consumer/tests/docs 路径；当前 dirty TUI/Logo/其他 docs 保持原样。

### Historical candidate evidence（2026-08-22；已由当前 fresh validation 取代）

- `display.cacheMissMarker` 已由 schema/resolver 注入 `InteractiveMode`，主 Timeline 和 transcript overlay 都使用同一 immutable presentation snapshot；warm cache 后连续 cold turn 不重复显示 marker。
- `tui.renderMermaid` 已由 `SettingsResolver → InteractiveMode → TUI → OpenTUI renderer` 贯通；关闭时只回退原始 Mermaid fenced Markdown source。
- `shellPath` 已做绝对路径/可执行性校验，并进入 ExecutionEnv、Security、managed process/PTY 和 sandbox launch plan；workspace 不能持有该 user-only setting。
- `display.collapseCompacted`、`startup.changelogMode`、`setupWizard`、`checkUpdate` 与 `gc.*` 没有被保留为无 consumer 的占位字段；unknown-path 和 GC 边界由测试/文档锁定。
- 早先 candidate run 记录了 `git diff --check`、`npm run check`、`npm test`（Vitest 455 files / 2817 passed / 3 skipped；Bun 128 passed / 1025 assertions）和 `npm run build` 通过；隔离 `RUNLEDGER_DIR` 的编译 CLI settings/workspace-capability smoke 通过；受控 POSIX `node-pty` Ctrl+D exit code 0。tmux `send-keys C-d` 本轮未列为通过。
- 当前 fresh validation 以 [`README.md`](README.md) 与 [`04-settings-acceptance-matrix.md`](04-settings-acceptance-matrix.md) 为准：same-version Host executable-digest acceptance 在本轮全量 `npm test` 中通过；标准 PATH TTY/人工视觉验收仍单独 pending。

这些证据只闭合 candidate slice，不代表本计划表中尚未接线的图片/终端展示、完整 startup migration、startup-only settings 的即时激活或 GC worker 已完成。

## 6. 低难度完成后的交接

向计划 02 交付：

- 可按 path/group 读取的 effective settings snapshot；
- user/workspace/override precedence 和 digest；
- 单一 config write path、credential redaction 和错误 taxonomy；
- settings change hook/refresh 机制；
- focused test fixture 工厂。

没有上述交付物时，不开始 compaction、retry 或 provider concurrency 的 settings 化；否则会重新在各子系统复制 resolver。
