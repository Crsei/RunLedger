# RunLedger 当前项目运行与结构审计

> 日期：2026-09-05（Asia/Shanghai）
> 分支：`rollback/before-composer-shape`
> HEAD：`74d39a1`；§2–5 为审计开始时的暂存/未暂存工作树快照，§9 为本次未提交修复后的结果。
> 路线结论：**调整当前方案**。保留 Session Owner、SQLite authority、ExecutionGateway 与投影视图；先修退出和验证缺陷，再收敛模块边界。
> 初轮审计未改业务代码；用户随后授权修复与 subagents 并行处理，并追加清理过度防御。修复与复验快照见 §9；后续授权的本地提交范围见 §10，未推送。

## 1. 范围与证据边界

检查了 `package.json`、TypeScript/测试配置、CI、README/AGENTS、当前架构文档、Runtime 06、模块化 Plan 12/13，以及 CLI → embedded Session Runtime → domain 的生产组合。针对退出、MCP/LSP 诊断、TUI imports 和类型检查继续追踪调用关系。

开始时已有 13 个暂存的代码/测试文件，以及 AGENTS、README、索引、架构说明等其他修改；包括模型可选性和失败消息回放相关改动。这些内容保留原状，不将本次结果归因为纯 HEAD 或远端状态。初始清单保存在 `tmp/project-audit-2026-09-05/baseline.json`。

运行环境：Linux、Node `22.23.1`、Bun `1.3.14`、npm `10.9.8`、tmux `2.6`。全局 `/home/nzq/.npm-global/bin/runledger` 已解析到本仓库 `bin/runledger.js`；重新构建后执行。该 shim 由 Node 启动，再运行 **Bun + dist/cli/cli.js**。

所有应用运行使用预创建的隔离 `RUNLEDGER_DIR`/home；应用探针只访问 loopback，不读取真实用户凭据或目录。未调用暂停中的 Boost MCP，未修改 sandbox。测试中提到的本地 MCP fixture 与暂停的 Codex MCP 服务无关。

## 2. 初轮审计运行结果（修复前快照）

| 项目 | 结果 | 说明 |
|---|---|---|
| `npm run check` | PASS，exit 0 | 完整输出已保存并审阅；包含静态边界、src typecheck、Rust 12 tests、Bash AST assets/pack 检查 |
| `npm run build` | PASS，exit 0 | 重建 Linux helper、Rust native、TypeScript、TUI assets、build manifest |
| `npm run test:inventory` | PASS，exit 0 | 497 owned files、0 diagnostics；默认 local 含 476 个 Vitest 文件和 19 个 Bun 文件；额外 Rust/smoke 各 1 个入口 |
| `npm test` | PASS，外层 exit 0 | Vitest：475 files / 2,940 tests passed，1 file / 3 tests skipped；Bun：19 files / 138 tests passed、1,052 assertions、0 fail |
| `npm run test:smoke` | 命令 PASS，exit 0 | 1 个 runner 测试及 built CLI smoke；其 TTY 成功判据存在 F02，不能独立证明正常退出 |
| 全局 `runledger`，143×42 TTY | PASS，直接观察 | Welcome 与输入区可见；无凭据 `/model` 提示先配置；`/new minimal` 显示 `Harness: minimal@1` |
| 全局 `runledger --harness-profile minimal`，80×24 TTY | 启动和退出通过 | 单独启动窄终端；不把字符帧等同于真人视觉验收 |
| 两次 TUI `Ctrl+D` | PASS，直接观察 exit 0 | 开启 tmux `remain-on-exit`，读取 `pane_dead=1`、`pane_dead_status=0`，未以“pane 消失”代替退出码 |
| 真实 `auth-gateway serve` + SIGTERM | **FAIL，F01** | 启动器退出后 `/healthz` 仍返回 200 |
| smoke runner 负向 fixture | **FAIL，F02** | 无 TUI、输出 fatal、交互后 exit 1，runner 却返回成功 |
| `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.scripts.json` | **FAIL，exit 2，F04** | 171 个文件、754 条 TS diagnostics：tests 717、scripts 25、examples 12；不是 754 个生产运行 Bug |
| 文档链接/工作树边界 | PASS | 新增文档本地链接有效，`git diff --check` / `git diff --cached --check` 通过；暂存 tree 与初始快照一致，src/tests/bin/scripts 无新增未暂存改动 |

直接运行还确认：`/settings` 不在当前 slash 注册表，输入后显示 Unknown command；这属于不存在的命令，不作为缺陷。无凭据时不允许发送模型请求，也不作为缺陷。

