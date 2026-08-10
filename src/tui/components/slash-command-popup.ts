/**
 * SlashCommandPopup —— `/` 命令输入期补全弹窗(纯展示组件,键位由集成层接管)。
 *
 * 对照 development-doc/tui/20-codex-slash-command-adaptation-plan.md P2 与
 * codex-rs `bottom_pane/command_popup.rs` 的过滤/高亮/滚动语义。
 *
 * 设计:
 *   - setFilter:空过滤 → 全量列表(hiddenInFullList 别名隐藏);非空 →
 *     exact 匹配在前,prefix 匹配在后,每组带 matchIndices(相对命令名,渲染 +1 偏移跳过 `/`);
 *   - moveUp/moveDown wrap 移动选中;selectedItem() 返回当前选中命令;
 *   - render(width):`/name` + 高亮匹配段 + 描述;描述折行计入行数,总行数上限 maxVisible;
 *     无匹配渲染 "no matches";
 *   - 本组件不接键位(对照 codex CommandPopup 只持数据;键位在 P3 集成层)。
 */

import type { RegisteredSlashCommand } from "../commands/registry.ts";
import { popupCommandsForFilter } from "../commands/registry.ts";
// 直接从 primitives.ts 导入,避免经 ../index.ts 的循环依赖
// (index.ts → slash-command-selector → slash-command-popup → index.ts)
import { sliceByColumn, truncateToWidth, visibleWidth, type SelectListTheme } from "../primitives.ts";
import type { PresentationBlock } from "../presentation.ts";

export interface SlashCommandPopupOptions {
  readonly commands: readonly RegisteredSlashCommand[];
  readonly maxVisible?: number;
  readonly theme: SelectListTheme;
}

export interface SlashCommandPopupRow {
  readonly command: RegisteredSlashCommand;
  /** 当前候选实际展示/补全的名字;可能是 canonicalName 或 alias。 */
  readonly name: string;
  /** 高亮段索引(相对命令名,不含 `/`);无命中段为 undefined。 */
  readonly matchIndices?: readonly number[];
}

/** 过滤串:形如 `/model` 或 `model`;仅取 `/` 后首个非空 token。 */
export function slashPopupFilterToken(filter: string): string {
  const stripped = filter.trim().startsWith("/") ? filter.trim().slice(1) : filter.trim();
  return stripped.split(/\s+/u)[0] ?? "";
}

export class SlashCommandPopup {
  private readonly commands: readonly RegisteredSlashCommand[];
  private readonly maxVisible: number;
  private readonly theme: SelectListTheme;
  private filterText = "";
  private rows: SlashCommandPopupRow[] = [];
  private selectedIndex = 0;

  constructor(options: SlashCommandPopupOptions) {
    this.commands = options.commands;
    this.maxVisible = options.maxVisible ?? 8;
    this.theme = options.theme;
    this.filterText = "";
    this.recompute("");
  }

  invalidate(): void {}

  /** 编辑器文本/光标变化时调用;过滤串变化则重置选中。 */
  setFilter(filter: string): void {
    const token = slashPopupFilterToken(filter);
    if (token === this.filterText) return;
    this.recompute(token);
  }

  getFilterText(): string {
    return this.filterText;
  }

  moveUp(): void {
    if (this.rows.length === 0) return;
    this.selectedIndex = (this.selectedIndex - 1 + this.rows.length) % this.rows.length;
  }

  moveDown(): void {
    if (this.rows.length === 0) return;
    this.selectedIndex = (this.selectedIndex + 1) % this.rows.length;
  }

  selectedItem(): RegisteredSlashCommand | undefined {
    return this.rows[this.selectedIndex]?.command;
  }

  selectedName(): string | undefined {
    return this.rows[this.selectedIndex]?.name;
  }

  getSelectedIndex(): number {
    return this.selectedIndex;
  }

  getVisibleRows(): readonly SlashCommandPopupRow[] {
    return this.rows;
  }

