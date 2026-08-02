import {
  RGBA,
  StyledText,
  TextAttributes,
  type TextChunk,
} from "@opentui/core";

interface AnsiStyleState {
  fg?: RGBA;
  bg?: RGBA;
  attributes: number;
}

function applySgr(state: AnsiStyleState, parameters: string): void {
  const codes = (parameters.length === 0 ? [0] : parameters.split(";").map((part) => Number.parseInt(part || "0", 10)));
  for (let index = 0; index < codes.length; index++) {
    const code = codes[index] ?? 0;
    if (code === 0) {
      state.fg = undefined;
      state.bg = undefined;
      state.attributes = TextAttributes.NONE;
    } else if (code === 1) state.attributes |= TextAttributes.BOLD;
    else if (code === 2) state.attributes |= TextAttributes.DIM;
    else if (code === 3) state.attributes |= TextAttributes.ITALIC;
    else if (code === 4) state.attributes |= TextAttributes.UNDERLINE;
    else if (code === 5) state.attributes |= TextAttributes.BLINK;
    else if (code === 7) state.attributes |= TextAttributes.INVERSE;
    else if (code === 9) state.attributes |= TextAttributes.STRIKETHROUGH;
    else if (code === 22) state.attributes &= ~(TextAttributes.BOLD | TextAttributes.DIM);
    else if (code === 23) state.attributes &= ~TextAttributes.ITALIC;
    else if (code === 24) state.attributes &= ~TextAttributes.UNDERLINE;
    else if (code === 25) state.attributes &= ~TextAttributes.BLINK;
    else if (code === 27) state.attributes &= ~TextAttributes.INVERSE;
    else if (code === 29) state.attributes &= ~TextAttributes.STRIKETHROUGH;
    else if (code >= 30 && code <= 37) state.fg = RGBA.fromIndex(code - 30);
    else if (code >= 90 && code <= 97) state.fg = RGBA.fromIndex(code - 90 + 8);
    else if (code >= 40 && code <= 47) state.bg = RGBA.fromIndex(code - 40);
    else if (code >= 100 && code <= 107) state.bg = RGBA.fromIndex(code - 100 + 8);
    else if (code === 39) state.fg = undefined;
    else if (code === 49) state.bg = undefined;
    else if ((code === 38 || code === 48) && codes[index + 1] === 5 && Number.isFinite(codes[index + 2])) {
      const color = RGBA.fromIndex(Math.max(0, Math.min(255, codes[index + 2]!)));
      if (code === 38) state.fg = color;
      else state.bg = color;
      index += 2;
    } else if ((code === 38 || code === 48) && codes[index + 1] === 2 && codes.slice(index + 2, index + 5).every(Number.isFinite)) {
      const color = RGBA.fromInts(codes[index + 2]!, codes[index + 3]!, codes[index + 4]!);
      if (code === 38) state.fg = color;
      else state.bg = color;
      index += 4;
    }
  }
}

function addChunk(chunks: TextChunk[], text: string, state: AnsiStyleState): void {
  const safeText = text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "");
  if (safeText.length === 0) return;
  chunks.push({
    __isChunk: true,
    text: safeText,
    ...(state.fg ? { fg: state.fg } : {}),
    ...(state.bg ? { bg: state.bg } : {}),
    ...(state.attributes !== TextAttributes.NONE ? { attributes: state.attributes } : {}),
  });
}

/**
 * 只接受 SGR 样式；OSC、APC、未知 CSI 和其他 C0 控制字符全部在 renderer 前丢弃。
 */
export function ansiToStyledText(input: string): StyledText {
  const state: AnsiStyleState = { attributes: TextAttributes.NONE };
  const chunks: TextChunk[] = [];
  let offset = 0;
  let plainStart = 0;

  const flushPlain = (end: number): void => {
    if (end > plainStart) addChunk(chunks, input.slice(plainStart, end), state);
  };

  while (offset < input.length) {
    if (input[offset] !== "\x1b") {
      offset++;
      continue;
    }
    flushPlain(offset);
    const kind = input[offset + 1];
    if (kind === "[") {
      const rest = input.slice(offset + 2);
      const finalOffset = rest.search(/[@-~]/u);
      if (finalOffset < 0) {
        offset = input.length;
        plainStart = offset;
        break;
      }
      const final = rest[finalOffset];
      if (final === "m") applySgr(state, rest.slice(0, finalOffset));
      offset += finalOffset + 3;
    } else if (kind === "]" || kind === "_") {
      const bel = input.indexOf("\x07", offset + 2);
      const st = input.indexOf("\x1b\\", offset + 2);
      const candidates = [bel >= 0 ? bel + 1 : -1, st >= 0 ? st + 2 : -1].filter((value) => value >= 0);
      offset = candidates.length > 0 ? Math.min(...candidates) : input.length;
    } else {
      offset += 2;
    }
    plainStart = offset;
  }
  flushPlain(input.length);
  return new StyledText(chunks);
}
