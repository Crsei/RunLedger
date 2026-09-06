# 本地运行轨迹记录与 TUI 面板实施计划

## 1. 状态与目标

日期：2026-09-06。状态：**已在独立工作树实现本地记录、owner 查询与面板；P6 验收按证据逐项收口**。实际默认值已改为 events，显式 off 保留。自动化、CLI/TTY 与人工/跨平台验收分开记录，见 [实施与验证记录](02-implementation-verification.md)。

目标：用户在对话运行中通过 `/trajectory` 查看 Run → Step → Model/Call/Attempt 的执行结构、耗时、输入输出与用量；支持历史分页、搜索、折叠、时间范围定位和实时跟随。本地轨迹事件默认开启，用户可通过 canonical settings 关闭。

本计划参考本地 deepseek-harness `47f943859b` 的 Trajectory，不移植其 Cordis、Web renderer 或产品内并行委派机制。Duration 是时间轴显示控制，Turns 与 Calls 是折叠控制，不将三个标签误当统计字段。

### 实施前基线

| 层 | 当前实现 | 本专项补齐 |
|---|---|---|
| TUI | 顺序 Timeline、工具卡片、运行边界、Ctrl+T 转写 | 独立轨迹面板、层级布局、详情与交互 |
| 计时 | assistant duration/TTFT、工具耗时、run active/elapsed | 统一来源、等待区间、按时长总览 |
| Trace | recorder、JSONL/hash chain、artifact CAS、树投影 | 稳定关联、可重建索引、分页查询与 live feed |
| recording | 默认 off，用户级配置 | 缺省 events，显式 off 保留 |
| 历史 | controller 消息回放，转写块数上限 | 从持久化事实查询，不依赖已渲染 Timeline |

代码入口：`src/runtime/trace/{types,recorder,composition,event-store,artifact-store,tree}.ts`、`src/storage/settings-manager.ts`、`src/cli/trace-config.ts`、`src/runtime/session-runtime/`、`src/runtime/session-server/`、`src/cli/session-interactive-controller.ts`、`src/tui/timeline/`、`src/tui/transcript-view.ts`、`src/tui/commands/registry.ts`。

参考实现：deepseek-harness 的 `packages/client/ui-trajectory/src/client/{TrajectoryToolbar,TrajectoryView,TrajectoryTable}.tsx`、`layout.ts`、`timeline.ts`，及 `packages/client/runtime/src/client/sessions/session.ts`。

## 2. 范围与不变量

- 复用 Session Owner + SQLite authority、owner fence 与 command/query/subscription。TUI 不读取 SQLite、Trace 文件或 native path；查询不取得 driver 写权限。
- Session Event Store 继续拥有会话/执行事实；Runtime Trace 是可选观测事实。新索引与面板投影可丢弃重建，不成为第二本执行账本。
- 本专项不开发 sandbox，不改变 ExecutionGateway、工具权限、模型上下文或产品内 child 深度/并发/写权限。
- 不恢复 legacy Host，不增加 mock 生产 fallback，不接入 Opik/OTLP/远程网络 exporter。
- Ctrl+T 保留原有转写用途；`/trajectory` 是独立面板。折叠、筛选、选中记录不删除历史，不触发模型调用。
- 公开 DTO 只含稳定 ID、digest、locator 和有界安全文本；凭据、auth header、完整环境、private reasoning 不进入新增展示/索引正文。

## 3. 默认记录与配置合同

唯一 authority：`<runledgerHome>/settings.json`；home 仍由 composition root 按 `RUNLEDGER_DIR`/默认 `~/.runledger` 解析。

目标缺省配置：

```json
{
  "recording": {
    "mode": "events",
    "failurePolicy": "best_effort"
  }
}
```

关闭新增轨迹记录：

```json
{
  "recording": {
    "mode": "off"
  }
}
```

| 模式 | 写入行为 | 面板详情 |
|---|---|---|
| off | 不创建新的 Trace event/artifact | 已有记录可读；新执行仅显示 Session 事实能证明的基本结构，标记 recording off |
| events（默认） | 本地结构化事件、计时、usage/cost、内容 digest | 复用 Session 已有安全内容；Trace 仅有 digest 时显示“未保存正文” |
| events_and_artifacts | events + 现有受控 artifact 保存链路 | 可按需分页读取已保存且允许显示的正文 |

