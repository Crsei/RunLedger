import { MERMAID_LIMITS } from "../limits.ts";
import { cleanMermaidText, isComment, normalizedLines, validIdentifier } from "./shared.ts";
import type {
  MermaidFallbackReason,
  MermaidParseResult,
  MermaidSequenceBlock,
  MermaidSequenceBlockKind,
  MermaidSequenceDiagram,
  MermaidSequenceMessage,
  MermaidSequenceMessageArrow,
  MermaidSequenceMessageStyle,
  MermaidSequenceNote,
  MermaidSequenceNotePosition,
  MermaidSequenceParticipant,
  MermaidSequenceParticipantType,
} from "../types.ts";

interface MutableBlock {
  kind: MermaidSequenceBlockKind;
  label: string;
  depth: number;
  branches: string[];
  branchOrders: number[];
  order: number;
  endOrder?: number;
}

interface MutableNote {
  position: MermaidSequenceNotePosition;
  participantIds: string[];
  text: string[];
  order: number;
}

interface SequenceParser {
  autonumber: boolean;
  autonumberStart: number;
  autonumberIncrement: number;
  nextNumber: number;
  participants: MermaidSequenceParticipant[];
  participantById: Map<string, MermaidSequenceParticipant>;
  messages: MermaidSequenceMessage[];
  notes: MermaidSequenceNote[];
  blocks: MutableBlock[];
  blockStack: MutableBlock[];
  activeNote?: MutableNote;
  itemCount: number;
  sourceOrder: number;
}

function failure(reason: MermaidFallbackReason): MermaidParseResult {
  return { ok: false, reason };
}

function consumeItem(parser: SequenceParser): MermaidFallbackReason | undefined {
  if (parser.itemCount >= MERMAID_LIMITS.edges) return "sequence_limit";
  parser.itemCount += 1;
  return undefined;
}

function addParticipant(parser: SequenceParser, id: string, label: string, participantType: MermaidSequenceParticipantType): MermaidFallbackReason | undefined {
  if (!validIdentifier(id) || id === "[*]") return "malformed_source";
  const existing = parser.participantById.get(id);
  const cleanLabel = cleanMermaidText(label);
  if (existing) {
    return existing.label === cleanLabel && existing.participantType === participantType ? undefined : "malformed_source";
  }
  if (parser.participants.length >= MERMAID_LIMITS.nodes) return "node_limit";
  const participant: MermaidSequenceParticipant = {
    id,
    label: cleanLabel.length > 0 ? cleanLabel : id,
    participantType,
    order: parser.participants.length,
  };
  parser.participants.push(participant);
  parser.participantById.set(id, participant);
  return undefined;
}

function parseParticipant(parser: SequenceParser, line: string): MermaidFallbackReason | undefined {
  const match = /^(participant|actor)\s+(\S+)(?:\s+as\s+(.+))?$/iu.exec(line);
  if (!match) return "malformed_source";
  return addParticipant(parser, match[2]!, match[3] ?? match[2]!, match[1]!.toLowerCase() as MermaidSequenceParticipantType);
}

function messageOperator(operator: string): { readonly style: MermaidSequenceMessageStyle; readonly arrow: MermaidSequenceMessageArrow; readonly lost: boolean } | undefined {
  if (operator === "->>" || operator === "->" || operator === "-)") return { style: "solid", arrow: "arrow", lost: false };
  if (operator === "-->>" || operator === "-->" || operator === "--)") return { style: "dotted", arrow: "arrow", lost: false };
  if (operator === "-x" || operator === "x-") return { style: "solid", arrow: "cross", lost: true };
  if (operator === "--x" || operator === "x--") return { style: "dotted", arrow: "cross", lost: true };
  return undefined;
}