80 列验证采用新建终端，因为本机 tmux 2.6 不支持本次尝试的 `resize-window`；被拒绝的 resize 不计作 TUI 自适应失败。首次 gateway HTTP 探针受 Python 继承代理影响而超时，该结果无效；F01 使用显式禁用代理的直接 loopback 探针重新确认。

## 3. 方案判断

项目目标是可归因、可重放的 Agent 执行：Session Store 持有 durable authority，Session Owner 管理唯一 writer/generation，Runtime 负责执行和恢复，TUI 通过 command/query/subscription 交互。当前 `src/cli/main.ts`、`src/cli/embedded-session-runtime.ts` 与 `src/runtime/session-runtime/domain.ts` 支持这一路径；原 resident Host 不是标准 CLI 的备用生产入口。

这一主线值得保留。现有问题不要求替换 SQLite 或回退为 TUI 直接驱动 Agent。当前更需要补齐**进程生命周期、可信运行证据、可执行的依赖边界**。

| 处理路线 | 收益 | 成本与风险 | 判断 |
|---|---|---|---|
| 原结构继续叠加功能 | 短期修改少 | 退出/验证缺陷持续存在，边界继续依赖人工约束 | 不建议 |
| 原仓内修复缺陷、先打断反向依赖，再按 Plan 13 分阶段拆包 | 保留既有 authority 和生产组合，迁移可逐步验证 | 需维护兼容出口与 import gates | 推荐 |
| 重写 Runtime、换存储、按一级目录机械拆成多个包 | 表面上模块增多 | 无法自动消除循环，扩大恢复/协议/权限变更面 | 当前无证据支持 |

关键假设：当前产品仍需要 session-scoped ownership 和可审计副作用；标准 CLI 应保持单一路径；权限与隔离策略由原有专项决定。本次不新增安全模式，也不把一般进程生命周期修复归类为 sandbox 开发。

## 4. 初轮确认的问题（原始复现证据）

### F01 — 高：启动器收到 SIGTERM 后，真实网关子进程仍存活

- **置信度：高；已在当前构建的全局 CLI 上复现。**
- 证据：[`bin/runledger.js`](../../bin/runledger.js) 第 27–28 行使用同步 `spawnSync("bun", …)` 等待子进程，没有 launcher → child 的 signal forwarding。[`src/cli/auth-gateway-cli.ts`](../../src/cli/auth-gateway-cli.ts) 第 246–251 行的退出监听运行在 Bun 子进程内。
- 触发：在隔离 home 启动 `runledger auth-gateway serve --bind 127.0.0.1:0 --no-auth`，等待 ready，对外层 Node 启动器 PID 发送 SIGTERM。
- **直接结果**：信号前 `/healthz` 为 `200 {"ok":true}`；启动器退出状态为 `-15`；信号后 `/healthz` 仍为 `200 {"ok":true}`。再向 Bun 子进程发送 SIGTERM，连接关闭。独立的 byte-identical launcher + 最小 Bun child fixture 也复现 child 残留。
- 后果：按启动 PID 管理服务时可能误以为已停止，监听端口和在途工作继续存在；本次未据此推断所有 Session 崩溃恢复路径都会失败。向整个进程组发信号是不同场景。
- 根因：CLI launcher 没有承担完整的子进程生命周期。
- 覆盖缺口：`tests/auth-gateway/e2e.test.ts:48` 通过 `node --import tsx src/cli/cli.ts` 直接启动应用，并对该进程发送 SIGINT；它绕过了 `bin/runledger.js`，因此该 E2E 通过与 F01 复现可以同时成立。
- 修复方向：选择可转发信号并等待子进程结束的 launcher 方案；保留 stdio/TTY 与退出状态语义，避免引入多层重复 cleanup。补真实 launcher PID 终止测试，同时验证进程组终止和 TUI Ctrl+D。
- 本地证据：`tmp/project-audit-2026-09-05/gateway-signal-direct.json`、`launcher-signal.json`。探针使用随机 loopback 端口，子进程与临时 home 已清理。

### F02 — 高：TTY smoke 会把报错退出标成正常启动、干净退出

