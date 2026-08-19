import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildRunledgerLayout } from "../../src/runtime/contracts/storage-layout.ts";
import { canCreateSymlink } from "../helpers/platform.ts";

const CAN_SYMLINK = canCreateSymlink();

interface PreferencesModule {
  createDefaultTuiPreferences(): {
    readonly version: 2;
    readonly transcript: { readonly scrollbar: "hidden" | "visible" };
    readonly display: { readonly shimmer: "classic" | "kitt" | "disabled" };
  };
  loadTuiPreferences(layout: ReturnType<typeof buildRunledgerLayout>): Promise<{
    readonly preferences: {
      readonly version: 2;
      readonly transcript: { readonly scrollbar: "hidden" | "visible" };
      readonly display: { readonly shimmer: "classic" | "kitt" | "disabled" };
    };
    readonly diagnostic?: { readonly code: string };
  }>;
  saveTuiPreferences(
    layout: ReturnType<typeof buildRunledgerLayout>,
    next: {
      readonly version: 2;
      readonly transcript: { readonly scrollbar: "hidden" | "visible" };
      readonly display: { readonly shimmer: "classic" | "kitt" | "disabled" };
    },
  ): Promise<{ readonly ok: boolean; readonly code?: string }>;
}

async function preferencesModule(): Promise<PreferencesModule> {
  const modulePath = "../../src/storage/tui-preferences.ts";
  return import(modulePath) as Promise<PreferencesModule>;
}

