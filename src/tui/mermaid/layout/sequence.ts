import { displayWidth, truncateDisplayWidth } from "../display-width.ts";
import { MERMAID_LIMITS } from "../limits.ts";
import type {
  MermaidFallbackReason,
  MermaidSequenceBlock,
  MermaidSequenceDiagram,
  MermaidSequenceMessage,
  MermaidSequenceNote,
} from "../types.ts";

export interface MermaidSequenceLaneLayout {
  readonly id: string;
  readonly label: string;
  readonly x: number;
  readonly width: number;
  readonly centerX: number;
}

export interface MermaidSequenceMessageLayout {
  readonly message: MermaidSequenceMessage;
  readonly y: number;
  readonly fromX: number;
  readonly toX: number;
}

export interface MermaidSequenceNoteLayout {
  readonly note: MermaidSequenceNote;
  readonly x: number;
  readonly y: number;
  readonly width: number;
}

export interface MermaidSequenceBlockLayout {
  readonly block: MermaidSequenceBlock;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface MermaidSequenceBranchLayout {
  readonly label: string;
  readonly keyword: "else" | "option";
  readonly depth: number;
  readonly y: number;
}

export interface MermaidSequenceLayout {
  readonly width: number;
  readonly height: number;
  readonly lanes: readonly MermaidSequenceLaneLayout[];
  readonly messages: readonly MermaidSequenceMessageLayout[];
  readonly notes: readonly MermaidSequenceNoteLayout[];
  readonly blocks: readonly MermaidSequenceBlockLayout[];
  readonly branches: readonly MermaidSequenceBranchLayout[];
}

export type MermaidSequenceLayoutResult =
  | { readonly ok: true; readonly layout: MermaidSequenceLayout }
  | { readonly ok: false; readonly reason: MermaidFallbackReason };

export function layoutSequence(diagram: MermaidSequenceDiagram, availableWidth: number): MermaidSequenceLayoutResult {
  const width = Math.floor(availableWidth);
  if (width <= 0) return { ok: false, reason: "width_limit" };
  const gap = 4;
  const laneCount = diagram.participants.length;
  if (laneCount === 0) return { ok: false, reason: "malformed_source" };
  const naturalLaneWidth = Math.max(9, ...diagram.participants.map((participant) => displayWidth(participant.label) + 2));
  const naturalWidth = laneCount * naturalLaneWidth + Math.max(0, laneCount - 1) * gap + 2;
  const laneWidth = naturalWidth <= width
    ? naturalLaneWidth
    : Math.floor(Math.max(1, width - 2 - Math.max(0, laneCount - 1) * gap) / laneCount);
  if (laneWidth < 5) return { ok: false, reason: "width_limit" };
  const lanes = diagram.participants.map((participant, index) => {
    const x = 1 + index * (laneWidth + gap);
    return {
      id: participant.id,
      label: truncateDisplayWidth(participant.label, laneWidth - 2, displayWidth(participant.label) > laneWidth - 2),
      x,
      width: laneWidth,
      centerX: x + Math.floor(laneWidth / 2),
    };
  });
  const headerHeight = 5;
  const rowStride = 3;
  const messageRows = diagram.messages.map((message) => {
    const from = lanes.find((lane) => lane.id === message.from);
    const to = lanes.find((lane) => lane.id === message.to);
    if (!from || !to) return undefined;
    return {
      message,
      y: headerHeight + message.order * rowStride,
      fromX: from.centerX,
      toX: to.centerX,
    };
  });
  if (messageRows.some((row) => row === undefined)) return { ok: false, reason: "malformed_source" };
  const messages = messageRows as MermaidSequenceMessageLayout[];
  const notes = diagram.notes.map((note) => {
    const selected = note.participantIds.map((id) => lanes.find((lane) => lane.id === id)).filter((lane): lane is MermaidSequenceLaneLayout => lane !== undefined);
    if (selected.length !== note.participantIds.length || selected.length === 0) return undefined;
    const left = Math.min(...selected.map((lane) => lane.x));
    const right = Math.max(...selected.map((lane) => lane.x + lane.width));
    const x = note.position === "left" ? Math.max(0, left - Math.min(12, displayWidth(note.text) + 3)) : note.position === "right" ? right : left;
    return { note, x, y: headerHeight + note.order * rowStride, width: Math.max(8, Math.min(width - x, right - left + 1)) };
  });
  if (notes.some((note) => note === undefined)) return { ok: false, reason: "malformed_source" };
  const blocks = diagram.blocks.map((block) => ({
    block,
    x: 0,
    y: headerHeight + block.order * rowStride,
    width,
    height: Math.max(2, ((block.endOrder ?? block.order + 1) - block.order) * rowStride + 1),
  }));
  const branches = diagram.blocks.flatMap((block) => block.branches.map((label, index) => ({
    label,
    keyword: block.kind === "critical" ? "option" as const : "else" as const,
    depth: block.depth,
    y: headerHeight + (block.branchOrders[index] ?? block.order) * rowStride,
  })));
  const lastOrder = Math.max(
    0,
    ...diagram.messages.map((message) => message.order),
    ...diagram.notes.map((note) => note.order),
    ...diagram.blocks.map((block) => block.endOrder ?? block.order),
  );
  const height = headerHeight + (lastOrder + 1) * rowStride + 1;
  if (width > Math.floor(MERMAID_LIMITS.maxCanvasCells / Math.max(1, height))) return { ok: false, reason: "canvas_limit" };
  return {
    ok: true,
    layout: {
      width,
      height,
      lanes,
      messages,
      notes: notes as MermaidSequenceNoteLayout[],
      blocks,
      branches,
    },
  };
}