- **置信度：高；负向 fixture 已复现。**
- 证据：[`scripts/run-smoke-tests.ts`](../../scripts/run-smoke-tests.ts) 第 182–195 行只要求 capture-pane 非空、之后 tmux session 消失，便输出 `startup: observed` 和 `cleanExit: observed`。未验证应用语义或退出码。
- 触发 fixture：`--help`/`--version` exit 0；正常启动只输出 `[runledger] fatal: fixture startup failed`，等待按键后 exit 1；不实现任何 TUI。给 fixture 提供 runner 要求的候选文件和 manifest 后，调用 `scripts/run-smoke-tests.ts --repo-root <fixture> --with-pty`。
- **直接结果**：runner exit 0，两个 TTY 字段均为 `observed`。
- 后果：CI 可在启动崩溃时变绿；现有 smoke PASS 不能代替产品启动和退出验收。
- 根因：观察条件只验证终端有字和进程消失，没有验证成功语义。manifest 结构/digest 存在本身也不证明实际应用健康。
- 修复方向：断言稳定的 ready/UI 标识，捕获真正的进程退出码，明确 fatal/启动前退出/exit 1 必须失败；检查所启动子进程和监听资源已清理。使用负向 fixture 锁定这一行为，避免测试只重复成功字段。
- 本地证据：`tmp/project-audit-2026-09-05/smoke-false-positive.json` 和 `smoke-false-positive-fixture/`。

### F03 — 中：MCP/LSP 丢弃外部进程 stderr，削弱可审计诊断

- **置信度：高；生产代码直接确认。未宣称本次真实外部 MCP/LSP 启动失败。**
- 证据：[`src/extensions/mcp/sdk-factory.ts`](../../src/extensions/mcp/sdk-factory.ts) 第 117 行与 [`src/runtime/session-runtime/lsp-composition.ts`](../../src/runtime/session-runtime/lsp-composition.ts) 第 33 行在启动命令尾追加 `2>/dev/null`；后者第 115 行 `peekStderr()` 固定返回空字符串。
- 触发：可执行文件不存在、配置不合法、依赖加载失败等原因只写 stderr，随后握手失败或超时。
- 后果：诊断正文在进入存储前已经丢失，无法由 Trace 或后续审计恢复。当前做法还将 transport 与 POSIX shell 语法绑定；跨平台失败未在本次复现。
- 根因：process output 接口没有在协议 stdout 与诊断 stderr 之间提供完整的分流消费路径。
- 修复方向：在现有 managed process 路径内分流 stdout/stderr，stdout 只供协议 parser；stderr 经限量、清洗后进入私有诊断或 Artifact，返回可定位的错误。不要简单删除重定向后把 stderr 混回协议流。

### F04 — 中：默认 typecheck 与测试/示例的类型事实脱节

- **置信度：高；补充命令 exit 2。**
- 证据：[`tsconfig.json`](../../tsconfig.json) 第 7–13 行排除 tests/examples/scripts；[`package.json`](../../package.json) 的 `check` 只追加此配置和 contract-consumer 配置。现有 [`tsconfig.scripts.json`](../../tsconfig.scripts.json) 未被 npm check/CI 调用，直接运行得到 754 条 diagnostics。
- 示例：`examples/m3-demo.ts:55` 访问无类型保证的 `taskId`；`examples/tui-demo.ts:49` 构造的 Model 缺少当前必需字段；`scripts/model-generation/compat-metadata.ts:292` 不满足当前 compatibility 类型。测试中也有 fixture 类型和 Bun 类型环境问题。
- 后果：Vitest/Bun 转译运行成功与“测试代码符合当前接口”可能长期分离；generator/示例的接口变化不受默认检查约束。
- 根因：验证配置未覆盖实际维护的全部 TS 消费者，且不同 runner 的类型环境混在一个闲置配置中。文件名叫 scripts，但 include 并不显式包含 `scripts/**/*.ts`；当前检出的 scripts 来自间接 import。
- 修复方向：先分别建立 Node tests、Bun tests、scripts/examples 的类型环境和清单，再修过期 fixture/接口；处理有意构造的非法输入时限定测试边界。分阶段接入门禁，禁止用全局 `any` 或 blanket ignore 消除诊断。
- 本地证据：`check-extra.log`、`check-extra-summary.json`。这不否定 src typecheck 的 PASS，也不能把全部 diagnostics 当作独立功能缺陷。

## 5. 结构与文档问题（原始审计）

### S01 — 中：TUI 内部循环与 Storage 反向依赖 UI

**置信度：高；AST 静态 import/export 图确认，尚未复现初始化崩溃。** 排除 `import type` 后，文件级存在两个非平凡强连通组：

1. `src/tui/primitives.ts:19` ↔ `src/tui/editor-height.ts:18`：Editor primitive 消费高度算法，高度算法反过来消费 primitive 文件中的宽度/折行工具。
2. `src/tui/index.ts` 与 selector/modal 组件组：例如 barrel 第 293 行导出 `SelectorModal`，该组件第 16 行再从 barrel 导入 `Box/SelectList`；MCP/extension modal 也采用类似路径。完整组含 7 个文件。

