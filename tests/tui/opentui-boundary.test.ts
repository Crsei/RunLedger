import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
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
});
