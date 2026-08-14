# RunLedger Tree-sitter Bash AST 移植实施计划

> 文档状态:`implemented (B0–B4)`；B5 仍为 `planned`，尚未达到 `agent-verified` 或 `human-verified`。本文是唯一实施和验收账本；B0–B4 实现与 review 修复随本次本地提交落账，不另建平行总计划<br>
> 编写日期:2026-08-14；最近实施复核:2026-08-15<br>
> 目标仓库基线:2026-08-14 `RunLedger` 工作树（实施起点 HEAD `c83ef05c`；相对 HEAD 含其他任务的既有脏改动，本专题只按显式路径提交）<br>
> 参考实现:../RunLedger-agent-loop-resurrect `feat/agent-loop-resurrect`，目录 `src/security/permission/bash-ast/`（11 个模块约 1,700 行）与 `assets/tree-sitter/`（2 个 WASM）<br>
> 参考文档:[`../RunLedger-agent-loop-resurrect/development-doc/extersion/01-implementation-plan.md`](../RunLedger-agent-loop-resurrect/development-doc/extersion/01-implementation-plan.md) §5、M5–M7、§7.4/§7.5/§8/§9.2/§10，[`00-reference.md`](../RunLedger-agent-loop-resurrect/development-doc/extersion/00-reference.md) §4<br>
> 相邻专题:`../RunLedger-agent-loop-resurrect/development-doc/extersion/02-bash-classifier-implementation-plan.md`（LLM prompt-rule classifier，不在本计划范围；它消费本计划的 AST result，不拥有 parser/walker/WASM）

## 0. 使用方式与状态规则

本文件是 Tree-sitter Bash AST 安全分类在本仓库移植与授权的唯一实施和验收账本。LSP 已由 [`../plan/04-lsp-server-adaptation-plan.md`](../plan/04-lsp-server-adaptation-plan.md) 独立交付；LLM Bash classifier 是后续独立专题。本文只拥有 Bash AST。

状态只能按以下顺序推进：

```text
planned
  -> implemented
  -> agent-verified
  -> human-verified
```

- `implemented`：代码与自动测试完成，但尚未关闭全部阶段门禁。
- `agent-verified`：阶段要求的 contract、integration、build、PTY 和结构门禁通过。
- `human-verified`：计划列出的真实终端与安全场景由用户明确验收。
- mock、单测、截图或 Agent 自测不能替代 human gate。
- 任一阶段只有在“实现、测试、文档状态、证据”同时闭合后才能勾选。

### 0.1 阶段状态

| 阶段 | 范围 | 对应参考 M 阶段 | 状态 | Commit | 证据 |
|---|---|---|---|---|---|
| B0 | 契约、依赖、WASM 资产、供应链与 RED 基线 | M0（Bash 部分）+ M5 前置 | `implemented` | 本次本地提交 | `check:bash-ast-assets`、5 个 contract tests、npm pack 资产清单通过 |
| B1 | bash-ast 模块移植：worker、walker、semantics、precheck、protocol | M5 | `implemented` | 本次本地提交 | walker 7 tests、Node worker 13 tests、Bun worker 13 tests、dist worker smoke 通过 |
| B2 | 类型/config/access-resolver/engine 接入与 mode-aware 判定 | M5–M6 前置 | `implemented` | 本次本地提交 | authorization 10 tests、config/mode/access/engine 定向覆盖、`tsc --noEmit` 通过 |
| B3 | 生产装配、CLI flag、shadow telemetry 与差异观测 | M5 完成门 | `implemented` | 本次本地提交 | Session Security 29 tests、Session 预热/双池隔离、shadow 脱敏、durable Bash audit、worker close/status 覆盖 |
| B4 | ast 权威授权、fail-closed 矩阵与 rollout | M6 | `implemented` | 本次本地提交 | parse-unavailable 策略矩阵、Bash approval timeout、managed deny/hardline、Gateway 审计及结构 mutant 覆盖 |
| B5 | 打包、加固、Bun/Node 平台门禁与 human gates | M7（Bash 部分） | `planned` | — | — |

### 0.1.1 2026-08-15 实施事实与未闭合门禁

当前工作树已经落地 B0–B4 的实现切片：`src/security/permission/bash-ast/` 负责唯一 WASM loader、bounded worker pool、allowlist walker、语义检查、分类与 mode lattice；配置、CLI、Session Security、PermissionEngine、Gateway 和审批路径已接线。两个生产 Bash 执行入口都复用 `resolveToolAccessRequestsWithBashAnalyzer`，不再各自复制 resolver。非 legacy Session 在暴露 shell 前预热自己的 worker pool，启动等待上限为 1,000 ms；单次 worker ready 等待和 parse/classify deadline 各自固定为 50 ms。默认解析模式仍是 `legacy`，`shadow`/`ast` 只能由显式配置选择；没有把 AST 失败回退到 legacy，也没有改动 legacy Host 授权路径。

本轮自动证据：

