export function normalizedLines(source: string): string[] {
  return source.replace(/\r\n?/gu, "\n").split("\n");
}

export function cleanMermaidText(value: string): string {
  const entities: Record<string, string> = {
    "&amp;": "&",
    "&lt;": "<",
    "&gt;": ">",
    "&quot;": '"',
    "&#39;": "'",
  };
  return value
    .replace(/&(amp|lt|gt|quot|#39);/gu, (entity) => entities[entity] ?? entity)
    .replace(/<br\s*\/?>(?=\S)/giu, " ")
    .replace(/(\*\*|__|~~|[*_])/gu, "")
    .replace(/^\s*"|"\s*$/gu, "")
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .trim();
}

export function isComment(line: string): boolean {
  return line.trim().startsWith("%%");
}

export function validIdentifier(value: string): boolean {
  return value === "[*]" || /^[^\s{}:]+$/u.test(value);
}

export function unquote(value: string): string {
  const trimmed = value.trim();
  return trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')
    ? trimmed.slice(1, -1)
    : trimmed;
}
