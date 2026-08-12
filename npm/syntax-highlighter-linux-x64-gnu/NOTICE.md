# Codex 语法高亮依赖与内嵌资产清单

> 状态：本机 Linux x64 glibc 的实现与包链候选已通过；其余真实 runner、tag 签名/attestation、npm trusted publishing 与法务验收仍是发布停止门。
>
> 审计日期：2026-08-12

## 1. 交付边界

`native/syntax-highlighter/` 构建为 N-API 8 addon。本地开发产物位于 `dist/native/runledger-syntax-highlighter.node`；发布的 private 根包明确排除该文件，只能从当前 OS/libc/arch 对应的 `@runledger/syntax-highlighter-*` optional package 加载。loader 在 `require()` 前读取 `checksums.json` 并验证 SHA-256；缺包为 typed `native_unavailable`，摘要错误为 typed `native_integrity_error`。

本机已验证 Linux x64 glibc 的 Node 22.23.1 与 Bun 1.3.14 clean-consumer：临时目录只安装根 tarball 与 `linux-x64-gnu` tarball，根 tarball 不含本地 addon，Node/Bun 均从 optional package 加载并完成真实高亮。CI 已定义八目标显式 Rust triple、Node/Bun smoke、checksum、keyless Sigstore bundle、GitHub build provenance、聚合 gate 与 `npm publish --provenance`；但该未提交 workflow 尚未在 GitHub runner 执行，不能把另外七个 target 或 tag 签名标为 accepted。

## 2. 当前实现验收

- 32 KiB 基准：20 次 warmup、100 次样本，最新本机 p50 `16.277 ms`、p95 `19.183 ms`、max `33.524 ms`，满足 `≤50 ms` 停止门；512 KiB p95 `89.618 ms`，10,000 行 p95 `33.955 ms`，两者只作为边界观测值。
- viewport admission：真实 OpenTUI frame/layout 后按 transcript viewport 计算 `visible / overscan / offscreen`；scheduler 保证 visible → overscan → background，离屏节点不提交或取消仍在队列中的工作，滚入 viewport 后才提交。
- Process command authority：Security authorize 后生成绑定 request/constraint/command digest 的脱敏 receipt，作为首个 owner-fenced durable event 重放；overlay 只消费 `authorized / spawned / unavailable`，legacy、损坏、超长或含控制字符的显示数据 fail closed 为 `command unavailable`。
- 包链：根 `runledger` 保持 `private: true`，只由 tag gate 发布八个 optional package；每包携带 checksum、binary Sigstore bundle、npm provenance、项目 NOTICE 和从固定 two-face crate 生成的 `THIRD_PARTY_NOTICES.md`。

## 3. 直接 Rust 依赖

| 组件 | 固定版本 | 用途 | 上游 | 许可证 |
|---|---:|---|---|---|
| `napi` | 3.12.1 | N-API 8 runtime 与 async worker task | <https://github.com/napi-rs/napi-rs> | MIT |
| `napi-derive` | 3.6.3 | N-API 导出宏 | <https://github.com/napi-rs/napi-rs> | MIT |
| `napi-build` | 2.4.1 | Cargo build script | <https://github.com/napi-rs/napi-rs> | MIT |
| `syntect` | 5.3.0 | TextMate parser/highlighter/theme model | <https://github.com/trishume/syntect> | MIT |
| `two-face` | 0.5.1 | bat-curated syntax/theme bundle | <https://github.com/CosmicHorrorDev/two-face> | MIT OR Apache-2.0 |

版本 authority 是已提交的 `native/syntax-highlighter/Cargo.lock`。`two-face` 在 `Cargo.toml` 中使用精确 `=0.5.1`，避免 `0.5` semver 自动漂移到另一个内嵌资产版本。

`syntect` crate 包含 `LICENSE.txt`；`two-face` crate 包含 `LICENSE-MIT` 与 `LICENSE-APACHE`。napi-rs 三个 crate 的 registry manifest 声明 MIT，并指向同一上游仓库；最终发布包仍需随 transitive license report 一并生成完整 NOTICE。

## 4. 内嵌 grammar 与 theme

本 addon 使用：

- `two_face::syntax::extra_newlines()` 的 Oniguruma/newline 语法集合；crate 中对应源资产 `generated/syntaxes-onig-newlines.bin`；
- `two_face::theme::extra()` 的 32 个内置主题；crate 中对应 `generated/themes.bin`；
- two-face 的语法与主题由 bat 项目的生成、整理流程衍生；
- 完整上游来源与许可证目录由 two-face 0.5.1 发布页维护：<https://github.com/CosmicHorrorDev/two-face/blob/v0.5.1/generated/acknowledgements_full.md>。

two-face 同时内嵌 `generated/acknowledgements_full.bin`。package 脚本通过 `two_face::acknowledgement::listing().to_md()` 生成 `THIRD_PARTY_NOTICES.md`，包含当前固定版本要求保留的 syntax/theme attribution；本地 crate 说明列出的许可证类型包括 MIT、BSD-2-Clause、BSD-3-Clause、Apache-2.0、Unlicense、Sublime 与 WTFPL，不能只用 two-face 顶层双许可证替代 grammar/theme 自身归属。

本阶段没有把 Codex 的 Rust 源文件、测试 snapshot 或 two-face 的 binary asset 手工复制进 RunLedger。Cargo 根据固定依赖把所需资产链接进 addon；实现只依据固定参照复写了 lookup、护栏和颜色转换行为。

## 5. 发布前未闭合项

- 在真实 GitHub runner 上完成 Linux arm64 glibc、Linux x64/arm64 musl、macOS x64/arm64、Windows x64/arm64；每个 target 都需保存 checksum、Node/Bun clean-consumer 和 artifact evidence。
- 以 tag 演练生成并验证 GitHub attestation、binary Sigstore bundle，配置 npm trusted publisher 后验证八包 `npm publish --provenance`；在此之前签名/发布仅为 workflow-ready。
- 生成 Cargo 完整 direct/transitive license report，并将额外需要分发的 crate license text 纳入 artifact；将生成的 two-face acknowledgement 与上游 0.5.1 完整清单对账。
- 由人工/法务确认 NOTICE 与第三方许可证后，才可把完整 production packaging 标为 accepted。
