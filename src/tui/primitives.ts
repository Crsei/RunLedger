import stringWidth from "string-width";
import stripAnsi from "strip-ansi";
import { createOpenTuiComponentRuntime, type OpenTuiComponentRuntime } from "./opentui/component-runtime.ts";
import { FrameScheduler, type FrameBacklogSnapshot } from "./opentui/frame-scheduler.ts";
import type { TuiPerformanceObserver } from "./opentui/performance-observer.ts";
import type { PresentationBlock } from "./presentation.ts";
import type { TuiAction } from "./application/action.ts";
import { appInputForKeypress, normalizeAppInput } from "./input/normalize-action.ts";

export interface Component {
  render(width: number): string[];
  present?(width: number): PresentationBlock[];
  getPresentationVersion?(): number;
  handleInput?(data: string): void;
  invalidate(): void;
  wantsKeyRelease?: boolean;
}

export interface Focusable {
  focused: boolean;
}

export const CURSOR_MARKER = "\x1b_pi:c\x07";
export function isFocusable(component: Component | null): component is Component & Focusable {
  return component !== null && "focused" in component;
}

export type OverlayAnchor = "center" | "top-left" | "top-right" | "bottom-left" | "bottom-right" | "top-center" | "bottom-center" | "left-center" | "right-center";
export type SizeValue = number | `${number}%`;
export interface OverlayMargin { top?: number; right?: number; bottom?: number; left?: number }
export interface OverlayOptions { anchor?: OverlayAnchor; width?: SizeValue; minWidth?: number; maxHeight?: SizeValue; margin?: OverlayMargin | number; nonCapturing?: boolean }
export interface OverlayUnfocusOptions { target: Component | null }
export interface OverlayHandle {
  hide(): void;
  setHidden(hidden: boolean): void;
  isHidden(): boolean;
  focus(): void;
  unfocus(options?: OverlayUnfocusOptions): void;
  isFocused(): boolean;
}

export class Container implements Component {
  readonly children: Component[] = [];
  addChild(component: Component): void { this.children.push(component); }
  removeChild(component: Component): void {
    const index = this.children.indexOf(component);
    if (index >= 0) this.children.splice(index, 1);
  }
  clear(): void { this.children.length = 0; }
  invalidate(): void { for (const child of this.children) child.invalidate(); }
  render(width: number): string[] { return this.children.flatMap((child) => child.render(width)); }
}

export class Box extends Container {
  private readonly paddingX: number;
  private readonly paddingY: number;
  constructor(paddingX = 0, paddingY = 0) {
    super();
    this.paddingX = paddingX;
    this.paddingY = paddingY;
  }
  override render(width: number): string[] {
    const innerWidth = Math.max(0, width - this.paddingX * 2);
    const padding = " ".repeat(this.paddingX);
    const lines = super.render(innerWidth).map((line) => padding + line + padding);
    const blank = " ".repeat(Math.max(0, width));
    return [...Array.from({ length: this.paddingY }, () => blank), ...lines, ...Array.from({ length: this.paddingY }, () => blank)];
  }
}

export class Spacer implements Component {
  private readonly height: number;
  constructor(height = 1) { this.height = height; }
  invalidate(): void {}
  render(): string[] { return Array.from({ length: this.height }, () => ""); }
}

export interface SelectItem { value: string; label: string; description?: string }
export interface SelectListTheme {
  selectedPrefix(text: string): string;
  selectedText(text: string): string;
  description(text: string): string;
  scrollInfo(text: string): string;
  noMatch(text: string): string;
}
export interface SelectListTruncatePrimaryContext { text: string; maxWidth: number; columnWidth: number; item: SelectItem; isSelected: boolean }
export interface SelectListLayoutOptions { minPrimaryColumnWidth?: number; maxPrimaryColumnWidth?: number; truncatePrimary?(context: SelectListTruncatePrimaryContext): string }