另外，`src/storage/tui-preferences.ts:8,19` value-import/re-export `src/tui/preferences/types.ts`，下层 storage 依赖产品 UI 目录；`src/auth/oauth/kimi-code.ts:9` 又依赖产品 storage paths。按顶级目录聚合的 value-import 图含跨 11 个领域的强连通组，**目录级循环不等于 11 个文件互相初始化**。

后果：低层 API 无法独立演进，内部组件通过 barrel 扩大加载范围；拆包会遇到循环与私有入口穿透。根因是文本纯函数、偏好 contract 与公开 barrel 的职责边界混合。

处理：先把宽度/折行纯函数与偏好 contract 放入合适的低层模块；组件从定义模块直接 import，barrel 只提供对外出口。用 AST 检查锁定内部反向 import 与 value cycles，勿通过机械搬目录消除表面路径。归入工作区已有的 `development-doc/plan/13-package-boundary-workspace-refactor-plan.md`（Plan 13 草稿，未随本次提交），不另建竞争拆包计划。

### S02 — 中：组合和包职责仍集中，构建边界不能独立验证

**置信度：高；结构风险，不是单凭行数判定 Bug。** 当前根 `package.json` 同时拥有 SDK/Provider exports、CLI、OpenTUI、PTY、Rust native 与全仓 build。`npm run build` 无论消费什么接口都经过 Linux helper 和 syntax highlighter 构建链；wildcard exports 还公开整个 storage/utils 等路径。

本次排除 `*.generated.ts`、`*.models.ts` 后，手写 src 为 **826 文件 / 133,833 行**。生产组合热点包括：

| 文件 | 行数 | 仍混合的责任 |
|---|---:|---|
| `src/tui/interactive-mode.ts` | 1,424 | workflow 构造、UI 资源、输入/事件、overlay、主题与退出订阅 |
| `src/runtime/session-server/runtime-server.ts` | 804 | 连接协议、driver、subscription、reverse request 生命周期 |
| `src/cli/main.ts` | 692 | 命令、home/store、workspace/model 组合、Session view 生命周期 |
| `src/runtime/session-runtime/extension-composition.ts` | 673 | extension discovery、配置、资源域、工具与启动/关闭组合 |

旧 `runtime-host-service.ts` 仍有 1,285 行、`runtime-host-model-context.ts` 1,119 行，但它们不在标准入口，不应抢占当前生产路径的修复优先级。

后果：小范围改动也容易牵动多个领域和 native 构建；入口层难以作为薄 facade 验证。根因是 composition ownership、public API 与 package lifecycle 尚未分离。

处理：沿 [Plan 12](../plan/12-bloated-code-modularization-refactor-plan.md) 与 Plan 13，先缩窄 API、稳定协作者和行为测试，再建立真正单向的包依赖。legacy Host 的隔离保留是 Runtime 06 的安全窗口；**R8 未接受前不能删除，也不为降行数重写它**。

### D01 — 低：标为“当前”的文档事实存在冲突

**置信度：高。** `AGENTS.md:128` 写 R0–R5 implemented、R6 partial/blocked；Runtime 06 当前首行写 R0–R6 implemented。开发索引的 Session Owner / Runtime Host 两行仍引导读者将 Runtime 05/Host 视为 current baseline，生产 main 和新架构文档却已经明确为 Session Owner。AGENTS 第 113 行的“当前 401 tests”也已经不适用于本工作树。

后果：后续开发可能误判缺口，甚至回到旧 Host 扩展；历史数字会被错误用于当前验收。根因是多个入口同时声称维护当前状态。

处理：保留历史证据及日期，删除它们对“当前”的重复权威声明；AGENTS 保留开发约束，现状路由指向架构/专题唯一入口。当前的未提交文档工作应协调后再修，不能覆盖。R6 implemented 与 R6.5/R8 accepted 是不同结论，不得顺手提升验收状态。

## 6. 修复清单

下表保留初轮修复范围并更新实施状态；统一复验见 §9.5。人工、真实外部服务和其他平台的验收仍单独保留，不能用本机自动化代替。

