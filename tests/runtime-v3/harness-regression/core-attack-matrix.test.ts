import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ArtifactAccessService } from "../../../src/runtime/artifacts/access.ts";
import type {
	ArtifactAccessLogPort,
	ArtifactCapabilityGatewayPort,
} from "../../../src/runtime/artifacts/types.ts";
import { FileCommandIdempotencyRepository } from "../../../src/daemon/durable-command-store.ts";
import { createLocalIdentityContext } from "../../../src/runtime/identity/local-principal.ts";
import { createIdempotencyKey } from "../../../src/runtime/protocol/v3/coordination.ts";
import { createSessionEventStreamRef } from "../../../src/runtime/protocol/v3/events.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/v3/ids.ts";
import {
	isWorkspaceExecutionEnvelope,
	isWorkspaceValidationReceiptForEnvelope,
	workspaceExecutionEnvelopeDigest,
	type WorkspaceExecutionEnvelope,
} from "../../../src/runtime/protocol/v3/workspace.ts";
import { scanJsonlV3EventLog } from "../../../src/runtime/session/jsonl-v3-store.ts";
import { sanitizeTelemetryObservation } from "../../../src/runtime/telemetry/redaction.ts";
import { TELEMETRY_SCHEMA_VERSION } from "../../../src/runtime/telemetry/types.ts";
import { createArtifactHarness, valueOf } from "../artifacts/helpers.ts";
import { rootRegistration, runtimeFakes, spawnRequest } from "../agents/helpers.ts";

const DIGEST = "a".repeat(64);