  render(width: number): string[] {
    if (this.rows.length === 0) return [this.theme.noMatch("no matches")];
    const start = Math.max(0, Math.min(
      this.selectedIndex - Math.floor(this.maxVisible / 2),
      Math.max(0, this.rows.length - this.maxVisible),
    ));
    const lines: string[] = [];
    for (let offset = start; offset < this.rows.length; offset += 1) {
      if (lines.length >= this.maxVisible) break;
      const row = this.rows[offset]!;
      const selected = offset === this.selectedIndex;
      const prefix = selected ? this.theme.selectedPrefix("→ ") : "  ";
      const name = this.renderName(row);
      const primaryWidth = visibleWidth(prefix + name);
      const descriptionWidth = Math.max(0, width - primaryWidth - 2);
      const descriptionLines = descriptionWidth > 0 && row.command.description.length > 0
        ? wrapDescription(row.command.description, descriptionWidth)
        : [];
      const primaryDescription = descriptionLines[0] === undefined
        ? ""
        : `  ${this.theme.description(descriptionLines[0])}`;
      const primary = truncateToWidth(prefix + name + primaryDescription, width, "…");
      lines.push(primary);
      for (const wrapped of descriptionLines.slice(1)) {
        if (lines.length >= this.maxVisible) break;
        lines.push(`${" ".repeat(primaryWidth + 2)}${this.theme.description(wrapped)}`);
      }
    }
    if (this.rows.length > this.maxVisible) {
      lines.push(this.theme.scrollInfo(`(${this.selectedIndex + 1}/${this.rows.length})`));
    }
    return lines;
  }

  present(_width: number): PresentationBlock[] {
    return [{
      kind: "select",
      title: "",
      options: this.rows.map((row) => ({
        value: row.name,
        label: `/${row.name}`,
        description: row.command.description,
      })),
      selectedIndex: this.selectedIndex,
    }];
  }

  private renderName(row: SlashCommandPopupRow): string {
    const name = `/${row.name}`;
    const indices = row.matchIndices;
    if (indices === undefined || indices.length === 0 || row.name.length === 0) return name;
    // matchIndices 相对命令名(不含 `/`),渲染时整体 +1 跳过前导 `/`。
    const start = Math.min(Math.max(0, indices[0]! + 1), name.length);
    const end = Math.min(Math.max(start, indices.at(-1)! + 1 + 1), name.length);
    const highlight = this.theme.matchHighlight ?? ((text: string): string => text);
    return `${name.slice(0, start)}${highlight(name.slice(start, end))}${name.slice(end)}`;
  }

  private recompute(token: string): void {
    this.filterText = token;
    const hasFilter = token.length > 0;
    const candidates = popupCommandsForFilter(this.commands, hasFilter);
    if (!hasFilter) {
      this.rows = candidates.map((command) => ({ command, name: command.canonicalName }));
    } else {
      const tokenLower = token.toLowerCase();
      const exact: SlashCommandPopupRow[] = [];
      const prefix: SlashCommandPopupRow[] = [];
      for (const command of candidates) {
        for (const candidateName of new Set([command.canonicalName, ...command.aliases])) {
          const name = candidateName.toLowerCase();
          if (name === tokenLower) {
            exact.push({ command, name: candidateName, matchIndices: range(0, token.length) });
          } else if (name.startsWith(tokenLower)) {
            prefix.push({ command, name: candidateName, matchIndices: range(0, token.length) });
          }
        }
      }
      this.rows = [...exact, ...prefix];
    }
    // 过滤串变化即重置选中到 0(对照 codex state.reset());列表为空时保持 0。
    this.selectedIndex = 0;
  }
}

function range(start: number, endExclusive: number): number[] {
  const out: number[] = [];
  for (let index = start; index < endExclusive; index += 1) out.push(index);
  return out;
}

function wrapDescription(description: string, width: number): string[] {
  const lines: string[] = [];
  let rest = description;
  while (rest.length > 0) {
    const head = sliceByColumn(rest, 0, width);
    if (head.length === 0) break;
    lines.push(head);
    rest = rest.slice(head.length);
  }
  return lines;
}
