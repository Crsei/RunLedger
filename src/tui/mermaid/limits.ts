/** Mermaid R1 的单一资源预算；parser/layout 不应散落重复 magic number。 */
export const MERMAID_RENDER_REVISION = 2;

export const MERMAID_LIMITS = {
  sourceBytes: 65_536,
  nodes: 128,
  edges: 512,
  groups: 24,
  depth: 6,
  membersPerEntity: 8,
  labelWidth: 28,
  labelWrapWidth: 24,
  labelWrapLines: 4,
  maxCanvasCells: 524_288,
  maxDrawOperations: 20_000,
  widthBucket: 8,
  cacheEntries: 64,
  cacheBytes: 8 * 1024 * 1024,
} as const;

export type MermaidLimits = typeof MERMAID_LIMITS;
