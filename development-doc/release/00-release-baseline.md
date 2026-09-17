# RunLedger 发布与升级现状基线

> 性质：只读实测记录，不是计划，也不代表任何能力已完成。
> 实测时间：2026-09-17，工作树 `RunLedger`（分支 `rollback/before-composer-shape`，存在他人未提交改动）。
> 行号对应当前工作树；工作树被修改后需要重新实测。
> 命令名 `npm` 在本机为 10.9.8，`node` 为 22.23.1，`bun` 为 1.3.14。

本文只记录两类内容：**可复现命令的输出**，以及**代码里可定位到 `文件:行` 的事实**。
推断一律标 `[推断]`。计划、目标与验收见 [01-release-and-upgrade-infrastructure-plan.md](01-release-and-upgrade-infrastructure-plan.md)。

## 1. 复现命令

```sh
# 版本与打包面
git rev-parse --short HEAD
npm pack --dry-run --json                       # 条目数、体积、文件清单
npm pack --pack-destination "$(mktemp -d)"      # 真实 tarball

# 隔离安装（不触碰真实全局与用户目录）
P="$(mktemp -d)"; npm install --global --prefix "$P" --no-audit --no-fund <tarball>
R="$(mktemp -d)"; RUNLEDGER_DIR="$R" "$P/bin/runledger" --version

# 安装树自校验（本轮发现阻塞项的方式）
cd "$P/lib/node_modules/runledger"
bun -e 'const m=await import("./dist/cli/host-build-identity.js");
        try{const x=await m.loadVerifiedHostBuildManifest(m.productionDistributionRoot());console.log("OK",x.artifacts.length)}
        catch(e){console.log("FAIL:",e.message)}'

# 现有门禁
npm run check
npx tsx scripts/check-current-format.ts
```

## 2. 分发单元与版本真相

| 事实 | 证据 |
|---|---|
| 根包 `runledger` 版本 `0.0.1`，`private: true`，未发布过 | `package.json:3`、`package.json:4` |
| 仓库当前**没有任何 tag** | `git tag \| wc -l` → `0` |
| 无版本递增/发布脚本，无 lifecycle hook（`prepublishOnly`/`prepack`/`prepare`） | `package.json:72-146` 无对应条目 |
| 版本号唯一读取点是 CLI 自身 | `src/cli/main.ts:92` = `readVersionFromPackage()`（实现 `src/cli/main.ts:772`），读 `new URL("../../package.json")`，失败兜底 `0.0.0-unknown` |
| 版本被写入构建产物自述字段 | `scripts/generate-host-build-manifest.ts:7-11` 把 `package.json.version` 写入 manifest 的 `packageVersion` |
| 8 个 native optional 包版本与根版本手写耦合 | `npm/syntax-highlighter-*/package.json` 均为 `0.0.1`；`package.json:148-157` 的 pin 也是 `0.0.1`；由测试钉死相等：`tests/tui/syntax-highlighter-packaging.test.ts:30-42` |

**结论：版本真相分散在 4 处** —— 根 `version`、根 `optionalDependencies` 的 8 个 pin、
8 个 `npm/syntax-highlighter-*/package.json`、以及构建产物内的 `packageVersion`。
当前只有"测试发现漂移"，没有"发布前拒绝漂移"的门禁。

`@runledger/syntax-highlighter-*` 在 npm registry 上**未发布**：

```sh
npm view @runledger/syntax-highlighter-linux-x64-gnu version   # E404
npm view runledger version                                     # 0.5.0（无关项目 SilasSolivagus/agent-ledger）
```

`runledger` 这个包名在公共 registry 上已被无关项目占用，因此**不可直接作为公共发布名**。

### 2.1 native leaf 包结构与参考实现（oh-my-pi）的差异

本仓库根目录存在 `npm/`（**早于本专题文档**：由 `cbccd13` 于 2026-08-13 引入，
标题 `feat(tui): make syntax highlighting production-governed`，共 16 个文件 / 424 行；
本次文档提交 `3fdcbbf` 未触碰其中任何文件）。它是 8 个语法高亮 native 的 **leaf 包目录**，
与 oh-my-pi 的同用途结构关键差异如下：

