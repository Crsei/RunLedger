import { resolveUiTheme } from "../../theme/ui-theme.ts";
/** Frame orchestration:layout、body registry、overlay owner 与 render scheduling。 */

import { BoxRenderable, ScrollBoxRenderable, TextRenderable, type CliRenderer } from "@opentui/core";
import { ansiToStyledText } from "../ansi-styled-text.ts";
import { shimmerStatusLine } from "../shimmer-status-line.ts";
import { createSyntectCodeBlockRenderer } from "../syntect-code-block-renderer.ts";
import { frameCharacterCount, isAtBottom } from "./transcript-runtime.ts";
import { promptStyledText, statusIndicatorPlainText, styledFooter, RunLedgerTextareaRenderable } from "./footer-editor-runtime.ts";
import { RenderableRegistry } from "./renderable-registry.ts";
import { OverlayController } from "./overlay-controller.ts";
import type { EditorAppearance, OpenTuiComponentFrame, OpenTuiComponentRuntimeOptions, TranscriptScrollPresentation } from "./types.ts";

export interface FrameRuntimePort {
  readonly renderer: CliRenderer;
  readonly screen: BoxRenderable;
  readonly transcript: ScrollBoxRenderable;
  readonly newContent: TextRenderable;
  readonly statusIndicator: TextRenderable;
  readonly editorRow: BoxRenderable;
  readonly editorPrompt: TextRenderable;
  readonly editor: RunLedgerTextareaRenderable;
  readonly footer: TextRenderable;
  readonly codeBlockRenderNode: ReturnType<typeof createSyntectCodeBlockRenderer>;
  readonly syntaxHighlightService: Parameters<typeof styledFooter>[1];
  readonly syntaxThemeController: Parameters<typeof styledFooter>[2];
  readonly options: OpenTuiComponentRuntimeOptions;
}

export class OpenTuiFrameRuntime {
  private terminalMode: "dark" | "light" = "dark";
  private readonly port: FrameRuntimePort;
  private readonly registry: RenderableRegistry;
  private readonly overlayController: OverlayController;
  private previousBodySignature: readonly string[] = [];
  private lastDirtyPartIds: readonly string[] = [];
  private pendingNewContent = 0;
  private requestedEditorHeight = 3;
  private lastEditorHeight = 3;
  private lastEditorAppearance: EditorAppearance | undefined;
  private lastTranscriptScrollPresentation: TranscriptScrollPresentation | undefined;

  public constructor(port: FrameRuntimePort) {
    this.port = port;
    this.registry = new RenderableRegistry(port);
    this.overlayController = new OverlayController(port);
  }

  public getLastDirtyPartIds(): readonly string[] {
    return this.lastDirtyPartIds;
  }

  public scrollBy(delta: number, mode?: "viewport"): void {
    this.port.transcript.scrollBy(delta, mode);
    this.updateNewContentIndicator();
    this.port.renderer.requestRender();
  }

  public applyThemeMode(mode: "dark" | "light"): void {
    this.terminalMode = mode;
    this.port.syntaxThemeController.setTerminalMode(mode);
    this.registry.applyTerminalMode(mode);
    // 界面颜色由 frame 中的有效快照决定，终端事件只驱动 syntax theme。
  }

  public updateHighlightAdmission(): void {
    this.registry.updateHighlightAdmission();
  }

  public disposeNodes(): void {
    this.registry.disposeSettledNodes();
  }

  public destroyStyles(): void {
    this.registry.destroyStyles();
  }

  public update(frame: OpenTuiComponentFrame): void {
    const projectionStartedAt = Date.now();
    this.registry.applyTheme(frame.uiTheme ?? resolveUiTheme({}, this.terminalMode, {}));
    if (frame.uiTheme) {
      this.port.screen.backgroundColor = frame.uiTheme.colors.background;
      this.port.footer.fg = frame.uiTheme.colors.primary;
      this.port.editor.textColor = frame.uiTheme.colors.primary;
      this.port.statusIndicator.fg = frame.uiTheme.colors.status;
    }
    const wasFollowing = isAtBottom(this.port.transcript);
    this.applyScrollPresentation(frame);
    const body = this.registry.reconcile(frame.body, frame.editorAppearance?.backgroundColor);
    this.lastDirtyPartIds = body.dirtyPartIds;
    if (this.previousBodySignature.length > 0 && body.changed) {
      if (body.signature.length < this.previousBodySignature.length || wasFollowing) this.pendingNewContent = 0;
      else this.pendingNewContent += Math.max(1, body.signature.length - this.previousBodySignature.length);
    }
    this.previousBodySignature = body.signature;
    const { footerHeight, editorHeight } = this.applyEditorAndFooter(frame);
    this.updateNewContentIndicator();
    this.overlayController.update(frame, footerHeight, editorHeight, this.port.statusIndicator.height);
    this.port.options.performanceObserver?.recordProjection({
      durationMs: Math.max(0, Date.now() - projectionStartedAt),
      processedChars: frameCharacterCount(frame),
      dirtyEntries: this.lastDirtyPartIds.length,
    });
    this.port.renderer.requestRender();
  }

