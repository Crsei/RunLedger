export type MarkdownProjectionMode = "markdown" | "plain-text";

export type MarkdownProjectionReason =
  | "streaming-character-limit"
  | "streaming-line-limit"
  | "open-fence-limit";

export interface MarkdownStreamingBudget {
  readonly maxStreamingCharacters?: number;
  readonly maxStreamingLines?: number;
  readonly maxOpenFenceCharacters?: number;
}

export interface MarkdownProjectionDecision {
  readonly mode: MarkdownProjectionMode;
  readonly reason?: MarkdownProjectionReason;
  readonly openFence: boolean;
  readonly characters: number;
  readonly lines: number;
}

const DEFAULT_BUDGET: Required<MarkdownStreamingBudget> = {
  maxStreamingCharacters: 64 * 1024,
  maxStreamingLines: 4_096,
  maxOpenFenceCharacters: 16 * 1024,
};

interface FenceMarker {
  readonly character: "`" | "~";
  readonly length: number;
}

/**
 * 只对正在增长的 Markdown 计算降级策略。
 *
 * 降级不裁剪正文，只改变 presentation adapter 选择；终态可以重新使用
 * MarkdownRenderable。Fence 识别保持有界且只依赖行首标记，避免在压力路径
 * 引入完整 Markdown parser。
 */
export function decideMarkdownProjection(
  text: string,
  streaming: boolean,
  budget: MarkdownStreamingBudget = {},
): MarkdownProjectionDecision {
  const limits = {
    maxStreamingCharacters: normalizeLimit(budget.maxStreamingCharacters, DEFAULT_BUDGET.maxStreamingCharacters),
    maxStreamingLines: normalizeLimit(budget.maxStreamingLines, DEFAULT_BUDGET.maxStreamingLines),
    maxOpenFenceCharacters: normalizeLimit(budget.maxOpenFenceCharacters, DEFAULT_BUDGET.maxOpenFenceCharacters),
  };
  const characters = text.length;
  const lines = countLines(text);

  // 超过字符预算时不再扫描完整 fence 状态；该结果已经确定为纯文本，
  // 避免 1 MiB 单消息在压力路径上再做一次完整 Markdown 前置扫描。
  if (streaming && characters > limits.maxStreamingCharacters) {
    return {
      mode: "plain-text",
      reason: "streaming-character-limit",
      openFence: false,
      characters,
      lines,
    };
  }

  const openFence = findOpenFence(text) !== undefined;

  if (!streaming) return { mode: "markdown", openFence, characters, lines };
  if (lines > limits.maxStreamingLines) {
    return {
      mode: "plain-text",
      reason: "streaming-line-limit",
      openFence,
      characters,
      lines,
    };
  }
  if (openFence && characters > limits.maxOpenFenceCharacters) {
    return {
      mode: "plain-text",
      reason: "open-fence-limit",
      openFence,
      characters,
      lines,
    };
  }
  return { mode: "markdown", openFence, characters, lines };
}

export function markdownFallbackNotice(reason: MarkdownProjectionReason): string {
  switch (reason) {
    case "open-fence-limit":
      return "[plain text fallback: open code fence exceeds streaming budget]";
    case "streaming-line-limit":
      return "[plain text fallback: streaming line budget exceeded]";
    case "streaming-character-limit":
      return "[plain text fallback: streaming character budget exceeded]";
  }
}

function findOpenFence(text: string): FenceMarker | undefined {
  let open: FenceMarker | undefined;
  for (const line of text.split("\n")) {
    const marker = line.match(/^\s*(`{3,}|~{3,})/u)?.[1];
    if (!marker) continue;
    const candidate: FenceMarker = {
      character: marker[0] as "`" | "~",
      length: marker.length,
    };
    if (!open) {
      open = candidate;
      continue;
    }
    if (candidate.character === open.character && candidate.length >= open.length) open = undefined;
  }
  return open;
}

function normalizeLimit(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.floor(value));
}

function countLines(text: string): number {
  if (text.length === 0) return 0;
  let lines = 1;
  for (const character of text) if (character === "\n") lines += 1;
  return lines;
}