| 维度 | RunLedger（实测） | oh-my-pi（参考） |
|---|---|---|
| 位置 | 仓库根 `npm/syntax-highlighter-<target>/` | `packages/natives/npm/<tag>/` |
| 是否进 git | **是**（`package.json` + `NOTICE.md` 已提交） | **否**，`.gitignore:66` 忽略，CI 期生成 |
| 清单来源 | 手写单行 JSON，无生成器 | `packages/natives/scripts/gen-npm-packages.ts` 的 `buildLeafManifest` 生成 |
| 每次构建 | 就地补充 `.node`/`checksums.json`/`THIRD_PARTY_NOTICES.md` | `fs.rm(leafDir, {recursive,force})` 后整体重建（`gen-npm-packages.ts:166-175`） |
| 版本来源 | 手写，与根版本靠测试钉相等 | 从核心包 `packages/natives/package.json` 读取（`gen-npm-packages.ts:141-142`，实测生成 `18.2.4`） |
| 清单字段 | `license/main/files/os/cpu/libc/engines/publishConfig`；**无** `author`/`repository`/`description` | 含 `author`/`license`/`repository`/`engines`/`files`（dry-run 实测） |
| workspace 成员 | 否（`workspaces = ["packages/*"]`） | 否（嵌套在 `packages/natives/` 下） |
| 与主包发布的关系 | leaf 独立发布；根包 `private: true`，**任何流水线都不发布主包** | leaf 与核心包同属一条发布流水线，核心包也发布 |

填充 leaf 目录的脚本是 `scripts/package-syntax-highlighter-prebuild.ts`，它**只写**
`checksums.json`（`:18`）与 `THIRD_PARTY_NOTICES.md`（`:24`），从不生成或改写 `package.json`；
`.node`/`checksums.json`/`THIRD_PARTY_NOTICES.md`/`.sigstore.json` 由 `.gitignore:12-16` 忽略。
因此 8 份清单是**唯一的手工维护点**。

字段一致性没有门禁：`tests/tui/syntax-highlighter-packaging.test.ts:27-42` 只断言 leaf 的
`name`/`version`/`files` 与"根排除本地 addon"，`:7-21` 断言的是**运行期**映射
（`src/tui/highlight/native-package.ts:11-24`）；**没有任何断言**把 leaf 清单里的
`os`/`cpu`/`libc` 与运行期映射比对。手工改错某个 leaf 的 `libc`（如把 `glibc` 写成 `musl`）
不会被现有检查发现，后果是该平台的 optional 依赖装不上而静默降级为 `native_unavailable`。

leaf 发布目前**不具备可执行的外部配置**：`.github/workflows/syntax-highlighter-prebuild.yml:92-112`
的 `release-publish` 只声明 `id-token: write`，全文无 `secrets.` / `NODE_AUTH_TOKEN`
（grep 无命中），因此它依赖 npm 侧预先配置的 trusted publisher；而实测
`@runledger/syntax-highlighter-*` 全部 404，说明该配置尚未建立。

### 2.2 与 oh-my-pi 对齐的收益与代价（逐项核实）

"对齐"在两个层面含义不同，结论也不同。

**(a) 生成式 leaf（表驱动 + gitignore + 整体重建）——收益有限，代价实在**

