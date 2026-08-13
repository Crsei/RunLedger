# Skill Registry 与 Discovery Provider 重构计划

> 文档角色：[`01-implementation-plan.md`](01-implementation-plan.md) 下的 Skill 专题执行计划；`01` 继续拥有 Plugin / MCP / Skill / Hooks 总状态，本文件不建立第二份总账。
>
> 编写日期：2026-08-12
>
> RunLedger 审阅基线：`d477dec`（`session-owner-runtime`）+ 当前未提交 Plugin/Skill/MCP live E2E 修复工作树；实施前必须重新记录 HEAD、工作树和 `01` 的差异。
>
> Oh My Pi 参考基线：`06aecdd51f`（`main`，只作行为与结构参考，不复制其全局状态、优先级覆盖或外部信任语义）。

## 0. 结论与计划边界

本次重构的目标不是简单把更多目录塞进 `discoverSkills()`，而是将 RunLedger 当前的“PluginManager 内部发现 Skill”拆成五个明确层次：

1. **被动 Capability/Provider 注册表**：显式注册“寻找什么”和“由谁发现”，不读磁盘、不持久化、不执行资源；
2. **Discovery Provider**：只产生带来源的候选 root/entry 和 diagnostics；不授予 trust，不启动脚本、Hook 或 MCP；
3. **统一 Skill 扫描与归一化**：复用同一套 frontmatter、预算、realpath containment、digest、resource facet 和 identity 规则；
4. **策略与激活**：在 discovery 之后应用 provider 开关、resource enable、trust/receipt、调用可见性和冲突规则；
5. **不可变 Session 快照与渐进披露**：模型常驻上下文只看到有界元数据，正文仍通过 exact resolver 按需读取并复核 digest/trust。

首轮实施只实例化 `skills` capability，不同时迁移 Hook、MCP、Plugin 或 Rules/Prompts。通用 registry 必须保持被动、最小和无 extension-specific 执行行为；只有第二种 capability 出现真实重复需求后，才允许抽取更多共用策略。

外部兼容来源（Codex、`~/.agents`、Claude、Claude 插件缓存等）必须**默认关闭**。启用 provider 只允许 RunLedger 发现候选，不能继承外部工具的 installed/enabled 状态作为 RunLedger trust，也不能绕过逐资源 receipt。RunLedger 不写回、禁用、卸载或修复任何外部工具目录/registry。

## 1. 当前实现基线与真实缺口

### 1.1 已有能力，必须保留

当前代码已经具备以下安全与运行时语义，重构不得降级：

- `src/extensions/skills/discovery.ts`：非递归 `skills/<name>/SKILL.md` 扫描、并发上限、frontmatter 校验、目录/文件 digest、references/assets/scripts facet、qualified identity 和 trust evaluation；
- `src/extensions/skills/catalog.ts`：exact qualified ID、唯一短名和含糊名拒绝；
- `src/extensions/skills/skill-tool.ts`：正文加载前重验 trust receipt 与 body digest，并以 `allowed-tools` 交集收窄当前工具；
- `src/extensions/skills/renderer.ts`：按模型上下文 2% 与 catalog 上限稳定渲染，不常驻注入正文；
- `src/extensions/snapshot.ts`、`manager.ts`、`turn-lifecycle.ts`：不可变快照、last-known-good 交换和 turn 内冻结；
- `src/runtime/session-runtime/extension-composition.ts`：标准 Session Owner production composition 持有 Skill resolver、Hook/MCP 生命周期与 ContextEngine source；
- 当前未提交 live E2E 修复已证明 Plugin-owned Skill 可从 catalog-only 首轮，经一次 exact `Skill` 调用加载正文，并在最终 provider-facing prompt/Trace 中可核对。

### 1.2 需要重构的耦合

当前 production 路径仍有四个结构性问题：

1. `PluginManager.discover()` 直接调用 `discoverSkills()`，同时拥有 Plugin manifest、Skill 扫描、Plugin trust 继承和 Skill 列表；Skill 不是独立注册表。
2. `ExtensionManager.currentSkills()` 实际代理 `PluginManager.skills()`；标准 Session composition 只向 PluginManager 注入 canonical user/workspace `plugins/` roots。
3. `src/extensions/paths.ts#discoverExtensionRoots()` 和 standalone user/project Skill discovery 已有行为/单测基础，但没有成为标准 Session 的统一 production 输入；“能扫描”不等于“已接入标准 CLI”。
4. provider 来源、provider 开关、resource enable、trust 和 model/user invocation visibility 尚未形成独立、可审计的状态层，不能安全扩展到 Codex/Agents/Claude 等兼容目录。

### 1.3 当前工作树边界

计划编写时工作树包含已有 Plugin/Skill/MCP/TUI/Runtime 修复，尤其涉及：

- `src/extensions/{plugins/manager,skills/{discovery,renderer,types}}.ts`；
- `src/runtime/{context/model-request-adapter,session-runtime/{domain,extension-composition},tools/skill}.ts`；
- 对应 Extension/Runtime/CLI/TUI tests；
- `development-doc/plugin-mcp-skill-hooks/01-implementation-plan.md` 的 2026-08-11 live E2E 记录。

实施不得从 `d477dec` 的纯 HEAD 推断这些文件为空闲，也不得覆盖现有未提交修复。开始 P0 前应先选择：在这些改动提交后的新分支执行，或在从相同工作树创建的明确 sibling worktree 中携带它们；禁止用 stash/reset 清场。

## 2. Oh My Pi 参考映射

### 2.1 可复用的设计思想

Oh My Pi 当前参考实现中，以下结构值得采用：

| 参考 | 可取部分 | RunLedger 落点 |
|---|---|---|
| `capability/{types,index,skill}.ts` | capability 定义、provider 元数据、并发 load、统一 diagnostics/introspection | 显式构造且可冻结的被动 registry；先只注册 `skills` |
| `discovery/*.ts` | 每个来源独立 provider；固定目录规则不泄漏给上层调用方 | `src/extensions/skills/providers/*.ts` |
| `discovery/helpers.ts#scanSkillsFromDir` | 所有 provider 复用同一非递归扫描语义 | RunLedger 统一 bounded scanner，继续使用自己的 storage/trust/digest 合同 |
| `extensibility/skills.ts` | 来源过滤、realpath 重复识别、稳定排序、常驻 metadata + 按需正文 | 拆成 provider policy、observation 合并、effective catalog view |
| `internal-urls/skill-protocol.ts` | 同一活动表解析 Skill 正文/相对资源的思路 | 先由 `Skill` tool 和 slash resolver 共用 exact loader；URI 协议后置 |
| system prompt 与 skill command | model discovery、用户显式调用、autoload 是不同上下文路径 | 建模成独立 visibility，不用一个 `enabled` 布尔值混代 |

### 2.2 明确不复制的语义

- 不使用模块 import 副作用注册全部 provider；测试和多 Session composition 必须能构造隔离 registry。
- 不使用进程全局可变 `Map`/disabled set；provider 配置由 canonical settings 快照注入。
- 不按 frontmatter `name` 做跨来源 first-wins 丢弃；同名不同资源全部保留 qualified identity，短名含糊时 fail closed。
- provider priority 只用于稳定调度、显示和 diagnostics，不授予覆盖权，也不形成 trust precedence。
- 不让 disabled 高优先级 provider 占住 key、遮蔽低优先级有效资源；disabled provider 在 discovery 前即被排除。
- 不把外部 installed plugin registry 的 `enabled:true` 解释为 RunLedger enable/trust；外部 `enabled:false` 最多作为“来源明确禁用”的负向输入。
- 不在 discovery 阶段读取/注入完整正文，更不执行 `scripts/`。
- 不直接用 `Bun.Glob`、`os.homedir()`、`process.cwd()` 或环境变量形成隐藏 authority；路径与设置由 composition root 解析一次后注入。

### 2.3 参考 provider 数量的使用方式

Oh My Pi 的 discovery 模块服务多个 capability；“注册了多个 discovery provider”不等于每个 provider 都提供 Skill。RunLedger 不以复刻 provider 数量为完成标准，而以每个启用来源都有以下闭环为标准：固定 locator、默认状态、bounded scan、provenance、冲突语义、trust、CLI/TUI 可见性、Session 隔离和最终 prompt 证据。

## 3. 固定架构决策

### D1 — Registry 是被动实例，不是全局服务

新增 `CapabilityRegistry`/`SkillRegistry` 均由 composition root 构造、注册、冻结。冻结后重复 capability ID、重复 provider ID、未知 capability 注册都返回 typed construction error；运行中只允许 reload 数据，不允许偷偷加入新 provider 实现。

### D2 — Discovery、enable、trust、invocation 四层分离

- provider enabled：是否运行该来源扫描；
- resource enabled：候选是否进入 active 集合；
- trusted/receipt valid：是否可读取正文；
- visibility：是否进入 model catalog、用户命令或仅 inspect。

任意一层关闭都不能由下一层反向开启。workspace/session 层只能收窄 user policy，不能把用户全局关闭的第三方 provider 重新打开。

