# Plan 20：oh-my-pi 可实现工具移植

## 0. 目标、范围与完成顺序

本计划承接 [Plan 19](19-omp-tool-surface-expansion-plan.md) 已完成的 `read` archive/sqlite 分支和 `ask`。目标是将 2026-09-18 复核后仍可在 RunLedger authority 内落地的五类能力，按下面顺序接入标准 Session Owner：

1. 命名 `checkpoint` / `rewind`（新会话 fork/switch）。
2. `read` 的 DOCX、PPTX、XLSX、EPUB 转换分支。
3. 受治理的 `image_gen`。
4. 只读 `github` 查询。
5. canonical user root 的 `manage_skill`。

每阶段先完成对应文件、定向测试和 production composition，才进入下一阶段；不以 schema 或 unit fixture 代替真实 owner 接线。本文是这些新文件和接线的编排入口；Session Owner、Extension 与 Provider 的公共 contract 仍归其原专题。

## 1. 上游参照与不可移植边界

| RunLedger 能力 | oh-my-pi 参照 | 本计划的裁定 |
|---|---|---|
| `checkpoint` / `rewind` | `packages/coding-agent/src/tools/checkpoint.ts` | 保留命名标记与目标说明；`rewind` 只能 fork 到新 session 并由 driver 切换，绝不更新或删除已有 session events。 |
| Office/EPUB `read` | `src/markit/{registry,types,converters/{docx,pptx,xlsx,epub}}.ts`、`utils/{xml,docx,turndown,ar}` | 只移植 Buffer → Markdown 的纯 TS 路径；不取 PDF converter、不写提取图片、不经 raw fs。 |
| `image_gen` | `src/tools/image-gen.ts` | 保留结构化 prompt 和 image result；Provider 请求改由 `ExecutionEnv.network`，不沿用上游 provider-specific raw HTTP。 |
| `github` | `src/tools/{gh,gh-common,gh-search,gh-view}.ts` | 仅 `repo_view`、`file_read`、五类 search；不含 PR 创建/checkout/push 与 `run_watch` 轮询。 |
| `manage_skill` | `src/tools/manage-skill.ts` | 仅管理 `<home>/state/extensions/user/skills/<name>/SKILL.md`；不改项目、外部兼容目录、plugin、trust receipt 或 provider settings。 |

以下仍不在本计划：`ast_grep` / `ast_edit`（Plan 16 的用户裁定与 native grammar 前置）、PDF、browser/computer、`eval` / `run-code`、Memory/`learn`、`yield`/hub，以及仅供工具实现内部使用的 `read-summary`、`shell-tokenize`、`tool-timeouts`、`render-utils`。

## 2. 冻结的横切约束

- 标准 CLI 的 authority 是 `src/cli/embedded-session-runtime.ts` → `src/runtime/session-runtime/domain.ts`；不得向旧 Resident Host 复制生产 fallback。
- 文件读取走 `ExecutionEnv.fs`；网络走 `ExecutionEnv.network` 并带固定 `principal`；写 user skill 只能通过 `NodeExtensionStorage` 的 canonical-home containment。
- Tool schema、capability claim 与 Harness Profile 一起进入组成 receipt。新工具只装配 `standard`；`minimal@1` 和 Plan Mode 的冻结 allowlist 不因本计划扩大。
- 输出、远端响应和生成图片不得写入 workspace；Trace 的 recording/overflow 按现有用户 settings 处理，不把本计划声称为远程 exporter。
- 新文件保持 TypeScript strict、顶层 `.ts` import、无 `any`；转换器与 API input 先有尺寸/项数/深度上限，再调用底层实现。

## 3. 阶段 I：命名检查点与 fork rewind

### 3.1 语义

`checkpoint({ goal })` 在当前 durable、stable assistant boundary 创建一条 named-checkpoint 事实：名称/goal、source session、boundary sequence/hash、创建者 generation、goal 摘要 digest。它不是 `session_checkpoints` cache，也不是工作区或 Git snapshot。

`rewind({ checkpoint, report })` 只解析当前 session 的命名 checkpoint，并发送不可伪造的 reverse-request handoff。TUI driver 调用 `session.rewind`，它在一个 SQLite 事务内以 `session.fork({ throughSequence })` 的历史投影创建目标、写入目标 report 和源端审计，再切到新 session；失败、取消、stale head 或不稳定边界均不改变源 session。headless 没有 handler必须立即 typed failure，禁止 polling。

