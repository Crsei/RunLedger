#!/usr/bin/env node
/** 提取固定来源的可移植 catalog 字段；原始文件摘要用于核对来源，不运行上游代码。 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const sourceRoot = process.argv[2];
if (!sourceRoot) throw new Error("usage: node scripts/sources/extract-oh-my-pi-models.ts <oh-my-pi checkout>");
const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: sourceRoot, encoding: "utf8" }).trim();
const expectedCommit = "9bafadd50317d68850324dbb4ca6a978995b3ae2";
if (commit !== expectedCommit) throw new Error(`source HEAD differs from reviewed snapshot: ${commit}`);
const catalogPath = "packages/catalog/src/models.json";
if (execFileSync("git", ["status", "--porcelain", "--", catalogPath, "packages/catalog/package.json"], { cwd: sourceRoot, encoding: "utf8" }).trim()) {
	throw new Error("source catalog or version has uncommitted changes");
}
const raw = readFileSync(join(sourceRoot, catalogPath));
const bundled = JSON.parse(raw.toString()) as Record<string, Record<string, Record<string, unknown>>>;
const previous = JSON.parse(execFileSync("git", ["show", "06aecdd51f07e689e970ceaa180abe2be0c14bbb:packages/catalog/src/models.json"], { cwd: sourceRoot, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 })) as typeof bundled;
const removedModels = Object.fromEntries(Object.keys(bundled).filter((id) => previous[id]).map((id) => [
	id, Object.keys(previous[id]!).filter((key) => !bundled[id]![key]).sort(),
]));
const compatFields = new Set(["supportsStore", "supportsDeveloperRole", "supportsReasoningEffort", "supportsUsageInStreaming", "thinkingFormat", "requiresReasoningContentForToolCalls", "requiresReasoningContentForAllAssistantTurns", "supportsStrictMode", "maxTokensField", "requiresToolResultName", "requiresAssistantAfterToolResult", "requiresThinkingAsText", "supportsLongPromptCacheRetention", "wireModelIdMode", "includeEncryptedReasoning"]);
const fields = ["id", "name", "api", "baseUrl", "reasoning", "input", "cost", "contextWindow", "maxTokens", "thinking", "compat"];
const providers = Object.fromEntries(Object.entries(bundled).sort(([a], [b]) => a.localeCompare(b)).map(([id, models]) => [
	id, Object.keys(models).sort().map((key) => Object.fromEntries(fields.filter((field) => models[key]![field] !== undefined).map((field) => [field, field === "compat" ? Object.fromEntries(Object.entries(models[key]![field] as Record<string, unknown>).filter(([key]) => compatFields.has(key))) : models[key]![field]]))),
]));
const output = {
	source: { repository: "oh-my-pi", commit, version: "18.1.9", catalogPath, sha256: createHash("sha256").update(raw).digest("hex"), license: "MIT" },
	providers,
	removedModels,
};
const outPath = join(dirname(fileURLToPath(import.meta.url)), "oh-my-pi-provider-models-18.1.9.json");
writeFileSync(outPath, `${JSON.stringify(output)}\n`);
console.log(`wrote ${outPath}: ${Object.keys(providers).length} providers`);
