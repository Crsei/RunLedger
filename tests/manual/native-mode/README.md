# Python + tmux 模式入口测试

此目录将 `/tmp/runledger-mode-native.py` 的临时操作整理为可复用的本地测试。Python 负责准备隔离目录、操作 tmux、保存证据和检查 SQLite；被测程序仍是标准 PATH 中通过 Bun 加载 `dist` 的真实 RunLedger。

## 原文件与评价

2026-09-06 找到原文件，1707 字节。[original.py.txt](original.py.txt) 是逐字节归档，仅供审阅，不建议执行。原 `/tmp/runledger-mode-native-path` 指向 `/tmp/runledger-mode-native-dko5nfhx`；当时该目录还包含模式、模型、fork/resume、Plan 审批等截图。这些临时路径可能被系统清理，归档不依赖它们。

使用 Python 本身没有问题：标准库很适合编排进程、文件和 SQLite，tmux 能覆盖真实 TTY。原代码的问题是它属于操作助手，不能凭运行成功就宣称产品行为通过。

| 原实现 | 影响 | 当前处理 |
|---|---|---|
| 直接访问 `sys.argv[1]`，未知命令无明确失败 | 参数错误难定位 | argparse、范围校验、非零失败退出码 |
| 固定路径指针和 tmux 名称 | 多次运行互相覆盖、误操作其他会话 | 每次独立临时目录、独占 tmux socket；禁用用户 tmux 配置 |
| `prepare` 只建目录和 settings | 遗漏外部补入的 compatibility manifest，无法独立重放 | 显式保存并安装合成 UI fixture |
| 仅发按键、抓截图，无等待和断言 | 启动即退出、输入未响应也可能被当成通过 | 单调时钟超时、持续就绪标记、弹窗响应断言、fatal 检测 |
| 将参数拼成 shell 命令 | 带空格路径可能执行失败 | subprocess 参数列表，tmux shell 边界使用 `shlex.join` |
| SQLite 默认读写连接，只列出表名 | 路径错误会建空库，不能证明 session 落库 | URI `mode=ro`，断言至少一个 session，关闭连接 |
| 退出码由临时 launcher 写入，但脚本没有检查或清理命令 | 易把会话消失当正常退出，遗留资源 | Escape 后 Ctrl+D，检查 pane 退出码，finally 清理独占 server |
| 固定 full-access profile | UI 入口检查无需扩大权限 | 使用产品默认权限配置 |

原脚本虽然没有复制凭据，但保留真实 HOME。改进版隔离 HOME、RUNLEDGER_DIR 和工作目录，仅传入 PATH、固定语言/终端设置及占位 API key；不读取真实用户配置或凭据。

## 运行

依赖 Linux、本地 Python 3.9+、tmux，以及项目规定的 Node/Bun 和已安装的 npm 依赖。Python 无需 pip 包。先在仓库根目录执行：

```bash
npm run build
command -v runledger
readlink -f "$(command -v runledger)"
npm ls -g --depth=0
python3 tests/manual/native-mode/run.py
```

默认 PATH 必须解析到本 checkout 的 `bin/runledger.js`，否则失败。若链接缺失或指向其他 checkout，核实后按当前仓库布局执行 `npm link`。`--executable /absolute/path/to/bin/runledger.js` 可用于显式候选入口；证据只属于该入口。脚本记录 dist 入口摘要，但它不能证明整个 dist 与 src 同步，因此构建步骤不可省略。

每次运行依次执行：

1. 创建权限为 700 的临时根目录，安装独立 settings 与合成兼容性 fixture。
2. 在独立 tmux server 中启动指定模式，先设置 `remain-on-exit`，保留启动即失败的退出码。
3. 等待 `Message RunLedger` 和 `Mode: <mode>` 连续出现至少 0.3 秒。
4. 按字面发送 `/mode` 并回车，断言弹窗显示 `Select agent mode` 和正确的 `Current: <mode>`，证明输入确实得到响应。
5. 在退出前只读查询 `home/state.db`，断言存在已落库 session。
6. 分开发送 Escape、Ctrl+D，等待实际 pane 结束并检查退出码为 0；再次记录 session 列表，保存 JSON 结果并清理本次独占 tmux server。