### D3 — Provider 产出 observation，不产出授权结论

provider 输出的路径、manifest 状态和来源标签都只是 `SkillDiscoveryObservation`。统一 scanner/normalizer 才创建 `SkillDescriptor`、resource facets 和 digest；TrustStore/ExtensionStateStore 才决定 activation。

### D4 — Identity 继续以 canonical root + scope 为基础

继续使用 `sourceKey(source, canonicalRoot)` 与 `skill:<source-key-or-plugin-id>:<name>`。provider ID 记录在 provenance observation 中，不直接进入资源 identity；因此两个 provider 在同一 owner/source scope 下指向同一 realpath 时可合并观察而不改变 receipt identity。

同名但 canonical root、source scope 或 plugin owner 不同的 Skill 保持不同 qualified ID。即使物理 realpath 相同，只要一个来源是 Plugin child、另一个是 standalone external resource，也不能跨 trust owner 合并。短名只在 effective snapshot 中唯一时可用；任何冲突都返回 candidates，不按 provider rank 猜测。

### D5 — Provider rank 不拥有覆盖权

来源 rank 固定为：session 显式输入 > canonical workspace > 显式 repo input > canonical user > RunLedger plugin contribution > builtin > 外部兼容来源。它只决定稳定列表顺序和 diagnostics 展示；不会删除冲突项、复用 trust 或替调用方选择含糊短名。

### D6 — 外部目录默认关闭且只读

Codex、Agents、Claude、Claude plugins、Agent Plugins、Oh My Pi/OpenCode/GitHub compatibility providers 全部默认关闭。启用后：

- 只读，不创建目录、不写 state、不改 registry；
- 外部用户目录不因“属于当前 Unix 用户”自动 trusted；
- repo/项目目录不因 Git tracked 自动 trusted；
- 外部 plugin 的 install/enabled 信息只形成 provenance/diagnostic；
- 必须通过 RunLedger exact resource trust/receipt 后才可加载正文；
- scripts/assets/references 继续分别受能力边界约束。

### D7 — 当前 turn 使用同一 SkillRegistrySnapshot

provider reload 只能在 idle 时构建新 generation；当前 turn 的 catalog、resolver、tool list 和 ContextEngine receipt 全部绑定同一 snapshot digest。reload 中途 provider 文件变化导致 body digest 不匹配时返回 `stale`，不能读取新正文或回退到裸路径。

### D8 — Provider 故障局部化，但 authority 故障 fail closed

- 可选/外部 provider 缺目录：`unavailable`，不产生资源；
- 单个非法 Skill：记录有界 diagnostic，其他 Skill 可继续；
- enabled canonical provider 的状态文件、trust store 或 schema authority 无法读取：本次 snapshot 构建失败并保留 last-known-good；
- provider 抛出未分类异常、返回越界路径或重复矛盾 observation：该 provider `failed`，不发布其新候选；required provider 失败阻止交换；
- 任何失败都不能退回直接扫描默认 OS home。

## 4. 目标数据流

```text
composition root
  ├─ canonical layout / workspace key / cwd / repo boundary
  ├─ user + workspace SkillProviderPolicy snapshot
  └─ createRunledgerCapabilityRegistry()
          │ explicit register + freeze
          ▼
SkillRegistry.load(context, pluginContributions)
  ├─ select enabled providers before I/O
  ├─ providers concurrently return bounded observations
  ├─ common SkillScanner validates path/frontmatter/digest/facets
  ├─ merge same canonical identity observations
  ├─ apply ExtensionState + TrustStore + visibility policy
  └─ produce immutable SkillRegistrySnapshot
          │
          ├─ all/diagnostics/provider status ──> inspect / CLI / TUI
          ├─ modelDiscoverable ───────────────> bounded ContextEngine fragment
          ├─ userInvocable ──────────────────> slash resolver
          └─ active ─────────────────────────> SkillToolResolver
                                                   │ digest + receipt recheck
                                                   ▼
                                                SKILL.md body
```

`ExtensionManager` 仍是 Session extension snapshot 的唯一交换入口，但它不再向 `PluginManager.skills()` 取 Skill。新的顺序固定为：

1. PluginManager 发现/校验 Plugin，产出 Plugin descriptors、Hook/MCP contributions 和 passive `PluginSkillContribution[]`；
2. SkillRegistry 加载 standalone providers 与 Plugin contributions；
3. ExtensionManager 合并 Plugin/Skill/Hook/MCP descriptors，构建一个 generation/digest；
4. turn lifecycle 原子发布或保留旧快照。

## 5. 计划合同草案

以下只冻结职责和字段方向；P1 RED 合同测试通过前不得直接把草案复制成 production API。

```ts
export interface CapabilityDefinition<TObservation, TSnapshot> {
	readonly id: string;
	readonly displayName: string;
	readonly validateObservation: (value: TObservation) => readonly ExtensionDiagnostic[];
	readonly buildSnapshot: (input: CapabilityBuildInput<TObservation>) => Promise<TSnapshot>;
}

export interface DiscoveryProvider<TObservation> {
	readonly id: string;
	readonly displayName: string;
	readonly capabilityId: string;
	readonly rank: number;
	readonly defaultEnabled: boolean;
	load(context: DiscoveryContext): Promise<DiscoveryProviderResult<TObservation>>;
}

export interface SkillDiscoveryObservation {
	readonly providerId: string;
	readonly source: ExtensionSource;
	readonly level: "builtin" | "user" | "workspace" | "project" | "plugin" | "session";
	readonly canonicalRoot: string;
	readonly scanKind: "skills-directory" | "single-skill-directory";
	readonly pluginId?: string;
	readonly inheritedTrustBinding?: SkillTrustBinding;
	readonly sourceRegistry?: Readonly<{
		locatorDigest: string;
		entryId: string;
		declaredEnabled?: boolean;
	}>;
}

export interface SkillRegistrySnapshot {
	readonly generation: number;
	readonly digest: string;
	readonly providers: readonly SkillProviderStatus[];
	readonly all: readonly SkillDescriptor[];
	readonly active: readonly SkillDescriptor[];
	readonly modelDiscoverable: readonly SkillDescriptor[];
	readonly userInvocable: readonly SkillDescriptor[];
	readonly diagnostics: readonly ExtensionDiagnostic[];
}
```

额外合同约束：

- registry 对外暴露 readonly array/map，构建后 `Object.freeze`；
- provider result 必须携带自身 ID，由 registry 覆盖/校验而不是信任 provider 填写；
- diagnostics 排序键至少为 `provider rank/provider id/source locator/code/resource id`；
- provider 不持有 TrustStore、ExtensionStateStore、Gateway、Agent、MCP client 或 process handle；
- Plugin contribution 的 inherited receipt 只复用 parent binding 校验，不跳过 Skill body/resource facet digest；
- public Session snapshot 只投影 locator digest/来源标签，不泄漏 OS home 或完整外部路径；CLI `show --local-path` 若后续需要，必须是本地 authenticated read-only 命令且不进入模型上下文/ledger。

## 6. Provider 清单与分批启用

### 6.1 第一批：RunLedger canonical providers

| Provider ID | 固定输入 | 默认 | Trust | 说明 |
|---|---|---:|---|---|
| `runledger-builtin` | composition root 注入的 builtin skill roots | on | system/builtin policy | 不从 npm package 相对 cwd 猜路径 |
| `runledger-user` | `<home>/state/extensions/user/skills/` | on | exact user resource receipt | 缺目录视为空，不自动创建 |
| `runledger-workspace` | `<home>/state/extensions/workspaces/<storage-key>/skills/` | on | exact workspace resource receipt | 只服务当前 workspace storage identity |
| `runledger-repo` | 受信 settings 显式开启后扫描 repo/ancestor `.runledger/skills/` | off | 默认 untrusted | 只读、bounded ancestor、不得写 repo `.runledger` |
| `runledger-plugin` | `PluginManager` 的 passive Skill contributions | on | parent Plugin binding + child digest | 保持当前 Plugin-owned Skill live 语义 |
| `runledger-session` | authenticated Session command 注入的临时 root | off/empty | session-scoped exact receipt | 不持久化 root，不跨 Session |

P2 完成时，production 必须至少真正装配 `runledger-user`、`runledger-workspace` 和 `runledger-plugin`；不能只在单元测试中构造 roots。

### 6.2 第二批：优先兼容 providers

