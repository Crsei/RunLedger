# RunLedger 包边界与 Workspace 重构计划

> 文档状态：**planned / staged；P0–P4 可执行，P5 的 legacy Host 最终收口受 Runtime 06 R8/R9 阻塞**
>
> 建立日期：2026-09-04
>
> 审计基线：`rollback/before-composer-shape@bd1c36338dcee15ec440a4728a7217e0ee864a2e` 加当前未提交工作树
>
> 文档职责：定义 RunLedger 从单一 npm 包迁移到单向依赖 workspace 的目标边界、迁移顺序、兼容策略和验证门禁；不替代各领域行为计划

## 0. 决策摘要

RunLedger 应采用 workspace 单仓，但**不照搬 oh-my-pi 的包数量和职责切法**。oh-my-pi 的可复用低层 TUI 与产品级 coding-agent 分离，而 RunLedger 当前 `src/tui/**` 已包含 Session、Timeline、权限、工具、工作区和完整交互流程，属于产品 TUI，不是通用组件库。

目标是形成四个内部包和一个产品入口：

1. `@runledger/contracts`：纯 DTO、schema、guard、catalog 和 port；
2. `@runledger/ai`：模型、Provider、API transport、认证与 catalog；
3. `@runledger/core`：Agent、Session Runtime、Security、Storage、Process、Workspace、Worktree、Extension 和 LSP 的单一 authority 边界；
4. `@runledger/product-tui`：完整产品 TUI；
5. `runledger`：CLI、bin、auth gateway 和唯一生产 composition root。

执行原则是**先在当前单包内消除反向依赖，再创建物理 workspace**。禁止把当前强连通依赖图直接搬成多个循环依赖的 `package.json`。

推荐顺序：

```text
P0  冻结当前依赖图、公共面和生产 authority
  -> P1  建立 current contracts，切断 storage -> tui
  -> P2  收拢 AI 边界，消除 auth -> storage 与 auth <-> providers
  -> P3  用 ports 消除 core 内跨域反向依赖
  -> P4  依次物理抽取 contracts -> ai -> product-tui -> core -> app
  -> P5  Runtime 06 R8 接受后执行 R9，删除 legacy Host 与兼容公共面
  -> P6  稳定后评估是否需要更多独立包
```

### 2026-09-17 先行拆包：`packages/collab-web`

首次创建物理 workspace 包 `packages/collab-web`（`@runledger/collab-web`，`private: true`），把 Plan 15 浏览器侧（web DTO、React SPA、静态壳、构建脚本、包内测试）从根包移出，形态对齐参考实现 oh-my-pi `packages/collab-web`。依赖方向为 app → 包，包内零 RunLedger 内部依赖，因此不引入循环，也不与 P1–P3 的收口目标冲突。

- 根 `package.json` 增加 `workspaces: ["packages/*"]`、`dependencies["@runledger/collab-web"]: "*"` 与 `bundleDependencies: ["@runledger/collab-web"]`；后者使 `npm pack` 把包嵌入 tarball 的 `node_modules/@runledger/`，保证仓库外安装的 `runledger` 仍能解析 `@runledger/collab-web/contracts`。
- 新增门禁：`check:collab-web`（包构建 + SPA/测试类型检查 + `types: []` 浏览器 consumer）、`check-package-boundaries` 的 `deep-package-import`/`package-escape`/`package-contract-dependency` 三条规则、`check-typecheck-coverage` 的 `packages/*` 覆盖检查；包内测试纳入 test inventory 的 `packages/*/test/**/*.test.ts` 规则。
- 服务端 `src/web/**` 仍是 app 层的薄 HTTP 桥，不随本次迁移；是否继续下沉到 `packages/core` 依赖其只读端口，留待 P3/P4 决定。

证据见 Plan 15 §9.5。

### 2026-09-05 审计修复进展（单包阶段）

本次沿 P0/P1 推进，未创建物理 workspace，P2–P6 不据此标记完成：

