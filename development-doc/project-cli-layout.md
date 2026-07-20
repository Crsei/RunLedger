# 项目层 .runledger/ 布局与 CLI 入口(2026-04-28)

> 本文档记录 M8 §0–§3 工作:本项目层 `.runledger/` 子树路径解析、SessionManager / SettingsManager、CLI 入口与 `bin/runledger.js`。对应 commit:
> - `46b50aa` §0 路径层
> - `abc0224` §1 SettingsManager
> - `f260f2f` §2 SessionManager
> - `290246c` §3 CLI 入口

子任务之间的依赖关系:`§0 → §1 → §2 → §3`(§3 调用前述三个模块的 API)。§6 文档同步作为收尾,不阻塞 §3。

## §0 路径层

### 目标

让 `.runledger/` 项目层布局可解析:扩 `src/storage/paths.ts` 的 `getProjectDir / getProjectSessionsDir / getProjectSettingsPath / getProjectAgentsMd / getGlobalAgentsMd`,加 `resolveSessionDir(cwd, settingsSessionDir?)` 把 settings.sessionDir 与 `RUNLEDGER_SESSION_DIR` env 的优先级关系抽出。

### 子任务
1. `src/storage/paths.ts` 扩 6 个新方法,`getProjectDir` 等走 `cwd` 而不是 `~/.runledger/agent`;
2. `src/storage/path-utils.ts` 新建纯函数 `encodeCwd / safeIso / buildSessionFileName`(不引 fs,便于单测);
3. `tests/storage/path-utils.test.ts` 10 例覆盖跨平台;
4. `tests/storage/paths.test.ts` 16 例覆盖 env 覆盖、settings.sessionDir 优先级。

### 关键设计
- `PI` 走 `~/.pi/agent/sessions/<encoded-cwd>--<iso>/` 而 RunLedger 走 `<cwd>/.runledger/sessions/<iso>_<id>.jsonl`,便于本项目带走完整子树;
- `encodeCwd` 出 pi 同款 `--encoded-cwd--` 形态可用于跨项目目录索引(本期未启用,留作 §M8 后续);
- `RUNLEDGER_DIR` env 覆盖用户层 `~/.runledger/agent`,`RUNLEDGER_SESSION_DIR` env 覆盖项目层 sessionDir。

## §1 SettingsManager

### 目标

加载/落盘 `<cwd>/.runledger/settings.json`,精简 schema 最小集 5 字段。

### 子任务
1. `src/storage/settings-manager.ts` 新增 `ProjectSettings` 类型(schema 见下)+ `loadProjectSettings`(async) / `loadProjectSettingsSync` / `saveProjectSettings`;
2. `ProjectSettings` schema:`{ model?: string; thinkingLevel?: ThinkingLevel; theme?: "light"|"dark"; sessionDir?: string; enabledModels?: string[] }`;
3. 未知字段一律丢弃,类型不符回退空不抛错(只写 stderr);
4. 落盘 `0o600` 文件 + `0o700` 父目录(对照 `auth-storage` 同款);
5. `tests/storage/settings-manager.test.ts` 9 例。

### 关键设计
- 本期不实现 trust-manager、extensions、skills、themes 加载(对照 AGENTS.md §1.3 显式不实现);
- 本期不实现用户层 settings 合并(`<cwd>/.runledger/settings.json` + `~/.runledger/agent/settings.json` 合并优先级)。这是 pi config 的职责,本期 cut scope。

## §2 SessionManager

### 目标

在 `JsonlLedger` 之上加 cwd-aware 文件布局与多入口工厂:`create / open / continueRecent / forkFrom / list / listAll`。

### 子任务
1. `src/storage/session-manager.ts` 新建薄包装,每个静态构造方法返回 SessionManager,内部持 `JsonlLedger` 实例;
2. `create({ cwd, sessionDir?, sessionId?, metadata?, truncate? })` 落 `<sessionDir>/<iso>_<id>.jsonl`,metadata 写 `cwd` 便于 list 过滤;
3. `open(path)` 触发 `JsonlLedger.ensureInitialized`(ensureInitialized 在 append 时触发);
4. `continueRecent` 在 sessionDir 中扫所有 *.jsonl,按 header.metadata.cwd 过滤 + mtime 倒序取首条;若无可匹配则回退 create;
5. `forkFrom(sourcePath, targetCwd, sessionDir?)` 复制源文件全部行到新文件,metadata 标 `parentSession = path.resolve(sourcePath)`;
6. `list(cwd, sessionDir?)` 列出 *.jsonl header,跳过损坏文件(只写 stderr),按 mtime 倒序;
7. `tests/storage/session-manager.test.ts` 13 例覆盖 create/open/continueRecent/forkFrom/list 跨场景。

