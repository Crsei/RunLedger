# Mermaid 图表渲染许可清单

状态：M7 实现清单；未引入参考实现源代码，formal license/NOTICE review 待维护者确认

本清单与 `development-doc/tui/21-mermaid-diagram-rendering-implementation-plan.md` 配套。M0 的 fixture 以及 M1–M7 的 parser、layout、canvas、projection 和 adapter 均作为 RunLedger 维护者实现；它们不复制 `grok-build` 的 Rust parser、layout、canvas、PNG engine 或 pager worker 源代码。清单记录实现边界，不替代维护者或法律审阅。

## 当前仓库与直接依赖

| 项目 | 版本/来源 | 许可 | 本专项使用方式 |
|---|---|---|---|
| RunLedger | 当前仓库 | MIT | Mermaid parser/layout/render 与 OpenTUI adapter 的实现载体 |
| `@opentui/core` | 0.4.5，`anomalyco/opentui` | MIT | 既有 `MarkdownRenderable`、`createMarkdownCodeBlockRenderer` 与 native test renderer |
| `string-width` | 7.2.0，Sindre Sorhus | MIT | R1 display-column authority；不复制其实现 |
| `strip-ansi` | 7.1.2，Chalk | MIT | 既有 TUI 测试/文本辅助；不复制其实现 |

以上版本以 M0 worktree 的 `package-lock.json` 与依赖 `package.json` 为准。依赖升级时必须重新审阅许可与显示宽度行为。

## M7 实现盘点

| 实现范围 | 当前工作树路径 | 许可结论 |
|---|---|---|
| bounded Mermaid parser、IR、layout、typed-array canvas、semantic projection、cache | `src/tui/mermaid/` | RunLedger 自有实现，按仓库 MIT 发布；未复制参考实现代码 |
| OpenTUI Markdown renderer seam、native block renderable、theme/selection/lifecycle adapter | `src/tui/opentui/mermaid-*.ts`、`src/tui/opentui/component-runtime.ts` | RunLedger adapter，调用已审计的 `@opentui/core` MIT API |
| pure/native fixtures 与回归测试 | `tests/tui/mermaid/`、`tests/tui/opentui-mermaid.bun.test.ts` | 测试资产由本仓库维护；不引入外部 diagram corpus 文件 |

M7 没有新增 npm Mermaid engine、Chromium、`mmdc`、外部字体、网络资源或 R2 sidecar；构建产物只包含现有 RunLedger MIT 代码与已声明依赖。因此当前不新增第三方 notice 文件，但这不是 formal license approval。后续若 R2 引入 engine、font、sidecar 或 vendored asset，必须扩展本清单并在对应 ADR/分发物中携带原始许可和 notice。

## 待确认项目

- [ ] 维护者完成 RunLedger MIT 与现有依赖版本的 license/NOTICE formal review；
- [x] 确认 R1 未复制 `grok-build` Apache-2.0 源代码；
- [x] 确认 R1 不引入 `mermaid` npm package、`mmdc`、Chromium、外部字体或远程资源；
- [ ] R2 engine、font、sidecar、打包 notices 的独立审阅（R2 尚未实现）。

## 已审计但未引入的参考实现

| 参考路径 | 记录版本 | 许可 | 决定 |
|---|---|---|---|
| `grok-build/crates/codegen/xai-grok-markdown/src/mermaid.rs` | `c68e39f60462f28d9be5e683d9cbe2c57b1a5027` | Apache-2.0 | 仅作为行为/边界参考；M0 不复制代码 |
| `grok-build/crates/codegen/xai-grok-mermaid` | `c68e39f60462f28d9be5e683d9cbe2c57b1a5027` | Apache-2.0 | 仅 R2 架构与安全参考；不进入 R1 |
| `xai-grok-mermaid/third_party/mermaid-to-svg` | 同上 | MIT | 未采用；若 R2 采用必须随 vendored notices 一并审阅 |
| `xai-grok-mermaid/assets/Roboto` | 同上 | Apache-2.0 | R1 不使用字体；R2 若使用必须带原始许可文本 |

## 实现边界

- `src/tui/mermaid/` 中的 parser、IR、layout、canvas 与 projection 将作为 RunLedger 新实现维护；在未完成正式许可审阅前不翻译或逐行移植参考代码。
- `src/tui/opentui/` 中的 adapter 只调用 OpenTUI 已公开的 MIT 接缝，不引入 Mermaid npm package、`mmdc`、Chromium 或外部字体。
- 如果未来从 Apache-2.0 参考实现复制或翻译任何实质代码，必须先保留 copyright/SPDX 信息，并在分发物加入对应 Apache license/NOTICE；该动作不由本清单预先授权。
- M0 不新增第三方 license 文件到构建产物，因为没有新增第三方代码或资产；R2 的 engine、font、sidecar 与 notices 另行建立 ADR 和清单。