  public updateStatusFrame(frame: Pick<OpenTuiComponentFrame, "statusIndicator" | "statusIndicatorShimmer" | "footer">): boolean {
    const plainStatus = frame.statusIndicator === undefined ? "" : statusIndicatorPlainText(frame.statusIndicator, this.port.renderer.width);
    const height = plainStatus.length > 0 ? plainStatus.split("\n").length : 0;
    if (height !== this.port.statusIndicator.height || Math.max(1, frame.footer.length) !== this.port.footer.height) return false;
    this.lastDirtyPartIds = [];
    this.applyStatusIndicator(frame, plainStatus);
    this.port.footer.content = styledFooter(frame.footer, this.port.syntaxHighlightService, this.port.syntaxThemeController);
    this.port.renderer.requestRender();
    return true;
  }

  private applyScrollPresentation(frame: OpenTuiComponentFrame): void {
    const requested = frame.transcriptScrollPresentation ?? { visible: false, trackColor: "", thumbColor: "" };
    const presentation = {
      ...requested,
      visible: requested.visible && !(frame.overlay !== undefined && frame.overlayNonCapturing !== true),
    };
    const previous = this.lastTranscriptScrollPresentation;
    if (previous === undefined || previous.visible !== presentation.visible) {
      this.port.transcript.viewportOptions = { paddingRight: presentation.visible ? 1 : 0 };
      this.port.transcript.verticalScrollBar.visible = presentation.visible;
    }
    if (previous === undefined || previous.trackColor !== presentation.trackColor || previous.thumbColor !== presentation.thumbColor) {
      this.port.transcript.verticalScrollbarOptions = {
        paddingLeft: 1,
        trackOptions: {
          ...(presentation.trackColor.length > 0 ? { backgroundColor: presentation.trackColor } : {}),
          ...(presentation.thumbColor.length > 0 ? { foregroundColor: presentation.thumbColor } : {}),
        },
      };
    }
    this.lastTranscriptScrollPresentation = presentation;
  }

  private applyEditorAndFooter(frame: OpenTuiComponentFrame): { footerHeight: number; editorHeight: number } {
    const { editor, renderer, statusIndicator } = this.port;
    if (editor.plainText !== frame.editorText) editor.setText(frame.editorText);
    const cursorOffset = Math.max(0, Math.min(frame.editorCursorOffset ?? frame.editorText.length, frame.editorText.length));
    if (editor.cursorOffset !== cursorOffset) editor.cursorOffset = cursorOffset;
    if (frame.editorHeight !== undefined) this.requestedEditorHeight = frame.editorHeight;
    const plainStatus = frame.statusIndicator === undefined ? "" : statusIndicatorPlainText(frame.statusIndicator, renderer.width);
    this.applyStatusIndicator(frame, plainStatus);
    const measuredLines = editor.editorView.measureForDimensions(Math.max(1, renderer.width - 3), 0x7fff)?.lineCount ?? 1;
    const desiredEditorHeight = Math.max(3, this.requestedEditorHeight, measuredLines + 2);
    const footerHeight = Math.max(1, frame.footer.length);
    const maxEditorHeight = Math.max(1, renderer.height - footerHeight - statusIndicator.height - 1);
    const boundedEditorHeight = Math.min(desiredEditorHeight, maxEditorHeight);
    if (boundedEditorHeight !== this.lastEditorHeight) {
      this.lastEditorHeight = boundedEditorHeight;
      this.port.editorRow.height = boundedEditorHeight;
    }
    this.applyEditorAppearance(frame.editorAppearance);
    this.port.footer.content = styledFooter(frame.footer, this.port.syntaxHighlightService, this.port.syntaxThemeController);
    this.port.footer.height = footerHeight;
    return { footerHeight, editorHeight: boundedEditorHeight };
  }

  private applyStatusIndicator(frame: Pick<OpenTuiComponentFrame, "statusIndicator" | "statusIndicatorShimmer">, plainStatus: string): void {
    const projectedStatus = plainStatus.length > 0 && frame.statusIndicator !== undefined && frame.statusIndicatorShimmer !== undefined
      ? shimmerStatusLine(plainStatus, frame.statusIndicator, frame.statusIndicatorShimmer)
      : plainStatus;
    const { statusIndicator } = this.port;
    statusIndicator.visible = projectedStatus.length > 0;
    statusIndicator.content = projectedStatus.length > 0 ? ansiToStyledText(projectedStatus) : "";
    statusIndicator.height = plainStatus.length > 0 ? plainStatus.split("\n").length : 0;
  }

  private applyEditorAppearance(appearance: EditorAppearance | undefined): void {
    if (appearance === undefined || appearance === this.lastEditorAppearance) return;
    const previous = this.lastEditorAppearance;
    if (previous === undefined || previous.backgroundColor !== appearance.backgroundColor) this.port.editorRow.backgroundColor = appearance.backgroundColor;
    if (previous === undefined || previous.promptColor !== appearance.promptColor) {
      this.port.editorPrompt.content = appearance.promptColor.length > 0 ? promptStyledText(appearance.promptColor) : ansiToStyledText("› ");
    }
    if (previous === undefined || previous.placeholderColor !== appearance.placeholderColor) this.port.editor.placeholderColor = appearance.placeholderColor;
    this.lastEditorAppearance = appearance;
  }

  private updateNewContentIndicator(): void {
    if (this.pendingNewContent > 0 && isAtBottom(this.port.transcript)) this.pendingNewContent = 0;
    this.port.newContent.content = this.pendingNewContent > 0 ? `↓ ${this.pendingNewContent} new content — PageDown to follow` : "";
    this.port.newContent.height = this.pendingNewContent > 0 ? 1 : 0;
  }
}
