import { describe, expect, it } from "vitest";
import { createLocalIdentityContext } from "../../src/runtime/local-identity.ts";
import { isWorkspaceExecutionEnvelope } from "../../src/runtime/protocol/workspace.ts";
import { createRuntimeId } from "../../src/runtime/protocol/ids.ts";
import { runtimeDigest } from "../../src/runtime/protocol/foundation.ts";

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
			// ADR 02 D1/D5：公共 envelope 只投影 digest，不携带 native path。
			worktreePathDigest: runtimeDigest("/tmp/runledger-worktree"),
			branch: "runledger/test",
			baseCommit: "0".repeat(40),
			agentId: createRuntimeId("agent", "security-test"),
			toolCallId: createRuntimeId("toolCall", "security-test"),
			traceId: createRuntimeId("trace", "security-test"),
			cwdDigest: runtimeDigest("/tmp/runledger-worktree"),
			ownerRuntimeId: createRuntimeId("runtime", "security-test"),
			leaseRevision: 1,
			fencingTokenDigest: {
				algorithm: "sha256",
				digest: "a".repeat(64),
			},
		};

		expect(isWorkspaceExecutionEnvelope(envelope)).toBe(true);
		expect(isWorkspaceExecutionEnvelope({ ...envelope, leaseRevision: -1.5 })).toBe(false);
		expect(isWorkspaceExecutionEnvelope({ ...envelope, cwdDigest: 42 })).toBe(false);
		expect(isWorkspaceExecutionEnvelope({ ...envelope, fencingToken: "raw-secret" })).toBe(false);
		expect(isWorkspaceExecutionEnvelope({ ...envelope, extra: true })).toBe(false);
	});
});