| 主张 | 核实结果 |
|---|---|
| "能消除目标集合的多处手抄" | 部分成立。oh-my-pi 除生成器表 `LEAF_TARGETS`（`gen-npm-packages.ts:51-58`）外，仍有 **3 处硬编码目标清单**：loader `SUPPORTED_PLATFORMS`（`packages/natives/native/loader-state.js:35`）、`update-cli.ts` 的 `SUPPORTED_NATIVE_TAGS`（该处注释明确选择重复，理由是"让 update 路径不引入跨包 import"）、CI 发布循环 `ci.yml:781` 的 6 个 tag。所以一致性门禁在两种模型下都需要 |
| "发布时 `optionalDependencies` 可派生" | **成立，且这是最实的一条**。`ci-release-publish.ts:283-288` 的 `buildNativeOptionalDependencies` 直接遍历 `LEAF_TARGETS`，因此**已发布的**核心清单不可能与 leaf 名字/版本不一致；RunLedger 的根 `optionalDependencies`（`package.json:148-157`）是手抄，只靠测试比对 |
| "leaf `main`/`files` 与实际产物一致" | 成立。`buildLeafManifest` 从 runner 实际存在的 `.node` 推导 `main`，并在零文件/非 `.node` 时报错；RunLedger 是手写字符串 |
| "缺失法律载荷会失败" | **不成立**，两边都失败。oh-my-pi `resolveLegalPayload` 返回 undefined 即 throw；RunLedger 的 `copyFile`（`package-syntax-highlighter-prebuild.ts:19`）在源缺失时同样抛错 |
| "可直接照搬" | **不成立**。oh-my-pi 的 `LEAF_TARGETS` **没有 libc 维度**（6 个 target），RunLedger 需要 glibc/musl（8 个）；其 `files: ["*.node", ...]` 也不覆盖 RunLedger 的 `checksums.json`/`.sigstore.json` |
| "载入期完整性更强" | **不成立，且方向相反**。oh-my-pi 的 loader 不校验摘要（全仓 grep `checksums`/`sha256`/`createHash` 在 `loader-state.js`、`index.js` 无命中），只校验版本哨兵符号（`loader-state.js:707` 的 `containsVersionSentinel`，符号名由 `version-sentinel.js:17` 从包版本派生）。RunLedger 校验 sha256 并 fail-closed 为 `native_integrity_error`（`native-loader.ts:72-77`），照搬其清单形状会**丢掉**摘要文件 |
| "leaf 不污染 git / 审阅" | 双向。oh-my-pi 的 leaf 目录被 `.gitignore:66` 忽略，PR 里看不到将发布的内容，本地复现需要"正确 runner + cargo + 对应 `.node`"；RunLedger 静态清单可在单机校验并被 diff 审阅（`AGENTS.md §4` 对 `package-lock.json` 有同等要求） |

**(b) 值得直接采纳的两点**

1. **单一目标表**（同时驱动运行期映射、leaf 清单、CI 矩阵、Rust triple）——
   但用"生成 + `--check` + 文件仍进 git"落地，而不是"生成 + gitignore"（见 01 §1.1 D9）。
2. **法律载荷单一来源**：8 份 `NOTICE.md` 实测 md5 相同（416 行重复），
   从 git 移除后由 CI 脚本写入即可，零信息损失。

**结论**：对齐 oh-my-pi 的价值不在其**形态**（gitignore + 重建 + 6 个无 libc 的 target），
而在其**性质**（一张表驱动所有派生面）。逐字照搬会换来更弱的载入期校验、
更差的审阅可见性和一次并不小的迁移，却换不到它自己也没做到的一致门禁。

## 3. 构建链与产物

`npm run build`（`package.json:79`）是 6 段串行链，**链上没有任何 clean/删除步骤**：

```
build = build:native(122) → build:collab-web(77) → build:typescript(121)
      → build:web(78) → build:tui-assets(75) → tsx scripts/generate-host-build-manifest.ts
```

| 步骤 | 产物 |
|---|---|
| `build:linux-peer-credential-helper` | `dist/native/runledger-linux-peer-credential`（非 Linux 直接 return） |
| `build:syntax-highlighter` | `dist/native/runledger-syntax-highlighter.node` |
| `build:collab-web` | `packages/collab-web/dist/contracts/**`（不在 `dist/` 下） |
| `build:typescript` | `dist/**/*.js` + `*.d.ts` + `*.js.map` + `*.d.ts.map` |
| `build:web` | `dist/web/assets/**` |
| `build:tui-assets` | `dist/tui/components/tips.txt` |
| manifest | `dist/host-build-manifest.json` |

