# RunLedger Agent Mode 入口实施计划

> 2026-09-11 更新：新建 `default` 使用 `standard@2`；恢复/attach/fork 仍保留原 ref。schema 6 升级必须先停止 active Session，再显式执行 `runledger migrate schema --confirm`。当前提示词合同与验证见 [Prompt 专题](../prompt/01-standard-execution-and-behavior-gaps.md)。下文原 standard@1 交付记录保留为历史。

> 状态：implemented；M0–M6 代码、Linux 本地自动化与 built CLI/TUI 验证完成；外部 provider、人工与跨平台门禁见第 6 节。
> 实施日期：2026-09-05–06；实施基线 `5a1b67a`，分支 `rollback/before-composer-shape`，共享工作树包含并发改动。
> 范围：用户授权执行全部阶段，包含 shell-only、Plan 与用户配置；不修改 OS sandbox 或真实用户数据库。

## 1. 归属与实现基础

本专题负责模式命名、CLI/TUI/config 入口、显示及交付验收。不可变 Harness Profile 合同归 [Runtime 09](09-minimal-harness-profile-implementation-plan.md)，公共 DTO 归 [Runtime 04](04-governed-agent-harness-runtime-plan.md)，Session 生命周期、owner fence、driver admission 与迁移归 [Runtime 06](06-session-owner-runtime-replacement-plan.md)。Plan 行为归 [Plan 专题](../plan-compact-memory/01-implementation-plan.md)。

实施前已核对当前生产调用链：`bin/runledger.js → dist/cli/cli.js → embedded Session Owner → assembleSessionDomain`。复用已有 builtin registry、governed stdlib、Session catalog/create/fork、`SecondarySelectionView`、Footer registry、Plan reducer/artifact store 与 Attempt Gateway；没有另建 renderer、权限 authority 或后台 daemon。

| 用户 Mode | 新建 durable ref | 模型工具 | Prompt / 扩展 |
|---|---|---|---|
| `default` | `standard@2` | 标准工具集，受当前策略约束 | 保留 assembled prompt、已装配扩展与受限 child 策略 |
| `minimal` | `minimal@2` | 仅 governed `bash`，无 background 参数 | 完整固定 prompt；不装配扩展、LSP、child |
| `plan` | `plan@1` | `read`, `glob`, `ls`, `plan_read`, `plan_write` | 完整 Plan prompt；不装配扩展、LSP、child |
| 恢复的旧 minimal | `minimal@1` | `bash`, `edit` | 旧 ref、prompt、descriptor 与工具 schema 不变 |

统一映射位于 `runtime/harness-profiles/agent-mode.ts`。`review` / `explore` 不注册空实现。Mode、Permission、Thinking、Model 分别有独立含义；mode 不自动修改 Security 或 OS sandbox 配置。

## 2. M0 冻结的产品合同

- **D1**：选择不同 exact ref 时新建空 Session 并切换，原会话可恢复。选择当前 exact ref 为 no-op；恢复 minimal@1 后再次选择 minimal 会新建 minimal@2。不热改原会话或把历史工具结果带入新模式。
- **D2**：本次新建 minimal 必须 shell-only；新增 minimal@2，保留 minimal@1。
- **D3**：本次提供 Plan 生产 authority、只读效果边界、工件审批和退出；批准/结束工作流不把 Plan 会话变成可写会话。
- **D4**：仅 canonical 用户级 JSON settings 接受 `agentMode`；不引入 TOML 或 workspace 默认覆盖。
- **D5**：TUI 新建转换保留当前 provider/model/thinking，并继续经过 model-routing admission；目标无法打开时返回原会话。草稿保留且拒绝切换；运行中拒绝。

## 3. CLI、配置和 TUI

### 创建与恢复

```sh
runledger --mode default
runledger --mode minimal
runledger --mode plan
```

`--mode=<value>` 同样支持。未知值、缺值、冲突的重复值在创建前拒绝。`--harness-profile standard|minimal` 保留兼容，新建 minimal 也选 minimal@2；同时给两个参数时只接受相同目标 ref。

用户级 `settings.json` 可写 `"agentMode": "minimal"`，合法值为 default/minimal/plan。fresh create 的优先级为显式 CLI > settings > default。resume/attach/continue/fork 始终读取 durable ref，显式 CLI profile/mode 覆盖被拒绝。workspace settings 中的 agentMode 不生效。TUI 普通 `/new` 继续继承源 ref，`/new [standard|minimal]` 保留兼容。

### 切换与显示