- `npx vitest run` Bash AST/Gateway/approval/Session Security 定向集合：10 files / 91 tests passed；`npx tsc --noEmit -p tsconfig.json` 与 `npm run check:bash-ast-assets` 通过。结构门禁包含 4 个 mutant tests，固定 canonical resolver、无 legacy fallback、AST failure fail-closed、hardline 顺序、telemetry redaction 与 legacy Host 隔离。
- Node `v22.23.1` 的 source/dist worker smoke 和 Bun `1.3.14` 的 `tests/security/bash-ast-worker.test.ts`：13 tests / 157 assertions passed；Bun deadline case 使用 precheck 上限内的最大 token 序列，连续 3 次通过并验证 fresh worker replacement；property corpus 先复现生产 prewarm，再并发灌入 128 条分类请求并 drain/close。
- Session Security 生产矩阵覆盖 injected `parse-unavailable` 在 headless/on-request/untrusted/granular（含 rules disabled）下的 deny/approval 行为、Bash approval timeout，以及两个 Session 各自持有 worker pool 且关闭一个不影响另一个。标准 `assembleSessionDomain()` 默认绑定 fenced、去重的 Session Event Store adapter，持久化 `security.bash_classified` 与 `security.bash_authorized`，记录 access-request digest、authorization outcome、可选 approval receipt、constraint snapshot digest 与可选 sandbox receipt digest；不记录 raw command/argv/env。
- `npm run build` 通过；全局 `/home/nzq/.npm-global/bin/runledger` 解析到当前仓库。使用隔离、预创建的 `RUNLEDGER_DIR` 在真实 tmux PTY 中启动 `runledger --bash-analyzer ast` 成功并呈现 idle TUI，未读取或改写真实用户目录；因隔离 home 无凭据，本证据只关闭 AST mode 标准 PATH 启动，不替代真实 Bash tool approval/execute 交互 gate。
- `npm run check` 的 current-format/storage/runtime/contract/execution/platform 等前置门禁通过，仅在既有 `src/tui/opentui/exec-renderable.ts` ANSI foreground boundary 停止；完整 `npm test` 同样仅由该 checker suite 阻断，其余 361 files / 2169 tests passed、1 file skipped。该 TUI 文件属于并行共享工作树改动，本专题不修改或伪造通过。

尚未闭合：B5 的 fuzz/property corpus、长期 worker leak soak、真实 npm packed consumer（当前已验证 pack 清单与 source/dist locator）、标准 PATH PTY 的 shadow/ast Bash tool approval/execute 交互、独立只读安全审计、rollback runbook，以及用户对 benign/dangerous/too-complex/unavailable 真实终端场景的明确 human gate。AST 专项尚未增加独立 crash/resume runner；该执行 fence 目前仍由通用 attempt/Gateway recovery tests 负责，不能据此宣称 AST 专项 fault rehearsal 已完成。

### 0.2 与现有权威计划/能力的关系

| 上游/相邻能力 | 本计划消费的约束 | 本计划不拥有 |
|---|---|---|
| [`../runtime/04-governed-agent-harness-runtime-plan.md`](../runtime/04-governed-agent-harness-runtime-plan.md) | 公共 contract、canonical digest、event/receipt、session lifecycle | 不建立第二套 event/ledger 或授权真源 |
| [`../runtime/06-session-owner-runtime-replacement-plan.md`](../runtime/06-session-owner-runtime-replacement-plan.md) | Session-scoped 组合根为 `src/runtime/session-runtime/domain.ts` → `src/security/session-composition.ts` | 不修改 legacy Host（`src/cli/runtime-host-security.ts`）的授权路径 |
| [`../plugin-mcp-skill-hooks/01-implementation-plan.md`](../plugin-mcp-skill-hooks/01-implementation-plan.md) | Extension/MCP 不参与 Bash 解析；本专题不依赖插件声明 | 不重建 ExtensionManager/TrustStore |
| [`../worktree-sandbox-permisson/00-worktree-sandbox-permission-plan.md`](../worktree-sandbox-permisson/00-worktree-sandbox-permission-plan.md) | `security.json`、PermissionEngine、ApprovalCoordinator、Gateway、sandbox | 不复制 policy merge、approval store 或 sandbox backend |
| [`../plan/04-lsp-server-adaptation-plan.md`](../plan/04-lsp-server-adaptation-plan.md) | 已交付的 LSP 与本文无共享代码路径 | 不把 LSP 状态或诊断与 Bash AST 混写 |
| [`../tui/`](../tui/00-overview.md) | canonical 命令/面板约束；本阶段不新增 TUI 命令 | 不建立 Bash 专用第二套 Timeline |

固定所有权：

1. `src/security/permission/bash-ast/` 拥有解析、walker、语义规则与分类结果。
2. `src/security/config/` 拥有 `bashAnalyzerMode` 的来源合并。
3. `src/security/permission/access-resolver.ts` + `engine.ts` 拥有 AST 结果到授权决定的 fail-closed 接入。
4. `src/security/session-composition.ts` 拥有 analyzer 生命周期（创建、pool、close、shadow telemetry 接线）。
5. `src/cli/args.ts` 只提供 `--bash-analyzer` 收窄 flag；CLI 不直接 spawn worker。
6. legacy Host（`src/cli/runtime-host-security.ts`）不新增任何 bash-ast 接线；新可选字段不得破坏其现有路径。

## 1. 目标

### 1.1 安全闭环

```text
raw command
  -> unconditional managed deny / catastrophic hardline check
  -> bounded worker_threads + official tree-sitter-bash WASM
  -> precheck + allowlist walker + semantic checks
  -> canonical simple command / redirect access requests
  -> PermissionEngine（mode-aware builtin shell decision）
  -> approval coordinator / Gateway / sandbox
  -> execute
```

AST 的职责是提高 shell 结构识别精度（产出 `simple` 的 canonical access request、`too-complex`、`parse-unavailable`），不替代现有治理层，不直接“批准”任何命令。

### 1.2 移植原则

参考实现已经逐文件核对并作为移植源，但移植不是复制粘贴：

- 保持参考实现全部安全不变量、预算、hash 与失败映射不变；
- 只改写与本仓库差异相关的导入、类型接线与组合点（§5 列全）；
- 不为“适配”而放宽任何 fail-closed 规则；
- 未列出的 node type、wrapper flag、语义场景一律 `too-complex`。

### 1.3 非目标

- LSP 能力、LLM prompt-rule Bash classifier（后续独立专题，消费本计划的 AST result）；
- 复制 claude-code-bun 约 7,600 行手写纯 TypeScript Bash parser（参考结论 §4.3 已否决）；
- PowerShell、zsh、fish 的 AST；
- 以 AST 绕过 managed deny、hardline、approval、Gateway 或 sandbox；
- AST 失败后回退 legacy 取得 allow；
- 新增 TUI 命令或 CLI 子命令面（只加一个 `--bash-analyzer` flag）；
- 修改 legacy Host 授权路径或既有 Runtime 行为。

## 2. 参考实现盘点（移植源）

### 2.1 模块映射

以下为参考仓库逐文件核对结果；`target 位置` 为本仓库目标路径，除注明外内容直接移植：

