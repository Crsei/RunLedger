import type { Component } from "../index.ts";
import { matchesKey } from "../index.ts";
import {
  providerModelKey,
  type ProviderWorkflowState,
} from "../providers/types.ts";
import { fitLinesToWidth } from "./render-width.ts";

export interface ProviderPickerCallbacks {
  onSearch(query: string): void;
  onHighlightProvider(providerId: string, generation: number): void;
  onHighlightModel(providerId: string, modelKey: string, generation: number): void;
  onSelectProvider(providerId: string, generation: number): void;
  onSelectModel(providerId: string, modelKey: string, generation: number): void;
  onCancel(): void;
}

export class ProviderPickerComponent implements Component {
  private state: ProviderWorkflowState;
  private readonly callbacks: ProviderPickerCallbacks;

  constructor(state: ProviderWorkflowState, callbacks: ProviderPickerCallbacks) {
    this.state = state;
    this.callbacks = callbacks;
  }

  setState(state: ProviderWorkflowState): void {
    this.state = state;
  }

  invalidate(): void {}

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
      if (this.state.state !== "applying-selection") this.callbacks.onCancel();
      return;
    }
    if (this.state.state === "choosing-provider") {
      const statuses = filteredProviders(this.state);
      const selectedIndex = providerIndex(this.state, statuses);
      if (matchesKey(data, "up") || matchesKey(data, "down")) {
        const next = wrappedIndex(selectedIndex, statuses.length, matchesKey(data, "down") ? 1 : -1);
        const selected = statuses[next];
        if (selected) this.callbacks.onHighlightProvider(selected.id, this.state.generation);
        return;
      }
      if (matchesKey(data, "enter")) {
        const selected = statuses[selectedIndex];
        if (selected) {
          this.callbacks.onSelectProvider(selected.id, this.state.generation);
        }
        return;
      }
      this.handleSearchInput(data, this.state.query);
      return;
    }
    if (this.state.state === "choosing-model") {
      const models = filteredModels(this.state);
      const selectedIndex = modelIndex(this.state, models);
      if (matchesKey(data, "up") || matchesKey(data, "down")) {
        const next = wrappedIndex(selectedIndex, models.length, matchesKey(data, "down") ? 1 : -1);
        const selected = models[next];
        if (selected) {
          this.callbacks.onHighlightModel(
            this.state.providerId,
            providerModelKey(selected),
            this.state.generation,
          );
        }
        return;
      }
      if (matchesKey(data, "enter")) {
        const selected = models[selectedIndex];
        if (selected) {
          this.callbacks.onSelectModel(
            this.state.providerId,
            providerModelKey(selected),
            this.state.generation,
          );
        }
        return;
      }
      this.handleSearchInput(data, this.state.query);
    }
  }

  render(width: number): string[] {
    const lines = ["/provider — typed workflow"];
    if (this.state.state === "idle") lines.push("  Provider workflow is idle");
    else if (this.state.state === "loading-providers") lines.push("  Loading provider status…");
    else if (this.state.state === "loading-models") {
      lines.push(`  Loading models for ${this.state.providerId}…`);
    } else if (this.state.state === "applying-selection") {
      lines.push(`  Applying ${this.state.modelKey}…`);
    } else if (this.state.state === "failed") {
      lines.push(`  ✗ ${this.state.message}`, "  Esc close");
    } else if (this.state.state === "cancelled") {
      lines.push(`  ⊘ ${this.state.reason}`);
    } else if (this.state.state === "choosing-provider") {
      lines.push(`/ ${this.state.query}`);
      const statuses = filteredProviders(this.state);
      const selectedIndex = providerIndex(this.state, statuses);
      const start = visibleStart(selectedIndex, statuses.length);
      for (let index = start; index < Math.min(statuses.length, start + 12); index++) {
        const status = statuses[index]!;
        const description = status.configured
          ? `configured${status.source ? ` · ${status.source}` : ""}`
          : status.interactiveAuthTypes.length > 0
            ? `login: ${status.interactiveAuthTypes.join("/")}`
            : "ambient credential required";
        lines.push(`${index === selectedIndex ? "→" : " "} ${status.name}  ${status.id}  ${description}`);
      }
      appendSelectionFooter(lines, selectedIndex, statuses.length, "provider");
    } else {
      lines.push(`/ ${this.state.query}`);
      const models = filteredModels(this.state);
      const selectedIndex = modelIndex(this.state, models);
      const start = visibleStart(selectedIndex, models.length);
      for (let index = start; index < Math.min(models.length, start + 12); index++) {
        const model = models[index]!;
        lines.push(
          `${index === selectedIndex ? "→" : " "} ${model.id}  [${model.provider}] ${model.name ?? ""}`,
        );
      }
      appendSelectionFooter(lines, selectedIndex, models.length, "model");
    }
    return fitLinesToWidth(lines, width);
  }

  private handleSearchInput(data: string, query: string): void {
    if (matchesKey(data, "backspace")) {
      this.callbacks.onSearch(Array.from(query).slice(0, -1).join(""));
    } else if (!/[\u0000-\u001f\u007f]/u.test(data)) {
      this.callbacks.onSearch(query + data);
    }
  }
}

function filteredProviders(
  state: Extract<ProviderWorkflowState, { state: "choosing-provider" }>,
) {
  const query = state.query.trim().toLocaleLowerCase();
  if (!query) return state.statuses;
  return state.statuses.filter((status) =>
    `${status.id} ${status.name} ${status.source ?? ""}`.toLocaleLowerCase().includes(query)
  );
}

function providerIndex(
  state: Extract<ProviderWorkflowState, { state: "choosing-provider" }>,
  statuses: ReturnType<typeof filteredProviders>,
): number {
  const index = statuses.findIndex((status) => status.id === state.selectedProviderId);
  return index >= 0 ? index : 0;
}

function filteredModels(
  state: Extract<ProviderWorkflowState, { state: "choosing-model" }>,
) {
  const query = state.query.trim().toLocaleLowerCase();
  if (!query) return state.models;
  return state.models.filter((model) =>
    `${model.id} ${model.provider} ${model.name ?? ""}`.toLocaleLowerCase().includes(query)
  );
}

function modelIndex(
  state: Extract<ProviderWorkflowState, { state: "choosing-model" }>,
  models: ReturnType<typeof filteredModels>,
): number {
  const index = models.findIndex((model) =>
    providerModelKey(model) === state.selectedModelKey
  );
  return index >= 0 ? index : 0;
}

function wrappedIndex(index: number, length: number, delta: number): number {
  if (length === 0) return 0;
  return (index + delta + length) % length;
}

function appendSelectionFooter(
  lines: string[],
  selectedIndex: number,
  length: number,
  kind: string,
): void {
  if (length === 0) lines.push(`  No matching ${kind}s`);
  else lines.push(`  (${selectedIndex + 1}/${length})  Enter select · Esc cancel`);
}

function visibleStart(selectedIndex: number, length: number): number {
  return Math.max(0, Math.min(selectedIndex - 6, Math.max(0, length - 12)));
}
