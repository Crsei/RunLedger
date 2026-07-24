import type { Component, TUI } from "../index.ts";

export class OverlayController {
  private readonly ui: TUI;

  constructor(ui: TUI) {
    this.ui = ui;
  }

  get isOpen(): boolean {
    return this.ui.hasOverlay();
  }

  show(component: Component): void {
    this.ui.showOverlay(component, { anchor: "bottom-left" });
  }

  close(): void {
    this.ui.hideOverlay();
  }
}
