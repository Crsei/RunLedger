export { MERMAID_LIMITS, MERMAID_RENDER_REVISION } from "./limits.ts";
export { inspectMermaidFence } from "./fence.ts";
export { parseMermaidSource } from "./parse.ts";
export { renderMermaidDiagram } from "./render.ts";
export {
  MermaidProjectionCache,
  makeMermaidCacheKey,
  makeMermaidCacheKeyFromDigest,
  mermaidSourceDigest,
  mermaidWidthBucket,
} from "./cache.ts";
export type {
  MermaidProjectionCacheOptions,
  MermaidProjectionCacheSnapshot,
  MermaidRenderCacheKey,
} from "./cache.ts";
export type * from "./types.ts";
