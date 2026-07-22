import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("Runtime design evidence snapshots", () => {
	it("keeps all reviewed repository SHAs in the canonical plan", () => {
		const path = fileURLToPath(new URL("../../development-doc/runtime/04-governed-agent-harness-runtime-plan.md", import.meta.url));
		const plan = readFileSync(path, "utf8");
		for (const snapshot of [
			"65f905452195e034c99fa5ac560a7e23a822f052",
			"0b175e6439a8608ba7726ee153fd8590619e8f34",
			"3f1762cc7d3af39898aa5d21891335935011287f",
			"c68e39f60462f28d9be5e683d9cbe2c57b1a5027",
			"73338f21dc16",
		]) {
			expect(plan).toContain(snapshot);
		}
		expect(plan).toContain("这些快照是设计取样,不是依赖锁定");
	});
});