因为无 clean，`dist/` 是**累积目录**。当前工作树的 `dist/` 含有**源码中已不存在的目录**：

| 残留 | 规模 | 说明 |
|---|---|---|
| `dist/update/**` | 28 个文件进 manifest（764 KB 目录） | 对应 `feat/agent-loop-resurrect` 线的 `src/update/`，当前 `src/` 无对应实现 |
| `dist/daemon/**` | 29 个文件进 manifest（1.3 MB 目录） | 同上，含 `update-host-controller.js` |
| `dist/verification-runner/**` | 232 KB 目录 | 同上 |
| `dist/native/runledger-peer-broker` | 17.8 KB | 无任何脚本再生成（`native/` 只有 `linux-peer-credential.c` 与 `syntax-highlighter/`） |
| `dist/tui/update/presentation.js` | 4 个文件 | `src/tui/update/` 当前只有 `types.ts` |

这些残留不在 git 中（`dist/` 被忽略，`.gitignore:8`），但会**进入 npm tarball**（见 §4）。

## 4. 打包面实测（`npm pack`）

```
entryCount   8463
size         6,950,962 B  (6.95 MB, tgz)
unpackedSize 37,849,952 B (37.85 MB)
```

| 项 | 实测 | 证据 |
|---|---|---|
| `files` 白名单 | `["dist", "!dist/native/runledger-syntax-highlighter.node", "assets/tree-sitter", "README.md"]` | `package.json:66-71` |
| 顶层分组 | `dist` 7040 项、`node_modules` 1418 项、`assets` 2 项、`bin` 1 项 | pack 清单 |
| `.map` 占比 | **3489 个文件 / 13,847,640 B（13.21 MB）**，占 unpacked 的 34.9% 与条目数的 41.2% | tar 清单统计 |
| 随包附带 | `bin/runledger.js`、`package.json` | npm 对 `bin` 与 `package.json` 强制收录 |
| bundle 依赖 | `node_modules/{@runledger/collab-web, marked, typebox}` | `bundleDependencies` `package.json:17-19` |
| 本地 addon | 已被 `files` 排除，**不在 tarball** | pack 清单 |
| 残留产物 | `dist/update/**`、`dist/daemon/**`、`dist/verification-runner/**`、`dist/native/runledger-peer-broker` **全部在 tarball 内** | pack 清单 |
| `LICENSE` | **仓库根无 `LICENSE` 文件**；tarball 内也没有 | `ls LICENSE*` → 文件不存在；`license: MIT`（`package.json:7`）仅是元数据 |
| `CHANGELOG.md` | 未列入 `files`，也不在 tarball | pack 清单 |
| 工作区协议泄漏 | `dependencies["@runledger/collab-web"] = "*"` | `package.json:125` |

`node_modules` 侧的 `marked`、`typebox` 会随包分发（bundle 传递），这是 `private: true` 与
`bundleDependencies` 组合的正常结果，但意味着 tarball 同时带有"bundled 一份 + registry 再解析一份"的重叠。

## 5. 隔离安装实测

### 5.1 忽略 lifecycle scripts 会得到一个起不来的 CLI

```sh
npm install --global --prefix "$P" --omit=optional --no-audit --no-fund --ignore-scripts <tgz>
RUNLEDGER_DIR="$R" "$P/bin/runledger" --version
```

输出在打印版本前中止：

```
error: Failed to load native module: pty.node, checked: build/Release, build/Debug, prebuilds/linux-x64
  at loadNativeModule (.../node_modules/node-pty/lib/utils.js:36:15)
```

原因：`node-pty@1.1.0` 是硬运行依赖（`package.json` `dependencies`；消费者
`src/storage/process/node-pty-adapter.ts:10`），其 `pty.node` 由安装期 lifecycle 构建或预编译下载获得。
仓库 `.npmrc:3` 显式设置 `ignore-scripts=false`，说明这一依赖关系是有意的。

### 5.2 正常安装可以启动

