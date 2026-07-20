# Changelog

本项目遵守 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 风格。

## [Unreleased]

### Added
- 项目骨架:`src/` 子目录、`examples/`、`tests/`,根配置 `package.json` / `tsconfig.*` / `biome.json` / `vitest.config.ts`。
- 核心类型:`AgentMessage` / `AgentTool` / `AgentEvent` / `AgentContext` / `AgentLoopConfig` / `StreamFn`(对照 `pi` 的 `packages/agent/src/types.ts`)。
- `EventStream<TEvent, TResult>`:push-based 异步事件流,既能 `for await` 消费也能 `emit` 喂数据。
- `runAgentLoop`:outer follow-up / inner tool-call 循环核心(其余高级流程以 `// TODO(pi):` 注释占位)。
- `Agent` 类:stateful 包装,`subscribe` / `on` / `prompt`。
- `LedgerSink` 接口 + `MemoryLedger` 内存实现 + `JsonlLedger` append-only 单文件实现。
- `mock-stream` provider:不需任何 API key 即可走通 start → message → tool → end 全流程(回声 echo 工具)。
- `examples/run.ts` CLI demo、`tests/agent-loop.test.ts` 单测。

### 未实现(以 `// TODO(pi):` 占位)
- `transformContext` 上下文变换;
- `prepareNextTurn` / `getSteeringMessages` / `getFollowUpMessages`;
- 真实 LLM provider(仅 mock);
- Session 树分叉、Compaction、branch summarization;
- `AgentHarness` 高级状态机;
- Skills (`SKILL.md` 加载)、Prompt templates;
- `streamProxy` (browser → backend);
- `ExecutionEnv` (FileSystem + Shell) 抽象;
- OpenTelemetry / metrics / RBAC / 多租户。