- `src/contracts/settings/tui-preferences.ts` 成为偏好合同定义位置；storage 直接依赖合同，TUI 原路径保留兼容 re-export，根包增加明确的 `./contracts` 出口。
- 文本宽度/ANSI 折行纯函数抽到 `src/tui/text-layout.ts`；内部 modal 从定义模块导入，消除 primitives/editor-height 与 barrel/modal 的 value cycles。
- Kimi OAuth 的设备 ID 持久化改为从 canonical layout 注入，消除 auth → storage；这里只完成这一反向依赖，P2 的其他 AI 边界工作未完成。
- `check:package-boundaries` 拒绝 auth → storage、storage → tui、TUI 内部 value barrel import、TUI value cycle 与 contracts 越界依赖；新增 Node/Bun/scripts/examples consumer coverage/typecheck 门禁。
- `build:contracts` 可独立编译偏好合同；`build:typescript` 与 `build:native` 明确分开，完整产品 `build` 仍组合 native、TypeScript、assets、manifest。根 package dependencies、wildcard compatibility exports 与完整产品 composition 尚未物理拆分。
- 各项 fresh 验证与剩余边界统一记在 [审计与修复记录](../audit/2026-09-05-runtime-and-structure.md)。Runtime 06 R8/R9、人工和跨平台门禁继续生效。

## 1. 文档权威与范围

### 1.1 上位事实入口

- 文件内模块化与超大文件拆分：[`12-bloated-code-modularization-refactor-plan.md`](12-bloated-code-modularization-refactor-plan.md)
- Session Owner、生产 authority 与 legacy Host 删除门禁：[`../runtime/06-session-owner-runtime-replacement-plan.md`](../runtime/06-session-owner-runtime-replacement-plan.md)
- Runtime 公共合同：[`../runtime/04-governed-agent-harness-runtime-plan.md`](../runtime/04-governed-agent-harness-runtime-plan.md)
- TUI 当前架构：[`../tui/00-overview.md`](../tui/00-overview.md)
- TUI 与 Session Runtime 接线：[`01-tui-session-runtime-integration-repair-plan.md`](01-tui-session-runtime-integration-repair-plan.md)
- Provider 迁移与特殊协议：[`../providers/02-oh-my-pi-provider-port-execution-checklist.md`](../providers/02-oh-my-pi-provider-port-execution-checklist.md)
- Test runner 与证据口径：[`../test/01-test-strategy-and-runner-hardening-plan.md`](../test/01-test-strategy-and-runner-hardening-plan.md)

当本文与领域权威发生冲突时，领域行为、schema、wire、authority 和验收状态以对应上位文档及当前代码/tests 为准；本文只拥有包边界与迁移编排。

### 1.2 纳入范围

- 根 `package.json`、npm exports、TypeScript build graph 和 package-local dependencies；
- `src` 一级领域目录及根级 models/images/OAuth/session-resource 文件；
- tests、scripts、examples、native loader 与生成器在目标 workspace 中的归属；
- 兼容 facade、旧 import path 和包级 boundary checks；
- 拆包过程中的 RED/GREEN/Stable Green、停止规则与回退策略。

### 1.3 不纳入范围

- 修改 Session Store schema、Runtime protocol、Provider wire、CLI 参数或 TUI 视觉行为；
- 新增 Provider、工具、设置、权限模式或产品功能；
- 在 Runtime 06 R8 未接受前删除 legacy Host；
- 为了“看起来像 monorepo”而拆出没有独立职责的 `utils`、`common`、`shared` 包；
- 同时引入新的包管理器或发布平台。首版沿用 npm workspaces、现有 lockfile 和 Node/Bun 版本约束；
- 自动把内部包发布到 registry。是否公开发布必须另立兼容性和版本策略。

## 2. 当前结构事实

### 2.1 单包承担全部产品职责

根 `package.json` 当前同时定义：

- `runledger` CLI bin；
- 根 SDK barrel；
- `api/*`、`auth/*`、`providers/*`、`storage/*`、`utils/*` wildcard exports；
- Provider SDK、OpenTUI、MCP、SQLite/lock、PTY、Tree-sitter 和平台 native optional packages；
- 全仓 build、test、boundary 和 legacy Host runner。

因此依赖安装、构建、公共 API 与产品生命周期全部耦合在同一个 package manifest 中。

### 2.2 当前规模快照

本次审计排除 `*.generated.ts` 与 `*.models.ts` 后，`src` 有 817 个手写 TypeScript 文件、约 132,768 行。主要领域为：

| 当前领域 | 文件数 | LOC | 主要职责 |
|---|---:|---:|---|
| `runtime` | 205 | 36,457 | Agent、Session Owner、Session Runtime、protocol、process、trace、tools |
| `tui` | 167 | 25,512 | OpenTUI renderer、timeline、interactive workflows、完整产品 UI |
| `cli` | 46 | 11,915 | 产品命令、Session Client、composition、legacy Host 安全窗口 |
| `storage` | 54 | 11,204 | SQLite Session Store、process/storage adapters、settings/auth |
| `api` | 61 | 10,173 | Provider wire protocol、transport、stream mapping |
| `security` | 62 | 8,794 | Permission、approval、policy、sandbox、ExecutionGateway composition |
| `providers` | 80 | 7,434 | Provider factories、catalog 和动态配置 |
| `extensions` | 49 | 7,330 | MCP、Skill、Hook、Plugin lifecycle |

