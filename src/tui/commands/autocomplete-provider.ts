import type { AutocompleteProvider } from "../index.ts";
import type { CommandSuggestionView } from "../presentation/types.ts";

export type CommandSuggestionSource = () => readonly CommandSuggestionView[];

/**
 * 把 command registry 的只读快照接到 Editor 原生 autocomplete。
 *
 * 返回给 Editor 的 prefix 故意不含 `/`:Enter 只接受补全并更新 draft,
 * 第二次 Enter 才进入 command execution funnel。
 */
export function createCommandAutocompleteProvider(
  source: CommandSuggestionSource,
): AutocompleteProvider {
  return {
    getSuggestions: async (lines, cursorLine, cursorCol, options) => {
      if (options.signal.aborted) return null;
      const line = lines[cursorLine] ?? "";
      const beforeCursor = line.slice(0, cursorCol);
      const match = /^\/([^\s]*)$/u.exec(beforeCursor);
      if (!match) return null;
      const prefix = match[1] ?? "";
      const query = prefix.toLowerCase();
      const items = source().flatMap((suggestion) => {
        const searchable = [
          suggestion.canonicalName,
          suggestion.label,
          suggestion.description,
        ].join(" ").toLowerCase();
        if (query && !searchable.includes(query)) return [];
        return [{
          value: suggestion.canonicalName,
          label: suggestion.label,
          description: suggestion.disabledReason ?? suggestion.description,
        }];
      });
      return items.length > 0 ? { items, prefix } : null;
    },
    applyCompletion: (lines, cursorLine, cursorCol, item, prefix) => {
      const nextLines = [...lines];
      const line = nextLines[cursorLine] ?? "";
      const tokenStart = cursorCol - prefix.length - 1;
      if (tokenStart < 0 || line.slice(tokenStart, cursorCol) !== `/${prefix}`) {
        return { lines: nextLines, cursorLine, cursorCol };
      }
      const completion = `/${item.value}`;
      nextLines[cursorLine] = `${line.slice(0, tokenStart)}${completion}${line.slice(cursorCol)}`;
      return {
        lines: nextLines,
        cursorLine,
        cursorCol: tokenStart + completion.length,
      };
    },
  };
}
