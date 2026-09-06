# RunLedger TUI 可配置主体色槽与思考灰色实施计划

> 状态：**implemented / Linux 自动化与构建后 TTY 已验证**。
> 日期：2026-09-06。源码核对基线：`rollback/before-composer-shape@96c7fa4`。
> 配置、预设与渲染接线已实现；最终验证结果见 §8，人工与跨平台验收单独记录。

## 1. 目标与范围

让思考正文默认呈灰色，并允许用户在 canonical RunLedger 配置文件中选择界面预设、覆盖主体色槽。提供三套内置 dark/light 配对预设。普通回答、思考、主界面和 transcript 查看使用一致的主题解析结果。

首期调整颜色，不默认增加思考斜体、边框、背景、折叠交互。继续支持现有隐藏思考功能。只修改展示与配置接线，不改变 Timeline 内容、provider 请求、权限、存储 authority 或 sandbox。

本计划是这一能力的实施入口；[05-theme.md](05-theme.md) 保留为历史设计，在实施完成时同步实际 API 与本计划链接。代码语法高亮合同继续由 [Plan 23](23-codex-syntax-highlighting-replication-plan.md) 管理。

## 2. 已核对的现状

| 当前入口 | 当前行为与改动原因 |
| --- | --- |
| `src/tui/timeline/selectors.ts` 的 `rowToBlocks()` | 思考、回答分别生成 `/thinking`、`/text`，均为无样式语义的 Markdown 块。 |
| `src/tui/presentation.ts` | Markdown 类型只有内容与流式状态，需添加展示变体。 |
| `src/tui/opentui/syntax-style.ts` | 默认文本使用 `theme.primary`，无思考专用样式。 |
| `src/tui/opentui/component-runtime/renderable-registry.ts` | 普通节点与流式稳定前缀共用样式；主题切换重新按模式加载默认值。 |
| `src/tui/theme/theme.ts` | 有 dark/light 与 `applyEnvOverrides()`，没有 `thinkingText`；旧文档中的 `thinkingFg` 不存在于当前接口。 |
| `src/tui/interactive-mode.ts` | 启动、主题切换分别加载主题并应用环境覆盖；与 registry 的解析路径分离。 |
| `src/storage/settings-manager.ts`、`src/cli/main.ts` | `settings.theme` 已用于 syntax theme，不能改作界面预设字段。 |

不能只在配置中添加色值，也不能仅修改 Markdown 的 `fg`：现有默认 syntax scope 会参与实际文字着色，必须验证最终渲染结果。

## 3. 配置合同

### 3.1 位置与字段

仅从 composition root 已解析的 `layout.settings` 读取，即默认 `~/.runledger/settings.json`；合法 `RUNLEDGER_DIR` 下使用该目录的 settings。TUI 只接收解析后的值，不自行读取文件。

新增顶层 `uiTheme`，保留 `theme` 原有语法高亮含义。首期 `uiTheme` 仅接受用户级配置，workspace 层不能覆盖终端外观；加载、保存和其他设置的读改写均须保留这一字段。

```json
{
  "uiTheme": {
    "preset": "default",
    "mode": "auto",
    "colors": {
      "common": { "accent": "#7dcfff" },
      "dark": { "thinkingText": "#777d88" },
      "light": { "thinkingText": "#6c6c6c" }
    }
  }
}
```

- `preset`：`default | neutral | high-contrast`，缺省 `default`。
- `mode`：`auto | dark | light`，缺省 `auto`。
- `colors.common/dark/light`：可选的部分色槽映射；缺少字段继承预设，不要求复制整套主题。
- `auto` 使用现有 OpenTUI `theme_mode` 信号，探测前回退 dark；显式 dark/light 固定界面模式。语法高亮控制器仍消费真实终端模式，保持既有 `theme` 行为，不被界面模式冒充终端信号。
- 配置文件编辑后重启生效；首期不增加文件监听、热重载或新的主题选择命令。现有 `/theme` 仍选择语法主题。

### 3.2 可配置色槽

沿用当前 `Theme` 字段，并新增 `thinkingText`，不为同义字段另建别名。

| 类别 | 字段 |
| --- | --- |
| 基础前景 | `primary`、`secondary`、`accent`、`muted`、`success`、`warning`、`error`、`info` |
| 表面与边界 | `background`、`surface`、`surfaceAlt`、`border`、`editorBackground` |
| 消息与工具 | `userMessage`、`assistantMessage`、`thinkingText`、`toolCall`、`toolResult`、`toolError` |
| 状态与链接 | `status`、`hint`、`link` |

