import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	AuthorityDaemonShutdownProtocol,
	resolveAuthorityShutdownAppliedCursor,
	resolveAuthorityShutdownAppliedEffect,
} from "../../../src/daemon/authority-shutdown.ts";
import { createLocalIdentityContext } from "../../../src/runtime/identity/local-principal.ts";
import { canonicalDigest } from "../../../src/runtime/protocol/v3/canonical-json.ts";
import { createIdempotencyKey } from "../../../src/runtime/protocol/v3/coordination.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/v3/ids.ts";
import { AuthorityCommandIdempotencyRepository } from "../../../src/runtime/control-plane/authority-command-idempotency.ts";
import type { CommandClaimRequest, CommandClaimToken } from "../../../src/runtime/control-plane/idempotency.ts";
import { ShutdownCoordinator } from "../../../src/runtime/control-plane/shutdown.ts";
import { controlPlaneCommandDigest, type ControlPlaneRequestContext, type ShutdownCommand } from "../../../src/runtime/control-plane/types.ts";
import { AuthorityRuntimeManager } from "../../../src/storage/authority-runtime-manager.ts";

const NOW = new Date("2026-07-22T15:00:00.000Z");
const roots: string[] = [];
const managers: AuthorityRuntimeManager[] = [];

afterEach(async () => {
	await Promise.all(managers.splice(0).map((manager) => manager.close().catch(() => undefined)));
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function claimToken(result: Awaited<ReturnType<AuthorityCommandIdempotencyRepository["claim"]>>): CommandClaimToken {
	if (!result.ok || result.value.status !== "claimed") throw new Error("expected a fresh shutdown claim");
	return result.value.claim;
}

describe("authority-backed daemon shutdown", () => {
	it("orders request, command terminal, drain terminal, and restores the exact effect after restart", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-authority-shutdown-"));
		roots.push(root);
		const identity = createLocalIdentityContext(NOW);
		const runtimeId = createRuntimeId("runtime", "authority-shutdown-runtime");
		const manager = await AuthorityRuntimeManager.open({
			cwd: root,
			stateDirectory: join(root, "authority"),
			identity,
			runtimeId,
			clock: () => NOW,
		});
		managers.push(manager);
		const command: ShutdownCommand = {
			kind: "command",
			type: "shutdown",
			commandId: createRuntimeId("command", "authority-shutdown-command"),
			idempotencyKey: createIdempotencyKey("authority-shutdown-idempotency"),
			authorityId: identity.authorityId,
			tenantId: identity.tenantId,
			principalId: identity.principalId,
			expectedSessionRevision: null,
			expectedTurnId: null,
			sessionHandle: null,
			payload: { reasonDigest: canonicalDigest({ reason: "operator" }), drainTimeoutMs: 2_000 },
		};
		const request: CommandClaimRequest = {
			commandId: command.commandId,
			idempotencyKey: command.idempotencyKey,
			commandType: command.type,
			requestDigest: controlPlaneCommandDigest(command),
		};
		const context: ControlPlaneRequestContext = {
			peer: {
				kind: "local",
				transport: "jsonl",
				pid: 1,
				uid: 1000,
				principalId: identity.principalId,
				authenticatedVia: "stdio_parent",
			},
			handshake: {
				kind: "handshake_result",
				requestId: "shutdown-handshake",
				protocol: { major: 1, minor: 0 },
				controlPlaneSchemaVersion: 1,
				runtimeSchemaVersion: 3,
				features: ["shutdown"],
				serverInstanceId: runtimeId,
				remoteAccess: "disabled",
				deliveryGuarantee: "at_least_once",
			},
		};
		const repository = new AuthorityCommandIdempotencyRepository(manager.authorityRepository(), {
			clock: () => NOW,
			resolveAppliedCursor: resolveAuthorityShutdownAppliedCursor,
			resolveAppliedEffect: resolveAuthorityShutdownAppliedEffect,
		});
		const claim = claimToken(await repository.claim(request, {
			authorityId: identity.authorityId,
			tenantId: identity.tenantId,
			principalId: identity.principalId,
			runtimeId,
			runtimeGeneration: 1,
			domain: "daemon",
			subjectSessionId: null,
			domainExpectedRevision: null,
			traceId: createRuntimeId("trace", "authority-shutdown-claim"),
		}));
		const shutdown = new ShutdownCoordinator(() => NOW);
		const protocol = AuthorityDaemonShutdownProtocol.open(manager, shutdown, () => NOW);
		if (!protocol.ok) throw new Error(protocol.error.message);
		const effect = await protocol.value.request(command, context, 1);
		expect(effect).toMatchObject({ ok: true, value: { type: "shutdown", acceptedAt: NOW.toISOString() } });
		if (!effect.ok) throw new Error(effect.error.message);
		const committed = await repository.commit(claim, effect.value);
		expect(committed).toMatchObject({ ok: true });
		if (!committed.ok) throw new Error(committed.error.message);
		protocol.value.committed(command, effect.value, committed.value);
		await shutdown.begin(command.payload.drainTimeoutMs);
		expect(manager.isClosed()).toBe(true);

		const restartedRuntimeId = createRuntimeId("runtime", "authority-shutdown-restart");
		const restarted = await AuthorityRuntimeManager.open({
			cwd: root,
			stateDirectory: join(root, "authority"),
			identity,
			runtimeId: restartedRuntimeId,
			clock: () => NOW,
		});
		managers.push(restarted);
		const events = await restarted.authorityRepository().replay();
		if (!events.ok) throw new Error(events.error.message);
		expect(events.value.events.map((event) => event.type)).toEqual([
			"command.claimed",
			"daemon.shutdown_requested",
			"command.applied",
			"daemon.shutdown_completed",
		]);
		const restored = new AuthorityCommandIdempotencyRepository(restarted.authorityRepository(), {
			clock: () => NOW,
			resolveAppliedCursor: resolveAuthorityShutdownAppliedCursor,
			resolveAppliedEffect: resolveAuthorityShutdownAppliedEffect,
		});
		expect(await restored.lookup(request)).toMatchObject({
			ok: true,
			value: { status: "duplicate", receipt: { result: effect.value } },
		});
	});
});