export class SelectList implements Component {
  onSelect?: (item: SelectItem) => void;
  onCancel?: () => void;
  onSelectionChange?: (item: SelectItem) => void;
  private filteredItems: SelectItem[];
  private selectedIndex = 0;
  private readonly items: SelectItem[];
  private readonly maxVisible: number;
  private readonly theme: SelectListTheme;
  private readonly layout?: SelectListLayoutOptions;
  constructor(
    items: SelectItem[],
    maxVisible: number,
    theme: SelectListTheme,
    layout?: SelectListLayoutOptions,
  ) {
    this.items = items;
    this.maxVisible = maxVisible;
    this.theme = theme;
    this.layout = layout;
    this.filteredItems = items;
  }
  setFilter(filter: string): void {
    const query = filter.toLowerCase();
    this.filteredItems = this.items.filter((item) => `${item.label} ${item.description ?? ""}`.toLowerCase().includes(query));
    this.selectedIndex = 0;
  }
  setSelectedIndex(index: number): void {
    this.selectedIndex = Math.max(0, Math.min(index, Math.max(0, this.filteredItems.length - 1)));
    const item = this.filteredItems[this.selectedIndex];
    if (item) this.onSelectionChange?.(item);
  }
  getSelectedItem(): SelectItem | null { return this.filteredItems[this.selectedIndex] ?? null; }
  getSelectedIndex(): number { return this.selectedIndex; }
  getVisibleItems(): readonly SelectItem[] { return this.filteredItems; }
  invalidate(): void {}
  handleInput(data: string): void {
    if (matchesKey(data, "up")) this.setSelectedIndex((this.selectedIndex - 1 + this.filteredItems.length) % Math.max(1, this.filteredItems.length));
    else if (matchesKey(data, "down")) this.setSelectedIndex((this.selectedIndex + 1) % Math.max(1, this.filteredItems.length));
    else if (matchesKey(data, "pageUp")) this.setSelectedIndex(this.selectedIndex - this.maxVisible);
    else if (matchesKey(data, "pageDown")) this.setSelectedIndex(this.selectedIndex + this.maxVisible);
    else if (matchesKey(data, "enter")) { const item = this.getSelectedItem(); if (item) this.onSelect?.(item); }
    else if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) this.onCancel?.();
  }
  render(width: number): string[] {
    if (this.filteredItems.length === 0) return [this.theme.noMatch("No matching items")];
    const start = Math.max(0, Math.min(this.selectedIndex - Math.floor(this.maxVisible / 2), Math.max(0, this.filteredItems.length - this.maxVisible)));
    const visible = this.filteredItems.slice(start, start + this.maxVisible);
    const lines = visible.map((item, offset) => {
      const selected = start + offset === this.selectedIndex;
      const prefix = selected ? this.theme.selectedPrefix("→ ") : "  ";
      const label = selected ? this.theme.selectedText(item.label) : item.label;
      const description = item.description ? `  ${this.theme.description(item.description)}` : "";
      void this.layout;
      return truncateToWidth(prefix + label + description, width, "…");
    });
    if (this.filteredItems.length > visible.length) lines.push(this.theme.scrollInfo(`(${this.selectedIndex + 1}/${this.filteredItems.length})`));
    return lines;
  }
}

