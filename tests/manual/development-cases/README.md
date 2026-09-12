# 真实开发案例试跑（2026-09-06）

六项均已通过真实 RunLedger TUI 尝试执行并做独立核验，**没有一项达到完整无缺口验收**。本次是带审批和环境干预的端到端诊断，不是无人值守模型能力基准。

模型沿用用户配置 **DeepSeek v4 Pro / high**，模式 `default`。练习、Session 数据和工具验证均在隔离目录；没有提交、推送或修复 RunLedger 产品代码，也没有替模型修改生成物。机器可读的评分依据、指标及原始命令输出位置见 [results-2026-09-06.json](results-2026-09-06.json)。原始要求见 [prompts.json](prompts.json)。

## 结果与评分

四维按“结果正确 / 遵守约束 / 验证可信 / 交互稳定”各 0–2 分，人工评分表示本次端到端表现。2 为相应要求得到充分证据，1 为部分满足或存在缺口，0 为未完成或严重阻塞；不把环境和驱动器问题归咎于模型本身。

| 案例 | 四维评分 | 总分 | 实际结果 |
|---|---|---:|---|
| 1 JSONL | 1 / 1 / 2 / 0 | 4/8 | 常规统计等独立检查通过；stdin 报错、文件全量读取；15 分钟等待上限内未结束 |
| 2 任务 CLI 两轮 | 1 / 2 / 2 / 0 | 5/8 | 增量修改和旧数据兼容通过；空 tag 会写出自身无法读取的数据；中途需重启恢复 |
| 3 重命名 | 1 / 2 / 2 / 1 | 6/8 | 预览、冲突整批保护等通过；扩展名内空格未替换；以 length 结束 |
| 4 只读追踪 | 1 / 2 / 2 / 2 | 7/8 | 主要链路和静态证据可信；实际 HTTP 请求落点追踪不完整 |
| 5 Markdown | 1 / 2 / 2 / 1 | 6/8 | 15 项自带测试通过；一种围栏结束边界会误报块内链接 |
| 6 中断恢复 CSV | 1 / 1 / 1 / 0 | 3/8 | 正常中断失败；强制退出后的同 Session 恢复可用；自带测试 23 过、1 失败，恢复轮以 length 结束 |

| 案例 | 所选执行阶段累计墙钟 | Runtime active 时间 | 完成工具调用 / 失败 | 其中 foreground process rejected |
|---|---:|---:|---:|---:|
| 1 | 919.0 s | ≥225.6 s，缺终态 | 39 / 17 | 17 |
| 2 | 1161.7 s | 329.3 s | 53 / 18 | 16 |
| 3 | 309.5 s | 155.6 s | 17 / 6 | 4 |
| 4 | 322.8 s | 318.0 s | 50 / 2 | 2 |
| 5 | 798.1 s | 366.7 s | 31 / 11 | 9 |
| 6 | 940.2 s | 详见逐 run 指标；首轮缺终态 | 38 / 16 | 16 |

墙钟包含审批等待、环境诊断、退出清理；案例 2、6 为首轮与恢复轮之和，不包含两阶段之间停顿。`activeDurationMs` 来自 Runtime 事件；缺 `agent_end` 时只保留最近观测下界。失败次数按 `tool_execution_end.isError=true` 计数，与断言失败数量不同。早期错误配置/被替代的试跑不混入上表。案例 2 首轮、3、6 恢复轮的 `length` 具体原因均为 `terminationReason=repeated_tool_failure`，不是模型输出 token 上限；无 model 字段的终止摘要是 Runtime 合成消息。

## 独立核验发现

### 1. JSONL

- 手工构造六条记录和第 7 行坏 JSON，验证 level/service 数量、中文字段、过滤、并列 Top 5、空文件及缺失文件报错。
- 核心 6 项检查通过。声明支持的 stdin 模式失败：`Bun.stdin` 上调用不存在的 `getReader()`。
- `cli.ts` 用 `Bun.file(file).text()` 读取全文再 split，所有记录也保留后排序，不是流式逐行读取。
- 模型因多次工具拒绝反复诊断，900 秒内未发出 `agent_end`，随后由驱动器清理，不能记为完整开发结束。

### 2. 两轮任务管理

