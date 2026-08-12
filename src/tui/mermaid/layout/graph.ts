import { MERMAID_LIMITS } from "../limits.ts";
import { displayWidth, wrapDisplayWidth } from "../display-width.ts";
import type {
  MermaidFallbackReason,
  MermaidFlowDirection,
  MermaidFlowchartDiagram,
  MermaidFlowchartGroup,
} from "../types.ts";

export interface MermaidPoint {
  readonly x: number;
  readonly y: number;
}

export interface MermaidNodeLayout {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly labelLines: readonly string[];
}

export interface MermaidEdgeLayout {
  readonly from: string;
  readonly to: string;
  readonly points: readonly MermaidPoint[];
  readonly label?: string;
  readonly style: "solid" | "dotted" | "thick";
  readonly arrow: "none" | "arrow" | "circle" | "cross";
  readonly startMarker?: string;
  readonly endMarker?: string;
  readonly startLabel?: string;
  readonly endLabel?: string;
}

export interface MermaidGroupLayout {
  readonly id: string;
  readonly label: string;
  readonly depth: number;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface MermaidFlowchartLayout {
  readonly width: number;
  readonly height: number;
  readonly nodes: readonly MermaidNodeLayout[];
  readonly edges: readonly MermaidEdgeLayout[];
  readonly groups: readonly MermaidGroupLayout[];
}

export type MermaidLayoutResult =
  | { readonly ok: true; readonly layout: MermaidFlowchartLayout }
  | { readonly ok: false; readonly reason: MermaidFallbackReason };

function nodeLabelLines(node: MermaidFlowchartDiagram["nodes"][number]): readonly string[] {
  if (node.displayLines !== undefined) {
    return node.displayLines.map((line) => wrapDisplayWidth(line, MERMAID_LIMITS.labelWrapWidth, 1)[0] ?? "");
  }
  return wrapDisplayWidth(node.label, MERMAID_LIMITS.labelWrapWidth, MERMAID_LIMITS.labelWrapLines);
}

function nodeSize(labelLines: readonly string[]): { readonly width: number; readonly height: number } {
  const labelWidth = Math.min(
    MERMAID_LIMITS.labelWidth,
    Math.max(1, ...labelLines.map((line) => displayWidth(line))),
  );
  return { width: labelWidth + 4, height: Math.max(3, labelLines.length + 2) };
}

function calculateRanks(diagram: MermaidFlowchartDiagram): Map<string, number> {
  const ranks = new Map<string, number>(diagram.nodes.map((node) => [node.id, 0]));
  const indegree = new Map<string, number>(diagram.nodes.map((node) => [node.id, 0]));
  const outgoing = new Map<string, string[]>(diagram.nodes.map((node) => [node.id, []]));
  for (const edge of diagram.edges) {
    indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
    outgoing.get(edge.from)?.push(edge.to);
  }
  const queue = diagram.nodes.filter((node) => (indegree.get(node.id) ?? 0) === 0).map((node) => node.id);
  const processed = new Set<string>();
  while (queue.length > 0) {
    const current = queue.shift()!;
    processed.add(current);
    for (const next of outgoing.get(current) ?? []) {
      ranks.set(next, Math.max(ranks.get(next) ?? 0, (ranks.get(current) ?? 0) + 1));
      const nextIndegree = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, nextIndegree);
      if (nextIndegree === 0) queue.push(next);
    }
  }
  // Cyclic components have no topological seed. Use stable declaration order as
  // a bounded fallback rank so state diagrams do not collapse every lane onto
  // the same column and route their edges through node boxes.
  for (const node of diagram.nodes) {
    if (!processed.has(node.id)) ranks.set(node.id, node.order);
  }
  return ranks;
}

function reversePrimaryAxis(
  direction: MermaidFlowDirection,
  width: number,
  height: number,
  nodes: MermaidNodeLayout[],
): void {
  if (direction === "BT") {
    for (let index = 0; index < nodes.length; index += 1) {
      const node = nodes[index]!;
      nodes[index] = { ...node, y: height - node.y - node.height };
    }
  }
  if (direction === "RL") {
    for (let index = 0; index < nodes.length; index += 1) {
      const node = nodes[index]!;
      nodes[index] = { ...node, x: width - node.x - node.width };
    }
  }
}

function frameForGroup(group: MermaidFlowchartGroup, nodes: readonly MermaidNodeLayout[]): MermaidGroupLayout | undefined {
  const members = nodes.filter((node) => group.nodeIds.includes(node.id));
  if (members.length === 0) return undefined;
  const left = Math.min(...members.map((node) => node.x)) - 2;
  const top = Math.min(...members.map((node) => node.y)) - 2;
  const right = Math.max(...members.map((node) => node.x + node.width)) + 2;
  const bottom = Math.max(...members.map((node) => node.y + node.height)) + 2;
  return {
    id: group.id,
    label: group.label,
    depth: group.depth,
    x: Math.max(0, left),
    y: Math.max(0, top),
    width: right - Math.max(0, left),
    height: bottom - Math.max(0, top),
  };
}