function parseMessage(parser: SequenceParser, line: string): MermaidFallbackReason | undefined {
  const match = /^([\S]+?)(-->>|->>|--x|-x|-->|->|--\)|-\)|x--|x-)\s*([+-]?)(\S+)(?:\s*:\s*(.*))?$/u.exec(line);
  if (!match) return "malformed_source";
  const from = parser.participantById.get(match[1]!);
  const to = parser.participantById.get(match[4]!);
  if (!from || !to) return "malformed_source";
  const operator = messageOperator(match[2]!);
  if (!operator) return "unsupported_syntax";
  const itemFailure = consumeItem(parser);
  if (itemFailure !== undefined) return itemFailure;
  const order = parser.sourceOrder;
  parser.sourceOrder += 1;
  const label = match[5] === undefined ? undefined : cleanMermaidText(match[5]);
  const activation = match[3] === "+" ? "start" as const : match[3] === "-" ? "end" as const : undefined;
  parser.messages.push({
    from: from.id,
    to: to.id,
    ...(label === undefined || label.length === 0 ? {} : { label }),
    style: operator.style,
    arrow: operator.arrow,
    self: from.id === to.id,
    lost: operator.lost,
    ...(activation === undefined ? {} : { activate: activation }),
    ...(parser.autonumber ? { number: parser.nextNumber } : {}),
    order,
  });
  if (parser.autonumber) parser.nextNumber += parser.autonumberIncrement;
  return undefined;
}

function parseNoteStart(parser: SequenceParser, line: string): MermaidFallbackReason | undefined {
  const match = /^Note\s+(over|left\s+of|right\s+of)\s+([^:]+?)(?:\s*:\s*(.*))?$/iu.exec(line);
  if (!match) return "unsupported_syntax";
  const position = match[1]!.toLowerCase().replace(/\s+of$/u, "") as MermaidSequenceNotePosition;
  const participantIds = match[2]!.split(",").map((id) => id.trim()).filter((id) => id.length > 0);
  if (position !== "over" && participantIds.length !== 1) return "malformed_source";
  if (participantIds.some((id) => !parser.participantById.has(id))) return "malformed_source";
  const itemFailure = consumeItem(parser);
  if (itemFailure !== undefined) return itemFailure;
  const order = parser.sourceOrder;
  parser.sourceOrder += 1;
  const text = match[3] === undefined ? [] : [cleanMermaidText(match[3])];
  if (match[3] !== undefined) {
    parser.notes.push({ position, participantIds, text: text.join(" "), order });
  } else {
    parser.activeNote = { position, participantIds, text, order };
  }
  return undefined;
}

function blockLabel(kind: MermaidSequenceBlockKind, rawLabel: string): string {
  const value = cleanMermaidText(rawLabel);
  if (kind !== "box") return value;
  const color = /^(?:[a-z]+|rgb\([^)]*\))\s+(.+)$/iu.exec(value);
  return color?.[1] ?? value;
}

function parseBlockStart(parser: SequenceParser, line: string): MermaidFallbackReason | undefined {
  const match = /^(loop|alt|opt|critical|box|rect)(?:\s+(.+))?$/iu.exec(line);
  if (!match) return "unsupported_syntax";
  const kind = match[1]!.toLowerCase() as MermaidSequenceBlockKind;
  const depth = parser.blockStack.length + 1;
  if (parser.blocks.length >= MERMAID_LIMITS.groups) return "group_limit";
  if (depth > MERMAID_LIMITS.depth) return "depth_limit";
  const itemFailure = consumeItem(parser);
  if (itemFailure !== undefined) return itemFailure;
  const order = parser.sourceOrder;
  parser.sourceOrder += 1;
  const block: MutableBlock = {
    kind,
    label: blockLabel(kind, match[2] ?? ""),
    depth,
    branches: [],
    branchOrders: [],
    order,
  };
  parser.blocks.push(block);
  parser.blockStack.push(block);
  return undefined;
}

function parseAutonumber(parser: SequenceParser, line: string): MermaidFallbackReason | undefined {
  const match = /^autonumber(?:\s+(\d+))?(?:\s+(\d+))?$/iu.exec(line);
  if (!match) return "malformed_source";
  if (parser.autonumber) return "malformed_source";
  parser.autonumber = true;
  parser.autonumberStart = match[1] === undefined ? 1 : Number.parseInt(match[1], 10);
  parser.autonumberIncrement = match[2] === undefined ? 1 : Number.parseInt(match[2], 10);
  if (!Number.isSafeInteger(parser.autonumberStart) || !Number.isSafeInteger(parser.autonumberIncrement) || parser.autonumberIncrement <= 0) return "malformed_source";
  parser.nextNumber = parser.autonumberStart;
  return undefined;
}