```sh
npm install --global --prefix "$P2" --omit=optional --no-audit --no-fund <tgz>
# added 210 packages in 51s；pty.node 出现在 node_modules/node-pty/build/Release/
RUNLEDGER_DIR="$R2" "$P2/bin/runledger" --version    # → runledger 0.0.1
```

`--omit=optional` 与不带该开关的安装都成功；未发布的 8 个 optional 包被 npm **静默跳过**
（无 404 报错），此时语法高亮按既有设计降级为 `native_unavailable`
（`src/tui/highlight/native-loader.ts:45-51`、`src/tui/highlight/contracts.ts` 的 reason 闭集）。

### 5.3 安装树无法通过自身构建身份校验（本轮最关键的阻塞项）

```sh
cd "$P2/lib/node_modules/runledger"
bun -e '... loadVerifiedHostBuildManifest(productionDistributionRoot()) ...'
# → FAIL: host_build_manifest_artifact_set_mismatch
```

机制：

- 构建期 manifest 由 `createHostBuildManifest` 递归 `dist` 生成，收集 `.js` / `.json` / `.node` /
  `native/runledger-linux-peer-credential`（`src/cli/host-build-identity.ts:142-145`）。
- 当前 `dist/host-build-manifest.json` 实测 **1815 个 artifact**，其中
  `native/runledger-syntax-highlighter.node` = 在册，`native/runledger-peer-broker` = 不在册。
- 打包时 `files` 把该 `.node` **排除**（`package.json:68`），而校验先用
  `canonicalJson(currentPaths) !== canonicalJson(manifest paths)` 比对集合
  （`src/cli/host-build-identity.ts:75-78`），于是安装树必然 `artifact_set_mismatch`。

即：**manifest 描述的产物集合 ≠ tarball 的产物集合**，两者由不同规则各自维护。
现有测试只钉住"根包排除该 addon"（`tests/tui/syntax-highlighter-packaging.test.ts:32`）与
"manifest 收录该 addon"（`tests/cli/host-build-identity.test.ts:63-77`）两条**互相冲突**的断言，
没有"打包后校验"的测试，所以缺陷不会在 CI 暴露。

影响面限定：`loadVerifiedHostBuildManifest` 的调用点在当前标准入口不可达（见 §6.4），
所以它不是标准会话路径的运行时故障；但它是"发布产物自校验失败"的事实，且会阻塞任何
后续把构建身份接回生产的工作。

### 5.4 npm 全局安装不留下可复用的完整性记录

```sh
find "$P2" -name "package-lock.json"            # 无输出
ls "$P2/lib"                                    # 只有 node_modules
ls -a "$P2/lib/node_modules"                    # 只有 runledger
```

即：`npm install -g --prefix "$P2" <tgz>` 之后，前缀下**没有** `package-lock.json`，也**没有**
`lib/node_modules/.package-lock.json`；`lib/node_modules/runledger/package.json` 是唯一安装记录。
因此不能像"读 npm 记录的 `integrity`/`resolved`"那样做安装树校验或来源回读，
升级设施必须自己判定安装形态（见 01 §2.3）并依赖 Release 资产的 `SHA256SUMS`（见 01 §1.1 的 D3）。

## 6. 现有版本闸门与升级接缝

### 6.1 SQLite session store（唯一带显式迁移入口的结构版本）

| 项 | 值 / 位置 |
|---|---|
| 当前 schema 版本 | `7`，`src/storage/session-store/schema.ts:13` |
| 二进制接受窗口 | `MIN=1 / MAX=7 / CURRENT=7`，`src/runtime/session-owner/types.ts:398-400` |
| 门禁 | `checkStoreCompatibility`（`src/storage/session-store/schema-compatibility.ts:92-122`）三类 fail-closed：`store_schema_too_new` / `store_schema_too_old` / `format_digest_mismatch` |
| 启动行为 | 旧版本 → `session store schema <n> requires explicit migration`（`src/cli/main.ts:196-200`）；不兼容 → 打印 detail（`:202-205`）；`migration_blocked` → 提示 resume/abort（`:207-210`）；全部 exit 2 |
| 唯一升级入口 | `runledger migrate schema --confirm`（`src/cli/schema-migrate.ts`），要求零 active owner（`beginOfflineMigration`，`schema-compatibility.ts:149-183`） |
| JSONL 导入入口 | `runledger migrate session-store --confirm-archive`（`src/cli/session-store-migrate.ts`） |
| 只读/Web 路径 | `storeVersion !== 7` → `schema_incompatible` → HTTP 503（`src/storage/session-store/history-reader.ts:49-51`、`src/web/server.ts:83-87`） |