export interface EditorTheme { borderColor(text: string): string; selectList: SelectListTheme }
export interface EditorOptions { paddingX?: number; autocompleteMaxVisible?: number }
export class Editor implements Component, Focusable {
  focused = false;
  onSubmit?: (text: string) => void;
  onChange?: (text: string) => void;
  disableSubmit = false;
  private text = "";
  protected readonly tui: TUI;
  private readonly theme: EditorTheme;
  private readonly options: EditorOptions;
  constructor(tui: TUI, theme: EditorTheme, options: EditorOptions = {}) {
    this.tui = tui;
    this.theme = theme;
    this.options = options;
  }
  invalidate(): void {}
  getText(): string { return this.text; }
  getExpandedText(): string { return this.text; }
  getLines(): string[] { return this.text.split("\n"); }
  getCursor(): { line: number; col: number } {
    const lines = this.getLines();
    return { line: lines.length - 1, col: lines.at(-1)?.length ?? 0 };
  }
  setText(text: string): void { this.text = text.replace(/\r\n?|\t/gu, (value) => value === "\t" ? "    " : "\n"); this.onChange?.(this.text); this.tui.requestRender(); }
  insertTextAtCursor(text: string): void { this.setText(this.text + text); }
  addToHistory(_text: string): void {}
  render(width: number): string[] {
    void this.theme;
    const padding = " ".repeat(this.options.paddingX ?? 0);
    const available = Math.max(1, width - visibleWidth(padding) - 2);
    const lines = wrapTextWithAnsi(this.text || "", available);
    return (lines.length > 0 ? lines : [""]).map((line) => truncateToWidth(`${padding}> ${line}`, width, "…"));
  }
  handleInput(data: string): void {
    if (matchesKey(data, "enter")) {
      if (!this.disableSubmit && this.text.trim().length > 0) {
        const value = this.text;
        this.text = "";
        this.onChange?.(this.text);
        this.onSubmit?.(value);
      }
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, "shift+enter") || matchesKey(data, "ctrl+j")) { this.setText(this.text + "\n"); return; }
    if (matchesKey(data, "backspace")) { this.setText(Array.from(this.text).slice(0, -1).join("")); return; }
    if (matchesKey(data, "ctrl+u")) { this.setText(""); return; }
    if (isNavigationKey(data)) { this.tui.requestRender(); return; }
    if (!/[\u0000-\u001f\u007f]/u.test(data)) this.setText(this.text + data);
  }
}

export interface MarkdownTheme {
  heading(text: string): string; link(text: string): string; linkUrl(text: string): string; code(text: string): string;
  codeBlock(text: string): string; codeBlockBorder(text: string): string; quote(text: string): string; quoteBorder(text: string): string;
  hr(text: string): string; listBullet(text: string): string; bold(text: string): string; italic(text: string): string;
  strikethrough(text: string): string; underline(text: string): string;
}
export interface MarkdownOptions {}
export interface DefaultTextStyle {}
export class Markdown implements Component {
  private text: string;
  private readonly theme: MarkdownTheme;
  constructor(text: string, _paddingX: number, _paddingY: number, theme: MarkdownTheme) {
    this.text = text;
    this.theme = theme;
  }
  setText(text: string): void { this.text = text; }
  invalidate(): void {}
  render(width: number): string[] {
    void this.theme;
    return this.text.split("\n").flatMap((line) => wrapTextWithAnsi(line, Math.max(1, width)));
  }
}

export type InputListenerResult = { consume?: boolean; data?: string } | undefined;
export type InputListener = (data: string) => InputListenerResult;
export type RenderPreparationListener = () => void;
export interface TUIOptions {
  readonly performanceObserver?: TuiPerformanceObserver;
}
export interface Terminal {
  start(onInput: (data: string) => void, onResize: () => void): void;
  stop(): void;
  drainInput(maxMs?: number, idleMs?: number): Promise<void>;
  write(data: string): void;
  readonly columns: number;
  readonly rows: number;
  readonly kittyProtocolActive: boolean;
  moveBy(lines: number): void; hideCursor(): void; showCursor(): void; clearLine(): void; clearFromCursor(): void; clearScreen(): void;
  setTitle(title: string): void; setProgress(active: boolean): void;
}

export class ProcessTerminal implements Terminal {
  get columns(): number { return process.stdout.columns || 80; }
  get rows(): number { return process.stdout.rows || 24; }
  get kittyProtocolActive(): boolean { return true; }
  start(_onInput: (data: string) => void, _onResize: () => void): void {}
  stop(): void {}
  async drainInput(): Promise<void> {}
  write(data: string): void { process.stdout.write(data); }
  moveBy(lines: number): void { process.stdout.write(`\x1b[${Math.abs(lines)}${lines < 0 ? "A" : "B"}`); }
  hideCursor(): void { process.stdout.write("\x1b[?25l"); }
  showCursor(): void { process.stdout.write("\x1b[?25h"); }
  clearLine(): void { process.stdout.write("\x1b[2K"); }
  clearFromCursor(): void { process.stdout.write("\x1b[J"); }
  clearScreen(): void { process.stdout.write("\x1b[2J\x1b[H"); }
  setTitle(title: string): void { process.stdout.write(`\x1b]0;${title}\x07`); }
  setProgress(_active: boolean): void {}
}