describe("canonical TUI preferences", () => {
  it("defaults a missing file to a hidden transcript scrollbar", async () => {
    const root = await mkdtemp(join(tmpdir(), "runledger-tui-preferences-"));
    try {
      const module = await preferencesModule();
      const layout = buildRunledgerLayout(join(root, "home"), "posix");
      expect(await module.loadTuiPreferences(layout)).toEqual({
        preferences: module.createDefaultTuiPreferences(),
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("round-trips only the versioned presentation choice with hardened modes", async () => {
    const root = await mkdtemp(join(tmpdir(), "runledger-tui-preferences-"));
    try {
      const module = await preferencesModule();
      const layout = buildRunledgerLayout(join(root, "home"), "posix");
      const next = {
        version: 2 as const,
        transcript: { scrollbar: "visible" as const },
        display: { shimmer: "kitt" as const },
      };
      expect(await module.saveTuiPreferences(layout, next)).toEqual({ ok: true });
      expect(await module.loadTuiPreferences(layout)).toEqual({ preferences: next });
      const target = join(layout.state, "tui-preferences.json");
      expect(JSON.parse(await readFile(target, "utf8"))).toEqual(next);
      if (process.platform !== "win32") {
        expect((await stat(layout.state)).mode & 0o777).toBe(0o700);
        expect((await stat(target)).mode & 0o777).toBe(0o600);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("migrates revision 1 documents in memory with classic shimmer", async () => {
    const root = await mkdtemp(join(tmpdir(), "runledger-tui-preferences-"));
    try {
      const module = await preferencesModule();
      const layout = buildRunledgerLayout(join(root, "home"), "posix");
      await mkdir(layout.state, { recursive: true });
      await writeFile(join(layout.state, "tui-preferences.json"), JSON.stringify({
        version: 1,
        transcript: { scrollbar: "visible" },
      }), "utf8");

      expect(await module.loadTuiPreferences(layout)).toEqual({
        preferences: {
          version: 2,
          transcript: { scrollbar: "visible" },
          display: { shimmer: "classic" },
        },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("falls back to classic for an invalid revision 2 shimmer value", async () => {
    const root = await mkdtemp(join(tmpdir(), "runledger-tui-preferences-"));
    try {
      const module = await preferencesModule();
      const layout = buildRunledgerLayout(join(root, "home"), "posix");
      await mkdir(layout.state, { recursive: true });
      await writeFile(join(layout.state, "tui-preferences.json"), JSON.stringify({
        version: 2,
        transcript: { scrollbar: "visible" },
        display: { shimmer: "rainbow" },
      }), "utf8");

      expect(await module.loadTuiPreferences(layout)).toEqual({
        preferences: {
          version: 2,
          transcript: { scrollbar: "visible" },
          display: { shimmer: "classic" },
        },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("falls back with a bounded diagnostic for damaged or unsupported documents", async () => {
    const root = await mkdtemp(join(tmpdir(), "runledger-tui-preferences-"));
    try {
      const module = await preferencesModule();
      const layout = buildRunledgerLayout(join(root, "home"), "posix");
      await mkdir(layout.state, { recursive: true });
      const target = join(layout.state, "tui-preferences.json");
      await writeFile(target, "{ secret-invalid-json", "utf8");
      const damaged = await module.loadTuiPreferences(layout);
      expect(damaged.preferences).toEqual(module.createDefaultTuiPreferences());
      expect(damaged.diagnostic).toEqual({ code: "invalid_tui_preferences" });
      expect(JSON.stringify(damaged)).not.toContain("secret-invalid-json");

      await writeFile(target, JSON.stringify({
        version: 99,
        transcript: { scrollbar: "visible" },
      }), "utf8");
      expect((await module.loadTuiPreferences(layout)).diagnostic).toEqual({
        code: "unsupported_tui_preferences_version",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("drops unknown and forbidden position fields instead of persisting them", async () => {
    const root = await mkdtemp(join(tmpdir(), "runledger-tui-preferences-"));
    try {
      const module = await preferencesModule();
      const layout = buildRunledgerLayout(join(root, "home"), "posix");
      const unsafe = {
        version: 1,
        transcript: { scrollbar: "visible", scrollTop: 420 },
        sessionId: "secret-session",
        credential: "secret-credential",
      } as unknown as Parameters<PreferencesModule["saveTuiPreferences"]>[1];
      expect(await module.saveTuiPreferences(layout, unsafe)).toEqual({ ok: true });
      const raw = await readFile(join(layout.state, "tui-preferences.json"), "utf8");
      expect(JSON.parse(raw)).toEqual({
        version: 2,
        transcript: { scrollbar: "visible" },
        display: { shimmer: "classic" },
      });
      expect(raw).not.toMatch(/scrollTop|sessionId|credential|secret/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("serializes concurrent writes as complete JSON documents", async () => {
    const root = await mkdtemp(join(tmpdir(), "runledger-tui-preferences-"));
    try {
      const module = await preferencesModule();
      const layout = buildRunledgerLayout(join(root, "home"), "posix");
      const hidden = {
        version: 2 as const,
        transcript: { scrollbar: "hidden" as const },
        display: { shimmer: "classic" as const },
      };
      const visible = {
        version: 2 as const,
        transcript: { scrollbar: "visible" as const },
        display: { shimmer: "kitt" as const },
      };
      const results = await Promise.all(Array.from({ length: 12 }, (_, index) =>
        module.saveTuiPreferences(layout, index % 2 === 0 ? hidden : visible)));
      expect(results.every((result) => result.ok)).toBe(true);
      const raw = await readFile(join(layout.state, "tui-preferences.json"), "utf8");
      expect(() => JSON.parse(raw)).not.toThrow();
      expect([hidden, visible]).toContainEqual(JSON.parse(raw));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses a symlinked canonical state directory", { skip: !CAN_SYMLINK }, async () => {
    const root = await mkdtemp(join(tmpdir(), "runledger-tui-preferences-"));
    try {
      const module = await preferencesModule();
      const layout = buildRunledgerLayout(join(root, "home"), "posix");
      const outside = join(root, "outside");
      await mkdir(layout.home, { recursive: true });
      await mkdir(outside, { recursive: true });
      await symlink(outside, layout.state);

      expect(await module.saveTuiPreferences(layout, {
        version: 2,
        transcript: { scrollbar: "visible" },
        display: { shimmer: "disabled" },
      })).toEqual({ ok: false, code: "tui_preferences_save_failed" });
      await expect(readFile(join(outside, "tui-preferences.json"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
