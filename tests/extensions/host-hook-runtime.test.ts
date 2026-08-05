import { describe, expect, it } from "vitest";
import { parseHookDocument } from "../../src/extensions/hooks/parser.ts";
import { HostHookRuntime } from "../../src/extensions/hooks/runtime.ts";
import { createProductionHostHookRuntime } from "../../src/cli/runtime-host-session.ts";
import type { HookLifecycleInvocationRequest } from "../../src/extensions/integration/runtime-hook-adapter.ts";
import type { HookLifecycleAdapterPort } from "../../src/extensions/integration/runtime-hook-adapter.ts";
import type { ExtensionAdapterResult } from "../../src/extensions/integration/runtime-resource-adapter.ts";
import { createRuntimeId } from "../../src/runtime/protocol/ids.ts";
import { runtimeDigest } from "../../src/runtime/protocol/foundation.ts";
import type { ExecutionHandleRef } from "../../src/runtime/process/types.ts";
import type { ManagedHookProcess } from "../../src/extensions/hooks/host-runner.ts";
import type { ControlPlaneOutputResult, ControlPlaneWaitResult } from "../../src/storage/process/control-plane.ts";

function hook() {
	const parsed = parseHookDocument({
		hooks: {
			PreToolUse: [{ id: "guard", handlers: [{ type: "command", command: "./guard.sh", args: [], timeoutMs: 1000, env: {} }] }],
		},
	}, { sourceLayer: "project", sourcePath: "/workspace/hooks.json" });
	if (!parsed.ok) throw new Error("fixture hook is invalid");
	return parsed.hooks[0]!;
}

describe("HostHookRuntime", () => {
	it("binds a lifecycle invocation to the published hook snapshot and adapter identity", async () => {
		const definition = hook();
		let captured: HookLifecycleInvocationRequest | undefined;
		const adapter: HookLifecycleAdapterPort = {
			invoke: async (request) => {
				captured = request;
				const value = {
					invocation: request.invocation,
					decision: "allow" as const,
					blocked: false,
					finalInput: request.event.input,
					requiresRevalidation: false,
					requiresAuthorization: false,
					additionalContext: [],
					handlers: [],
					runtimeResult: {} as never,
				};
				return { ok: true, value, audit: {} as never, auditDigest: runtimeDigest(value) } satisfies ExtensionAdapterResult<typeof value>;
			},
		};
		const runtime = new HostHookRuntime({
			hooks: () => [definition],
			adapter,
			identity: {
				authorityId: createRuntimeId("authority", "hook-runtime"),
				tenantId: createRuntimeId("tenant", "hook-runtime"),
				principalId: createRuntimeId("principal", "hook-runtime"),
				principalKind: "local",
				issuedAt: "2026-08-05T00:00:00.000Z",
			},
			source: "host",
		});

		const result = await runtime.run({
			event: "PreToolUse",
			sessionId: createRuntimeId("session", "hook-runtime"),
			snapshotId: createRuntimeId("snapshot", "hook-runtime"),
			input: { command: "printf ok" },
			matcherValue: "Bash",
		});

		expect(result.decision).toBe("allow");
		expect(captured?.event.snapshotId).toBe(createRuntimeId("snapshot", "hook-runtime"));
		expect(captured?.invocation.tool.kind).toBe("hook");
		expect(captured?.invocation.tool.resourceId).toBe(definition.resourceId);
	});

	it("composes the real pipeline and managed process through the Host resource gate", async () => {
		const definition = hook();
		const sessionId = createRuntimeId("session", "hook-composition");
		const snapshotId = createRuntimeId("snapshot", "hook-composition");
		const handle: ExecutionHandleRef = {
			authorityId: createRuntimeId("authority", "hook-composition"),
			tenantId: createRuntimeId("tenant", "hook-composition"),
			workspaceId: createRuntimeId("workspace", "hook-composition"),
			sessionId,
			hostGeneration: 1,
			sessionGeneration: 1,
			executionId: createRuntimeId("execution", "hook-composition"),
			attemptId: createRuntimeId("attempt", "hook-composition"),
			revision: 1,
			requestDigest: runtimeDigest("hook-composition"),
		};
		let authorized = 0;
		let started = 0;
		const managedProcess: ManagedHookProcess = {
			start: async () => { started += 1; return { ok: true, handle, summary: { state: "running" } }; },
			processOutput: async (_handle, cursor): Promise<ControlPlaneOutputResult> => {
				const text = cursor.byteOffset === 0 ? '{"decision":"allow"}' : "";
				const next = { sequence: 1, byteOffset: Buffer.byteLength(text, "utf8") };
				return { ok: true, page: { handle, startCursor: cursor, endCursor: next, nextCursor: next, text, truncated: false }, head: next };
			},
			processWait: async (): Promise<ControlPlaneWaitResult> => ({ ok: true, outcome: "terminal", summary: { state: "completed" } as never, nextCursor: { sequence: 1, byteOffset: 20 } }),
			stop: async () => ({ ok: true, operation: "stop", receiptDigest: runtimeDigest("hook-stop"), summary: { state: "killed" } as never }),
		};
		const runtime = createProductionHostHookRuntime({
			sessionId,
			cwd: "/workspace/hooks",
			managedProcess,
			extensionManager: {
				currentHooks: () => [definition],
				beginTurn: () => ({ snapshotId, generation: 1, createdAt: "2026-08-05T00:00:00.000Z", digest: "a".repeat(64), descriptors: [], diagnostics: [], counts: { plugins: 0, skills: 0, hooks: 1, mcpServers: 0, mcpTools: 0, ready: 1, blocked: 0, disabled: 0, error: 0 } }),
				endTurn: async () => undefined,
			},
			security: {
				authorizeResource: async () => {
					authorized += 1;
					return { ok: true, value: { authorization: { outcome: "allow", decisionSource: "policy", requests: [], policyDigest: runtimeDigest("policy"), reason: "fixture" }, authorizationDigest: runtimeDigest("authorization") } };
				},
			},
			identity: {
				authorityId: createRuntimeId("authority", "hook-composition"),
				tenantId: createRuntimeId("tenant", "hook-composition"),
				principalId: createRuntimeId("principal", "hook-composition"),
				principalKind: "local",
				issuedAt: "2026-08-05T00:00:00.000Z",
			},
			adapter: { adapterId: "runledger.test.hooks", generation: 1, configDigest: runtimeDigest("hooks") },
		});

		const result = await runtime.run({ event: "PreToolUse", sessionId, snapshotId, input: { value: "ok" } });
		expect(result.decision).toBe("allow");
		expect(started).toBe(1);
		expect(authorized).toBe(1);
	});
});
