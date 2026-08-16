import { describe, expect, test } from "vitest";
import { runStreamingPrefixStressCases } from "../../scripts/streaming-prefix-stability-fixtures.ts";

describe("streaming prefix stability pressure fixtures", () => {
	test("covers the bounded delta, markdown, table, diff, cache, and lineage cases", () => {
		const results = runStreamingPrefixStressCases();
		const byName = new Map(results.map((result) => [result.name, result]));

		expect([...byName.keys()]).toEqual([
			"10000 x 1-char delta",
			"1 MiB message",
			"open fence",
			"growing table",
			"streaming diff",
			"settled cache bound",
			"abort/error lineage",
		]);
		expect(byName.get("10000 x 1-char delta")).toMatchObject({ inputEvents: 10_000, projectedItems: 1, textLossless: true });
		expect(byName.get("1 MiB message")).toMatchObject({ inputBytes: 1024 * 1024, textLossless: true });
		expect(byName.get("open fence")).toMatchObject({ openFence: true, settledEnd: 0 });
		expect(byName.get("growing table")).toMatchObject({ split: true, prefixStable: true });
		expect(byName.get("streaming diff")).toMatchObject({ admittedLines: 1, tailLines: 1, fallback: "none" });
		expect(byName.get("settled cache bound")).toMatchObject({ bounded: true, entries: 64 });
		expect(byName.get("abort/error lineage")).toMatchObject({ oldGenerationVisible: false, terminalEvents: 2 });
	});
});
