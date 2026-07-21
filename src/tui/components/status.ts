/**
 * StatusComponent —— status 区单行组件,显示当前 turn / stopReason / token usage。
 *
 * 对照 development-doc/tui/02-component-spec.md §2 与 03-event-binding §1 表。
 *
 * 设计:
 *   - 持有 turn / stopReason / tokenUsage(input/output);
 *   - InteractiveMode.handleEvent 在 turn_start/turn_end/message_end 路径调相应 setter;
 *   - render 单行,左对齐,宽度被截到 width;
 *   - 仅文本展示(无 ANSI 色,色盲安全,05 §2 原则)。
 */

import type { Component } from "../index.ts";

export interface StatusComponentProps {
  initialTurn?: number;
  initialStopReason?: string;
}

export class StatusComponent implements Component {
  private turn: number | undefined;
  private stopReason: string | undefined;
  private inputTokens: number | undefined;
  private outputTokens: number | undefined;

  constructor(props: StatusComponentProps) {
    this.turn = props.initialTurn;
    this.stopReason = props.initialStopReason;
  }

  invalidate(): void {
    // 无缓存
  }

  setTurn(turn: number): void {
    this.turn = turn;
  }

  setStopReason(reason: string | undefined): void {
    this.stopReason = reason;
  }

  setTokens(input: number, output: number): void {
    this.inputTokens = input;
    this.outputTokens = output;
  }

  render(width: number): string[] {
    const parts: string[] = [];
    if (this.turn !== undefined) parts.push(`turn:${this.turn}`);
    if (this.stopReason) parts.push(`stop:${this.stopReason}`);
    if (this.inputTokens !== undefined && this.outputTokens !== undefined) {
      parts.push(`tok:${this.inputTokens}/${this.outputTokens}`);
    }
    const line = parts.join("  ");
    if (line.length <= width) {
      return [line + " ".repeat(Math.max(0, width - line.length))];
    }
    return [line.slice(0, Math.max(0, width - 1)) + "…"];
  }
}