**无降级路径**：store 版本高于二进制窗口即硬拒绝。

### 6.2 运行期协议常量（无迁移窗口）

| 常量 | 值 | 定义 |
|---|---|---|
| `SESSION_OWNER_PROTOCOL_VERSION` | `1` | `src/runtime/session-owner/types.ts:28` |
| `HOST_PROTOCOL_VERSION` | `1` | `src/runtime/host/types.ts:15` |
| `HOST_SESSION_STORAGE_CONTRACT_VERSION` | `1` | `src/runtime/host/types.ts:16` |
| `EXTENSION_HOST_PROTOCOL_VERSION` | `1` | `src/contracts/extensions/host-protocol.ts:30` |

### 6.3 文件格式版本

| 文件 | 版本字段 | 不匹配行为 |
|---|---|---|
| `settings.json` | 无 | 未知键丢弃；JSON 损坏 → stderr + recording 关闭 |
| `auth.json` | 无 | 缺失即 `{}` |
| `state/tui-preferences.json` | `version` 只接受 `1 \| 2`（`src/storage/tui-preferences.ts:95-100`） | 回退默认 + stderr diagnostic，不失败 |
| `state/extensions/extensions-state.json` | 仅 `revision` 计数 | 校验失败返回空状态，未知键保留回写 |
| `events/**/*.jsonl`（trace） | 无 | 靠 `eventHash`/`sequence` 连续性 |
| `state/hosts/**/endpoint.json` | `protocolVersion`/`managementProtocolVersion` | 不匹配即拒绝/重建 |

即：**只有 `state.db` 需要格式迁移**，其余用户级文件是"容忍未知/回退默认"语义。

### 6.4 已存在但未接线的升级接缝

| 接缝 | 位置 | 现状 |
|---|---|---|
| 更新提示被动合同 | `src/tui/update/types.ts:1-27`：`UpdateNoticeView{channel,releasePrefix,message,policy}`、`UpdateWorkflowState`（unavailable/idle/loading/ready/empty/error）、`UpdateQueryPort.inspect` | 合同存在；`src/tui/application/ports.ts:52` 的 `update?: UpdateQueryPort` 为可选；`initial-state.ts:45` 端口默认 `unavailable` |
| 工作流接线 | effect `update.inspect`（`src/tui/application/effect.ts:38`）→ runner（`src/tui/application/effect-runner.ts:188-189`）→ reducer 归属 `updateWorkflow`（`src/tui/application/reducer.ts:262`） | 三段齐备，但**没有任何地方派发 `update.inspect`**（全仓 grep 仅命中这三处声明与测试） |
| 合同约束 | `tests/tui/governed-mutations.test.ts:247-252`："update inspect only reports policy/status; no download or activation" | 强制要求 inspect 只读，不得下载或激活 |
| 宿主停机原因 | `auto_update` 是合法 shutdown reason（`src/storage/host/shutdown-intent-store.ts:14,38`），但服务端硬编码返回 `updater_unavailable`（`src/cli/runtime-host-service.ts:530`） | legacy 常驻 Host 线的占位；当前标准入口不可达 |
| 维护重启协议 | `runledger host restart` 会发 `host.shutdown{reason:"maintenance_restart", targetBuildDigest}` 并复用 `evaluateHostReplacementAdmission` 校验新 build（`src/cli/host-command.ts:137-165`、`src/storage/host/shutdown-intent-store.ts:53-69`） | `runHostCommand` **无生产调用点**（`src/cli/host-command.ts:62`；全仓仅测试引用） |
| 既有迁移措辞 | `active_owners_present`、`upgrade_requires_sessions_closed` 等 typed code 已有 | 新命令应复用同一措辞，不另造一套 |