- `/mode` 打开 Composer 上方的 bottom-left 选择器；`/mode default|minimal|plan` 直接选择。
- `/minimal` 绑定 minimal 参数，不是打开通用选择器的松散 alias。
- 选择器说明新会话语义并显示当前内部 ID/version；取消不产生 mutation。
- session.create、revision、driver/observer、recovery barrier、断连等错误沿既有 Session admission 返回，失败不乐观修改 Footer 或 sessionId。
- Footer、header、catalog 共用 mapper；Footer 从当前 snapshot 的最终工具表生成摘要。新 minimal 显示 shell，旧 minimal 显示 bash + edit，缺失工具表显示 unavailable。
- 80/143 列优先保留 Mode；工具摘要可在窄屏隐藏，model/permission/thinking 仍由各自字段负责。`/mode` 中的 Current tools 展示当前最终模型工具表，可用方向键浏览。

## 4. Plan 的生产行为与边界

新 plan@1 Session 自动建立初始工件并进入 active。`plan_write` 只能用 state revision、artifact revision 和完整正文更新 Session-owned 工件，不能提供路径或批准自身计划。正文限制为 65,536 字符且不超过 128 KiB，工件最多 256 个 revision。

流程为：active → 写工件 → request_approval → awaiting_approval → approved/exit_pending → settle_exit/inactive。拒绝后回到 active；取消可结束 active 或待审批流程。结束后创建新 Plan Session 才能重新发起工作流。`plan.activate` 保留为写工件兼容入口；`plan.enter` 对当前 active 状态只返回经 revision 校验的快照。

`/plan` 分页展示固定快照的完整正文，审批绑定 state revision、artifact revision/digest、approvalId；过期内容或错误绑定不能批准。CLI 提供对应控制命令：

```sh
runledger --session-id <id> plan inspect
runledger --session-id <id> plan write '# Plan body'
runledger --session-id <id> plan request_approval
runledger --session-id <id> plan approve <approval-id>
runledger --session-id <id> plan reject <approval-id>
runledger --session-id <id> plan cancel
runledger --session-id <id> plan settle_exit
```

`session-runtime/plan-domain.ts` 通过 owner-fenced events 与 Attempt Gateway 持久化。Session-local payload 使用 `runledger.session-plan.current` exact envelope，包含 session、policy ceiling、operation、request digest、command/attempt IDs、reducer commands 和必要正文。恢复重放工件并校验 digest/transition，幂等请求返回原结果，冲突不重复写入。

工具 admission 拒绝任意 shell、workspace write、network 与未知效果；唯一工件写例外按 composition 注入的实际 writer 对象身份识别，保留上游 deny。Plan 不发布 process mutation，ExecutionEnv 进一步拒绝 shell/network/所有文件 mutation。read/glob/ls 的实际读取继续经过原 Security gateway。未选入的 grep/find 含内部 shell 路径，因此不列为 Plan 模型工具。

批准或退出工作流后上述只读边界仍生效；实施时 `/mode default` 新建会话。default/minimal 的 `/plan` 仍是被动 inspect，不组合第二个可变模式 authority。

## 5. 兼容、receipt 与迁移

- `standard@1` 和 `minimal@1` descriptor digest 不变；新 schema 5 只接受这两个旧 ref、minimal@2 和 plan@1 的 exact ID/version/digest。
- schema 4 → 5 通过现有 offline structural migration：零 active owner、事务内再次验证、固定列复制、保留既有 row/ref；旧 binary 按 schema max 拒绝新库。历史 schema 4 SQL 没有改写。
- 仅在隔离数据库验证迁移、旧 ref 与 fork；没有修改真实用户 home、credentials 或 owner rows。真实库中的残留 owner 仍需既有恢复专项处理，不通过 mode 绕过。
- `harness.composed` 移到最终 child 工具注册之后、首个模型调用之前，落盘失败仍使 owner 启动失败。
- 新 receipt 使用 `manifestFormat: descriptor-digests@1`，按有序 `{name, descriptorDigest}` 表重算 manifest，再重算 composition digest，并比对 builtin flags、prompt/context 合同和 allowlist。minimal/plan 使用固定工具表摘要。
- 旧 receipt 没有格式标记：旧 minimal 同时比对固定 raw/table 摘要；旧 standard 的动态 raw manifest 无法仅从历史 bounded 字段完整重建，保留兼容语义，不声称历史记录获得了新版自校验能力。
- 恢复错误保留 storage/admission 分类，只有 profile 投影损坏映射为 harness_profile_corruption。

shell-only 表示模型工具数量，不保证任意 shell 命令都会被允许。默认 legacy 分类器将重定向视为未知，approvalPolicy never 会拒绝；配置现有 AST 分类后可验证允许的重定向写入。未扩大分类器、权限规则或 sandbox；用户未授权的效果仍可被拒绝。

## 6. 阶段记录与验收

