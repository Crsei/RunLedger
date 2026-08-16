import { performance } from "node:perf_hooks";
import { runStreamingPrefixStressCases } from "./streaming-prefix-stability-fixtures.ts";

const startedAt = performance.now();
const results = runStreamingPrefixStressCases();
const processVersions = process.versions as NodeJS.ProcessVersions & { readonly bun?: string };

console.log(JSON.stringify({
	plan: "05-streaming-prefix-stability",
	environment: {
		node: process.version,
		bun: processVersions.bun ?? null,
		platform: process.platform,
		arch: process.arch,
		columns: process.stdout.columns ?? null,
		rows: process.stdout.rows ?? null,
	},
	durationMs: round(performance.now() - startedAt),
	results,
}, null, 2));

function round(value: number): number {
	return Math.round(value * 1000) / 1000;
}
