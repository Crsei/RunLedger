# RunLedger 测试专题

本目录保存 RunLedger 的测试策略、测试基础设施实施计划与可复用测试方法。这里是测试建设的导航入口，不用历史测试数量替代当前 runner、当前工作树和当前 CI 的实时证据。

## 阅读顺序

1. [`01-test-strategy-and-runner-hardening-plan.md`](01-test-strategy-and-runner-hardening-plan.md)：当前测试体系建设的权威实施计划，覆盖测试发现、分桶、CI、PTY/CLI smoke、跨平台和验收边界。
2. [`async-state-machine.md`](async-state-machine.md)：异步状态机、虚拟时间、显式 gate、资源释放和多观察面断言的测试方法附录。
3. [`Python + tmux 模式入口测试`](../../tests/manual/native-mode/README.md)：临时 Python 脚本归档、可复用本地 TTY 流程、故障路径检查和验收边界。
4. [`真实开发案例试跑`](../../tests/manual/development-cases/README.md)：用户配置的 DeepSeek Pro/high 六类案例、四维评分与独立边界验证。

5. [Harness 执行可靠性回归](../../tests/manual/harness-repair/README.md)：本地 HTTP fixture 驱动真实 CLI/TTY，核对持久化事件和副作用。

## 文档职责

- 实施顺序、状态、门禁和停止规则只在 `01-test-strategy-and-runner-hardening-plan.md` 维护。
- `async-state-machine.md` 提供方法指导，不承担测试基础设施完成状态。
- 当前测试文件数、收集用例数、skip 数、通过数和耗时必须由当前 checkout 的 runner 或 inventory 命令重新生成。
- 自动化测试、真实 runner、标准 PATH/PTY、人工视觉验收和真实外部 provider 验收是五类不同证据，不得互相替代。
