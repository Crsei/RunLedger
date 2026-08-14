import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRuntimeId } from "../../../src/runtime/protocol/ids.ts";
import { runtimeDigest } from "../../../src/runtime/protocol/foundation.ts";
import type { OwnerFence } from "../../../src/runtime/session-owner/types.ts";
import { openSessionDatabase } from "../../../src/storage/session-store/database.ts";
import { installSessionStoreSchema } from "../../../src/storage/session-store/schema.ts";
import { SessionStore } from "../../../src/storage/session-store/session-store.ts";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

interface AuditModule {
	createSessionBashClassificationAudit(options: {
		readonly store: SessionStore;
		readonly fence: OwnerFence;
	}): {
		record(record: Record<string, unknown>): Promise<void>;
		link(record: Record<string, unknown>): Promise<void>;
	};
}

async function loadModule(): Promise<AuditModule | undefined> {
	const path = join(process.cwd(), "src/runtime/session-runtime/bash-classification-audit.ts");
	expect(existsSync(path), "Session durable Bash classification audit module must exist").toBe(true);
	if (!existsSync(path)) return undefined;
	const specifier = "../../../src/runtime/session-runtime/bash-classification-audit.ts";
	return await import(specifier) as AuditModule;
}

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "runledger-bash-audit-"));
	roots.push(root);
	const db = openSessionDatabase(join(root, "state.db"));
	installSessionStoreSchema(db);
	const store = new SessionStore(db);
	const sessionId = createRuntimeId("session", "bash-audit");
	store.createSession({
		sessionId,
		workspaceId: createRuntimeId("workspace", "bash-audit"),
		repositoryId: createRuntimeId("repository", "bash-audit"),
		settingsDigest: "d".repeat(64),
	});
	const fence: OwnerFence = {
		sessionId,
		runtimeId: createRuntimeId("runtime", "bash-audit"),
		generation: 3,
	};
	store.database().runSync(
		"INSERT INTO session_owners (session_id, runtime_id, generation, state, updated_at_ms) VALUES (?, ?, ?, 'running', 1)",
		[sessionId, fence.runtimeId, fence.generation],
	);
	return { store, fence, close: () => db.close() };
}

describe("Session durable Bash classification audit", () => {
	it("appends redacted classification and authorization linkage to the fenced Event Store", async () => {
		const module = await loadModule();
		if (module === undefined) return;
		const value = await fixture();
		try {
			const audit = module.createSessionBashClassificationAudit(value);
			const requestDigest = "a".repeat(64);
			await audit.record({
				protocolVersion: 1,
				sessionId: value.fence.sessionId,
				toolCallId: createRuntimeId("toolCall", "bash-audit"),
				requestDigest,
				commandDigest: "b".repeat(64),
				accessRequestsDigest: "c".repeat(64),
				mode: "ast",
				classification: "simple",
				configDigest: "d".repeat(64),
				parserDigest: "e".repeat(64),
				durationBucket: "0-10ms",
				nodeCountBucket: "0-100",
				authorizationOutcome: "allow",
				approvalReceiptId: createRuntimeId("receipt", "bash-approval"),
			});
			await audit.link({
				protocolVersion: 1,
				sessionId: value.fence.sessionId,
				requestDigest,
				constraintSnapshotDigest: runtimeDigest("constraint").digest,
				sandboxReceiptDigest: runtimeDigest("sandbox").digest,
			});
			await audit.record({
				protocolVersion: 1,
				sessionId: value.fence.sessionId,
				toolCallId: createRuntimeId("toolCall", "bash-audit"),
				requestDigest,
				commandDigest: "b".repeat(64),
				accessRequestsDigest: "c".repeat(64),
				mode: "ast",
				classification: "simple",
				configDigest: "d".repeat(64),
				parserDigest: "e".repeat(64),
				durationBucket: "0-10ms",
				nodeCountBucket: "0-100",
				authorizationOutcome: "allow",
				approvalReceiptId: createRuntimeId("receipt", "bash-approval"),
			});

			const events = value.store.replaySessionEvents(value.fence.sessionId);
			expect(events.map((event) => event.eventType)).toEqual([
				"security.bash_classified",
				"security.bash_authorized",
			]);
			const payloads = events.map((event) => JSON.parse(event.payloadJson) as Record<string, unknown>);
			expect(payloads[0]).toMatchObject({
				requestDigest,
				accessRequestsDigest: "c".repeat(64),
				authorizationOutcome: "allow",
				approvalReceiptId: createRuntimeId("receipt", "bash-approval"),
			});
			expect(payloads[1]).toMatchObject({
				requestDigest,
				sandboxReceiptDigest: runtimeDigest("sandbox").digest,
			});
			expect(JSON.stringify(payloads)).not.toContain("secret-command");
		} finally {
			value.close();
		}
	});
});