### 3.2 实现文件

| 文件 | 变更 |
|---|---|
| `src/runtime/session-runtime/named-checkpoint.ts` | schema、invariant digest、stable-boundary 校验和 append-only event projection。 |
| `src/runtime/session-runtime/named-checkpoint-domain.ts` | owner-fenced create/list/resolve resource domain；从 durable events replay，不复用可删除的 checkpoint cache。 |
| `src/runtime/session-runtime/rewind-reverse-request.ts` | `RewindPort`、opaque reverse-request 编解码、一次投递/取消/stale 的 typed result。 |
| `src/runtime/tools/checkpoint.ts` | TypeBox schema 和 `NamedCheckpointPort` 工具 adapter。 |
| `src/runtime/tools/rewind.ts` | TypeBox schema 和 fork handoff tool adapter。 |
| `src/runtime/tools/index.ts`、`src/runtime/tools/capabilities.ts` | 仅有 port 时注册；checkpoint 为 session mutation、rewind 为 driver-switch mutation，Plan Mode 默认 unknown/deny。 |
| `src/runtime/session-runtime/domain.ts` | 创建 domain、将它加到 session resource domains，并把两个 port 传入 `productionSessionTools`。 |
| `src/cli/embedded-session-runtime.ts` | owner-side `RewindPort` 的唯一生产构造。 |
| `src/tui/interactive/approval-workflow.ts`、`src/tui/interactive/session-workflow.ts` | 处理 `checkpoint_rewind`，以 `session.rewind` command、expected revision/head 和 switch exit intent 完成 handoff。 |

### 3.3 验收

新增 `tests/runtime/session-runtime/named-checkpoint.test.ts`、`tests/runtime/tools/{checkpoint,rewind}.test.ts`、`tests/tui/rewind-reverse-request.test.ts`。覆盖 event replay、活跃 checkpoint 冲突、cache 不参与 resolve、headless fail-fast、fork CAS/stale 和 source immutable。最后用 built CLI/真实 TTY 创建一个 checkpoint 并 rewind；验证 source/child session ID 和 sequence，而非只看 modal。

## 4. 阶段 II：非 PDF 文档转换 read branch

### 4.1 分派与限制

`read` 保持 schema 和 `repository_read` claim 不变，在 archive/sqlite 之后、文本 decode 之前按文件扩展名及 OOXML/EPUB 容器结构分派。转换器只接受已由 governed fs 取得的 `Buffer`；不暴露 image extraction directory，图片以有界 Markdown placeholder 表示。转换失败或伪造扩展名回落现有文本/二进制错误路径，绝不把异常容器静默当正文。

### 4.2 实现文件

| 文件 | 变更 |
|---|---|
| `src/websource/internal/xml.ts` | 受限 XML parser：保留命名空间/属性/文本，拒绝 DTD/custom entity，并有字节、元素、深度与 entity 引用上限。 |
| `src/websource/internal/docx/{converter,xml,index}.ts` | Buffer-only DOCX 正文/表格/图片占位 Markdown 投影；无 path/Bun.write 分支。 |
| `src/runtime/tools/read-office.ts` | DOCX/PPTX/XLSX/EPUB 的 extension/ZIP magic 判定、纯 Buffer converter registry、Markdown 渲染与统一输入/ZIP/XML/输出上限。 |
| `src/runtime/tools/read.ts` | 调用 `readOfficeBytes`、保留现有 selector/truncation，`ReadToolDetails.media` 扩展为 `office`。 |
| `src/websource/internal/turndown/{create,html}.ts` | 复用 Plan 18 已有的 HTML → Markdown 实现处理 EPUB；不重写 scraper 语义。 |
| `development-doc/plan/19-omp-tool-surface-expansion-plan.md` | 将 markit 四种纯 TS 格式的实现 authority 指向本计划，PDF 仍保留非目标。 |

### 4.3 验收

新增 `tests/runtime/tools/read-office.test.ts`，以最小 DOCX/PPTX/XLSX/EPUB fixtures 覆盖章节/表格/元数据、坏 ZIP、XML entity 上限、图像 placeholder、截断和普通文本无回归。运行 read 的既有 archive/sqlite/selector 测试与 `check:execution-boundaries`。

## 5. 阶段 III：受治理 image_gen

### 5.1 契约

