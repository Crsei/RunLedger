import stringWidth from "string-width";

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function graphemes(value: string): readonly string[] {
  return Array.from(graphemeSegmenter.segment(value), (part) => part.segment);
}

export function displayWidth(value: string): number {
  return Math.max(0, stringWidth(value));
}

export function wrapDisplayWidth(value: string, width: number, maxLines: number): readonly string[] {
  const boundedWidth = Math.max(1, Math.floor(width));
  const boundedLines = Math.max(1, Math.floor(maxLines));
  const output: string[] = [];
  let current = "";
  let currentWidth = 0;

  const flush = (): void => {
    output.push(current);
    current = "";
    currentWidth = 0;
  };

  const normalized = value.replace(/[\u0000-\u0009\u000b-\u001f\u007f]/gu, " ");
  for (const sourceLine of normalized.split("\n")) {
    if (output.length >= boundedLines) break;
    if (sourceLine.length === 0) {
      flush();
      continue;
    }
    for (const grapheme of graphemes(sourceLine)) {
      if (output.length >= boundedLines) break;
      const graphemeWidth = displayWidth(grapheme);
      if (graphemeWidth === 0) {
        current += grapheme;
        continue;
      }
      if (currentWidth > 0 && currentWidth + graphemeWidth > boundedWidth) flush();
      if (output.length >= boundedLines) break;
      current += grapheme;
      currentWidth += graphemeWidth;
    }
    if (output.length < boundedLines) flush();
  }
  if (output.length < boundedLines && (current.length > 0 || output.length === 0)) flush();

  if (output.length > boundedLines) output.length = boundedLines;
  if (output.length === boundedLines && graphemes(value).length > 0) {
    const last = output[output.length - 1] ?? "";
    if (displayWidth(last) >= boundedWidth) {
      output[output.length - 1] = truncateDisplayWidth(last, boundedWidth, true);
    }
  }
  return output;
}

export function truncateDisplayWidth(value: string, width: number, ellipsis = false): string {
  const boundedWidth = Math.max(0, Math.floor(width));
  const suffix = ellipsis && boundedWidth > 0 ? "…" : "";
  const suffixWidth = displayWidth(suffix);
  const target = Math.max(0, boundedWidth - suffixWidth);
  let result = "";
  let used = 0;
  for (const grapheme of graphemes(value)) {
    const next = displayWidth(grapheme);
    if (used + next > target) break;
    result += grapheme;
    used += next;
  }
  return `${result}${suffixWidth > 0 && used < displayWidth(value) ? suffix : ""}`;
}
