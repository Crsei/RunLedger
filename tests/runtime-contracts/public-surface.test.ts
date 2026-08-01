import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as contracts from "../../src/runtime/contracts/public.ts";

describe("Governed Runtime audited public surface", () => {
	it("exports contract schemas, guards, catalogs, and port metadata", () => {
		for (const name of [
			"RUNTIME_ID_KINDS",
			"RuntimeDigestSchema",
			"RUNTIME_EVENT_TYPES",
			"RUNTIME_EVENT_PAYLOAD_SCHEMAS",
			"WorkspaceExecutionEnvelopeSchema",
			"CapabilityRequestSchema",
			"RuntimeResourceSnapshotSchema",
			"ModelRouteDecisionSchema",
			"PlanModeStateSchema",
			"ContextAssemblyReceiptSchema",
			"CompactionCheckpointSchema",
			"MemoryRecordSchema",
			"ArtifactIntentSchema",
			"ProductionCompositionReceiptSchema",
			"RUNTIME_ADAPTER_PORT_NAMES",
			"AdapterPortRequestSchema",
			"resolveRunledgerHomeContract",
		]) {
			expect(contracts, name).toHaveProperty(name);
		}
	});

	it("does not export behavior implementations, managers, or test fakes", () => {
		for (const forbidden of [
			"Agent",
			"SessionManager",
			"PermissionEngine",
			"MemoryStore",
			"CompactionService",
			"FakeArtifactStore",
			"createResourceLifecycleEvent",
		]) {
			expect(contracts).not.toHaveProperty(forbidden);
		}
	});

	it("publishes one stable package subpath for the audited surface", () => {
		const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
		const packageJson = JSON.parse(readFileSync(`${repoRoot}/package.json`, "utf8")) as {
			exports?: Record<string, unknown>;
		};
		expect(packageJson.exports?.["./runtime/contracts"]).toEqual({
			import: "./dist/runtime/contracts/public.js",
			types: "./dist/runtime/contracts/public.d.ts",
		});
	});
});