主体映射必须明确：普通回答默认文字使用 `assistantMessage`，思考默认文字使用 `thinkingText`，用户文字使用 `userMessage`，一般界面文字使用 `primary`。对当前存在字段但没有对应消费路径的情况，实施时补齐或在色槽映射表中写明具体范围，不能宣称“可配置”却仍在 renderer 中硬编码。

代码块的 native syntax palette、diff 增删语义和 Mermaid 专用颜色继续遵循现有合同；UI 色槽不承诺重染所有外部高亮 token。代码、链接、标题保留局部高亮，思考色控制其普通叙述文字。

### 3.3 校验、覆盖顺序与错误处理

低到高：**内置预设 → common → 当前模式覆盖 → `RUNLEDGER_THEME_<KEY>`**。沿用环境字段大写规则，例如 `RUNLEDGER_THEME_THINKINGTEXT`；不添加第二种拼写。

仅接受 `#RRGGBB`，解析后规范化；不接受 ANSI、透明度、命名色、路径、命令或任意动态表达式。未知色槽、错误类型、非法色值忽略该项，并通过现有安全诊断入口给出一次可定位到字段的提示，不回显整个配置；非法 preset/mode 使用缺省值，其他合法字段仍生效。环境覆盖采用同样校验，移除当前任意非空字符串可进入颜色通道的行为。

背景派生规则：当前模式下若显式设置 `editorBackground`，终端背景探测不得覆盖它；否则按既有算法从有效背景计算。显式 `background` 优先于探测值；没有覆盖时保留现有终端背景自适应。必须在解析结果中携带必要的覆盖来源，避免仅凭“颜色等于默认值”猜测用户意图。

解析为不可变的有效主题快照，附独立的展示 revision。新 revision 不修改 Timeline 的 `contentGeneration`，无配置时不自动写 settings，不改变真实用户文件。

## 4. 内置预设

每个预设包含 dark/light 两套完整有效色槽，允许通过基底与补丁构造；不得修改共享基底对象。以下为拟定色值，实际视觉验收完成前不宣称可访问性达标。

`default` 保留现有界面视觉；将 `userMessage` 默认值对齐当前实际用户文字的 `primary`，避免接通语义字段后把用户整段文字意外染蓝。其余未列字段继承当前 dark/light，新增思考灰色。另两套继承 `default` 并应用下表。

| 色槽 | default dark / light | neutral dark / light | high-contrast dark / light |
| --- | --- | --- | --- |
| `primary` | `#e6e6e6` / `#1a1a1a` | `#e5e5e5` / `#202020` | `#ffffff` / `#000000` |
| `assistantMessage` | `#e6e6e6` / `#1a1a1a` | `#e5e5e5` / `#202020` | `#ffffff` / `#000000` |
| `userMessage` | `#e6e6e6` / `#1a1a1a` | `#e5e5e5` / `#202020` | `#ffffff` / `#000000` |
| `thinkingText` | `#777d88` / `#6c6c6c` | `#909090` / `#666666` | `#b0b0b0` / `#505050` |
| `secondary` | `#a0a0a0` / `#444444` | `#aaaaaa` / `#505050` | `#cccccc` / `#303030` |
| `muted`、`hint` | `#666666` / `#888888` | `#808080` / `#707070` | `#aaaaaa` / `#505050` |
| `accent` | `#7dcfff` / `#0066cc` | `#b0c4de` / `#365f87` | `#80dfff` / `#004c99` |
| `background` | `#0b0e14` / `#ffffff` | `#141414` / `#fafafa` | `#000000` / `#ffffff` |
| `surface` | `#11151c` / `#f5f5f5` | `#1c1c1c` / `#f0f0f0` | `#101010` / `#f0f0f0` |
| `surfaceAlt` | `#1a1f29` / `#eaeaea` | `#262626` / `#e5e5e5` | `#202020` / `#e0e0e0` |
| `border` | `#2b3340` / `#cccccc` | `#404040` / `#bbbbbb` | `#808080` / `#606060` |

`editorBackground` 使用既有 dark 12% 白混入、light 4% 黑混入算法，从预设有效背景派生；显式覆盖遵守 §3.3。三个预设都将思考正文设为灰色，较亮的 high-contrast 思考色适合需要更强可读性的暗色终端。

最小配置示例，三者任选其一：

```json
{ "uiTheme": { "preset": "default", "mode": "auto" } }
```

```json
{ "uiTheme": { "preset": "neutral", "mode": "dark" } }
```

