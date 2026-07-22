现在构建 Agent Harness Runtime，真正需要关注什么

把前面大量产品更新、事故修复和研究结论压缩成一句话：

未来 Coding Agent 的核心不是模型、Prompt 或聊天界面，而是一个以 Session、Workspace、Capability、Evidence 为中心的可治理工程运行时。

模型、UI、工具和 Provider 都会不断更换；真正需要长期稳定的是：

Agent 在哪个工作区执行；
它基于哪段完整历史作出决定；
每次工具调用具有什么权限；
输入和工具结果来自哪里；
花费了多少资源；
是否真的完成了验证；
出错后能否恢复、回滚和审计。

最适合未来 Coding Agent 的框架，应当是：

协议优先、模型无关、工作区隔离、能力受控、事件溯源、证据驱动、验证强制、客户端解耦的 Runtime。

一、必须重点处理的 11 类问题
1. Workspace Identity：每次执行必须知道“我到底在哪个仓库”

目前最危险、也最容易发生的问题之一，是 Agent 以为自己在隔离 worktree 中，实际却在主仓库、其他项目或父目录执行命令。

不能只依赖当前进程的 cwd。每次工具调用都应携带完整执行身份：

type WorkspaceExecutionEnvelope = {
  sessionId: string;
  workspaceId: string;
  repositoryId: string;
  worktreePath: string;
  branch: string;
  baseCommit: string;

  agentId: string;
  toolCallId: string;
  traceId: string;

  cwd: string;
  ownerRuntimeId: string;
};

执行前必须检查：

cwd 是否位于指定 worktree 内；
canonical path 是否存在 symlink、junction 或 .. 越界；
当前分支和 base commit 是否匹配；
workspace 是否归当前 runtime/session 所有；
删除 worktree 时是否可能越界删除其他目录。

推荐原则：一个 Goal、一个 Branch、一个 Worktree、一个独立 Session。

2. Session Integrity：Session 不只是聊天记录

未来的 Session 应当是一个可重放、可验证、可回滚的执行 Episode，而不是数据库里几条 message。

推荐采用 append-only event log：

type RuntimeEvent = {
  eventId: string;
  sessionId: string;
  sequence: number;
  timestamp: string;

  type:
    | "message"
    | "model_routed"
    | "tool_call_started"
    | "tool_call_finished"
    | "permission_requested"
    | "permission_decided"
    | "checkpoint_created"
    | "artifact_created"
    | "verification_finished"
    | "subagent_spawned"
    | "session_stopped";

  previousEventHash?: string;
  currentEventHash: string;
  payloadDigest?: string;
};

必须支持：

历史哈希链；
Checkpoint 与 Rewind；
Session fork；
本地到远端 handoff；
用户主动停止后永不自动复活；
断线后恢复，但不重复旧 Prompt；
子 Agent 失败时返回 partial result；
历史损坏时停止执行，而不是静默截断。

为了性能，可以定期生成快照，但事件日志应继续保留为真实来源：

Append-only Events
        ↓
Periodic Snapshot
        ↓
Fast Restore + Full Audit
3. Capability Kernel：权限必须独立于模型和 Prompt

不要把“不要执行危险命令”仅写进 System Prompt。Prompt 是行为引导，不是安全边界。

推荐将所有副作用操作放到独立的 Capability Gateway：

Agent Runtime（不可信）
        │
        │ Signed Capability Request
        ▼
Capability Gateway（可信）
        ├─ Identity Binding
        ├─ Argument Policy
        ├─ Workspace Boundary
        ├─ Rate Limit
        ├─ Credential Broker
        ├─ Approval
        └─ Audit Log
        │
        ▼
Shell / Git / Network / Deploy / Secrets

权限应按能力拆分，而不是只有 Manual/Auto：

capabilities:
  repository_read: allow
  workspace_write: ask
  dependency_install: ask
  external_network: ask
  process_control: ask
  cross_workspace_access: deny
  credential_access: deny
  deployment: deny

策略合并遵循：

deny > ask > allow

企业策略、安全 Hook 或分类器返回 ask，Auto Mode 不能再将其降级为 allow。

Shell 命令需要先解析为规范化语义，而不是简单匹配字符串：

Shell Text
→ Shell-specific Parser
→ Expansion / Canonical AST
→ Capability Classification
→ Path Boundary Validation
→ Policy Decision

解析置信度低、命令过长、包含复杂重定向或未知语义时，默认回退到 ask。

4. Tool、MCP、Skill 和 Plugin 是新的供应链