export class TUI extends Container {
  readonly terminal: Terminal;
  private focusedComponent: Component | null = null;
  private readonly inputListeners: InputListener[] = [];
  private readonly renderPreparationListeners: RenderPreparationListener[] = [];
  private readonly themeModeListeners: Array<(mode: "dark" | "light") => void> = [];
  private readonly actionListeners: Array<(actions: readonly TuiAction[]) => void> = [];
  private appIntentHandler: TuiAppIntentHandler | undefined;
  private readonly performanceObserver: TuiPerformanceObserver | undefined;
  private overlay: Component | undefined;
  private overlayHidden = false;
  private runtime: OpenTuiComponentRuntime | undefined;
  private frameScheduler: FrameScheduler | undefined;
  private started = false;
  constructor(terminal: Terminal, _showHardwareCursor = false, options: TUIOptions = {}) {
    super();
    this.terminal = terminal;
    this.performanceObserver = options.performanceObserver;
  }
  addInputListener(listener: InputListener): () => void { this.inputListeners.push(listener); return () => { const i = this.inputListeners.indexOf(listener); if (i >= 0) this.inputListeners.splice(i, 1); }; }
  addBeforeRenderListener(listener: RenderPreparationListener): () => void {
    this.renderPreparationListeners.push(listener);
    return () => {
      const index = this.renderPreparationListeners.indexOf(listener);
      if (index >= 0) this.renderPreparationListeners.splice(index, 1);
    };
  }
  addThemeModeListener(listener: (mode: "dark" | "light") => void): () => void {
    this.themeModeListeners.push(listener);
    return () => {
      const index = this.themeModeListeners.indexOf(listener);
      if (index >= 0) this.themeModeListeners.splice(index, 1);
    };
  }
  addActionListener(listener: (actions: readonly TuiAction[]) => void): () => void {
    this.actionListeners.push(listener);
    return () => {
      const index = this.actionListeners.indexOf(listener);
      if (index >= 0) this.actionListeners.splice(index, 1);
    };
  }
  setAppIntentHandler(handler: TuiAppIntentHandler | undefined): void { this.appIntentHandler = handler; }
  setFocus(component: Component | null): void {
    if (isFocusable(this.focusedComponent)) this.focusedComponent.focused = false;
    this.focusedComponent = component;
    if (isFocusable(component)) component.focused = true;
  }
  hasOverlay(): boolean { return this.overlay !== undefined && !this.overlayHidden; }
  get isStarted(): boolean { return this.started; }
  showOverlay(component: Component, _options: OverlayOptions = {}): OverlayHandle {
    this.overlay = component;
    this.overlayHidden = false;
    this.requestRender();
    return {
      hide: () => this.hideOverlay(),
      setHidden: (hidden) => { this.overlayHidden = hidden; this.requestRender(); },
      isHidden: () => this.overlayHidden,
      focus: () => { this.overlayHidden = false; this.requestRender(); },
      unfocus: (options) => { if (options) this.setFocus(options.target); },
      isFocused: () => this.hasOverlay(),
    };
  }
  hideOverlay(): void { this.overlay = undefined; this.overlayHidden = false; this.requestRender(); }
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.frameScheduler = new FrameScheduler({
      frameWindowMs: 16,
      backlogLimits: {
        maxQueuedEvents: 512,
        maxQueuedBytes: 256 * 1024,
        maxOldestAgeMs: 100,
      },
      onFrame: () => {
        if (this.started) this.renderFrame();
      },
    });
    if (this.terminal instanceof ProcessTerminal) {
      this.runtime = await createOpenTuiComponentRuntime({
        onInput: (data) => this.handleInput(data, true),
        onResize: () => this.requestRender(),
        onActions: (actions) => this.emitActions(actions),
        onThemeMode: (mode) => {
          for (const listener of this.themeModeListeners) listener(mode);
        },
        performanceObserver: this.performanceObserver,
      });
      this.renderFrame();
      return;
    }
    this.terminal.start((data) => this.handleInput(data), () => this.requestRender());
    this.renderFrame();
  }
  stop(): void {
    if (!this.started) return;
    this.started = false;
    this.frameScheduler?.destroy();
    this.frameScheduler = undefined;
    this.runtime?.destroy();
    this.runtime = undefined;
    this.terminal.stop();
  }
  requestRender(force = false, backlog?: FrameBacklogSnapshot): void {
    if (!this.started || !this.frameScheduler) return;
    if (force) {
      this.frameScheduler.markDirty();
      this.frameScheduler.flush("force");
    } else this.frameScheduler.markDirty(backlog);
  }
  invalidate(): void { super.invalidate(); this.requestRender(true); }
  private handleInput(input: string, boundaryActionsDispatched = false): void {
    const appInput = appInputForKeypress(input);
    if (appInput !== undefined) {
      if (!boundaryActionsDispatched) this.emitActions(normalizeAppInput(appInput));
      if (appInput.kind === "interrupt" && this.appIntentHandler?.onInterrupt?.() !== false) {
        this.requestRender(true);
        return;
      }
      if (appInput.kind === "request-exit" && this.appIntentHandler?.onExit?.() === true) {
        this.requestRender(true);
        return;
      }
      if (appInput.kind === "viewport-clear") {
        this.appIntentHandler?.onRefresh?.();
        this.requestRender(true);
        return;
      }
    }
    let data = input;
    for (const listener of this.inputListeners) {
      const result = listener(data);
      if (result?.data !== undefined) data = result.data;
      if (result?.consume) { this.requestRender(true); return; }
    }
    const target = this.hasOverlay() ? this.overlay : this.focusedComponent;
    target?.handleInput?.(data);
    if (!this.hasOverlay() && this.focusedComponent !== null && "getText" in this.focusedComponent) {
      const draft = (this.focusedComponent as Component & { getText(): string }).getText();
      this.emitActions(normalizeAppInput({ kind: "composer-changed", draft }));
    }
    this.requestRender(true);
  }
  private emitActions(actions: readonly TuiAction[]): void {
    if (actions.length === 0) return;
    for (const listener of this.actionListeners) listener(actions);
  }
  private renderFrame(): void {
    for (const listener of this.renderPreparationListeners) listener();
    const width = Math.max(1, this.terminal.columns);
    const focusIndex = this.focusedComponent ? this.children.indexOf(this.focusedComponent) : -1;
    const bodyComponents = focusIndex >= 0 ? this.children.slice(0, focusIndex) : this.children;
    const footerComponents = focusIndex >= 0 ? this.children.slice(focusIndex + 1) : [];
    const body = bodyComponents.flatMap((component): PresentationBlock[] => component.present?.(width) ?? [{
      kind: "text",
      content: component.render(width).join("\n"),
    }]);
    const footer = footerComponents.flatMap((component) => component.render(width));
    const editorText = this.focusedComponent && "getText" in this.focusedComponent
      ? (this.focusedComponent as Component & { getText(): string }).getText()
      : "";
    const overlay = this.hasOverlay() && this.overlay
      ? this.overlay.present?.(Math.max(1, width - 4)) ?? [{
        kind: "text" as const,
        content: this.overlay.render(Math.max(1, width - 4)).join("\n"),
      }]
      : undefined;
    if (this.runtime) {
      this.runtime.update({ body, editorText, footer, overlay });
      return;
    }
    this.terminal.write([...body, ...this.focusedComponent?.render(width) ?? [], ...footer, ...overlay ?? []].join("\n"));
  }
}

