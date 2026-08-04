import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

function collectTypeScriptFiles(root: string): string[] {
  const files: string[] = [];
  for (const name of readdirSync(root)) {
    const path = join(root, name);
    if (statSync(path).isDirectory()) files.push(...collectTypeScriptFiles(path));
    else if (path.endsWith(".ts")) files.push(path);
  }
  return files;
}

describe("OpenTUI framework boundary", () => {
  it("生产 TUI 与 package 依赖不再引用 pi-tui", () => {
    const legacyPackage = "@earendil-works/" + "pi-tui";
    const sourceMatches = collectTypeScriptFiles(join(process.cwd(), "src", "tui"))
      .filter((path) => readFileSync(path, "utf8").includes(legacyPackage));
    const packageJson = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
    };

    expect(sourceMatches).toEqual([]);
    expect(packageJson.dependencies?.[legacyPackage]).toBeUndefined();
  });

  it("生产 shim 与总测试门禁使用 Bun 承载 OpenTUI", () => {
    const packageJson = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };
    const shim = readFileSync(join(process.cwd(), "bin", "runledger.js"), "utf8");

    expect(shim.startsWith("#!/bin/sh\n")).toBe(true);
    expect(shim).toContain("[runledger] Bun");
    expect(shim).toContain("exec bun");
    expect(packageJson.scripts?.["test:tui-native"]).toContain("bun test");
    expect(packageJson.scripts?.test).toContain("npm run test:tui-native");
  });

  it("通过 npm 风格符号链接启动时仍定位 package 内的 dist", () => {
    const root = mkdtempSync(join(tmpdir(), "runledger-linked-shim-"));
    try {
      const fakeBin = join(root, "fake-bin");
      const globalBin = join(root, "global-bin");
      mkdirSync(fakeBin);
      mkdirSync(globalBin);
      const fakeBun = join(fakeBin, "bun");
      writeFileSync(fakeBun, "#!/bin/sh\nprintf '%s\\n' \"$1\"\n", "utf8");
      chmodSync(fakeBun, 0o755);
      const linkedShim = join(globalBin, "runledger");
      symlinkSync(join(process.cwd(), "bin", "runledger.js"), linkedShim);

      const result = spawnSync(linkedShim, [], {
        encoding: "utf8",
        env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH ?? ""}` },
      });

      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe(resolve(process.cwd(), "dist", "cli", "cli.js"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