未来 Agent 不会只调用几个内置工具，而会动态发现和加载：

MCP Server；
Skills；
Plugins；
Browser Tools；
企业内部能力；
第三方 Registry 资源。

不要一次性把所有工具塞进上下文。正确流程是：

Task
→ Search Capabilities
→ Verify Registry Record
→ Activate Scoped Tools
→ Request Capabilities
→ Audit Usage

每个工具需要 Capability Manifest：

tool:
  id: github-pr-review
  version: 1.4.2
  publisher: verified-company
  source: enterprise-registry
  digest: sha256:...

  capabilities:
    - repository_read
    - pull_request_write

  scope: session
  network:
    allowed_hosts:
      - api.github.com

  filesystem:
    read:
      - workspace
    write: []

  risk: medium

必须防止：

模型凭空猜出包名、仓库名、Skill 名；
同名资源被攻击者抢注；
MCP 配置修改后继续沿用旧信任；
Repo 中提交的 .mcp.json 自动获得权限；
Skill 自动写入长期配置；
插件从未知 Marketplace 安装。

推荐做法：

Exact registry resolution；
Publisher 验证；
Digest 和签名验证；
配置、命令或资产指纹变化后重新审批；
新版本冷却期；
未验证资源先进入临时沙箱运行探针；
execute 工具默认隐藏，仅在显式 Code Mode 中开启。
5. Orchestrator 必须是确定性状态机

不应让模型自行决定：

是否需要测试；
是否需要 Review；
是否可以完成任务；
是否应该创建 PR；
是否应该部署。

这些都属于 Orchestrator 的职责。

推荐状态机：

Goal Intake
→ Planning
→ Plan Approval
→ Implementation
→ Deterministic Build
→ Deterministic Test
→ Security Scan
→ Independent Review
→ Remediation
→ Reverification
→ Draft PR
→ Human Gate
→ Complete

模型可以提出建议，但不能跳过系统门禁。

type GoalPhase =
  | "planning"
  | "implementation"
  | "build"
  | "test"
  | "security_review"
  | "independent_review"
  | "remediation"
  | "reverification"
  | "awaiting_human"
  | "completed"
  | "failed";

Completion 只能读取结构化 Verification Artifact，不能相信自然语言中的“测试已通过”。

6. Model Router 不能只比较价格与 Benchmark

未来框架一定是多 Provider、多模型的。模型路由需要考虑：

Coding 能力；
推理能力；
延迟；
成本；
Tool Calling 协议；
是否要求保留 reasoning history；
是否允许中途切换模型；
Compaction 兼容性；
Context Window；
最大输出；
数据边界；
是否通过当前 Harness 回归测试。

推荐维护 Model-Harness Compatibility Manifest：

models:
  provider/model-version:
    context_window: 272000
    max_output_tokens: 32000

    protocol:
      api: responses
      tool_call_replay: required
      preserve_reasoning_history: false

    session:
      mid_session_switch: supported
      compaction_strategy: canonical-summary

    verified_profiles:
      - builder
      - reviewer

    regression_suite:
      version: harness-regression-v12
      passed: true

模型切换原则：

兼容模型可以在 Session 内切换；
不兼容模型应 Fork 新 Session；
Provider-specific reasoning state 应保存在 Adapter 私有状态中；
不应把一个模型的私有推理格式直接交给另一个模型。

建议用能力别名而不是模型名：

routing:
  searcher: cheap-fast
  builder: strong-coding
  reviewer: strong-reasoning
  security_reviewer: high-assurance
  summarizer: cheap-fast
7. Context、Compaction 与 Memory 必须分层

不要把所有信息都永久追加进 Prompt，也不要把 Agent 总结自动写进长期 Memory。

推荐五层：

1. Turn Context        当前一次调用
2. Session Memory      当前任务状态
3. Workspace Knowledge 项目级知识
4. User Memory         用户明确确认的偏好
5. Organization Policy 签名、只读的企业策略

每条 Memory 应带来源和信任等级：

type MemoryEntry = {
  content: string;
  source: string;
  trust: "trusted" | "derived" | "untrusted";
  createdBySession?: string;
  approvedByUser: boolean;
  expiresAt?: string;
  digest: string;
};

规则：

Web、Issue、PR、MCP Result 默认不可信；
Agent 自动总结属于 derived；
不可信内容不能自动进入持久 Memory；
企业安全策略不可由 Agent 修改；
Memory 修改需要 Diff 与人工确认；
Memory 支持 TTL 和删除；
大型工具结果外置到 Artifact Store，Prompt 中只放摘要和引用。

