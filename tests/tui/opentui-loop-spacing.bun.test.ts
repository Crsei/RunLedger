import { describe, expect, test } from "bun:test";
import { TextRenderable } from "@opentui/core";
import { requireNode } from "./fixtures/opentui-nodes.ts";
import { createTestRenderer } from "@opentui/core/testing";
import { createOpenTuiComponentRuntimeFromRenderer } from "../../src/tui/opentui/component-runtime.ts";
import { transcriptBlockLines } from "../../src/tui/transcript-view.ts";
import { ChatContainer } from "../../src/tui/components/chat-container.ts";
import { timelineToBlocks } from "../../src/tui/timeline/selectors.ts";
import type { TimelineRow, TimelineState } from "../../src/tui/timeline/types.ts";

const bounded = (text: string) => ({ text, truncated: false, byteLength: text.length });
const base = { timestamp: "2026-09-06T00:00:00Z", displayOrder: 0, status: "succeeded" as const };
const assistant = (id: string, text: string, streaming = false): TimelineRow => ({ ...base, kind: "assistant", id, text: bounded(text), thinking: bounded(`reason-${id}`), streaming });
const tool: TimelineRow = { ...base, kind: "tool", id: "tool", toolCallId: "call", toolName: bounded("custom"), presentation: { state: "unknown", reason: "fixture" } };
const state = (rows: readonly TimelineRow[]): TimelineState => ({ generation: 1, committedRows: rows, activeRowsByCorrelationId: {}, activeOrder: [], cursor: { messageIndex: 0 } });

describe("agent loop spacing", () => {
  test("separates tool observation from the next response consistently in live and replay projections", () => {
    const rows = [assistant("first", "action"), tool, { ...tool, id: "tool-2", toolCallId: "call-2" }];
    const next = assistant("next", "answer");
    const replay = timelineToBlocks(state([...rows, next]));
    const live = timelineToBlocks({ ...state(rows), activeRowsByCorrelationId: { next }, activeOrder: ["next"] });
    expect(live).toEqual(replay);
    expect(transcriptBlockLines({ kind: "separator", label: "" }, 80)).toEqual(["─".repeat(80)]);
    expect(replay.filter((block) => block.kind === "separator").map((block) => block.id)).toEqual(["timeline-next/loop"]);
    expect(timelineToBlocks(state([...rows, { ...base, kind: "user", id: "user", text: bounded("new prompt") }, next])).filter((block) => block.kind === "separator")).toHaveLength(0);
    expect(timelineToBlocks(state([...rows, { ...base, kind: "run-boundary", id: "end", runId: "run", stopReason: "stop" }, next])).filter((block) => block.kind === "separator")).toHaveLength(1);
  });

  test("leaves one blank row around blocks and separators without empty streaming placeholders", async () => {
    const setup = await createTestRenderer({ width: 80, height: 36 });
    const runtime = createOpenTuiComponentRuntimeFromRenderer(setup.renderer, { onInput: () => {}, onResize: () => {} });
    const chat = new ChatContainer();
    try {
      for (const width of [80, 143]) {
        setup.resize(width, 36);
        for (const streaming of [true, false]) {
          chat.setTimelineBlocks(timelineToBlocks(state([
            assistant("first", "", streaming), tool, assistant("next", "answer", streaming),
          ])), streaming ? 1 : 2);
          const blocks = chat.present(width);
          runtime.update({ body: [...blocks, { id: "exec", kind: "exec", command: "echo observed", status: "succeeded", output: [{ channel: "stdout", text: "observed" }] }, { id: "notice", kind: "notice", severity: "info", message: "finished-note" }], editorText: "", footer: [] });
          await setup.renderOnce();
          await setup.renderOnce();
          const lines = setup.captureCharFrame().split("\n").map((line) => line.trimEnd());
          const markers = ["reason-first", "✓ custom", "─".repeat(width), "reason-next", "answer", "• Ran echo observed", "  └ observed", "finished-note"];
          const positions = markers.map((marker) => lines.findIndex((line) => line.includes(marker)));
          expect(positions.every((position) => position >= 0)).toBe(true);
          for (let index = 1; index < positions.length; index++) {
            expect(positions[index]! - positions[index - 1]!).toBe(2);
            expect(lines[positions[index]! - 1]).toBe("");
          }
        }
      }
    } finally { runtime.destroy(); setup.renderer.destroy(); }
  });
  test("keeps separators on one measured row across scrollbar, overlay, label and resize transitions", async () => {
    const setup = await createTestRenderer({ width: 80, height: 20 });
    const runtime = createOpenTuiComponentRuntimeFromRenderer(setup.renderer, { onInput: () => {}, onResize: () => {} });
    const chat = new ChatContainer();
    try {
      for (const width of [80, 143, 60]) {
        setup.resize(width, 20);
        for (const label of ["", "stop · Worked for 12s", "已完成思考和行动"]) {
          chat.setTimelineBlocks([{ id: "rule", kind: "separator", label }], label.length + width);
          for (const state of ["hidden", "visible", "overlay", "visible", "hidden"]) {
            runtime.update({
              body: chat.present(width), editorText: "", footer: [],
              transcriptScrollPresentation: { visible: state !== "hidden", trackColor: "#112233", thumbColor: "#445566" },
              ...(state === "overlay" ? { overlay: [{ kind: "text" as const, content: "modal" }] } : {}),
            });
            await setup.renderOnce();
            await setup.renderOnce();
            const node = requireNode(setup.renderer.root, "runledger-block-rule", TextRenderable);
            expect(node.height).toBe(1);
            expect(node.width).toBe(state === "visible" ? width - 2 : width);
            expect(node.plainText).toContain(label);
            if (state !== "overlay") {
              const rules = setup.captureCharFrame().split("\n").filter((line) => line.includes("─"));
              expect(rules).toHaveLength(1);
            }
          }
        }
      }
    } finally { runtime.destroy(); }
  });

});