正常退出会回收无用户消息的非 Plan session，因此退出后的空列表不表示落库失败；不能把退出前后的断言混为一谈。

三模式和窄屏示例：

```bash
python3 tests/manual/native-mode/run.py --mode default --theme dark --width 143
python3 tests/manual/native-mode/run.py --mode minimal --theme light --width 80
python3 tests/manual/native-mode/run.py --mode plan --theme light --width 80
```

`--timeout 15` 是每个等待阶段的秒数；`--height 42` 控制终端高度。`--output-parent /absolute/existing/directory` 指定证据父目录，仍会创建独立子目录。无需使用共享 `/tmp/runledger-mode-native-path`。

程序首先打印证据目录，成功退出 0、失败退出 1；参数错误退出 2。证据保留在本地，不自动提交：

- `result.json`：启动参数、实际入口、尺寸、模式、通过/失败原因、正常退出码和 session 摘要。
- `startup.txt`、`mode-picker.txt`、`exit.txt`：当前可见终端帧。
- `history.txt`：最近最多 2000 行滚动历史，帮助查出退屏前的启动错误。
- `failure.txt`：失败后的可用终端帧；初始化就失败时可能不存在。
- `home/`：隔离 settings、合成 fixture 和 SQLite；不含真实凭据。

失败时会尝试正常退出，再清理独占 server，失败清理会明确记录；超时后强制清理不算正常退出。检查完成后可删除本次打印出的临时目录。父进程被 SIGKILL 或机器断电时 finally 无法执行，可用 `result.json` 中记录的 socket 定位；不要清理默认 tmux server。

## 维护与验证

### 并发运行与结果汇总

单例脚本之间可以并发：每例有独立 HOME、RUNLEDGER_DIR、工作目录、SQLite 和 tmux socket。批量入口 [run_matrix.py](run_matrix.py) 使用有界线程池编排独立 CLI 进程，不改变产品内的 multi-agent 策略。

```bash
# 3 模式 × 2 主题 × 2 宽度，共 12 例，同时最多运行 3 例。
PYTHONDONTWRITEBYTECODE=1 python3 tests/manual/native-mode/run_matrix.py --jobs 3

# 仅同时比较三个模式，全部使用 dark / 143 列。
PYTHONDONTWRITEBYTECODE=1 python3 tests/manual/native-mode/run_matrix.py --jobs 3 --themes dark --widths 143
```

先完成构建，再启动矩阵；运行中不要重建共享 dist 或改写被测入口。`--jobs` 支持 1–16，默认 3；并发量应按本机资源调整，负载过高可能导致就绪超时。其余 `--height`、`--timeout`、`--executable`、`--output-parent` 与单例含义一致。`--jobs 1` 可用于串行复验。

每批新建 `runledger-mode-matrix-*` 目录，每例单独保存截图、SQLite、原始 `result.json` 和包含耗时的 `case.json`。批次结束写出：

- `summary.md`：按模式统计通过/失败，并逐例展示结果、耗时、CLI 退出码和证据链接。
- `summary.json`：完整的各例结果、失败原因、开始/结束相对时间、总耗时及活动用例峰值。

单例失败不会取消其他用例；只要有失败，批次就退出 1，全部通过退出 0。活动用例峰值包含准备和清理时间，不等同于同时就绪的 TUI 数量。汇总只统计本批次目录，避免混入以前的结果。若整个批次被中断，最终汇总可能缺失，仍可查看已完成用例的 `case.json` 和各例 `result.json`；中断清理边界与单例相同。

并发回归使用同步屏障证明至少两个用例同时执行，并验证并发上限、独立目录，以及单例异常后的完整失败汇总；与其他 Python 回归一并执行下列命令。