```json
{ "uiTheme": { "preset": "high-contrast", "mode": "light" } }
```

实施时将以上三个可解析示例放入现有 examples 体系，并在配置文档说明它们是 settings 片段。安装、启动不得自动覆盖用户配置。

## 5. 实施步骤

### P1：配置与主题解析

- 扩展 `settings-manager.ts` 的类型、清洗、保存合同；用户层读取 `uiTheme`，覆盖缺省、非法输入与其他设置保存时的保留行为。
- 在 `src/tui/theme/` 下实现内置预设与纯解析器；输出完整 `Theme`、有效模式、覆盖来源和诊断。
- `src/cli/main.ts` 通过 composition root 读取配置并注入 TUI；不新增隐式配置目录。
- 为所有色槽建立消费位置清单，核查 foreground、背景填充和 env 覆盖的实际接线。

### P2：统一主题传递

- `InteractiveMode` 与 OpenTUI frame/runtime 接收同一份有效主题快照。
- `syntax-style.ts` 改为消费有效 Theme，不再自行按模式调用 `loadTheme()`。
- `RenderableRegistry` 移除独立默认主题解析；`FrameRuntime` 传递有效 UI 主题与真实终端模式时区分两者。
- 主题 revision 更新必须使已有主面、overlay、用户行、Footer、输入区和滚动条刷新；固定模式不被终端事件重置，auto 不丢配置覆盖。

### P3：思考展示语义与节点样式

- Markdown `PresentationBlock` 添加可选 `variant: "thinking"`；缺省为普通回答。`rowToBlocks()` 赋值；不根据 id 后缀判断语义。
- registry 管理普通与思考两份 Markdown 样式；只改变默认叙述文字颜色，局部高亮保持原有规则。
- 创建、节点复用、流式追加、最终完成、稳定前缀拆分、历史恢复均传递 variant；已稳定节点也必须记录足够语义以便主题更新。
- 样式 variant/revision 进入必要的渲染失效判断，不能因内容不变而漏更新；切换主题后正确释放旧 `SyntaxStyle`，禁止销毁仍被节点引用的样式。
- 覆盖主时间线与 transcript 查看共用和独立路径，隐藏思考后的重新投影保留样式。

### P4：验证、说明与交付

- 在既有 settings、selectors、OpenTUI transcript/syntax 测试中加入行为回归，避免只比较实现文本或重复色表常量。
- 更新 `05-theme.md` 的相关事实与配置示例、用户配置说明和所属索引，不扩大为整套历史文档重写。
- 当前工作树存在其他任务暂存与未暂存测试，实施前重新核对；保留原工作，必要时用 sibling worktree，最终只提交本专项改动。

## 6. 验证矩阵与完成标准

| 领域 | 必需证据 |
| --- | --- |
| 配置 | 无字段默认、三个预设、三种模式、common/模式/env 优先级、非法输入安全回退、保存往返、用户级作用域。所有测试使用隔离目录。 |
| 色槽 | 主体文字、思考、用户文字、背景与代表性 UI 槽的覆盖实际到达渲染结果；default 下普通回答及用户文字保持原有视觉。 |
| Markdown | 相同文字分别作思考/回答，在 renderer 字符格或样式数据上颜色不同；代码、链接、粗体后正确恢复基础颜色。 |
| 生命周期 | 流式追加、稳定前缀、表格拆分、最终完成、恢复历史、隐藏/显示、相同内容 variant 更新和主题切换。 |
| 双面与资源 | 主界面/transcript 一致；切换后旧节点更新，无陈旧样式引用、无不必要的整段内容重置。 |
| 自动化 | 受影响测试使用当前 bucket runner；`npm run check` 保留完整输出，再运行 `npm test`、`npm run build`、`git diff --check`。已通过且工作树未变化的检查不重复。 |
| 真实 CLI | 构建后核对 `command -v runledger`、`readlink -f`、`npm ls -g --depth=0`；隔离 `RUNLEDGER_DIR`，80/143 列、dark/light、三个预设及单槽覆盖，通过真实 TTY 验证提交后的思考与回答。 |
| 人工 | 验收灰色可读性、局部高亮、主题切换无闪回；自动捕获不等于人工视觉验收，macOS/Windows 未运行时保留 pending。 |

仅在配置与渲染生产接线、对应自动化、构建后 CLI 验证完成后标记 implemented；人工和平台证据分别记录。若受既有无关问题阻塞，记录具体失败与影响，不能用通过的 helper 测试代替最终效果。