| Provider ID | 输入 | 默认 | 外部 registry 语义 |
|---|---|---:|---|
| `codex-user` | 显式解析的 `<os-user-home>/.codex/skills/` | off | 不读取 Codex enable 配置；RunLedger policy + trust 独立 |
| `codex-project` | repo boundary 内 `.codex/skills/` | off | 当前 workspace 只读，默认 untrusted |
| `agents-user` | `<os-user-home>/.agents/skills/` 与兼容 `.agent/skills/` | off | 两目录分别形成 observation，不按 name 覆盖 |
| `agents-project` | repo boundary 内 `.agents/skills/`/`.agent/skills/` | off | bounded ancestor，越近只改变 rank，不覆盖 identity |
| `claude-user` | `<os-user-home>/.claude/skills/` | off | 不读取 Claude settings 的 enabledPlugins 作为授权 |
| `claude-project` | repo boundary 内 ancestor `.claude/skills/` | off | bounded ancestor，默认 untrusted |
| `claude-plugins` | `~/.claude/plugins/installed_plugins.json` 指向的已安装 roots | off | `enabled:false` 可抑制该 source entry；缺失/true 不等于 RunLedger trusted |
| `agent-plugins` | 用户显式提供或可信 registry 指向的 Agent Plugins `plugin.json` roots | off | 仅导入标准 skills contribution；不执行 plugin code |

`claude-plugins` 首个 fixture 必须覆盖用户描述的真实问题：Claude settings 把 plugin 标为 false、installed registry 未写 `enabled:false` 时，RunLedger 仍只把它视为“可发现候选”；在 RunLedger provider 未开启或 resource 未 trust 时，不得出现在模型 catalog，也不得读取正文。

### 6.3 后置兼容 providers

`omp-user/project`、`omp-plugins`、`opencode-user/project`、`github-project` 等仅在第二批完成真实 E2E 后逐个增加。每增加一个 provider 必须单独提交固定 locator、默认关闭、fixture、诊断和 provenance；不得以一个“third-party fallback”开关把未知 provider 一起打开。

Gemini/Cursor/Windsurf/Cline/VS Code 等若参考实现当前只提供其他 capability，不为了凑数量虚构 Skill 路径。

## 7. 冲突、重复和可见性规则

### 7.1 相同文件被多个 provider 发现

先 realpath，再以 `source scope + canonical root/plugin owner + skill name` 形成 identity。同一 trust owner 下、同一 identity/body digest 的多次 observation 合并为一个 descriptor，并保留按 provider ID 排序的 `observedBy`。任何 provider 开关变化不应改变该资源的 receipt identity。

不同 trust owner 即使最终指向同一物理文件也不合并：例如 Plugin child 与 standalone external provider 必须保持各自 identity、receipt 和 provenance，并产生 alias diagnostic，避免一个 owner 的 trust 泄漏给另一个 owner。

同一 identity 却出现不同 canonical path/body digest 是 invariant failure；不得 first-wins，必须标记 failed 并阻止该 descriptor 激活。

### 7.2 同名不同资源

- inspect/list 保留全部 qualified ID；
- model catalog 可同时显示，但每行必须明确 `name` 与 `qualifiedId`；
- `Skill({name: "foo"})` 只在 effective active 集合唯一时成功；
- 含糊时返回 typed `ambiguous` + bounded candidates，`isError=true`；
- provider rank、目录深度、安装时间和外部 enabled 状态都不能替模型/用户猜选。

### 7.3 四种 visibility

| View | 条件 | 消费者 |
|---|---|---|
| `all` | 发现并成功归一化，含 disabled/blocked | inspect、CLI/TUI diagnostics |
| `active` | provider on + resource enabled + trust valid + digest current | exact Skill loader |
| `modelDiscoverable` | active + `disable-model-invocation !== true` | system prompt catalog、模型 Skill tool |
| `userInvocable` | active + `user-invocable !== false` | `/skill:<name>`/显式用户调用 |

`hide` 若作为兼容字段进入 parser，只映射为“不进入 `modelDiscoverable`”，不能等同 disabled。当前 canonical frontmatter 继续以 `disable-model-invocation` 为主；未知兼容字段不应悄悄改变权限。

## 8. 配置与管理面

### 8.1 Canonical policy

provider policy 进入 user/workspace canonical settings 的版本化 `skills` 节点；resource enable 和 trust 继续由 `ExtensionStateStore`/`TrustStore` 持有，避免把不同 authority 混成一个 JSON：

```json
{
  "skills": {
    "enabled": true,
    "providers": {
      "runledger-user": true,
      "runledger-workspace": true,
      "runledger-plugin": true,
      "codex-user": false,
      "agents-user": false,
      "claude-plugins": false
    }
  }
}
```

规则：

- schema 只接受已知 provider exact ID 和 boolean；未知 ID 保留 diagnostic，不自动运行；
- user `skills.enabled=false` 是总闸；workspace 和 Session 只能进一步关闭；
- workspace `providers[id]=true` 不能反转 user `false`；
- 不采用 name-only `disabledExtensions` 或 glob 作为 trust/identity authority；如后续提供 include/exclude，只接受 qualified ID pattern，并在同一文档明确 pattern 语义；
- provider enable mutation 必须走 Session Owner command、revision/idempotency/receipt，不允许 TUI 直接写 settings；
- 外部 path 不保存到 provider policy。OS home、repo root 和 canonical layout 由 composition root 解析并以 typed locator 注入。

### 8.2 CLI/TUI 目标

在 registry 读路径稳定后增加：

- `runledger skill provider list [--json]`：显示 provider ID、默认/有效状态、来源 scope、last load status、candidate/active/error 数；
- `runledger skill provider enable|disable <provider-id> [--scope user|workspace]`：只改 canonical policy 并请求 idle reload；
- `runledger skill list|show <qualified-id>`：默认脱敏路径；
- `runledger skill trust|untrust <qualified-id>`：显示 exact identity、digest、source 后走现有 Runtime Resource receipt；
- TUI `/skills` 增 provider/filter 视图，但 mutation 仍通过 authenticated Session command；
- 所有 JSON 输出固定 schema 标识（内容寻址 digest，不采用数字 schema 版本号），stdout 只放结果，diagnostic/log 走 stderr。

首轮 registry cutover 不以 UI 完成为前置；但兼容 provider 在没有可审计 enable + trust 路径前不得从默认 off 改为可用。

### 8.3 明确不做的管理动作

- 不实现外部 plugin install/update/uninstall；
- 不执行 `omp plugin disable`、Claude/Codex settings 修改；
- 不自动复制、symlink 或迁移外部 Skill 到 RunLedger home；
- 不因发现同名 Skill 删除任何文件；
- 不把 Marketplace/网络下载纳入本重构。

## 9. 文件与所有权规划

目标结构（名称可在 P1 合同测试中微调，职责不可合并回 PluginManager）：

```text
src/extensions/
├── capabilities/
│   ├── types.ts                 # 被动 capability/provider 合同
│   └── registry.ts              # 显式 register/freeze/introspection/load orchestration
├── skills/
│   ├── registry.ts              # Skill observation -> immutable snapshot
│   ├── policy.ts                # user/workspace/session provider policy 合并
│   ├── scanner.ts               # common bounded scanner（由现 discovery.ts 拆出）
│   ├── discovery.ts             # 兼容 facade 仅在迁移期存在，最终删除或收窄
│   ├── catalog.ts
│   ├── renderer.ts
│   ├── skill-tool.ts
│   ├── types.ts
│   └── providers/
│       ├── index.ts             # 显式 factory，不靠 import side effects
│       ├── runledger.ts
│       ├── plugin-contributions.ts
│       ├── codex.ts
│       ├── agents.ts
│       ├── claude.ts
│       ├── claude-plugins.ts
│       └── agent-plugins.ts
└── plugins/manager.ts           # 只输出 passive Skill contributions
```

共享接线：

| 文件 | 计划改动 |
|---|---|
| `src/extensions/manager.ts` | 同时持有 PluginManager 与 SkillRegistry；统一 build/swap |
| `src/extensions/snapshot.ts` | digest/counts 纳入 provider status 与 Skill snapshot ref，不泄漏对象 |
| `src/extensions/types.ts` | provider/source observation 的中立 public descriptor 字段 |
| `src/extensions/plugins/manager.ts` | 删除内部 Skill catalog ownership，改为 passive contributions |
| `src/storage/settings-manager.ts` | 精确解析/保存 `skills` policy；workspace 只能收窄 |
| `src/runtime/session-runtime/extension-composition.ts` | composition root 显式注册 provider、注入路径/policy、让 resolver/context 绑定同一 Skill snapshot |
| `src/cli/control-commands.ts`、Session protocol/domain | provider inspect/mutation 与 resource trust commands |
| `src/tui/interactive-mode.ts`、extension selectors | 读取 provider status；后续 mutation 走 command |
| `scripts/check-execution-boundaries.ts` | 禁止 provider 导入 fs/process/network/TrustStore/Gateway 执行端口 |

resident Host 兼容接线只在标准 Session Owner 路径通过后做等价更新，不得成为第二个 registry owner。R9 删除窗口前两条 composition 的 provider factory 必须复用同一实现。

## 10. 分阶段执行计划

### P0 — 基线冻结与 characterization（无 production 行为变化）