### 关键设计
- `SessionManager` 不修改 `LedgerSink` 协议,仅暴露文件路径解析与列举能力;
- `open` 不预热 ledger(避免 append placeholder 污染源会话),ledger.header() 在调用方首次 append 后才反映文件内真实 sessionId;这一行为已通过单测固化;
- `forkFrom` 沿用旧 sessionId 与 header id 以保留可追溯性(新文件与源文件可同时存在,互不影响)。

## §3 CLI 入口

### 目标

让"终端运行 `runledger` 命令打开 TUI"成立。

### 子任务
1. `src/cli/args.ts` 手写 argv parser,支持 `-c/--continue / -r/--resume / --session <path> / --session-id <id> / --fork <path> / -m/--model <id> / --thinking <level> / --session-dir <dir> / --debug / -v/--version / -h/--help`;未知 flag 兜到 `unknown: Map<name, string|true>` 不抛错;
2. `src/cli/main.ts` 按 §3 计划定流程装配:`parseArgs → handle -h/-v → debug env → loadProjectSettings → resolveSessionDir → SessionManager create/open/continueRecent/forkFrom → buildRuntime(anthropic key 存在走真路径,否则 mock 回退)→ buildSystemPrompt(合并 DEFAULT + cwd/AGENTS.md + ~/.runledger/agent/AGENTS.md,本期两点,祖先链扫描留 M8 后)→ InteractiveMode.run → finally closeAll ledger`;
3. `src/cli/cli.ts` bin 入口,仅 `main(process.argv.slice(2)).catch(exit 1)`;业务全留 main.ts 以便单测;
4. `bin/runledger.js` npm bin shim,`spawnSync('node', ['--import', 'tsx', 'src/cli/cli.ts', ...args])`;后期出 dist/cli/cli.js 后可改该 bin 直接 import dist 产物;
5. `package.json` 加 `bin.runledger` 字段、`scripts.cli / cli:debug`;
6. `npm link` 后 PATH 上的 `runledger` 命令可直接打开 TUI;
7. `tests/cli/args.test.ts` 23 例覆盖 parseArgs 全旗;`tests/cli/main.test.ts` 7 例通过 spawnSync `node --import tsx` 真跑 cli.ts 的 `--help / -h / --version / -v / --thinking bogus / --session 缺值`(error path);真 TUI 路径因 stdin 阻塞留 manual smoke test。

### 关键设计
- 对齐 pi `bin/cli.ts` 形态:cli.ts 仅做参数透传与 .catch exit 1,业务全在 main.ts 以便单测 spawnSync 真跑;
- `bin/runledger.js` 不引 await import 动态注册(AGENTS.md §2 禁内联),统一 spawnSync 进程;
- `--thinking` 切换在本期不真生效(`createAnthropicAgent` 在构造时一次性 cake thinking level);切换需重建 streamFn —— 留作 §M8e polish。

## 子任务后续(本期不实现,M8 后续 PR)

- 祖先链 AGENTS.md 扫描(本期仅 cwd 直接目录与 global 两点);
- `--resume` 弹 Overlay 选择列表(本期 placeholder:走 continueRecent 取最大 mtime);
- 真正的 thinkingLevel 切换生效(`createAnthropicAgent` 接受 `thinkingLevelRef`;
- 用户层 settings 与项目层 settings 合并策略(对照 pi `config.ts` resolveConfigValue);
- EnabledModels 过滤 `/model` 选择器可见候选(本期简化:候选默认全部 known);
- trust-manager / extensions / skills / themes 加载;
- `dist/cli/cli.js` 编译产物稳定后,bin 切到 `import('../dist/cli/cli.js')`(去除 tsx 依赖)。
