# Plan 21：oh-my-pi computer use 能力复刻

## 0. 目标、范围与阶段顺序

目标：在 RunLedger 内复刻 oh-my-pi 的 host desktop 控制能力 —— 显示器/窗口发现、截图、native 指针与键盘输入、OS 无障碍（AX）树读写、剪贴板 —— 并把它接成**受治理的一等工具**，而不是上游的 eval prelude。

上游把 `computer` 实现为「`eval` 工具里的一个 prelude 全局对象」：模型写 JavaScript/Python 片段，片段在持久 kernel 里调用 `computer.window(...)`、`win.ax()` 等 facade，每次 helper 调用回落到 host 做一次审批。RunLedger 没有 `eval` / `run-code` 内核，Plan 19 与 Plan 20 §1 都明确把 `eval` 排除在范围外，因此本计划**不复刻 prelude 形态**，改为把同一组 helper 表与同一套审批分级搬到一个 registry 工具里。

阶段顺序（每阶段先完成文件、定向测试与 production composition，才进入下一阶段；不以 schema 或 unit fixture 代替真实 owner 接线）：

| 阶段 | 内容 | 是否可独立验收 |
|---|---|---|
| A | 能力合同与受治理端口：capability claim、`AccessRequest` 新 kind、`DesktopPort`、settings 组、standard 装配 | 是。无 native，fake port 即可跑通授权、审批分级与生命周期 |
| B | Windows native 后端：Rust addon + 预编译包 + loader | 是。`check:desktop` + 真实 Windows 捕获/输入/AX 冒烟 |
| C | `computer` 工具面：schema、方法表、审批分级、结果投影、screenshot → `ImageContent`/artifact | 是。fake port 覆盖 schema、审批与投影 |
| D | settings / CLI / TUI 开关 | 是。built CLI `/computer status` |
| E | 提示词与安全策略（屏幕内容不可授权） | 是。prompt 快照 + 人工评审 |
| F | 非 Windows 后端：macOS → Linux X11 → Wayland（可选） | 分平台单列 |

A 与 C 先把 RunLedger 的 authority 面（claim、`AccessRequest`、审批分级、结果投影、artifact）钉死，B 只负责把 native 能力做成一个可注入 port 的实现。这样 native 缺失、平台不支持或权限未授予时，工具是 typed unavailable，而不是半成品。

## 1. 上游参照与裁定

| RunLedger 交付物 | oh-my-pi 参照 | 本计划裁定 |
|---|---|---|
| 方法表与审批分级 | `packages/coding-agent/src/tools/computer/call.ts`（`DESKTOP_METHODS` / `WINDOW_METHODS` / `ELEMENT_METHODS`、`isReadOnlyComputerCall`） | **原样移植**。这是 read/exec 分级的唯一 authority，RunLedger 侧改为按 `AccessRequest.operation` 表达 |
| 工具入口与参数 schema | `tools/computer.ts`（`action: run\|call\|capabilities\|close`、`computerApproval`、`buildComputerSnapshot`） | 保留四个 action 的语义；`call` 由「helper 链」改为显式 `target` + `method`；`run` 由 JS 代码串改为**有界步骤序列** |
| 会话级 worker 生命周期 | `tools/computer/supervisor.ts`（lazy 启动、单飞、超时后重建并重置 capture/ref、owner 释放） | 保留生命周期语义（lazy、single-flight、崩溃后重建、`releaseXxxForOwner`），**不引入 Bun Worker**，改为 in-process session port |
| JS/Python 内核 facade | `tools/computer/worker.ts`、`prelude.js`、`prelude.py`、`declarations.d.ts`、`src/eval/**`（12,234 行 TS + Python kernel） | **不移植**。本计划不新增任何模型侧代码执行内核 |
| native 共享层 | `crates/pi-natives/src/desktop/{backend,types,frame,keys,ax,error}.rs` | 移植。`frame.rs` / `keys.rs` / `error.rs` 平台无关；`ax.rs` 的 ref 注册与代际失效逻辑共享，句柄枚举按 `cfg` 分支 |
| Windows 后端 | `desktop/win32/{capture,input,delivery,ax,mod}.rs` | 阶段 B 移植，是**第一个平台** |
| macOS / Linux 后端 | `desktop/macos/**`、`desktop/linux/{x11,wayland}/**` | 阶段 F。Wayland 的 pipewire screencast 特性上游默认关闭，本计划同样不作为必需项 |
| 工具文档 | `prompts/tools/computer.md` | 改写为 RunLedger 工具 `description`（去掉 JS/Python 与 `computer.run(code)` 段） |
| 安全策略 | `prompts/system/computer-safety.md` | 改写进 standard prompt 的安全段，见 §7 |
| 设置项 | `config/settings-schema.ts` 的 `computer.enabled/display/maxWidth/maxHeight` | 映射为 `ProjectSettings.computer`，见 §6 |
| 斜杠命令 | `slash-commands/builtin-modes.ts` 的 `/computer [on\|off\|status]` | 映射为 TUI command `computer`，见 §6 |
| 模型能力探测 | `packages/catalog` 的 `supportsComputerUse`、`packages/ai/src/providers/openai-responses-wire.ts` 的 `ComputerTool` / `ComputerUsePreviewTool` | **不移植**。RunLedger 不代理 provider 原生 computer tool；只保留坐标安全降级这一等价判定，见 §3.5 |
| Provider 安全确认 | `pendingSafetyChecks` → 强制交互式审批 | **不移植**。RunLedger 没有 provider 发起的 computer tool，等价物是 §7 的「屏幕内容不可授权」与既有审批引擎 |
| 截图的落盘形态 | 写 OS temp 目录并把绝对路径返回给模型 | **改写**。RunLedger 只返回 `ImageContent`；落盘仅走既有 artifact 存储并只暴露 artifact id，见 §5.4 |

