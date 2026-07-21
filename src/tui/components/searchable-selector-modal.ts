import type { Component, SelectItem } from "../index.ts";
import { matchesKey } from "../index.ts";
import { fitLinesToWidth } from "./render-width.ts";

export interface SearchableSelectorModalProps {
  title: string;
  items: SelectItem[];
  maxVisible?: number;
  onSelect(item: SelectItem): void;
  onCancel(): void;
}

/** 面向大型 model catalog 的包含式搜索选择器。 */
export class SearchableSelectorModal implements Component {
  private readonly props: SearchableSelectorModalProps;
  private query = "";
  private selectedIndex = 0;

  constructor(props: SearchableSelectorModalProps) {
    this.props = props;
  }

  invalidate(): void {
    // 无缓存。
  }

  handleInput(data: string): void {
    const items = this.filtered();
    if (matchesKey(data, "up")) {
      this.selectedIndex = items.length === 0
        ? 0
        : (this.selectedIndex - 1 + items.length) % items.length;
      return;
    }
    if (matchesKey(data, "down")) {
      this.selectedIndex = items.length === 0 ? 0 : (this.selectedIndex + 1) % items.length;
      return;
    }
    if (matchesKey(data, "enter")) {
      const selected = items[this.selectedIndex];
      if (selected) this.props.onSelect(selected);
      return;
    }
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
      this.props.onCancel();
      return;
    }
    if (matchesKey(data, "backspace")) {
      this.query = Array.from(this.query).slice(0, -1).join("");
      this.selectedIndex = 0;
      return;
    }
    if (!/[\u0000-\u001f\u007f]/u.test(data)) {
      this.query += data;
      this.selectedIndex = 0;
    }
  }

  render(width: number): string[] {
    const items = this.filtered();
    const maxVisible = this.props.maxVisible ?? 12;
    const start = Math.max(0, Math.min(
      this.selectedIndex - Math.floor(maxVisible / 2),
      Math.max(0, items.length - maxVisible),
    ));
    const visible = items.slice(start, start + maxVisible);
    const lines = [this.props.title, `/ ${this.query}`];
    for (let i = 0; i < visible.length; i++) {
      const item = visible[i]!;
      const index = start + i;
      const description = item.description ? `  ${item.description}` : "";
      lines.push(`${index === this.selectedIndex ? "→" : " "} ${item.label}${description}`);
    }
    if (items.length === 0) lines.push("  No matching items");
    else lines.push(`  (${this.selectedIndex + 1}/${items.length})`);
    return fitLinesToWidth(lines, width);
  }

  private filtered(): SelectItem[] {
    const query = this.query.trim().toLowerCase();
    if (!query) return this.props.items;
    return this.props.items.filter((item) =>
      `${item.value} ${item.label} ${item.description ?? ""}`.toLowerCase().includes(query)
    );
  }
}