### 解析与升级规则

1. 未配置 recording，或合法对象缺少 mode：采用 events。缺少 failurePolicy：采用 best_effort。必须逐字段补缺省，不能沿用“任一字段缺失则整段回退”的旧解析。
2. 合法显式 off 永远优先；升级不覆盖用户已有 off，不写回用户 settings。`{"mode":"off"}` 必须有效。
3. mode/failurePolicy 非法、对象类型错误或未知字段：配置入口拒绝写入；启动加载给出有界诊断并使本次 recording 关闭，不能因错误回退到默认开启。不得吞掉显式关闭意图。
4. 在 CLI composition 时冻结有效配置与 digest；文件修改对下次启动生效。连接仍在运行的 owner 不重新解释客户端配置；面板展示 owner 实际有效模式。
5. off 不关闭必要的 Session 持久化/审计，不删除历史 Trace，不回填过去未记录的数据。旧会话仍可查询，有缺口则展示范围和原因。
6. 默认 events 不等于默认保存所有原始请求/响应、token chunk 或无限工具输出。大输出详情只在确实保存且允许访问时提供；无正文不伪造完整性。
7. 代码落地默认值时，同批更新根 AGENTS.md recording 条款、settings schema/help/tests 与 Trace Phase 03 文档；实现已同步默认 events；历史 off 配置保持原意。

### 失败与资源语义

- best_effort：磁盘满、写入/flush 失败不能终止正常模型/工具执行；发出可见但限频的 degraded 状态，记录缺口范围，恢复后不能宣称缺口已补全。
- fail_closed：继续沿用既有失败策略，在受治理的执行边界停止；不靠吞异常降级为 best_effort。
- 实施时核查目录创建/安全校验/recorder factory 初始化异常，也纳入失败策略；不能只覆盖事件 append。
- 每 owner 采用有界写队列和 batch/flush，退出时有界等待；过载必须显式报告，禁止无限内存积累。
- 默认不自动删除用户历史；展示当前 session 记录字节数与写入故障。P2 用压力测试确定并冻结队列/批量阈值；记录 10 万事件及大输出的磁盘增长，未完成测量不得启用发布默认值。
- 文件权限、symlink 检查、hash chain、redaction 和 artifact digest 校验继续复用现有实现。

## 4. 轨迹模型与计时

显示结构：Session → Run（界面可标 Turn）→ Step → Model / Tool Call → Attempt；既有 child 只作为独立 session 引用，不扩展委派能力。

Run 是一次用户提交触发的执行生命周期；Step 是一次模型请求及关联工具阶段。先核对现有 Trace turn 与 Agent Loop turn 的实际语义，再通过显式映射得到显示层级，不直接把同名字段视为同一概念。排队、steering、重试、压缩、恢复均应有可测试的归属规则。

稳定键至少包含 sessionId、runId、stepId、callId/attemptId（适用时）、traceId/nodeId 和 ownerGeneration。禁止用数组下标、显示顺序或时间戳拼接实体身份。并行工具即便当前无执行路径也不按相邻行误合并；对已知并发事实只做展示。

| 数据 | 规则 |
|---|---|
| 状态 | pending/running/waiting/succeeded/failed/cancelled/interrupted/unknown；录制缺口不等于执行失败 |
| elapsed | 生命周期墙钟跨度；跨进程依赖已记录时间，标记来源 |
| active | 复用 Runtime 已扣除审批/凭据等待的计时，不由 UI 猜测 |
| 模型 Timing | request start、first token、completed；TTFT 与 decode 分段，仅在证据齐全时计算 |
| 工具/attempt | 各自开始/终态耗时；父节点不简单累加重叠子节点 |
| cost/usage | 保留 provider/metered/estimated/unavailable 来源；未知不显示 0；小额费用采用足够精度 |
| 运行中耗时 | 可显示客户端递增的 elapsed 预览，明确 provisional；终态以持久化值替换 |

