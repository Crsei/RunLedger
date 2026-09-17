# @runledger/collab-web

RunLedger 本地只读运行看板（Plan 15）的**浏览器侧**包：web DTO 合同 + React 单页应用 + 静态资源构建。

服务端 HTTP 桥（`src/web/**`，含认证、游标、SSE、Owner 观察适配器与只读路由）留在产品包 `runledger` 内；本包不接触 Session Owner、SQLite 或任何运行时 authority，也不依赖 `runledger` 包。这是刻意的边界：浏览器侧只消费公开 DTO，服务端负责授权与投影。

## 内容

| 路径 | 职责 |
|---|---|
| `src/contracts/**` | web DTO、TypeBox schema、`WEB_BOUNDS`、`WEB_READ_ROUTES`；唯一出口 `./contracts`。只依赖 `typebox`，不导入 Node、runtime、storage 或 TUI。 |
| `src/**`（其余） | React SPA：项目目录、会话对话、工具卡片、轨迹、用量、进程/child/Plan 能力页；`src/lib/session-store.ts` 维护有界历史窗口与实时补读。 |
| `index.html`、`src/app.css` | 静态壳与样式。 |
| `scripts/build.ts` | 用 Bun 打包 SPA，产物写入产品 `dist/web/assets`（服务端按自身 `import.meta.url` 读取）。 |
| `test/**` | 包内测试：DTO 边界回归、浏览器侧有界窗口回归、`types: []` 的浏览器 consumer 编译门禁。 |
| `THIRD_PARTY_NOTICES.md` | oh-my-pi collab-web 移植来源、commit、逐文件改动与 MIT 许可。 |

## 命令

```sh
npm run build --workspace @runledger/collab-web        # 编译 ./contracts 出口到 dist/contracts
npm run build:assets --workspace @runledger/collab-web # 打包 SPA 到仓库 dist/web/assets
npm run check --workspace @runledger/collab-web        # SPA/测试类型检查 + 浏览器 consumer 门禁
```

仓库根通过 `build:collab-web` / `build:web` / `check:collab-web` 调用上述脚本；根 `check` 必须先构建本包，根 `src` 与 `tests` 才能解析 `@runledger/collab-web/contracts` 的类型。测试侧由 `vitest.config.ts` 的 alias 直接指向 `src/contracts`，因此不要求先构建。

## 与 collab-web 的差异

参考 [oh-my-pi collab-web](https://github.com/can1357/oh-my-pi) 的组件与状态同步设计，不迁移其 relay、room key、`pi-wire` 数据模型与写操作。首版本地部署、只读、无 Composer。
