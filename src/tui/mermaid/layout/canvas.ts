import { displayWidth, graphemes } from "../display-width.ts";
import { MERMAID_LIMITS } from "../limits.ts";
import type { MermaidSemanticClass, MermaidStyledLine, MermaidStyledSpan } from "../types.ts";
import type { MermaidPoint } from "./graph.ts";

export const WIDE_GLYPH_SENTINEL = 0xffff_ffff;

const directionBits = {
  up: 1,
  right: 2,
  down: 4,
  left: 8,
} as const;

const semanticCodes: Record<MermaidSemanticClass, number> = {
  border: 1,
  nodeText: 2,
  edge: 3,
  edgeLabel: 4,
  title: 5,
};

function lineGlyph(mask: number, style: number): string {
  if (style === 2) {
    if ((mask & (directionBits.left | directionBits.right)) !== 0 && (mask & (directionBits.up | directionBits.down)) === 0) return "┄";
    if ((mask & (directionBits.up | directionBits.down)) !== 0 && (mask & (directionBits.left | directionBits.right)) === 0) return "┊";
  }
  if (style === 3) {
    if ((mask & (directionBits.left | directionBits.right)) !== 0 && (mask & (directionBits.up | directionBits.down)) === 0) return "━";
    if ((mask & (directionBits.up | directionBits.down)) !== 0 && (mask & (directionBits.left | directionBits.right)) === 0) return "┃";
  }
  switch (mask) {
    case directionBits.left | directionBits.right: return "─";
    case directionBits.up | directionBits.down: return "│";
    case directionBits.right | directionBits.down: return "┌";
    case directionBits.left | directionBits.down: return "┐";
    case directionBits.right | directionBits.up: return "└";
    case directionBits.left | directionBits.up: return "┘";
    case directionBits.left | directionBits.right | directionBits.down: return "┬";
    case directionBits.left | directionBits.right | directionBits.up: return "┴";
    case directionBits.up | directionBits.down | directionBits.right: return "├";
    case directionBits.up | directionBits.down | directionBits.left: return "┤";
    case directionBits.up | directionBits.right | directionBits.down | directionBits.left: return "┼";
    case directionBits.left: return "─";
    case directionBits.right: return "─";
    case directionBits.up: return "│";
    case directionBits.down: return "│";
    default: return " ";
  }
}