### 6.5 边界规则对新增代码的硬约束

`scripts/check-session-owner-boundaries.ts`：

- legacy Host 的 import 来源模式含 `runtime/host/`、`storage/host/`、`runtime-host`、
  `reconnecting-host-bridge`、`host-command`、**`host-build-identity`**、`linux-peer-attestor`
  （`:47-55`）。
- 任何 `src/` 文件命中这些 import，必须属于 legacy 内部（`:57-66`）或位于
  `R0_FROZEN_LEGACY_CONSUMER_ALLOWLIST`（`:69-89`），且注释明确"**新文件不得加入**"。
- 扫描根是 `src/`（`scripts/check-session-owner-boundaries.ts` 的 `scanSessionOwnerBoundaries`），
  `scripts/` 不受约束。

**推论**：新的发布/升级模块**不能** import `host-build-identity` 或任何 `storage/host/*`、`runtime/host/*`；
若需要读构建身份，只能读 JSON 数据文件或另立模块。

`tests/cli/session-owner-cli.test.ts:189-197` 另行禁止 `src/cli/main.ts` 出现
`runtime-host` / `reconnecting-host-bridge` / `host-command` / `host-build-identity` / `storage/host/` 的 import 行。
`update` 子命令因此必须以"`main.ts` 只做一次分派、实现落在新文件"的方式接入。

`scripts/check-current-format.ts:43-50` 禁止第一方代码与**项目文档**出现代际协议标记：独立的
字母加序号代际标记、数字形式的 schema 字段名、代际特性开关、代际专用标识符与代际路径
（精确正则见该文件，本说明刻意不复写这些字面量，否则自身会被判违规）。扫描根含
`development-doc`，因此本目录文档受同一检查约束。

### 6.6 标准入口形态（决定升级语义）

- `bin/runledger.js:20-22` 定位 `<packageDir>/dist/cli/cli.js` 并 spawn `bun`；缺 Bun 时 exit 127。
- 标准 CLI 使用 `createEmbeddedSessionRuntime`（`src/cli/main.ts:51`）：**session-scoped 内嵌 Session
  Owner**，没有常驻 daemon、没有 machine-wide registry。
- `state.db` 的 SQLite 由运行时内建提供（`src/storage/session-store/database.ts:18-41`：
  `node:sqlite` / `bun:sqlite`），不是 native addon。
- Linux peer credential helper 仅被 legacy 常驻 Host 路径消费（`src/cli/runtime-host.ts:29,251`、
  `src/cli/runtime-host-production.ts:43,257`），标准入口不用它，但它仍随 dist 打包。
- 进程/PTY 能力依赖 `node-pty`（`src/storage/process/node-pty-adapter.ts:10`），是唯一需要
  lifecycle 构建的运行时依赖（见 §5.1）。
- 开发链接形态（本机实测）：

  ```
  ~/.npm-global/lib/node_modules/runledger -> ../../../../.../RunLedger      # 符号链接指向仓库
  ~/.npm-global/bin/runledger              -> ../lib/node_modules/runledger/bin/runledger.js
  ~/.npm-global/bin/runledger-daemon       -> ...（legacy 线残留）
  readlink -f $(which runledger)           # → <repo>/bin/runledger.js
  npm prefix -g                            # → /home/nzq/.npm-global
  ```

  即"已安装"的入口实际执行的是**仓库源码目录内的 `bin/runledger.js`**，
  任何原地安装都会与服务中的开发工作树冲突，必须被升级命令识别为不可自动修改的形态。

## 7. 阻塞项清单

