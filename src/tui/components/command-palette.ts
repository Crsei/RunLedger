import type { CommandSuggestionView } from "../presentation/types.ts";
import type { SelectItem } from "../index.ts";
import { SearchableSelectorModal } from "./searchable-selector-modal.ts";

export interface CommandPaletteOptions {
  suggestions: readonly CommandSuggestionView[];
  title?: string;
  onSelect(command: string): void;
  onCancel(): void;
}

export class CommandPalette extends SearchableSelectorModal {
  constructor(options: CommandPaletteOptions) {
    const byName = new Map(options.suggestions.map((suggestion) => [suggestion.canonicalName, suggestion]));
    const items: SelectItem[] = options.suggestions.map((suggestion) => ({
      value: suggestion.canonicalName,
      label: suggestion.label,
      description: suggestion.disabledReason ?? suggestion.description,
    }));
    super({
      title: options.title ?? "/commands",
      items,
      onSelect: (item) => {
        const suggestion = byName.get(item.value);
        if (suggestion?.disabledReason) return;
        options.onSelect(`/${item.value}`);
      },
      onCancel: options.onCancel,
    });
  }
}
