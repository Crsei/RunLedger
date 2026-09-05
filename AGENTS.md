# RunLedger Agent 工作约定

RunLedger 是面向可审计 Agent 执行的运行时。标准 CLI 通过 Bun 加载 `dist`，使用 session-scoped embedded Session Owner Runtime 与用户级 SQLite authority；TUI 消费 command/query/subscription。

本文件只维护行动规则、工程约束和文档入口。实现细节、里程碑、测试数量与验收证据归对应专题；判断当前状态时核对当前工作树、生产接线和实际验证结果。

## 1. 自主推进与任务边界

- 根据用户当前要求和已有上下文判断目标及范围。“帮助实现”“修复”“清理”等请求就是执行授权；完成实现、必要验证和交付，不停在能力确认、计划或“是否继续”。
- 常规实现细节自行作出合理选择。只有答案会实质改变目标、兼容性、数据处理或不可逆操作时才提出有针对性的问题；等待期间继续不依赖答案的工作。
- 会话中已经获得的授权持续有效，不重复确认。需要最终批准的操作，先完成已授权的准备工作，让用户审查具体结果；任务完成后的自动提交与推送遵守第 7 节。
- 用户补充要求时合并进当前任务；旁支问题简短回答后继续主任务。只有明确取消或替换目标时才放弃原任务。
- `review`、“只读检查”“分析日志”按只读范围执行，先查证据，不自动改代码。发现范围外问题，记录具体影响，不顺带扩展专项。
- 尊重共享工作树：先检查分支、暂存区和未提交改动；基于已有修改继续，不覆盖、回滚或收走其他任务的工作。

### 指令与 Skill

遵守系统和开发者约束；在其允许范围内，用户明确指令优先于 Skill 指南。历史文档中的步骤、示例和验收快照不自动成为当前任务指令。

只读取与任务相关的 Skill 和专题。若某条 Skill 导致请求确认、暂停或无法完成，指出并链接确切 `SKILL.md`，引用相关条款，说明适用原因，并区分明确要求与自己的解释。不要把模糊建议自行升级成审批门禁。

### 协作与沟通

- 在当前环境允许委派时，只委派可独立执行、有清晰交付物、能节省时间或提高质量的子任务；明确文件边界，主 Agent 继续推进其他工作并负责整合验证。简单修改直接完成。
- 开发助手的委派规则与 RunLedger 产品内的 bounded multi-agent 能力是不同层面的约束，不因开发工具支持并行而扩展产品能力。
- 默认用简洁中文段落，先说结果或下一步，再给必要依据。并列步骤或对比确实更清晰时才用列表或表格。
- 进度更新说明新发现、剩余不确定性和下一步；避免重复播报等待状态、套话、夸张措辞和无关技术细节。Agent 间消息同样应清晰易读。
- 最终说明完成了什么、如何验证，以及仍存在的实际阻碍或验收缺口；不要把未执行的测试写成通过。

## 2. 不可顺带突破的工程边界

### Sandbox

当前项目**不在开发任何与 sandbox 有关的代码**。现有 `src/security/sandbox/`、Linux bwrap 及其调用链仅作为既有运行时实现保留；除非用户后续明确启动独立 sandbox 专项，否则不得新增、扩展、移植、重构或在其他任务中顺带修改 OS sandbox、文件系统/网络 namespace、进程隔离等相关实现，也不得把一般的 Security、ExecutionGateway 或进程治理工作宣称为 sandbox 开发。

### Runtime 与权限

- 标准 CLI 使用 Session Owner Runtime；旧 Host 的移除与验收按 Runtime 06 推进，不恢复旧 Host 或 mock 作为生产 fallback。
- 工具副作用继续经过 Security/ExecutionGateway、Attempt Gateway 与 owner fence。保持 fail closed，不通过 raw I/O、AllowAll 或绕过治理让测试通过。
- 平台差异经 `src/workspace/` adapter 处理；业务模块不新增 `process.platform` 分支，平台选择收敛到 `factory.ts` / `runtime-platform.ts`。
- 公共 workspace DTO 只暴露 digest / locator；native path 保留在运行时私有上下文。
- 产品内 child 委派保持默认关闭、root-owned sequential readonly、depth=1、同一 root 最多一个 child；并行、可写工作区、递归委派与扩展能力按 Runtime 08 的非目标边界处理。
- Harness Profile 在 Session 创建时冻结，fork 继承；`minimal@1` 仅暴露 governed `bash` / `edit`，不装配模型侧扩展或 child。Profile 不改变权限 authority。

### 用户数据与配置

