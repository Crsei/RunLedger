# ADR 02：Workspace Path / Locator 语义（P2，已冻结）

> 状态：**FROZEN**。2026-08-06 由 Runtime/Storage/Worktree 当前 owner 共同接受；
> 修改必须走新 ADR revision，不能静默改本文件。
>
> 依据证据：[`01-multiplatform-workspace-path-adaptation-plan.md`](01-multiplatform-workspace-path-adaptation-plan.md) P1 真实 runner 证据
> （`tests/fixtures/platform-evidence/linux/`）+ [`evidence-verification-gaps.md`](evidence-verification-gaps.md)。
>
> 本 ADR 只拥有路径/locator 语义；不拥有 Permission、Approval、OS sandbox 或 process 生命周期。

## 1. 背景

registry/session 与 Host 进程内此前混用 native absolute path：既有存储格式、
Git 输出、process cwd 与公共 DTO redaction 共用一种未加说明的字符串。多平台
路径身份（POSIX、drive、UNC、device/long path）、大小写策略与 containment 都
没有版本化结论。P1 在真实 Linux runner 采集了 path/Git/Shell/process/cleanup
证据；macOS/Windows 仍是 gap，本 ADR 的对应决策以“未验证 → typed unsupported”
收口，不猜测。

## 2. 决策

### D1：native / display / compare / storage 四种值分离

| 值 | 定义 | 归属 |
|---|---|---|
| native path | 进程内可直接用于 fs/Git 的绝对路径 | 仅 Host-private 状态与 private locator store |
| display path | canonical、大小写保留的展示值 | CLI/TUI 脱敏展示、审计记录（受限） |
| compare key | 平台规范化的同一性比较键 | containment/identity 比较专用，不展示 |
| persisted locator | 版本化私有持久记录 | 私有 store 的存储格式，不是 process API 输入 |

规则：

1. 公共 DTO、event、receipt、Artifact metadata 不得携带 native path；
   只能使用 opaque ID、root-relative locator 或脱敏 label；
2. native ↔ persisted 的转换只由 `WorkspacePathAdapter` 完成；
3. compare key 按平台生成：linux/macos 大小写敏感；windows 大小写折叠
   （展示值仍保留大小写）；UNC server/share 身份大小写折叠；
   macOS case policy 在真实 APFS 证据补齐前保持大小写敏感（见 §4 pending）；
4. display path 来自 realpath（existing）或 nearest-existing-ancestor
   （candidate），不是用户输入的 raw 字符串。

### D2：existing path 与 candidate path 契约

- **existing path**：`realpath` 得到真实身份（display + compare key）；
  symlink 全部解析，解析结果必须在 managed root 内，否则 outside/fail closed；
  同时保留 `requestedPath`（用户输入）用于审计。
- **candidate path**（待创建）：只对最近存在的祖先做 realpath，其余 segment
  按 lexical 拼接；祖先 realpath 逃出 root 或落在跨 volume/root 时返回
  typed error，不猜测。
- 两条路径都返回结构化身份（kind/root/display/compareKey）；
  不允许用裸字符串 `startsWith` 判断 containment 或 identity。

### D3：root / volume / share identity 与 containment

Root 分类：