| ID | 阻塞项 | 证据 | 为什么必须先解决 |
|---|---|---|---|
| G1 | manifest 与 tarball 的产物集合不一致，安装树自校验失败 | §5.3、`src/cli/host-build-identity.ts:142-145` vs `package.json:68` | 任何"发布产物可信"的说法都站不住；两条冲突断言需要统一 |
| G2 | 构建无 clean，陈旧产物进入 tarball | §3、`package.json:79` | tarball 携带无源码对应的 `dist/update`、`dist/daemon`、`dist/verification-runner`、`peer-broker` |
| G3 | 版本真相分散在 4 处，无漂移门禁 | §2 | 升级判定的基准不确定 |
| G4 | 无 `LICENSE` 文件；`CHANGELOG`/`LICENSE` 不进包 | §4 | 分发物缺法律与技术必要文件 |
| G5 | 包名 `runledger` 在公共 registry 已被占用 | §2 | 公共发布需要换名或换 scope，影响 registry/spec 设计 |
| G6 | `dependencies["@runledger/collab-web"] = "*"` 使用工作区协议 | `package.json:125`、§5.2 | 当前安装靠 tarball 内的 bundle 兜住（§4），但 registry 解析语义不成立，公共发布前必须改精确版本 |
| G7 | `node-pty` 必须运行 lifecycle，忽略脚本即得不可用 CLI | §5.1 | 安装前置条件必须显式化，且能在诊断里识别 |
| G8 | 无 `update` 命令、无启动提示生产实现、无安装形态识别 | §6.4 | 升级链路的三个必需要素全缺 |
| G9 | 无 tag、无发布流水线、无 release notes 生成 | §2、§8 | 升级没有可发现的目标版本 |
| G10 | `.map` 占 unpacked 的 34.9%，无体积门禁 | §4 | 分发体积不可控 |
| G11 | leaf 清单的 `os`/`cpu`/`libc` 无门禁，与运行期映射可能不一致 | §2.1、`tests/tui/syntax-highlighter-packaging.test.ts:7-42` | 手工改错即让某平台静默丢失语法高亮，且无检查发现 |
| G12 | leaf 发布依赖尚未建立的 npm trusted publisher，且无 token 回退 | §2.1、`syntax-highlighter-prebuild.yml:92-112` | tag 上的发布 job 目前必然失败（实测 404） |

## 8. 现有 CI 与文档面

| 项 | 现状 |
|---|---|
| `.github/workflows/test.yml` | 唯一门禁 workflow：`inventory-and-check` + 6 个测试 bucket + `build-and-cli-smoke`，末尾 `test-gate` 用 `always()` 汇总 `needs`；无 matrix、无 publish |
| `.github/workflows/syntax-highlighter-prebuild.yml` | 8 target matrix 构建 native addon；tag 上追加 attestation + cosign；`release-publish` 逐目录 `npm publish --access public --provenance`（`:92-112`）；**不发布根包** |
| `.npmrc` | 4 行，仅 `ignore-scripts=false`；无 registry / authToken / save-exact |
| `CHANGELOG.md` | 27 行，只有 `[Unreleased]` 段；无版本段、无比较链接、无消费者 |
| `README.md:34-53` | 唯一安装说明：源码构建 + `npm link`；唯一"升级"表述是"更新源码后需重新执行 `npm run build`" |
| `docs/cli.md:12-15` | 子命令清单含 `migrate`/`storage`，**无** `update`/`install` |
| `AGENTS.md` §5/§7 | 变更范围→必需验证表（`:76-82`）与提交推送规则（`:116-135`）；无 tag/release/版本号约定 |

## 9. 未核实项

- 未执行 `npm run check`、`npm test`、`npm run build` 的完整运行（工作树含他人未提交改动，
  且不属于本次只读调查范围）；任何"当前门禁是否全绿"的判断需要单独实测。
- 未在 macOS/Windows 上复现 §5 的安装与 manifest 校验；§3/§4 的残留与体积数字仅对本机 Linux 工作树成立。
- 未验证 `npm install -g <tarball URL>`（仅验证了本地 tarball 路径安装）。
- `dist/` 与 `src/` 的代际差异（§3）只在文件层面核对，未追溯这些残留具体来自哪个 commit 的构建。