- canonical home 由 composition root 解析一次：`RUNLEDGER_DIR` 必须是既有绝对目录，否则默认 `~/.runledger`；消费注入的 `RunledgerLayout`。
- 不恢复项目 `.runledger/`、旧 `~/.runledger/agent/` 或任意 session 路径作为隐式 authority；`settings.sessionDir`、`RUNLEDGER_SESSION_DIR`、`--session-dir` 保持拒绝。
- 旧数据迁移必须走显式迁移入口与确认参数；不新增猜测格式、静默 import 或 fallback。迁移方式及验收查 Storage/CLI 专题。
- recording 仅由用户级 settings 授权，默认 `off + best_effort`；不把本地 Trace 当作远程 exporter、OTLP 或已完成 Opik 接线。
- `resolve-config-value.ts` 仅支持字面值与 `${ENV_VAR}`，不引入 `$(cmd)` 执行。
- 测试始终使用隔离 `RUNLEDGER_DIR`，不得操作真实用户目录或复制真实凭据到测试目录。

## 3. 工具使用

- 搜索优先 `rg` / `rg --files`；无依赖的搜索和读取可批量执行，编辑与依赖后续结果的操作顺序执行。
- 遵守用户级 `AGENTS.md` 中的 Boost 暂停与异步等待规则。暂停期间不调用、重启、重新启用或探测 `boost`、`codex-skills`、`agent-skills`，不手动启动 Boost bridge / daemon；用内置文件和 shell 工具处理。`allthecodes-bridge` 不属于此次暂停。
- 外部 MCP 失败、超时或不可用时，及时回退到内置工具；不重复重试而阻塞任务。
- 长任务在工具支持的情况下异步运行，等待期间推进独立工作；遵守当前工具及上级指令的等待限制，不靠高频空轮询获取进度。
- shell 参数按 shell 规则引用；不要把 JSON 编码当 shell 转义，避免反引号或 `$()` 意外执行。多行提交/PR 文本通过文件或结构化参数传递。

## 4. 代码约定

- TypeScript strict，`verbatimModuleSyntax: true`；类型使用显式 `import type`。
- 只使用可擦除 TS 语法：禁止 `enum`、`namespace`、`import =`、`export =`、参数属性；类字段显式声明和赋值。
- 相对导入带 `.ts` 后缀，构建时重写为 `.js`；使用 NodeNext module / moduleResolution。只用顶层 import，不使用内联 `await import()`。
- 禁止 `any`；确有充分理由时紧邻添加 `// why any` 说明。保持现有 tsconfig 约定，不顺带启用装饰器或修改严格性选项。
- 异步工具方法通过 `stopReason: "error"` 或 `{ ok: false }` 返回错误，不向调用方抛出。
- 注释用简洁中文说明必要的技术原因，不加 emoji 或堆砌形容词。
- 依赖沿用仓库版本约束；`package-lock.json` 与代码一样审阅。模型 catalog 经 `npm run generate-models` 生成，审阅源数据与生成物，不只手改生成文件。

## 5. 验证与完成标准

根据变更影响选择测试，优先验证实际行为和故障路径。低影响、可逆、只能重复实现逻辑的修改不专门增加测试；缺陷修复应尽可能先复现，并加入有意义的回归覆盖。

| 变更范围 | 必需验证 |
|---|---|
| 纯文档 / 指令整理 | 审阅差异、检查链接与规则一致性、`git diff --check`；无需代码测试或构建 |
| 代码修改 | `npm run check` 与受影响的测试；完整保留 check 输出，不截断 |
| 进入 `dist/` 的代码 | 上述检查 + `npm run build` + 真实 `runledger` 对应路径验证 |
| 模型 catalog / provider 增删 | 先 `npm run generate-models`，审阅生成差异，再做对应代码验证 |
| 提交代码、测试、生成物或依赖变更 | 完成对应验证，通常依次执行 `npm run check` 与 `npm test` |

修复本任务引入的 error / warning / info。若检查被无关既有问题阻塞，明确记录证据和影响，不为通过检查擅自扩大修改范围，不伪造通过状态。

同一工作树状态下已通过的检查不用重复执行；只有新增修改、测试失败、尚未解决的疑点或专题明确要求时才扩大验证。按 `package.json` 当前脚本选择测试入口，不依赖旧文档中的测试数量。

### 真实 CLI / TUI 验证

`bin/runledger.js` 加载 `dist/cli/cli.js`，不直接运行 `src`。修改运行时代码后先构建，再用 `command -v runledger`、`readlink -f` 和 `npm ls -g --depth=0` 确认实际入口；本机预期 `~/.npm-global/bin/runledger` 链接到本仓库。缺失或错误时按任务所需修复 `npm link`。

