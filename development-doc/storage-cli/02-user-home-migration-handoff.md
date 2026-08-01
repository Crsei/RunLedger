# Storage/CLI 用户级单一 home 迁移 handoff

> 状态:待实施;本文件只授权后续 Storage/CLI 行为迁移,当前提交不创建、复制、移动或删除任何用户数据
> 上位契约:[Runtime 保存位置合同](../runtime/04-governed-agent-harness-runtime-plan.md#contract-persistence)
> 现行实现记录:[`01-project-layout-cli-plan.md`](01-project-layout-cli-plan.md) 与 [`../project-cli-layout.md`](../project-cli-layout.md)

## 1. 目标与边界

本 handoff 负责把现行项目级/任意目录写入行为迁移到唯一用户级 `runledgerHome`。目标行为必须只消费上位 Runtime 已冻结的 `resolveRunledgerHomeContract`、`buildRunledgerLayout`、workspace key、session/artifact locator、权限和 path-containment 规则,不得在 Storage/CLI 内复制第二套合同。

本计划完成前,以下能力均不得宣称已交付:

- `RUNLEDGER_DIR` 或默认 `~/.runledger` 的单次解析与固定拓扑创建;
- 停止向 `<cwd>/.runledger/` 与 `~/.runledger/agent/` 新写数据;
- `settings.sessionDir`、`RUNLEDGER_SESSION_DIR`、`--session-dir` 的 authority 移除;
- 旧 session/settings/auth 的显式只读 import;
- import 冲突处理、失败恢复和 rollback。

本文件不授权 Event Store、Artifact Store、retention/GC、后台迁移、隐式扫描、双写或删除旧目录。外部路径只能是用户显式指定的只读 import source。

## 2. 当前实现差距

当前代码仍以项目级布局为主,这是迁移输入,不是目标合同:

| 当前面 | 现行行为 | 目标差距 |
|---|---|---|
| `src/storage/paths.ts` | 默认 `<cwd>/.runledger/sessions`;默认用户目录为 `~/.runledger/agent`;多个 helper 可分别解析路径 | 启动时只解析一次绝对 `runledgerHome`,所有写路径来自固定 layout |
| `src/storage/settings-manager.ts` | 读写 `<cwd>/.runledger/settings.json`,接受 `sessionDir` | 用户级 settings 与 `projects/<workspace-key>/settings.json`;不再接受任意 session root |
| `src/storage/session-manager.ts` | caller 可注入任意 `sessionDir`;open 后可原地追加/锁定 | canonical session 只写 `sessions/YYYY/MM/DD`;外部文件只能经显式 import |
| `src/cli/args.ts` | `--session-dir` 是最高优先级写入 override | flag 进入明确弃用/拒绝路径,不能改变 canonical 写入位置 |
| `src/cli/main.ts` | `--session-dir > RUNLEDGER_SESSION_DIR > settings.sessionDir > project default` | composition root 只注入一次已验证 layout |
| `src/storage/auth-storage.ts` | 默认 `~/.runledger/agent/auth.json` | 默认 `<runledgerHome>/auth.json` |

现有测试对这些旧行为的断言是迁移时必须显式替换的 compatibility baseline,不能在新实现完成前直接删除以制造假绿。

## 3. 不变量

后续实现必须满足:

1. `RUNLEDGER_DIR` 是唯一位置 override;非空值必须是可规范化的既有绝对目录,失败即启动失败。
2. 未设置 override 时只创建 `<用户主目录>/.runledger`,目录 `0700`,敏感/用户数据文件不宽于 `0600`。
3. composition root 解析一次 layout,以依赖注入传给 settings/auth/session/CLI;下游不得再次读 env 或 cwd 推导根。
4. workspace/cwd 只形成 identity/metadata 与 `projects/<workspace-key>` key,不形成第二个保存根。
5. canonical session 只写 `sessions/YYYY/MM/DD/<session-id>.jsonl`;archive 不改变 session identity。
6. 所有 create/open-for-write/lock/rename 前后都验证规范化目标仍在 `runledgerHome` 内;symlink 变化必须 fail closed。
7. `<cwd>/.runledger/`、`~/.runledger/agent/` 和任意 `sessionDir` 只允许被显式 import reader 以只读方式打开。
8. import source 保持原样;没有单独的数据删除授权时,迁移成功也不得删除或改名源文件。
9. 不双写,不后台扫描,不因新 home 为空而自动导入最近项目。

## 4. Authority 移除与兼容语义

### 4.1 `settings.sessionDir`

- 新 settings schema 不保存该字段。
- 读取旧项目 settings 时只把它作为 legacy import 提示,不能影响新 session 创建、resume、fork 或 archive 位置。
- 用户级/项目级 settings 保存若收到 `sessionDir`,返回结构化 `unsupported_setting` 并保持目标文件不变;不得静默丢弃后声称已应用。

### 4.2 `RUNLEDGER_SESSION_DIR`

- composition root 检测到非空值时启动失败并给出 `unsupported_environment_override` 与迁移命令提示。
- 不回退到该目录,也不把它解释为 `RUNLEDGER_DIR`。
- 自动化环境若需要隔离,必须把一个预创建绝对目录传给 `RUNLEDGER_DIR`。

### 4.3 `--session-dir`

- parser 保留一个有期限的显式错误分支,用于给出退出码 `2` 和替代方案;不得落入 unknown flag。
- 该参数不能与 create/continue/resume/session-id/fork 组合后继续运行。
- 完成一个已公告的弃用窗口后可以移除 parser 分支,但仍需负向 CLI 测试证明它不会恢复成写入 authority。

### 4.4 外部 `--session`/`--fork`

- 根外 path 只触发 import 预检或显式 import 流程,不能由 `SessionManager.open` 原地锁定和追加。
- 根内 canonical locator 可以正常 resume;用户输入的绝对路径不得写入 durable record。

## 5. 显式只读 import

建议 CLI 形态为独立命令 `runledger import --source <path> [--dry-run|--apply]`;最终命名可在实现 RED 测试中冻结,但必须保留 dry-run 与 apply 的显式区分。

### 5.1 允许的 source

- 单个旧 session JSONL 文件;
- 用户显式给出的旧 `<cwd>/.runledger/sessions/`;
- 用户显式给出的旧 `~/.runledger/agent/`;
- 用户显式给出的历史 `sessionDir`。

reader 只列出已授权 source 内的已知文件,不跟随逃逸 source root 的 symlink,不执行脚本,不加载插件,不读取不相关文件。source 解析失败、格式未知或权限不足时只报告失败,不得猜测或部分转换。

### 5.2 两阶段流程

1. `dry-run`:只读扫描,验证 current session codec、计算内容 digest、解析 canonical ID/创建时间/workspace identity、生成目标 locator 与 bounded 冲突报告;不创建 `runledgerHome` 之外的任何文件。
2. `apply`:重新读取并重新校验 source digest,在 `<runledgerHome>/tmp/import-<batch-id>/` 写 staged copy,以 `0600` 校验后原子发布到 canonical locator,最后写 import batch receipt/index。dry-run 与 apply 间 source 改变则拒绝。

每个 import item 只有 `planned`、`imported`、`deduplicated`、`conflict`、`rejected` 五种结果。单项失败不得被记录为成功;batch 是否允许部分成功必须在命令开始前显式选择并写入 receipt,默认 atomic batch。

### 5.3 冲突规则

| 条件 | 结果 |
|---|---|
| 目标不存在且 source 通过 exact codec/digest 校验 | staged 后原子发布 |
| 相同 session ID 且 canonical digest 相同 | `deduplicated`,不重写目标 |
| 相同 session ID 但 digest 不同 | `conflict`,默认整个 batch 失败;不覆盖、不自动改 ID |
| source 没有 current exact ID/codec | `rejected`;本计划不授权 legacy 猜测转换 |
| 目标路径或父目录逃逸/symlink 改变 | `rejected`,fail closed |

如未来需要把旧格式转换为 current format,必须先增加独立、版本明确、可审计的转换计划;不能把转换隐藏在本 import 中。

## 6. Rollback 与恢复

- 发布前失败:删除的范围只能是本 batch 在 `<runledgerHome>/tmp/import-<batch-id>/` 新建的 staged 文件;source 与既有 canonical 文件保持不变。
- atomic batch 发布中断:重启后以 batch receipt/staging manifest 重放判断,只清理 digest 匹配且属于该 batch 的临时文件;不得按目录时间或通配符删除。
- 已发布且尚未被任何新 session/ref 消费:显式 `rollback-import <batch-id>` 可以移除仅由该 batch 新建且 digest 未变的目标,并保留 rollback receipt。
- 已发布且已被引用、继续写入或归档:不得物理回滚;只能记录冲突/撤销请求,交由未来 retention/deletion 行为计划处理。
- settings/auth 迁移不得覆盖既有目标。需要合并时逐字段提示并由用户确认;rollback 恢复的是本次导入前的目标 revision,不是删除整个目标文件。

任何 rollback 都不删除 legacy source。删除旧 `<cwd>/.runledger/` 或 `~/.runledger/agent/` 必须是后续独立、明确授权的用户动作。

## 7. 实施阶段与提交边界

### S0:RED baseline 与 composition seam

- 为单一 home 成功/失败、旧 authority 拒绝、根外写入拒绝和现行行为差距建立失败测试。
- 新增 Storage-owned layout resolver adapter,只消费 Runtime public contract;不修改 session 数据。
- 提交目标:`storage: resolve one governed user home`。

### S1:Settings/Auth 路径迁移

- 把 user settings、workspace settings、auth 和 AGENTS.md 切到 injected layout。
- 对旧 project settings 与 agent dir 只提供只读发现/提示。
- 提交目标:`storage: stop project settings and agent-dir writes`。

### S2:Session canonical writer

- SessionManager create/list/resume/fork 只接受 canonical locator/layout,移除任意 write root 参数。
- UTC shard、权限、containment、lock/temp/rename 全部有负向测试。
- 提交目标:`storage: keep canonical sessions inside user home`。

### S3:CLI authority removal

- `RUNLEDGER_SESSION_DIR` 与 `--session-dir` fail closed;settings.sessionDir 不再生效。
- help、错误码、debug diagnostic 和非交互 CLI 测试同步更新。
- 提交目标:`cli: reject legacy session directory authority`。

### S4:只读 import 与 rollback

- 先完成 dry-run、冲突矩阵与 source immutability 测试,再实现 apply。
- rollback 只能操作 batch-owned、digest 未变、未被引用的目标。
- 提交目标:`storage: import legacy sessions without mutating sources`。

### S5:文档与删除旧写路径

- 静态检查确认生产代码不再写 `<cwd>/.runledger/`、`~/.runledger/agent/` 或读取 `RUNLEDGER_SESSION_DIR`。
- 更新 `AGENTS.md`、CLI 文档与现状页;旧计划保留为历史记录并加醒目 superseded 路由。
- 不删除用户磁盘上的旧数据。
- 提交目标:`docs: close single-home storage migration evidence`。

每阶段必须独立 commit;只暂存该阶段明确路径。迁移实现改动代码后至少运行 `npm run check`、`npm test`、`npm run build` 和 `git diff --check`。

## 8. 必需测试

- home override:绝对既有目录、missing、relative、not-directory、canonicalization failure、default create mode;
- path containment:POSIX/Windows、`..`、sibling prefix、symlink swap、rename target、external open-for-write;
- layout:所有固定子目录、UTC session shard、workspace key、权限下限;
- authority removal:settings/env/CLI 三条路径均不能改变写入目标;
- source immutability:dry-run/apply/failure/rollback 前后 source bytes、mode、mtime 不变;
- import conflict:不存在、相同 digest、同 ID 异 digest、损坏 JSONL、unknown format、TOCTOU;
- crash recovery:staging 前、staging 后、发布中、receipt 前后的确定性恢复;
- consumer regression:CLI create/continue/resume/fork 只使用 root 内 locator,不把绝对 path 写入 canonical records;
- static boundary:Storage/CLI 只从 `runledger/runtime/contracts` 或仓库内 audited public barrel 消费上位合同。

## 9. 完成条件

- [ ] `RUNLEDGER_DIR`/默认 `~/.runledger` 是唯一写入根,且只解析一次。
- [ ] 新运行不向 `<cwd>/.runledger/` 或 `~/.runledger/agent/` 创建/修改文件。
- [ ] `sessionDir` setting、env 和 CLI flag 均不能形成写入 authority。
- [ ] 根外 session 只能显式只读 import,不能原地 append/lock/archive。
- [ ] import dry-run、conflict、TOCTOU、source immutability 与 rollback tests 全绿。
- [ ] 旧数据未被隐式扫描、移动、复制或删除。
- [ ] `npm run check`、`npm test`、`npm run build`、静态边界和文档链接检查附 commit 证据。

这些项目全部完成前,本 handoff 状态保持“待实施”。上位 Runtime contract 的完成只表示位置/DTO 规则已冻结,不能代替本迁移行为验收。
