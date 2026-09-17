/**
 * Vendored turndown 的可用面。
 *
 * `service.ts` 是默认导出（`TurndownService` 类），`gfm.ts` 是插件，`types.ts`
 * 只导出类型。上游对应物是 `packages/utils/src/turndown.ts`。
 */

export * from "./gfm.ts";
export type * from "./types.ts";
export { default } from "./service.ts";
export { default as TurndownService } from "./service.ts";
