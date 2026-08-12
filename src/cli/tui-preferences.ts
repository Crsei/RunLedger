/** CLI composition 对本地 TUI preference 的单次加载与进程级 snapshot。 */

import type { RunledgerLayout } from "../runtime/contracts/storage-layout.ts";
import { loadTuiPreferences, saveTuiPreferences } from "../storage/tui-preferences.ts";
import type {
  TuiPreferencesDocument,
  TuiPreferencesLoadResult,
  TuiPreferencesPort,
} from "../tui/preferences/types.ts";

export interface CliTuiPreferencesComposition {
  current(): TuiPreferencesDocument;
  readonly port: TuiPreferencesPort;
  readonly startupDiagnostic?: TuiPreferencesLoadResult["diagnostic"];
}

export async function createCliTuiPreferences(
  layout: RunledgerLayout,
): Promise<CliTuiPreferencesComposition> {
  const loaded = await loadTuiPreferences(layout);
  let current = loaded.preferences;
  const port: TuiPreferencesPort = {
    load: async () => ({ preferences: current }),
    save: async (next) => {
      current = next;
      const result = await saveTuiPreferences(layout, next);
      return result;
    },
  };
  return {
    current: () => current,
    port,
    ...(loaded.diagnostic === undefined ? {} : { startupDiagnostic: loaded.diagnostic }),
  };
}