export interface TuiAppIntentHandler {
  onInterrupt?(): boolean | void;
  onExit?(): boolean;
  onRefresh?(): void;
}

export type KeyId = string;
export type KeyEventType = "press" | "repeat" | "release";
export const Key = {
  escape: "escape", enter: "enter", tab: "tab", up: "up", down: "down", left: "left", right: "right",
  ctrl: (key: string) => `ctrl+${key}`, alt: (key: string) => `alt+${key}`,
} as const;

const RAW_KEYS: Record<string, readonly string[]> = {
  enter: ["\r", "\n"], return: ["\r", "\n"], escape: ["\x1b"], esc: ["\x1b"], tab: ["\t"], backspace: ["\x7f", "\x08"],
  up: ["\x1b[A"], down: ["\x1b[B"], right: ["\x1b[C"], left: ["\x1b[D"], pageUp: ["\x1b[5~"], pageDown: ["\x1b[6~"],
  "shift+enter": ["\x1b[13;2u"], "ctrl+j": ["\x0a"], "alt+enter": ["\x1b\r", "\x1b[27;3;13~"], "alt+up": ["\x1bp", "\x1b[1;3A"],
};
export function matchesKey(data: string, keyId: KeyId): boolean {
  if (RAW_KEYS[keyId]?.includes(data)) return true;
  const ctrl = /^ctrl\+(.+)$/u.exec(keyId);
  if (ctrl?.[1]?.length === 1 && data === String.fromCharCode(ctrl[1].toLowerCase().charCodeAt(0) & 0x1f)) return true;
  const alt = /^alt\+(.+)$/u.exec(keyId);
  if (alt?.[1]?.length === 1 && data === `\x1b${alt[1]}`) return true;
  return data === keyId;
}

