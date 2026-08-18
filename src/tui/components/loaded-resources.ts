/**
 * LoadedResourcesComponent —— 屏幕顶部资源条(MCP / Skills / Slash commands / Hooks)。
 *
 * 对照 development-doc/tui/02-component-spec.md §2 与 07-roadmap.md M2。
 *
 * 本 M2 阶段(占位完成形态):
 *   - 持有 resources 列表(setResource 计数);
 *   - render 输出单行,显示 "mcp:0  skills:0  hooks:0";
 *   - 中长期 SST 等 mcp/skills 真实接入由后续里程碑扩充;
 *   - ledger session id 与 tools 计数不再展示(面板仅保留资源类计数)。
 */

import type { Component } from "../index.ts";
import { fitToWidth } from "./render-width.ts";

export type LoadedResourceKind = "mcp" | "skills" | "hooks" | "slash";

export interface LoadedResourceEntry {
  kind: LoadedResourceKind;
  count: number;
  label?: string;
}

export interface LoadedResourcesComponentProps {
  /** 保留接口形状;后续接入新资源计数时再扩展。 */
}

export class LoadedResourcesComponent implements Component {
  private resources: Map<LoadedResourceKind, LoadedResourceEntry> = new Map();

  constructor(_props: LoadedResourcesComponentProps = {}) {
    // 当前无构造期依赖。
  }

  invalidate(): void {
    // 无缓存
  }

  /** 设置/更新某类资源;count <=0 时移除条目。 */
  setResource(kind: LoadedResourceKind, count: number, label?: string): void {
    if (count <= 0) {
      this.resources.delete(kind);
      return;
    }
    this.resources.set(kind, { kind, count, label });
  }

  render(width: number): string[] {
    const parts: string[] = [];
    for (const kind of ["mcp", "skills", "hooks", "slash"] as LoadedResourceKind[]) {
      const entry = this.resources.get(kind);
      if (entry) {
        parts.push(`${kind}:${entry.count}`);
      }
    }
    if (parts.length === 0) {
      return [""];
    }
    return [fitToWidth(parts.join("  "), width)];
  }
}
