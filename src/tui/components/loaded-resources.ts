/**
 * LoadedResourcesComponent —— 屏幕顶部资源条(MCP / Skills / Slash commands / Hooks)。
 *
 * 对照 development-doc/tui/02-component-spec.md §2 与 07-roadmap.md M2。
 *
 * 本 M2 阶段(占位完成形态):
 *   - 持有当前 activeLedgerSessionId 与 resources 列表;
 *   - render 输出单行,显示 "ledger:<sessionId>  mcp:0  skills:0  hooks:0";
 *   - 中长期 SST 等 mcp/skills 真实接入由后续里程碑扩充,通过 setActive 接口;
 *   - M2 阶段 InteractiveMode 装配时 setActive("ledger", agent.sessionId),其余为 0。
 */

import type { Component } from "../index.ts";

export type LoadedResourceKind = "ledger" | "mcp" | "skills" | "hooks" | "slash" | "tools";

export interface LoadedResourceEntry {
  kind: LoadedResourceKind;
  count: number;
  label?: string;
}

export interface LoadedResourcesComponentProps {
  /** 装配时由 InteractiveMode 传入初始空列表;后续 SST 加载时 setActive。 */
  activeLedgerSessionId?: string;
}

export class LoadedResourcesComponent implements Component {
  private activeLedgerSessionId: string | undefined;
  private resources: Map<LoadedResourceKind, LoadedResourceEntry> = new Map();

  constructor(props: LoadedResourcesComponentProps) {
    this.activeLedgerSessionId = props.activeLedgerSessionId;
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

  /** 设置当前 ledger session id(InteractiveMode 启动时传 agent.sessionId)。 */
  setActiveLedgerSessionId(id: string): void {
    this.activeLedgerSessionId = id;
  }

  render(_width: number): string[] {
    const parts: string[] = [];
    if (this.activeLedgerSessionId && this.activeLedgerSessionId.length > 0) {
      parts.push(`ledger:${this.activeLedgerSessionId.slice(0, 8)}`);
    }
    for (const kind of ["tools", "mcp", "skills", "hooks", "slash"] as LoadedResourceKind[]) {
      const entry = this.resources.get(kind);
      if (entry) {
        parts.push(`${kind}:${entry.count}`);
      }
    }
    if (parts.length === 0) {
      return [""];
    }
    return [parts.join("  ")];
  }
}
