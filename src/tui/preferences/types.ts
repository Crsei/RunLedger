/** 本地 TUI presentation preference；不包含 Session 或滚动位置。 */
export interface TuiPreferencesDocument {
  readonly version: 1;
  readonly transcript: {
    readonly scrollbar: "hidden" | "visible";
  };
}

export type TuiPreferencesDiagnosticCode =
  | "invalid_tui_preferences"
  | "unsupported_tui_preferences_version"
  | "tui_preferences_read_failed";

export interface TuiPreferencesLoadResult {
  readonly preferences: TuiPreferencesDocument;
  readonly diagnostic?: { readonly code: TuiPreferencesDiagnosticCode };
}

export type TuiPreferencesSaveResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: "tui_preferences_save_failed" };

/** CLI composition 注入的唯一持久化端口；TUI 不拥有路径或文件系统。 */
export interface TuiPreferencesPort {
  load(): Promise<TuiPreferencesLoadResult>;
  save(next: TuiPreferencesDocument): Promise<TuiPreferencesSaveResult>;
}

export function createDefaultTuiPreferences(): TuiPreferencesDocument {
  return { version: 1, transcript: { scrollbar: "hidden" } };
}