- 第二轮保留 `src/taskStore.ts` / `src/cli.ts` / `tests/taskStore.test.ts` 结构，增加 tags 和 JSON 输出。
- 17 项模型自带测试实际通过。独立用第一轮快照 CLI 生成无 tags 的旧文件，再用第二轮 CLI 读取、添加、筛选、完成任务；ID 不复用、中文/空格、读取不改旧文件、损坏文件字节不变等 18 项检查通过。
- 新边界复现：`add new --tag ""` 返回成功，把空字符串写入 tags；随后 `list --json` 报 `tasks[1].tags[0] 必须是非空字符串`。即正常数据被该输入变成自身不能读取的状态。模型最终所称“空 --tag 明确报错”不完整。
- 第一轮以 `length` 结束，驱动器未自动进入第二轮。保存快照后用同 Session 重启，经 `/recovery assess` 再补发第二轮，最终 `stop`、CLI exit 0。原始首轮报告里的 `cli_exit: 0` 是旧驱动器提前填入的占位，**不作为首轮退出证据**；驱动器已改为不提前填写。

### 3. 批量重命名

- 5 项自带测试通过；独立验证默认预览无变更、中文名称、内容保留、跳过符号链接和子目录，以及冲突时整批字节不变。
- `中文 A.T XT` 实际变成 `中文_A.t xt`，而要求对应结果应为 `中文_A.t_xt`：实现只替换 stem 的空格。
- 最后终态是 `length`，没有完整最终交付说明。

### 4. RunLedger 只读追踪

- 原始回答见 [/tmp/runledger-dev-suite-r8e_3wjt/04-trace/final-answer.md](/tmp/runledger-dev-suite-r8e_3wjt/04-trace/final-answer.md)。46 处引用的文件和行号范围均存在；逐条审阅 bash 命令及工具类型，没有写入操作。
- TUI → command → TCP → SessionRuntime → Agent，以及工具事件落库/订阅回传/TUI timeline 的主要关系得到源码支持。回答明确标为静态分析，没有把阅读当作运行通过。
- 它把 `src/api/anthropic-messages.ts:317` 的 `streamSimple` 包装入口称作实际 HTTP 落点；真正 `client.messages.create(...)` 在第 111 行。也没有继续追踪此次 DeepSeek 的具体请求边界。

### 5. Markdown 链接检查

- Runtime 内最终 15 项 unittest 通过；独立复跑也通过。普通相对链接、fragment、外链/邮件/锚点忽略、中文目标和常见围栏均通过边界核验。
- 对下列文件应忽略代码块内链接，但程序输出失效链接并返回 1：

