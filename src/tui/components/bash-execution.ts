/**
 * BashExecutionComponent —— bash 工具的"实时执行"渲染块。
 *
 * M5 新增:对齐 docs/tui/02-component-spec.md §6 BashExecution 三态 + background 模式。
 *
 * 设计:
 *   - 持有 command / status (pending|running|ok|error) / stdout-tail / stderr-tail /
 *     runInBackground / exitCode / durationMs;
 *   - 折叠态单行:host_icon + bin_bash + cmd[0..width-?] + status_icon;
 *   - 展开态:扩 stdout/stderr tail + exitCode + bg 提示;
 *   - 真流式 (run_in_background) 由 BashAdapter 在每条 chunk 后调 appendOutput,渲染时
 *     只保留最后 N 行(默认 200)避免长跑日志炸内存。
 */

import type { Component } from "../index.ts";

export type BashExecStatus = "pending" | "running" | "ok" | "error";

export interface BashExecutionComponentProps {
  command: string;
  initialStatus?: BashExecStatus;
  runInBackground?: boolean;
  maxTailLines?: number;
}

const STATUS_ICON: Record<BashExecStatus, string> = {
  pending: "⏳",
  running: "…",
  ok: "✓",
  error: "✗",
};

export class BashExecutionComponent implements Component {
  private readonly command: string;
  private readonly runInBackground: boolean;
  private readonly maxTailLines: number;
  private status: BashExecStatus;
  private stdoutLines: string[] = [];
  private stderrLines: string[] = [];
  private exitCode: number | undefined;
  private durationMs: number | undefined;
  private expanded: boolean = false;
  private errorMessage: string | undefined;

  constructor(props: BashExecutionComponentProps) {
    this.command = props.command;
    this.runInBackground = props.runInBackground ?? false;
    this.maxTailLines = props.maxTailLines ?? 200;
    this.status = props.initialStatus ?? "pending";
  }

  invalidate(): void {
    // 无缓存
  }

  setStatus(status: BashExecStatus): void {
    this.status = status;
  }

  appendStdout(line: string): void {
    if (line.length === 0) return;
    this.stdoutLines.push(line);
    if (this.stdoutLines.length > this.maxTailLines) {
      this.stdoutLines = this.stdoutLines.slice(-this.maxTailLines);
    }
  }

  appendStderr(line: string): void {
    if (line.length === 0) return;
    this.stderrLines.push(line);
    if (this.stderrLines.length > this.maxTailLines) {
      this.stderrLines = this.stderrLines.slice(-this.maxTailLines);
    }
  }

  /** 同 appendStdout+appendStderr,但接收多行 chunk。 */
  appendOutput(chunk: string, stream: "stdout" | "stderr" = "stdout"): void {
    const lines = chunk.split(/\r?\n/);
    for (const l of lines) {
      if (stream === "stdout") this.appendStdout(l);
      else this.appendStderr(l);
    }
  }

  finalize(
    exitCode: number,
    durationMs: number,
    isError: boolean = false,
    errorMessage?: string,
  ): void {
    this.exitCode = exitCode;
    this.durationMs = durationMs;
    this.status = isError ? "error" : "ok";
    if (errorMessage) this.errorMessage = errorMessage;
  }

  setError(message: string): void {
    this.errorMessage = message;
    this.status = "error";
  }

  toggle(): void {
    this.expanded = !this.expanded;
  }

  render(width: number): string[] {
    const icon = STATUS_ICON[this.status];
    const bgTag = this.runInBackground ? "(bg) " : "";
    const cmdShort = this.command.length > Math.max(0, width - 12)
      ? this.command.slice(0, Math.max(0, width - 13)) + "…"
      : this.command;
    const header = `$ ${bgTag}${cmdShort}  ${icon}`;
    if (!this.expanded) {
      return header.length <= width ? [header] : [header.slice(0, Math.max(0, width - 1)) + "…"];
    }
    const lines = [header];
    if (this.stdoutLines.length > 0) {
      lines.push("  stdout:");
      for (const l of this.stdoutLines.slice(-Math.max(1, Math.floor(this.maxTailLines / 2)))) {
        const max = Math.max(0, width - 4);
        lines.push("    " + (l.length > max ? l.slice(0, max - 1) + "…" : l));
      }
    }
    if (this.stderrLines.length > 0) {
      lines.push("  stderr:");
      for (const l of this.stderrLines.slice(-Math.max(1, Math.floor(this.maxTailLines / 2)))) {
        const max = Math.max(0, width - 4);
        lines.push("    " + (l.length > max ? l.slice(0, max - 1) + "…" : l));
      }
    }
    if (this.exitCode !== undefined || this.durationMs !== undefined) {
      const parts: string[] = [];
      if (this.exitCode !== undefined) parts.push(`exit=${this.exitCode}`);
      if (this.durationMs !== undefined) parts.push(`${this.durationMs}ms`);
      lines.push(`  ${parts.join("  ")}`);
    }
    if (this.status === "error" && this.errorMessage) {
      const max = Math.max(0, width - 9);
      const trimmed =
        this.errorMessage.length > max
          ? this.errorMessage.slice(0, Math.max(0, max - 1)) + "…"
          : this.errorMessage;
      lines.push(`  ! ERR: ${trimmed}`);
    }
    return lines;
  }
}
