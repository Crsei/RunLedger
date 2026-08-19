import { copyFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const source = resolve("src/tui/components/tips.txt");
const destination = resolve("dist/tui/components/tips.txt");

await mkdir(dirname(destination), { recursive: true });
await copyFile(source, destination);
