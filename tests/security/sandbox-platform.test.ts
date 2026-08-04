import { describe, expect, it } from "vitest";
import { createRuntimeId } from "../../src/runtime/protocol/ids.ts";
import { runtimeDigest } from "../../src/runtime/protocol/foundation.ts";
import { createSandboxBackend } from "../../src/security/sandbox/factory.ts";
import type { SandboxPrepareRequest } from "../../src/security/sandbox/types.ts";

const request: SandboxPrepareRequest = {
	requested: "workspace-write",
	policyDigest: runtimeDigest("platform-policy"),
	requestDigest: runtimeDigest("platform-request"),
	workspace: {
		authorityId: createRuntimeId("authority", "platform"),
		tenantId: createRuntimeId("tenant", "platform"),
		principalId: createRuntimeId("principal", "platform"),
		sessionId: createRuntimeId("session", "platform"),
		workspaceId: createRuntimeId("workspace", "platform"),
		repositoryId: createRuntimeId("repository", "platform"),
		worktreePath: "/repo",
		branch: "test",
		baseCommit: "c".repeat(40),
		agentId: createRuntimeId("agent", "platform"),
		toolCallId: createRuntimeId("toolCall", "platform"),
		traceId: createRuntimeId("trace", "platform"),
		cwd: "/repo",
		ownerRuntimeId: createRuntimeId("runtime", "platform"),
		leaseRevision: 1,
		fencingTokenDigest: runtimeDigest("platform-fence"),
	},
	readRoots: ["/repo"],
	writeRoots: ["/repo"],
	denyRead: [],
	denyWrite: [],
	protectedPaths: [],
	network: "deny",
	command: "true",
	cwd: "/repo",
	environment: {},
	timeoutMs: 1_000,
};

describe("sandbox platform selection", () => {
	it("returns unavailable for Windows and unknown platforms without a raw-shell downgrade", async () => {
		for (const platform of ["windows", "unknown"] as const) {
			const backend = createSandboxBackend(platform, { probe: { which: async () => "/not-used" } });
			expect(await backend.probe()).toMatchObject({ status: "unavailable", platform });
			expect(await backend.prepare(request)).toMatchObject({ ok: false, error: { code: "sandbox_unavailable" } });
		}
	});
});
