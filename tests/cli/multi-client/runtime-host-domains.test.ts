import { describe, expect, it } from "vitest";
import { createRuntimeId } from "../../../src/runtime/protocol/ids.ts";
import { runtimeDigest } from "../../../src/runtime/protocol/foundation.ts";
import type { SecuritySnapshot } from "../../../src/security/types.ts";
import type { HostRuntimeDomainContext } from "../../../src/cli/runtime-host-service.ts";
import { createHostDomainPorts, createSecurityDomainPort, createWorkspaceDomainPort } from "../../../src/cli/runtime-host-domains.ts";

function context(operation: string, mutation = false): HostRuntimeDomainContext {
	const sessionId = createRuntimeId("session", "domain-adapter");
	return {
		principal: {
			principalId: createRuntimeId("principal", "domain-adapter"),
			connectionId: createRuntimeId("connection", "domain-adapter"),
			attestationDigest: runtimeDigest("attestation"),
		},
		frame: {
			frameId: "domain-adapter-frame",
			kind: "command_request",
			protocolVersion: 1,
			body: { operation, sessionId },
		},
		operation,
		mutation,
		sessionId,
		controller: {
			sessionId,
			inFlight: false,
			currentSelection: { thinkingLevel: "off" },
			messages: [],
			warnings: [],
			auditEntries: [],
			toolCount: 0,
			subscribe: () => () => {},
			getSteeringMessages: () => [],
			getFollowUpMessages: () => [],
			getProviderStatuses: async () => [],
			getProvider: () => undefined,
			getAvailableModels: async () => [],
			login: async () => { throw new Error("unused"); },
			logout: async () => {},
			selectModel: async () => {},
			setThinkingLevel: async (level) => level,
			prompt: async () => {},
			interrupt: () => {},
			clearAllQueues: () => ({ steering: [], followUp: [] }),
			waitForIdle: async () => {},
			dispose: () => {},
		},
		hostGeneration: 1,
		sessionGeneration: 1,
		driverRevision: 1,
		domainRevision: 0,
	};
}

function securitySnapshot(): SecuritySnapshot {
	return {
		profile: {
			name: "workspace-write",
			approvalPolicy: "on-request",
			filesystemMode: "workspace-write",
			network: { mode: "deny", allowedHosts: [] },
			sandbox: "off",
		},
		filesystem: { mode: "workspace-write", workspaceRoot: "/private/workspace", protectedPaths: [] },
		rules: [],
		sources: ["user"],
		workspaceRoot: "/private/workspace",
		tempRoot: "/private/tmp",
		policyDigest: runtimeDigest("policy"),
		createdAt: "2026-08-05T00:00:00.000Z",
	};
}

describe("Host security/workspace domain adapters", () => {
	it("composes exactly one Host port for each domain", () => {
		const ports = createHostDomainPorts({
			security: { snapshot: securitySnapshot() },
			workspace: { workspaceId: createRuntimeId("workspace", "domain-adapter"), defaultCwd: "/private/workspace" },
		});
		expect(ports.map((port) => port.name)).toEqual(["security", "workspace"]);
	});

	it("projects a bounded security snapshot without leaking private paths", async () => {
		const result = await createSecurityDomainPort({ snapshot: securitySnapshot() }).execute(context("security.inspect"));
		expect(result).toMatchObject({ ok: true, body: { policyDigest: runtimeDigest("policy"), profile: "workspace-write", sandbox: "off" } });
		expect(JSON.stringify(result)).not.toContain("/private/workspace");
	});

	it("fails closed when workspace control is not composed", async () => {
		const result = await createWorkspaceDomainPort({ workspaceId: createRuntimeId("workspace", "domain-adapter"), defaultCwd: "/private/workspace" }).execute(context("worktree.resume", true));
		expect(result).toMatchObject({ ok: false, body: { code: "workspace_binding_unavailable" } });
	});
});
