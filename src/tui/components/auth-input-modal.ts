import type { Component } from "../index.ts";
import { isNavigationKey, matchesKey } from "../index.ts";
import { fitLinesToWidth } from "./render-width.ts";
import type { PresentationBlock } from "../presentation.ts";

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
    if (isNavigationKey(data)) {
      return;
    }
    if (!/[\u0000-\u001f\u007f]/u.test(data)) {
      this.value += data;
    }
  }

  render(width: number): string[] {
    const shown = this.props.secret ? "•".repeat(Array.from(this.value).length) : this.value;
    const placeholder = this.value.length === 0 ? this.props.placeholder ?? "" : "";
    return fitLinesToWidth([
      this.props.title,
      this.props.message,
      `> ${shown || placeholder}`,
      "Enter confirm · Esc cancel",
    ], width);
  }

  present(): PresentationBlock[] {
    return [{
      kind: "input",
      title: this.props.title,
      message: this.props.message,
      value: this.props.secret ? "•".repeat(Array.from(this.value).length) : this.value,
      placeholder: this.props.placeholder,
    }];
  }
}
