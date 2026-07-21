# 实现计划:补建 pi 用户层/项目层(项目层为重)+ `runledger` CLI 起动 TUI

> 文档属性:历史实施计划。原始来源:`.zcode/plans/plan-sess_43a5be3a-b430-4147-a81c-490636aafd5b.md`。
> 本文覆盖项目层路径、settings、session manager、CLI 与 TUI 装配;已落地事实与后续项汇总见 `../project-cli-layout.md`。

## 范围与确认的设计决策

- **信任**:`settings.json` + 层级向上扫 `AGENTS.md`(到 fs root),不做 pi 的 trust-manager/ProjectTrustStore。
- **项目层资源**:本期**只补 `settings.json`**(不实现 extensions / skills / prompts / themes)。
- **Session 落盘**:默认 `<cwd>/.runledger/sessions/`,可由 `<cwd>/.runledger/settings.json#sessionDir` 覆盖(支持项目内、用户层绝对路径、`.`)。覆盖默认路径未指定时回退用户层 `~/.runledger/agent/sessions/--<encoded-cwd>--/`。
- **TUI**:InteractiveMode 仍接 pre-assembled Agent;新建 `src/cli/main.ts` 负责把 SessionManager + SettingsManager + Agent 装配好后传入。
- **样式**:沿用 RunLedger 既有中文注释风格、`erasableSyntaxOnly`、相对路径含 `.ts` 后裔、`import type` 严格模式。

---

## 目录结构(目标)

新建文件全部在 `src/storage/` + `src/cli/` + `examples/` 下;不破坏任何已有运行时/工具实现。