function routeEdge(
  edge: MermaidFlowchartDiagram["edges"][number],
  nodes: ReadonlyMap<string, MermaidNodeLayout>,
  direction: MermaidFlowDirection,
): MermaidEdgeLayout | undefined {
  const from = nodes.get(edge.from);
  const to = nodes.get(edge.to);
  if (!from || !to) return undefined;
  const fromCenter = { x: from.x + Math.floor(from.width / 2), y: from.y + Math.floor(from.height / 2) };
  const toCenter = { x: to.x + Math.floor(to.width / 2), y: to.y + Math.floor(to.height / 2) };
  const vertical = direction === "TD" || direction === "TB" || direction === "BT";
  let points: MermaidPoint[];
  if (vertical) {
    const downward = toCenter.y >= fromCenter.y;
    const start = { x: fromCenter.x, y: downward ? from.y + from.height : from.y - 1 };
    const end = { x: toCenter.x, y: downward ? to.y - 1 : to.y + to.height };
    const middle = Math.floor((start.y + end.y) / 2);
    points = [start, { x: start.x, y: middle }, { x: end.x, y: middle }, end];
  } else {
    const rightward = toCenter.x >= fromCenter.x;
    const start = { x: rightward ? from.x + from.width : from.x - 1, y: fromCenter.y };
    const end = { x: rightward ? to.x - 1 : to.x + to.width, y: toCenter.y };
    const middle = Math.floor((start.x + end.x) / 2);
    points = [start, { x: middle, y: start.y }, { x: middle, y: end.y }, end];
  }
  return {
    from: edge.from,
    to: edge.to,
    points,
    ...(edge.label === undefined ? {} : { label: edge.label }),
    style: edge.style,
    arrow: edge.arrow,
    ...(edge.startMarker === undefined ? {} : { startMarker: edge.startMarker }),
    ...(edge.endMarker === undefined ? {} : { endMarker: edge.endMarker }),
    ...(edge.startLabel === undefined ? {} : { startLabel: edge.startLabel }),
    ...(edge.endLabel === undefined ? {} : { endLabel: edge.endLabel }),
  };
}

export function layoutFlowchart(diagram: MermaidFlowchartDiagram, availableWidth: number): MermaidLayoutResult {
  const widthLimit = Math.max(1, Math.floor(availableWidth));
  const ranks = calculateRanks(diagram);
  const rankValues = [...new Set(diagram.nodes.map((node) => ranks.get(node.id) ?? 0))].sort((left, right) => left - right);
  const rankNodes = rankValues.map((rank) => diagram.nodes.filter((node) => (ranks.get(node.id) ?? 0) === rank));
  const nodeLayouts: MermaidNodeLayout[] = [];
  const nodeSizes = new Map<string, { readonly width: number; readonly height: number; readonly labelLines: readonly string[] }>();
  for (const node of diagram.nodes) {
    const labelLines = nodeLabelLines(node);
    nodeSizes.set(node.id, { ...nodeSize(labelLines), labelLines });
  }

  const vertical = diagram.direction === "TD" || diagram.direction === "TB" || diagram.direction === "BT";
  const gap = 4;
  let canvasWidth = 0;
  let canvasHeight = 0;
  if (vertical) {
    const rowWidths = rankNodes.map((row) => row.reduce((total, node, index) => total + (nodeSizes.get(node.id)?.width ?? 1) + (index === 0 ? 0 : gap), 0));
    canvasWidth = Math.max(1, ...rowWidths) + 2;
    let y = 1;
    for (let rowIndex = 0; rowIndex < rankNodes.length; rowIndex += 1) {
      const row = rankNodes[rowIndex]!;
      const rowWidth = rowWidths[rowIndex]!;
      let x = 1 + Math.floor((canvasWidth - 2 - rowWidth) / 2);
      const rowHeight = Math.max(...row.map((node) => nodeSizes.get(node.id)?.height ?? 1));
      for (const node of row) {
        const size = nodeSizes.get(node.id)!;
        nodeLayouts.push({ id: node.id, x, y, width: size.width, height: size.height, labelLines: size.labelLines });
        x += size.width + gap;
      }
      y += rowHeight + 3;
    }
    canvasHeight = Math.max(1, y);
  } else {
    const columnHeights = rankNodes.map((column) => column.reduce((total, node, index) => total + (nodeSizes.get(node.id)?.height ?? 1) + (index === 0 ? 0 : 2), 0));
    canvasHeight = Math.max(1, ...columnHeights) + 2;
    let x = 1;
    for (let columnIndex = 0; columnIndex < rankNodes.length; columnIndex += 1) {
      const column = rankNodes[columnIndex]!;
      const columnWidth = Math.max(...column.map((node) => nodeSizes.get(node.id)?.width ?? 1));
      let y = 1 + Math.floor((canvasHeight - 2 - columnHeights[columnIndex]!) / 2);
      for (const node of column) {
        const size = nodeSizes.get(node.id)!;
        nodeLayouts.push({ id: node.id, x, y, width: size.width, height: size.height, labelLines: size.labelLines });
        y += size.height + 2;
      }
      x += columnWidth + gap;
    }
    canvasWidth = Math.max(1, x);
  }

  if (canvasWidth > widthLimit) return { ok: false, reason: "width_limit" };
  if (canvasWidth > Math.floor(MERMAID_LIMITS.maxCanvasCells / Math.max(1, canvasHeight))) return { ok: false, reason: "canvas_limit" };
  reversePrimaryAxis(diagram.direction, canvasWidth, canvasHeight, nodeLayouts);
  const nodeMap = new Map(nodeLayouts.map((node) => [node.id, node]));
  const edgeLayouts: MermaidEdgeLayout[] = [];
  for (const edge of diagram.edges) {
    const routed = routeEdge(edge, nodeMap, diagram.direction);
    if (!routed) return { ok: false, reason: "malformed_source" };
    edgeLayouts.push(routed);
  }
  const groups = diagram.groups
    .map((group) => frameForGroup(group, nodeLayouts))
    .filter((group): group is MermaidGroupLayout => group !== undefined)
    .sort((left, right) => right.depth - left.depth || left.y - right.y || left.x - right.x);
  return { ok: true, layout: { width: canvasWidth, height: canvasHeight, nodes: nodeLayouts, edges: edgeLayouts, groups } };
}
