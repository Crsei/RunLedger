# Storage/CLI 用户级单一 home 迁移 handoff

> 状态:待实施;本文件授权后续 Storage/CLI 破坏性迁移,当前提交不创建、复制、移动或删除任何用户数据
> 上位契约:[Runtime 保存位置合同](../runtime/04-governed-agent-harness-runtime-plan.md#contract-persistence)
> 现行实现记录:[`01-project-layout-cli-plan.md`](01-project-layout-cli-plan.md) 与 [`../project-cli-layout.md`](../project-cli-layout.md)

## 0. 当前状态与执行顺序

| 阶段 | 状态 | 前置条件 | 独立提交目的 |
|---|---|---|---|
| S0 composition seam / RED baseline | 已完成 (`9bee364`) | Runtime C0–C5 contract 已冻结；当前项目级写入行为已取证 | 只建立单一 home resolver 接缝与失败测试 |
| S1 Settings/Auth 路径迁移 | 已完成（本阶段） | S0 通过 | 停止 project settings 与 agent-dir 新写入 |
| S2 Session canonical writer | 未开始 | S1 通过；layout 注入可用 | session 只写 user home 的 UTC shard |
| S3 CLI authority removal | 未开始 | S2 通过 | 拒绝 `sessionDir`、环境变量和 CLI 任意目录 authority |
| S4 破坏性迁移与旧源删除 | 未开始 | S3 通过；canonical writer 稳定 | 显式迁移、冲突、TOCTOU 与 source deletion receipt |
| S5 文档与旧写路径收口 | 未开始 | S0–S4 全部通过 | 静态边界、删除清单、文档与最终验收 |

执行必须严格按 `S0 → S1 → S2 → S3 → S4 → S5` 串行推进。各阶段不得并行修改 `src/storage/paths.ts`、`settings-manager.ts`、`session-manager.ts`、`src/cli/main.ts` 或共享测试；每阶段完成后先保留独立 commit，再进入下一阶段。当前唯一前置合同证据为 Runtime [C0–C5 milestone](../runtime/04-governed-agent-harness-runtime-plan.md#contract-acceptance)，不把它误作 Storage/CLI 行为已完成。

阶段状态只能在对应 RED→GREEN 测试、完整门禁和阶段 commit 都存在后更新。任何阶段失败都保持前一阶段可运行；不得通过双写、自动迁移、提前删除旧目录或放宽 path-containment 来取得绿灯。旧源只能在 S4 对应 canonical 数据完成 digest 校验并写入删除清单后删除。

S0 证据：`9bee364 storage: resolve one governed user home`；`tests/storage/runledger-home.test.ts` 5 tests；`npm run check`、`npm test`（60 files / 358 tests）和 `npm run build` 通过。S0 不创建 home、不写旧目录、不迁移或删除数据。

S1 证据（实现提交目标：`storage: stop project settings and agent-dir writes`）：`src/storage/settings-manager.ts` 只接受注入的 `RunledgerLayout`，canonical settings 位于 `layout.settings` 或受校验的 `projects/<workspace-key>/settings.json`；`sessionDir` 保存输入返回 `unsupported_setting` 且不触碰目标文件。`src/storage/auth-storage.ts` 与 CLI composition root 改为注入 `layout.auth`，全局 `AGENTS.md` 也从 `layout.agents` 读取；controller 的选择持久化不再调用 cwd 路径 helper。新增/更新 `tests/storage/user-home-settings-auth.test.ts`、`tests/storage/settings-manager.test.ts` 与 `tests/runtime/interactive-session-controller.test.ts`，聚焦共 15 tests 通过；完整 `npm run check`、`npm test`（61 files / 362 tests）和 `npm run build` 通过。S1 未迁移、复制或删除旧数据；session canonical writer 与 CLI authority removal 仍由 S2/S3 负责。

## 1. 目标与边界

本 handoff 负责把现行项目级/任意目录写入行为迁移到唯一用户级 `runledgerHome`。目标行为必须只消费上位 Runtime 已冻结的 `resolveRunledgerHomeContract`、`buildRunledgerLayout`、workspace key、session/artifact locator、权限和 path-containment 规则,不得在 Storage/CLI 内复制第二套合同。

本计划完成前,以下能力均不得宣称已交付:

- `RUNLEDGER_DIR` 或默认 `~/.runledger` 的单次解析与固定拓扑创建;
- 停止向 `<cwd>/.runledger/` 与 `~/.runledger/agent/` 新写数据;
- `settings.sessionDir`、`RUNLEDGER_SESSION_DIR`、`--session-dir` 的 authority 移除;
- 旧 session/settings/auth 的显式破坏性迁移与源删除;
- source deletion manifest、冲突停止、TOCTOU 检查和不可逆失败语义。

本文件不授权 Event Store、Artifact Store、retention/GC、后台迁移、隐式扫描或双写。旧目录删除只允许由本 handoff 的显式迁移命令、逐项删除清单和用户确认触发；不提供只读 import、自动 fallback 或隐式删除路径。

## 2. 当前实现差距

当前代码仍以项目级布局为主,这是迁移输入,不是目标合同:

| 当前面 | 现行行为 | 目标差距 |
|---|---|---|
| `src/storage/paths.ts` | 默认 `<cwd>/.runledger/sessions`;默认用户目录为 `~/.runledger/agent`;多个 helper 可分别解析路径 | 启动时只解析一次绝对 `runledgerHome`,所有写路径来自固定 layout |
| `src/storage/settings-manager.ts` | 读写 `<cwd>/.runledger/settings.json`,接受 `sessionDir` | 用户级 settings 与 `projects/<workspace-key>/settings.json`;不再接受任意 session root |
| `src/storage/session-manager.ts` | caller 可注入任意 `sessionDir`;open 后可原地追加/锁定 | canonical session 只写 `sessions/YYYY/MM/DD`;外部文件只能经显式 destructive migration |
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
7. `<cwd>/.runledger/`、`~/.runledger/agent/` 和任意 `sessionDir` 只能作为显式迁移 source；不得由 `SessionManager` 原地追加、锁定或归档。
8. canonical 目标完成 digest/receipt 校验后，按 source deletion manifest 直接删除对应旧文件；不提供保留旧源的 fallback，也不删除清单之外的文件。
9. 不双写,不后台扫描,不因新 home 为空而自动迁移最近项目；只有用户显式确认的 migrate 命令能触发删除。

## 4. Authority 移除与兼容语义

### 4.1 `settings.sessionDir`

- 新 settings schema 不保存该字段。
- 读取旧项目 settings 时只把它作为 legacy migration metadata,不能影响新 session 创建、resume、fork 或 archive 位置。
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

- 根外 path 只能作为显式迁移 source 进入 preflight→publish→delete 流程,不能由 `SessionManager.open` 原地锁定和追加。
- 根内 canonical locator 可以正常 resume;用户输入的绝对路径不得写入 durable record 或作为删除目标,除非它已出现在经过校验的 source deletion manifest 中。

## 5. 破坏性迁移与旧源删除

CLI 形态固定为独立命令 `runledger migrate --source <path> --confirm-delete`;不提供 `--dry-run`、`--read-only` 或 `--fallback` 作为完成路径。命令开始前必须展示待迁移对象数量、目标 root、删除清单摘要，并要求不可歧义的显式确认；非交互调用必须提供等价的确认 token/flag。

### 5.1 允许的 source 与删除范围

- 单个旧 session JSONL 文件;
- 用户显式给出的旧 `<cwd>/.runledger/sessions/`;
- 用户显式给出的旧 `~/.runledger/agent/`;
- 用户显式给出的历史 `sessionDir`。

迁移器只处理已授权 source 内、可列入 deletion manifest 的已知文件,不跟随逃逸 source root 的 symlink,不执行脚本,不加载插件,不读取不相关文件。source 解析失败、格式未知、权限不足或 manifest 无法固定时直接失败并保持 source；不得猜测、部分转换或 fallback 到旧路径继续运行。

每个 batch 必须先生成并持久化不可变 `source deletion manifest`，至少包含：source canonical path、source file digest、object kind、object ID、target locator、target digest、requested delete action、用户确认时间和 batch ID。删除范围仅限以下三类已由该 batch 成功迁移并验证的对应文件：

- 旧 `<cwd>/.runledger/settings.json`、旧 `~/.runledger/agent/auth.json` 或其对应的旧 AGENTS/settings 文件；
- 旧项目 `.runledger/sessions/*.jsonl`、旧 agent sessions 和显式 `sessionDir` 中已成功发布的 session 文件；
- 本 batch 明确列出的旧 metadata/index 文件，且其内容已被 canonical settings/index/receipt 校验覆盖。

未列入 manifest 的文件、目录中的插件/扩展/用户自有文件和 source root 本身不得删除。目录只可在删除对应文件后、确认为空且 manifest 明确允许时移除；禁止对整个 workspace、home 或任意递归路径执行宽泛删除。

### 5.2 迁移与删除流程

1. `preflight`:在命令内部读取 source，验证 current session codec、计算内容 digest、解析 canonical ID/创建时间/workspace identity，固定目标 locator 和 source deletion manifest；这不是用户可单独选择的只读 import 模式。
2. `publish`:在 `<runledgerHome>/tmp/migrate-<batch-id>/` 写 staged copy，以 `0600` 校验后原子发布到 canonical locator；重新读取 source 并校验 digest，source 改变则整个 batch 失败。
3. `verify-and-delete`:验证目标文件、canonical receipt、source digest 和 containment 后，按 manifest 逐项删除对应旧 source；每次删除都写 `source_deleted` receipt，删除失败立即停止，不回退到 source 或旧 session path。
4. `finalize`:写 migration batch receipt/index，包含 source digest、target digest、deleted paths、未删除项和失败原因；receipt 写失败时命令失败，后续只能通过同一 batch 的 digest reconciliation 继续删除，不能 fallback。

每个 migration item 只有 `validated`、`published`、`deduplicated_and_deleted`、`source_deleted`、`conflict`、`rejected`、`delete_failed` 七种结果。默认 atomic batch；任何 source 删除前的失败都不得删除 source。已删除 item 不得被标为 fallback 或可恢复成功。

### 5.3 冲突规则

| 条件 | 结果 |
|---|---|
| 目标不存在且 source 通过 exact codec/digest 校验 | staged 后原子发布，校验通过后删除 source |
| 相同 session ID 且 canonical digest 相同 | `deduplicated_and_deleted`，不重写目标，校验通过后删除重复 source |
| 相同 session ID 但 digest 不同 | `conflict`，整个 batch 失败；不覆盖、不改 ID、不删除冲突 source |
| source 没有 current exact ID/codec | `rejected`；不猜测转换、不 fallback、不删除 source |
| 目标路径、source 路径或父目录逃逸/symlink 改变 | `rejected`，fail closed，不删除 source |

如未来需要把旧格式转换为 current format，必须先增加独立、版本明确、可审计的转换计划；本迁移命令不隐藏转换，也不以旧格式继续运行。

## 6. 不可逆失败语义与恢复

- source 删除前失败：只清理本 batch 在 `<runledgerHome>/tmp/migrate-<batch-id>/` 新建的 staged 文件；source 与既有 canonical 文件保持不变。
- canonical 发布成功但 source 删除失败：写 `delete_failed` receipt，立即停止；不回退、不继续使用旧 source，不删除其他 source。后续只能由用户再次显式执行同一 batch 的 digest reconciliation。
- source 删除成功但 finalize receipt 失败：canonical 数据和已删除事实不可逆；重启时根据目标 digest 与 deletion manifest 补写 receipt，不恢复 source。
- 已发布、已删除且被引用/继续写入/归档的对象：不提供物理恢复；只能由未来独立 retention/deletion 计划处理逻辑撤销。
- settings/auth 迁移不得覆盖既有目标。冲突直接失败；不通过 fallback、自动改名或隐式合并继续。

删除是本 handoff 明确授权的最终动作，但只限 deletion manifest 中、已完成目标校验的对应旧文件。不得递归删除整个 home、workspace 或未列入 manifest 的用户数据；本次计划修改本身不执行删除。

## 7. 实施阶段与提交边界

### S0:RED baseline 与 composition seam

- 为单一 home 成功/失败、旧 authority 拒绝、根外写入拒绝和现行行为差距建立失败测试。
- 新增 Storage-owned layout resolver adapter,只消费 Runtime public contract;不修改 session 数据。
- 提交目标:`storage: resolve one governed user home`。

### S1:Settings/Auth 路径迁移

- 把 user settings、workspace settings、auth 和 AGENTS.md 切到 injected layout。
- 对旧 project settings 与 agent dir 只建立受控 migration metadata，不能作为运行时 settings/auth authority。
- 提交目标:`storage: stop project settings and agent-dir writes`。

### S2:Session canonical writer

- SessionManager create/list/resume/fork 只接受 canonical locator/layout,移除任意 write root 参数。
- UTC shard、权限、containment、lock/temp/rename 全部有负向测试。
- 提交目标:`storage: keep canonical sessions inside user home`。

### S3:CLI authority removal

- `RUNLEDGER_SESSION_DIR` 与 `--session-dir` fail closed;settings.sessionDir 不再生效。
- help、错误码、debug diagnostic 和非交互 CLI 测试同步更新。
- 提交目标:`cli: reject legacy session directory authority`。

### S4:破坏性迁移与 source deletion

- 先完成 preflight、确认 token、冲突矩阵、目标 digest 校验和 source deletion manifest 测试，再实现 publish→delete。
- 删除只针对 batch-owned 且已完成 canonical 校验的 source；删除失败必须停止且不能 fallback。
- 提交目标:`storage: destructively migrate legacy data into user home`。

### S5:文档与旧写路径收口

- 静态检查确认生产代码不再写 `<cwd>/.runledger/`、`~/.runledger/agent/` 或读取 `RUNLEDGER_SESSION_DIR`。
- 更新 `AGENTS.md`、CLI 文档与现状页;旧计划保留为历史记录并加醒目 superseded 路由。
- 更新 destructive migration、删除清单和不可逆失败说明；旧计划标记为 superseded。
- 不执行删除清单之外的用户数据删除。
- 提交目标:`docs: close destructive single-home migration evidence`。

每阶段必须独立 commit;只暂存该阶段明确路径。迁移实现改动代码后至少运行 `npm run check`、`npm test`、`npm run build` 和 `git diff --check`。

## 8. 必需测试

- home override:绝对既有目录、missing、relative、not-directory、canonicalization failure、default create mode;
- path containment:POSIX/Windows、`..`、sibling prefix、symlink swap、rename target、external open-for-write;
- layout:所有固定子目录、UTC session shard、workspace key、权限下限;
- authority removal:settings/env/CLI 三条路径均不能改变写入目标;
- source deletion:目标 digest/receipt 未完成前 source bytes 不变；完成后只删除 manifest 中的 source，未列入 manifest 的旧文件仍保留;
- migration source conflict:不存在、相同 digest、同 ID 异 digest、损坏 JSONL、unknown format、TOCTOU;
- crash recovery:staging 前、publish 后、source delete 中、删除后 receipt 前后的确定性 reconciliation；不得恢复已删除 source;
- no-fallback:不存在 `--dry-run`、`--read-only`、`--fallback` 成功路径，旧 source 不能继续作为运行时 authority;
- consumer regression:CLI create/continue/resume/fork 只使用 root 内 locator,不把绝对 path 写入 canonical records;
- static boundary:Storage/CLI 只从 `runledger/runtime/contracts` 或仓库内 audited public barrel 消费上位合同。

## 9. 完成条件

- [ ] `RUNLEDGER_DIR`/默认 `~/.runledger` 是唯一写入根,且只解析一次。
- [ ] 新运行不向 `<cwd>/.runledger/` 或 `~/.runledger/agent/` 创建/修改文件。
- [ ] `sessionDir` setting、env 和 CLI flag 均不能形成写入 authority。
- [ ] 根外 session 只能作为显式 destructive migration source,不能原地 append/lock/archive。
- [ ] preflight、conflict、TOCTOU、target verification、source deletion 与不可逆失败 tests 全绿。
- [ ] 对应旧 source 已按 deletion manifest 删除，manifest 外旧数据未被扫描、移动、复制或删除。
- [ ] `npm run check`、`npm test`、`npm run build`、静态边界和文档链接检查附 commit 证据。

这些项目全部完成前,本 handoff 状态保持“待实施”。上位 Runtime contract 的完成只表示位置/DTO 规则已冻结,不能代替本迁移行为验收。
