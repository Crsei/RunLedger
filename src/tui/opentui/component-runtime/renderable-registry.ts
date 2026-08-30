/** Transcript body renderable 的唯一 create/update/destroy owner。 */

import { MarkdownRenderable, TextRenderable, type CliRenderer, type ScrollBoxRenderable } from "@opentui/core";
import { ExecRenderable } from "../exec-renderable.ts";
import { DiffRenderable } from "../diff-renderable.ts";
import { PlanUpdateRenderable } from "../plan-update-renderable.ts";
import { NoticeRenderable } from "../notice-renderable.ts";
import { ansiToStyledText } from "../ansi-styled-text.ts";
import { createRunLedgerSyntaxStyle } from "../syntax-style.ts";
import { BodySignatureTracker } from "../body-signature.ts";
import { splitClosedStreamingTable } from "../streaming-table-split.ts";
import type { PresentationBlock } from "../../presentation.ts";
import { chooseSettledMarkdownSpan, finalizeMarkdownChildren, updateMermaidTheme, updateTranscriptHighlightAdmission } from "./highlight-admission.ts";
import { blockKey, blockSignatureText, blockText, isSettledPresentationBlock, renderableId, toPresentationBlock } from "./transcript-runtime.ts";
import type { BodyRenderable, KeyedRenderable, OpenTuiComponentFrame, SettledMarkdownState } from "./types.ts";
import type { FrameRuntimePort } from "./frame-runtime.ts";

export interface RenderableReconciliation {
  readonly signature: readonly string[];
  readonly changed: boolean;
  readonly dirtyPartIds: readonly string[];
}

type RenderableRegistryPort = Pick<FrameRuntimePort, "renderer" | "transcript" | "codeBlockRenderNode" | "syntaxHighlightService" | "syntaxThemeController">;

export class RenderableRegistry {
  private readonly port: RenderableRegistryPort;
  private bodyNodes = new Map<string, KeyedRenderable<BodyRenderable>>();
  private settledMarkdownStates = new Map<string, SettledMarkdownState>();
  private readonly bodySignatureTracker = new BodySignatureTracker();
  private syntaxStyle = createRunLedgerSyntaxStyle();

  public constructor(port: RenderableRegistryPort) {
    this.port = port;
  }

