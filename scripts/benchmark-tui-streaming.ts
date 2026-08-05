import { performance } from "node:perf_hooks";
import { DeltaCoalescer } from "../src/tui/opentui/delta-coalescer.ts";
import { decideMarkdownProjection } from "../src/tui/opentui/markdown-budget.ts";

interface BenchmarkCase {
  readonly name: string;
  readonly inputEvents: number;
  readonly inputBytes: number;
  readonly pushMs: number;
  readonly drainMs: number;
  readonly projectedItems: number;
  readonly mergedTextEvents: number;
  readonly queuedBytes: number;
}

interface MarkdownFixtureResult {
  readonly name: string;
  readonly inputBytes: number;
  readonly lines: number;
  readonly mode: string;
  readonly reason?: string;
  readonly openFence: boolean;
}

interface TerminalFixtureResult {
  readonly name: string;
  readonly drainedItems: number;
  readonly semanticText: string;
  readonly terminalKind: "abort" | "error";
}

const cases: BenchmarkCase[] = [
  runCase("10000 x 1-char", Array.from({ length: 10_000 }, () => "a")),
  runCase("8 KiB natural chunks", chunk("b", 8 * 1024, 256)),
  runCase("1 MiB single chunk", ["c".repeat(1024 * 1024)]),
];

const markdownFixtures: MarkdownFixtureResult[] = [
  markdownFixture("open code fence", `\`\`\`ts\n${"x".repeat(16 * 1024)}`),
  markdownFixture("large table", [
    "| key | value |",
    "| --- | --- |",
    ...Array.from({ length: 4_096 }, (_, index) => `| ${index} | value-${index} |`),
  ].join("\n")),
  markdownFixture("long single line", "y".repeat(128 * 1024)),
];

const terminalFixtures: TerminalFixtureResult[] = [
  terminalFixture("abort", "abort"),
  terminalFixture("error", "error"),
];

console.log(JSON.stringify({
  environment: {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    columns: process.stdout.columns ?? null,
    rows: process.stdout.rows ?? null,
  },
  cases,
  markdownFixtures,
  terminalFixtures,
}, null, 2));

function runCase(name: string, chunks: readonly string[]): BenchmarkCase {
  const coalescer = new DeltaCoalescer();
  const pushStartedAt = performance.now();
  for (const text of chunks) {
    coalescer.push({
      kind: "append-text",
      entryId: "benchmark:assistant",
      partId: "benchmark:markdown",
      generation: 1,
      text,
    });
  }
  const pushMs = performance.now() - pushStartedAt;
  const drainStartedAt = performance.now();
  const drained = coalescer.drain();
  const drainMs = performance.now() - drainStartedAt;
  const inputBytes = new TextEncoder().encode(chunks.join("")).byteLength;
  return {
    name,
    inputEvents: chunks.length,
    inputBytes,
    pushMs: round(pushMs),
    drainMs: round(drainMs),
    projectedItems: drained.length,
    mergedTextEvents: coalescer.stats.mergedTextEvents,
    queuedBytes: coalescer.queuedBytes,
  };
}

function markdownFixture(name: string, text: string): MarkdownFixtureResult {
  const decision = decideMarkdownProjection(text, true);
  return {
    name,
    inputBytes: new TextEncoder().encode(text).byteLength,
    lines: decision.lines,
    mode: decision.mode,
    ...(decision.reason ? { reason: decision.reason } : {}),
    openFence: decision.openFence,
  };
}

function terminalFixture(name: "abort" | "error", terminalKind: "abort" | "error"): TerminalFixtureResult {
  const coalescer = new DeltaCoalescer();
  coalescer.push({
    kind: "append-text",
    entryId: "benchmark:assistant",
    partId: "benchmark:markdown",
    generation: 1,
    text: `${terminalKind} body`,
  });
  coalescer.push({
    kind: "terminal",
    patch: {
      kind: "complete",
      entryId: "benchmark:assistant",
      generation: 1,
      status: terminalKind,
    },
  });
  const drained = coalescer.drain();
  const semanticText = drained
    .filter((delta): delta is Extract<typeof delta, { kind: "append-text" }> => delta.kind === "append-text")
    .map((delta) => delta.text)
    .join("");
  return { name, drainedItems: drained.length, semanticText, terminalKind };
}

function chunk(value: string, totalBytes: number, chunkSize: number): string[] {
  const count = Math.ceil(totalBytes / chunkSize);
  return Array.from({ length: count }, (_, index) => {
    const size = Math.min(chunkSize, totalBytes - index * chunkSize);
    return value.repeat(size);
  });
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