使用新建的绝对路径临时目录作为 `RUNLEDGER_DIR`，通过真实 TTY 或独立命名的 tmux 会话验证相关交互。TUI 先 Esc 逐级关闭弹窗，再 Ctrl+D 干净退出；确认退出后只清理本任务会话和临时产物。无法完成时说明具体阻碍。

自动化、构建后的 CLI、真实外部 provider、人工视觉/键盘/中文 IME、macOS/Windows runner 是不同证据。Linux、mock、PTY 或 tmux 捕获通过不等于 human-verified 或 cross-platform verified；专题中的 pending 门禁只能由对应证据关闭。

## 6. 文档与事实入口

先读 [开发索引](development-doc/00-index.md)，再按任务阅读对应专题。原地维护已有权威文档；新增专题时更新所属 README 和总索引，避免创建重复状态文件。历史数量、旧路径与早期 pi 移植说明不代表当前完成状态。

| 主题 | 入口 |
|---|---|
| 当前运行与结构审计 | [审计入口](development-doc/audit/README.md) |
| 公共 contract / schema / 数据结构 | [Runtime 04](development-doc/runtime/04-governed-agent-harness-runtime-plan.md) |
| Session Owner、生产接线与 R8/R9 验收 | [Runtime 06](development-doc/runtime/06-session-owner-runtime-replacement-plan.md) |
| 产品内 bounded multi-agent | [Runtime 08](development-doc/runtime/08-bounded-multi-agent-system-plan.md) |
| Minimal Harness Profile | [Runtime 09](development-doc/runtime/09-minimal-harness-profile-implementation-plan.md) |
| 用户级存储与迁移 | [Storage/CLI handoff](development-doc/storage-cli/02-user-home-migration-handoff.md) |
| Workspace 平台证据与缺口 | [平台验收缺口](development-doc/worktree-sandbox-permisson/evidence-verification-gaps.md) |
| Provider 移植、partial / deferred 边界 | [Provider 清单](development-doc/providers/02-oh-my-pi-provider-port-execution-checklist.md) |
| Trace 远程导出计划 | [Opik exporter](development-doc/runtime/trace/phase-04-opik-exporter-tree.md) |
| Forward proxy gateway | [Gateway 计划](development-doc/plan/11-forward-proxy-gateway-plan.md) |
| TUI | [TUI 专题入口](development-doc/tui/00-overview.md) |

本文件行动风格参考 [GPT-6 Astra 官方指南](https://developers.openai.com/api/docs/guides/latest-model?model=gpt-6-astra) 的 prompting 建议；API 参数、模型选择和运行时能力由相应实现与配置决定。

## 7. Git 提交与推送

**每次任务完成、必要验证通过且没有明确需要用户确认的事项时，自动执行 `git commit`，无需再次询问提交许可。只有用户明确要求推送时才推送。** 只提交本任务改动，不把 `git status` 中全部文件视为任务范围。

用户明确要求不提交、仅做只读检查，或仍有待确认事项时，不自动提交；没有本任务改动时不创建空提交。验证失败或提交受阻时先处理可解决的问题，无法解决则说明具体原因，不将任务报告为已完成。

提交前确认仓库、分支、状态与身份：`git status --short`、`git branch --show-current`、`git config --get user.name`、`git config --get user.email`。身份缺失或不正确时请求明确授权，不能从其他仓库复制配置。

审阅 `git diff --check` 与本任务逐路径 diff，完成第 5 节验证后再暂存：

- 新增/修改使用 `git add -- <explicit-paths>`；新增模块可指定本任务的新目录。
- 删除使用 `git add -u -- <deleted-paths>`；重命名拆成新增目录与删除旧文件时分别暂存。
- 审阅 `git diff --cached --name-status`、`git diff --cached --check` 和完整 staged diff，确认没有混入既有暂存改动；已有他人暂存内容时使用明确路径的提交方式，只提交本任务内容。
- 每个 commit / PR 聚焦一件事，说明问题、修改目的和必要验证。完成后检查 `git status --short` 与 `git log -1 --oneline`。

禁止 `git add -A`、`git add .`、`git commit -a`、`--no-verify`、`git reset --hard`、`git checkout .`、`git stash`，不借用其他仓库的提交脚本。

推送前核对 `git remote get-url origin` 和目标分支；预期 origin 为 `https://github.com/Crsei/RunLedger.git`，以当前配置为准。只推送已授权分支。

认证不可交互时使用现有受控凭据或临时 `GIT_ASKPASS`：关闭 xtrace，帮助程序权限 `700`，设置 `GIT_TERMINAL_PROMPT=0`，结束后删除帮助程序。不得读取、打印、复制或暂存 token、密码或凭据文件。
