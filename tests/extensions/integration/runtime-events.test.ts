import { describe, expect, it } from "vitest";
import { createExtensionInvocationEvent } from "../../../src/extensions/integration/runtime-events.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/ids.ts";
import { runtimeDigest } from "../../../src/runtime/protocol/foundation.ts";
import type { ExtensionInvocationAudit } from "../../../src/extensions/integration/runtime-audit-adapter.ts";

function audit(outcome: ExtensionInvocationAudit["outcome"]): { readonly audit: ExtensionInvocationAudit; readonly auditDigest: ReturnType<typeof runtimeDigest> } {
	const requestId = createRuntimeId("command", "extension-event");
	const correlationId = createRuntimeId("trace", "extension-event");
	const snapshotId = createRuntimeId("snapshot", "extension-event");
	const resource = {
		resourceId: createRuntimeId("resource", "extension-event"),
		kind: "hook" as const,
		qualifiedId: "hook:project:guard",
		version: "1.0.0",
		source: "project" as const,
		digest: runtimeDigest("resource"),
	};
	const value: ExtensionInvocationAudit = {
		kind: "hook.run",
		requestId,
		correlationId,
		snapshotId,
		resource,
		outcome,
		inputDigest: runtimeDigest("secret input"),
		outputDigest: runtimeDigest("safe output"),
		metadataDigest: runtimeDigest({ outcome }),
		originalBytes: 12,
		resultBytes: 11,
		truncated: false,
		durationMs: 3,
	};
	return { audit: value, auditDigest: runtimeDigest(value) };
}

describe("extension invocation Runtime event projection", () => {
	it("uses the canonical tool event catalog and stores only bounded refs/digests", () => {
		const value = audit("ok");
		const event = createExtensionInvocationEvent({
			authorityId: createRuntimeId("authority", "extension-events"),
			tenantId: createRuntimeId("tenant", "extension-events"),
			principalId: createRuntimeId("principal", "extension-events"),
			sessionId: createRuntimeId("session", "extension-events"),
			...value,
		});

		expect(event.type).toBe("tool.finished");
		expect(event.payload.subject.kind).toBe("toolCall");
		expect(event.payload.refs?.length).toBe(3);
		expect(JSON.stringify(event)).not.toContain("secret input");
	});

	it("records denied, cancelled, and failed invocations as non-committed tool failures", () => {
		for (const outcome of ["denied", "cancelled", "unsupported"] as const) {
			const event = createExtensionInvocationEvent({
				authorityId: createRuntimeId("authority", `extension-events-${outcome}`),
				tenantId: createRuntimeId("tenant", `extension-events-${outcome}`),
				principalId: createRuntimeId("principal", `extension-events-${outcome}`),
				sessionId: createRuntimeId("session", `extension-events-${outcome}`),
				...audit(outcome),
			});

			expect(event.type).toBe("tool.failed");
			expect(event.payload.effect).toBe("none");
			expect(event.payload.reasonCode).toBe(outcome);
		}
	});
});