| 参考文件（RunLedger-agent-loop-resurrect） | 行数 | 本仓库目标位置 | 移植时需要适配 |
|---|---|---|---|
| `src/security/permission/bash-ast/types.ts` | 133 | `src/security/permission/bash-ast/types.ts` | 无（常量、hash、类型原样） |
| `src/security/permission/bash-ast/precheck.ts` | 34 | 同上目录 | 无 |
| `src/security/permission/bash-ast/worker-protocol.ts` | 246 | 同上目录 | 无 |
| `src/security/permission/bash-ast/worker.ts` | 239 | 同上目录 | 无（唯一 WASM 加载点保持） |
| `src/security/permission/bash-ast/parser.ts` | 250 | 同上目录 | `createRuntimeId` 直接从 `runtime/contracts/public.ts` 导入 |
| `src/security/permission/bash-ast/walker.ts` | 295 | 同上目录 | 无 |
| `src/security/permission/bash-ast/semantics.ts` | 221 | 同上目录 | 无 |
| `src/security/permission/bash-ast/classifier.ts` | 167 | 同上目录 | `canonicalDigest` 直接从 `runtime/contracts/public.ts` 导入 |
| `src/security/permission/bash-ast/mode.ts` | 72 | 同上目录 | 同上（`canonicalDigest`） |
| `src/security/permission/bash-ast/assets.ts` | 42 | 同上目录 | 无（asset root 相对路径 `../../../../assets/tree-sitter` 需按本仓库布局复核） |
| `src/security/permission/bash-ast/index.ts` | 9 | 同上目录 | 无 |
| `assets/tree-sitter/tree-sitter-bash.wasm` | 1,358,224 B | `assets/tree-sitter/tree-sitter-bash.wasm` | 原样，hash 校验 |
| `assets/tree-sitter/web-tree-sitter.wasm` | 201,037 B | `assets/tree-sitter/web-tree-sitter.wasm` | 原样，hash 校验 |
| `tests/security/bash-ast-walker.test.ts` | 85 | `tests/security/bash-ast-walker.test.ts` | 类型/路径适配 |
| `tests/security/bash-ast-worker.test.ts` | 245 | `tests/security/bash-ast-worker.test.ts` | 同上 |
| `tests/security/bash-ast-authorization.test.ts` | 284 | `tests/security/bash-ast-authorization.test.ts` | snapshot 构造适配本仓库 engine/config |

### 2.2 固定常量与供应链

| 项 | 值 |
|---|---|
| command 长度上限 | 10,000 UTF-16 code units |
| parse/classify deadline | 50 ms |
| worker ready 等待（单次 classify） | 50 ms |
| worker startup/prewarm 上限 | 1,000 ms |
| AST node 上限 | 50,000 |
| worker pool 上限 | 2（每 worker 同时 1 个请求） |
| reason/detail 上限 | 2,048 chars |
| `tree-sitter-bash` | 精确版本 `0.25.1`（production dependency） |
| `web-tree-sitter` | 精确版本 `0.26.11`（production dependency） |
| Bash grammar upstream revision | `801326684a26ffc4e749bb016c50c6c30bdfa345` |
| `tree-sitter-bash.wasm` SHA-256 | `8292919c88a0f7d3fb31d0cd0253ca5a9531bc1ede82b0537f2c63dd8abe6a7a` |
| `web-tree-sitter.wasm` SHA-256 | `715cae35f31b7b03a13592bc5ac9039d5c6d2c2bda9f9e0c2b8abab77b3f64cc` |
| parser digest | `cc228d357506ee221fb19ac58d8f7a8d0e9d8b45b37b91166f3a13055b6ef387` |
| worker protocol version | `1` |

依赖使用精确版本，不使用 caret/range。WASM 资产必须进入 `npm pack` 产物（本仓库 `package.json` `files` 目前只有 `dist` 等，B0 必须补 `assets/tree-sitter`）。hash 不符、资产缺失或初始化失败时 fail closed，不从网络补下载。

### 2.3 参考实现的集成面（作为本仓库接线蓝本）

| 参考位置 | 行为 | 本仓库对应接线点 |
|---|---|---|
| `security/types.ts` shell request 扩展 | shell AccessRequest 增加可选 `bashAnalyzerMode`、`bashAst`、`bashMetrics` | `src/security/types.ts` shell kind 扩展（新字段可选，兼容 legacy 路径） |
| `security/types.ts` config layer | `SecurityConfigLayer.bashAnalyzerMode`、`ManagedSecurityConstraints.minimumBashAnalyzerMode` | `src/security/config/schema.ts` + `types.ts` |
| `security/config/resolver.ts` | `resolveBashSecurityAnalyzerMode({user, project, cli, managedMinimum})` | `src/security/config/resolver.ts`（resolveSecuritySnapshot 内） |
| `security/permission/access-resolver.ts` | `resolveToolAccessRequestsWithBashAnalyzer(...)`：`toolName !== "bash"` 直接走同步版；bash 先 analyze 再构造扩展 shell request | `src/security/permission/access-resolver.ts`（当前只有同步 `resolveToolAccessRequests`） |
| `security/permission/engine.ts` | builtin shell decision 按 mode/AST 结果分支 | `src/security/permission/engine.ts` 的 builtin shell 分支（当前 `analysis === "unknown"` → ask `builtin-shell-unknown`） |
| `security/integration/runtime-gateway-adapter.ts` | `bashAnalyzer?: BashSecurityAnalyzerPort` 注入 | 本仓库 Gateway 接线在 `session-composition.ts`，见 §5.5 |
| `cli/args.ts` | `--bash-analyzer legacy\|shadow\|ast` | `src/cli/args.ts` |
| 生产工厂 | `BashSecurityAnalyzer` 创建、close、status | `src/security/session-composition.ts`（`createSessionSecurity`） |
| 控制面 doctor | WASM 资产/hash 检查进 doctor | 本阶段仅 `scripts/check-bash-ast-assets.ts`；doctor 接线留到有明确需求时 |

## 3. 本仓库基线现状与缺口