这些数字是 2026-09-04 的工作树快照，只用于确定迁移优先级；实施时必须重新生成。

### 2.3 当前 value-import 强连通关系

忽略 `import type` 后，当前主要双向依赖仍包括：

```text
(root) <-> api/providers/runtime
auth <-> providers
extensions <-> runtime
runtime <-> security/storage/workspace/worktree
security <-> storage
workspace <-> worktree
storage -> tui -> runtime -> storage
```

其中：

- TUI 主要单向消费 Runtime/Security/Workspace；唯一明显的下层反向边是 `src/storage/tui-preferences.ts -> src/tui/preferences/types.ts`；
- `src/auth/oauth/kimi-code.ts -> src/storage/paths.ts` 使 AI authentication 依赖产品 storage；
- `auth -> providers` 与 `providers -> auth` 使 AI 内部无法按 auth/provider 两个物理包独立；
- Runtime/Security/Storage/Workspace/Worktree/Extensions 共同参与 Session authority，当前不具备分别成包的条件。

## 3. 与 oh-my-pi 的取舍

采用的原则：

- workspace package 必须具有单向依赖、明确公共入口和可独立验证的职责；
- native 平台包继续保持叶子发行物；
- AI/Provider 与产品 Runtime 分离；
- 产品 composition root 位于最上层。

不采用的形态：

- 不复制 oh-my-pi 的全部包数量；
- 不把 RunLedger 的完整 `src/tui` 当作低层 `pi-tui`；
- 不在没有第二个消费者前建立 `tui-kit`；
- 不按现有一级目录机械地创建 `security`、`storage`、`workspace`、`worktree`、`extensions` 等互相循环的包。

判断一个子域是否继续独立成包，至少要同时满足：

1. 有稳定且窄的公共 API；
2. 可以不使用目标包私有 import；
3. 与其他内部包的 value-import 图无环；
4. 有独立测试、构建或发布生命周期；
5. 拆分不会复制 authority、writer、gateway 或缓存状态。

## 4. 目标目录结构

```text
RunLedger/
├── apps/
│   └── runledger/
│       ├── src/
│       │   ├── cli/                 # argv、命令与产品生命周期
│       │   ├── composition/         # 唯一 production composition root
│       │   └── auth-gateway/        # 暂随主产品，独立部署前不拆包
│       ├── bin/
│       └── package.json             # name: runledger
│
├── packages/
│   ├── contracts/
│   │   ├── src/
│   │   │   ├── ai/                  # message/model/tool 基础 DTO
│   │   │   ├── session/
│   │   │   ├── process/
│   │   │   ├── security/
│   │   │   ├── workspace/
│   │   │   └── settings/
│   │   └── package.json
│   │
│   ├── ai/
│   │   ├── src/
│   │   │   ├── api/
│   │   │   ├── auth/
│   │   │   ├── providers/
│   │   │   ├── catalog/
│   │   │   └── internal/
│   │   └── package.json
│   │
│   ├── core/
│   │   ├── src/
│   │   │   ├── domain/              # Session、ledger、process 状态机
│   │   │   ├── application/         # AgentLoop、SessionRuntime
│   │   │   ├── ports/               # storage/execution/model/workspace ports
│   │   │   └── adapters/
│   │   │       ├── sqlite/
│   │   │       ├── security/
│   │   │       ├── process/
│   │   │       ├── workspace/
│   │   │       ├── worktree/
│   │   │       ├── extensions/
│   │   │       └── lsp/
│   │   └── package.json
│   │
│   └── product-tui/
│       ├── src/
│       │   ├── application/
│       │   ├── interactive/
│       │   ├── timeline/
│       │   ├── components/
│       │   └── opentui/
│       └── package.json
│
├── native/
│   └── syntax-highlighter/
├── npm/
│   └── syntax-highlighter-*/
├── scripts/
├── development-doc/
├── package.json                     # private workspace orchestrator
└── tsconfig.base.json
```

测试默认与包职责同置：`packages/<name>/test/**`、`apps/runledger/test/**`。跨包、真实 CLI/TTY、migration 和 production composition 测试保留在根 `tests/integration/**`，直到 runner 能明确收集并报告 package ownership；不在同一阶段机械移动全部测试。