- [x] 记录 RunLedger HEAD、当前未提交路径、`01` 差异、Oh My Pi HEAD 和实施 worktree；
- [x] 把当前 Plugin-owned Skill qualified ID、receipt inheritance、catalog 文本、ContextEngine fragment、loader error 与 turn snapshot 固定成 characterization tests；
- [x] 增加 production composition characterization：standalone user/workspace Skills 当前不进入标准 Session（记录 gap，不伪装已支持）；
- [x] 固定同名 ambiguous、body stale、symlink escape、catalog budget、`disable-model-invocation` 当前行为；
- [x] 保存一个最小 Plugin Skill fixture 和一个 standalone Skill fixture；不使用真实 `~/.codex`/`~/.claude`。

验收：只新增测试/fixture/文档；现有 live 修复语义有可失败的基线保护。若当前未提交修复尚未形成稳定差异，停止重构并先确定其提交/保留边界。

P0 验收证据（2026-08-13，见 §15）：未提交 live 修复形成稳定差异（26 files / 466+/38-），实施在 sibling worktree 携带；`npm run check` EXIT=0，完整 `npm test` 314 files / 1825 passed / 3 skipped EXIT=0，Bun OpenTUI 66 pass；新增 `tests/extensions/skills-characterization.test.ts`（10 测试）、`extensions-domain.test.ts` gap 测试（+1）、`tests/fixtures/extensions/skills/{plugin-skill,standalone-skill}`；全部行为固定无 production 代码变更。

### P1 — RED 合同：被动 registry 与 provider construction

- [x] 为 duplicate capability/provider、register-after-freeze、unknown capability、deterministic provider order 写 RED；
- [x] 为 provider exception、timeout/abort、diagnostic sorting、disabled-before-I/O 写 RED；
- [x] 实现最小 `CapabilityRegistry`，不接 production；
- [x] 实现 `SkillDiscoveryObservation`、`SkillProviderStatus`、`SkillRegistrySnapshot` schema/类型；
- [x] 增 execution-boundary 测试，provider 不得 import execution/Gateway/client/process modules；
- [x] 验证严格 TS、erasable syntax、无 `any`、无动态 import。

验收：registry 可在两个测试 Session 中隔离构造；一个 Session 的 provider enable/registration 不影响另一个；尚不改变 ExtensionManager 输出。

P1 验收证据（2026-08-13，见 §15.2）：`tests/extensions/capabilities/registry.test.ts`（11 测试）+ `boundaries.test.ts`（5 测试）+ `tests/extensions/skills/registry-types.test.ts`（4 测试）全绿；`npm run check` EXIT=0；ExtensionManager 输出不变（既有 extensions-domain 套件无回归）。

### P2 — RED→GREEN：RunLedger canonical provider cutover

- [x] 将通用扫描从 `discoverSkills()` 拆为 common scanner；保持 frontmatter/digest/facet/containment 输出等价；
- [x] 实现 builtin/user/workspace/repo/session providers；repo/session 默认 off；
- [x] PluginManager 改为输出 `PluginSkillContribution[]`，不再拥有最终 SkillCatalog；
- [x] SkillRegistry 合并 standalone observations 与 plugin contributions；
- [x] ExtensionManager 从 SkillRegistry 读取 current Skills，并在一个 snapshot generation 内合并全部 descriptor；
- [x] standard Session Owner composition 显式装配 canonical providers；
- [x] resident Host compatibility composition 复用同一 factory，不复制 provider 列表；
- [x] 删除 PluginManager 的 `skills()` ownership 和已无调用的兼容路径。

验收：现有 Plugin live fixture identity/receipt/catalog 不变；新增 canonical user/workspace standalone Skill 在 production composition 可 inspect、trust、进入 catalog、按需读取；provider 未启用时零 I/O。

P2 验收证据（2026-08-13，见 §15.3）：Plugin qualified identity/receipt/catalog 无回归（characterization 套件随机制更新后全绿）；production composition acceptance 测试覆盖 standalone inspect→trust→catalog→正文→untrust 全流程；`npm run check` EXIT=0；完整 `npm test` 318 files / 1852 passed / 3 skipped EXIT=0；`npm run build` EXIT=0。

### P3 — RED→GREEN：策略、冲突与 visibility

- [x] 在 settings schema 增 versioned `skills` policy；user/workspace/session 合并只允许收窄；
- [x] provider disabled、resource disabled、untrusted/stale、model hidden、user non-invocable 分别有独立测试；
- [x] 同 realpath 多 observation 合并并保留 `observedBy`；
- [x] 同名不同 identity 保留并拒绝短名；
- [x] renderer 只消费 `modelDiscoverable`，不得只检查 `enabled`；
- [x] slash/user resolver 只消费 `userInvocable`；模型 Tool 只消费 `modelDiscoverable` 或在 resolver 再次强制同一 flag；
- [x] provider status/counts 进入有界 public snapshot 和 snapshot digest。

验收：关闭 provider 不会遮蔽其他 provider；`hide`/`disable-model-invocation` 不进模型清单但可按允许的用户路径显式调用；untrusted 候选只在 inspect 可见。

P3 验收证据（2026-08-13，见 §15.4）：四视图矩阵独立测试通过；`npm run check` EXIT=0；完整 `npm test` 319 files / 1866 passed / 3 skipped EXIT=0；`npm run build` EXIT=0。

### P4 — RED→GREEN：Codex 与 Agents compatibility providers

- [x] composition root 显式解析 OS home/repo boundary，providers 不自行调用 `homedir()`/`cwd()`；
- [x] 实现 `codex-user/project` 与 `agents-user/project` 固定目录；
- [x] 全部默认 off，missing directory 为 unavailable；
- [x] 覆盖 `.agents`/`.agent`、`.codex` ancestor boundary、symlink escape、case collision、oversize 和重复 realpath；
- [x] provider enable 后候选仍 untrusted，trust exact Skill 后才 active；
- [x] 用隔离 fake home/repo 验证，不读取真实用户目录。

验收：可在隔离 `RUNLEDGER_DIR` + fake OS home 下重现“同一个 Skill 在 Codex 与 Agents 有副本”的情况；same realpath 合并、不同文件同名 ambiguous，不出现 first-wins。

P4 验收证据（2026-08-13，见 §15.5）：fake home/repo 隔离测试全绿（同 realpath 合并沿用 P2 合并测试；同名跨来源 ambiguous 不 first-wins；trust exact Skill 后 active）；`npm run check` EXIT=0；完整 `npm test` 320 files / 1874 passed / 3 skipped EXIT=0；`npm run build` EXIT=0。

### P5 — RED→GREEN：Claude 与 plugin registry compatibility

- [x] 实现 Claude user/project skills roots；
- [x] 为真实 `{version, plugins: {id: entry[]}}` `installed_plugins.json` 定义有界 parser，只读取必要 identity/installPath/version/enabled/scope/projectPath 字段；
- [x] installPath 必须 absolute、realpath 可解析、在允许的 plugin cache/root policy 内；registry/path escape 只产生 blocked diagnostic；
- [x] `enabled:false` 抑制该外部 entry，true/缺失不授 RunLedger trust；`local` entry 只在 projectPath 与当前 boundary 匹配时进入 project scope；
- [x] 不读取/写回 Claude settings 作为 RunLedger authority；可把检测到的冲突状态显示为 diagnostic；
- [x] plugin skills 继续经 common scanner，Plugin package root containment 与 child digest 都要复核；
- [x] fixture 覆盖 superpowers/oh-my-mermaid 风格的同名副本、disabled entry 与 local project scope，不依赖真实第三方内容。

验收：RunLedger provider off 时外部 Skill 不可见；provider on 但 untrusted 时仅 inspect 可见；exact trust 后按需读取；外部 registry/文件从未被修改。

### P6 — 管理面与审计闭环

- [x] 增 provider list/enable/disable command/query schema、revision/idempotency 与 owner-fenced event；
- [x] 增 standalone Skill trust/untrust exact-resource command，复用 Runtime Resource receipt，不新建第二套 PermissionEngine；
- [x] CLI human/JSON 与稳定 exit code；
- [x] TUI `/skills` 显示 provider、source、trust、active/hidden/ambiguous/failed；
- [x] idle reload 有 pending/success/failure subscription，当前 turn 不变；
- [x] 审计只记 provider ID、policy revision、resource identity/digest、计数和诊断摘要；不写完整外部路径、Skill 正文或外部 registry 内容。

验收：另一个 client 能观察 provider mutation/reload；断线重连后从 durable policy/snapshot projection 恢复；mutation outcome uncertain 时不盲目重试写入。

### P7 — 上下文与调用路径联合验收

- [x] system prompt 只含 `modelDiscoverable` metadata，预算稳定；
- [x] `Skill` Tool、`/skill:<name>` 和其他已支持显式语法走同一 catalog/exact loader；
- [x] user invocation 以用户身份进入会话，model Tool result 保持 toolResult 身份，两者 provenance 不混；
- [x] 若增加 `skill://`，必须复用当前 snapshot resolver、realpath containment、trust/digest 和资源预算；不得创建独立全局 active table；
- [x] 子代理 autoload/per-task pinning 在 RunLedger 有正式 agent manifest/session contract 前保持 deferred，不用父 Session 全量列表临时替代；
- [x] Trace `context.assembled` 验证 selected Skill fragment 真正进入 provider-facing request，正文只在调用后的后续上下文出现。