### 3.1 可复用能力（已核实）

| 能力 | 路径 | 用法 |
|---|---|---|
| legacy shell analyzer | `src/security/permission/shell-analyzer.ts` | legacy/shadow 基线；`analyzeShellCommand` + `hardlineShellDenialReason` |
| 单一访问请求分类器 | `src/security/permission/access-resolver.ts` | 增加 async analyzer 变体 |
| PermissionEngine | `src/security/permission/engine.ts` | builtin shell 分支是 mode-aware 接入点 |
| 配置合并 | `src/security/config/{resolver,schema,loader,profile-compiler}.ts` | 增加 `bashAnalyzerMode` 与 managed minimum |
| approval/Gateway/sandbox | `src/security/{approval-coordinator,execution-gateway,integration,sandbox}/**` | 不变，继续作为授权真源 |
| Session 生产组合根 | `src/security/session-composition.ts`（`createSessionSecurity` → `createGovernedShell`） | analyzer 生命周期唯一所有者 |
| Runtime 公共 contract | `src/runtime/contracts/public.ts`（含 `protocol/ids.ts`、`protocol/canonical-json.ts`） | `createRuntimeId`/`canonicalDigest` 导入源 |
| 结构门禁 | `scripts/check-execution-boundaries.ts` 等 | 增加 bash-ast 规则 |
| 测试目录 | `tests/security/` | 新增 3+ 个 bash-ast 测试文件 |

### 3.2 B0 前基线缺口（历史输入，当前已由 B0–B4 闭合）

- 无 `src/security/permission/bash-ast/`、无 `assets/tree-sitter/`；
- `package.json` 无 `web-tree-sitter`/`tree-sitter-bash`，`files` 不含任何资产目录；
- 全仓无 `node:worker_threads` 使用（bash-ast 将是第一个 worker 模式）；
- shell AccessRequest 无 mode/AST/metrics 字段；
- `access-resolver.ts` 只有同步版本；
- `engine.ts` 对复杂 shell 统一 ask，无 AST 分支；
- config schema/resolver 无 `bashAnalyzerMode`；
- CLI 无 `--bash-analyzer`；
- `session-composition.ts` 的 `createGovernedShell` 同步构造 shell request，无 analyzer 注入与生命周期；
- 无 shadow telemetry、无 Bash 分类 durable event；
- 无 WASM hash/打包结构 checker。

## 4. 固定契约（移植时不得偏离）

### 4.1 分类结果

```ts
type BashSecurityAnalyzerMode = "legacy" | "shadow" | "ast";

type BashAstClassification =
  | { kind: "simple"; commands: readonly CanonicalSimpleCommand[]; parserDigest: string }
  | { kind: "too-complex"; reasonCode: string; nodeType?: string; parserDigest: string }
  | { kind: "parse-unavailable"; reasonCode: string; parserDigest?: string };
```

- `simple` 只表示 AST walker 完整理解了结构，仍须进入 managed policy、hardline、PermissionEngine、approval、sandbox 与 durable audit。
- `too-complex` 表示解析存在但语法/语义无法安全归一化。
- `parse-unavailable` 表示 worker、WASM 或初始化不可用。
- 解析超时、节点超限、panic/worker crash 与错误节点不能伪装成“未启用”，也不能在 ast 模式回退 legacy。

### 4.2 资源预算与失败映射

| 条件 | 结果 |
|---|---|
| command 空/超长、deadline、node budget | `too-complex`（reasonCode 分别 `bash_empty_command`/`bash_command_oversize`/`bash_parse_deadline`/节点超限） |
| 控制字符、Unicode 非标准 whitespace、反斜杠+空白、zsh 歧义 | `too-complex`（`bash_control_character`/`bash_unicode_whitespace`/`bash_escape_whitespace_ambiguity`/`bash_cross_shell_ambiguity`） |
| parser `ERROR`/missing node、未知 AST node、序列化失败 | `too-complex` |
| WASM hash/加载/初始化失败、worker crash、协议 shape/version 不匹配 | `parse-unavailable` |
| 未知 grammar revision | `parse-unavailable` |

超时或 crash 后必须 terminate 对应 worker 并以 fresh worker 替换，禁止复用可能损坏的 parser state。任何失败不得抛出到 Runtime（按仓库约定以 typed result 编码）。

### 4.3 precheck 规则（`precheck.ts` 原样）

1. 空命令、超 10,000 字符；
2. NUL、C0/C1 控制字符；
3. Unicode 非标准 whitespace（`\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff`）；
4. 反斜杠 + whitespace 歧义（`\\[ \t\r\n\v\f]`）；
5. zsh 特有 `~[...]`、`=command` 形式（`(?:^|[\s;|&()])(?:~\[|=[A-Za-z_])`）。

### 4.4 allowlist walker

保留参考实现的白名单集合与语义，移植时逐项核对：

- container：program、command、pipeline、list、subshell、if/while/until/for、redirect、declaration、variable assignment、test command、comment；
- word：word、number、raw/single/double string、concatenation、受限 parameter/arithmetic expansion；
- 静态变量赋值与局部 scope 跟踪；动态展开用 placeholder，不伪造成确定字符串；
- 任何未列入且无专门安全证明的 node type 都是 `too-complex`；
- 尤其不对 command/process substitution、动态 executable、复杂 heredoc、function definition、coproc、数组/indirect expansion 做乐观降级。

### 4.5 语义规则（`semantics.ts` 原样）

- 二次解释 builtin：`.`/`eval`/`exec`/`source`/`trap`；
- shell keyword 出现在 argv[0] 的误解析检测；
- `test -v`、`printf -v`、`read -a/-A` 等间接变量/subscript flags；
- `/proc/*/environ` 与同类 credential/environment 读取；
- `jq` 的 `system()` 与危险 flags；
- `env`/`timeout`/`nice`/`stdbuf` wrapper 受限剥离；未知 flag、缺参数、动态 next command 一律 `too-complex`；
- PS4/IFS 等敏感变量严格 allowlist；
- redirect 目标与每个 pipeline/list segment 都生成 access request，不只检查首命令。