```
src/storage/
  paths.ts(*扩*)          用户层 + 项目层 + sessionDir 解析
  settings-manager.ts(*新建*)  Settings schema + loadMerge() + deepMergeSettings
  session-manager.ts(*新建)    SessionManager: cwd / sessionDir / create / open / continueRecent / list / forkFrom + readSessionHeader + encodeCwd + 文件名
  path-utils.ts(*新建)         encodeCwd / 默认 sessionDir 解析(纯函数,不引 fs,便于单测)
src/cli/
  args.ts(*新建)           argv 解析(本期旗标见下)
  main.ts(*新建)           极薄入口(<120 行)
  cli.ts(*新建)           bin 入口(只 import 并调 main)
examples/
  tui-demo.ts(*改造)       改为装配 SessionManager + SettingsManager 后再起 InteractiveMode,保留 mock 回退
tests/storage/
  paths.test.ts(*新建)
  settings-manager.test.ts(*新建)
  session-manager.test.ts(*新建)
tests/cli/
  args.test.ts(*新建)
package.json(*修改)
  新增 `"bin": { "runledger": "dist/cli/cli.js" }`
  新增 `"scripts.start": "tsx src/cli/cli.ts"`
  exports 补 `./cli/*`、`./storage/*`(已存在,保留)
tsconfig.json(*可能微调)   cli 与 storage 需在 build 输出内
```

**最终布局示例**(项目里跑一次 `runledger` 后的落盘样子):
```
/<cwd>/.runledger/
  settings.json             (可选,用户手动写或写 demo 创建)
  sessions/                 (默认 sessionDir)
    2026-07-20T16-42-33-079Z_019dcaab-....jsonl

~/.runledger/agent/
  auth.json                 (已存在)
  settings.json             (可选,本期不修正 schema)
  AGENTS.md                 (可选,全局用户 AGENTS,加入到 systemPrompt 头部)
  sessions/
    --C--Users-foo-projects--/     (当 sessionDir 未设时退回)
      2026-07-20T16-42-33-079Z_*.jsonl
```

---

## §0 路径层 `src/storage/paths.ts` 扩展

补充函数(保留现有 `getAgentDir` / `getBinDir`):

```ts
getProjectDir(cwd?: string): string           // join(cwd ?? process.cwd(), ".runledger")
getProjectSettingsPath(cwd?)                  // join(getProjectDir(cwd), "settings.json")
getProjectSessionsDir(cwd?)                   // join(getProjectDir(cwd), "sessions")
getSessionPath(cwd?, opts?)                    // settings.sessionDir 覆盖 → path.resolve(cwd,sessionDir);默认 getProjectSessionsDir(cwd);env RUNLEDGER_SESSION_DIR 单独覆盖
getUserSessionsDir()                          // join(getAgentDir(), "sessions")
getDefaultSessionDirForCwd(cwd)              // 走 cwd encoded 子目录布局 = join(getUserSessionsDir(), encodeCwd(cwd))
getGlobalAgentsMd()                           // join(getAgentDir(), "AGENTS.md") (可选)
```

环境变量 `RUNLEDGER_SESSION_DIR`(单个项目覆盖 session dir,与 pi 的 `PI_CODING_AGENT_SESSION_DIR` 对应)

新建 `src/storage/path-utils.ts`(纯函数,不引 fs 便于单测):
```ts
encodeCwd(cwd: string): string                // `--${cwd.replace(/^[/\\]/,"").replace(/[/\\:]/g,"-")}--`
buildSessionFileName(date?: Date, id?: string): string  // `<ISO-ts(派:>_<id>.jsonl`
ISO 时间戳做处理:`:` 与 `.` 全换 `-`
```

---

## §1 Settings 模块 `src/storage/settings-manager.ts`

最小精简版,不引 trust,不做 deepMergeSettings 的复杂嵌套展开:

```ts
export interface ProjectSettings {
  model?: string;  // 模型 ID 指定
  thinkingLevel?: ThinkingLevel;  // minimal|low|medium|high
  theme?: "dark" | "light";
  sessionDir?: string;  // 相对或绝对,默认 ".runledger/sessions";"."=项目根
  enabledModels?: string[];  // /model 选择器可见白名单
}

export interface SettingsManager {
  project(): ProjectSettings;  // 解析自 <cwd>/.runledger/settings.json,不存在返回 {}
  toString(): string;
}
```

实现:
- `loadSettings(cwd?)` —— read 文件 + JSON.parse,缺失字段保持 {};**不**做 user 层 settings 合并(本期暂只项目),后期扩展。
- 模板解析能用 `resolve-config-value.ts` 已有的 `${VAR}` 解析。
- 写入 `saveProjectSettings(cwd, partial)`:fullFile write,带 `mkdir(dirname, {recursive:true})` 与 mode 0o600。

不做 pi 的 `defaultProjectTrust` / `compaction` / `retry` 等高级字段(全部纳入 `// TODO(pi):` 注释占位)。

---

## §2 Session Manager `src/storage/session-manager.ts`

**关键契约**:运行期 RunLedger 的 `LedgerSink`(见 `src/runtime/ledger/types.ts`)仍被复用,SessionManager 只是把 `JsonlLedger` 的 `filePath` 解析从外部传入改为内部生成 + 提供查询/列举能力。

实现采 SessionManagerInMemory + JsonlLedger 二级组合,而非 pi 那套独立 typed entry tree(本期不分叉、不摘要,见 AGENTS.md §1.3)。

```ts
export interface SessionManagerOptions {
  cwd: string;                                  // process.cwd() 快照
  sessionDir?: string;                          // 绝对路径,可不指定
  sessionId?: string;                           // 可指定 / continueRecent 会填
  metadata?: Record<string, unknown>;
  truncate?: boolean;
}

export class SessionManager {
  static async create(opts: SessionManagerOptions): Promise<SessionManager>;
  static async continueRecent(cwd: string, sessionDir?: string): Promise<SessionManager>;
  static async open(sessionPath: string): Promise<SessionManager>;
  static forkFrom(sourcePath: string, targetCwd: string, sessionDir?: string): Promise<SessionManager>;
  static async list(cwd: string, sessionDir?: string): Promise<SessionInfo[]>;
  static async listAll(sessionDir?: string): Promise<SessionInfo[]>;

  ledger(): JsonlLedger;                         // 返回已初始的 LedgerSink
  sessionId(): string;
  filePath(): string;
  closeAll(): Promise<void>;
}

export interface SessionInfo {
  id: string;
  filePath: string;
  createdAt: number;                             // header.createdAt
  cwd?: string;                                  // header.metadata.cwd
  modifiedMs: number;                            // 文件 stat
}
```

实现细节:
- `continueRecent`:调 `getSessionPath(cwd, sessionDir)` 取 dir → glob `*.jsonl` → 对每文件只读首行 header(本期先全读首行无加锁;1MB 限速与 pi 类似)→ 按 `cwd === args.cwd` 过滤(仅当 sessionDir 未显式指定且路径 = 默认 project 时不过滤,因本项目内 sessions/ 都是本项目)→ mtime 倒序取首条 → 用该路径 `JsonlLedger.open(path)` 初始化(继承已有 entries)。
- `open(path)`:`JsonlLedger` 已支持「文件已存在则继承 header + entries」(见 `ensureInitialized` 中 line 122-161)。SessionManager 是这层薄包装。
- `forkFrom(sourcePath, targetCwd, sessionDir)`:把源文件所有行复制到新路径(新建 header,`metadata.parentSession = sourcePath`),返回 SessionManager。
- 单文件首行读取 helper:catch 异常记 `lastError = e`,skip 该文件继续扫。
- SessionHeader 格式沿用 `LedgerHeader`(`type:"ledger", version:1, id, createdAt, sessionId, metadata`),`metadata.cwd` 在 create 时传入,便于 list 时 filter。

**不动 LedgerSink / JsonlLedger 协议**,新增能力仅放在 SessionManager 包装层,降低回归。

---

## §3 CLI 入口

### `src/cli/args.ts`

`parseArgs(argv: string[])`,手写解析,本期支持:

| 开关 | 缩写 | 类型 | 说明 |
|---|---|---|---|
| `--continue` | `-c` | boolean | continueRecent(默认 dir) |
| `--resume` | `-r` | boolean | list all from project dir,弹选择器(本期 placeholder:列出最后修改的一条) |
| `--session <path\|id>` |  | string | open by path 或 id prefix(本期只支持精确 path) |
| `--fork <path\|id>` |  | string | forkFrom 到当前项目 |
| `--session-id <id>` |  | string | 同 --session,但按精确 id 匹配 |
| `--model <id>` | `-m` | string | override settings.model 做模型查找 |
| `--thinking <level>` |  | minimal\|low\|medium\|high | 本期仅写入 footer,closure 不重接 streamFn(mark `// TODO(pi): M8e polish`) |
| `--debug` |  | boolean | `RUNLEDGER_DEBUG=1` stderr log |
| `--version` | `-v` | boolean | 打 version 退出 |
| `--help` | `-h` | boolean | 打 usage 退出 |
| `--session-dir <dir>` |  | string | 进程期内 OVERRIDE,优先级最高 |

未知 flag 收集到 `unknownFlags: Map<string, string|true>`,后续插件 TODO 用。

### `src/cli/main.ts` 流程(<120 行)

```
parseArgs → handle -h/-v → compute cwd/process.cwd()
if --debug: process.env.RUNLEDGER_DEBUG=1
const settings = await loadSettings(cwd)            // from settings-manager
const sessionPath:  --session 有值 → openSession(path)
                    --continue → SessionManager.continueRecent(cwd, sessionDirOverride)
                    --fork → SessionManager.forkFrom(source, cwd)
                    默认 → SessionManager.create({ cwd, sessionDir, metadata: { cwd } })
const ledger = await mgr.ledger()                    // JsonlLedger 实例,已 ensureInitialized
const modelId = args.model ?? settings.model ?? "mock"
const model = resolveModel(modelId)                 // 见下
const streamFn = chooseStreamFn(logger if RUNLEDGER_DEBUG, model)
const tools = stdlibRegistry(cwd).toContext()       // createStdlibTools(cwd)
const systemPrompt = await buildSystemPrompt(cwd)    // merge AGENTS.md ancestor链 + ~/.runledger/agent/AGENTS.md(可选)
const agent = new Agent({ initialState:{systemPrompt,model,tools}, streamFn, ledger, toolExecution:"sequential" })
const interactive = new InteractiveMode({ agent, modelRegistry, initialThinkingLevel, onThinkingChange })
await interactive.run()
finally mgr.closeAll()
```

注:**模型解析**本期采与 `examples/tui-demo.ts` 类似的策略:
- 有 `ANTHROPIC_API_KEY=xxx`,默认候选 = claude-sonnet-4-5/haiku/opus;settings.json 的 `enabledModels` 过滤可见项;
- 没有则回退 mock(`mockStreamFn + echoTool`),stderr 打 WARNING。
- `chooseStreamFn` + `createAnthropicAgent` 已在 `src/runtime/agents/create-anthropic-agent.ts` 实现,直接复用。

### `src/cli/cli.ts`(<10 行)

```ts
#!/usr/bin/env node
import { main } from "./main.ts";
process.title = "runledger";
main(process.argv.slice(2)).catch((e: unknown) => {
  process.stderr.write(`[runledger] fatal: ${String(e)}\n`);
  process.exit(1);
});
```

### `package.json`(已有内容不动,只追加)

```json
"bin": { "runledger": "dist/cli/cli.js" },
"scripts": {
  ...现有...,
  "start": "tsx src/cli/cli.ts"
}
```

需在 `exports` 里追加 `"./cli/*"` 让 dist 可被外部 import(本期不开 dash 用)。

---

## §4 TUI 装配改造:`examples/tui-demo.ts`

保留现状不动(作为纯 demo),但优化以下两点:
1. 复用 `src/cli/main.ts` 内已抽出的 `buildRuntime(opts) → { agent, modelRegistry, ... }` 函数,避免重复 planRuntime 逻辑;`examples/tui-demo.ts` 仅做 `npm run start` 的 escape hatch。
2. 在 `src/cli/main.ts` 中加上从 `examples/tui-demo.ts` 推出的 `mock 回退分支`(无 ANTHROPIC_API_KEY 时)与项目内 JsonlLedger 装载。

`InteractiveMode` API 不变,继续接 pre-assembled Agent;SessionManager 包装发生在 main.ts 层。

---

## §5 单测

新建以下测试,目标不破坏现有 35 测试绿:

### `tests/storage/path-utils.test.ts`(~4 测试)
- `encodeCwd` 几种路径格式(POSIX/Windows drive)
- `buildSessionFileName` ISO 时间无 `:/.` 字符,len 与 uuid 完整

### `tests/storage/paths.test.ts`(~3 测试)
- `getProjectDir` cwd === process.cwd() / 自定义 cwd
- `getSessionPath` 实现 settings.sessionDir 优先级 / 项目默认 / env 覆盖
- env `RUNLEDGER_DIR` 覆盖 `getAgentDir`

### `tests/storage/settings-manager.test.ts`(~3 测试)
- 加载已有 `<cwd>/.runledger/settings.json`
- 文件不存在返回 {}
- saveProjectSettings → reload 字段一致

### `tests/storage/session-manager.test.ts`(~6 测试)
- `create` 写文件 + 首行 header
- `open` 已有文件继承 header 与 entries
- `continueRecent` 在 dir 里多个会话按 mtime 倒序取首
- `forkFrom` 复制所有 entries + metadata.parentSession
- `list` 按 cwd 过滤
- 损坏文件(无 header / 解析断裂)skip 不抛

### `tests/cli/args.test.ts`(~5 测试)
- `-c` parse
- `-m xxx` parse
- 未知 flag 进 unknownFlags
- `-h/-v` 返回 bool
- `--session-dir foo` override

---

## §6 文档同步

- **AGENTS.md §1.2**:追加 `src/storage/{paths,settings-manager,session-manager,path-utils}.ts` 与 `src/cli/{cli,main,args}.ts` 的项目层 + CLI 入口说明(单独小节"项目层布局" + "CLI 入口")。
- **AGENTS.md §1.3** 显式不实现:trust-manager / extensions / skills / themes 资源加载器(本期延后)。
- **README.md** 新增 `## Quick start (TUI)`段:`npm run build && npm link && runledger`。
- **development-doc/tui/07-roadmap.md** Mark M7 完成 + 在文档底部+"实际落地总结"字段注明 entry 已转 `src/cli/main.ts`。
- 不写 `CHANGELOG.md`(RunLedger 习惯按 commit 描述而非 CHANGELOG)。

---

## §7 风险与回头点

| 风险 | 说明 | 缓解 |
|---|---|---|
| 现 `JsonlLedger` 已有「文件存在则继承」逻辑,SessionManager `open` 复用它可能行为偏差 | ensureInitialized 在文件已存在时只继承 header id 与 entries;本期 sessionId 由 caller 指定 path → sessionPath 取决于参数路径正确 | SessionManager 不重新入口 `JsonlLedger` 内部,仅控制 `filePath` 与首次 `appendFile`;open 路径以全文件路径传 |
| `examples/tui-demo.ts` 内 mock 回退分支试图自己 planRuntime,迁出到 cli/main 时容易让现有测试挂 | `tui-demo` 不在源侧测试覆盖中,但行为替换会影响 dump 样 | 暂不动 `examples/tui-demo.ts`;新 `src/cli/main.ts` 从头写 planRuntime 函数。`examples/tui-demo.ts` 仅留作 dev 跳板 |
| ` InteractiveMode.modelRegistry` 主入参类型以 `ModelSwitchEntry[]` 为约束,需 cli/main 构造 | 已有 mock-1 / mock-2 作为 mock fallback,与现状一致 | 构造器逻辑可能重复,留个内部小工厂 `buildModelRegistry(modelId, isMock, enabledModels)` 由 cli/main 与 tui-demo 都用 |
| build 期 `dist/cli/cli.js` 属 NodeNext,tsconfig 已 OK | tsconfig.json `include` 现在覆盖 `src/**`,包含 cli/ | 若 include 做选择性裁剪需手动加 src/cli/,预期不调 |

---

## §8 提交策略(可连锁)

预期 5 个 commit,每个职责单一:

1. `feat(storage): 项目层 .runledger/ 路径布局 + path-utils`  — paths.ts 扩 + path-utils.ts 新建 + tests
2. `feat(storage): SettingsManager 项目级 settings.json 加载`  — settings-manager.ts + tests
3. `feat(storage): SessionManager create/open/continueRecent/list/forkFrom` — session-manager.ts + tests
4. `feat(cli): runledger CLI 入口 + args 解析 + SessionManager + agent 装配` — cli/{args,main,cli}.ts + package.json bin + tests + AGENTS.md 同步
5. `docs(tui): M7 收尾总结 + README quick start + AGENTS.md 项目层布局段`—README + AGENTS.md + development-doc

每个 commit 前 `npm run check` + `npm test` 必须双双通过(AGENTS.md §3 工作流)。

---

## §9 不在本期(后续 PR)

- pi 的 trust-manager / ProjectTrustStore(用户已确认延后)
- extensions / skills / themes / prompts 项目层资源加载器
- pi 的 `package-manager.ts` `addAutoDiscoveredResources`
- AGENTS.md 的祖先链主动扫描实施(本期只在 main.ts 里硬读 cwd/AGENTS.md + `~/.runledger/agent/AGENTS.md`,后续可改为向上扫到 fs root)
- `transformContext` / 队列 / `AgentHarness`(已在 AGENTS.md §1.3 中)
- `--resume` 弹出 Overlay 选择器(本期 placeholder 列最大 mtime 一条)
- thinkingLevel 切换真生效(现 M8e 已注释,留待 polish)
- 子命令:install/remove/list(对照 pi 的 package-manager-cli.ts)
- `runledger daemon / remote send`(`development-doc/tui/09-remote-control-roadmap.md`,完全远期)

---

## 工作量预估

| 阶段 | 文件数 | 实现代码(净增) | 测试 |
|---|---|---|---|
| §0 路径层 | 1 扩 + 1 新 | ~50 行 | 4 测试 |
| §1 Settings | 1 新 | ~80 行 | 3 测试 |
| §2 SessionManager | 1 新 | ~250 行 | 6 测试 |
| §3 CLI | 3 新 + 1 package.json 改 | ~200 行 | 5 测试 |
| §5 测试汇总 | — | — | ~18 新测试 |
| §6 文档 | AGENTS.md 与 README 改 | 文档 | — |
| 总计 | 6 新 + 3 改 | ~580 行 | +18 测试 |

可用指向性测试:执行后 `runledger` 在 `RunLedger` 自身 repo 内可联真 Anthropic 或 mock,首跑默认创建 `<本 repo>/.runledger/sessions/<ts>_<id>.jsonl` 首次后 `runledger -c` 能 join 同一会话。先会话结束后 `ls .runledger/sessions/` 至少出现一个文件是验证手段。
