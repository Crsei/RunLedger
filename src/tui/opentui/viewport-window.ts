export interface ViewportWindowRequest {
  readonly scrollTop: number;
  readonly viewportHeight: number;
  readonly overscan: number;
}

export interface ViewportWindowResult {
  readonly start: number;
  readonly end: number;
  readonly overscanStart: number;
  readonly overscanEnd: number;
}

export interface ScrollAnchor {
  readonly index: number;
  readonly offsetWithin: number;
}

/**
 * 维护 entry 高度前缀和，用于可见窗口定位和 resize 后恢复 scroll anchor。
 * 该索引不负责裁剪原始会话数据，也不持有 OpenTUI renderable。
 */
export class HeightIndex {
  private readonly heights: number[];
  private offsets: number[];

  constructor(heights: readonly number[] = []) {
    this.heights = heights.map(normalizeHeight);
    this.offsets = buildOffsets(this.heights);
  }

  get length(): number {
    return this.heights.length;
  }

  get totalHeight(): number {
    return this.offsets.at(-1) ?? 0;
  }

  getHeight(index: number): number {
    return this.heights[index] ?? 0;
  }

  getOffset(index: number): number {
    if (index <= 0) return 0;
    return this.offsets[Math.min(index, this.heights.length)] ?? this.totalHeight;
  }

  update(index: number, height: number): void {
    if (index < 0 || index >= this.heights.length) return;
    this.heights[index] = normalizeHeight(height);
    this.offsets = buildOffsets(this.heights);
  }

  append(height: number): void {
    this.heights.push(normalizeHeight(height));
    this.offsets = buildOffsets(this.heights);
  }

  findIndexAtOffset(offset: number): number {
    if (this.heights.length === 0) return -1;
    const target = Math.max(0, Math.min(offset, Math.max(0, this.totalHeight - 1)));
    let low = 0;
    let high = this.heights.length - 1;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const start = this.offsets[middle] ?? 0;
      const end = this.offsets[middle + 1] ?? this.totalHeight;
      if (target < start) high = middle - 1;
      else if (target >= end) low = middle + 1;
      else return middle;
    }
    return Math.max(0, Math.min(low, this.heights.length - 1));
  }

  getWindow(request: ViewportWindowRequest): ViewportWindowResult {
    if (this.heights.length === 0) return { start: 0, end: 0, overscanStart: 0, overscanEnd: 0 };
    const top = Math.max(0, request.scrollTop);
    const bottom = Math.max(top, top + Math.max(0, request.viewportHeight));
    const start = this.findIndexAtOffset(top);
    const end = Math.min(this.heights.length, this.findIndexAtOffset(Math.max(top, bottom - 1)) + 1);
    const overscanStart = this.findIndexAtOffset(Math.max(0, top - Math.max(0, request.overscan)));
    const overscanEnd = Math.min(
      this.heights.length,
      this.findIndexAtOffset(Math.min(Math.max(0, this.totalHeight - 1), bottom + Math.max(0, request.overscan))) + 1,
    );
    return { start, end, overscanStart, overscanEnd };
  }

  captureAnchor(index: number, offsetWithin: number): ScrollAnchor {
    return {
      index: Math.max(0, Math.min(index, Math.max(0, this.heights.length - 1))),
      offsetWithin: Math.max(0, offsetWithin),
    };
  }

  restoreAnchor(anchor: ScrollAnchor): number {
    return this.getOffset(anchor.index) + anchor.offsetWithin;
  }
}

function normalizeHeight(value: number): number {
  return Number.isFinite(value) ? Math.max(1, Math.ceil(value)) : 1;
}

function buildOffsets(heights: readonly number[]): number[] {
  const offsets = [0];
  for (const height of heights) offsets.push((offsets.at(-1) ?? 0) + height);
  return offsets;
}