| 完成 | 顺序 / 编号 | 修复边界 | 验收条件 |
|---|---|---|---|
| [x] Linux | 1 / F01 | launcher signal/lifetime；独立小改动 | Linux built/global CLI 的 launcher PID SIGTERM、进程组信号与 TUI Ctrl+D 回归；Windows 验收归入下方平台缺口 |
| [x] | 2 / F02 | smoke runner 及其负向 fixture | fatal-only、exit 1、启动前退出、残留 child 均 fail；真实 TUI ready + exit 0 才 pass；证据包含退出状态 |
| [x] | 3 / F03 | managed process 诊断消费 + MCP/LSP transport | 协议 stdout 不受污染；stderr 缺失 executable/错误配置可检索，有限量和清洗；在原 Gateway/attempt/fence 内执行 |
| [x] | 4 / F04 | typecheck 配置和过期 consumers | Node/Bun 分别有正确 types；scripts/examples 显式归属；新接口漂移会阻止门禁；本次诊断按类别修正，567 consumers / 0 diagnostics |
| [x] | 5 / S01 | 先拆纯函数/contract，再约束 imports | 两组 TUI value cycles 消失；storage 不再依赖 tui 目录；新增反向 import 能被 check 阻止；对应显示/偏好行为不变 |
| 部分 | 6 / S02 | 复用 Plan 12/13 | 完成单包边界、contracts 独立构建与 export；物理拆包和其余 composition 拆分留在 Plan 13；legacy 删除仍受 Runtime 06 R8/R9 门禁限制 |
| [x] | 7 / D01 | AGENTS/索引/专题状态路由 | 历史计数注明日期；Session Owner 为当前生产入口；R6 实现与 R6.5/R8 验收状态不混写 |
| [ ] | 8 / 验收缺口 | 真实外部与人工/平台验收 | provider 凭据模型回合、外部 MCP/LSP、fault/migration 联合演练、macOS/Windows、dark/light 与真实中文 IME 各自留独立证据 |

每个代码修复按“复现失败 → 修复 → 对应测试 → `npm run check` / `npm test` / `npm run build` → 当前链接 CLI 复验”执行。先处理前三项；类型门禁与结构迁移应分批，不与退出修复捆绑。提交与推送仍需用户明确要求。

## 7. 尚未确认、可暂时接受与停止边界

- 本次不使用真实外部 provider 凭据发起模型请求，也未执行可能读取 `asset/api-key.json` 的 `npm run demo`。keyless/local fixture 的测试结果与真实模型 E2E 分开。
- 无 macOS/Windows runner、真实中文 IME、dark/light 人工视觉证据。143/80 字符帧只证明本机渲染和已观察交互。
- 初轮未运行 npm audit；修复轮已运行，结果见 §9。未跑全量性能/内存基准，不给出吞吐或长时间稳定性结论。
- 本轮是定向深入加全仓自动化检查，未逐行审阅 13 万行源码。现有 staging 中的修复没有被当成新的未修复问题重复登记。
- Runtime 06 的 R6.5/R8 仍不被本次结果自动接受，R9 不启动。现有 legacy 保留、平台缺少验收属于明确受控边界。
- 值得进行下一轮审查，但应在 F01–F03 修复后围绕真实退出、故障诊断与负向验收进行；继续无目标扫描的收益已经低于修复已复现问题。

## 8. 本地证据位置

原始日志与 fixture 位于仓库忽略目录 `tmp/project-audit-2026-09-05/`，仅供当前机器复查，**不保证随 Git 保存或长期留存**。本文件中的复现条件、观察结果和修复验收条件是持久记录。

- `check.log` / `build.log` / `test.log` / `smoke.log` 与各自 `.exit`。
- `test-summary.json`：完整 local run 的计数、外层退出码及日志 SHA-256；本次 `test.log` digest 为 `e384a30923b05769d0dd01abebff8f58c2e409f0b7a38cdcce4bf698c1f636ea`。
- `check-extra.log`、`check-extra-summary.json`：补充类型检查。
- `gateway-signal-direct.json`：真实网关 signal 复现；`gateway-signal.json` 是受代理影响的无效首轮，勿引用为应用故障。
- `launcher-signal.json`、`smoke-false-positive.json` 及对应 fixture 目录。
- `tty-startup-143.txt`、`tty-model-143.txt`、`tty-new-input.txt`、`tty-new-result.txt`、`tty-minimal-80.txt`、`tty-exit*.txt`、`tty-summary.json`。
- `structure.json`、`import-graph.json`：当前规模和 AST value-import 图；未将 type-only imports 计入循环。

## 9. 授权修复、过度防御清理与再次检测

### 9.1 范围与执行方式

在同一工作树使用三个 subagents 分区修复 launcher/smoke、stderr/managed process、consumer types/EffectRunner；主代理处理 TUI/结构边界、文档、依赖和统一验证。原始 13 个暂存文件的 index 保留；修复前快照为 `tmp/audit-repair-2026-09-05/initial.json` 与两份 patch。未提交或推送，未修改 sandbox 实现或迁移真实用户目录。

### 9.2 修复结果