### 4.6 三种 rollout mode 与来源合并

```text
legacy 默认
  -> shadow opt-in
  -> shadow 默认、收集差异
  -> ast opt-in
  -> B5 human gate 后 ast 默认
  -> legacy 只保留显式受控 rollback 窗口
```

mode 强度 `legacy(0) < shadow(1) < ast(2)`；来源强度 `default(0) < user(1) < project(2) < cli(3) < managed(4)`；取最强 mode，同强度取最强来源。managed minimum 可以强制 `ast`；`--bash-analyzer` CLI flag 只能收窄。resolved config source 与 digest 必须记录。

### 4.7 fail-closed 决策矩阵（适配本仓库 approval policy）

本仓库没有 YOLO 模式（已核实），approval policy 为 `on-request | never | untrusted | granular`，headless 表现为 `approvalPorts` 缺失。矩阵按参考 §5.7 适配：

先应用 managed deny 与 catastrophic hardline block，它们始终不可覆盖。然后：

| 场景 | `simple` | `too-complex` / timeout | `parse-unavailable` |
|---|---|---|---|
| interactive + `on-request` | 继续 PermissionEngine | `ask`（正常 approval ticket/receipt） | `ask` |
| interactive + `untrusted` | 继续（untrusted 已强制 ask） | `ask` | `ask` |
| `approvalPolicy=never` | 继续 | `deny` | `deny` |
| `granular` | 继续 | 沿用 granular shell 类别（rules 启用则 ask，否则 deny） | 同左 |
| headless（无 approvalPorts） | 继续 | `deny` | `deny` |

补充约束（全部来自参考 §5.7，一字不改）：

- managed deny 永远强于 allow/ask；
- catastrophic hardline block 永远 unconditional deny；
- approval requester 缺失、超时、取消或证据不完整都变成 deny；
- AST 已经尝试后，无论 error kind 都不能调用 legacy analyzer 取得 allow；
- `simple` 仍要经过完整 PermissionEngine/Gateway/sandbox，不等于 allow；
- shadow mode 的 AST 结果永远不参与本次 decision。

### 4.8 shadow telemetry 与隐私

只记录（参考 §5.8）：

- legacy `known/unknown` 与 AST `simple/too-complex/unavailable` 的组合；
- canonical command count、executable/redirect/dynamic flag 类别一致性；
- reason code、timing/node count bucket、parser/grammar digest；
- raw command 的 salted digest。

不得记录 raw command、argv、env、文件正文或可能含 credential 的 expansion。Telemetry 不是 durable authorization truth。

## 5. 本仓库适配决策

移植前必须固定以下差异处理；不在实施中临时发明。

### 5.1 worker 隔离：沿用 `node:worker_threads`

参考实现用 `node:worker_threads`（`parser.ts` 的 `BashAstWorkerPool`），本仓库当前无任何 worker 模式。决策：

1. 原样移植 `node:worker_threads`，不换成子进程、不新建进程管理抽象。理由：参考实现已验证（worker 定向测试 + 50 ms deadline + crash 替换），换传输层引入新风险而无收益。
2. 本仓库 engines 同时声明 `node >=22.19` 与 `bun >=1.3`。`node:worker_threads` 在 Node 下为原生能力；Bun 兼容性不预设为成立，作为 B5 平台门禁：真实 Bun 运行 worker 测试，失败则只影响 Bun 下的 AST 可用性（→ `parse-unavailable` → fail-closed），不影响 Node 主路径与 legacy 授权。
3. 任何 worker init 失败只产生 `parse-unavailable`，不得 fallback 到 legacy、不得同步加载 WASM、不得在主线程持有 Tree-sitter Node。
4. worker 启动与单次分类预算分离：Session composition 在暴露非 legacy shell 前调用 `initialize()`，每个 worker 最多等待 1,000 ms；已经预热的 worker 在单次 `classify()` 中最多等待 50 ms ready，再以独立 50 ms parse/classify deadline 执行。crash/deadline 后的 fresh replacement 仍受 1,000 ms startup bound 约束，不再存在 5 秒启动等待。

### 5.2 类型接线

- `src/security/types.ts` shell kind 扩展为：

```ts
| { readonly kind: "shell"; readonly command: string; readonly cwd: string; readonly analysis: "known" | "unknown";
    readonly bashAnalyzerMode?: BashSecurityAnalyzerMode;
    readonly bashAst?: BashAstClassification;
    readonly bashMetrics?: BashAstClassificationMetrics; }
```

新字段可选，保证 `src/cli/runtime-host-security.ts` 等 legacy 构造点零改动编译通过。

- `SecurityConfigLayer` 增加 `bashAnalyzerMode?`；`ManagedSecurityConstraints` 增加 `minimumBashAnalyzerMode?`；schema 同步（`src/security/config/schema.ts`）。

### 5.3 access-resolver

新增（保持现有同步 `resolveToolAccessRequests` 供非 bash 与 legacy 路径使用）：

```ts
async function resolveToolAccessRequestsWithBashAnalyzer(
  toolName: string, argumentsValue: unknown, cwd: string,
  mode: BashSecurityAnalyzerMode, analyzer: BashSecurityAnalyzerPort,
): Promise<SecurityResult<readonly AccessRequest[]>>
```

`toolName !== "bash"` 直接返回同步版结果；bash 分支先 `analyzer.analyze(command, mode)`，再构造带 `bashAnalyzerMode/bashAst/bashMetrics` 的 shell request。`analysis` 字段仍由 legacy `analyzeShellCommand` 填充（shadow 对照需要）。

该函数是生产 Bash access request 的唯一异步 resolver；direct governed shell 与 managed-process prepare 都调用它。`session-composition.ts` 不拥有私有副本，结构 checker 会拒绝重复实现。

### 5.4 engine mode-aware 分支

`src/security/permission/engine.ts` 的 `builtinDecision` shell 分支改为：

