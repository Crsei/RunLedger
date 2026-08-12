import { displayWidth, graphemes, truncateDisplayWidth } from "./display-width.ts";
import { createMermaidCanvas } from "./layout/canvas.ts";
import { layoutFlowchart } from "./layout/graph.ts";
import { layoutSequence } from "./layout/sequence.ts";
import { MERMAID_LIMITS } from "./limits.ts";
import type {
  MermaidClassDiagram,
  MermaidDiagram,
  MermaidErDiagram,
  MermaidFlowchartDiagram,
  MermaidProjectionResult,
  MermaidStateDiagram,
  MermaidSequenceDiagram,
} from "./types.ts";

function stateAsFlowchart(diagram: MermaidStateDiagram): MermaidFlowchartDiagram {
  return {
    kind: "flowchart",
    direction: diagram.direction,
    nodes: diagram.states.map((state) => ({
      id: state.id,
      label: state.label,
      shape: state.stateType === "choice" ? "diamond" : state.stateType === "start" || state.stateType === "end" ? "round" : "rect",
      order: state.order,
    })),
    edges: diagram.transitions.map((transition) => ({
      from: transition.from,
      to: transition.to,
      ...(transition.label === undefined ? {} : { label: transition.label }),
      style: "solid" as const,
      arrow: "arrow" as const,
      order: transition.order,
    })),
    groups: diagram.groups.map((group) => ({
      id: group.id,
      label: group.label,
      depth: group.depth,
      nodeIds: group.stateIds,
      order: group.order,
    })),
  };
}

function classAsFlowchart(diagram: MermaidClassDiagram): MermaidFlowchartDiagram {
  return {
    kind: "flowchart",
    direction: "LR",
    nodes: diagram.classes.map((classNode) => ({
      id: classNode.id,
      label: classNode.label,
      displayLines: [classNode.label, ...classNode.members.map((member) => member.display)],
      shape: "rect" as const,
      order: classNode.order,
    })),
    edges: diagram.relations.map((relation) => {
      const leftArrow = relation.operator.startsWith("<") && !relation.operator.startsWith("<|");
      const rightArrow = relation.operator.endsWith(">");
      return {
      from: relation.from,
      to: relation.to,
      ...(relation.label === undefined ? {} : { label: relation.label }),
      style: relation.relation === "dependency" ? "dotted" as const : relation.relation === "composition" ? "thick" as const : "solid" as const,
      arrow: rightArrow ? "arrow" as const : "none" as const,
      ...(relation.relation === "inheritance" ? { startMarker: "△" } : leftArrow ? { startMarker: "◀" } : {}),
      ...(relation.relation === "composition" ? { startMarker: "◆" } : {}),
      ...(relation.relation === "aggregation" ? { startMarker: "◇" } : {}),
      ...(relation.leftCardinality === undefined ? {} : { startLabel: relation.leftCardinality }),
      ...(relation.rightCardinality === undefined ? {} : { endLabel: relation.rightCardinality }),
      order: relation.order,
    };
    }),
    groups: [],
  };
}

function erAsFlowchart(diagram: MermaidErDiagram): MermaidFlowchartDiagram {
  return {
    kind: "flowchart",
    direction: "LR",
    nodes: diagram.entities.map((entity) => ({
      id: entity.id,
      label: entity.label,
      displayLines: [entity.label, ...entity.attributes.map((attribute) => `${attribute.keys.join(",")} ${attribute.type} ${attribute.name}`.trim())],
      shape: "rect" as const,
      order: entity.order,
    })),
    edges: diagram.relations.map((relation) => ({
      from: relation.from,
      to: relation.to,
      ...(relation.label === undefined ? {} : { label: relation.label }),
      style: relation.identifying ? "thick" as const : "dotted" as const,
      arrow: "none" as const,
      startLabel: relation.leftCardinality,
      endLabel: relation.rightCardinality,
      order: relation.order,
    })),
    groups: [],
  };
}

function drawSequenceBox(
  canvas: NonNullable<ReturnType<typeof createMermaidCanvas>>,
  x: number,
  y: number,
  width: number,
  label: string,
  className: "border" | "title",
  height = 1,
): void {
  if (width < 3 || y < 0 || y >= canvas.height) return;
  const right = Math.min(canvas.width - 1, x + width - 1);
  canvas.setGlyph(x, y, "┌", className);
  for (let column = x + 1; column < right; column += 1) canvas.setGlyph(column, y, "─", className);
  canvas.setGlyph(right, y, "┐", className);
  if (label.length > 0) canvas.drawText(x + 1, y, ` ${truncateDisplayWidth(label, Math.max(1, right - x - 2))} `, "title");
  if (height <= 1) return;
  const bottom = Math.min(canvas.height - 1, y + height - 1);
  for (let row = y + 1; row < bottom; row += 1) {
    canvas.setGlyph(x, row, "│", className);
    canvas.setGlyph(right, row, "│", className);
  }
  canvas.setGlyph(x, bottom, "└", className);
  for (let column = x + 1; column < right; column += 1) canvas.setGlyph(column, bottom, "─", className);
  canvas.setGlyph(right, bottom, "┘", className);
}