`image_gen` 的最小输入是 `prompt`，可选 `model`、`aspect_ratio`、`image_size` 和输入图片 data reference；复杂上游字段先在工具端拼成可审计 prompt，不能透传 provider-specific arbitrary JSON。模型只从 Host 配置的 image catalog 解析。输出为 `AgentToolResult` 的 text/image content，并包含 provider/model/usage/response digest；错误返回 `isError`，不抛出未分类 provider body。

### 5.2 实现文件

| 文件 | 变更 |
|---|---|
| `src/runtime/tools/image-gen.ts` | TypeBox schema、prompt normalizer、bounded output/result details 和 `ImageGenerationPort` adapter。 |
| `src/runtime/tools/image-generation-port.ts` | image catalog lookup、fixed principal `image_gen`、response byte cap 与 provider-result projection；工具层不直接 import SDK。 |
| `src/api/openrouter-images.ts` | 接受由 port 注入的 governed fetch adapter；删除该路径对 ambient fetch 的依赖。 |
| `src/images-models.ts`、`src/providers/all.ts` | image model collection 的选择/credential composition，不改变 chat model catalog。 |
| `src/runtime/tools/index.ts`、`src/runtime/tools/capabilities.ts` | port 存在时注册，claim 为 network；Plan/minimal 不注册。 |
| `src/runtime/session-runtime/domain.ts` | 创建一次 session-scoped image port，传给 `productionSessionTools`。 |
| `src/cli/embedded-session-runtime.ts`（若 domain 需要 owner-only image credential state） | 只注入 Host/owner 构造所需的 secret resolver，绝不把 credential 放进 tool params/ledger。 |

### 5.3 验收

新增 `tests/runtime/tools/image-gen.test.ts` 和 `tests/api/openrouter-images.test.ts`：catalog miss、credential miss、network deny/review、abort、payload normalization、base64 image output 和大小上限。使用 fake `ExecutionEnv.network` 验证请求仅经 `image_gen` principal；真实 provider 验收必须由具备受控凭据的用户环境单列，不作为 fixture PASS。

## 6. 阶段 IV：GitHub 只读查询

### 6.1 契约

工具名为 `github`，op 仅为 `repo_view`、`file_read`、`search_issues`、`search_prs`、`search_code`、`search_commits`、`search_repos`。REST endpoint 由 tool 构造，不接收任意 URL；token 仅由既有 `WebSearchCredentialPort.getApiKey("github")` 获取，匿名读取仍可用。所有 API 调用走 `createWebSearchFetch({ principal: "github" })`，响应/文件内容受 byte/result cap 和 binary 检测保护。

### 6.2 实现文件

| 文件 | 变更 |
|---|---|
| `src/websource/github-read.ts` | endpoint builder、repo reference parser、JSON/file response validator 与 bounded render；复用 `fetchGitHubApi` 的 credential/transport discipline。 |
| `src/runtime/tools/github.ts` | TypeBox `op` union、只读操作 router、details 及 error projection。 |
| `src/runtime/tools/index.ts`、`src/runtime/tools/capabilities.ts` | 只在 governed network + credentials port 存在时注册，claim 为 network。 |
| `src/runtime/session-runtime/domain.ts` | 注入现有 web credential/settings 与 session network port。 |

### 6.3 验收

新增 `tests/runtime/tools/github.test.ts` 和 `tests/websource/github-read.test.ts`，覆盖 endpoint encoding、无 token、403/404/rate-limit、base64 text file、binary/oversize file、所有 op schema，以及 network principal。不可调用 `pr_create`、checkout/push、任意 URL 和 run_watch。

## 7. 阶段 V：canonical user manage_skill

### 7.1 语义

`manage_skill` 支持 `create` / `update` / `delete`。create/update 写入校验后的 `SKILL.md`，delete 只删除该 tool 创建/管理的 canonical user skill directory；不覆盖同名外部/compatibility skill。每次 mutation 是 write effect，成功后在 agent idle 重新扫描并交换 Extension snapshot；本 turn 使用旧 snapshot，下一 turn 才能发现新 skill。工具不自动 trust 新内容，仍由既有 trust receipt 决定激活。

### 7.2 实现文件

| 文件 | 变更 |
|---|---|
| `src/extensions/skills/managed-store.ts` | name/body/frontmatter 校验、managed provenance marker、canonical user root containment、atomic create/update/delete 及 collision policy。 |
| `src/runtime/tools/manage-skill.ts` | TypeBox action schema、`ManageSkillPort` adapter、明确 mutation result。 |
| `src/runtime/session-runtime/extension-composition.ts` | 暴露受 owner 控制的 skill reload request；只在 idle 执行 registry snapshot swap。 |
| `src/runtime/session-runtime/domain.ts` | 使用 composition-root 的 `NodeExtensionStorage` / user root 创建 port，并在 standard tool set 注册。 |
| `src/runtime/tools/index.ts`、`src/runtime/tools/capabilities.ts` | 有 managed port 时注册，claim 为 workspace write；minimal/plan 不注册。 |