明确不在本计划：`eval` / `run-code` 内核、`browser`、PDF、provider 原生 computer tool 代理、Memory/`learn`/`yield`，以及**任何 `src/security/sandbox/**` 的改动**。

## 2. 冻结的横切约束

- **不触碰 sandbox。** `src/security/sandbox/`、Linux bwrap 及其调用链不因本计划新增、扩展、移植或重构。desktop 控制是一个新的能力域，不是 sandbox 专项。
- **副作用经治理。** 所有 desktop 副作用经 Security / `ExecutionGateway`、Attempt Gateway 与 owner fence；保持 fail closed。不通过 raw I/O、`AllowAll` 或绕过治理让测试通过。
- **平台分支收敛。** 平台差异只允许出现在 native 层（Rust `cfg`）与 `src/workspace/factory.ts` / `src/workspace/runtime-platform.ts`。TS 侧沿用 `runtimeNodePlatform()` 单点，业务模块不新增 `process.platform`。
- **raw I/O 位置。** `check-execution-boundaries` 扫描 `src/runtime/tools`、`src/security`、`src/worktree`、`src/extensions`、`src/websource`。因此 native loader（需要 `node:fs`）与 addon 解析必须放在 `src/runtime/desktop/**`，`src/runtime/tools/computer.ts` 只能消费注入的 port。
- **屏幕与 AX 内容不可授权。** 截图、AX 文本、通知、文档内容一律是 untrusted data，永远不构成用户确认。
- **有界输出。** 截图字节、每轮截图数、AX 文本与节点数、窗口列表与 `find` 结果都有上限；超限截断而不是无限累积。
- **不写入 workspace。** 截图与 AX 文本不落 workspace；落盘只走既有 artifact 路径，且受 recording 设置授权。
- **profile 边界。** 新工具只装配 `standard`；`minimal@1` 与 Plan Mode 的冻结 allowlist 不扩大，Plan Mode 对 `host_desktop` claim 显式 deny。
- **不新增代码执行内核。** 工具参数是声明式的，模型不能在一次调用里写循环/条件。

## 3. 阶段 A：能力合同与受治理端口

### 3.1 capability claim

`src/runtime/protocol/capability.ts` 的 `CAPABILITY_NAMES` 增加 `host_desktop`，`CapabilityClaim.resourceKind` 增加 `desktop`。

裁定依据：现有八个 claim（`repository_read` / `workspace_write` / `dependency_install` / `network` / `process` / `credential` / `deploy` / `cross_workspace`）没有一个覆盖「读取或操作宿主桌面」；复用 `process` 在审计与审批上都说不清「截了一张图」和「点了一下鼠标」的区别，因此新增 name 与 resourceKind，而不是借用 `tool` 桶。