export class MermaidCanvas {
  readonly width: number;
  readonly height: number;
  readonly glyphIndex: Uint32Array;
  readonly semanticClass: Uint8Array;
  readonly directionMask: Uint8Array;
  readonly lineStyle: Uint8Array;
  readonly occupied: Uint8Array;
  readonly glyphs: string[] = [""];
  private readonly glyphLookup = new Map<string, number>([["", 0]]);

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    const cells = width * height;
    this.glyphIndex = new Uint32Array(cells);
    this.semanticClass = new Uint8Array(cells);
    this.directionMask = new Uint8Array(cells);
    this.lineStyle = new Uint8Array(cells);
    this.occupied = new Uint8Array(cells);
  }

  private index(x: number, y: number): number | undefined {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return undefined;
    return y * this.width + x;
  }

  private intern(glyph: string): number {
    const existing = this.glyphLookup.get(glyph);
    if (existing !== undefined) return existing;
    const index = this.glyphs.length;
    this.glyphs.push(glyph);
    this.glyphLookup.set(glyph, index);
    return index;
  }

  setGlyph(x: number, y: number, glyph: string, className: MermaidSemanticClass, occupied = false): void {
    const index = this.index(x, y);
    if (index === undefined || glyph.length === 0) return;
    const width = displayWidth(glyph);
    if (width <= 0 || width > 2) return;
    this.glyphIndex[index] = this.intern(glyph);
    this.semanticClass[index] = semanticCodes[className];
    this.occupied[index] = occupied ? 1 : this.occupied[index];
    if (width === 2) {
      const trailing = this.index(x + 1, y);
      if (trailing !== undefined) {
        this.glyphIndex[trailing] = WIDE_GLYPH_SENTINEL;
        this.semanticClass[trailing] = semanticCodes[className];
        this.occupied[trailing] = occupied ? 1 : this.occupied[trailing];
      }
    }
  }

  setLineCell(x: number, y: number, mask: number, className: MermaidSemanticClass, style: number): void {
    const index = this.index(x, y);
    if (index === undefined) return;
    const nextMask = this.directionMask[index]! | mask;
    this.directionMask[index] = nextMask;
    this.lineStyle[index] = style;
    this.setGlyph(x, y, lineGlyph(nextMask, style), className);
  }

  drawText(x: number, y: number, text: string, className: MermaidSemanticClass, occupied = false): void {
    let column = x;
    for (const grapheme of graphemes(text)) {
      const width = displayWidth(grapheme);
      if (width === 0) continue;
      this.setGlyph(column, y, grapheme, className, occupied);
      column += width;
      if (column >= this.width) break;
    }
  }

  drawTextIfEmpty(x: number, y: number, text: string, className: MermaidSemanticClass): boolean {
    const cells: number[] = [];
    let column = x;
    for (const grapheme of graphemes(text)) {
      const width = displayWidth(grapheme);
      if (width === 0) continue;
      if (column < 0 || column + width > this.width || y < 0 || y >= this.height) return false;
      for (let offset = 0; offset < width; offset += 1) {
        const index = this.index(column + offset, y);
        if (index === undefined || this.occupied[index] !== 0 || this.glyphIndex[index] !== 0 || this.directionMask[index] !== 0) return false;
        cells.push(index);
      }
      column += width;
    }
    this.drawText(x, y, text, className);
    return cells.length > 0;
  }

  drawPolyline(points: readonly MermaidPoint[], className: MermaidSemanticClass, style: number): void {
    for (let index = 1; index < points.length; index += 1) {
      const start = points[index - 1]!;
      const end = points[index]!;
      if (start.x === end.x) {
        const step = end.y >= start.y ? 1 : -1;
        for (let y = start.y; y !== end.y + step; y += step) {
          this.setLineCell(start.x, y, step > 0 ? directionBits.up | directionBits.down : directionBits.down | directionBits.up, className, style);
        }
      } else if (start.y === end.y) {
        const step = end.x >= start.x ? 1 : -1;
        for (let x = start.x; x !== end.x + step; x += step) {
          this.setLineCell(x, start.y, step > 0 ? directionBits.left | directionBits.right : directionBits.right | directionBits.left, className, style);
        }
      }
    }
  }

  toStyledLines(): readonly MermaidStyledLine[] {
    const lines: MermaidStyledLine[] = [];
    for (let y = 0; y < this.height; y += 1) {
      let text = "";
      let column = 0;
      const spans: MermaidStyledSpan[] = [];
      let activeClass: MermaidSemanticClass | undefined;
      let activeStart = 0;
      const closeSpan = (): void => {
        if (activeClass !== undefined && column > activeStart) spans.push({ start: activeStart, end: column, className: activeClass });
        activeClass = undefined;
      };
      for (let x = 0; x < this.width; x += 1) {
        const cell = y * this.width + x;
        if (this.glyphIndex[cell] === WIDE_GLYPH_SENTINEL) continue;
        const glyphIndex = this.glyphIndex[cell]!;
        const glyph = glyphIndex === 0 ? " " : this.glyphs[glyphIndex] ?? " ";
        const className = Object.entries(semanticCodes).find(([, code]) => code === this.semanticClass[cell])?.[0] as MermaidSemanticClass | undefined;
        if (className !== activeClass) {
          closeSpan();
          if (className !== undefined) {
            activeClass = className;
            activeStart = column;
          }
        }
        text += glyph;
        column += displayWidth(glyph);
      }
      closeSpan();
      const trimmed = text.replace(/[ ]+$/u, "");
      const trimmedWidth = displayWidth(trimmed);
      lines.push({
        text: trimmed,
        spans: spans.filter((span) => span.start < trimmedWidth).map((span) => ({ ...span, end: Math.min(span.end, trimmedWidth) })),
      });
    }
    return lines;
  }

  estimatedBytes(lines: readonly MermaidStyledLine[]): number {
    const textBytes = new TextEncoder().encode(lines.map((line) => line.text).join("\n")).byteLength;
    return this.glyphIndex.byteLength
      + this.semanticClass.byteLength
      + this.directionMask.byteLength
      + this.lineStyle.byteLength
      + this.occupied.byteLength
      + this.glyphs.reduce((total, glyph) => total + new TextEncoder().encode(glyph).byteLength, 0)
      + textBytes;
  }
}

export function createMermaidCanvas(width: number, height: number): MermaidCanvas | undefined {
  const normalizedWidth = Math.floor(width);
  const normalizedHeight = Math.floor(height);
  if (normalizedWidth <= 0 || normalizedHeight <= 0) return undefined;
  if (normalizedWidth > Math.floor(MERMAID_LIMITS.maxCanvasCells / normalizedHeight)) return undefined;
  return new MermaidCanvas(normalizedWidth, normalizedHeight);
}