Compaction 前后必须校验不可变状态：

type CompactionInvariant = {
  sessionId: string;
  goalDigest: string;
  activePlanDigest: string;
  changedFilesDigest: string;
  pendingPermissionIds: string[];
  workspaceId: string;
  lastVerifiedCommit?: string;
};

如果压缩后这些字段发生变化，应拒绝继续执行。

8. Multi-Agent 应是受预算约束的 DAG，而不是自由递归

多 Agent 的正确形态不是：

Agent 随意创建 Agent
→ Agent 再创建 Agent
→ 无限扩展

而是有界 DAG：

Goal
├─ Search Task
├─ Build Task
│  ├─ Frontend Patch
│  └─ Backend Patch
├─ Review Task
└─ QA Task

每次 Spawn 必须声明：

type SpawnAgentRequest = {
  parentAgentId: string;
  role: "search" | "build" | "review" | "qa";
  objective: string;
  expectedArtifact: string;

  depth: number;
  maxTurns: number;
  maxCostUsd: number;
  requestedCapabilities: string[];
};

硬限制：

subagents:
  max_depth: 2
  max_children_per_agent: 3
  max_total_agents: 8
  max_total_cost_usd: 5
  max_tool_calls_per_agent: 40

  spawn_permission_default: deny
  inherit_parent_permissions: false
  require_expected_artifact: true

子 Agent 默认不应拥有继续 Spawn、Deploy、Secrets 或跨工作区权限。

9. Verification 必须独立于 Builder

最大的质量风险之一是：

Builder 写代码
→ Builder 写测试
→ Builder 运行自己的测试
→ Builder 宣布成功

代码与测试可能共享同一个错误假设。

推荐角色隔离：

profiles:
  builder:
    can_write_code: true
    sees:
      - specification
      - repository
      - visible_tests

  test_generator:
    can_write_tests_only: true
    cannot_see_builder_reasoning: true

  reviewer:
    read_only: true
    fresh_context: true
    starts_from: diff

  security_reviewer:
    read_only: true
    network: deny
    fresh_context: true

验证源应来自可信 base commit，而不是由候选分支自己定义：