Duration 关闭时按顺序等宽；开启时按区间耗时缩放并压缩空闲间隔，界面标注“空闲已压缩”。真实 elapsed/active 数值不随布局改变。缺失时间显示无计时标记，不赋予假时长。轮次边界、错误和等待区间有可区分的文本标识，不能只靠颜色。

## 5. 查询、索引与实时衔接

在 Session Owner 暴露版本化只读查询能力，建议 operation 名为 `trajectory.page`、`trajectory.detail`、`trajectory.search` 和轨迹订阅；以当前 protocol 注册方式落地，不单独开放文件 HTTP 服务。

- page：sessionId、opaque cursor、方向、过滤条件、pageSize；缺省 50 条，最大 200 条、编码后单页上限 256 KiB，且不得超过现有 transport 帧限制。大文本只返回摘要/locator。
- detail：recordId、字段、正文 cursor；单块最大 64 KiB；返回完整/截断/未记录/已不可用/拒绝访问状态。artifact 的定位与解码由 owner 执行。
- search：在该 session 的可查询历史中搜索安全投影字段，结果分页并标明覆盖范围；不把“已加载窗口搜索”标为全历史搜索。digest-only 内容不可搜索。
- 每页携带 projectionVersion、snapshot watermark、连续性信息、hasMore、recording 状态和缺口描述。Session 与多条 Trace 日志具有独立序号，必须用复合 cursor/watermark，不能比较不同日志的 sequence 大小。
- 首屏读尾页；上翻追加旧页并保持选中 ID 与滚动锚点。数据窗口和渲染窗口均有界；卸载页面后可重新查询，禁止累计整个 session 到 TUI 内存。
- 历史快照与订阅建立使用 barrier/resume cursor；缓冲期间事件按稳定键与版本合并，重复丢弃，缺口重新查询，不能把重连事件追加成重复节点。
- 旧 generation 历史可读；live 消息验证 owner generation，接管后重新取得 snapshot，过期 owner 不更新当前状态。
- 索引按 session/run/step/call 和安全检索字段组织，是可重建 cache。禁止每次打开全目录扫描。索引损坏时后台有界重建并显示进度，不修写 canonical 事件。
- SQLite schema 如需变更，走现有兼容性/offline migration gate；活动 owner 阻止迁移时明确提示关闭会话，不清空 owner 行或绕过 fence。
- 旧 Trace 缺关联 ID：只根据可证明的 metadata 映射；无法归属的记录显示“旧格式，关联不完整”，不改写 hash chain。

## 6. TUI 命令与面板

### 命令

- `/trajectory`：打开/聚焦当前 session 轨迹面板；运行中可用，不提交给模型。
- `/trajectory close`：关闭并恢复原 composer draft、焦点和主对话滚动位置。
- `/trajectory status`：只读展示有效 recording 模式、完整性、最后记录位置与故障原因。
- 不增加 `/trajectory off` 这类与文件配置竞争的 authority。关闭记录按第 3 节 settings 配置；面板关闭与录制关闭是不同操作。

命令进入现有 registry → action → controller 路径，支持补全/help；不调用模型、不创建运行任务、不改变权限 profile。

### 面板布局

1. 顶栏：当前 session、recording/完整性状态、Duration、Turns、Calls、搜索、Follow。
2. Overview：终端字符绘制的可见范围时间轴，标记 run 边界、模型、工具、等待；支持选择区间并跳转列表，不引入第二个竞争的滚动位置 authority。
3. 主列表：Run/Step 分组，节点状态、类型、摘要、耗时；Turns 折叠轮次，Calls 折叠工具子树。
4. 详情：Overview/Input/Output/Timing/Usage 标签；展示字段来源、正文可用性、错误、attempt。默认先加载元数据，按需获取正文。
5. 底栏：键位提示、历史加载与缺口状态；首行提供“加载更早记录”，失败可重试。

键位：↑/↓、PgUp/PgDn 导航；Home/End 首尾；Enter 展开或选择；Tab 切换列表/详情/控件；Esc 逐级退出搜索、详情、面板。单字母快捷键仅在非输入焦点下工作；文本搜索输入不被折叠/Duration 快捷键截获。鼠标滚轮与滚动条归所属 viewport；面板捕获期间输入不落入 composer。

