/**
 * ToolRegistry —— AgentTool 的 Map 形态注册表。
 *
 * 不对齐 pi(pi 用 `AgentTool[]` 数组 + `find(t => t.name === ...)`)。
 * RunLedger 选择 Map 形态以承载企业级多命名空间分层工具,并为后续
 * MCP / Skills / 用户态注入工具铺路。
 *
 * 合并策略:
 *   - 同 namespace 内 first-wins(先注册胜出,后注册的同名工具被拒收)
 *   - 跨 namespace 隔离(`get(name)` 命中前精确匹配 namespace,再兜底全局)
 *   - `list()` 不带 namespace 时返回所有 namespace 的扁平列表
 *
 * 字段:
 *   - tool:AgentTool 实例
 *   - namespace:工具来源域("stdlib" / "fs" / "mcp" / "skill@xxx"/……)
 *   - version:可选 schema 版本号,用于跨版本兼容诊断
 *
 * 与 AgentContext.tools 的桥:
 *   - `registry.toContext()` 返回 `AgentTool[]` 给 AgentContext 用
 *   - `registry.schemaOnlyView()` 返回 pi-ai `Tool[]` 给 LLM streamFn 用
 *     (丢 execute / label / executionMode / prepareArguments)
 */

import type { TSchema } from "typebox";
import type { AgentTool } from "./types.ts";
import type { Tool } from "../types.ts";

/** 单个工具的注册元信息。 */
export interface RegisteredTool {
  tool: AgentTool;
  namespace: string;
  version?: string;
}

export interface RegisterOptions {
  namespace?: string;
  version?: string;
}

const DEFAULT_NAMESPACE = "stdlib";

/**
 * ToolRegistry —— 内部 Map 形态,key 形如 `${namespace}::${toolName}`。
 */
export class ToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>();

  /**
   * 注册工具。同名同 namespace 已存在时不变(first-wins)。
   * 返回是否成功(false = 被先注册的覆盖)。
   */
  register(tool: AgentTool, opts: RegisterOptions = {}): boolean {
    const ns = opts.namespace ?? DEFAULT_NAMESPACE;
    const key = makeKey(ns, tool.name);
    if (this.tools.has(key)) {
      return false;
    }
    this.tools.set(key, { tool, namespace: ns, version: opts.version });
    return true;
  }

  /**
   * 注销工具。namespace 必须匹配才生效(避免跨 namespace 误删)。
   * 返回是否实际移除。
   */
  unregister(name: string, namespace: string = DEFAULT_NAMESPACE): boolean {
    const key = makeKey(namespace, name);
    return this.tools.delete(key);
  }

  /** 工具是否存在;namespace 不传则任意 namespace 命中即返回 true。 */
  has(name: string, namespace?: string): boolean {
    if (namespace !== undefined) {
      return this.tools.has(makeKey(namespace, name));
    }
    for (const rt of this.tools.values()) {
      if (rt.tool.name === name) return true;
    }
    return false;
  }

  /**
   * 取工具。namespace 优先态:传了 namespace 时只查该 namespace;
   * 不传时按"最先注册胜出"取,与 pi `tools.find(name === ...)` 行为对齐。
   */
  get(name: string, namespace?: string): AgentTool | undefined {
    if (namespace !== undefined) {
      return this.tools.get(makeKey(namespace, name))?.tool;
    }
    for (const rt of this.tools.values()) {
      if (rt.tool.name === name) return rt.tool;
    }
    return undefined;
  }

  /**
   * 列出工具。namespace 不传时返回所有;传时按改 namespace 过滤。
   */
  list(namespace?: string): AgentTool[] {
    const out: AgentTool[] = [];
    for (const rt of this.tools.values()) {
      if (namespace === undefined || rt.namespace === namespace) {
        out.push(rt.tool);
      }
    }
    return out;
  }

  /**
   * 投影为 `AgentTool[]` 给 AgentContext.tools 用(扁平列表,pi 兼容形态)。
   */
  toContext(): AgentTool[] {
    return this.list();
  }

  /**
   * 投影为 pi-ai `Tool[]` 给 LLM streamFn 用 —— 丢 execute / label /
   * executionMode / prepareArguments / version / namespace 这些 LLM 不相关
   * 的字段,只留 name / description / parameters。
   */
  schemaOnlyView(): Tool[] {
    return this.list().map((t): Tool => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters as TSchema,
    }));
  }

  /** 注册数(包含所有 namespace)。 */
  get size(): number {
    return this.tools.size;
  }
}

function makeKey(namespace: string, name: string): string {
  return `${namespace}::${name}`;
}

/**
 * 把 `AgentTool[]` 直接组装成 ToolRegistry 的便捷工厂。
 * 用于"工具集很小、不需要 namespace"的场景;namespace 走默认 stdlib。
 */
export function createToolRegistry(
  tools: AgentTool[],
  opts: RegisterOptions = {},
): ToolRegistry {
  const r = new ToolRegistry();
  for (const t of tools) {
    r.register(t, opts);
  }
  return r;
}
