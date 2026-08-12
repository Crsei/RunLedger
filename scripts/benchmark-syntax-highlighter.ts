import { performance } from "node:perf_hooks";
import { loadNativeSyntaxAddon } from "../src/tui/highlight/native-loader.ts";
import { syntaxBenchmarkFixtures } from "./syntax-highlighter-benchmark-fixtures.ts";

const availability = loadNativeSyntaxAddon();
if (!availability.ok) {
	process.stderr.write("syntax highlighter benchmark unavailable: native_unavailable\n");
	process.exit(1);
}

const fixtures = syntaxBenchmarkFixtures();
const WARMUP_RUNS = 20;
const SAMPLE_RUNS = 100;
const VISIBLE_32_KIB_P95_STOP_GATE_MS = 50;

const results = [];
for (const item of fixtures) {
	for (let run = 0; run < WARMUP_RUNS; run += 1) {
		await availability.addon.highlightAsync(item.source, item.language, item.theme);
	}
	const samples: number[] = [];
	for (let run = 0; run < SAMPLE_RUNS; run += 1) {
		const startedAt = performance.now();
		const result = await availability.addon.highlightAsync(item.source, item.language, item.theme);
		samples.push(performance.now() - startedAt);
		if (!result.ok) throw new Error(`${item.name} failed: ${result.reason}`);
	}
	samples.sort((left, right) => left - right);
	results.push({
		name: item.name,
		bytes: Buffer.byteLength(item.source, "utf8"),
		lines: item.source.endsWith("\n") ? item.source.split("\n").length - 1 : item.source.split("\n").length,
		p50Ms: round(percentile(samples, 0.5)),
		p95Ms: round(percentile(samples, 0.95)),
		maxMs: round(samples.at(-1) ?? 0),
	});
}

const visibleResult = results.find((item) => item.name === "32 KiB visible snippet");
const stopGatePassed = visibleResult !== undefined && visibleResult.p95Ms <= VISIBLE_32_KIB_P95_STOP_GATE_MS;

process.stdout.write(`${JSON.stringify({
	environment: { node: process.version, platform: process.platform, arch: process.arch },
	engine: availability.info,
	gate: { name: "32 KiB p95", thresholdMs: VISIBLE_32_KIB_P95_STOP_GATE_MS, passed: stopGatePassed },
	fixtures: results,
}, null, 2)}\n`);
if (!stopGatePassed) process.exitCode = 1;

function percentile(sorted: readonly number[], quantile: number): number {
	return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * quantile) - 1))] ?? 0;
}

function round(value: number): number {
	return Math.round(value * 1_000) / 1_000;
}
