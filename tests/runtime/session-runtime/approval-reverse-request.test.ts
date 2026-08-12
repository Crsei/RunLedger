import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRuntimeId, type ConnectionId, type SessionId } from "../../../src/runtime/protocol/ids.ts";
import type { OwnerFence } from "../../../src/runtime/session-owner/types.ts";
import type { SessionFrameEnvelope } from "../../../src/runtime/session-server/protocol.ts";
import { createApprovalReceipt } from "../../../src/security/permission/approval-coordinator.ts";
import type { PermissionPrompt } from "../../../src/security/types.ts";
import { runtimeDigest } from "../../../src/runtime/protocol/foundation.ts";
import { openSessionDatabase } from "../../../src/storage/session-store/database.ts";
import { installSessionStoreSchema } from "../../../src/storage/session-store/schema.ts";
import { SessionStore } from "../../../src/storage/session-store/session-store.ts";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

interface ApprovalModule {
	LateBoundHumanInputWaitPort?: new () => {
		bind(port: { withHumanInputWait<T>(waitId: string, reason: "approval" | "credential", operation: () => Promise<T>): Promise<T> }): void;
		withHumanInputWait<T>(waitId: string, reason: "approval" | "credential", operation: () => Promise<T>): Promise<T>;
	};
	createSessionApprovalPorts(options: {
		readonly store: SessionStore;
		readonly fence: OwnerFence;
		readonly sender: {
			requestToConnection(connectionId: ConnectionId, request: { readonly kind: string; readonly body: Record<string, unknown> }, timeoutMs?: number): Promise<SessionFrameEnvelope>;
		};
		readonly driverConnectionId: () => ConnectionId | undefined;
		readonly pollIntervalMs?: number;
		readonly humanInputWait?: {
			withHumanInputWait<T>(waitId: string, reason: "approval" | "credential", operation: () => Promise<T>): Promise<T>;
		};
	}): {
		readonly prompter: { request(prompt: PermissionPrompt, signal?: AbortSignal): Promise<Record<string, unknown>> };
		readonly stateStore: {
			read(approvalId: string): Promise<unknown>;
			commit(receipt: ReturnType<typeof createApprovalReceipt>, expectedRevision: number): Promise<{ readonly ok: boolean }>;
		};
		readonly audit: {
			requested(input: { readonly request: Record<string, unknown>; readonly ticket: Record<string, unknown> }): Promise<void>;
		};
	};
}

async function loadModule(): Promise<ApprovalModule | undefined> {
	const path = join(process.cwd(), "src/runtime/session-runtime/approval-reverse-request.ts");
	expect(existsSync(path), "S3 durable approval reverse-request module must exist").toBe(true);
	if (!existsSync(path)) return undefined;
	const specifier = "../../../src/runtime/session-runtime/approval-reverse-request.ts";
	return await import(specifier) as ApprovalModule;
}

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "runledger-session-approval-"));
	roots.push(root);
	const db = openSessionDatabase(join(root, "state.db"));
	installSessionStoreSchema(db);
	const store = new SessionStore(db);
	const sessionId = createRuntimeId("session", "approval-reverse") as SessionId;
	store.createSession({
		sessionId,
		workspaceId: createRuntimeId("workspace", "approval-reverse"),
		repositoryId: createRuntimeId("repository", "approval-reverse"),
		settingsDigest: "d".repeat(64),
	});
	const fence: OwnerFence = { sessionId, runtimeId: createRuntimeId("runtime", "approval-reverse"), generation: 4 };
	store.database().runSync(
		"INSERT INTO session_owners (session_id, runtime_id, generation, state, updated_at_ms) VALUES (?, ?, ?, 'running', 1)",
		[sessionId, fence.runtimeId, fence.generation],
	);
	return { store, fence, close: () => db.close() };
}

function prompt(sessionId: SessionId, expiresInMs = 5_000): PermissionPrompt {
	return {
		requestId: createRuntimeId("command", "approval-reverse"),
		sessionId,
		toolCallId: createRuntimeId("toolCall", "approval-reverse"),
		toolName: "write",
		summary: "write filesystem target",
		requests: [{ kind: "filesystem", operation: "write", path: "file.ts" }],
		argumentsDigest: runtimeDigest({ path: "file.ts" }),
		cwd: "/workspace",
		policyDigest: runtimeDigest({ policy: "approval-reverse" }),
		createdAt: new Date().toISOString(),
		expiresAt: new Date(Date.now() + expiresInMs).toISOString(),
	};
}

function response(body: Record<string, unknown>): SessionFrameEnvelope {
	return { frameId: "reverse_response_approval", kind: "reverse_response", protocolVersion: 3, body };
}

