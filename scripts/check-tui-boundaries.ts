/** TUI 四层依赖边界检查。 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import ts from "typescript";

const root = resolve(process.cwd(), "src");
const tuiRoot = join(root, "tui");
const failures: string[] = [];

for (const file of files(tuiRoot)) {
  const rel = relative(root, file).replaceAll("\\", "/");
  const imports = moduleSpecifiers(file);
  if (rel.startsWith("tui/components/")) {
    reject(rel, imports, ["../../runtime/", "../../storage/"], "components may consume presentation types only");
  }
  if (
    rel === "tui/application/reducer.ts" ||
    rel === "tui/application/effects.ts" ||
    rel === "tui/application/interactive-shell.ts" ||
    rel.startsWith("tui/timeline/tool-")
  ) {
    reject(rel, imports, ["node:fs", "node:net", "../../runtime/", "../../storage/"], "pure TUI state modules may not perform IO");
  }
  if (rel.startsWith("tui/commands/")) {
    reject(rel, imports, ["../components/"], "command domain may not depend on concrete components");
  }
}

for (const area of ["runtime", "storage"]) {
  for (const file of files(join(root, area))) {
    const rel = relative(root, file).replaceAll("\\", "/");
    reject(rel, moduleSpecifiers(file), ["/tui/", "../tui/", "../../tui/"], "runtime/storage may not depend on TUI");
  }
}

if (failures.length > 0) {
  process.stderr.write(`${failures.join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write("TUI boundary check passed\n");
}

function files(directory: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(directory)) {
    const target = join(directory, entry);
    if (statSync(target).isDirectory()) out.push(...files(target));
    else if (target.endsWith(".ts")) out.push(target);
  }
  return out;
}

function moduleSpecifiers(file: string): string[] {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.TS,
  );
  const imports: string[] = [];
  source.forEachChild((node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) imports.push(node.moduleSpecifier.text);
  });
  return imports;
}

function reject(
  file: string,
  imports: readonly string[],
  forbidden: readonly string[],
  reason: string,
): void {
  for (const specifier of imports) {
    if (forbidden.some((value) => specifier.includes(value))) {
      failures.push(`${file}: forbidden import ${specifier} (${reason})`);
    }
  }
}