  public reconcile(body: OpenTuiComponentFrame["body"]): RenderableReconciliation {
    const { renderer, transcript } = this.port;
    const nextBodyNodes = new Map<string, KeyedRenderable<BodyRenderable>>();
    const nextSettledMarkdownStates = new Map<string, SettledMarkdownState>();
    const desiredBodyNodes: BodyRenderable[] = [];
    const bodyBlocks = body.length > 0 ? body.map(toPresentationBlock) : [{ id: "empty", kind: "text" as const, content: "" }];
    const keyedBodyBlocks = uniqueBodyKeys(bodyBlocks);
    const snapshot = this.bodySignatureTracker.update(keyedBodyBlocks.map(({ block, key }) => ({
      key,
      ...(block.partId === undefined ? {} : { partId: block.partId }),
      kind: block.kind,
      streaming: block.kind === "markdown" ? block.streaming : block.kind === "diff" ? block.streaming === true : false,
      ...(block.contentGeneration === undefined ? {} : { contentGeneration: block.contentGeneration }),
      ...(block.finalized === undefined ? {} : { finalized: block.finalized }),
      contentKey: isSettledPresentationBlock(block) ? "" : blockSignatureText(block),
    })));

    for (const { block, key } of keyedBodyBlocks) {
      const previous = this.bodyNodes.get(key);
      const previousSettled = this.settledMarkdownStates.get(key);
      const markdownBlock = block.kind === "markdown" ? block : undefined;
      const settledSpan = markdownBlock?.streaming === true
        ? chooseSettledMarkdownSpan(markdownBlock.content, previousSettled?.span, splitClosedStreamingTable(markdownBlock.content))
        : undefined;
      const splitMarkdown = markdownBlock !== undefined && settledSpan !== undefined && settledSpan.end > 0 && settledSpan.end < markdownBlock.content.length;
      let settledRenderable: MarkdownRenderable | undefined;
      if (splitMarkdown && settledSpan !== undefined) {
        settledRenderable = previousSettled?.renderable ?? new MarkdownRenderable(renderer, {
          id: renderableId("runledger-block", `${key}-settled`),
          width: "100%",
          flexShrink: 0,
          content: settledSpan.prefixText,
          streaming: true,
          syntaxStyle: this.syntaxStyle,
          internalBlockMode: "top-level",
          renderNode: this.port.codeBlockRenderNode,
        });
        if (settledRenderable.content !== settledSpan.prefixText) {
          settledRenderable.content = "";
          settledRenderable.content = settledSpan.prefixText;
        }
        settledRenderable.streaming = false;
        finalizeMarkdownChildren(settledRenderable);
        nextSettledMarkdownStates.set(key, { span: settledSpan, renderable: settledRenderable });
      }
      const contentKey = block.kind === "markdown"
        ? (splitMarkdown && settledSpan !== undefined ? block.content.slice(settledSpan.end) : block.content)
        : blockText(block);
      const current = this.reconcileNode(block, key, contentKey, previous);
      nextBodyNodes.set(key, current);
      if (settledRenderable !== undefined) desiredBodyNodes.push(settledRenderable);
      desiredBodyNodes.push(current.renderable);
    }
    disposeMissing(this.settledMarkdownStates, nextSettledMarkdownStates, transcript);
    disposeMissing(this.bodyNodes, nextBodyNodes, transcript);
    for (const [index, node] of desiredBodyNodes.entries()) {
      if (transcript.getChildren()[index] !== node) {
        if (node.parent === transcript) transcript.remove(node);
        transcript.add(node, index);
      }
    }
    this.bodyNodes = nextBodyNodes;
    this.settledMarkdownStates = nextSettledMarkdownStates;
    return { signature: snapshot.signature, changed: snapshot.changed, dirtyPartIds: snapshot.changedKeys };
  }

  public applyThemeMode(mode: "dark" | "light"): void {
    const previousStyle = this.syntaxStyle;
    this.syntaxStyle = createRunLedgerSyntaxStyle();
    for (const node of this.bodyNodes.values()) {
      if (node.renderable instanceof MarkdownRenderable) node.renderable.syntaxStyle = this.syntaxStyle;
      updateMermaidTheme(node.renderable, mode);
    }
    for (const state of this.settledMarkdownStates.values()) {
      state.renderable.syntaxStyle = this.syntaxStyle;
      updateMermaidTheme(state.renderable, mode);
    }
    previousStyle.destroy();
  }

  public updateHighlightAdmission(): void {
    updateTranscriptHighlightAdmission(this.port.transcript, this.bodyNodes, this.settledMarkdownStates);
  }

  public disposeSettledNodes(): void {
    for (const state of this.settledMarkdownStates.values()) state.renderable.destroyRecursively();
    this.settledMarkdownStates.clear();
  }

  public destroyStyles(): void {
    this.syntaxStyle.destroy();
  }