```bash
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tests/manual/native-mode -p 'test_*.py' -v
npm run check
npm test
git diff --check
```

[test_driver.py](test_driver.py) 实测启动即退出、fatal 输出、就绪超时和 SQLite 缺失路径；使用临时失败程序，不调用模型。缺少 tmux 时生命周期用例会 skip，不能将 skip 视为验证通过。Python 驱动器通过上述命令单独运行，不加入现有 Vitest/Bun 分桶，也不由 TypeScript check 验证。

[model-compatibility.fixture.json](model-compatibility.fixture.json) 来自原临时测试目录中的合成数据；其中 `status: verified` 是 UI 测试输入，不是模型验收结论。保留原 digest，不手改内容以绕过 manifest 校验。此流程只打开模式选择器，不发送自然语言请求，不执行模型工具。

## 验收边界与后续步骤

成功仅证明：指定模式可以启动、模式选择器响应、主 pane 正常退出，以及 session 存在。SQLite 查询不验证 mode/checkpoint/fork 的完整语义，屏幕文本断言不验证颜色、布局或中文 IME；可见帧 fatal 检测也不等于完整日志审计。

此轻量驱动器清理自己创建的 tmux server，未提供 detached descendants 的完整追踪保证。进程树泄漏验收应运行现有 [`scripts/run-smoke-tests.ts`](../../../scripts/run-smoke-tests.ts) 对应的 `npm run test:smoke`，该入口包含进程身份和后代检查。这里的结果不能替代该门禁。

原截图涵盖的复杂流程需要另行执行并留下对应断言：选择新模式后 session ID 改变且旧 session 可恢复；minimal 的有效工具表；fork/resume 后 mode 继承；Plan 审批与完成后 durable 状态。相关自动化入口见 [CLI mode](../../cli/agent-mode.test.ts)、[runtime mode](../../runtime/session-runtime/agent-mode-plan.test.ts) 和 [TUI Plan review](../../tui/agent-mode-plan-review.test.ts)。这些不包含在本脚本的一次成功结果中。

真实外部 provider、人工视觉/键盘/中文 IME、macOS/Windows 是独立验收，不能由本机 tmux 自动化关闭。整体策略见 [测试专题](../../../development-doc/test/README.md)。

## 2026-09-06 本机验证记录

当前共享工作树构建后，标准 PATH 确认指向本仓库 `bin/runledger.js`。default / dark / 143×42、minimal / light / 80×42、plan / light / 80×42 均通过上述流程，主 pane 退出码均为 0。default 与 minimal 的空会话正常回收，plan 会话保留为 paused。Python 故障回归 4 项通过，`npm run check`、`npm run build` 与 `npm test` 均以退出码 0 完成。全量测试日志位于 `/tmp/runledger-native-mode-test.log`，check 完整日志位于 `/tmp/runledger-native-mode-check.log`。此记录属于当时包含既有未提交修改的工作树，不代表仅此文档提交的干净 checkout。

本地证据目录分别为 `/tmp/runledger-mode-native-079komfm`、`/tmp/runledger-mode-native-xh0y0r7i`、`/tmp/runledger-mode-native-x658j420`；临时目录不是长期存储，复验请重新运行命令。

同日并发矩阵验证：`--jobs 3`，12/12 例通过，default、minimal、plan 各 4/4；覆盖 dark/light × 80/143 列，活动用例峰值 3，总耗时 17.957 秒。12 个证据目录与 tmux socket 均互不相同，CLI 均退出 0，结束后未残留本批次 tmux session。逐例与模式汇总位于 `/tmp/runledger-mode-matrix-_br4_ffg/summary.md` 和 `summary.json`。

并发入口的 Python 回归共 5 项通过，check/build 重新执行并通过；完整日志分别为 `/tmp/runledger-mode-matrix-check.log`、`/tmp/runledger-mode-matrix-build.log`。本次仅修改独立 Python 编排与文档，未重复不收集这些 Python 用例的全量 `npm test`；其上一轮结果见前述记录。