验收：catalog-only 首轮、一次 exact 调用、正文后续可见、disabled/hidden/ambiguous/stale 负向路径都在最终 provider request/Trace 层成立。

### P8 — 真实 smoke、清理与发布门禁

- [x] `npm run check`、focused tests、完整 `npm test`、`npm run build`；完整输出不截断；
- [x] `git diff --check`、execution/runtime/storage/session-owner boundaries；
- [x] 重建 `dist`，核对 `which runledger` 与全局 npm link；
- [ ] 使用隔离 `RUNLEDGER_DIR`、fake external homes 和真实 TTY/tmux 验证 provider list/toggle、Skill list、catalog、调用与 reload；当前 worktree 环境阻塞见 §15.6；
- [ ] 至少一次本 worktree 真实模型 E2E，检查 Trace/artifact 不含凭据、完整外部 home path 和未调用 Skill 正文；当前仅有 2026-08-11 既有语义证据，不能计作本轮 fresh 证据；
- [x] 审阅所有 provider 默认值，确认 compatibility provider 仍为 off；
- [x] 删除旧 PluginManager Skill ownership、重复 scanner、临时 adapter/feature flag；不保留 silent fallback；
- [x] 回写本文件阶段证据和 `01` 总状态；不以 focused gate 代替完整 gate。

验收：标准 PATH `runledger` 使用新 registry；一个 provider 失败不影响其他 optional provider，required authority failure 保留 last-known-good；无 orphan process（本专项本身不应由 discovery 启动任何进程）。

## 11. 测试矩阵

### 11.1 Registry/Provider 单元测试

- 显式 register/freeze、重复 ID、隔离实例；
- provider rank 稳定但不覆盖；
- disabled provider 的 `load()` 从未调用；
- 并发完成顺序不同仍生成同一 snapshot digest；
- optional unavailable、provider failed、required authority failed；
- abort/reload 并发与旧 generation 保留；
- diagnostics 数量/字符/路径投影预算。

### 11.2 Scanner/Identity 安全测试

- immediate child only、目录 basename 与 frontmatter name 不一致；
- absolute/`..`/symlink/device/escape/case collision；
- body/references/assets/scripts 分别超限；
- 同 realpath 多 provider observation；
- 同名不同 root/plugin owner；
- discovery 后文件替换、receipt stale/revoked；
- external registry installPath escape、dangling path、duplicate entry、unknown version。

### 11.3 Policy/Context 测试

- user master off、workspace 不能 reopen、Session 可临时 narrow；
- provider on 不等于 resource enabled/trusted；
- `disable-model-invocation`、`user-invocable` 四视图矩阵；
- untrusted/disabled provider 不进入 final ContextEngine fragment；
- renderer 预算、稳定排序、qualified field 格式；
- loader failure `isError=true`；
- allowed-tools 只能交集收窄；
- same-turn reload 不改变 catalog/resolver。

### 11.4 Production/E2E 测试

- canonical user + workspace + Plugin Skill 同 Session；
- 两个 Session 使用不同 workspace provider policy/roots，不共享 registry mutable state；
- local/remote client attach 后观察同一 provider snapshot；
- provider enable → idle reload → exact trust → prompt catalog → body call；
- disable/revoke → next turn 撤出，不重放旧正文或副作用；
- real model Trace 验证 progressive disclosure 和路径/secret redaction。

## 12. 提交切分与停止规则

建议每阶段至多两个提交，且只暂存明确路径：

1. `test(extensions): freeze Skill registry behavior before provider cutover`
2. `refactor(extensions): isolate passive capability discovery registry`
3. `refactor(skills): make canonical providers own Skill discovery`
4. `feat(skills): add governed provider policy and visibility views`
5. `feat(skills): discover opted-in Codex and Agents sources`
6. `feat(skills): import opted-in Claude plugin Skill metadata safely`
7. `feat(skills): govern provider and standalone Skill mutations`
8. `test(skills): verify progressive disclosure across providers`

停止规则：

- 当前 live E2E 修复未形成可复用基线或 shared files 冲突未审清时，停在 P0；
- registry 需要 import execution/Gateway/process 才能工作时，说明边界设计错误，停在 P1；
- Plugin Skill qualified identity/receipt/catalog 发生未计划变化时，停在 P2；
- workspace 能开启 user 禁用 provider、provider enable 自动授 trust、同名资源被 first-wins 丢弃时，不得进入兼容 provider；
- 无隔离 fake home/registry fixtures 时，不读取真实 `~/.codex`、`~/.agents`、`~/.claude` 做自动测试；
- 没有 exact trust mutation 和最终 provider-facing prompt 证据时，compatibility provider 保持默认 off；
- 完整 gate 被无关既有文件阻断时，记录 focused 证据和精确 blocker，不修改无关文件制造全绿；
- 未经用户明确要求不 commit、不 push，也不操作真实用户 RunLedger/Claude/Codex state。

## 13. Definition of Done

本专项只有同时满足以下条件才能在 `01` 中标为完成：

- Skill discovery 不再由 PluginManager 私有拥有；standalone 与 Plugin contributions 共用一个 SkillRegistry；
- registry/provider 均是显式、被动、Session 隔离且可 introspect 的实例；
- canonical user/workspace/Plugin providers 已在标准 Session Owner production composition 生效；
- 外部 compatibility providers 默认 off，enable 与 trust 分离，且从不写回外部 registry；
- 相同文件重复观察可合并，同名不同资源不丢失、不猜选；
- model/user/inspect/active 四视图有独立测试，hidden 不等于 disabled；
- current turn 固定 snapshot，reload 只在 idle 原子交换；
- Plugin-owned Skill 的现有 live E2E、qualified identity、trust inheritance 和 progressive disclosure 无回归；
- CLI/TUI 能解释“来自哪个 provider、为什么 blocked/hidden/ambiguous”，mutation 走 Session Owner；
- focused、完整仓库、build、boundary、标准 PATH TTY 与至少一次真实模型 Trace 验证完成；
- `01-implementation-plan.md` 回写最终状态/证据，本文件保留设计与阶段证据但不篡夺总状态 authority。

## 14. 参考文件

### RunLedger

- `src/extensions/{manager,snapshot,paths,types}.ts`
- `src/extensions/plugins/manager.ts`
- `src/extensions/skills/{types,frontmatter,discovery,catalog,renderer,skill-tool}.ts`
- `src/extensions/{state-store,storage-port}.ts`
- `src/extensions/trust/{trust-store,digest,types}.ts`
- `src/storage/{settings-manager,extensions/extension-storage}.ts`
- `src/runtime/session-runtime/{domain,extension-composition}.ts`
- `src/runtime/context/model-request-adapter.ts`
- `src/runtime/tools/skill.ts`
- `tests/extensions/{skills,plugins,host-manager}.test.ts`
- `tests/runtime/session-runtime/extensions-domain.test.ts`

### Oh My Pi（只读参考）

- `packages/coding-agent/src/capability/{types,index,skill}.ts`
- `packages/coding-agent/src/discovery/{index,helpers,builtin,omp-plugins,agent-plugins,claude,claude-plugins,agents,codex,github,opencode}.ts`
- `packages/coding-agent/src/extensibility/skills.ts`
- `packages/coding-agent/src/internal-urls/skill-protocol.ts`
- `packages/coding-agent/src/modes/skill-command.ts`
- `packages/coding-agent/src/prompts/system/system-prompt.md`

## 15. P0 执行记录（2026-08-13）

实施选择：从相同工作树创建明确 sibling worktree 携带未提交 live E2E 修复，不使用 stash/reset，不在 d477dec 纯 HEAD 上推断文件空闲。

- RunLedger HEAD：`d477dec`（`session-owner-runtime`，`merge: integrate conversation permission view`）。
- 实施 worktree：`/data2-HDD-SATA-20T/Digital_avatar/haoweiyao/RunLedger-skill-registry`，分支 `worktree/skill-registry`，从 `d477dec` 创建；创建后按主工作树 `git status --porcelain` 逐路径复制未提交状态（26 个 modified + 2 个 untracked，28 条全部一致）。
- 未提交路径（即 §1.3 的 live 修复基线，`git diff --stat` = 26 files / 466 insertions / 38 deletions）：
  - `src/extensions/{plugins/manager,skills/{discovery,renderer,types},mcp/sdk-factory}.ts`；
  - `src/runtime/{context/model-request-adapter,session-runtime/{domain,extension-composition},tools/skill}.ts`；
  - `src/cli/{main,runtime-host-session,runtime-host}.ts`、`src/tui/interactive-mode.ts`；
  - 对应 `tests/{extensions,cli,runtime/context,runtime/session-runtime,tools-m4,tui}` 修改；
  - untracked：本文件（02 计划）与 `development-doc/tui/23-codex-syntax-highlighting-replication-plan.md`。