- `posix`：`/` 及其子树；
- `drive`：`C:` 形式（drive letter 比较大小写折叠）；
- `unc`：`\\server\share`（server/share 身份比较大小写折叠）；
- `device`（`\\?\`、`\\.\`）与无法分类的路径：typed `unsupported_root`，
  不得参与 containment；
- 相对路径与 drive-relative（`C:foo`）：typed `invalid_path`（业务层必须给
  绝对路径）。

Containment 判定（`isWithin(parent, child)`）：

1. parent 与 child 的 root 身份必须相同（同为 posix 根、或同 drive letter、
   或同 UNC server+share）；
2. 不同 root → outside（不比较 segment）；
3. 同 root 时逐 segment 前缀比较：parent 的每个 segment 必须是 child 对应
   segment 的前缀且数量不超过；windows 下 segment 比较按 compare key
   （大小写折叠）；
4. `/repo` 与 `/repo-other`：segment 比较天然拒绝，禁止字符串前缀；
5. symlink：existing path 的身份基于 realpath 结果；candidate path 中已存在
   的祖先 realpath 后仍须满足 containment，否则 outside/fail closed；
6. junction/reparse point 的 containment 语义待 Windows 真实证据（§4 pending），
   在证据前按不可信处理（解析后重新 containment 校验）。

### D4：versioned private locator

版本 1 私有 locator 记录（存储 JSON，不在 process API 间传递）：

```json
{ "version": 1, "platform": "linux", "kind": "posix", "path": "/abs/path" }
```

- `decode` 是平台无关的结构化解析：版本、platform、kind、path 任何一项
  不符合 → typed error；
- `open/restore`（同平台恢复）必须重验证：locator platform == 当前平台、
  path 存在、仍是预期 Git worktree（对 worktree locator）、lease 与
  effective cwd 有效；任一失败 fail closed；
- `platform` 与当前平台不同 → typed `platform_mismatch`，不猜测转换；
- 无版本或无法无损解释的旧记录 → typed `migration_required`，只读审计，
  迁移方案（digest/TOCTOU/rollback）批准前不得执行；
- 本仓库内除测试外不生产旧格式记录（`src/runtime/workspace-adapters`
  不读取旧格式，与 JSONL ledger 的旧格式策略一致）。

### D5：公共 DTO redaction 与错误 taxonomy

Redaction：

- 公共 DTO 只出现：`WorkspaceRef`/`RepositoryRef`（opaque ID + digest）、
  root-relative locator、脱敏 label（repo slug/display hint）；
- 日志/事件中的绝对路径按策略截断并标注 redacted，不记录完整 native path；
- 审计私有 store 仍保留完整 locator，但该 store 不投影到公共事件。

错误 taxonomy（typed，业务层只消费这些 code）：

| code | 含义 |
|---|---|
| `invalid_path` | 相对路径、drive-relative、非法字符等不可用输入 |
| `unsupported_root` | device/long-path/无法分类的 root |
| `cross_root_containment` | 父子分属不同 root/volume/share，或解析后逃出 managed root |
| `platform_mismatch` | locator 平台与当前平台不一致 |
| `migration_required` | 旧格式/无版本记录，只读，不转换 |
| `unverified_platform` | 平台 adapter 尚无真实 runner 证据（macOS/Windows） |
| `stale_registration` | Git registration 与 registry 不一致，不盲目删除 |
| `git_failed` | Git 命令失败或 broker 不可用（retryable 标记信号中断） |
| `invalid_state` | 注册条目状态不满足操作前置（如 git-locked worktree 不可 remove） |
| `base_drift` | cold resume 时 worktree HEAD 与记录 base 不一致，拒绝改指 source |

> ADR revision 1（2026-08-06，P4 实现时补充）：新增 `git_failed` 与
> `invalid_state` 两个 code，覆盖 Git 命令失败与注册状态冲突；不改变既有
> 决策语义。
>
> ADR revision 2（2026-08-06，P5 实现时补充）：新增 `base_drift`，覆盖
> cold resume 的 HEAD/base 漂移；不改变既有决策语义。

## 3. P1 证据对决策的输入（Linux，2026-08-06）

- ext 文件系统大小写敏感（`case-sensitive-probe`：`MixedCase` 存在而小写变体不存在）
  → D1 第 3 条 linux 大小写敏感；
- `git worktree list --porcelain` 输出 `detached`/`locked`/`bare` 单行标记、
  路径原样输出 → porcelain parser 必须保路径大小写并解析这些标记；
- `git worktree remove` 在另一进程持有 cwd 时 exit 0（POSIX 允许 unlink 目录）
  → Linux cleanup 不需要 Windows 式句柄重试，但进程组终止仍必须先于 remove
  （D2/D3 之外的过程适配契约，见 process adapter）；
- `git worktree lock` 后 remove exit 128（`cannot remove a locked working tree`）
  与 dirty（untracked）remove exit 128 → remove 前置校验契约；
- POSIX process group kill 在无 trap 时终止组内孙进程（`child_alive=no`）；
  `trap "" TERM` 会经 SIG_IGN 被继承，cleanup 不得依赖 trap 清场；
- occupied-file：`flock` 持有下 `rmdir` 仍成功 → POSIX unlink 语义确认。

## 4. Pending（证据未齐，禁止实现前冻结语义）

1. macOS compare key case policy：APFS 默认大小写不敏感但保留大小写；需分别
   在大小写敏感/不敏感 APFS runner 采集，当前按大小写敏感实现并记录 gap；
2. Windows junction/reparse point containment 与 Git for Windows porcelain
   路径格式（大小写、引号、换行）；
3. Windows 进程树终止（taskkill /T、job object）与 locked-handle cleanup
   retry 的 terminal result 语义；
4. Git Bash 的 POSIX↔Windows 路径翻译是否进入 adapter 契约。

以上各项在真实 runner 证据补齐前，对应平台 adapter 保持 typed
`unverified_platform`（fail closed），不得按 Linux 行为类推上线。

## 5. 一致性要求

- `src/workspace/path-adapter.ts`（纯实现）是本 ADR 的唯一实现者；
- 业务模块不得新增 `process.platform` 分支（静态边界 `check-platform-boundaries.ts`）；
- `src/workspace/git-porcelain.ts` 保路径大小写、解析 `detached`/`locked`/`bare`
  标记，不调用真实 Git；
- 现有 `src/worktree/**` 行为不回滚：本 ADR 冻结后，新适配器与被接线模块
  消费本 ADR 语义；旧模块在 P5/P6 串行窗口迁移。
