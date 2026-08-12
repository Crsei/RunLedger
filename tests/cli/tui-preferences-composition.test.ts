import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildRunledgerLayout } from "../../src/runtime/contracts/storage-layout.ts";
import { saveTuiPreferences } from "../../src/storage/tui-preferences.ts";
import { canCreateSymlink } from "../helpers/platform.ts";

const CAN_SYMLINK = canCreateSymlink();

interface CliPreferencesComposition {
  current(): {
    readonly version: 1;
    readonly transcript: { readonly scrollbar: "hidden" | "visible" };
  };
  readonly port: {
    save(next: {
      readonly version: 1;
      readonly transcript: { readonly scrollbar: "hidden" | "visible" };
    }): Promise<{ readonly ok: boolean }>;
  };
  readonly startupDiagnostic?: { readonly code: string };
}

async function compositionModule(): Promise<{
  createCliTuiPreferences(
    layout: ReturnType<typeof buildRunledgerLayout>,
  ): Promise<CliPreferencesComposition>;
}> {
  const modulePath = "../../src/cli/tui-preferences.ts";
  return import(modulePath) as Promise<{
    createCliTuiPreferences(
      layout: ReturnType<typeof buildRunledgerLayout>,
    ): Promise<CliPreferencesComposition>;
  }>;
}

describe("CLI TUI preference composition", () => {
  it("loads once and shares the latest process snapshot across Session views", async () => {
    const root = await mkdtemp(join(tmpdir(), "runledger-cli-tui-preferences-"));
    try {
      const layout = buildRunledgerLayout(join(root, "home"), "posix");
      await saveTuiPreferences(layout, { version: 1, transcript: { scrollbar: "visible" } });
      const { createCliTuiPreferences } = await compositionModule();
      const composition = await createCliTuiPreferences(layout);

      expect(composition.current().transcript.scrollbar).toBe("visible");
      expect(await composition.port.save({
        version: 1,
        transcript: { scrollbar: "hidden" },
      })).toEqual({ ok: true });
      expect(composition.current().transcript.scrollbar).toBe("hidden");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps the latest process snapshot when persistence fails", { skip: !CAN_SYMLINK }, async () => {
    const root = await mkdtemp(join(tmpdir(), "runledger-cli-tui-preferences-"));
    try {
      const layout = buildRunledgerLayout(join(root, "home"), "posix");
      const { createCliTuiPreferences } = await compositionModule();
      const composition = await createCliTuiPreferences(layout);
      const outside = join(root, "outside");
      await mkdir(layout.home, { recursive: true });
      await mkdir(outside, { recursive: true });
      await symlink(outside, layout.state);

      expect(await composition.port.save({
        version: 1,
        transcript: { scrollbar: "visible" },
      })).toEqual({ ok: false, code: "tui_preferences_save_failed" });
      expect(composition.current().transcript.scrollbar).toBe("visible");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("exposes only a bounded startup diagnostic for a damaged document", async () => {
    const root = await mkdtemp(join(tmpdir(), "runledger-cli-tui-preferences-"));
    try {
      const layout = buildRunledgerLayout(join(root, "home"), "posix");
      await mkdir(layout.state, { recursive: true });
      await writeFile(join(layout.state, "tui-preferences.json"), "{ secret-invalid-json", "utf8");
      const { createCliTuiPreferences } = await compositionModule();
      const composition = await createCliTuiPreferences(layout);

      expect(composition.current().transcript.scrollbar).toBe("hidden");
      expect(composition.startupDiagnostic).toEqual({ code: "invalid_tui_preferences" });
      expect(JSON.stringify(composition)).not.toContain("secret-invalid-json");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