## 5. 目标依赖图

箭头表示“左侧依赖右侧”：

```text
runledger app ────────────────> @runledger/ai ───────> @runledger/contracts
      │
      ├──────────────────────> @runledger/core ─────> @runledger/contracts
      │
      └──> @runledger/product-tui ──> @runledger/core
                         └──────────> @runledger/contracts
```

附加规则：

- `contracts` 不依赖任何 RunLedger 内部包；
- `ai`、`core` 互不依赖；app 通过 `ModelExecutionPort` 将 AI adapter 注入 core；
- `product-tui` 可以依赖 core 的稳定 client/application surface，但 core 不得依赖 TUI；
- app 可以依赖全部内部包，任何内部包都不得依赖 app；
- native syntax-highlighter 平台包是低层叶子发行物，由 TUI native adapter 或 app composition 加载，不反向依赖产品包；
- 禁止通过相对路径跨 package root；禁止 deep import 未列入 package exports 的实现文件。

## 6. 各包职责与依赖

### 6.1 `@runledger/contracts`

允许内容：

- immutable DTO、TypeBox schema、parse/guard；
- Runtime/Session/process/workspace/security IDs 与 envelopes；
- passive state、receipt/ref、catalog；
- dependency-inversion ports；
- TUI preferences document 等跨层数据合同。

禁止内容：

- `node:fs`、`node:net`、`node:http`、`node:child_process`；
- `fetch()`、环境变量、用户目录读取；
- SQLite、PTY、OpenTUI、Provider SDK；
- mutable singleton、缓存、transport client/server 或 composition。

首版外部依赖只允许 `typebox`。当前 `src/runtime/contracts/public.ts` 仍重导出 legacy Host contracts；因此应先新增不含 Host 的 current surface，旧路径作为兼容 facade 保留到 R9。

### 6.2 `@runledger/ai`

归属：

- 当前 `src/api/**`、`src/auth/**`、`src/providers/**`、`src/compat/**`；
- 根级 `models*`、`images*`、`oauth.ts`、`bun-oauth.ts`、`bedrock-provider.ts`；
- model generator 的 source、metadata 与 emitter；
- Provider/API 专用 stream、proxy、headers、retry、diagnostic helpers。

外部依赖由该包独占：Anthropic、OpenAI、AWS Bedrock、Google、Mistral、Smithy、HTTP proxy 等 SDK。

边界修复：

1. 将 Provider identity/model metadata 从 Provider 实现中下沉到 AI 内部 contract/spec 层，消除 `auth -> providers`；
2. `providers` 可消费 auth contract/resolve surface，但 auth implementation 不得反向消费 provider factory；
3. Kimi device ID path 通过显式 option/port 注入，或成为 AI 自有配置 locator，消除 `auth -> storage`；
4. `src/types.ts` 拆成 AI 基础合同与 provider-option augmentation；禁止基础 message/model 类型反向引用 API 实现。

### 6.3 `@runledger/core`

首版将 Runtime、Security、Storage、Process、Workspace、Worktree、Extension 和 LSP 保持在同一个物理包内，因为它们共同参与 Session authority 和当前强连通分量。

内部方向：

```text
domain + ports
      ↑
application
      ↑
adapters
```

更准确地说，application 只依赖 domain/contracts/ports；adapter 实现 ports；最终 composition 位于 app。禁止 application 直接导入 SQLite、OpenTUI、Provider SDK 或 CLI。

至少建立以下窄 port：

- `SessionEventStorePort`
- `OwnerFenceStorePort`
- `SecurityDecisionPort`
- `ExecutionGatewayPort`
- `ManagedProcessPort`
- `WorkspaceLocatorPort`
- `WorktreeLeasePort`
- `ExtensionRuntimePort`
- `ModelExecutionPort`

这些 port 不能引入第二套状态。Session Owner、durable writer、ExecutionGateway、process manager 与 recovery barrier 仍各自只有一个生产实例和一个明确 owner。

### 6.4 `@runledger/product-tui`

归属当前完整 `src/tui/**`，不是通用 UI toolkit。它负责：

- Session/Timeline projection；
- input、overlay、approval、permissions、settings 与 workflow；
- OpenTUI component runtime 与 native highlight presentation；
- TUI application state 和 effect dispatch。

禁止：

- 成为 durable truth；
- 直接写 SQLite/settings/auth；
- 建立第二套 Session/permission/process authority；
- 被 core/storage/security 反向引用。

