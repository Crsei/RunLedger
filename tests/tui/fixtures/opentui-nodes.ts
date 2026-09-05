import { MarkdownRenderable, BoxRenderable, Renderable, ScrollBoxRenderable, TextareaRenderable, TextRenderable } from "@opentui/core";

/** 测试按真实节点类型取值，缺失或类型错误时立即失败。 */
export function requireNode<T extends Renderable>(root: Renderable, id: string, nodeType: new (...args: never[]) => T): T {
  const node = root.findDescendantById(id);
  if (!(node instanceof nodeType)) throw new Error(`Expected ${nodeType.name} at ${id}, received ${node?.constructor.name ?? "missing"}`);
  return node;
}

export { MarkdownRenderable, BoxRenderable, ScrollBoxRenderable, TextareaRenderable, TextRenderable };