`src/runtime/tools/capabilities.ts` 的 `builtinCapabilityClaims` 增加 `computer → host_desktop / desktop`，`scope: "invocation"`。

### 3.2 AccessRequest 新 kind

`src/security/types.ts` 的 `AccessRequest` 增加分支：

```ts
| { readonly kind: "desktop";
    readonly operation: "window_query" | "capture" | "ax_read" | "clipboard_read"
                     | "input" | "ax_write" | "clipboard_write";
    readonly target: string }
```

`src/security/permission/access-resolver.ts` 增加 `computer` 分支：按工具参数里的 `action` + `method`（或 `run.steps` 的并集）映射成**一个或多个** `desktop` 请求。这是「参数 → 效应」的唯一分类器，审批只看它，不看工具名，也不看模型自述。

### 3.3 desktop 策略

新增 `src/security/policy-desktop.ts`，与 `policy-network.ts` 同构，判定顺序：

1. `computer.enabled !== true` → deny（`computer_disabled`）。
2. `target` 不属于本次 session 已解析的 desktop / 窗口集合 → deny（`invalid_target`）。
3. `operation` 属于 inspection 集（`window_query` / `capture` / `ax_read` / `clipboard_read`）→ read tier；属于 mutation 集（`input` / `ax_write` / `clipboard_write`）→ exec tier。
4. 其余按 `src/security/permission/engine.ts` 既有 `approvalPolicy`（`on-request` / `never` / `untrusted` / `granular`）走审批。

`src/security/config/schema.ts` 的 `rules[].kind` union 增加 `desktop`，使规则可以按 `desktop` + pattern 表达 allow/ask/deny；managed 层仍只允许收紧。

`src/runtime/modes/plan/policy.ts` 的 `PlanModeDenyReason` 增加 `plan_mode_desktop_denied`，并在 `denyReason` 的 switch 里显式列出 `host_desktop`。注意：即使不加这一条，`default` 分支也会把它当 unknown effect 拒绝；显式列出是为了让拒绝原因可读、可测试。

### 3.4 DesktopPort

新增 `src/runtime/desktop/`：

| 文件 | 变更 |
|---|---|
| `src/runtime/desktop/types.ts` | 纯类型：`DesktopDisplay`、`DesktopWindow`、`DesktopCapabilities`、`DesktopCapture`、`AxNode`、`AxSnapshot`、`PointerOptions`、`DeliveryMode`。与 §4 的 napi 对象一一对应 |
| `src/runtime/desktop/port.ts` | `DesktopPort` 接口：`capabilities()`、`displays()`、`windows()`、`capture()`、`pointer()`、`typeText()`、`keyChord()`、`raiseWindow()`、`axSnapshot()`、`axQuery()`、`axNode()`、`axAttributes()`、`axChildren()`、`axParent()`、`axPerform()`、`axSetValue()`、`axFocus()`、`clipboardRead()`、`clipboardWrite()`、`close()` |
| `src/runtime/desktop/session.ts` | 会话级实现：lazy 建会话、single-flight、每轮 read_only 快照、超时后重建并作废 capture/ref、`close()` 幂等；沿用 supervisor 的生命周期语义 |
| `src/runtime/desktop/native-package.ts` | 纯模块：`{platform, arch, libc}` → `@runledger/desktop-<platform>-<arch>[-<libc>]`，无 I/O、无平台探测（对照 `src/tui/highlight/native-package.ts`） |
| `src/runtime/desktop/native-loader.ts` | `createRequire` 加载预编译包，回落 `dist/native/runledger-desktop.node`，做完整性校验；能力缺失时返回 typed `native_unavailable`（对照 `src/tui/highlight/native-loader.ts`） |
| `src/runtime/desktop/fake.ts` | 测试用确定性 port（供 A/C 阶段与低层组合使用） |

`src/runtime/desktop/` 不在 `CONTRACT_DIRECTORY_ALLOWLIST`，也不在 `check-execution-boundaries` 的扫描根内，因此 loader 持有 `node:fs` 是合法的、且是唯一的落点。