若未来出现第二个真正消费者，再从 `product-tui` 中提取纯 renderer/component primitives；当前不建立 `@runledger/tui-kit`。

### 6.5 `runledger` app

负责：

- `bin/runledger.js`、argv、命令和退出码；
- SessionStore/Owner、Security、AI、Extension、Workspace 和 TUI 的生产组装；
- auth gateway 和 migration CLI；
- optional native package 选择；
- 兼容旧 `runledger` npm exports 的 facade。

app 是唯一允许同时依赖 AI、core 和 product-tui 的位置。任何跨领域 bridge 都必须在 app 中显式构造，不能隐藏在全局 singleton 或包级 side effect 中。

## 7. 当前目录到目标包的映射

| 当前路径 | 第一目标 | 说明 |
|---|---|---|
| `src/runtime/contracts/**`、protocol/identity 等登记的纯合同 | `packages/contracts` | 先建立 current surface；legacy Host 暂不进入 clean package |
| `src/tui/preferences/types.ts` | `packages/contracts/src/settings` | 第一批切断 `storage -> tui` |
| `src/api/**` | `packages/ai/src/api` | 保持 transport/wire fixtures |
| `src/auth/**` | `packages/ai/src/auth` | 先去除 storage/provider 反向依赖 |
| `src/providers/**` | `packages/ai/src/providers` | generated catalog 仍只由 generator 更新 |
| 根级 models/images/OAuth 文件 | `packages/ai` | 根 barrel 最终只做兼容重导出 |
| `src/runtime/**` 非纯合同 | `packages/core/src/domain|application` | Host 路径按 R9 另行删除 |
| `src/security/**` | `packages/core/src/adapters/security` | authority 不拆包 |
| `src/storage/**` | `packages/core/src/adapters/sqlite|storage` | durable writer 不拆分 |
| `src/workspace/**`、`src/worktree/**` | `packages/core/src/adapters` | 先以 ports 消除双向依赖 |
| `src/extensions/**`、`src/lsp/**` | `packages/core/src/adapters` | Session-scoped lifecycle 仍由 core application 管理 |
| `src/tui/**` | `packages/product-tui` | 先消除下层反向 import |
| `src/cli/**`、`src/auth-gateway/**` | `apps/runledger` | composition root；legacy 文件等待 R9 |
| `native/syntax-highlighter`、`npm/syntax-highlighter-*` | 保持原位 | 已有独立平台发行边界，不重复搬迁 |
| 浏览器侧（原 `web/src/**`、`src/contracts/web/**`、web 构建脚本与浏览器测试） | `packages/collab-web` | 2026-09-17 已建包：形态对齐参考实现 oh-my-pi `packages/collab-web`；服务端 `src/web/**` 暂留 app 层（薄 HTTP 桥，随 core 拆包再评估），见 Plan 15 §9.5 |

## 8. `utils` 处置规则

不创建 `@runledger/utils`。当前 helper 按 owner 归位：

- API 专用：`abort-signals`、`deferred-tools`、`diagnostics`、`error-body`、`estimate`、`fetch-provider-proxy`、`hash`、`headers`、`json-parse`、`provider-env`、`provider-fetch-context`、`sanitize-unicode`、proxy helpers、`uuid` -> `@runledger/ai/internal`；
- `event-stream` -> AI stream contract 或 `contracts/ai`，取决于其最终是否只含无 I/O 的通用流原语；
- `shell`、`validation` -> core platform/application 内部；
- `typebox-helpers` -> contracts internal；
- `overflow`、`retry`、`text` 等只有在两个以上 package 有真实 value consumer 且语义稳定时才进入 contracts/internal，否则跟随唯一 owner。

禁止创建不表达领域语义的 `helpers.ts`、`common.ts`、`shared.ts` 来绕过依赖门禁。

## 9. 公共 API 与兼容策略

### 9.1 当前风险

根 package wildcard exports 允许消费者绕过领域入口，直接依赖 storage 和 utils 实现。物理拆包前必须获得 exact consumer inventory，不能仅从仓库内 import 推断没有外部使用者。

### 9.2 迁移策略

1. 每个新 package 只提供显式 exports；内部目录默认不导出；
2. 原 `runledger` package 在过渡期保留 facade，重导出到新 package；
3. 为每个旧 export 建立 `retained | deprecated | internalized | R9-delete` manifest；
4. 兼容 facade 只转发，不复制实现、不持有缓存、不产生 side effect；
5. `check:contract-consumers` 扩展到所有新 public entry；
6. 下一 major/明确内部化批次才删除 wildcard exports；本计划不擅自承诺公开 semver。