### 7.3 验收

新增 `tests/extensions/skills/managed-store.test.ts`、`tests/runtime/tools/manage-skill.test.ts`、`tests/runtime/session-runtime/manage-skill-composition.test.ts`。覆盖 frontmatter/name/body bound、path traversal/symlink、foreign collision、atomic update、only-managed delete、trust remains blocked、idle reload 前后 catalog 和 failure 不改变 snapshot。用隔离 `RUNLEDGER_DIR` 的 built CLI 做一轮 create → next-turn discovery → delete；不得触碰真实 user home。

## 8. 实施状态和交付门槛

| 阶段 | 初始状态 | 进入下一阶段的门槛 |
|---|---|---|
| I checkpoint/rewind | implemented，待真实 TTY tool-call evidence | 已完成 named event projection、owner-fenced atomic target/source handoff、标准 profile 注册、headless fail-fast、router/TUI switch 和 32 项定向测试；仍需可用 provider 下的 built CLI/TTY 实际工具调用证据。 |
| II office/EPUB read | implemented | `read-office` 已仅通过 governed `read` 字节分派 DOCX/PPTX/XLSX/EPUB；受限 XML/ZIP 与输出界限、图片占位、converted Markdown selector 的定向测试和 execution-boundary check 已完成。PDF 仍不在范围。 |
| III image_gen | planned | fake governed network tests；真实 provider 另列 pending/accepted 证据 |
| IV GitHub read | implemented，待 built CLI smoke | `src/websource/github-read.ts` 与 `src/runtime/tools/github.ts` 已经由 `createWebSearchFetch({ principal: "github" })` 接入标准组合；定向 transport/tool/stdlib 测试已通过，仍须随本批次完成 check/build/CLI 验证。 |
| V manage_skill | implemented，待 built CLI lifecycle | canonical user root、attempt fence、active-turn pending reload 与 standard-only 注册已接入；存储/工具定向测试已通过，仍须补 isolated CLI 的 create → next-turn discovery → delete 证据。 |

每个代码阶段按影响运行 `npm run check`、受影响测试和 `npm run build`。如果已有无关失败阻塞，保留完整输出并区分；不为绿灯修改 sandbox、Memory、old Host 或其他不在范围模块。完成后将 Plan 19、parity 00 和本计划的状态原地更新。

### 8.1 2026-09-18 本批次证据

- 阶段 IV/V 已完成源码接线：GitHub 仅通过 governed `github` principal 访问固定 REST endpoint；`manage_skill` 仅写 canonical home、经 attempt fence，且 active turn 只登记 pending reload。
- 阶段 II 已完成源码接线：`read-office.ts` 只接受 `ExecutionEnv.fs` 已读取的 ZIP 字节，DOCX/PPTX/XLSX/EPUB 输出 Markdown；输入 8 MiB、ZIP entry/member、XML byte/depth/element/entity 与转换输出均有上限。DTD/custom entity、坏 ZIP 不回落为正文；图像从不写盘，只投影占位。PDF 仍为 native 依赖非目标。
- 定向测试 `tests/runtime/tools/read-office.test.ts` 加既有 archive/sqlite/read dispatch 测试：31 tests passed；覆盖四种最小容器、DOCX/PPTX 表格、EPUB metadata、图片占位、DTD 拒绝、converted selector 及伪装 `.docx` 文本回落。
- 定向测试 `tests/{websource/github-read,runtime/tools/github,extensions/skills/managed-store,runtime/tools/manage-skill}.test.ts` 加 `tests/stdlib-tools.test.ts`：39 assertions passed。
- `npm run check` 与 `npm run build` 均 exit 0；built `runledger --help` 在一个新建、隔离的 `RUNLEDGER_DIR` 下成功，随后已删除该空目录。
- `npm test` 的 80 files / 577 assertions 都通过，但 Vitest worker 最终报 `Timeout calling "onTaskUpdate"`，使命令 exit 1；该 runner-level unhandled error 不视为本批次完整测试绿灯，也不由本计划范围外修改掩盖。
