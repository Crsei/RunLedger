import { describe, expect, it } from "vitest";
import { createLocalIdentityContext } from "../../src/runtime/identity/local-principal.ts";
import { isWorkspaceExecutionEnvelope } from "../../src/runtime/protocol/workspace.ts";
import { createRuntimeId } from "../../src/runtime/protocol/ids.ts";

describe("current Runtime/security boundary contract", () => {
	it("accepts a typed workspace envelope without owning policy evaluation", () => {
		const identity = createLocalIdentityContext(new Date("2026-07-22T00:00:00.000Z"));
		const envelope = {
			authorityId: identity.authorityId,
			tenantId: identity.tenantId,
			principalId: identity.principalId,
			sessionId: createRuntimeId("session", "security-test"),
			workspaceId: createRuntimeId("workspace", "security-test"),
			repositoryId: createRuntimeId("repository", "security-test"),
			worktreePath: "/tmp/runledger-worktree",
			branch: "runledger/test",
			baseCommit: "0".repeat(40),
			agentId: createRuntimeId("agent", "security-test"),
			toolCallId: "tool-call-security-test",
			traceId: createRuntimeId("trace", "security-test"),
			cwd: "/tmp/runledger-worktree",
			ownerRuntimeId: "runtime-security-test",
			leaseRevision: 1,
			fencingToken: "fence-security-test",
		};

		expect(isWorkspaceExecutionEnvelope(envelope)).toBe(true);
		expect(isWorkspaceExecutionEnvelope({ ...envelope, leaseRevision: -1.5 })).toBe(false);
		expect(isWorkspaceExecutionEnvelope({ ...envelope, cwd: 42 })).toBe(false);
	});
});