### 3.5 坐标安全

上游对「transport 无法保留 native 截图细节」的模型收窄到 1280×896（`COORDINATE_SAFE_MAX_CAPTURE_WIDTH/HEIGHT`），因为指针坐标必须与模型看到的像素一致。

RunLedger 的事实：`src/api/openai-responses-shared.ts` 固定发 `detail: "auto"`，Anthropic 路径会在长边 ≤1568px 上重采样。因此**只要 provider 可能改写图像，就必须在捕获侧先收窄**，否则模型按看到的坐标点击会偏。

阶段 A 的判定规则：active model 的 API 属于 anthropic 系列，或 responses 路径仍固定 `detail: "auto"` 时，`captureMaxWidth/Height` 取 `min(configured, 1280×896)`；其余取 configured。后续再评估是否给模型 catalog 增加显式 compat 字段（例如 `supportsImageDetailOriginal`）并允许 responses 路径发 `detail: "original"`；该字段不在本阶段范围。

### 3.6 装配

- `src/runtime/session-runtime/domain.ts`：仅当 `harnessProfile.descriptor.tools.mode === "standard"` **且** `settings.computer.enabled === true` **且** native 后端可用时构造 port，并作为新的 `computerDesktop` 选项传入 `productionSessionTools`（对照 `imageGeneration` 的写法）。
- `src/runtime/tools/index.ts`：`StdlibToolsOptions` 增加 `computerDesktop?: DesktopPort`；port 存在时才 `register(createComputerTool(port))`。
- 未注入时工具不存在，因此未接线的组合不会暴露一个必然失败的工具。
- 标准 profile 是直通投影、不做 manifest pin（见 `frozen-manifests.ts`），所以新增工具不需要新 profile version；`standard-plan-tool-guard` 测试需要同步确认。

### 3.7 验收

新增 `tests/runtime/desktop/session.test.ts`（lazy 建会话、single-flight、并发 capabilities 不重复建会话、超时重建作废 ref、close 幂等）、`tests/security/policy-desktop.test.ts`（disabled deny、inspection → read tier、mutation → exec tier、managed 层只能收紧）、`tests/runtime/modes/plan/policy.test.ts` 增补 `host_desktop` deny 用例、`tests/runtime/tools/capabilities.test.ts` 增补 claim 断言。运行 `npm run check:execution-boundaries`、`npm run check:platform-boundaries`。

## 4. 阶段 B：Windows native 后端

新增独立 addon `native/desktop/`，对照 `native/syntax-highlighter/` 的既有工程形态（`Cargo.toml` + `build.rs` + `cdylib` + napi）。

| 文件 | 来源 | 说明 |
|---|---|---|
| `native/desktop/Cargo.toml`、`build.rs` | 新建 | `crate-type = ["cdylib"]`，`napi-build` |
| `src/lib.rs` | 由上游 `desktop/mod.rs` 裁剪 | napi 入口：`DesktopSession` 类 + 方法，内部请求走专用 OS 线程 |
| `src/thread.rs` | 由上游 `mod.rs` 的 dispatcher 拆出 | 单线程持有 backend，`flume` 请求/回复通道，`OPERATION_TIMEOUT` / `CLOSE_TIMEOUT` |
| `src/types.rs` | 上游 `desktop/types.rs` | napi object：`DesktopDisplay` / `DesktopWindow` / `DesktopCapture` / `DesktopCapabilities` / `AxNode` / `AxSnapshot` / `PointerOptions` / `CaptureCaps` |
| `src/backend.rs` | 上游 `desktop/backend.rs` | `Backend` / `AxBackend` trait、`DeliveryMode`、`MouseButton`、`Modifiers`、`PointerEvent` |
| `src/error.rs` | 上游 `desktop/error.rs` | `ErrorCode`（含 `PermissionDenied` / `BackgroundUnavailable` / `StaleRef` / `InvalidCoordinateFrame`） |
| `src/frame.rs` | 上游 `desktop/frame.rs` | 捕获上限、合成、缩放与 PNG 编码 |
| `src/keys.rs` | 上游 `desktop/keys.rs` | chord 字符串 → `KeyName[]` |
| `src/ax.rs` | 上游 `desktop/ax.rs` | ref 注册表与代际失效；句柄枚举按 `cfg` 分支 |
| `src/win32/{mod,capture,input,delivery,ax}.rs` | 上游 `desktop/win32/*` | 显示器/窗口捕获、Win32 输入、background/foreground delivery、UI Automation |

