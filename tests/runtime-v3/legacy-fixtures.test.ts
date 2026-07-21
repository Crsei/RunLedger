import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

function readFixture(name: "v1-basic.json" | "v2-basic.json"): Record<string, unknown> {
	const path = fileURLToPath(new URL(`../fixtures/runtime-v3/legacy/${name}`, import.meta.url));
	return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

describe("legacy compatibility fixture scaffold", () => {
	it("keeps v1 and v2 fixtures read-only and distinguishable", () => {
		expect(readFixture("v1-basic.json").version).toBe(1);
		expect(readFixture("v2-basic.json").version).toBe(2);
	});
});
