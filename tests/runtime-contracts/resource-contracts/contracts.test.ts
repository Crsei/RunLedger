import { describe, expect, it } from "vitest";
import { createRuntimeId } from "../../../src/runtime/protocol/ids.ts";
import { resourceIdentityDigest, resourceIdentityKey, isRuntimeToolInvocation } from "../../../src/runtime/resources/schemas.ts";
import { createResourceLifecycleEvent } from "../../../src/runtime/resources/events.ts";
import type { RuntimeToolDescriptor } from "../../../src/runtime/resources/types.ts";

const digest = {
	algorithm: "sha256",
	digest: "5".repeat(64),
} as const;

function descriptor(): RuntimeToolDescriptor {
	return {
		identity: {
			resourceId: createRuntimeId("resource", "fixture-tool"),
			kind: "mcp-tool",
			qualifiedId: "fixture.server/read",
			version: "1.0.0",
			source: "project",
			digest,
		},
		provenance: {
			source: "project",
			sourceLocatorDigest: digest,
		},
		runtimeName: "mcp_fixture_server_read",
		description: "A bounded contract fixture",
		parametersSchemaRef: { subjectKind: "content", digest },
		claims: [],
		exposure: "deferred",
		isReadOnly: true,
		isDestructive: false,
		isConcurrencySafe: true,
		trust: "trusted",
		activation: "ready",
		descriptorDigest: digest,
	};
}

describe("Runtime resource contract scaffold", () => {
	it("uses exact identity rather than display name for routing", () => {
		const tool = descriptor();
		const identityKey = resourceIdentityKey(tool.identity);
		expect(identityKey).toContain("mcp-tool:fixture.server/read@1.0.0");
		expect(resourceIdentityDigest(tool.identity)).toHaveLength(64);
		expect(isRuntimeToolInvocation({
			requestId: createRuntimeId("command", "fixture"),
			tool: tool.identity,
			inputDigest: digest,
			requestedClaims: [],
			decisionReceiptRef: { subjectKind: "receipt", digest },
			snapshotId: createRuntimeId("snapshot", "fixture"),
			correlationId: createRuntimeId("trace", "fixture"),
		})).toBe(true);
	});

	it("creates a bounded lifecycle event without a second hash chain", () => {
		const event = createResourceLifecycleEvent(
			descriptor().identity,
			"discovered",
			createRuntimeId("snapshot", "fixture"),
		);
		expect(event).not.toHaveProperty(["schema", "Version"].join(""));
		expect(event.state).toBe("discovered");
		expect(event).not.toHaveProperty("currentEventHash");
	});
});