/**
 * OpenTUI 运行时把导航键归一化为字符串键名(up/down/left/right/escape/tab/...)
 * 而不是原始转义序列;matchesKey 的 `data === keyId` 兜底能识别它们,但文本
 * 输入组件必须显式消费,否则 "up" 这种键名会被当成普通字符追加进 buffer。
 */
const NAMED_NAVIGATION_KEYS = ["escape", "tab", "delete", "home", "end", "pageUp", "pageDown", "up", "down", "left", "right"] as const;
export function isNavigationKey(data: string): boolean {
  return NAMED_NAVIGATION_KEYS.some((key) => matchesKey(data, key));
}
export function parseKey(data: string): string | undefined { return Object.entries(RAW_KEYS).find(([, values]) => values.includes(data))?.[0] ?? (data.length === 1 ? data : undefined); }
export function isKeyRelease(_data: string): boolean { return false; }
export function isKeyRepeat(_data: string): boolean { return false; }
export function isKittyProtocolActive(): boolean { return true; }
export function setKittyProtocolActive(_active: boolean): void {}

export type Keybinding = string;
export interface KeybindingDefinition { defaultKeys: KeyId | KeyId[]; description?: string }
export type KeybindingDefinitions = Record<string, KeybindingDefinition>;
export type KeybindingsConfig = Record<string, KeyId | KeyId[] | undefined>;
export interface KeybindingConflict { key: KeyId; keybindings: string[] }
export const TUI_KEYBINDINGS: KeybindingDefinitions = {
  "tui.input.submit": { defaultKeys: "enter" },
  "tui.select.up": { defaultKeys: "up" }, "tui.select.down": { defaultKeys: "down" },
  "tui.select.confirm": { defaultKeys: "enter" }, "tui.select.cancel": { defaultKeys: ["escape", "ctrl+c"] },
};
export class KeybindingsManager {
  private readonly definitions: KeybindingDefinitions;
  private userBindings: KeybindingsConfig;
  constructor(definitions: KeybindingDefinitions, userBindings: KeybindingsConfig = {}) {
    this.definitions = definitions;
    this.userBindings = userBindings;
  }
  matches(data: string, keybinding: Keybinding): boolean { return this.getKeys(keybinding).some((key) => matchesKey(data, key)); }
  getKeys(keybinding: Keybinding): KeyId[] { const value = this.userBindings[keybinding] ?? this.definitions[keybinding]?.defaultKeys ?? []; return Array.isArray(value) ? value : [value]; }
  getDefinition(keybinding: Keybinding): KeybindingDefinition { return this.definitions[keybinding] ?? { defaultKeys: [] }; }
  getConflicts(): KeybindingConflict[] { return []; }
  setUserBindings(bindings: KeybindingsConfig): void { this.userBindings = bindings; }
  getUserBindings(): KeybindingsConfig { return { ...this.userBindings }; }
  getResolvedBindings(): KeybindingsConfig { return Object.fromEntries(Object.keys(this.definitions).map((key) => [key, this.getKeys(key)])); }
}
let keybindings = new KeybindingsManager(TUI_KEYBINDINGS);
export function setKeybindings(next: KeybindingsManager): void { keybindings = next; }
export function getKeybindings(): KeybindingsManager { return keybindings; }