verification:
  verifier_source: trusted_base_commit
  candidate_source: agent_worktree

  protected_paths:
    - ci/trusted-gates/**
    - security/policies/**
    - verification/schema/**

Review 也必须提供执行证据：

type ReviewEvidence = {
  diffReadProof: string;
  inspectedFiles: string[];
  verificationArtifacts: string[];
  reverseAuditHypotheses: string[];
  verdict: "approve" | "request_changes" | "inconclusive";
};

Finding 应有生命周期，而不是一段 Markdown：

Detected
→ Drafted
→ Verified
→ Published
→ Addressed
→ Reverified
→ Closed

只有经过验证的高严重度 Finding 才能阻塞 PR。

10. Observability、Cost 与 Artifact 是 Runtime 的一等对象

Agent Runtime 至少需要三套输出：

Runtime Activity

当前 Agent 在做什么：

type RuntimeActivity = {
  activeTaskId?: string;
  activeToolCallId?: string;
  nestedAgents: Array<{
    id: string;
    parentId?: string;
    status: string;
  }>;
  waitingForPermission: boolean;
  lastHeartbeatAt: string;
};
Runtime Event Stream

完整审计流：

模型路由；
工具调用；
权限审批；
子 Agent；
Checkpoint；
Artifact；
验证；
PR 创建。

支持 JSONL、OpenTelemetry、SIEM Webhook。

默认只记录 metadata，不记录完整 Prompt、Tool Output、Secrets 或环境变量。

Artifact Store

代码 Diff、日志、测试报告、截图和 Session Report 不应混在消息中。

推荐使用 content-addressed storage：

type AgentArtifact = {
  digest: string;
  kind:
    | "diff"
    | "tool_output"
    | "log"
    | "test_report"
    | "screenshot"
    | "session_report";

  originalSize: number;
  compressedSize: number;
  references: string[];
  expiresAt?: string;
};

最终生成 Episode Manifest：

type EpisodeManifest = {
  sessionId: string;
  goalId: string;
  repositoryId: string;
  workspaceId: string;

  baseCommit: string;
  finalCommit?: string;

  artifacts: AgentArtifact[];
  verificationResults: VerificationResult[];
  permissionEvents: PermissionEvent[];
  costTrace: CostTrace;

  integrityStatus: "valid" | "partial" | "corrupted";
};

预算也不能只统计 Token，还应包含：

Web Search；
Tool Calls；
Subagent 数量；
并发数；
Runtime；
Network；
Storage；
Verification；
Retry。
11. CI/CD 与企业治理必须从一开始设计

Agent 进入 GitHub Actions、远程 Runner 和企业开发机后，需要处理：

最小权限 Token；
Fork PR 不可信输入；
Issue、PR 评论到 Shell 的 taint；
GitHub Action SHA pinning；
依赖冷却期；
Secret Scan；
Runner Egress；
Managed Settings；
Telemetry Manifest；
Marketplace allowlist；
Server-scoped permissions。

企业策略优先级可以设计为：

Native MDM
→ Organization-managed
→ File-based Managed Settings
→ Workspace Policy
→ User Local Config

普通用户不能覆盖高优先级安全策略。

二、最推荐的整体架构

未来最合理的形态不是多个 UI 各自实现 Agent，而是一个 Headless Runtime Daemon，所有客户端连接同一个内核：

┌─────────────────────────────────────────┐
│ Clients                                 │
│ TUI / Web / Desktop / IDE / CI / Mobile │
└───────────────────┬─────────────────────┘
                    │ JSON-RPC / HTTP / SSE / ACP
                    ▼
┌─────────────────────────────────────────┐
│ Runtime Daemon / Control Plane           │
│                                         │
│  Session API    Runtime Activity         │
│  Permission UI  Artifact API             │
│  Event Stream   Cost Dashboard           │
└───────────────────┬─────────────────────┘
                    ▼
┌─────────────────────────────────────────┐
│ Deterministic Orchestrator               │
│ Goal State Machine / DAG / Budgets       │
└──────┬──────────┬──────────┬────────────┘
       │          │          │
       ▼          ▼          ▼
 Session      Model       Workspace
 Kernel       Router      Manager
 Event Log    Adapters    Git Worktrees
 Checkpoint   Compat      Sandbox
 Memory       Registry    Executors
       │          │          │
       └──────────┼──────────┘
                  ▼
┌─────────────────────────────────────────┐
│ Capability Gateway                      │
│ Policy / Identity / Approval / Secrets  │
└───────────────────┬─────────────────────┘
                    ▼
┌─────────────────────────────────────────┐
│ Tool Runtime                            │
│ Native Tools / MCP / Browser / CodeMode │
└───────────────────┬─────────────────────┘
                    ▼
┌─────────────────────────────────────────┐
│ Verification Pipeline                   │
│ Build / Test / Security / Review / QA   │
└─────────────────────────────────────────┘

关键原则是：

UI 无状态或轻状态；
Runtime 是唯一真实来源；
Agent 不直接接触高风险工具；
Verification 不由 Builder 控制；
每个工具调用都有 Session、Workspace 和 Capability 身份；
所有状态变化都进入 Event Log。
三、推荐的工程实现方式

如果是在构建 allthecodes 一类跨平台产品，推荐先做模块化单体 Daemon，而不是一开始拆微服务。

一个合理的目录结构：

crates/
  runtime-core/          状态机、Session、事件
  session-store/         Event Log、Checkpoint、Rewind
  workspace-manager/     Git Worktree、Sandbox、Executor
  policy-engine/         Capability Policy
  capability-gateway/    工具授权与凭据代理
  model-router/          Provider、模型兼容、路由
  tool-registry/         Native/MCP/Skill/Plugin
  context-engine/        Compaction、Memory、Knowledge
  orchestrator/          DAG、预算、Subagent
  verifier/              Build/Test/Security/Review
  artifact-store/        CAS、Retention
  telemetry/             OTel、Cost、Audit

apps/
  daemon/
  tui/
  web/
  desktop/
  ide-companion/
  ci-runner/

adapters/
  mcp/
  acp/
  openai-compatible/
  anthropic/
  local-model/

推荐技术策略：

Runtime Core 使用适合并发、跨平台和进程管理的系统语言；
本地版可先使用 SQLite WAL 保存事件与元数据；
团队版切换到 PostgreSQL；
Artifact 本地使用内容寻址文件系统，团队版使用对象存储；
Web/Desktop 通过 HTTP + SSE 或 WebSocket；
IDE/TUI 可使用 JSON-RPC 或 stdio；
高风险工具通过单独进程执行；
Code Mode 使用 WASI、Deno 或受限容器，而不是直接开放主机 Bash；
Linux 优先容器沙箱，macOS/Windows 使用对应系统沙箱或远端 Executor。
四、标准 Coding Agent 执行闭环

推荐每个任务都遵循同一生命周期：

1. Goal Intake
2. 输入来源标记与 Taint 分析
3. 创建 Session、Budget、Branch、Worktree
4. 只读 Plan Agent
5. 人工或策略批准 Plan
6. Orchestrator 生成 Task DAG
7. Builder 在隔离 Worktree 执行
8. 工具调用经过 Capability Gateway
9. 确定性 Build/Test
10. 独立 Test Generator
11. 独立 Reviewer
12. Security Reviewer
13. 有界 Remediation Loop
14. Reverification
15. 创建 Draft PR
16. 附加 Session Report、Cost Trace、Evidence
17. 人工 Merge Gate
18. 生成 Episode Manifest
19. 清理或归档 Workspace
五、应该写死在 Runtime 中的硬约束

下面这些不能只写在 Prompt 中：

没有 Workspace Envelope，不允许任何 Tool Call。
Agent 自述“测试通过”不能标记 Verification Pass。
模型猜出的包、仓库、MCP、Skill 不允许直接安装。
Repo 提交的 MCP、Instruction 或 Plugin 配置默认不可信。
Instruction 文件变更不能由同一个 Agent 自我批准。
Subagent 默认不能继续 Spawn Agent。
用户主动停止的任务不能自动恢复。
高风险工具不能直接获得长期凭据。
模型切换必须通过 Compatibility Check，否则 Fork Session。
不可信内容不能自动进入持久 Memory。
Verification Gate 使用可信基线，不允许候选分支修改评分器。
Session Completion 必须拥有完整 Evidence 与 Episode Manifest。
六、推荐落地顺序
第一阶段：单 Agent 先做到可靠

优先完成：

Session Event Log；
Worktree 隔离；
Capability Policy；
Provider Adapter；
Tool Registry；
Budget Guard；
Deterministic Build/Test；
Runtime Event Stream；
Artifact Store；
Checkpoint/Rewind。

在这一阶段不要急着做复杂多 Agent。

第二阶段：建立质量闭环

加入：

独立 Reviewer；
Test Generator；
Security Gate；
Browser Verification；
PR Finding 生命周期；
Episode Manifest；
Harness Regression CI。
第三阶段：再做 Multi-Agent

加入：

Task DAG；
有界 Subagent；
角色隔离；
子 Agent Capability 子集；
Partial Result；
Loop Breaker；
并发与总预算。
第四阶段：客户端和远程执行

再扩展：

TUI；
Web；
Desktop；
IDE Companion；
CI Runner；
Local/SSH/Relay Executor；
Session Handoff；
Mobile Notifications。
第五阶段：企业治理和自我优化

最后加入：

MDM / Managed Settings；
SIEM / OTel；
Marketplace allowlist；
Cost Center；
Persistent Memory；
Harness Experience；
自动 Harness 优化。

自动学习得到的规则不能直接提升为全局策略，应经过：

Case Rule
→ Repository Rule
→ Repeated Validation
→ Regression Suite
→ Global Rule
七、最容易犯的错误

构建时应主动避免：

先做漂亮 UI，再补 Runtime；
把权限全部写进 System Prompt；
让 Builder 决定是否需要验证；
一个 Session 多个 Agent 共用同一主工作区；
一次加载几十个工具；
自动持久化 Agent 生成的 Memory；
使用具体模型名散落在业务代码中；
允许 Repo 配置自动启用 MCP；
失败的子 Agent 被标记为 completed；
把完整 Prompt 和工具输出写进日志；
无限制保存所有 Session 历史；
一开始就构建复杂分布式多 Agent 平台。
最终建议

最适合未来 Coding Agent 的框架，不应定位成：

“一个能调用多种模型的聊天应用。”

而应定位成：

一个支持多模型、多客户端、多工作区和多 Agent，但由确定性 Orchestrator、独立 Capability Gateway、强制 Verification Pipeline 和可审计 Session Kernel 管理的工程 Runtime。

它的长期核心资产也不是某个 Prompt，而是以下五部分：

Session Integrity
Workspace Isolation
Capability Security
Verification Evidence
Harness Regression

只要这五层设计正确，未来接入新的模型、MCP、桌面端、远程 Executor、浏览器工具或多 Agent 调度，都只是扩展适配器；如果这五层缺失，再强的模型最终也会变成一个昂贵、不可控、无法证明正确性的自动化脚本。