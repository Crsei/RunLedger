/**
 * `runledger/extensions`：扩展作者面向的公开入口（D12、§12 Q2）。
 *
 * 扩展只 import RunLedger 自有的、版本化的契约与 API 类型；**不**兼容
 * `@oh-my-pi/*` 或 legacy `pi` specifier。这里刻意只导出契约数据、schema
 * 与扩展侧类型，不导出 owner 侧实现（supervisor/client/channel）：扩展在
 * host 子进程内运行，拿不到 owner 的 store、settings 或 trust 句柄。
 *
 * `package.json#exports["./extensions"]` 指向本模块的构建产物。
 */

export * from "../contracts/extensions/index.ts";
export { ExtensionRuntimeNotInitializedError } from "./host/runtime-api.ts";
export type {
	ExtensionActionRequest,
	ExtensionActionResult,
	ExtensionApi,
	ExtensionActionDispatcher,
	ExtensionApiOptions,
	ExtensionRegistrations,
	ExtensionEventDelivery,
	ExtensionEventHandler,
	ExtensionEventHandlerResult,
} from "./host/runtime-api.ts";