依赖（与上游 Windows 目标一致）：`napi` / `napi-derive` / `image` / `png` / `parking_lot` / `flume`；Windows 目标加 `xcap`（捕获）、`enigo`（输入）、`uiautomation`（AX）、`windows-sys`（Win32 消息与光标）、`clipboard-win`（剪贴板）。全部来自 crates.io，不依赖 MSYS 或系统 pkg-config。

工程接线：

- `scripts/build-desktop.ts` 与 `scripts/package-desktop-prebuild.ts`：对照 `build-syntax-highlighter.ts` / `package-syntax-highlighter-prebuild.ts`。
- `package.json`：新增 `build:desktop`、`check:desktop`（`cargo test --locked --manifest-path native/desktop/Cargo.toml`）、`benchmark:desktop`；把 `build:desktop` 接进 `build:native`；新增 `npm/desktop-win32-x64-msvc` 等预编译包到 `optionalDependencies` 与 `files` 白名单；`check` 链加入 `check:desktop`。
- 平台/架构选择沿用 `resolveNativeSyntaxPackage` 的纯模块模式，不新增 `process.platform` 分支。

验收：`npm run check:desktop`（Rust 单测：`DeliveryMode::parse`、chord 解析、capture 上限、ref 代际）；在一台真实 Windows 桌面（**不**在无头 CI）上跑通 `capabilities → displays → windows → capture → ax snapshot → click/type → clipboard` 冒烟；记录 backend、`capturePermission` / `inputPermission` / `axPermission` 的实际取值。无头或权限未授予时 `capabilities()` 必须如实报告 `capture: false` 等，而不是抛错。

## 5. 阶段 C：`computer` 工具面

### 5.1 schema

`src/runtime/tools/computer.ts`，TypeBox 判别联合，四个 action：

| action | 参数 | 审批 |
|---|---|---|
| `capabilities` | 无 | read |
| `call` | `target`（`"desktop"` 或 `{ window: string }`）、`method`、`args?`、`timeout?` | 按 §5.2 方法表 |
| `run` | `steps`（1–32 步，每步同 `call`）、`read_only?`、`timeout?` | 任一步是 exec → exec；全为 read → read |
| `close` | 无 | read |

`run` 与上游 `computer.run(fnOrCode)` 的差异必须写进工具描述：上游接受 JS 代码串或函数并在持久 kernel 里执行，RunLedger 接受**声明式步骤序列**，由运行时逐步执行并逐步应用 §3.2 的分类。代价是没有循环与条件分支，模型需要多轮工具调用；这是不引入代码执行内核的必然结果。

### 5.2 方法表

`src/runtime/tools/computer-methods.ts`：从 `call.ts` 移植三张表，作为**唯一** authority，工具、分类器与文档都从它读。

- desktop：`displays`/`windows`/`window`/`focusedWindow`/`screenshot`/`elementAt`/`focusedElement`/`ref`/`clipboard.read` → read；`click`/`doubleClick`/`move`/`drag`/`scroll`/`type`/`press`/`clipboard.write` → exec。
- window：`screenshot`/`ax`/`find`/`ref` → read；`click`/`doubleClick`/`move`/`drag`/`scroll`/`type`/`press`/`raise` → exec。
- element：`value`/`bounds`/`attributes`/`actions`/`parent`/`children` → read；`setValue`/`perform`/`press`/`click`/`focus` → exec。

未知 method、未知 target、超过 32 步、或 `run` 里出现 `read_only: true` 却带 mutation 步骤 → 立即 typed error，不执行任何一步（fail closed，不做部分执行）。

### 5.3 结果投影

- `call` / `run` 的返回值投影为受限 JSON（`stringifyReturnValue` 等价物）：对象深度、数组长度、字符串长度都有上限。
- `ax` 返回**单个文本树**（每行一个节点带 `[ref=eN]`），受字符数与节点数上限；描述里明确「不要遍历或 map 它」。
- `screenshot` 追加 `ImageContent`（`image/png`），并给出「目标、尺寸、是否缩放」的一行文本。
- `capabilities` 返回 backend 与三个 permission 状态，使模型与用户能区分「不支持」与「未授权」。

