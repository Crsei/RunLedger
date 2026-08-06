/** Generates the content-addressed identity consumed by the production CLI and Host. */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { writeHostBuildManifest } from "../src/cli/host-build-identity.ts";

const packageDocument = JSON.parse(await readFile(resolve("package.json"), "utf8")) as { version?: unknown };
if (typeof packageDocument.version !== "string" || packageDocument.version.length === 0) {
	throw new Error("package version is unavailable for the Host build manifest");
}
await writeHostBuildManifest(resolve("dist"), packageDocument.version);