describe("Harness Regression: core attack matrix", () => {
	it("session corruption: preserves no unverified suffix and reports the first malformed record", () => {
		const scope = {
			authorityId: createRuntimeId("authority", "harness-corruption"),
			tenantId: createRuntimeId("tenant", "harness-corruption"),
			sessionId: createRuntimeId("session", "harness-corruption"),
		};
		const scan = scanJsonlV3EventLog(Buffer.from('{"candidate":"rewrote history"}\n', "utf8"), scope);
		expect(scan.events).toEqual([]);
		expect(scan.firstError).toMatchObject({ code: "invalid_event", line: 0, byteOffset: 0 });
	});

	it("[contract boundary] path escape/cross-workspace envelope rejects receipt reuse after scope substitution", () => {
		const envelope: WorkspaceExecutionEnvelope = {
			authorityId: createRuntimeId("authority", "harness-workspace"),
			tenantId: createRuntimeId("tenant", "harness-workspace"),
			principalId: createRuntimeId("principal", "harness-workspace"),
			sessionId: createRuntimeId("session", "harness-workspace"),
			workspaceId: createRuntimeId("workspace", "harness-workspace"),
			repositoryId: createRuntimeId("repository", "harness-workspace"),
			worktreePath: "/workspace/allowed",
			branch: "harness/attack",
			baseCommit: "1".repeat(40),
			agentId: createRuntimeId("agent", "harness-workspace"),
			toolCallId: createRuntimeId("toolCall", "harness-workspace"),
			traceId: createRuntimeId("trace", "harness-workspace"),
			cwd: "/workspace/allowed",
			ownerRuntimeId: createRuntimeId("runtime", "harness-workspace"),
			leaseRevision: 1,
			fencingToken: "opaque-harness-fence",
		};
		const receipt = {
			authorityId: envelope.authorityId,
			tenantId: envelope.tenantId,
			principalId: envelope.principalId,
			receiptId: createRuntimeId("receipt", "harness-workspace"),
			workspaceId: envelope.workspaceId,
			envelopeDigest: workspaceExecutionEnvelopeDigest(envelope),
			validatorId: createRuntimeId("principal", "workspace-validator"),
			validatedAt: "2026-07-22T00:00:00.000Z",
			outcome: "valid" as const,
		};
		expect(isWorkspaceValidationReceiptForEnvelope(receipt, envelope)).toBe(true);

		const escaped = { ...envelope, cwd: "/etc" };
		const crossWorkspace = { ...envelope, workspaceId: createRuntimeId("workspace", "attacker") };
		// 合同边界：Runtime 不负责文件系统 containment；没有专项签发的新 validation receipt 时必须拒绝 envelope。
		expect(isWorkspaceExecutionEnvelope(escaped)).toBe(true);
		expect(isWorkspaceValidationReceiptForEnvelope(receipt, escaped)).toBe(false);
		expect(isWorkspaceValidationReceiptForEnvelope(receipt, crossWorkspace)).toBe(false);
	});

	it("credential/telemetry leak: exports only allowlisted metadata and drops secret-bearing attributes", () => {
		const sample = sanitizeTelemetryObservation({
			schemaVersion: TELEMETRY_SCHEMA_VERSION,
			authorityId: createRuntimeId("authority", "harness-telemetry"),
			tenantId: createRuntimeId("tenant", "harness-telemetry"),
			principalId: createRuntimeId("principal", "harness-telemetry"),
			sessionId: createRuntimeId("session", "harness-telemetry"),
			traceId: createRuntimeId("trace", "harness-telemetry"),
			name: "runtime.attack_sample",
			severity: "warn",
			observedAt: "2026-07-22T00:00:00.000Z",
			attributes: {
				"event.type": "attack.probed",
				"tool.name": "credential-helper",
				credential: "github-token-secret",
				authorization: "Bearer top-secret",
				"tool.output": "password=hunter2",
				environment: { API_KEY: "secret" },
			},
		});
		expect(sample.ok).toBe(true);
		if (!sample.ok) return;
		expect(sample.value.attributes).toEqual([
			{ key: "event.type", value: "attack.probed" },
			{ key: "tool.name", value: "credential-helper" },
		]);
		expect(JSON.stringify(sample.value)).not.toMatch(/github-token-secret|Bearer|hunter2|API_KEY/u);
	});

	it("cross-tenant read: cannot reach Artifact bytes or the capability gateway", async () => {
		const harness = await createArtifactHarness();
		try {
			const request = harness.request("cross-tenant");
			valueOf(await harness.repository.write(request));
			let gatewayCalls = 0;
			const gateway: ArtifactCapabilityGatewayPort = {
				recheckArtifactAccess: async (candidate) => {
					gatewayCalls += 1;
					return { ok: true, value: { authorityId: candidate.authorityId, tenantId: candidate.tenantId, decision: "allow" } };
				},
			};
			const accessLog: ArtifactAccessLogPort = { append: async () => ({ ok: true, value: undefined }) };
			const access = new ArtifactAccessService({
				cas: harness.cas,
				metadata: harness.metadata,
				gateway,
				accessLog,
				keyProvider: harness.keyProvider,
			});
			const result = await access.read({
				authorityId: request.authorityId,
				tenantId: createRuntimeId("tenant", "attacker"),
				artifactId: request.artifactId,
				principalId: createRuntimeId("principal", "attacker"),
				sessionId: request.source.sessionId,
				workspaceId: request.source.workspaceId,
				capability: "repository_read",
			});
			expect(result).toMatchObject({ ok: false, error: { code: "not_found" } });
			expect(gatewayCalls).toBe(0);
		} finally {
			await harness.cleanup();
		}
	});

	it("multi-agent isolation: rejects a child allocation that aliases the parent workspace", async () => {
		const runtime = runtimeFakes();
		const root = rootRegistration();
		expect((await runtime.supervisor.registerRoot(root)).ok).toBe(true);
		runtime.workspace.sharedWorkspaceId = root.workspaceReceipt.workspaceId;
		const spawned = await runtime.supervisor.spawn(spawnRequest(root.capabilityGrant));
		expect(spawned).toMatchObject({ ok: false, error: { code: "workspace_shared" } });
		expect(runtime.launcher.launches).toHaveLength(0);
		expect(runtime.workspace.releases).toHaveLength(1);
	});

	it("[contract boundary] daemon replay restores a committed receipt as duplicate after repository reopen", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-harness-replay-"));
		try {
			const path = join(root, "commands.jsonl");
			const first = await FileCommandIdempotencyRepository.open(path);
			if (!first.ok) throw new Error(first.error.message);
			const command = {
				commandId: createRuntimeId("command", "harness-replay"),
				idempotencyKey: createIdempotencyKey("harness-replay-key-0001"),
				commandType: "session:stop" as const,
				requestDigest: DIGEST,
			};
			const claim = await first.value.claim(command);
			if (!claim.ok || claim.value.status !== "claimed") throw new Error("command claim failed");
			const sessionId = createRuntimeId("session", "harness-replay");
			const stream = createSessionEventStreamRef(createLocalIdentityContext(), sessionId);
			expect(await first.value.commit(claim.value.claim, {
				type: "session:stop",
				sessionId,
				terminalCursor: {
					stream,
					sequence: 1,
					eventId: createRuntimeId("event", "harness-replay"),
					eventHash: DIGEST,
				},
			})).toMatchObject({ ok: true });

			// 这里只验证 durable idempotency 边界；完整 daemon crash 后的副作用不重放仍需生产级联合 E2E。
			const restarted = await FileCommandIdempotencyRepository.open(path);
			if (!restarted.ok) throw new Error(restarted.error.message);
			expect(await restarted.value.claim(command)).toMatchObject({
				ok: true,
				value: { status: "duplicate", receipt: { result: { type: "session:stop" } } },
			});
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
