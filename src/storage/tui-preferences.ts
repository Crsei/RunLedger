/** canonical RunledgerLayout.state 下的本地 TUI preference store。 */

import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import type { RunledgerLayout } from "../runtime/contracts/storage-layout.ts";
import {
  createDefaultTuiPreferences,
  type TuiPreferencesDocument,
  type TuiPreferencesLoadResult,
  type TuiPreferencesSaveResult,
} from "../tui/preferences/types.ts";

const FILE_NAME = "tui-preferences.json";
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;

export { createDefaultTuiPreferences } from "../tui/preferences/types.ts";

export async function loadTuiPreferences(layout: RunledgerLayout): Promise<TuiPreferencesLoadResult> {
  try {
    const raw = await readFile(preferencesPath(layout), "utf8");
    return parsePreferences(raw);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return { preferences: createDefaultTuiPreferences() };
    return {
      preferences: createDefaultTuiPreferences(),
      diagnostic: { code: "tui_preferences_read_failed" },
    };
  }
}

export async function saveTuiPreferences(
  layout: RunledgerLayout,
  next: TuiPreferencesDocument,
): Promise<TuiPreferencesSaveResult> {
  const target = preferencesPath(layout);
  let release: (() => Promise<void>) | undefined;
  try {
    await mkdir(layout.state, { recursive: true, mode: DIRECTORY_MODE });
    const stateMetadata = await lstat(layout.state);
    if (stateMetadata.isSymbolicLink()) throw new Error("TUI preference state directory may not be a symlink");
    const canonicalState = await realpath(layout.state);
    const canonicalHome = await realpath(layout.home);
    if (canonicalState !== join(canonicalHome, "state")) {
      throw new Error("TUI preference state directory escapes runledgerHome");
    }
    await chmod(layout.state, DIRECTORY_MODE);
    release = await lockfile.lock(target, {
      realpath: false,
      retries: { retries: 50, factor: 1.25, minTimeout: 10, maxTimeout: 100 },
      stale: 30_000,
    });
    const document = sanitizePreferences(next);
    const temporary = join(layout.state, `.${FILE_NAME}.${randomUUID()}.tmp`);
    await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, {
      flag: "wx",
      mode: FILE_MODE,
    });
    try {
      await rename(temporary, target);
      await chmod(target, FILE_MODE);
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
    return { ok: true };
  } catch {
    return { ok: false, code: "tui_preferences_save_failed" };
  } finally {
    await release?.().catch(() => undefined);
  }
}

function preferencesPath(layout: RunledgerLayout): string {
  return join(layout.state, FILE_NAME);
}

function parsePreferences(raw: string): TuiPreferencesLoadResult {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return {
      preferences: createDefaultTuiPreferences(),
      diagnostic: { code: "invalid_tui_preferences" },
    };
  }
  if (!isRecord(value)) {
    return {
      preferences: createDefaultTuiPreferences(),
      diagnostic: { code: "invalid_tui_preferences" },
    };
  }
  if (value.version !== 1) {
    return {
      preferences: createDefaultTuiPreferences(),
      diagnostic: { code: "unsupported_tui_preferences_version" },
    };
  }
  const transcript = value.transcript;
  if (!isRecord(transcript) || (transcript.scrollbar !== "hidden" && transcript.scrollbar !== "visible")) {
    return {
      preferences: createDefaultTuiPreferences(),
      diagnostic: { code: "invalid_tui_preferences" },
    };
  }
  return { preferences: sanitizePreferences(value as unknown as TuiPreferencesDocument) };
}

function sanitizePreferences(value: TuiPreferencesDocument): TuiPreferencesDocument {
  return {
    version: 1,
    transcript: {
      scrollbar: value.transcript?.scrollbar === "visible" ? "visible" : "hidden",
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