1. `hardlineShellDenialReason` 命中 → deny（顺序不变，先于一切）；
2. mode 为 `legacy` → 现有 `analysis === "unknown"` → ask `builtin-shell-unknown` 逻辑不变；
3. mode 为 `shadow` → 与 legacy 字节一致（决策只用 `analysis`，AST 结果忽略）；
4. mode 为 `ast`：
   - `bashAst.kind === "simple"` → 继续后续规则/权限引擎（不直接 allow）；
   - `too-complex`/`parse-unavailable` → 按 §4.7 矩阵返回 ask/deny（`applyApprovalPolicy` 现有 never/untrusted/granular 转换继续生效，headless deny 由 coordinator 缺失 prompter 保证，B4 测试固化）；
   - `bashAst` 缺失（AST attempted 后不应发生）→ deny。

### 5.5 生产装配与生命周期

- `createSessionSecurity`（`src/security/session-composition.ts`）创建 `BashSecurityAnalyzer`（内部 `BashAstWorkerPool`），非 legacy mode 在 shell 对外可用前预热，加入组合的 owned resources，随 session drain 关闭（`close()` terminate workers）。测试注入的 analyzer 由调用方拥有，composition 不越权关闭。
- `SessionSecurityCompositionOptions` 增加 `bashAnalyzerMode?`（来自 CLI flag/config 解析结果）与可选 `bashShadowTelemetry?`。
- `createGovernedShell.exec` 与 managed-process prepare 都是 async：在构造 shell request 前通过 canonical resolver `await analyzer.analyze(command, mode)`，把结果写入 request。worker 不可用时只等待固定 ready/startup budget，决策按矩阵 fail-closed。
- `assembleSessionDomain`（`src/runtime/session-runtime/domain.ts`）与 `SessionDomainCompositionOptions` 透传 CLI flag。
- legacy Host（`src/cli/runtime-host-security.ts`）不加任何接线；结构门禁固定。

### 5.6 CLI flag

`src/cli/args.ts` 增加：

```text
--bash-analyzer legacy|shadow|ast
```

只允许收窄：CLI 解析为 `BashSecurityAnalyzerMode` 并经 `resolveBashSecurityAnalyzerMode({ cli })` 参与合并；不提供 `legacy` 之外的放权路径。

### 5.7 资产与打包

- 新增 `assets/tree-sitter/` 两个 WASM（从参考仓库原样拷贝，hash 校验）；
- `package.json` `files` 增加 `assets/tree-sitter`；
- 新增 `scripts/check-bash-ast-assets.ts`：校验两个 SHA-256、size 上界（5 MiB）、`npm pack --dry-run` 产物包含资产、`src/security/permission/bash-ast/worker.ts` 之外无 `web-tree-sitter` 加载点；
- `assets.ts` 的 `assetRoot` 相对路径按本仓库布局验证三种形态：source checkout、`dist`、npm packed layout。

### 5.8 durable 事件

`assembleSessionDomain()` 默认创建 `createSessionBashClassificationAudit({ store, fence })`；显式注入端口只作为受控 override。adapter 以确定性 event id 去重并通过当前 owner fence 向 Session Event Store 追加：

- `security.bash_classified`：command digest、mode/config/parser digest、result/reason、timing/node bucket、access request digest、authorization outcome 与可选 approval receipt id；
- `security.bash_authorized`：request digest、constraint snapshot digest 与可选 sandbox receipt digest。

Gateway 在 authorization outcome 已知后写分类记录，direct/managed final leaf 成功后再写绑定记录。sink 失败保持 best-effort，不改变授权决定；fence/session 不匹配 fail closed 于 sink 内。真实执行的 tool input/result 审计继续服从现有 Runtime redaction，本专题不扩大明文保留范围。

## 6. 分阶段实施

每个阶段形成一个关注单一目的的 commit。开始阶段前记录当前 HEAD 和 dirty paths，只暂存本阶段显式路径。

### B0 — 契约、依赖、WASM 资产、供应链与 RED 基线

实现：

- [x] 冻结 §4 契约与本仓库适配决策（本文更新确认）；
- [x] `package.json` 增加 `tree-sitter-bash@0.25.1`、`web-tree-sitter@0.26.11` 精确依赖并审阅 lockfile；
- [x] 拷贝 `assets/tree-sitter/` 两个 WASM，校验 SHA-256 与 upstream revision 记录；
- [x] 新增 `scripts/check-bash-ast-assets.ts` 并接入 `npm run check`；
- [x] `package.json` `files` 增加 `assets/tree-sitter`，`npm pack --dry-run` 验证；
- [x] 扩展 `src/security/types.ts` shell kind 与 config layer 类型（可选字段，编译零破坏）；
- [x] 提交 RED contract tests：mode lattice、类型 schema、失败映射（当前已转为 green 回归）。

验证：

- schema 拒绝非法 mode、config 层非法值；
- 两个 WASM hash 与 §2.2 完全一致，资产缺失/超限被 checker 拒绝；
- `npm pack --dry-run` 输出包含 `assets/tree-sitter/*.wasm`；
- RED 测试只因 bash-ast 模块缺失而失败，不因 fixture/setup 错误；
- 全仓 `npm run build` 通过；`npm run check` 与 `npm test` 的 Bash AST/相关 Session 门禁通过，但整体仍受既有 current-format 与 TUI boundary 失败阻断（见 §0.1.1）。

完成门：

- 依赖/provenance 有明确记录；未改变生产授权行为；无 worker 运行。

### B1 — bash-ast 模块移植：worker、walker、semantics、precheck、protocol

实现：

- [x] 移植 `types.ts`、`precheck.ts`、`worker-protocol.ts`、`worker.ts`、`walker.ts`、`semantics.ts`、`parser.ts`、`assets.ts`、`index.ts`（§2.1 映射的导入适配）；
- [x] 随 B1 一起移植 `classifier.ts`、`mode.ts` 纯逻辑（已接入生产）；
- [x] 移植 `tests/security/bash-ast-walker.test.ts`、`bash-ast-worker.test.ts`。

验证：