## 7. 进度

| 阶段 | 状态 |
| --- | --- |
| 计划与配置合同 | 已落实到代码与配置说明 |
| P1 配置与解析 | implemented |
| P2 统一主题传递 | implemented |
| P3 思考样式接线 | implemented |
| P4 测试与交付 | implemented；主 PATH 集成记录见 §8 |
| 人工与跨平台验收 | pending |

## 8. 实施记录与证据（2026-09-06）

- 新增 `src/contracts/ui-theme.ts` 纯配置合同，保持 storage → contracts 的依赖方向；没有 storage → TUI 反向依赖。
- 用户级 `uiTheme` 支持三套预设、auto/dark/light、common/模式/env 覆盖及字段级安全诊断。示例见 [examples/ui-themes](../../examples/ui-themes/README.md)，现行色槽映射见 [05-theme.md](05-theme.md)。
- 主界面与 transcript 的思考色已接通，保持普通回答与用户文字独立配置；复用节点、稳定表格前缀、主题 revision 和 shimmer 颜色缓存均覆盖更新路径。
- OpenTUI 的 `fg` 与 syntax default 必须同时设置。主题切换先 `refreshStyles()`，再恢复 finalized 子节点；回归曾复现“主题切换后已完成段落空白”，修复后通过实际字符格颜色验证。
- UI 固定模式不覆盖 syntax theme / Mermaid 的真实终端模式。初始终端模式可能为 null，只有 dark/light 信号参与解析。
- 新增测试 `ui-theme.test.ts`、`ui-theme-rendering.bun.test.ts`，扩充 settings 保存往返测试；未把原工作树的其他测试改动纳入本专项。
- 可重放 CLI 验证工具见 [tests/manual/ui-theme](../../tests/manual/ui-theme/README.md)。第一轮完整矩阵 13/13 通过：三预设 × 两模式 × 两宽度，加单槽覆盖，主面与 transcript 色值符合预期，所有 CLI 退出 0。证据 `/tmp/rl-theme-matrix-pw5wdr_l/summary.json`；使用独立工作树的构建后 CLI，属于 Linux 真实 TTY 合成历史验证。
- 原始提交基线的全量测试在 `tests/tui/adapters/adapters.test.ts` 出现两项既有 Plan Mode `unknown`/`inactive` 预期失败。原工作树已有该修正；为验证最终合入状态，临时借用原工作树现有测试改动后重新运行门禁，借用文件不进入本专项提交。
- auto 模式额外通过真实终端通知 + OSC 10/11 回复验证：思考从 `#777d88` 切换为 `#6c6c6c`，transcript 同步且退出 0；证据 `/tmp/rl-theme-matrix-i02tmhoa/summary.json`。重放工具已将此例纳入完整 14 例矩阵。
- 最终 `npm run check`、`npm run build` 退出 0，完整日志 `/tmp/rl-plan27-check-delivery.log`、`/tmp/rl-plan27-build-delivery.log`。
- `npm test` 的 singleton/runtime/security-storage/integration 分组全部通过；在 native 分组发现默认链接颜色兼容回归后，将 `link` 的默认值对齐原有 cyan。随后完整重跑 `npm run test:fast`、`npm run test:tui-native`，均退出 0（native 149 tests）。所有 local 分组已有通过证据，但没有将先前退出 1 的单次 `npm test` 记作退出 0。日志 `/tmp/rl-plan27-integrated-tests.log`、`/tmp/rl-plan27-fast-delivery.log`、`/tmp/rl-plan27-native-delivery.log`。
- 最终构建后 CLI 完整矩阵 14/14 通过：`/tmp/rl-theme-matrix-1ij6pvpu/summary.json`，含 auto 切换；主面/transcript 思考颜色一致、所有 CLI 退出 0。
- 实现提交 `f052aaa` 已快进合入 `rollback/before-composer-shape`；原工作树 `npm run build` 退出 0（`/tmp/rl-plan27-main-build.log`）。`command -v`、`readlink -f`、`npm ls -g --depth=0` 确認全局入口指向本仓库 `bin/runledger.js`。
- 实际 PATH `runledger` 完整矩阵再次 14/14 通过，所有退出码为 0：`/tmp/rl-theme-matrix-cmwpc9ah/summary.json`（`/tmp/rl-plan27-path-matrix.log`）。原有暂存 patch 与 20 个既有测试文件逐一核对未变。
- 人工视觉、中文 IME、真实 provider 与 macOS/Windows 未执行，不宣称通过。