- `01` 差异：`01-implementation-plan.md` 处于未提交修改状态，含 2026-08-11 DeepSeek live E2E 修复记录（MCP `get-sum=42`、Plugin-owned Skill progressive disclosure、根因一/二/三修复）；本轮不修改 `01` 总账（P8 才回写最终状态）。
- Oh My Pi 参考 HEAD：`06aecdd51f`（`main`），与计划编写时基线一致；`~/pi` 另有一份 `3f1762cc`（仅作补充参考，不复制其全局状态）。
- 基线门禁（worktree 内）：`npm run check` EXIT=0（全部 boundary checks + `tsc --noEmit` 通过）；focused `skills/plugins/extensions-domain/host-manager` 4 files / 30 tests 通过；完整 `npm test` 结果见下方追加记录。
- 文档对齐：`02` §8.2 原要求“所有 JSON 输出固定数字 schema 版本字段”，触发 `scripts/check-current-format.ts` 的 numeric schema field 边界（正则匹配数字 schema 字段名，仓库约定禁止第一方代码/测试/文档引入数字 schema 字段）；已改写为“固定 schema 标识（内容寻址 digest，不采用数字 schema 版本号）”，保留“stdout 只放结果、diagnostic/log 走 stderr”语义，使 `npm run check` 全绿。
- 待办：完整 `npm test` 基线结果、P0 characterization tests（`tests/extensions/skills-characterization.test.ts`）、production composition standalone gap 测试、fixtures（`tests/fixtures/extensions/skills/{plugin-skill,standalone-skill}`）与行为固定。


### 15.1 P0 完成证据（2026-08-13）

无 production 代码变更；只新增测试/fixture/文档。新增：

- `tests/extensions/skills-characterization.test.ts` —— 10 测试，四组 describe：
  1. Plugin-owned Skill 身份与 receipt 继承：exact qualifiedId `skill:plugin:<sourceKey>:<pluginName>:<name>`、`descriptor.pluginId`、`trustBinding.identity.qualifiedId === pluginId`、`receiptId === plugin approvalReceiptId`；untrust 后 `skills()` 立即清空；
  2. catalog 文本与 ContextEngine fragment：header/row 格式、不注入正文、bounded + 输入序稳定、maxChars=0 空、2% model context 预算、ready-filter 后排除 blocked；
  3. loader 错误矩阵：not_found / ambiguous（2 candidates）/ stale（body 变更）/ blocked（untrusted）；`disable-model-invocation` 仅挡 model-tool trigger，`$`/`/`/`/skill ` 仍可用；
  4. discovery containment 与 turn snapshot：symlink skill 条目静默跳过（无 descriptor、无 `skill.path_escape` diagnostic）；`beginTurn` 固定 snapshot、turn 内 reload 为 pending、`endTurn` 才 swap；plugin root 新增文件使 binding digest 变化 → `trust: "stale"`、activation blocked、skills 清空。
- `tests/runtime/session-runtime/extensions-domain.test.ts` —— 新增 production gap 测试：正控 plugin Skill 进入 `skill.list`/ContextEngine/Skill tool，而 canonical standalone `user/skills/` 下 Skill 不可见（`skill.list` 无、ContextEngine 无、loader `not_found`）。
- `tests/fixtures/extensions/skills/plugin-skill/`（`.runledger-plugin/plugin.json` + `skills/release-review/SKILL.md`）与 `standalone-skill/skills/release-review/SKILL.md`；characterization 直接消费两 fixture（plugin fixture 经 trust+enable 后 ready，standalone fixture blocked）。

行为固定中发现并记录（P2 设计输入）：

1. trusted plugin Skill 的 `provenance.parentResourceId` 当前为 undefined；plugin 归属经 `descriptor.pluginId` + `trustBinding.identity` 表达（untrusted 分支的 `componentDescriptor` 才写 parentResourceId）。
2. renderer（`renderSkillCatalog`）只检查 `descriptor.enabled`，不检查 activation；production composition 在调用前自行过滤 `activation === "ready"`。P3 的 `modelDiscoverable` 视图需沿用或替换该过滤。
3. discovery 对 symlink skill 条目静默跳过（`readDirectory` 把 symlink 归为非 directory）；`skill.path_escape` 只在 containment resolve 失败路径出现。P2 统一 scanner 需显式决定该语义。
4. plugin binding 是内容寻址的：plugin root 下任何文件变更 → `TrustStore.evaluate` 返回 `stale` → 整个 plugin（含其 Skills）blocked。skill 级 body digest 复核在 loader 层独立存在。

门禁：`npm run check` EXIT=0；focused 5 files / 41 tests 通过；完整 `npm test` 314 files / 1825 passed / 3 skipped EXIT=0（基线 1814 + 新增 11）；Bun OpenTUI 66 pass。`tests/cli/multi-client/acceptance-runners.test.ts` 与 `tests/runtime/current-format-boundary.test.ts` 在 worktree 初建的 2 个失败均为环境/文档产物（缺 `dist/`、§15 初稿引用数字 schema 字段名），已随 `npm run build` 与文档改写消除，非代码回归。

### 15.2 P1 完成证据（2026-08-13）

新增 production 文件（不接 production composition，ExtensionManager 输出不变）：

- `src/extensions/capabilities/types.ts` —— `CapabilityDefinition` / `DiscoveryProvider` / `DiscoveryContext` / `DiscoveryProviderResult` / `ProviderStatus` / `CapabilityRegisterError` / `CapabilityLoadResult`；provider result 必须携带自身 ID，registry 校验等于已注册 provider，不信任自报；
- `src/extensions/capabilities/registry.ts` —— `CapabilityRegistry`：registerCapability/registerProvider/freeze（冻结后重复 ID、未知 capability、注册一律 typed `frozen`/`duplicate_*`/`unknown_capability`）；`load()` 先按 policy 过滤（disabled provider 的 `load()` 从不调用，I/O 前过滤），并发加载后按 `rank+id` 确定性装配 statuses/diagnostics/observations（并发完成顺序不影响输出），再逐 capability 调 `buildSnapshot`；provider 抛异常/身份不匹配/`unavailable`/`aborted` 分别 failed/unavailable/aborted 状态并局部化，其他 provider 继续；`signal` 在 dispatch 前 gate（aborted → 不调用 load），provider 经 `DiscoveryContext.signal` 自行响应中断；
- `src/extensions/skills/registry.ts` —— `SkillDiscoveryObservation`（providerId/source/level/canonicalRoot/scanKind/pluginId/inheritedTrustBinding/sourceRegistry）、`SkillProviderStatus`（ProviderStatus + candidate/active/failed counts）、`SkillRegistrySnapshot`（generation/digest/providers/all/active/modelDiscoverable/userInvocable/diagnostics）；P2 在此文件扩展 `SkillRegistry` 实现。

新增测试（全部 GREEN）：

- `tests/extensions/capabilities/registry.test.ts`（11）：构造合同（duplicate/unknown/frozen/顺序/隔离）+ load 编排（disabled 零 I/O、异常局部化、unavailable、身份不匹配、预 abort 零 dispatch、signal-aware abort、validation diagnostics 按 provider rank 排序、per-capability snapshot）；
- `tests/extensions/capabilities/boundaries.test.ts`（5）：`findProviderExecutionPortViolations` 纯函数单测（trust/state-store、mcp/gateway/session-runtime/child_process 禁止；skill schema/diagnostics/类型允许；非 provider 文件不检查）+ 仓库现无 provider-execution-port 违反；
- `tests/extensions/skills/registry-types.test.ts`（4）：schema 可构造、`Object.freeze` 可用、四视图 descriptor 类型兼容。

边界规则：`scripts/check-execution-boundaries.ts` 增 `provider-execution-port` kind，扫描 `src/extensions/**/providers/`，禁止 import trust-store/state-store/connection-manager/attempt-gateway/session-runtime/tool-registry/agent-loop/mcp/child_process；`npm run check`（含该规则 + `tsc --noEmit`）EXIT=0。

P1 停止规则复核：registry 不需要 import execution/Gateway/process 即可工作 ✓；严格 TS、erasable syntax、无 `any`、无动态 import（全部 `unknown` + 顶层 import）✓；完整 `npm test` 见 §15.3 追加记录。
### 15.3 P2 完成证据（2026-08-13）

cutover 完成，Skill discovery 不再由 PluginManager 私有拥有；Plugin 与 standalone 共用 SkillRegistry。

新增/重构 production 文件：