const ESCAPE_PATTERN = /(?:\x1B\][^\x07]*(?:\x07|\x1B\\)|\x1B\[[0-?]*[ -\/]*[@-~]|\x1B_[^\x07]*\x07)/gu;
export function visibleWidth(value: string): number { return stringWidth(stripAnsi(value.replace(ESCAPE_PATTERN, ""))); }
function tokenize(value: string): string[] {
  const tokens: string[] = [];
  let offset = 0;
  for (const match of value.matchAll(ESCAPE_PATTERN)) {
    if (match.index > offset) tokens.push(...Array.from(new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(value.slice(offset, match.index)), (entry) => entry.segment));
    tokens.push(match[0]);
    offset = match.index + match[0].length;
  }
  if (offset < value.length) tokens.push(...Array.from(new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(value.slice(offset)), (entry) => entry.segment));
  return tokens;
}
export function sliceByColumn(value: string, start: number, end = Number.POSITIVE_INFINITY, _preserveAnsi = false): string {
  let column = 0;
  let result = "";
  for (const token of tokenize(value)) {
    const width = visibleWidth(token);
    if (width === 0) { if (column >= start && column < end) result += token; continue; }
    if (column >= start && column + width <= end) result += token;
    column += width;
    if (column >= end) break;
  }
  return result;
}
export function truncateToWidth(value: string, width: number, ellipsis = ""): string {
  if (visibleWidth(value) <= width) return value;
  const suffix = visibleWidth(ellipsis) <= width ? ellipsis : "";
  const body = sliceByColumn(value, 0, Math.max(0, width - visibleWidth(suffix)), true);
  return body + suffix + (value.includes("\x1b[") ? "\x1b[0m" : "");
}
export function wrapTextWithAnsi(value: string, width: number): string[] {
  if (width <= 0) return [""];
  if (value.length === 0) return [""];
  const lines: string[] = [];
  for (const source of value.split("\n")) {
    let rest = source;
    while (visibleWidth(rest) > width) {
      const line = sliceByColumn(rest, 0, width, true);
      lines.push(line);
      rest = sliceByColumn(rest, width, Number.POSITIVE_INFINITY, true);
    }
    lines.push(rest);
  }
  return lines;
}
export function hyperlink(text: string, url: string): string { return `\x1b]8;;${url}\x07${text}\x1b]8;;\x07`; }

export interface RgbColor { r: number; g: number; b: number }
export function parseOsc11BackgroundColor(value: string): RgbColor | undefined {
  const match = /rgb:([0-9a-f]{2,4})\/([0-9a-f]{2,4})\/([0-9a-f]{2,4})/iu.exec(value);
  if (!match) return undefined;
  const channel = (hex: string): number => Math.round(Number.parseInt(hex, 16) * 255 / (16 ** hex.length - 1));
  return { r: channel(match[1]!), g: channel(match[2]!), b: channel(match[3]!) };
}
export function parseTerminalColorSchemeReport(_value: string): undefined { return undefined; }