### 5.4 artifact 与落盘

对照上游「写 OS temp 目录并返回路径」，RunLedger 改为：默认只返回 `ImageContent`，**不**返回可写路径；仅当 recording 设置授权 artifact（`events_and_artifacts`）时，把截图物化到既有 artifact 存储（`ArtifactRef.kind = "screenshot"`），并只向模型与 ledger 暴露 artifact id 与 digest。任何情况下都不写 workspace。

### 5.5 验收

新增 `tests/runtime/tools/computer.test.ts`：四个 action 的 schema 边界、未知 method/target、步数上限、`read_only` 与 mutation 冲突、`capabilities` 在 native 缺失时返回 typed unavailable、AX 文本与截图上限、截图不产生路径泄漏。新增 `tests/security/computer-approval.test.ts`：inspection 组合走 read tier、mutation 组合走 exec tier、混合组合整体升为 exec。用 fake port 断言**没有**任何 native 调用发生。

## 6. 阶段 D：settings / CLI / TUI

### 6.1 settings

`src/storage/settings-manager.ts` 的 `ProjectSettings` 增加：

```ts
computer?: {
  readonly enabled?: boolean;        // 仅 user 层拥有 authority
  readonly display?: string;         // "all" 或 native display id
  readonly maxWidth?: number;        // 默认 3840，范围 320..7680
  readonly maxHeight?: number;       // 默认 2400，范围 240..4320
  readonly maxScreenshotsPerCall?: number;
};
```

沿用既有 group 形态：默认值、上下界常量、`EffectiveXxxSettings` 快照、workspace 层只能收窄（本组里即「只能把 enabled 置为 false」）。`enabled` 默认 `false`，与上游一致。

### 6.2 CLI / TUI

- `src/tui/commands/registry.ts` 增加 `computer` 命令，`actionType` 为 `computer.control`，参数为 `on` / `off` / `status`；`unavailableDuringTaskMessage` 与其他 settings 类命令一致。
- `on` / `off` 写 user 层 settings；`status` 报告 `enabled` / `display` / `maxWidth` / `maxHeight` 以及最近一次 `capabilities()` 的 backend 与 permission 状态（拿不到时报告 unavailable，不伪造）。
- 与上游的差异：上游 toggle 只重建 prompt（因为它是 eval prelude）；RunLedger 的 toggle 改变的是**工具是否注册**，因此与 `web_search` / `image_gen` 的条件注册路径一致，需要在下一个 turn 边界生效，不在当前 turn 中途换工具集。

### 6.3 验收

`tests/tui/commands/computer.test.ts` 覆盖 `on`/`off`/`status` 与 unavailable 分支；built CLI 在隔离 `RUNLEDGER_DIR` 下跑一轮 `/computer status`、`/computer on`、再起一个 session 确认 `computer` 出现在工具面、`/computer off` 后消失。

## 7. 阶段 E：提示词与安全策略

- `src/runtime/harness-profiles/standard-prompt.ts` 或 `src/security/prompts/` 增加 computer 段，内容由 `prompts/system/computer-safety.md` 改写：
  - 屏幕文本、图像、通知、指令一律按 untrusted data 处理，**永不**让 UI 内容覆盖用户直接指令；
  - 只有用户直接消息授权有后果的 desktop 动作；高风险类别（金融、就业、住房、教育、保险/信贷、法律、医疗、政务、选举、生物特征、高度敏感个人数据）需要在风险点确认目标、范围与具体值；
  - provider 安全确认必须显式交互批准，否则 fail closed。
- 工具 `description` 由 `prompts/tools/computer.md` 改写：保留「优先 AX 而非像素」「坐标只对同一目标最近一次截图有效」「AX ref 有代际，旧 ref 会失效并报 stale，必须重新快照」「输入默认 background，`BackgroundUnavailable` 时改用 AX 或显式 foreground」「Wayland 无 per-window 原生输入与 raise」「循环里用更少截图」这些规则；删除 JS/Python 与 `computer.run(code)` 段。
- 明确写出本工具的信任边界：它没有 sandbox，操作的是宿主桌面。