function renderSequenceDiagram(diagram: MermaidSequenceDiagram, width: number): MermaidProjectionResult {
  const layoutResult = layoutSequence(diagram, width);
  if (!layoutResult.ok) return layoutResult;
  const canvas = createMermaidCanvas(layoutResult.layout.width, layoutResult.layout.height);
  if (!canvas) return { ok: false, reason: "canvas_limit" };
  const layout = layoutResult.layout;
  for (const lane of layout.lanes) {
    drawSequenceBox(canvas, lane.x, 0, lane.width, lane.label, "border");
    canvas.drawPolyline([{ x: lane.centerX, y: 1 }, { x: lane.centerX, y: layout.height - 1 }], "edge", 2);
  }
  for (const block of layout.blocks) {
    const indent = Math.max(0, Math.min(block.block.depth - 1, 4));
    drawSequenceBox(canvas, indent, block.y, Math.max(3, block.width - indent), block.block.label, "border", block.height);
  }
  for (const branch of layout.branches) {
    const indent = Math.max(1, Math.min(branch.depth, 5));
    canvas.drawText(
      indent,
      branch.y,
      `${branch.keyword} ${truncateDisplayWidth(branch.label, Math.max(1, canvas.width - indent - branch.keyword.length - 2), true)}`.trimEnd(),
      "title",
    );
  }
  for (const message of layout.messages) {
    const from = message.fromX;
    const to = message.toX;
    if (message.message.self) {
      const loopRight = Math.min(canvas.width - 2, from + 4);
      canvas.drawPolyline([
        { x: from, y: message.y },
        { x: loopRight, y: message.y },
        { x: loopRight, y: message.y + 1 },
        { x: from, y: message.y + 1 },
      ], "edge", message.message.style === "dotted" ? 2 : 1);
      canvas.setGlyph(from, message.y + 1, message.message.arrow === "cross" ? "×" : "◀", "edge");
    } else {
      const step = to >= from ? 1 : -1;
      canvas.drawPolyline([{ x: from, y: message.y }, { x: to, y: message.y }], "edge", message.message.style === "dotted" ? 2 : 1);
      const arrow = message.message.arrow === "cross" ? "×" : step > 0 ? "▶" : "◀";
      canvas.setGlyph(to, message.y, arrow, "edge");
    }
    const label = `${message.message.number === undefined ? "" : `${message.message.number} `}${message.message.label ?? ""}`.trim();
    if (label.length > 0) {
      const labelX = message.message.self ? from + 1 : Math.min(from, to) + 1;
      const labelWidth = message.message.self
        ? Math.max(1, canvas.width - labelX - 1)
        : Math.max(1, Math.abs(to - from) - 1);
      canvas.drawText(labelX, Math.max(0, message.y - 1), truncateDisplayWidth(label, Math.min(20, labelWidth), true), "edgeLabel");
    }
  }
  for (const note of layout.notes) {
    canvas.drawText(note.x, note.y, `[Note: ${truncateDisplayWidth(note.note.text, Math.max(1, note.width - 8), true)}]`, "title");
  }
  const lines = canvas.toStyledLines();
  return { ok: true, width: layout.width, height: layout.height, lines, estimatedBytes: canvas.estimatedBytes(lines) };
}

function graphForDiagram(diagram: MermaidDiagram): MermaidFlowchartDiagram {
  if (diagram.kind === "flowchart") return diagram;
  if (diagram.kind === "state") return stateAsFlowchart(diagram);
  if (diagram.kind === "class") return classAsFlowchart(diagram);
  if (diagram.kind === "er") return erAsFlowchart(diagram);
  throw new Error(`sequence diagram must use its dedicated layout`);
}