- walker 对 simple argv/quote/escape、pipeline/list/redirect、if/loop/subshell、assignment/scope、wrapper、eval/source/exec/trap、command/process substitution、heredoc、Unicode/control 歧义的 golden 断言与参考一致；
- worker 对 syntax error、ERROR/missing node、unknown node、timeout（50 ms deadline 后 worker 被 terminate/replaced）、node bomb、worker crash、WASM hash drift 的失败映射与参考一致；
- 分类结果不含 raw command；worker 是唯一 `web-tree-sitter` 加载点。

完成门：

- bash-ast 模块可以独立构建并通过移植后的定向测试，且已接入 Session Security 授权路径；全专题 agent-verified 仍受 B5 门禁约束。

### B2 — 类型/config/access-resolver/engine 接入与 mode-aware 判定

实现：

- [x] `src/security/config/schema.ts` + `types.ts`：`bashAnalyzerMode`/`minimumBashAnalyzerMode` schema 与合并；
- [x] `src/security/config/resolver.ts`：`resolveBashSecurityAnalyzerMode({ user, project, cli, managedMinimum })` 进 snapshot（mode + source + configDigest）；
- [x] `src/security/permission/access-resolver.ts`：`resolveToolAccessRequestsWithBashAnalyzer`（§5.3）；
- [x] `src/security/permission/engine.ts`：§5.4 mode-aware 分支；
- [x] 移植 `tests/security/bash-ast-authorization.test.ts` 并适配本仓库 snapshot/engine 构造。

验证：

- mode lattice：user/project/cli/managed 全组合，managed minimum 不可降级；
- engine 矩阵（§4.7）全覆盖：interactive/never/untrusted/granular/headless × simple/too-complex/unavailable；
- hardline/managed deny 在所有 mode 不可覆盖；
- shadow 决策与 legacy 字节一致（注入 AST 结果也不变）；
- ast simple 仍不能绕过 filesystem/network/sandbox；
- legacy Host 构造点（`runtime-host-security.ts`）编译与行为零变化。

完成门：

- 授权路径 mode-aware 完成；生产默认仍为 `legacy`，无行为变化。

### B3 — 生产装配、CLI flag、shadow telemetry 与差异观测

实现：

- [x] `src/security/session-composition.ts`：analyzer 创建/owned resources/close；`createGovernedShell` 先 analyze 再构造 request（§5.5）；
- [x] direct governed shell 与 managed-process prepare 统一调用 canonical async access resolver；
- [x] `SessionSecurityCompositionOptions`/`SessionDomainCompositionOptions` 透传 security 配置；标准 SessionDomain 默认绑定 fenced、去重的 durable Bash 分类审计 adapter；
- [x] `src/cli/args.ts`：`--bash-analyzer legacy|shadow|ast`（只收窄）；
- [x] `BashShadowTelemetryPort` 实现（salted digest + 差异记录，§4.8），可选注入；
- [x] 非 legacy Session 在暴露 shell 前以 1,000 ms startup budget 预热 pool；`bashAnalyzer.status()` 在 Session Security 组合中可观测，并在 close 后报告 `workerHealth=closed`。

验证：

- shadow 开启后生产授权与 legacy 完全一致（集成级对照）；
- telemetry 不含 raw command/argv/env（sentinel 扫描）；
- session drain 关闭 analyzer（worker 无泄漏）；
- CLI flag 非法值报错，`--bash-analyzer` 只允许显式收窄；
- 双 Session 隔离（各自 pool；关闭第一个后第二个仍为 ready 且可执行）；
- `security.bash_classified` / `security.bash_authorized` durable append、fence、去重、access/approval/constraint/sandbox linkage 与 sentinel redaction。

完成门：

- shadow 可在生产装配中开启；默认授权行为未改变。

### B4 — ast 权威授权、fail-closed 矩阵与 rollout

实现：

- [x] `ast` mode 全链路：analyze → 扩展 request → engine 矩阵 → approval/Gateway/sandbox；
- [x] AST attempted 后禁止 legacy fallback、AST failure allow、hardline 错序、raw telemetry 与 legacy Host 接线的结构 scanner + 4 个 mutant tests；
- [x] injected `parse-unavailable` 覆盖 headless/on-request/untrusted/granular（rules enabled/disabled）生产组合矩阵；
- [x] 审批取消/missing requester 变 deny；Bash approval timeout 返回 `approval_expired`；worker parse timeout 独立映射为 `too-complex`；
- [x] managed-process 的 AST 分类复用同一授权路径，不重复执行；现有 attempt/Gateway fence 继续负责 crash/resume/retry；
- [x] rollout 状态记录（resolved config source + digest）。

验证：

- 测试中注入 legacy “allow” 不能覆盖 AST unavailable；
- `ast` 模式 benign/dangerous/too-complex/unavailable 矩阵全绿；
- direct/managed 两条生产路径都由 checker 固定为 canonical resolver，且 authorization/approval receipt 与 final-leaf constraint/sandbox receipt 可在 durable Session events 中关联；
- 默认 mode 保持 shadow/legacy（B5 human gate 前不擅自切 ast）。

完成门：

- `ast` opt-in 可用于生产；默认值不变。

### B5 — 打包、加固、Bun/Node 平台门禁与 human gates

实现：

- [ ] fuzz/property corpus 与 worker leak soak；
- [~] `npm pack` 资产清单、source/dist/packed locator contract 已验证；真实安装后的 npm packed consumer 仍待补；
- [x] Node 22 与 Bun 双平台 worker 运行验证（Bun 失败只影响 Bun 下 AST 可用性，fail-closed）；
- [ ] 操作文档与 rollback runbook（legacy 回退窗口）；
- [~] 标准 PATH + 隔离 home 的 `--bash-analyzer ast` TUI 启动已验证；shadow/ast 下 Bash tool approval/execute 的真实交互仍待补；
- [ ] 独立只读安全审计；修复所有 high/critical 与边界问题；
- [ ] human gate 批准后才把 `ast` 设为默认并记录 rollout commit。

验证命令至少包括：