describe("Session durable approval reverse requests", () => {
	it("persists request, decision receipt, and allow-once revocation in the Session event chain", async () => {
		const module = await loadModule();
		if (module === undefined) return;
		const value = await fixture();
		const ports = module.createSessionApprovalPorts({
			store: value.store,
			fence: value.fence,
			sender: { requestToConnection: async () => response({ ok: true, decision: "allow-once" }) },
			driverConnectionId: () => createRuntimeId("connection", "approval-driver"),
		});
		const ticket = {
			approvalId: createRuntimeId("approval", "approval-reverse"),
			requestDigest: runtimeDigest({ request: "approval-reverse" }),
			scope: "once" as const,
			status: "pending" as const,
			principalId: createRuntimeId("principal", "requester"),
			createdAt: new Date().toISOString(),
			expiresAt: new Date(Date.now() + 5_000).toISOString(),
		};
		await ports.audit.requested({ request: { toolName: "write", argumentsDigest: runtimeDigest("args"), snapshot: { policyDigest: runtimeDigest("policy") } }, ticket });
		const receipt = createApprovalReceipt(ticket, { decision: "allow-once", decidedBy: createRuntimeId("principal", "approval-driver") });
		expect(await ports.stateStore.commit(receipt, 0)).toMatchObject({ ok: true });
		expect(await ports.stateStore.read(ticket.approvalId)).toMatchObject({ decision: "allowed", decisionRevision: 1 });
		const revoked = { ...receipt, decision: "revoked" as const, decisionRevision: 2, receiptId: createRuntimeId("receipt", "approval-revoked"), receiptDigest: runtimeDigest({ revoked: true }) };
		expect(await ports.stateStore.commit(revoked, 1)).toMatchObject({ ok: true });
		expect(value.store.replaySessionEvents(value.fence.sessionId).map((event) => event.eventType)).toEqual([
			"approval.requested",
			"approval.decided",
			"approval.revoked",
		]);
		value.close();
	});

	it("retries on a newly claimed driver before expiry and rejects an old-generation response", async () => {
		const module = await loadModule();
		if (module === undefined) return;
		const value = await fixture();
		let driver = createRuntimeId("connection", "old-driver") as ConnectionId | undefined;
		const seen: string[] = [];
		const ports = module.createSessionApprovalPorts({
			store: value.store,
			fence: value.fence,
			driverConnectionId: () => driver,
			pollIntervalMs: 5,
			sender: {
				requestToConnection: async (connectionId) => {
					seen.push(connectionId);
					if (connectionId.endsWith("old-driver")) {
						driver = undefined;
						setTimeout(() => { driver = createRuntimeId("connection", "new-driver"); }, 10);
						throw new Error("connection closed");
					}
					return response({ ok: true, decision: "allow-once" });
				},
			},
		});
		await expect(ports.prompter.request(prompt(value.fence.sessionId))).resolves.toMatchObject({ decision: "allow-once" });
		expect(seen).toEqual(["connection_old-driver", "connection_new-driver"]);

		const stalePorts = module.createSessionApprovalPorts({
			store: value.store,
			fence: value.fence,
			driverConnectionId: () => createRuntimeId("connection", "new-driver"),
			sender: {
				requestToConnection: async () => {
					value.store.database().runSync("UPDATE session_owners SET generation = 5, runtime_id = ? WHERE session_id = ?", [createRuntimeId("runtime", "new-generation"), value.fence.sessionId]);
					return response({ ok: true, decision: "allow-once" });
				},
			},
		});
		await expect(stalePorts.prompter.request(prompt(value.fence.sessionId))).rejects.toThrow(/generation|fenced|stale/u);
		value.close();
	});

	it("fails closed when no driver appears before expiry or the request is aborted", async () => {
		const module = await loadModule();
		if (module === undefined) return;
		const value = await fixture();
		const ports = module.createSessionApprovalPorts({
			store: value.store,
			fence: value.fence,
			driverConnectionId: () => undefined,
			pollIntervalMs: 2,
			sender: {
				requestToConnection: async () => response({ ok: true, decision: "allow-once" }),
			},
		});

		await expect(ports.prompter.request(prompt(value.fence.sessionId, 15))).rejects.toThrow(/timed out/u);
		const abort = new AbortController();
		const pending = ports.prompter.request(prompt(value.fence.sessionId, 5_000), abort.signal);
		abort.abort();
		await expect(pending).rejects.toThrow(/aborted/u);
		value.close();
	});

	it("wraps the complete approval request in the Runtime human-wait boundary", async () => {
		const module = await loadModule();
		if (module === undefined) return;
		const value = await fixture();
		const waits: string[] = [];
		const ports = module.createSessionApprovalPorts({
			store: value.store,
			fence: value.fence,
			driverConnectionId: () => createRuntimeId("connection", "approval-driver"),
			sender: { requestToConnection: async () => response({ ok: true, decision: "allow-once" }) },
			humanInputWait: {
				withHumanInputWait: async (waitId, reason, operation) => {
					waits.push(`begin:${reason}:${waitId}`);
					try {
						return await operation();
					} finally {
						waits.push(`end:${reason}:${waitId}`);
					}
				},
			},
		});

		await expect(ports.prompter.request(prompt(value.fence.sessionId))).resolves.toMatchObject({ decision: "allow-once" });
		expect(waits).toEqual([
			"begin:approval:approval-command_approval-reverse",
			"end:approval:approval-command_approval-reverse",
		]);
		value.close();
	});

	it("fails closed before the Runtime wait port binds and delegates after binding", async () => {
		const module = await loadModule();
		if (module === undefined) return;
		expect(module.LateBoundHumanInputWaitPort).toBeTypeOf("function");
		if (module.LateBoundHumanInputWaitPort === undefined) return;
		const port = new module.LateBoundHumanInputWaitPort();
		await expect(port.withHumanInputWait("approval-before-bind", "approval", async () => "unexpected"))
			.rejects.toThrow(/unavailable|not bound/u);
		const calls: string[] = [];
		port.bind({
			withHumanInputWait: async (waitId, reason, operation) => {
				calls.push(`${reason}:${waitId}`);
				return operation();
			},
		});
		await expect(port.withHumanInputWait("approval-after-bind", "approval", async () => "ok")).resolves.toBe("ok");
		expect(calls).toEqual(["approval:approval-after-bind"]);
	});

	it("round-trips session, exec-prefix, and exact network decisions without changing Runtime events", async () => {
		const module = await loadModule();
		if (module === undefined) return;
		const value = await fixture();
		const decisions = [
			{ decision: "allow-session" },
			{ decision: "allow-with-prefix-rule", prefixRule: ["npm", "test"] },
			{ decision: "allow-with-network-rule", host: "api.example", protocol: "https", port: 8443 },
		] as const;
		const sent: Record<string, unknown>[] = [];
		let index = 0;
		const ports = module.createSessionApprovalPorts({
			store: value.store,
			fence: value.fence,
			driverConnectionId: () => createRuntimeId("connection", "approval-driver"),
			sender: {
				requestToConnection: async (_connectionId, request) => {
					sent.push(request.body);
					return response({ ok: true, ...decisions[index++]! });
				},
			},
		});
		for (const decision of decisions) {
			await expect(ports.prompter.request(prompt(value.fence.sessionId))).resolves.toMatchObject(decision);
		}
		expect(sent[0]).toMatchObject({ requests: [{ kind: "filesystem", operation: "write", path: "file.ts" }] });
		expect(value.store.replaySessionEvents(value.fence.sessionId)).toEqual([]);
		value.close();
	});

	it("atomically persists an exec-prefix amendment in the Session event chain", async () => {
		const module = await loadModule();
		if (module === undefined) return;
		const value = await fixture();
		const ports = module.createSessionApprovalPorts({
			store: value.store,
			fence: value.fence,
			driverConnectionId: () => createRuntimeId("connection", "approval-driver"),
			sender: { requestToConnection: async () => response({ ok: true, decision: "allow-once" }) },
		});
		const stateStore = ports.stateStore as typeof ports.stateStore & {
			commitWithExecPrefixRule(receipt: ReturnType<typeof createApprovalReceipt>, expectedRevision: number, rule: Record<string, unknown>): Promise<{ readonly ok: boolean }>;
			findExecPrefixApproval(input: Record<string, unknown>): Promise<unknown>;
		};
		const ticket = {
			approvalId: createRuntimeId("approval", "session-prefix"), requestDigest: runtimeDigest("session-prefix-request"),
			scope: "session" as const, status: "pending" as const, principalId: createRuntimeId("principal", "requester"),
			createdAt: new Date().toISOString(),
		};
		const receipt = createApprovalReceipt(ticket, { decision: "allow-session", decidedBy: createRuntimeId("principal", "approval-driver") });
		const rule = { sessionId: value.fence.sessionId, policyDigest: runtimeDigest("session-prefix-policy"), prefix: ["npm", "test"] };
		expect(await stateStore.commitWithExecPrefixRule(receipt, 0, rule)).toMatchObject({ ok: true });
		expect(await stateStore.findExecPrefixApproval({ sessionId: value.fence.sessionId, policyDigest: rule.policyDigest, command: "npm test -- run" })).toMatchObject({ receipt, rule });
		expect(value.store.replaySessionEvents(value.fence.sessionId)).toHaveLength(1);
		value.close();
	});
});