- `src/extensions/skills/scanner.ts` —— 从 discovery.ts 拆出的统一 bounded scanner：`scanSkill`（原 discoverOne，新增 `providerId` 归属）、`listSkillEntries`（immediate-child 排序/bounded/containment）、`scanSkillsDirectory`（并发上限扫描）；`discovery.ts` 收窄为迁移期 facade（P8 删除）。
- `src/extensions/skills/registry.ts` —— `SkillRegistry`：构造时装配 providers 并 freeze 内部 CapabilityRegistry；`load()` 产出不可变 `SkillRegistrySnapshot`（generation/digest/providers/all/active/modelDiscoverable/userInvocable/diagnostics）；同一 identity 同 content 合并 providerIds，同 identity 异 content → `skill.identity_conflict` fail closed；`trust/untrust` 走 exact resource receipt。
- `src/extensions/skills/providers/{runledger.ts,plugin-contributions.ts,index.ts}` —— `runledger-{builtin,user,workspace,repo,session}`（repo/session 默认 off；缺目录 unavailable；零 I/O 由 registry dispatch 保证）与 `runledger-plugin`（contributions → observations 纯变换；scanKind=skills-directory 与原 `discoverSkills({skillsPath})` 等价）。
- `src/extensions/plugins/manager.ts` —— 删除内部 SkillCatalog ownership：`PluginDiscoveryResult.skills` → `skillContributions: PluginSkillContribution[]`（pluginId/source/sourceKey/priority/skillRoot/inheritedTrustBinding）；删除 `skills()` 与 `SkillDescriptor` 再导出；trusted+enabled 才携带 parent binding，untrusted/disabled 只留 component descriptor。
- `src/extensions/manager.ts` —— 持有 PluginManager + SkillRegistry；`currentSkills()` 返回 registry `active` 视图（resolver/catalog 与 contextSources 消费）；`#buildAndSwap` 合并 plugin + skill descriptors 进同一 snapshot generation（identity 去重）；新增 `trustSkill/untrustSkill`。
- `src/runtime/session-runtime/extension-composition.ts` —— production factory 经 `createSkillRegistry` 装配 `userSkillRoot`/`workspaceSkillRoot` + plugin contributions；OPERATION_MANIFEST 增 `skill.trust`/`skill.untrust`（session.skills mutate）；`SessionExtensionManagerPort` 增两方法。
- `src/cli/runtime-host.ts` —— resident Host 复用同一 `createSkillRegistry` factory（不复制 provider 列表），user/workspace roots + plugin contributions。

新增/更新测试（全部 GREEN）：

- `tests/extensions/skills/registry.test.ts`（7）：canonical user inspect→trust→catalog→loader→untrust；disabled provider 零 I/O（TracingStorage 断言不触碰 user root）；缺目录 unavailable；workspace project-scoped identity；同 realpath 三 provider 合并 providerIds；同 identity 异 content conflict；digest 确定性 + generation 递增 + frozen。
- `tests/runtime/session-runtime/extensions-domain.test.ts` —— gap 测试改写为 acceptance：「canonical user standalone Skill 经 exact trust 进入标准 production Session」：plugin 正控 + standalone blocked 候选 inspect 可见 → 不进 catalog（contextSources 无、loader not_found）→ `skill.trust` mutation → ready、进入 catalog、Skill tool 读正文 → `skill.untrust` → 撤出（not_found）。
- `tests/extensions/plugins.test.ts` / `skills-characterization.test.ts` / `host-manager.test.ts` —— 机制随 cutover 更新（经 `createSkillRegistry` 读取 Skill），行为断言（identity/receipt/catalog/stale/turn/root-digest）不变。

发现并记录（P3 设计输入）：

1. 插件 manifest 声明的 skill 路径是 **skills root**（含 skill 子目录），不是单个 skill 目录；contribution scanKind 必须为 `skills-directory`（初版误用 single-skill-directory 导致 plugin Skill 不出现，已由 acceptance 测试捕获并修复）。
2. workspace Skill 的 identity source 映射为 `project`（ResourceSource 无 workspace），workspace 区分由 canonicalRoot digest + provider level "workspace" 表达；P3 若需独立 workspace scope 再评估。
3. `currentSkills()` 返回 registry `active`（provider on + enabled + trust valid + digest current）；untrusted 候选只经 snapshot descriptors（inspect）可见，loader 返回 not_found 而非 blocked（原 PluginManager-only 路径无 standalone 候选，行为等价）。

门禁：`npm run check` EXIT=0（含 execution boundary 新规则）；`npm run build` EXIT=0；完整 `npm test` 318 files / 1852 passed / 3 skipped EXIT=0（1845 → +7 registry 测试；plugins/characterization/domain 改写保持计数）；Bun OpenTUI 66 pass。
### 15.4 P3 完成证据（2026-08-13）

新增 production 文件/字段：

- `src/storage/settings-manager.ts` —— `ProjectSettings.skills?: SkillsSettings`（versioned policy：`enabled` 总闸 + `providers` exact-ID→boolean，≤32 项、key 模式校验；非法结构整体丢弃不拒绝整个 settings；workspace settings 同 schema）。
- `src/extensions/skills/policy.ts` —— `KNOWN_SKILL_PROVIDER_IDS` + `resolveSkillsPolicy(user, workspace)`：master switch、workspace 只收窄（workspace `true` 不能反转 user `false` → `skill.policy_workspace_cannot_reopen`）、未知 ID → `skill.policy_unknown_provider` diagnostic 且不运行；只输出显式覆盖（缺省 provider 用 defaultEnabled，repo/session 保持 off）。
- `src/extensions/skills/registry.ts` —— `load({ masterEnabled })`：master false → 全部 provider disabled（零 I/O）。
- `src/extensions/skills/catalog.ts` —— `resolve()` 增 user 触发路径强制：`user-invocable: false` 挡 `$`/`/`/`/skill `，模型路径继续挡 `disable-model-invocation`。
- `src/extensions/skills/renderer.ts` —— filter 改为 `enabled && disableModelInvocation !== true`（只渲染 modelDiscoverable；hidden 不进模型清单）。
- `src/extensions/snapshot.ts` / `manager.ts` / `extension-composition.ts` / `domain.ts` —— `ExtensionSnapshot.skillProviders`（中立投影：providerId/displayName/rank/effectiveEnabled/state/candidate/active/failed counts/lastError）进入 snapshot 与 digest；`ExtensionManagerOptions.skillsPolicy` 传递 policy 并把 policy diagnostics 并入 snapshot diagnostics；production composition 增 `skillsPolicy` 选项，domain.ts 从 user settings 解析（workspace settings 加载是 session-runtime 既有缺口，merge 函数已支持并单测）。

新增测试（全部 GREEN）：

- `tests/extensions/skills/policy.test.ts`（6）：默认全开、已知 ID 过滤 + 未知 diagnostic、workspace 收窄/不能 reopen、master switch、KNOWN 集合 frozen、disjoint 合并。
- `tests/storage/settings-manager.test.ts`（+4）：skills policy 持久化往返、非法结构丢弃、空节点、workspace settings 保存加载。
- `tests/extensions/skills/registry.test.ts`（+4）：四视图矩阵（model-only/user-only/hidden/plain → active/modelDiscoverable/userInvocable 投影）、catalog 按 trigger 强制（模型挡 hidden、用户挡 non-invocable、renderer 排除 hidden）、masterEnabled=false 全 disabled 零 I/O、provider counts 随 trust 更新。
- `tests/runtime/session-runtime/extensions-domain.test.ts` —— acceptance 增 `extension.inspect` 断言 `skillProviders`（runledger-user loaded/candidateCount 1 进入有界 public snapshot）。

验收对照：关闭 provider 不遮蔽其他 provider（registry/policy 独立测试）✓；`disable-model-invocation` 不进模型清单但 user 路径可调用（trigger 矩阵）✓；untrusted 候选只在 inspect 可见（P2 acceptance 已覆盖）✓；`observedBy` 由 `SkillDescriptor.providerIds` 承载（同 realpath 合并，见 P2 §15.3）。

门禁：`npm run check` EXIT=0；`npm run build` EXIT=0；完整 `npm test` 319 files / 1866 passed / 3 skipped EXIT=0（1852 → +14：policy 6 + settings 4 + visibility 4）；Bun OpenTUI 66 pass。
### 15.5 P4 完成证据（2026-08-13）

新增 production 文件：

- `src/extensions/skills/providers/shared.ts` —— `createFixedRootsProvider`：多固定 root 各一 observation，全缺失 → unavailable；root 由 composition root 注入。
- `src/extensions/skills/providers/codex.ts` —— `createCodexUserProvider(osUserHome)`（`~/.codex/skills`，rank 2000）与 `createCodexProjectProvider(repoBoundary)`（boundary 内 `.codex/skills`，rank 2100），均默认 off。
- `src/extensions/skills/providers/agents.ts` —— `createAgentsUserProvider(osUserHome)`（`.agents/skills` + `.agent/skills` 各一 observation，rank 2200）与 `createAgentsProjectProvider(repoBoundary)`（rank 2300），均默认 off。
- `src/extensions/skills/providers/runledger.ts` —— `createRunledgerRootProvider` 重构为共享 helper 的薄封装（消除重复 load 逻辑）。
- `src/extensions/skills/registry.ts` —— `SkillRegistryOptions` 增 `codexUserHome/codexProjectBoundary/agentsUserHome/agentsProjectBoundary`；提供 locator 时才注册对应 provider（默认 off → 零 I/O）。
- `src/extensions/skills/policy.ts` —— `KNOWN_SKILL_PROVIDER_IDS` 增 `codex-user/codex-project/agents-user/agents-project`（仍全默认 off，enable 走 policy）。
- `scripts/check-execution-boundaries.ts` —— provider 文件增 `os.homedir()`/`process.cwd()`/`process.env`/`Bun.Glob` 禁止规则（D6：路径与设置由 composition root 解析一次注入）。