function drawNodeBox(
  canvas: NonNullable<ReturnType<typeof createMermaidCanvas>>,
  node: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
    readonly labelLines: readonly string[];
  },
  shape: "rect" | "round" | "diamond",
): void {
  const left = shape === "round" ? "╭" : shape === "diamond" ? "◇" : "┌";
  const right = shape === "round" ? "╮" : shape === "diamond" ? "◇" : "┐";
  const bottomLeft = shape === "round" ? "╰" : shape === "diamond" ? "◇" : "└";
  const bottomRight = shape === "round" ? "╯" : shape === "diamond" ? "◇" : "┘";
  const horizontal = "─".repeat(Math.max(1, node.width - 2));
  canvas.setGlyph(node.x, node.y, left, "border", true);
  canvas.drawText(node.x + 1, node.y, horizontal, "border", true);
  canvas.setGlyph(node.x + node.width - 1, node.y, right, "border", true);
  for (let row = 1; row < node.height - 1; row += 1) {
    canvas.setGlyph(node.x, node.y + row, "│", "border", true);
    canvas.setGlyph(node.x + node.width - 1, node.y + row, "│", "border", true);
  }
  canvas.setGlyph(node.x, node.y + node.height - 1, bottomLeft, "border", true);
  canvas.drawText(node.x + 1, node.y + node.height - 1, horizontal, "border", true);
  canvas.setGlyph(node.x + node.width - 1, node.y + node.height - 1, bottomRight, "border", true);
  for (let row = 0; row < node.labelLines.length; row += 1) {
    const label = truncateDisplayWidth(node.labelLines[row] ?? "", node.width - 2);
    const offset = Math.max(0, Math.floor((node.width - 2 - displayWidth(label)) / 2));
    canvas.drawText(node.x + 1 + offset, node.y + 1 + row, label, "nodeText", true);
  }
}

function drawArrow(
  canvas: NonNullable<ReturnType<typeof createMermaidCanvas>>,
  point: { readonly x: number; readonly y: number },
  previous: { readonly x: number; readonly y: number } | undefined,
  arrow: "none" | "arrow" | "circle" | "cross",
): void {
  if (arrow === "none") return;
  if (arrow === "circle") {
    canvas.setGlyph(point.x, point.y, "○", "edge");
    return;
  }
  if (arrow === "cross") {
    canvas.setGlyph(point.x, point.y, "×", "edge");
    return;
  }
  const glyph = previous === undefined
    ? "▶"
    : previous.x < point.x
      ? "▶"
      : previous.x > point.x
        ? "◀"
        : previous.y < point.y
          ? "▼"
          : "▲";
  canvas.setGlyph(point.x, point.y, glyph, "edge");
}

function drawEndpointMarker(
  canvas: NonNullable<ReturnType<typeof createMermaidCanvas>>,
  point: { readonly x: number; readonly y: number } | undefined,
  marker: string | undefined,
): void {
  if (point !== undefined && marker !== undefined) canvas.setGlyph(point.x, point.y, marker, "edge");
}

function drawEdgeLabel(
  canvas: NonNullable<ReturnType<typeof createMermaidCanvas>>,
  points: readonly { readonly x: number; readonly y: number }[],
  label: string,
): boolean {
  if (label.length === 0) return true;
  if (points.length < 2) return false;
  let segmentStart = points[0]!;
  let segmentEnd = points[1]!;
  let segmentLength = 0;
  for (let index = 1; index < points.length; index += 1) {
    const start = points[index - 1]!;
    const end = points[index]!;
    const length = Math.abs(end.x - start.x) + Math.abs(end.y - start.y);
    if (length > segmentLength) {
      segmentStart = start;
      segmentEnd = end;
      segmentLength = length;
    }
  }
  const value = truncateDisplayWidth(label, 20, displayWidth(label) > 20);
  const horizontal = segmentStart.y === segmentEnd.y;
  const requestedX = horizontal
    ? Math.max(0, Math.floor((segmentStart.x + segmentEnd.x - displayWidth(value)) / 2))
    : segmentStart.x + 1;
  const requestedY = horizontal
    ? segmentStart.y > 0 ? segmentStart.y - 1 : segmentStart.y + 1
    : Math.floor((segmentStart.y + segmentEnd.y) / 2);
  const candidates: Array<readonly [number, number]> = [
    [requestedX, requestedY],
    [requestedX, requestedY - 1],
    [requestedX, requestedY + 1],
    [requestedX, requestedY - 2],
    [requestedX, requestedY + 2],
    [segmentStart.x + 1, segmentStart.y],
    [segmentEnd.x + 1, segmentEnd.y],
  ];
  for (const [x, y] of candidates) {
    if (canvas.drawTextIfEmpty(x, y, value, "edgeLabel")) return true;
  }
  return false;
}

function estimatedGraphDrawOperations(layout: {
  readonly nodes: readonly {
    readonly width: number;
    readonly height: number;
    readonly labelLines: readonly string[];
  }[];
  readonly edges: readonly {
    readonly points: readonly { readonly x: number; readonly y: number }[];
    readonly label?: string;
    readonly startLabel?: string;
    readonly endLabel?: string;
  }[];
}): number {
  let operations = 0;
  for (const node of layout.nodes) {
    operations += 2 * (node.width + node.height);
    operations += node.labelLines.reduce((total, line) => total + line.length, 0);
  }
  for (const edge of layout.edges) {
    for (let index = 1; index < edge.points.length; index += 1) {
      const previous = edge.points[index - 1]!;
      const point = edge.points[index]!;
      operations += Math.abs(point.x - previous.x) + Math.abs(point.y - previous.y) + 1;
    }
    operations += Math.min(20, edge.label?.length ?? 0) * 7;
    operations += Math.min(12, edge.startLabel?.length ?? 0) * 4;
    operations += Math.min(12, edge.endLabel?.length ?? 0) * 4;
    if (operations > MERMAID_LIMITS.maxDrawOperations) return operations;
  }
  return operations;
}