| 编号 | 本轮处理 | 状态与边界 |
|---|---|---|
| F01 | Node launcher 使用异步 child，转发 SIGINT/SIGTERM/SIGHUP，等待 child 结束后保留退出码/信号 | Linux launcher 与真实 gateway 回归；其他平台仍需 runner |
| F02 | ready UI、真实 pane exit code、已观察进程身份/组残留检查；fatal、非零退出、提前退出、残留 child 均为负向 fixture | 可复验 smoke；不宣称采样能捕获所有双 fork 脱离进程 |
| F03 | managed output 记录 stdout/stderr 来源，protocol 只读 stdout；诊断保留有界清洗尾部；移除 `2>/dev/null` | 默认 combined 不变；旧无来源 output 不被猜作协议 stdout；raw 私有 output 仍按原存储策略保存 |
| F04 | Node tests、Bun tests、scripts、examples 四份类型环境；覆盖清单进入默认 `check`；修正过期 fixture、合法注入类型与生成器/示例接口 | 不关闭 strict，不 blanket ignore，不排除失败文件；非法输入断言仅留在相应负向边界 |
| S01 | 文本纯函数、偏好 contracts 抽离；内部组件直接依赖定义模块；Kimi OAuth 只消费设备 ID callback，持久化由 canonical layout 组合注入 | 两组 TUI value cycle、storage → tui、auth → storage 已由静态 gate 阻止回归 |
| S02 | contracts 独立 build/export；TypeScript 与 native 构建命令分开；EffectRunner 明确组装端口参数 | 单包阶段已落地；Plan 13 物理拆包、wildcard export 收缩及其余 composition 拆分仍按原分阶段计划执行，未冒充全量迁移完成 |
| D01 | AGENTS/索引将旧规模和实现写为历史快照；Session Owner 为标准入口，Runtime 05 为 legacy 安全窗口 | R6 implemented 与 R6.5/R8 acceptance 分开；R9 未启动 |

类型门禁额外暴露并修正了 Session Owner heartbeat / managed process timeout 被默认常量误推断为 literal、LSP action schema 静态类型推断为 `never`、手动 FrameClock 与宿主 timer 句柄不一致等契约问题；不将每条 TS diagnostic 算成一个运行缺陷。

### 9.3 再次检测发现的实际问题

