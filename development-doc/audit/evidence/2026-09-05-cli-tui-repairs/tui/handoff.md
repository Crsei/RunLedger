# TUI 修复交接

已按 test-driven-development / opentui 技能执行 RED → GREEN，仅修改约定的 TUI 显示层和必要帧布局调用点。未 stage、commit、push、build 或运行全量 check；原有 staged/provider/catalog 改动保留。

## 修改

- `src/tui/components/welcome.ts`：接收可用 body 高度 getter，缓存键包含高度；短终端合并 shortcut 行，按余量限制 recent session 槽位，整体不超过可用高度。
- `src/tui/interactive-mode.ts`：只在 assembleTree 的 Welcome 构造处注入高度；动态读取 editor desiredHeight、status + footer 真实行数、非 Welcome header 行数与 loadedResources 行数，模型 context 造成的第二 footer 行也计入预算。
- `src/tui/footer/layout.ts`：新增共享的两个空格缩进常量。
- `src/tui/primitives.ts`：只有 native footer 投影预留该缩进宽度。
- `src/tui/opentui/component-runtime/footer-editor-runtime.ts`：渲染消费同一缩进常量，消除投影 80 列后渲染再加 2 列导致 thinking 尾值被裁切。
- `src/tui/goal-plan/types.ts`、`src/tui/adapters/session-resources.ts`：PlanRenderView 保留合法 inactive 状态；非法状态仍回落 unknown。
- 测试：修改 `tests/tui/welcome.bun.test.ts`、`tests/tui/adapters/adapters.test.ts`，新增 `tests/tui/opentui-welcome-layout.bun.test.ts`。

## 证据

| 日志 | 命令 | 结果 |
| --- | --- | --- |
| red-native.log | `bun test tests/tui/opentui-welcome-layout.bun.test.ts tests/tui/welcome.bun.test.ts` | exit 1，3 个预期失败：Welcome 24 行超出 18 行预算；native 首屏缺标题；native footer 缺 think:off |
| red-plan.log | `npx vitest run tests/tui/adapters/adapters.test.ts` | exit 1，2 个预期失败：inactive 被投影成 unknown |
| green-native.log | 同 RED native | exit 0，13 tests |
| green-plan.log | 同 RED plan | exit 0，19 tests |
| focused-native.log | `bun test tests/tui/opentui-welcome-layout.bun.test.ts tests/tui/welcome.bun.test.ts tests/tui/welcome-tips.bun.test.ts tests/tui/opentui-component-runtime.bun.test.ts` | exit 0，4 files / 59 tests / 535 assertions |
| focused-vitest.log | `npx vitest run tests/tui/adapters/adapters.test.ts tests/tui/footer-status-line.test.ts tests/tui/footer-field-registry.test.ts tests/tui/footer-registry-integration.test.ts tests/tui/interactive-controls.test.ts` | exit 0，5 files / 64 tests |

`git diff --check -- <本组明确路径>` exit 0。

Native 回归用生产 TUI 帧投影 + OpenTUI native renderer，仅替换真实终端 transport。不是人工视觉、IME 或真实 provider 验收。root 统一 build 后需通过全局 runledger 实测：80×24 fresh 首屏应看到 RunLedger/Welcome/commands/Enter，footer 应完整显示 think:off；`/plan` 应显示 inactive。100×30 已有布局测试兼容，实际 TTY 复核由 root 完成。

## 模型 footer 补充修复

统一 build 后 root 在 80×24 真实 TTY 发现：有模型时 footer 增加 `ctx window` 行，原先固定 1 行 footer 预算把 Harness 行推出首屏。

- 已将 native 回归改为真实 `InteractiveMode` 装配，测试不再复制高度预算。
- 新 RED：`red-model-footer.log`，`bun test tests/tui/opentui-welcome-layout.bun.test.ts` exit 1；真实 profile + 模型 context footer 时缺少 Harness，复现 root 帧。
- 补充 GREEN：`green-model-footer.log`，4 files / 60 tests / 540 assertions，exit 0；`focused-model-footer-vitest.log`，5 files / 64 tests，exit 0。
- 定向 diff 检查 exit 0。需要 root 再次统一 build 后复核首屏同时包含 Harness、Welcome、快捷键、think:off 与 context footer。