宽屏采用列表与详情分栏；窄屏采用列表/详情切换，80×24 下保持退出、导航和状态可达。先复用 OpenTUI 组件与主题；不修改 renderer 底层。跟随默认开启，手动上翻暂停；显式 Follow/End 恢复。流式内容变化不重置选择，不反复全量重排。

展示偏好使用现有版本化 tui-preferences：Duration、折叠策略可持久化；录制模式不放入此文件，搜索文本和正文不持久化。

## 7. 分阶段实施与交付

| 阶段 | 交付物 | 验收出口 |
|---|---|---|
| P0 合同与基线 | 核对 Run/Trace turn 语义；冻结 DTO、cursor、事件映射与指标来源；隔离 fixtures | 关联映射、未知值、旧格式规则经审阅；无运行行为变化 |
| P1 默认记录 | 逐字段解析、显式 off、诊断与配置 digest；默认 events；同步说明/AGENTS | 缺省、部分配置、非法配置、升级保留 off、owner 配置冻结测试通过；与 P2 资源界限同批交付 |
| P2 记录完整性与索引 | 稳定关联 ID、缺口事件、失败策略、资源上限、可重建索引 | 写满/崩溃/接管/重启、队列压力与磁盘测量通过；不存在不可见丢失 |
| P3 查询与订阅 | page/detail/search、auth/generation 校验、复合 watermark、重连恢复 | 分页覆盖全历史且无重复遗漏；大小边界、旧格式、off 历史读取通过 |
| P4 基础轨迹面板 | 命令、Run/Step/Call 层级、详情、折叠、历史分页、Follow | 运行中打开/关闭不影响模型执行、draft、主滚动位置；关闭录制状态可解释 |
| P5 时间轴与检索 | Duration Overview、时间选择、搜索、窄屏适配、偏好 | 零/缺失/重叠时长、搜索跳转、折叠选择保持、流式更新验证通过 |
| P6 集成与交付 | 文档、完整 gates、构建后真实 CLI/TTY、性能与平台证据 | 满足以下验收矩阵；未完成的人工作业与跨平台门禁明确 pending |

P0 → P1/P2 → P3 → P4 → P5 → P6。提交按能力边界拆分；实现前重新检查工作树，保留并发修改。P1/P2 应在同一发布批次启用，避免先发布默认写入再补失败控制。

## 8. 验收矩阵

| 场景 | 必须观察的结果 |
|---|---|
| 首启默认配置 | 实际 CLI 产生本地 events，面板出现新轨迹；不产生默认 artifact 正文 |
| 显式 off / 部分配置 | 不新增 Trace 文件；旧轨迹可查，新执行标记观测缺口；Session 数据仍正常保存 |
| 非法配置 / 旧配置 | 无静默开启；诊断可见；既有 events/events_and_artifacts/off 含义保持 |
| 多步骤工具执行 | Run/Step/Call/Attempt 身份不串联，重试和异常不重复计数 |
| 等待/取消/失败/接管 | active 与 elapsed 区分；终态、缺口与 owner generation 正确 |
| live + 翻页 + 重连 | 快照与增量无重复遗漏，滚动锚点不跳，旧 owner 更新被拒绝 |
| 10 万事件/长输出 | 查询受 page/byte 限制，TUI 内存随窗口而非总历史增长；报告 p95 查询时间、RSS、写入体积 |
| 记录写入/flush/索引失败 | best_effort 可继续且显示 degraded；fail_closed 遵守既有合同；cache 可重建 |
| 输入安全 | 凭据/环境/private reasoning 不泄漏；任意 path、跨 session ID、伪造 cursor 被拒绝 |
| 真实 TUI | /trajectory、Duration/Turns/Calls、详情、搜索、Follow、Esc 与 Ctrl+D 实际可操作 |

代码变更执行 `npm run check` 和受影响测试；提交前按仓库要求完成 `npm test`。进入 dist 的改动执行 `npm run build`，核对 `command -v runledger`、`readlink -f`、`npm ls -g --depth=0`，再用隔离绝对路径 RUNLEDGER_DIR 和独立 TTY/tmux 验证。纯本计划文档交付只执行差异、链接和 `git diff --check`。