| 阶段 | 本次实现与 RED → GREEN 证据 |
|---|---|
| M0 | 核对生产接线和复用组件，冻结第 2 节 D1–D5 |
| M1 | 恢复测试先复现工具表/builtin flags 篡改未拒绝，child receipt 测试先复现缺 spawn_agent；修复后 recovery 11、multi-agent composition 7、旧 minimal production 4 项通过 |
| M2 | `/mode` workflow 缺失的两项 RED 后接通；后续 28 项 Session workflow 回归覆盖 alias/Plan 派发、无参取消、same-ref no-op、草稿、创建与 admission/transport 错误 |
| M3 | CLI 新模式解析 6 项 RED、Footer Mode 两项 RED 后接通；CLI parser/创建默认、settings 校验、Footer/header/catalog 对应测试通过；窄屏真实帧见下表 |
| M4 | 文档、帮助、标准 PATH、build 与隔离真实 CLI/TUI；最终结果见下表 |
| M5 | schema 迁移先观察 version 4 而非 5；GREEN 保留 minimal@1/fork，active owner 拒绝迁移，新 minimal@2 只有 bash。生产 6 项验证旧/新工具表、固定 prompt/context、无扩展/child、权限拒绝零变化，以及新版写入、超时、取消、输出截断和 process receipts |
| M6 | 初始 RED 为 plan resolver unavailable；GREEN 的 embedded owner/TCP 测试验证 exact 五工具、Plan 工件写入、重复请求、stale/错误审批绑定拒绝、批准/退出、重启后 digest/content 保持，以及批准/结束后仍拒绝工作区效果。TUI 两项验证固定正文审批绑定与 Esc 无 mutation |

| 验收类型 | 本次状态 |
|---|---|
| 定向自动化 | 上述套件已通过；最终新增代码状态由全量门禁再次覆盖 |
| `npm run check` | passed；582 consumer coverage、零诊断、Rust 12 项通过；完整输出保存在本次验证日志 |
| `npm test` 默认本地 inventory | 六桶分桶执行全部通过：515 文件覆盖、3,241 项通过、3 项 macOS-only 跳过；每桶退出 0，child/descendants/socket/temp 清理均 verified |
| `npm run build` | passed；最终构建退出 0，随后真实 TUI 验证期间未再次覆盖 native 产物 |
| PATH | `/home/nzq/.npm-global/bin/runledger → 本仓库/bin/runledger.js → dist/cli/cli.js`，global link 已核对 |
| built CLI/TUI | passed（Linux 自动终端捕获）；143×42 dark、80×32 light，4 次 TUI 退出均为 0；具体路径见下文 |
| 外部真实 provider | pending；隔离测试 manifest 和占位凭据只验证选择/继承，不证明 provider 兼容，不发送外部请求 |
| 人工视觉/真实键盘/中文 IME | pending；终端捕获不替代人工验收 |
| macOS/Windows runner | pending；Linux 实测不替代跨平台验收 |

### 构建后行为证据（2026-09-06）

隔离 `RUNLEDGER_DIR` 使用 `/tmp/runledger-mode-native-dko5nfhx/home`，有效终端帧和 JSON 摘要保存在同级目录；验证结束后已清理隔离 home 与本任务 tmux 会话。使用占位凭据与仅供 UI 验证的兼容性 manifest，没有外部模型请求。

- 先把 CLI 初始 `openai/gpt-5 + low` 改为 `openai/gpt-5-mini + medium`，再执行 default → minimal → plan → default，四个 frame 的 Footer 保持后者。取消 `/mode` 后 catalog 未变化；切换后的三个源会话仍存在。
- composition receipt 与 Current tools 实测：新 minimal@2 为 bash；Plan 为 read/glob/ls/plan_read/plan_write；额外构造的旧 minimal@1 恢复与 fork 均仍为 bash/edit。
- 改 settings.agentMode 后恢复 minimal、恢复 Plan 和 fork minimal 均保留 durable ref；省略 CLI mode 的 fresh create 采用 settings.agentMode=plan；非法 CLI mode 在 catalog mutation 前失败。
- CLI 分三次进程写正文、请求审批、inspect，均退出 0；80 列 light TUI 恢复同一 artifact digest 与 pending approval，显示完整正文后批准、结束为 inactive，Mode 仍为 plan。
- 原始 empty legacy 测试 fixture 缺少 workspace locator，标准入口按预期拒绝；补齐 fixture 的合法 binding 后才进行旧 ref 的有效验证，不绕过 workspace admission。
- 早期探索在另一次 build 覆盖已加载 native 文件期间出现 Bun 崩溃，该次不计为通过；最终有效验证采用稳定构建产物，全部正常退出。

最终回归曾定位到既有 `process-composition` takeover fixture：takeover 后旧 owner 的 stop 未成功，测试未清理自身 30 秒 Node 子进程。仅在该测试中记录 fixture PID、验证旧 owner stop 被拒绝、终止 fixture 并确认进程退出；没有修改生产进程治理。定向 18 项与 runtime 整桶均退出 0，所有清理项 verified；没有忽略先前的非零退出码。

同一状态下已通过的检查不重复跑；新增变更或失败后才重跑相应门禁。只提交本任务相对基线的改动，保留并发已暂存/未暂存内容，不推送。