function drawEdgeEndpointLabels(
  canvas: NonNullable<ReturnType<typeof createMermaidCanvas>>,
  edge: {
    readonly points: readonly { readonly x: number; readonly y: number }[];
    readonly startLabel?: string;
    readonly endLabel?: string;
  },
): boolean {
  const endpoints: Array<readonly [string | undefined, { readonly x: number; readonly y: number } | undefined]> = [
    [edge.startLabel, edge.points[0]],
    [edge.endLabel, edge.points[edge.points.length - 1]],
  ];
  for (const [label, point] of endpoints) {
    if (label === undefined || point === undefined) continue;
    const value = truncateDisplayWidth(label, 12, displayWidth(label) > 12);
    const candidates: Array<readonly [number, number]> = [
      [point.x - displayWidth(value), point.y - 1],
      [point.x + 1, point.y - 1],
      [point.x + 1, point.y + 1],
      [point.x - displayWidth(value), point.y + 1],
    ];
    if (!candidates.some(([x, y]) => canvas.drawTextIfEmpty(x, y, value, "edgeLabel"))) return false;
  }
  return true;
}

function drawGroup(
  canvas: NonNullable<ReturnType<typeof createMermaidCanvas>>,
  group: { readonly x: number; readonly y: number; readonly width: number; readonly height: number; readonly label: string },
): void {
  if (group.width < 3 || group.height < 3) return;
  const right = group.x + group.width - 1;
  const bottom = group.y + group.height - 1;
  canvas.setGlyph(group.x, group.y, "╭", "border");
  canvas.drawText(group.x + 1, group.y, `─ ${truncateDisplayWidth(group.label, Math.max(1, group.width - 5))} `, "title");
  canvas.setGlyph(right, group.y, "╮", "border");
  canvas.setGlyph(group.x, bottom, "╰", "border");
  canvas.setGlyph(right, bottom, "╯", "border");
  for (let x = group.x + 1; x < right; x += 1) {
    canvas.setGlyph(x, bottom, "─", "border");
  }
  for (let y = group.y + 1; y < bottom; y += 1) {
    canvas.setGlyph(group.x, y, "│", "border");
    canvas.setGlyph(right, y, "│", "border");
  }
}

export function renderMermaidDiagram(diagram: MermaidDiagram, width: number): MermaidProjectionResult {
  const normalizedWidth = Math.floor(width);
  if (normalizedWidth <= 0) return { ok: false, reason: "width_limit" };
  if (diagram.kind === "sequence") return renderSequenceDiagram(diagram, normalizedWidth);
  const graph = graphForDiagram(diagram);
  const layoutResult = layoutFlowchart(graph, normalizedWidth);
  if (!layoutResult.ok) return layoutResult;
  if (estimatedGraphDrawOperations(layoutResult.layout) > MERMAID_LIMITS.maxDrawOperations) {
    return { ok: false, reason: "canvas_limit" };
  }
  const canvas = createMermaidCanvas(normalizedWidth, layoutResult.layout.height);
  if (!canvas) return { ok: false, reason: "canvas_limit" };

  for (const group of layoutResult.layout.groups) drawGroup(canvas, group);
  for (const edge of layoutResult.layout.edges) {
    canvas.drawPolyline(edge.points, "edge", edge.style === "dotted" ? 2 : edge.style === "thick" ? 3 : 1);
    drawEndpointMarker(canvas, edge.points[0], edge.startMarker);
    drawEndpointMarker(canvas, edge.points[edge.points.length - 1], edge.endMarker);
    drawArrow(canvas, edge.points[edge.points.length - 1]!, edge.points[edge.points.length - 2], edge.arrow);
  }
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  for (const node of layoutResult.layout.nodes) {
    const source = nodeById.get(node.id);
    if (source) drawNodeBox(canvas, node, source.shape);
  }
  for (const edge of layoutResult.layout.edges) {
    if (!drawEdgeEndpointLabels(canvas, edge)) return { ok: false, reason: "canvas_limit" };
    if (edge.label !== undefined && !drawEdgeLabel(canvas, edge.points, edge.label)) {
      return { ok: false, reason: "canvas_limit" };
    }
  }
  const lines = canvas.toStyledLines();
  return {
    ok: true,
    width: normalizedWidth,
    height: layoutResult.layout.height,
    lines,
    estimatedBytes: canvas.estimatedBytes(lines),
  };
}
