import type { Component } from "../index.ts";
import { matchesKey } from "../index.ts";

export interface AuthInputModalProps {
  title: string;
  message: string;
  placeholder?: string;
  secret?: boolean;
  onSubmit(value: string): void;
  onCancel(): void;
}

/** 认证专用输入框。secret 模式只渲染掩码,原值不进入 chat。 */
export class AuthInputModal implements Component {
  private readonly props: AuthInputModalProps;
  private value = "";

  constructor(props: AuthInputModalProps) {
    this.props = props;
  }

  invalidate(): void {
    // 无缓存。
  }

  handleInput(data: string): void {
    if (matchesKey(data, "enter")) {
      this.props.onSubmit(this.value);
      return;
    }
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
      this.props.onCancel();
      return;
    }
    if (matchesKey(data, "backspace")) {
      this.value = Array.from(this.value).slice(0, -1).join("");
      return;
    }
    if (matchesKey(data, "ctrl+u")) {
      this.value = "";
      return;
    }
    if (!/[\u0000-\u001f\u007f]/u.test(data)) {
      this.value += data;
    }
  }

  render(width: number): string[] {
    const shown = this.props.secret ? "•".repeat(Array.from(this.value).length) : this.value;
    const placeholder = this.value.length === 0 ? this.props.placeholder ?? "" : "";
    return [
      this.props.title.slice(0, width),
      this.props.message.slice(0, width),
      `> ${shown || placeholder}`.slice(0, width),
      "Enter confirm · Esc cancel".slice(0, width),
    ];
  }
}