  private reconcileNode(
    block: PresentationBlock,
    key: string,
    contentKey: string,
    previous: KeyedRenderable<BodyRenderable> | undefined,
  ): KeyedRenderable<BodyRenderable> {
    let current = previous;
    if (current?.kind !== block.kind) {
      if (current) this.port.transcript.remove(current.renderable);
      current?.renderable.destroyRecursively();
      current = undefined;
    }
    if (!current) return this.createNode(block, key, contentKey);
    if (block.kind === "markdown" && current.renderable instanceof MarkdownRenderable) {
      if (current.streaming !== block.streaming) {
        if (!block.streaming) {
          current.renderable.content = "";
          current.contentKey = undefined;
        }
        current.renderable.streaming = block.streaming;
        current.streaming = block.streaming;
      }
      if (current.contentKey !== contentKey) {
        if (current.contentKey !== undefined && !contentKey.startsWith(current.contentKey)) {
          current.renderable.content = "";
          current.contentKey = undefined;
        }
        current.renderable.content = contentKey;
        current.contentKey = contentKey;
      }
      if (!block.streaming) finalizeMarkdownChildren(current.renderable);
    } else if (block.kind === "exec" && current.renderable instanceof ExecRenderable) {
      if (current.contentKey !== contentKey) current.renderable.updateBlock(block);
    } else if (block.kind === "diff" && current.renderable instanceof DiffRenderable) {
      if (current.contentKey !== contentKey) current.renderable.updateBlock(block);
    } else if (block.kind === "plan-update" && current.renderable instanceof PlanUpdateRenderable) {
      if (current.contentKey !== contentKey) current.renderable.updateBlock(block);
    } else if (block.kind === "notice" && current.renderable instanceof NoticeRenderable) {
      if (current.contentKey !== contentKey) current.renderable.updateBlock(block);
    } else if (current.renderable instanceof TextRenderable && current.contentKey !== contentKey) {
      current.renderable.content = ansiToStyledText(contentKey);
    }
    current.contentKey = contentKey;
    return current;
  }

  private createNode(block: PresentationBlock, key: string, contentKey: string): KeyedRenderable<BodyRenderable> {
    const renderer = this.port.renderer;
    const common = { id: renderableId("runledger-block", key), width: "100%" as const, flexShrink: 0 };
    const renderable = block.kind === "markdown"
      ? new MarkdownRenderable(renderer, { ...common, content: contentKey, streaming: true, syntaxStyle: this.syntaxStyle, internalBlockMode: "top-level", renderNode: this.port.codeBlockRenderNode })
      : block.kind === "exec"
      ? new ExecRenderable(renderer, { ...common, block, highlightService: this.port.syntaxHighlightService, themeController: this.port.syntaxThemeController })
      : block.kind === "diff"
      ? new DiffRenderable(renderer, { ...common, block, highlightService: this.port.syntaxHighlightService, themeController: this.port.syntaxThemeController })
      : block.kind === "plan-update"
      ? new PlanUpdateRenderable(renderer, { ...common, block })
      : block.kind === "notice"
      ? new NoticeRenderable(renderer, { ...common, block, highlightService: this.port.syntaxHighlightService, themeController: this.port.syntaxThemeController })
      : new TextRenderable(renderer, { ...common, content: ansiToStyledText(blockText(block)) });
    if (block.kind === "markdown" && !block.streaming && renderable instanceof MarkdownRenderable) {
      renderable.streaming = false;
      finalizeMarkdownChildren(renderable);
    }
    return { kind: block.kind, renderable, contentKey, ...(block.kind === "markdown" ? { streaming: block.streaming } : {}) };
  }
}

function uniqueBodyKeys(body: readonly PresentationBlock[]): Array<{ readonly block: PresentationBlock; readonly key: string }> {
  const result: Array<{ readonly block: PresentationBlock; readonly key: string }> = [];
  const used = new Set<string>();
  for (const [index, block] of body.entries()) {
    const key = blockKey(block, index);
    const uniqueKey = used.has(key) ? `${key}-${index}` : key;
    used.add(uniqueKey);
    result.push({ block, key: uniqueKey });
  }
  return result;
}

function disposeMissing<T extends BodyRenderable | MarkdownRenderable>(
  previous: ReadonlyMap<string, { readonly renderable: T }>,
  next: ReadonlyMap<string, { readonly renderable: T }>,
  transcript: ScrollBoxRenderable,
): void {
  for (const [key, node] of previous) {
    if (next.has(key)) continue;
    transcript.remove(node.renderable);
    node.renderable.destroyRecursively();
  }
}