`runledger/runtime/contracts` 的特殊顺序：

- P1 新增不含 Host 的 `@runledger/contracts`；
- 旧入口继续组合 current + legacy re-export；
- Runtime 06 R9 后删除 Host export；
- 最后让旧入口成为单纯的 `@runledger/contracts` compatibility alias。

## 10. 分阶段实施计划

### P0：基线、行为表征与依赖冻结

任务：

1. 记录 branch、HEAD、dirty paths、Node/Bun/npm 版本和 lockfile digest；
2. 用 TypeScript AST 生成 value-import graph，独立记录 type-only edge；
3. 冻结当前 package exports、bin、scripts 和外部 dependency ownership；
4. 为根 barrel、contracts、AI、Runtime client 和 TUI adapter 建立 consumer fixtures；
5. 增加 architecture manifest 和 DAG check，先以现状 allowlist 表达已知债务；
6. 记录所有跨目标包 deep import，并逐项指定 owner 和迁移阶段。

RED/Green：

- RED：新 DAG check 能稳定报告已知反向边；
- GREEN：baseline allowlist 精确匹配当前债务且禁止新增边；
- Stable Green：`npm run check`、`npm test`、`npm run build` 与 test inventory 完整通过，或记录与本计划无关的精确既有失败。

退出门禁：依赖图可重复生成；没有未登记的跨边界 value import；没有修改生产行为。

### P1：current contracts 与 TUI preference 解耦

任务：

1. 从 `runtime/contracts/public.ts` 中标定 current 与 legacy exports；
2. 新建 current contracts 入口，只包含纯 DTO/schema/guard/catalog/ports；
3. 将 TUI preference document、default 和 parse contract 移到 `settings` contract；storage 只依赖该 contract；
4. TUI 经相同 contract 消费 preference，不再拥有被 storage 引用的类型；
5. 增加 contracts 禁 I/O、禁内部实现 import 和 public-surface snapshot。

RED：boundary test 证明 `storage -> tui` 被禁止，旧代码先失败。

GREEN：value-import 图中 core/storage 不再指向 TUI，旧 import facade 仍通过 consumer compile。

Stable Green：contracts、storage preference、TUI settings focused tests和全量 gates 通过。

### P2：AI 边界收拢

任务：

1. 拆分 `src/types.ts` 的基础类型与 API option augmentation；
2. 建立 provider spec/auth contract，消除 `auth <-> providers`；
3. 注入 Kimi device/config locator，消除 `auth -> storage`；
4. 将 API 专用 utils 收入 AI internal；
5. 固定 model generator 输入、输出树和 digest；
6. 建立 AI 单一 public barrel，保持旧根/API/provider exports 的兼容 facade。

RED：为当前循环边和非法 storage import 建立结构测试；Provider fixture、OAuth、abort、proxy、stop reason 和错误 body characterization 在移动前通过。

GREEN：AI 只依赖 contracts；Provider/auth 内部图无环；生成输出等价。

Stable Green：AI focused、generator、全量 check/test/build 通过。

### P3：core 内部 ports 与 authority 收口

任务：

1. 将 Runtime 对 Storage/Security/Workspace/Worktree/Extension/LSP 的调用收敛为窄 port；
2. 将共享 DTO 从实现目录移动到 contracts 或 core ports；
3. adapter 只实现 port，不反向调用 application 私有对象；
4. `ModelExecutionPort` 由 app 注入，core 不直接 import AI Provider/API implementation；
5. Session composition 仍是唯一 authority，不创建测试外 production fallback；
6. 更新 execution/storage/session-owner boundary scripts。

建议的内部处理顺序：

```text
storage/session-store
  -> security/execution gateway
  -> process
  -> workspace/worktree
  -> extensions/lsp
  -> agent/model port
  -> session-runtime composition
```

RED：每个 port 先用既有实现的 characterization/conformance suite 固定 fence、receipt、recovery 和错误语义。

GREEN：application 不直接 import adapter；双向边逐组归零。

Stable Green：Session Owner、storage、security、process/PTY、extension、worktree、LSP、candidate 和全量 gates 通过。

### P4：物理 workspace 迁移

物理移动顺序固定为：

```text
contracts -> ai -> product-tui -> core -> runledger app
```

每次只移动一个 package：

1. 创建 package manifest、explicit exports 和 package-local tsconfig；
2. 更新 TypeScript project references/build order；
3. 将跨 package 相对 import 改为 package public import；
4. 保留旧入口 compatibility facade；
5. 运行 package-local 和全量 gates；
6. 独立提交后才开始下一个 package。

