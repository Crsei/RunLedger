import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { RUNTIME_EVENT_TYPES } from "../../../src/runtime/protocol/v3/event-catalog.ts";
import { RUNTIME_EVENT_PAYLOAD_SCHEMAS } from "../../../src/runtime/protocol/v3/event-payloads.ts";
import { isRuntimeEventSchemaCatalogExhaustive } from "../../../src/runtime/protocol/v3/schemas.ts";
import { asRecord, loadContractFixture } from "./helpers.ts";

const projectRoot = resolve(fileURLToPath(new URL("../../../", import.meta.url)));

function stringArray(value: unknown, field: string): string[] {
	if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
		throw new Error(`${field} must be a string array`);
	}
	return value;
}

describe("Phase 6 contract ownership", () => {
	it("publishes non-overlapping contract, behavior and serialized integration paths", () => {
		const manifest = asRecord(loadContractFixture("contract-ownership/runtime-phase6.json"));
		expect(manifest.schemaVersion).toBe(1);
		const contracts = stringArray(manifest.runtimeContractAllowlist, "runtimeContractAllowlist");
		const behavior = stringArray(manifest.specialtyBehaviorPaths, "specialtyBehaviorPaths");
		const integration = stringArray(manifest.sharedIntegrationPaths, "sharedIntegrationPaths");
		expect(new Set(contracts).size).toBe(contracts.length);
		expect(new Set(behavior).size).toBe(behavior.length);
		expect(new Set(integration).size).toBe(integration.length);
		expect(contracts.filter((path) => behavior.includes(path) || integration.includes(path))).toEqual([]);
		expect(behavior.filter((path) => integration.includes(path))).toEqual([]);
		for (const path of contracts.filter((entry) => !entry.endsWith("contracts") && !entry.includes("fixtures/"))) {
			expect(existsSync(resolve(projectRoot, path)), path).toBe(true);
		}
	});

	it("keeps contract modules free of behavior imports and duplicate public definitions", () => {
		const contractFiles = [
			"src/runtime/model-routing/types.ts",
			"src/runtime/model-routing/schema.ts",
			"src/runtime/modes/plan/types.ts",
			"src/runtime/modes/plan/schema.ts",
			"src/runtime/context/types.ts",
			"src/runtime/context/schema.ts",
			"src/runtime/context/compaction/types.ts",
			"src/runtime/context/compaction/schema.ts",
			"src/runtime/context/memory/types.ts",
			"src/runtime/context/memory/schema.ts",
		];
		const forbidden = ["manifest-loader", "/router.ts", "/service.ts", "/store.ts", "context-engine", "cut-planner", "/summarizer.ts", "/tui/", "/cli/"];
		for (const path of contractFiles) {
			const source = readFileSync(resolve(projectRoot, path), "utf8");
			const imports = source.split("\n").filter((line) => line.startsWith("import ")).join("\n");
			for (const fragment of forbidden) expect(imports.includes(fragment), `${path}: ${fragment}`).toBe(false);
		}
	});

	it("keeps the public event catalog exhaustive without losing conversation events", () => {
		const phaseSixEvents = [
			"model.routed",
			"mode.transitioned",
			"plan.proposed",
			"plan.approved",
			"plan.rejected",
			"plan.invalidated",
			"context.assembled",
			"compaction.started",
			"compaction.completed",
			"compaction.failed",
			"compaction.suppressed",
			"memory.proposed",
			"memory.approved",
			"memory.rejected",
			"memory.published",
			"memory.searched",
			"memory.injected",
			"memory.revoked",
			"memory.expired",
		];
		for (const type of phaseSixEvents) expect(RUNTIME_EVENT_TYPES).toContain(type);
		expect(RUNTIME_EVENT_TYPES).toContain("conversation.message_recorded");
		expect(Object.keys(RUNTIME_EVENT_PAYLOAD_SCHEMAS)).toEqual([...RUNTIME_EVENT_TYPES]);
		expect(isRuntimeEventSchemaCatalogExhaustive()).toBe(true);
	});
});