````text
```
``` not-a-close
[x](absent.txt)
```
````

- 已有 README 诚实列出引用式链接、嵌套括号、URL 编码等未支持语法；上述结束围栏缺陷不在已声明范围内。

### 6. 中断恢复 CSV

- 首个 `csv.ts` 出现后发送 Ctrl+C，60 秒内没有 `aborted`，模型继续创建其他文件。之后从审批界面取消也没有形成正常终态。驱动器按失败清理，不能算正常中断成功。
- `--continue` 后 Session ID 相同，重启前后源码及 Bun 辅助文件哈希相同。首次继续提示被 `RECOVERY_REQUIRED` 拒绝；`/recovery assess` 显示 `state=ready unresolved=0` 后重新发送继续要求。模型确实先核对原有文件并继续工作。
- 五项独立功能检查通过：引号内逗号/换行/转义引号、空分组、空值/非法数值、stdin、未知列和仅表头输入。
- 模型自带 `test.ts` 独立实际运行结果为 **23 passed, 1 failed**。失败是测试期望错：west 数据只有一个有效数值 7.5，count 应为 1，测试写成 2。没有替模型修正测试。
- 恢复轮最后是 `length`、CLI exit 0；没有完成最终说明，也没有把未完成测试说成通过。正常中断、恢复后完整收尾仍未通过。

## 模型、运行环境与干预边界

用户 settings 配置为 `deepseek/deepseek-v4-pro`、`high`，但原 compatibility manifest 只准入 Flash。直接复制原设置/manifest 的预检曾在 TUI 观察到 Flash，因此在发送提示前停止，没有用 Flash 代替 Pro。

随后使用同一用户认证进行真实 Pro/high 工具调用和结果回传小样本验证；返回模型均为 `deepseek-v4-pro`，验证证据在 [/tmp/runledger-user-model-probe-_n08der8/verification.json](/tmp/runledger-user-model-probe-_n08der8/verification.json)。仅在隔离测试 home 中生成与该证据 digest 绑定的准入 profile。此小样本不证明目录所标称的最大上下文/输出容量；用户原配置与 manifest 未改动。

测试只继承用户模型、thinking 和对应认证，不声称复制全部用户环境。凭据只在子进程内存使用，未复制真实 auth.json；对测试产物扫描没有发现该凭据值。

实际入口为 `/home/nzq/.npm-global/bin/runledger` → 本仓库 `bin/runledger.js` → **既有 2026-09-05 构建的 dist**，入口 SHA256 为 `10f270636822cde18dcb7f7099bb2b73864bd9f42674a51068a34b390e749fa7`。本次未重建产品；案例 4 则读取当前有并发改动的源码。因而 CLI 观察不能直接当作当前未构建源码的回归结论。

写入案例使用 `workspace-write / on-request`，只读案例使用 `read-only / never`。通过真实审批界面审阅并批准样例/测试操作，未关闭 ExecutionGateway 或修改权限/隔离实现。早期 `never` 写入试跑和不可见宿主 Bun 路径造成阻塞；修正后的 TypeScript 练习目录预置同一 Bun 二进制于 `.runtime/bun`。部分 `y` 审批输入落入草稿，后改用 Enter；原始中断及输入不稳定记录保留。

这不是人工视觉/IME、跨平台或无人值守验收，也不是对当前源码完成了故障根因修复。运行过程中出现的 `foreground process rejected` 和审批过期按观测记录，没有仅凭提示文案推断根因。

## 证据目录与复用

| 案例 | 证据根目录 |
|---|---|
| 1 | `/tmp/runledger-dev-suite-ne64z210/01-jsonl` |
| 2 | `/tmp/runledger-dev-suite-bj9xvv95/02-tasks` |
| 3、4、5 | `/tmp/runledger-dev-suite-r8e_3wjt/<case>` |
| 6 | `/tmp/runledger-dev-suite-ne64z210/06-csv` |

每项保留 `workspace`、`home/state.db`、TTY 帧、原始提示、`all-events.json`、运行报告和 `independent-acceptance.json`；有正常终态的轮次另有 `*-events.json`。案例 2 保存 `round-1-workspace`；案例 6 保存 `before-interrupt.txt`、`forced-exit-workspace`、恢复前后哈希和 recovery 操作帧。临时样例由独立验收脚本清理，命令、退出码与输出保存在报告中。

此前错误网关试跑 `/tmp/runledger-dev-01-jsonl-fbyo_8wm` 的 403 只对应错误选择的网关；不能据此判断用户 DeepSeek 额度。Flash 预检、`/tmp/runledger-dev-suite-ykzgy6kt` 及被替代的 bj9xvv95 JSONL/CSV 运行也保留，但不计入当前评分。

工具入口：

- [verify_model.py](verify_model.py)：真实用户模型协议小样本验证，会发生付费请求。
- [run_suite.py](run_suite.py) / [driver.py](driver.py)：真实 TUI 分轮编排，审批需要操作者按请求审阅；终态成功不等于功能验收通过。
- [resume_failed.py](resume_failed.py)：失败后的同 Session 恢复诊断；需要时使用 `/recovery assess`，不自动接受未决副作用。
- [acceptance.py](acceptance.py)：独立运行生成物和边界样例，失败返回非零；不修改模型代码。

```bash
PYTHONDONTWRITEBYTECODE=1 python3 tests/manual/development-cases/verify_model.py
# 使用上一步输出的 verification.json 绝对路径：
PYTHONDONTWRITEBYTECODE=1 python3 tests/manual/development-cases/run_suite.py --verification /tmp/实际目录/verification.json --cases 01-jsonl 02-tasks 06-csv
PYTHONDONTWRITEBYTECODE=1 python3 tests/manual/development-cases/acceptance.py tasks /tmp/runledger-dev-suite-bj9xvv95/02-tasks
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tests/manual/development-cases -p 'test_*.py' -v
```

仓库侧验证：Python 驱动器 3 项回归通过；`npm run check` 通过（exit 0），完整输出保留在 `/tmp/runledger-development-cases-final-check.log`。本次只增加测试驱动/证据文档，不修改产品代码，未运行全量 `npm test` 或重新 build。Python 脚本语法、文档链接、源码验收哈希和 `git diff --check` 也已核对。