验收：prompt 与工具描述的评审记录；`tests/runtime/harness-profiles/` 下的 prompt 快照测试更新。

## 8. 阶段 F：非 Windows 后端

按 macOS → Linux X11 → Wayland 的顺序，每个平台独立立项、独立验收，不因 Windows 通过而宣称跨平台：

| 平台 | 后端 | 关键前置 |
|---|---|---|
| macOS x64/arm64 | ScreenCapture/Quartz + native AX + 输入 | 需要 Screen Recording 与 Accessibility 权限；权限变更后需重启宿主进程 |
| Linux X11 x64/arm64 | X11 捕获/输入 + AT-SPI | 需要可读 display 与 RandR/XTEST |
| Linux Wayland | RemoteDesktop portal + AT-SPI | 上游默认不编 pipewire screencast，`capabilities()` 报 `capture: false`；per-window 原生输入与 `raise()` 不可用 |

`capabilities()` 是这条路径的诚实出口：平台支持但权限缺失时报告权限状态，平台不支持时报告 `capture/input/ax: false`，两者都不抛错、都不伪装可用。

## 9. 验收矩阵

| 变更范围 | 必需验证 |
|---|---|
| 纯文档 / 计划 | 审阅差异、检查链接与规则一致性、`git diff --check` |
| TS 合同与工具 | `npm run check`（含 `check:execution-boundaries`、`check:platform-boundaries`）+ 受影响测试 |
| 进入 `dist/` 的代码 | 上述 + `npm run build` + 真实 `runledger` 对应路径 |
| native addon | `npm run check:desktop` + `npm run build:desktop` + 真实桌面冒烟 |
| 提交 | `npm run check` 与 `npm test` |

`npm test` 若被 runner 级错误（例如既有 `Timeout calling "onTaskUpdate"`）影响，保留完整输出并区分，不伪造绿灯，也不用范围外修改掩盖。

自动化、构建后的 CLI、真实外部环境、人工视觉/键盘/中文 IME 是不同证据。Linux/mock/无头通过**不等于** human-verified 或 cross-platform verified；每个平台的 pending 门禁只能由该平台的真实证据关闭。

## 10. 实施状态与交付门槛

| 阶段 | 初始状态 | 进入下一阶段的门槛 |
|---|---|---|
| A 合同与端口 | not started | capability/`AccessRequest`/policy/settings/装配全部落地，fake port 的授权与生命周期测试通过 |
| B Windows native | not started | `check:desktop` 通过，且真实 Windows 桌面完成捕获/输入/AX/剪贴板冒烟 |
| C 工具面 | not started | 四 action schema、方法表、审批分级、投影与 artifact 规则落地，定向测试通过 |
| D settings/CLI/TUI | not started | built CLI 在隔离 `RUNLEDGER_DIR` 下完成 on/off/status 与工具面出现/消失 |
| E 提示词 | not started | prompt 与工具描述改写完成并评审 |
| F 非 Windows | not started | 按平台单列，不阻塞 A–E |

## 11. 文档同步

本计划落地时原地更新以下文档，不新建重复状态文件：

- `development-doc/plan/README.md` 与 `development-doc/00-index.md`：登记本计划（已在本次创建时登记）。
- `development-doc/plan/20-omp-implementable-tools-port-plan.md` §1 与 §8：把 `computer` 从「不在本计划」移到本计划的 authority。
- `development-doc/parity/00-oh-my-pi-coding-agent-module-gap-report.md` 第 94 行与第 145 行：更新 `computer` 的现状描述（`browser`、`eval`/`run-code` 仍无对等物）。
- `development-doc/parity/02-oh-my-pi-tool-registration-and-presentation.md` 第 325 行：注明 RunLedger 的 `computer` 是 registry 工具而非 eval prelude，因此 toggle 语义与上游不同。
- `development-doc/runtime/04-governed-agent-harness-runtime-plan.md`：`host_desktop` capability 与 `desktop` resourceKind 的 contract 变更。
- `development-doc/worktree-sandbox-permisson/evidence-verification-gaps.md`：新增 desktop 能力的平台证据缺口（若该文负责平台验收缺口）。