export function parseSequenceDiagram(source: string): MermaidParseResult {
  const lines = normalizedLines(source);
  const header = (lines.shift() ?? "").trim();
  if (!/^sequenceDiagram$/iu.test(header)) return failure("unsupported_kind");
  const parser: SequenceParser = {
    autonumber: false,
    autonumberStart: 1,
    autonumberIncrement: 1,
    nextNumber: 1,
    participants: [],
    participantById: new Map(),
    messages: [],
    notes: [],
    blocks: [],
    blockStack: [],
    itemCount: 0,
    sourceOrder: 0,
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.length === 0 || isComment(line)) continue;
    if (parser.activeNote) {
      if (/^end\s+note$/iu.test(line)) {
        parser.notes.push({
          position: parser.activeNote.position,
          participantIds: [...parser.activeNote.participantIds],
          text: cleanMermaidText(parser.activeNote.text.join(" ")),
          order: parser.activeNote.order,
        });
        parser.activeNote = undefined;
      } else {
        parser.activeNote.text.push(line);
      }
      continue;
    }
    if (/^autonumber\b/iu.test(line)) {
      const error = parseAutonumber(parser, line);
      if (error !== undefined) return failure(error);
      continue;
    }
    if (/^(?:participant|actor)\b/iu.test(line)) {
      const error = parseParticipant(parser, line);
      if (error !== undefined) return failure(error);
      continue;
    }
    if (/^Note\b/iu.test(line)) {
      const error = parseNoteStart(parser, line);
      if (error !== undefined) return failure(error);
      continue;
    }
    if (line === "end") {
      const block = parser.blockStack.pop();
      if (!block) return failure("malformed_source");
      block.endOrder = parser.sourceOrder;
      parser.sourceOrder += 1;
      continue;
    }
    const branch = /^(else|option)\b(?:\s+(.+))?$/iu.exec(line);
    if (branch) {
      const block = parser.blockStack[parser.blockStack.length - 1];
      const expected = branch[1]!.toLowerCase() === "else" ? "alt" : "critical";
      if (!block || block.kind !== expected) return failure("unsupported_syntax");
      const error = consumeItem(parser);
      if (error !== undefined) return failure(error);
      block.branches.push(cleanMermaidText(branch[2] ?? ""));
      block.branchOrders.push(parser.sourceOrder);
      parser.sourceOrder += 1;
      continue;
    }
    if (/^(?:activate|deactivate)\s+/iu.test(line)) {
      const participantId = line.replace(/^(?:activate|deactivate)\s+/iu, "").trim();
      if (!parser.participantById.has(participantId)) return failure("malformed_source");
      continue;
    }
    if (/^hide\s+footbox$/iu.test(line)) continue;
    if (/^(?:loop|alt|opt|critical|box|rect)\b/iu.test(line)) {
      const error = parseBlockStart(parser, line);
      if (error !== undefined) return failure(error);
      continue;
    }
    if (/(?:->|--|-[x)]|x-)/u.test(line)) {
      const error = parseMessage(parser, line);
      if (error !== undefined) return failure(error);
      continue;
    }
    return failure("unsupported_syntax");
  }

  if (parser.activeNote || parser.blockStack.length > 0) return failure("malformed_source");
  if (parser.participants.length === 0) return failure("malformed_source");
  const diagram: MermaidSequenceDiagram = {
    kind: "sequence",
    autonumber: parser.autonumber,
    autonumberStart: parser.autonumberStart,
    autonumberIncrement: parser.autonumberIncrement,
    participants: parser.participants.map((participant) => ({ ...participant })),
    messages: parser.messages.map((message) => ({ ...message })),
    notes: parser.notes.map((note): MermaidSequenceNote => ({ ...note, participantIds: [...note.participantIds] })),
    blocks: parser.blocks.map((block): MermaidSequenceBlock => ({
      ...block,
      branches: [...block.branches],
      branchOrders: [...block.branchOrders],
    })),
  };
  return { ok: true, diagram };
}
