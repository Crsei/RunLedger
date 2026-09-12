# 本地交互测试

- [Python + tmux 模式入口测试](native-mode/README.md)：保存 `/tmp/runledger-mode-native.py` 的原始版本、改进后的自动断言流程和证据边界。
- [真实开发案例试跑](development-cases/README.md)：六个开发案例的真实 Pro/high 运行、四维评分与独立核验；终态不等于验收通过。

- [Harness 执行可靠性回归](harness-repair/README.md)：构建后真实 CLI 的审批、中断、超时、恢复与模型准入检查。

这些流程需要本机构建产物和真实终端依赖，通过文档中的命令显式执行；不属于 `npm test` 自动发现的 Vitest/Bun 测试。