根 package 只保留 workspace orchestration。应用 package 继续名为 `runledger` 并拥有 bin；内部包首版保持 `private: true`，除非另有发布授权。

首版依赖归属：

| 包 | 主要外部依赖 |
|---|---|
| contracts | `typebox` |
| ai | Anthropic/OpenAI/AWS/Google/Mistral/Smithy、HTTP proxy、`node-fetch`、`partial-json` |
| core | MCP SDK、OpenTelemetry、`node-pty`、`proper-lockfile`、Tree-sitter |
| product-tui | `@opentui/core`、`string-width`、`strip-ansi` |
| runledger app | 四个内部包、平台 native optional packages；不重复声明其实现依赖 |

### P5：legacy Host R9 收口

前置条件：Runtime 06 R6.5、R8、三平台、独立审计和 human acceptance 按其权威计划接受，并明确授权 R9。

任务：

1. 按 Runtime 06 §9.3 删除 legacy Host source、storage、scripts、native helper、commands 和 tests；
2. 从旧 contracts/public barrels 删除 Host contracts；
3. 清空 legacy consumer allowlist；
4. 删除 legacy build manifest 和 runner；
5. 保留受限 migration archive/source tooling，不把数据物理删除混入代码删除；
6. 重新收紧 package exports 和 dependency DAG。

R8 未接受时 P5 状态始终为 `blocked_by_runtime_06_r9_not_authorized`。不得借 workspace 重构提前删除安全窗口，也不得增加自动 fallback。

### P6：可选的二次拆包评估

只有 P4/P5 稳定后才评估：

- `@runledger/sqlite-store`
- `@runledger/security`
- `@runledger/extensions`
- `@runledger/workspace`
- `@runledger/tui-kit`
- 独立 auth-gateway app

每一项必须重新满足 §3 的五个独立成包条件。默认决策是“不拆”；不能以目录已存在作为成包理由。

## 11. 测试与验证矩阵

| 层级 | 必须验证 |
|---|---|
| contracts | schema/guard fixtures、public surface、consumer compile、无 I/O/side effect |
| AI | provider wire fixtures、auth/OAuth、abort/timeout/proxy、usage/stop reason/error body、generator digest |
| core | hash chain、owner fence、attempt/receipt、recovery barrier、Security final leaf、process/PTY、workspace/worktree、extension lifecycle |
| product-tui | reducer/projector/effect/frame 等价、OpenTUI native tests、streaming prefix、overlay/focus/scroll |
| app | argv/exit code、fresh/open/resume/fork、migration、production composition、standard PATH CLI/TTY |
| workspace | DAG、无 deep import、exports consumer、package build order、pack contents、跨平台 required gates |

每阶段至少运行：

```bash
git status --short
git diff --check -- <explicit-paths...>
npm run check
npm test
npm run build
```

按阶段追加：

- P1：contract consumer + storage preference + TUI settings；
- P2：Provider fixture/proxy/OAuth + `npm run generate-models` 后生成树 diff；
- P3：Session Owner candidate、Security、真实 pipe/PTY、Extension/Worktree/LSP；
- P4：每包 build/test、根 build graph、bin、pack dry-run；
- P5：Runtime 06 R9 全部自动、标准 PATH、独立审计与人工门禁。

自动化 unit/native/tmux 证据不能填写为 human-verified。dark/light、真实鼠标、真实 IME、跨平台和完整 standard-PATH fault rehearsal 继续单独记录。

## 12. 提交与工作树协议

- 实施前重新记录当前 dirty paths；来源不明的修改不得覆盖、stash、reset 或跨分支切换；
- 当前审计时 `src/api/transform-messages.ts`、`src/cli/main.ts`、`src/cli/session-model-router.ts`、`src/runtime/session-runtime/domain.ts`、多个 TUI timeline/interactive 文件及对应 tests 已有其他任务修改；相关阶段应使用独立 worktree 或等待原任务收口；
- 每阶段一个或多个小提交，只包含该 package/boundary、直接测试和必要文档；
- 逐路径暂存，不使用 `git add -A`、`git add .`、`git commit -a`、stash 或破坏性 reset；
- 用户未明确要求时不 commit、不 push、不删除 branch/worktree；
- 兼容 facade 与新实现必须在同一阶段提交，避免中间提交破坏 consumer。

## 13. 停止规则

出现以下任一情况立即停止当前阶段：