真实 provider 需单列一次多 step/call 轨迹证据；不得把 fixture/模拟 provider 当作外部调用通过。Linux 自动化、人工视觉/鼠标/中文 IME、macOS/Windows 分开记录。性能预算在 P0 基线测量后明确数值并冻结，P6 不得仅用“不卡顿”代替证据。

## 9. 文档边界与完成标准

既有 [Session Audit 阅读方案](../note/00-session-audit-reading-mode-plan.md)标为 superseded：复用其 hash/digest 校验与安全阅读要求，替换 idle-only、全量扫描和独立 `/audit` 面板设计，不保留两个竞争入口。

本专题是本地轨迹查询/交互的权威入口；既有 Trace Phase 01–03 继续维护 Store/recorder/config 实现事实。Phase 04 中本地树查询与 CLI/TUI 展示移交本专项，远程 Opik/outbox 仍独立 planned，不作为本地轨迹交付前提。

完成须同时满足：默认 events 与显式关闭有效；数据关联与缺口可解释；面板能分页查看完整可用历史；Duration/Turns/Calls、详情与搜索可用；故障和性能门禁通过；文档事实一致。只有计划存在、类型存在或 mock 界面可见均不算实施完成。

## 10. 当前实现决策

- `src/runtime/contracts/trajectory.ts` 冻结 owner-scoped DTO；Session → Run、Agent Loop turn → Step。各流序号分开保留，新增 Attempt receipt 位置，不比较无关日志序号。
- 独立 `projections/trajectory/<session-digest>.sqlite` 是可重建 cache，不修改 Session authority schema。owner 启动时流式发现历史、校验完整 hash 前缀；后续打开面板只查询 cache。损坏 cache 隔离后重建；缺失日志和不完整尾部显示 degraded。
- Trace 持久化回调接入 Agent 与 managed process 两条生产路径。Session 安全公开内容、Trace digest/artifact 和 Attempt receipts 合并显示。无法证明 Call 归属的旧/现有回执明确标记 association unavailable；不根据相邻顺序猜测。process output 是回执下的内容记录，不增加执行 attempt 数量。
- 查询采用先订阅失效通知、再取 snapshot 的衔接方式；失效通知限频、无 durable sequence，面板从带 generation/Session/Trace/Attempt watermark 的快照重新查询。Follow 关闭时保留当前阅读快照，手动翻页或重试刷新，避免后台替换窗口造成锚点跳动。
- 实际页上限冻结为 200 条和 192 KiB（给 transport envelope 留余量），正文块 48 KiB，TUI 窗口 400 条，搜索 128 字符。Session 索引批次按 4 MiB 正文预算读取；单事件超过 8 MiB 时显式 degraded 并停止该前缀重放。Session 正文安全预览最多 2 MiB，过大明确 unavailable；不把截断预览标为完整正文。
- 写队列每个 Trace 最多 256 条；单事件输入 64 KiB；单 Trace 最多 100,000 条或 128 MiB。batch=1、逐条 flush；单次写入 deadline 5 秒，写入故障后不继续追加到可疑 hash chain。触达界限走 failure policy；不删除用户旧文件。历史 events()/tree() 是显式批量 reader，仍受单 Trace 上限约束。
- Duration 仅缩放有计时证据的节点、压缩空闲并保留重叠；Calls 折叠 attempt 子项但保留 Call 行。Session/Trace 到达顺序不决定面板层级顺序。小额 cost 保留微额精度，计费来源仍显示 provider 或 pricing_table，不等同账单。
- `/trajectory status` 独立显示 owner 的 recording/coverage/watermark；完整面板支持 Duration/Turns/Calls、详情、分页、全历史安全摘要搜索、时间范围、Follow、鼠标选择和滚动。关闭面板不改变 recording。

本轮没有开发 Sandbox、远程 Opik/OTLP、可写或并行 child。真实 provider 多步骤、人工 IME/视觉及 macOS/Windows 仍需对应环境证据。