- **F05：依赖审计。** 修复前 npm audit 报告 8 个受影响包（含 Vitest 开发服务漏洞与 fast-uri 等传递依赖）；升级 Vitest 到 `3.2.6` 并更新受影响传递依赖，增加与本机匹配的 `@types/bun@1.3.14`。最终 `npm audit --json` 为 **0 vulnerabilities**。没有据此声称生产 CLI 曾被利用；Vitest 公告涉及开发 API/UI 暴露条件。[Vitest 官方公告](https://github.com/vitest-dev/vitest/security/advisories/GHSA-5xrq-8626-4rwp)、[fast-uri 官方公告](https://github.com/fastify/fast-uri/security/advisories/GHSA-f65p-4m7j-42xc)。
- **F06：Bun fetch 包装丢失宿主成员。** 原全局 router 替换函数后 `fetch.preconnect` 变成 undefined；改用只拦截调用的 Proxy 保留宿主静态成员，普通 SDK 代理函数只声明调用签名。Bun RED→GREEN 与 Node 代理测试均保留。
- **F07：可注入的 TUI effect 与 port 参数漂移。** 原 `as Parameters<...>` 掩盖审批/队列缺少 item、process cursor 形状不匹配。移除这些强转，通过真实查询快照重验关联/generation/revision 再提交；非法游标不会回退到输出起点。审批/队列生产 mutation port 当前仍受能力缺口限制，本修复不宣称新增了生产授权 authority。
- **F08：持续 stderr 可饿死协议 stdout。** 首版分流在动态尾部始终 truncated 时会一直读 stderr。可控 moving-head fixture 复现后，live 每轮限制读取预算，terminal 按固定 head 排空；400 KB stderr 后置错误仍保留。该预算有实际 RED 支撑。
- **F09：Session 控制请求吞错。** 中断/清队列及 editor activity 命令失败时原方法忽略错误，用户收不到诊断。三处后台请求现共用错误投影，经 warning subscription 显示到 TUI；本地 dispose 后迟到的失败不再更新已关闭 UI，活跃连接的失败仍可见。定向 RED→GREEN 为 4 files / 39 tests。
- **F10：终端文本测量和折行丢字。** 旧实现把 ST 终结的 OSC 超链接正文吞进控制序列，`visibleWidth` 返回 0；一列宽度折行 `汉a` 会变成空行加 `a`。补 RED→GREEN，修正 OSC token 边界，折行改为按 grapheme 单次遍历；不可拆的宽字符在极窄宽度下独占一行，保留正文。
- **F11：带引号的诊断凭据部分泄漏。** 交叉审阅使用合成 `password="first second"`、`api_key='alpha beta'` 复现只隐藏首词、留下后半段的问题；修复覆盖单/双引号及跨 chunk。规则限定已识别的凭据字段，不宣称可以识别任意未知 secret。
- **F03 补充：MCP/LSP 输出读取失败后的回收缺口。** 真实 managed process probe 证明，stderr reader 返回错误或 reject 后，MCP 的 `closed` 标记使后续 `close()` 跳过 stop/wait，LSP 则直接完成退出通知；child 均仍处于 `backgrounded` 并持续输出 heartbeat。原 invalid-protocol 测试仅排除 `starting/running`，漏掉 `backgrounded`，不能作为回收证据。修复复用现有 stop/wait，MCP 启动失败与 close 也等待既有 pump 回收完成；强化回归后 3 files / 30 tests 通过。四个真实 reader-failure probe 均观察到 SIGTERM → wait → `killed`，不再输出 heartbeat；探针子进程均已回收。

交叉审阅还观察到，POSIX 进程组信号可以同时直达 Bun 和经 launcher 转发。真实 Agent 的一次/两次 interrupt 对照均只有一次 abort、一次 agent_end、零工具启动；没有据此增加去抖、进程组隔离或新的 launcher 分支，也不将计数差异作为已确认的产品缺陷。

### 9.4 过度防御清理

用户追加要求后，按实际调用关系清理冗余，避免把所有异常处理一概删除：

- 去掉启动时重复的 Bun 同步预探测，由实际 spawn 统一报告启动失败。
- smoke 只要求必要的产品 ready 标识，退出码、fatal 与残留进程的已复现负向检查保留。
- 移除 `plan.inspect` 的空 plan ID/虚构 revision、EffectRunner 参数强转、重复 payload 拷贝及不可达 abort 分支；保留将同步 port throw 统一转成 Promise rejection 的 async wrapper。
- TUI 测试使用 `requireNode` 确认真实类型后，删除后续重复判空与提前返回，避免维护两套成功条件。
- Kimi 设备 ID 去掉重复缓存/读回检查；OAuth 不再拥有用户目录解析和文件写入。
- 对于错误消息投影、清洗/分页预算、owner/Gateway/fence 和 canonical layout，保留有实际契约或 RED 支撑的检查。

### 9.5 修复轮统一门禁（提交前补充见 §10）

统一验证在包括交叉审阅补充修复在内的源码冻结后执行。定向 RED/GREEN 原始日志位于 `tmp/audit-repair-2026-09-05/`，不是最终门禁的替代。

| 项目 | 修复后结果 | 证据边界 |
|---|---|---|
| `npm run check` | PASS，exit 0，63.55 秒 | 全部静态边界、567 consumers / 0 diagnostics、src typecheck、Rust 12 tests、Bash AST assets/pack；完整输出已审阅 |
| `npm run build` | PASS，exit 0，12.23 秒 | native、TypeScript、TUI assets、build manifest 全部重建 |
| `npm run test:inventory` | PASS，502 owned files / 0 diagnostics | 所有测试入口有明确 bucket 归属 |
| `npm test` | PASS，exit 0，633.04 秒 | Vitest **480 files / 2,995 tests passed**，1 file / 3 tests skipped；Bun **19 files / 139 tests passed / 1,040 assertions**，0 fail |
| `npm run test:smoke` | PASS，exit 0；1 file / 5 tests | 四类错误 fixture 均被拒绝；built help/version/真实 TTY ready、exit 0、remainingDescendants=0 |
| 全局 `runledger` 143×42 / 80×24 | PASS，两次 Ctrl+D 均 exit 0 | 143 列 standard → `/model` 无凭据错误 → `/new minimal`；80 列 minimal。退出前只读隔离 catalog 验证 exact profile，两次所有跟踪进程均已关闭 |
| 真实 gateway + SIGTERM | PASS | launcher PID：exit 0；进程组：exit -15（SIGTERM）；两次 `/healthz` 从 200 变成 connection-closed，Bun child 均消失 |
| `npm audit --json` | 0 vulnerabilities | 精确依赖锁已更新，Vitest 3.2.6；不是对外部服务的安全审计 |
| `build:contracts` / 独立导入 | PASS | 新的偏好合同不依赖 CLI/TUI/native 即可构建和导入 |

最终原始日志和 summary 位于 `tmp/audit-repair-2026-09-05/`，为本机忽略产物，不保证随 Git 长期留存。`final-gates.json` 保存每个命令的退出码、耗时和日志 SHA-256；`final-test-summary.json` 保存全量测试计数及 digest；`final-cli/summary.json` 与 `artifact-digests.json` 关联本次 built/global CLI。

本轮完整 `final-test.log` SHA-256 为 `c641a6a4c6964bb7e7543500b87d757e49846ae1cfe8e0d81080cac4f508368a`。文档更新后的 current-format、文档本地链接与 `git diff --check` / `git diff --cached --check` 均通过。原始 13 个暂存文件的 staged patch 在修复前后逐字节一致（SHA-256 `e24c058020d97d7c95bea1b2d352f0bd94135ac6f5f494e80485eca1c096eae8`）；本次代码、测试和文档修改保持未暂存，未创建 commit 或执行 push。

CLI 与 smoke 的候选 manifest SHA-256 均为 `9c2c9bc2935dfe5b1b7bc4bd400f76a74e213bdcae6fe5dfa8e62595068672e9`，与实际 `dist/host-build-manifest.json` 一致。80×24 的首屏 Session/输入区可见，标题/Harness 在 viewport 外；这项布局观察未被当成完整人工视觉验收。第一次 CLI probe 在退出后才查 catalog，撞上无用户消息 Session 的正常回收，已调整为退出前核验并保留失败探针记录。

保留失败记录：首次统一 `check` 因新增 warning subscription 缺少 B8 精确白名单而失败，补上单个允许项后通过。首轮 `npm test` 在 215 files / 1,494 tests passed 后遇到两项旧源码字面量断言（同步 launcher、内联 native build）；更新断言后这两文件 14 tests 定向通过，再执行完整门禁。未把中途失败或部分桶通过写成全量通过。

### 9.6 剩余修复/验收清单

- [ ] Plan 13 后续物理 workspace/package 迁移、wildcard API 收缩与其他 composition 拆分（本轮完成的是单包边界准备）。
- [ ] 真实外部 provider/MCP/LSP 凭据与服务回合，联合 fault/migration 演练。
- [ ] macOS/Windows 原生 runner、dark/light 真人视觉、真实键盘/中文 IME 验收。
- [ ] 80×24 Welcome 的高度适配：输入区与 Session 信息可见，标题/Harness 首屏位于 viewport 外；启动和退出通过，但标题布局仍应在人工视觉验收时处理。
- [ ] Runtime 06 R6.5/R8 正式接受后再判断 R9；本轮不授权删除 legacy Host。

## 10. 本地提交范围与独立候选复验

用户随后授权 `git commit`。本次仅提交审计修复，使用独立候选分离原有暂存；原 13 项暂存补丁在代码提交后重放到新 HEAD，仍留待原任务提交。README、既有架构文档、review-note、Plan 13 草稿，以及原有 AGENTS sandbox 段和 Plan 13 索引路由继续保留在工作区；Plan 13 本轮推进结果已记录于 §9。没有推送。

| 本地代码提交 | 目的 |
|---|---|
| `1ad8434` | 启动器可靠退出，smoke 拒绝假通过及标题滚出视口的误报 |
| `dbfae01` | 保留协议诊断并回收异常 MCP/LSP 子进程 |
| `a46346f` | 显示异步命令失败，按当前 workflow 合同组装参数 |
| `a236fa1` | 消除 storage/TUI/auth 反向依赖并修正文本折行 |
| `86159ca` | 完整 consumer 类型门禁与工具链依赖更新 |

提交前独立候选基于 `74d39a1` 只应用本轮代码差异；最终代码 tree 为 `73ced742c8901d0c18fc7830176e94f01a03ab4c`，与 `86159ca` 的 tree 完全一致。该候选通过完整 `npm run check`（564 consumers / 0 diagnostics）、构建、20 files / 196 tests 定向回归，以及 canonical `npm run test:smoke`（6 tests 和真实 built TTY，exit 0，无后代残留）。§9 的全量测试是包含原暂存修改的完整工作树证据，与此处独立候选的验证范围分开。

独立候选复验期间确认了 F02 的另一个问题：100×30 终端中，两行 Tip 可将版本标题挤出 viewport，CLI 仍可输入并以 exit 0 退出。新正向 fixture 完成 RED→GREEN；smoke 现在以 `Message RunLedger` 输入区判断 ready，同时保留 fatal、非零退出、提前退出和残留进程四项负向检查。

主树再次构建后，全局 `runledger` 的链接仍指向本仓库，143×42 TTY 启动通过、Ctrl+D exit 0、跟踪进程全部关闭，隔离 home 已清理。提交前 evidence 位于本机忽略目录 `tmp/commit-audit-repair-2026-09-05/`：`candidate-check-final.log`、`candidate-focused.log`、`candidate-smoke-fixed.log`、`candidate-viewport-repair-summary.json`、`main-build-final.log`、`global-final-summary.json` 和分组提交记录。