新增测试（全部 GREEN）：

- `tests/extensions/skills/providers-external.test.ts`（8）：默认 off 零 I/O（TracingStorage 断言不触碰 `.codex`/`.agents`/`.agent`）；codex-user 显式 enable → blocked 候选 → exact trust → active → loader 正文；同 `shared` 名跨 Codex/Agents → 2 个独立 identity、catalog ambiguous（2 candidates）、无 first-wins、无 identity_conflict；`.agents`+`.agent` 双目录 → 2 observations 不按 name 覆盖；缺目录 unavailable；codex-project boundary 根扫描；case collision（混合大小写目录被 frontmatter 小写 schema 拒绝，独立条目不合并）；真实 provider 文件源码不含 homedir/cwd/env/Bun.Glob。
- `tests/extensions/skills/policy.test.ts` —— unknown-ID 用例改用 `claude-user`（codex/agents 已入 KNOWN 集）。

验收对照：fake home/repo 重现「同 Skill 在 Codex 与 Agents 有副本」→ ambiguous 不 first-wins ✓；same realpath 合并（P2 merge 测试，providerIds 三路合并）✓；enable 后仍 untrusted、trust exact 后 active ✓；未读取真实用户目录（全部隔离 tmp fixture）✓。外部 provider 未接 production composition（P6 enable 命令带来 wiring；停用规则：无 exact trust mutation + provider-facing prompt 证据前保持默认 off）。

门禁：`npm run check` EXIT=0（含新 boundary 规则）；`npm run build` EXIT=0；完整 `npm test` 320 files / 1874 passed / 3 skipped EXIT=0（1866 → +8）；Bun OpenTUI 66 pass。
### 15.6 P6/P7/P8 完成证据（2026-08-13）

**P6 — 管理面与审计闭环**：

- Session domain（extension-composition.ts）：OPERATION_MANIFEST 增 `skill.provider.list`（read）/`skill.provider.enable|disable`（mutate）；`queryResources` 返回 `skillProviders` 投影；`mutateResources` 走 attempt barrier + `setSkillProviderEnabled`。`SessionExtensionManagerPort` 增三方法。
- ExtensionManager：`skillsPolicyLoader`（异步重读 settings→policy）+ `updateSkillsProviderPolicy`（写 canonical user settings→reload）；`setSkillProviderEnabled(providerId, enabled, scope)`（scope=workspace 未接线 → 显式 failed）。
- 生产 composition 与 resident Host（runtime-host.ts）均注入 settings-backed loader/writer（复用同一实现）。
- Host domain（runtime-host-domains.ts）：`EXTENSION_QUERY_OPERATIONS`/`EXTENSION_MUTATION_OPERATIONS` 增 skill.provider.list / skill.trust / skill.untrust / skill.provider.enable|disable；handler 分支 + `ExtensionManagerDomainPort` 扩展。
- CLI（control-commands.ts）：`skill provider list|enable|disable <id> [--scope user|workspace]` 与 `skill trust|untrust <id>` 解析/请求映射/帮助；mutation 标志按子命令；revision query 走 skill.list。
- TUI：新增 `/skillsproviders` 命令（registry.ts）+ `openSkillProvidersModal`（interactive-mode.ts）——只读 provider status 列表（providerId/state/candidates/active/failed），mutation 仍走 authenticated Session command。
- 测试：`tests/cli/control-commands.test.ts` +2（skill 命令解析/请求映射）；extensions-domain acceptance 增 provider disable→persist settings→re-enable 全流程（关闭不遮蔽 plugin Skill）；slash-command-popup.test 更新（新命令进 /s 过滤）；`extension.inspect`/`skill.provider.list` 断言 snapshot 投影。
- 审计：provider mutation 走 attempt barrier（beginAttempt/settleAttempt + receipt），审计事件复用 `extension.snapshot.idle_reloaded`/`extension.snapshot.loaded`（只含 snapshotId/generation/status，不含外部路径与正文）。

**P7 — 上下文与调用路径联合验收**：

- system prompt 只含 `modelDiscoverable`（P3 renderer + production ready-filter；adapter 测试断言 hidden 不进 fragment）。
- 统一 catalog：`SkillCatalog.resolve` 按 trigger 强制（model-tool 挡 disable-model-invocation、用户触发挡 user-invocable:false）；P7 新增 resolver 级测试（同一 active catalog，`load("name")` blocked / `load("$name")` 读正文）。
- Trace `context.assembled`：`tests/runtime/context/model-request-adapter.test.ts` 新增 —— skill catalog fragment 进入 `assembled.receipt.fragmentIds` + systemPrompt（name/qualifiedId 元数据、无正文、无 hidden）；确定性 digest 既有测试覆盖。
- `skill://` 未增加（deferred）；子代理 autoload deferred（无 agent manifest contract）；slash 命令在 resolver 层统一（无独立全局 active table）。

**P8 — 真实 smoke、清理与发布门禁**：

- 清理：`src/extensions/skills/discovery.ts` facade 已删除（P2 迁移期兼容路径）；3 个测试文件（skills/host-skill-loader/characterization）迁移到 `scanner.ts` 统一扫描 API；无 silent fallback。PluginManager 不再拥有 SkillCatalog（P2 已删）。
- 门禁：`npm run check` EXIT=0；完整 `npm test` **321 files / 1887 passed / 3 skipped** EXIT=0；`npm run build` EXIT=0；`git diff --check` 干净；Bun OpenTUI 66 pass。
- dist 重建完成；worktree 内 `bun dist/cli/cli.js --version/--help` 验证 CLI 参数面正常。
- provider 默认值审阅：`runledger-{builtin,user,workspace,plugin}` on；`runledger-{repo,session}` 与 `codex-*`/`agents-*`/`claude-*`/`claude-plugins` 全部默认 off（KNOWN 集 + defaultEnabled 双保险）。
- **blocked 记录（环境）**：真实 TTY/tmux 全会话 smoke 与真实模型 E2E 未执行 —— (1) `asset/api-key.json` 未随 worktree 携带（gitignored），真实模型不可用；(2) bin shim 用 `bun dist/cli/cli.js` 启动，`process.execPath`=bun 二进制，session toolchain gate（`src/security/toolchain.ts` 用 execPath 当 node 版本）误判 `toolchain_version_unsupported`，且 OpenTUI FFI 在 node 运行时不可用——两者均为本次专项之外的既有环境/启动门禁，未在 worktree 内修复；`--version/--help` 参数面已验证。01 的 2026-08-11 live E2E（真实 deepseek + Trace context.assembled）仍为该语义的既有证据。

### 15.7 Review 修复与 fresh 验证（2026-08-13）

本轮以 RED→GREEN 修复实现审阅发现的六类缺口：

- parent Extension snapshot 与 child Plugin/Hook/Skill candidate 改为 build + parent swap 成功后共同发布；turn admission 抢在 reload 完成前时，各视图都保留 last-known-good，idle boundary 才发布下一代；
- `extensions-state.json` 的 JSON/schema/I/O authority failure 会终止 Skill snapshot build，不再把空 state 当成 enabled 默认值；
- workspace `skills.enabled` 与 provider policy 只能收窄 user/default authority；default-off compatibility provider 不能由 workspace 单独 reopen；
- standard Session Owner 与 resident Host 都显式注入 OS user home/project boundary，注册 Codex/Agents/Claude/Claude Plugins compatibility providers；未注册 provider mutation 在写 settings 前失败；
- Claude plugin registry parser 对齐真实 `{version, plugins: {id: entry[]}}`，覆盖多 scope entry、`local.projectPath` 匹配、containment、disabled 和 trust 独立语义；
- fixed-root 与 Claude registry unavailable status 改为有界消息，public `skillProviders.lastError`/JSON 不再泄漏完整 external home path。

fresh 自动证据：review focused 8 files / 77 tests 全绿；mutation/atomicity focused 4 files / 38 tests 全绿；`npm run check` EXIT=0；完整 `npm test` 为 Vitest 322 files（321 passed / 1 skipped）、1894 passed / 3 skipped，Bun OpenTUI 66 passed；`npm run build` EXIT=0；隔离临时 `RUNLEDGER_DIR` 下编译后的 `node dist/cli/cli.js --version/--help` 通过。全局 `which runledger` 当前链接到 sibling `RunLedger-codex-syntax-highlighting`，不是本 worktree，因此未替换用户全局链接，也未把它计为本分支 PATH smoke；`git diff --check` 在最终审阅完成。真实 TTY/tmux 与真实模型仍保持 §15.6 的 pending/blocked 状态，P8 不提升为全部完成。
