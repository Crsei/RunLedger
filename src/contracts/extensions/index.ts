/**
 * Extension 运行时与 plugin 分发的公共合同入口（本文件只导出纯数据、
 * schema、catalog 与纯函数）。行为实现位于 `src/extensions/**` 与
 * `src/runtime/session-runtime/**`；契约模块不做 I/O、不授予权限。
 */

export * from "./common.ts";
export * from "./manifest.ts";
export * from "./events.ts";
export * from "./registry.ts";
export * from "./host-protocol.ts";
export * from "./intent.ts";
export * from "./marketplace.ts";

/** 必须由独立契约 PR 冻结的上位决策；改变任一项先改专题文档与测试。 */
export const EXTENSION_CONTRACT_DECISIONS = Object.freeze([
	"D1:扩展代码在 session 私有 extension host 子进程内执行",
	"D3:扩展工具与声明式资源经既有 admission 路径",
	"D4:扩展副作用统一为 owner-fenced mutation",
	"D5:扩展事件是 canonical event 的投影",
	"D7:分发只用受治理 fetch/解包,不用包管理器",
	"D9:无 Extension UI context,只能提交 intent",
	"D12:扩展 API 包是 RunLedger 自有契约",
	"D14:全面 bounded",
] as const);
