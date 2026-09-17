import { lstat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { object } from "./projection.ts";

export async function assertSafePath(home: string, path: string): Promise<void> {
  const root = resolve(home), target = resolve(path);
  if (target !== root && !target.startsWith(`${root}/`) && !target.startsWith(`${root}\\`)) throw new Error("trajectory path outside home");
  const relative = target.slice(root.length).split(/[\\/]/).filter(Boolean);
  let current = root;
  for (const part of ["", ...relative]) {
    current = part ? join(current, part) : current;
    try { if ((await lstat(current)).isSymbolicLink()) throw new Error("trajectory symlink rejected"); }
    catch (error) { if (!isMissing(error)) throw error; }
  }
}
function isMissing(error: unknown): boolean { return object(error).code === "ENOENT"; }
