import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

interface Phase11Fault {
	id: string;
	injectionPoint: string;
	expectedEventOrReceipt: string;
	recovery: string;
	owner: "runtime" | "external_gap";
	exactCommand: string;
	platforms: readonly ("linux" | "darwin" | "win32")[];
	testFile: string;
}

interface Phase11FaultManifest {
	schemaVersion: 1;
	phase: 11;
	faults: readonly Phase11Fault[];
}

const manifestPath = resolve("development-doc/runtime/harness/phase-11-fault-manifest.json");
const expectedKeys = [
	"exactCommand",
	"expectedEventOrReceipt",
	"id",
	"injectionPoint",
	"owner",
	"platforms",
	"recovery",
	"testFile",
];

async function manifest(): Promise<Phase11FaultManifest> {
	const parsed: unknown = JSON.parse(await readFile(manifestPath, "utf8"));
	if (typeof parsed !== "object" || parsed === null) throw new TypeError("fault manifest must be an object");
	return parsed as Phase11FaultManifest;
}

describe("Phase 11 fault manifest", () => {
	it("is the unique closed machine-readable mapping for W5 A-E", async () => {
		const value = await manifest();
		expect(value).toMatchObject({ schemaVersion: 1, phase: 11 });
		expect(value.faults.length).toBeGreaterThanOrEqual(20);
		expect(new Set(value.faults.map((fault) => fault.id)).size).toBe(value.faults.length);
		expect(new Set(value.faults.map((fault) => fault.id.split("-")[1]))).toEqual(
			new Set(["A", "B", "C", "D", "E"]),
		);
		for (const fault of value.faults) {
			expect(Object.keys(fault).sort()).toEqual(expectedKeys);
			expect(fault.id).toMatch(/^P11-[A-E]-[A-Z0-9-]+$/u);
			expect(fault.injectionPoint.length).toBeGreaterThan(8);
			expect(fault.expectedEventOrReceipt.length).toBeGreaterThan(8);
			expect(fault.recovery.length).toBeGreaterThan(8);
			expect(["runtime", "external_gap"]).toContain(fault.owner);
			expect(fault.platforms).toEqual(["linux", "darwin", "win32"]);
			expect(fault.exactCommand).toContain(fault.testFile);
			expect(fault.exactCommand).toMatch(/^npx vitest run tests\/.+ --no-file-parallelism$/u);
			expect(fault.testFile).toMatch(/^tests\/.+\.test\.ts$/u);
			await expect(access(resolve(fault.testFile))).resolves.toBeUndefined();
		}
	});

	it("maps every new runtime-owned uncertain-effect suite into W5", async () => {
		const value = await manifest();
		const mapped = new Set(value.faults.map((fault) => fault.testFile));
		for (const testFile of [
			"tests/runtime-v3/executors/execution-authority.test.ts",
			"tests/runtime-v3/executors/handoff-coordinator.test.ts",
			"tests/runtime-v3/telemetry/durable-delivery.test.ts",
			"tests/runtime-v3/telemetry/cost-v2.test.ts",
			"tests/runtime-v3/verification/proposal-effects.test.ts",
			"tests/runtime-v3/lifecycle/gc-journal.test.ts",
		]) {
			expect(mapped.has(testFile), `${testFile} is missing from Phase 11 fault manifest`).toBe(true);
		}
	});
});