1. 必须改变 Runtime schema/wire、SQLite format、Provider wire、CLI/TUI 可观察行为才能继续；
2. 新旧路径必须双写、共享可变 singleton、复制 authority 或运行时 fallback 才能通过；
3. 目标 package 产生内部包循环或需要 deep import 其他包的私有实现；
4. contracts 需要 raw I/O、环境读取或具体 adapter；
5. Security/Process 拆分后无法证明 final leaf、attempt、receipt、Trace 或 recovery 顺序；
6. 目标路径存在其他任务未提交修改且无法安全避让；
7. characterization test 在旧实现上不稳定；
8. focused tests 通过但完整 check/test/build 出现本阶段相关失败；
9. P5 的 Runtime 06 R8/R9 准入或 human acceptance 未闭合。

停止时不回滚用户工作。保留已验证的小提交或明确的未提交 diff，记录精确 blocker，再选择修复、缩小范围或另立行为变更计划。

## 14. 回退策略

- P0–P3 只改变代码依赖和 facade，不做用户数据迁移；按阶段 revert 即可回退；
- P4 每次只移动一个 package，旧公共入口继续重导出；若 package build/consumer 失败，回退该 package 的独立提交；
- 禁止用 dual production path 作为回退；生产行为回退必须通过版本/提交 revert；
- P5 使用 Runtime 06 定义的 offline archive/restore 边界，不让新 Runtime 自动读取 legacy archive；
- 任何物理删除用户数据的动作都不属于本计划。

## 15. 状态表

| 阶段 | 状态 | 前置条件 | 完成证据 |
|---|---|---|---|
| P0 基线与依赖冻结 | planned | 当前工作树审计 | graph、exports、consumer、完整基线 |
| P1 current contracts/TUI preference | planned | P0 | storage 不再依赖 TUI；contract gates |
| P2 AI 边界 | planned | P1 | AI 只依赖 contracts；provider/auth/generator gates |
| P3 core ports/消环 | planned | P1、P2 model port | authority invariants + core DAG + candidate |
| P4 物理 workspace | implementing | P1–P3 无目标包循环（`packages/collab-web` 为该原则的先行样本，其余仍 planned） | 已建 `packages/collab-web`：包内零内部依赖、根 exports/workspaces/bundleDependencies 接线、边界与类型覆盖门禁、pack 安装与真实 CLI 验证见 Plan 15 §9.5；完整 P4 仍需其余包迁移 |
| P5 legacy Host R9 | blocked | Runtime 06 R8 accepted + R9 authorized | Runtime 06 R9 + full/CLI/TTY/human gates |
| P6 二次拆包评估 | planned/optional | P4/P5 稳定窗口 | 独立成包五项条件逐包成立 |

状态只能使用 `planned`、`implementing`、`partial`、`blocked`、`implemented`、`accepted`。历史门禁不作为新阶段 fresh evidence。

## 16. 最终 Definition of Done

只有以下条件全部成立，本计划才能标记为 `accepted`：

1. workspace 形成 §5 的单向 DAG，不存在内部 package cycle 或未登记 deep import；
2. app 是唯一 production composition root；内部包不依赖 app；
3. contracts 无 raw I/O、环境读取、mutable singleton 或具体 adapter；
4. AI 与 core 解耦，由 app 通过 port 注入；
5. core/storage/security 不依赖 product-tui；TUI 不拥有 durable authority；
6. Session Owner、durable writer、ExecutionGateway、process manager 与 recovery barrier 没有复制、双写或 fallback；
7. 原公开 import 有明确 retained/deprecated/internalized/R9-delete 结论和 consumer 证据；
8. legacy Host 仅在 Runtime 06 R9 授权后删除，migration archive 边界保持不变；
9. package-local 与全量 check/test/build、standard PATH CLI/TTY、required platform 和人工门禁均有 fresh evidence；
10. `development-doc/00-index.md`、Plan 12、Runtime 06、TUI/Provider/Test 权威文档与最终代码事实一致。

## 17. 首批建议执行单元

首个实现批次应严格限制为：

1. P0 dependency/exports manifest 与禁止新增债务的静态门禁；
2. P1 current contracts 入口；
3. TUI preference DTO/default 移入 neutral settings contract，切断 `storage -> tui`；
4. 兼容 import 保持不变；
5. focused + full gates 和文档状态回写。

首批不创建 npm workspace、不移动整个 `src/tui`、不调整 Provider、不处理 legacy Host。这样可以先验证边界方法和兼容策略，再开始成本更高的目录迁移。
