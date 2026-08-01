import { describe, expect, it } from "vitest";
import { buildExtensionSnapshot } from "../../src/extensions/snapshot.ts";
import { mergeExtensionConfigLayers } from "../../src/extensions/config-layers.ts";
import { DEFAULT_EXTENSION_SCAN_LIMITS, extensionDiagnostic } from "../../src/extensions/diagnostics.ts";
import type { ExtensionResourceDescriptor } from "../../src/extensions/types.ts";
import { createRuntimeId } from "../../src/runtime/protocol/ids.ts";

const digest = {
	algorithm: "sha256",
	digest: "6".repeat(64),
} as const;

function descriptor(): ExtensionResourceDescriptor {
	return {
		identity: {
			kind: "skill",
			qualifiedId: "project:fixture",
			version: "1.0.0",
			source: "project",
			digest: "extension-digest",
		},
		resource: {
			resourceId: createRuntimeId("resource", "extension-fixture"),
			kind: "skill",
			qualifiedId: "project:fixture",
			version: "1.0.0",
			source: "project",
			digest,
		},
		provenance: { source: "project", sourceLocatorDigest: digest },
		enabled: true,
		trusted: true,
		ready: true,
	};
}

describe("Extension foundation scaffold", () => {
	it("builds a deterministic sorted snapshot", () => {
		const snapshot = buildExtensionSnapshot({
			snapshotId: "snapshot-fixture",
			generation: 1,
			createdAt: "2026-07-22T00:00:00.000Z",
			descriptors: [descriptor()],
			diagnostics: [extensionDiagnostic("fixture.warning", "warning", "pending", "test")],
		});
		expect(snapshot.counts.skills).toBe(1);
		expect(snapshot.counts.ready).toBe(1);
		expect(snapshot.digest).toHaveLength(64);
	});

	it("keeps config layer order explicit and bounded", () => {
		const merged = mergeExtensionConfigLayers([
			{ source: "user", config: { enabled: false }, digest: "user" },
			{ source: "project", config: { enabled: true }, digest: "project" },
		]);
		expect(merged.config.enabled).toBe(true);
		expect(merged.sources).toEqual(["user", "project"]);
		expect(DEFAULT_EXTENSION_SCAN_LIMITS.maxFiles).toBeGreaterThan(0);
	});
});