```bash
npm run check
npm test
npm run build
node scripts/check-execution-boundaries.ts
node scripts/check-runtime-boundaries.ts
node scripts/check-tui-boundaries.ts
node scripts/check-bash-ast-assets.ts
npm pack --dry-run
git diff --check
```

还需运行本专题新增的：

```text
bash-ast walker/worker/authorization 定向测试
shadow 差异 corpus 审阅
worker leak soak
Node/Bun 双平台 worker smoke
标准 PATH PTY（shadow/ast）
```

完成门：

- 自动门禁通过后只可标记 `agent-verified`；
- 用户明确批准 Bash benign/dangerous/too-complex/unavailable 真实终端场景后才可标记 `human-verified`；
- `AGENTS.md`、本计划阶段表和 `development-doc/00-index.md` 同步当前事实；
- 任何未解决的 high/critical 或 fail-open 都阻断完成。

## 7. 测试矩阵

### 7.1 parser/walker

- simple argv/quote/escape；
- pipeline/list/redirect；
- if/loop/subshell；
- assignment/scope；
- wrapper；
- eval/source/exec/trap；
- command/process substitution；
- heredoc；
- Unicode/control 歧义；
- syntax error/unknown node；
- timeout/node bomb/worker crash/WASM missing/hash drift。

### 7.2 authorization

- legacy/shadow/ast；
- managed deny；
- hardline catastrophic deny；
- interactive on-request；
- untrusted；
- approval never；
- granular；
- headless（无 approvalPorts）；
- approval cancel/timeout/missing requester；
- Gateway durable ordering；
- sandbox unavailable；
- 通用 attempt/Gateway retry/replay/resume fence（AST 专项 crash/resume runner 仍属 B5 缺口）；
- 无 AST-to-legacy fallback。

### 7.3 配置/CLI/装配

- mode lattice 全组合与 managed minimum；
- `--bash-analyzer` 合法/非法值、只收窄语义；
- config digest 随来源变化；
- session drain 关闭 analyzer；
- 双 session 池隔离；
- Session prewarm startup bound 与单次 classify ready/parse deadline 分离；
- default SessionDomain durable audit append、dedupe、fence 与 receipt linkage；
- shadow telemetry redaction（sentinel）；
- 三形态 asset locator。

### 7.4 打包/平台/终端

- `npm pack --dry-run` 包含 WASM；
- Node 22 全绿；Bun worker smoke；
- 标准 PATH PTY（shadow/ast）；
- 真实终端 human gate。

## 8. 失败语义

| 失败 | 用户可见状态 | Runtime 行为 |
|---|---|---|
| WASM 缺失/hash 错 | `parse-unavailable` | ast 模式按矩阵 ask/deny，无网络下载 |
| Bash timeout/node budget | `too-complex` | ask/deny，无 legacy fallback |
| worker crash | `parse-unavailable` | terminate/recreate；当前命令 ask/deny |
| analyzer 未装配（legacy 路径） | legacy 行为不变 | `analysis === "unknown"` → 既有 ask |
| approval/Gateway/sandbox 缺失 | deny | 不执行 |
| telemetry port 失败 | 记录有界 diagnostic | 不影响授权决定 |

异步 API 按仓库约定以 `{ ok: false }`、tool `stopReason: "error"` 或 typed result 编码失败，不把可预期失败作为未捕获异常抛到 agent loop。

## 9. 审计与隐私

Bash durable event 只记录：

- command digest；
- analyzer mode/source digest；
- parser/grammar digest；
- result kind/reason code；
- node/time bucket；
- derived access request digest；
- authorization outcome 与 approval receipt id；
- constraint snapshot digest 与 sandbox receipt digest。

不记录 raw command、AST、argv、variable value 或 env。真实执行的既有 tool input/result 审计继续服从当前 redaction 与 artifact policy，本专题不扩大明文保留范围。

## 10. 结构性门禁

`scripts/bash-ast-security-boundaries.ts` 已由 `scripts/check-bash-ast-assets.ts` 调用；`tests/security/bash-ast-boundaries.test.ts` 用 4 个 mutant fixture 固定关键拒绝条件。checker 必须拒绝：

- Bash AST worker 之外加载 WASM parser；
- ast 模式调用 legacy analyzer 作为 fallback；
- AST 失败被 allow；
- managed deny/hardline 在 AST 后被覆盖；
- raw command/diagnostic/env 进入新 telemetry/event；
- legacy Host（`src/cli/runtime-host-security.ts`）新增 bash-ast 导入；
- `assets/tree-sitter` 缺失或 hash 漂移进入 `npm pack` 产物；
- `package.json` 依赖使用 caret/range 版本。

## 11. 提交建议

用户若后续要求实施和“每阶段一个 commit”，建议：

1. `B0: pin bash WASM assets and freeze bash AST contracts`
2. `B1: port bounded bash AST worker and allowlist walker`
3. `B2: make shell authorization mode-aware and fail closed`
4. `B3: wire bash analyzer lifecycle and shadow telemetry into sessions`
5. `B4: authorize shell execution from AST classification`
6. `B5: close packaging, platform and human acceptance gates`

提交消息应说明目的/原因；每次只暂存本阶段显式路径。未获用户明确授权时不 commit、不 push。

## 12. 最终完成定义

只有同时满足以下条件，专题才完成：

- [ ] 官方 Bash WASM、hash/provenance、worker 与硬预算全部落地；
- [ ] allowlist walker、semantic checks 与 differential shadow 全部落地；
- [ ] `ast` 模式对 timeout/unavailable/too-complex fail closed；
- [ ] managed deny 与 catastrophic hardline 始终 unconditional；
- [ ] interactive/never/untrusted/granular/headless 失败矩阵全绿；
- [ ] 无 AST failure -> legacy fallback；
- [ ] `npm run check`、`npm test`、build、pack、boundary checker 全绿；
- [ ] Node/Bun 平台门禁与标准 PATH PTY 全绿；
- [ ] 独立只读审计无未解决 high/critical；
- [ ] Bash 真实终端 human gates 获用户明确批准；
- [ ] 本文件、总索引和 `AGENTS.md` 状态一致。
