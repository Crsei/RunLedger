import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalDigest } from "../../../src/runtime/protocol/v3/canonical-json.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/v3/ids.ts";
import {
	DurableRemoteExecutionService,
	FileRemoteExecutionAuthorityRepository,
	MemoryRemoteExecutionAuthorityRepository,
	type RemoteExecutionCanonicalEventPort,
} from "../../../src/runtime/executors/execution-authority.ts";
import type {
	AcceptedRemoteExecution,
	ExecutorPortResult,
} from "../../../src/runtime/executors/ports.ts";
import type { RemoteExecutorInvocation } from "../../../src/runtime/executors/types.ts";
import { invocation, result, verification } from "./helpers.ts";

const roots: string[] = [];
const runtimeId = createRuntimeId("runtime", "remote-authority");
const agentId = createRuntimeId("agent", "remote-authority");

class Events implements RemoteExecutionCanonicalEventPort {
	public requested = 0;
	public terminal = 0;
	public failTerminalOnce = false;

	public async recordRequested(): Promise<ExecutorPortResult<{ eventDigest: string }>> {
		this.requested += 1;
		return { ok: true, value: { eventDigest: canonicalDigest({ kind: "requested" }) } };
	}

	public async recordTerminal(): Promise<ExecutorPortResult<{ eventDigest: string }>> {
		this.terminal += 1;
		if (this.failTerminalOnce) {
			this.failTerminalOnce = false;
			return {
				ok: false,
				error: {
					code: "durable_write_failed",
					retryable: true,
					reasonDigest: canonicalDigest("terminal event ack lost"),
					outcomeCertain: false,
				},
			};
		}
		return { ok: true, value: { eventDigest: canonicalDigest({ kind: "terminal" }) } };
	}
}

function accepted(request: RemoteExecutorInvocation): AcceptedRemoteExecution {
	const execution = result(request);
	return { result: execution, attestationVerification: verification(request, execution) };
}

function service(options: {
	repository: MemoryRemoteExecutionAuthorityRepository | FileRemoteExecutionAuthorityRepository;
	events: Events;
	execute: (request: RemoteExecutorInvocation) => Promise<ExecutorPortResult<AcceptedRemoteExecution>>;
	generation?: number;
}) {
	return new DurableRemoteExecutionService({
		repository: options.repository,
		events: options.events,
		gateway: { execute: options.execute },
		runtimeId,
		runtimeGeneration: options.generation ?? 7,
		agentId,
		clock: () => new Date("2026-07-24T00:00:00.000Z"),
	});
}

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("durable remote execution authority", () => {
	it("persists before effect and returns the original bounded effect for exact duplicates", async () => {
		const repository = new MemoryRemoteExecutionAuthorityRepository();
		const events = new Events();
		let calls = 0;
		const runtime = service({
			repository,
			events,
			execute: async (request) => {
				calls += 1;
				const stored = await repository.load(request.authorityId, request.tenantId, request.requestId);
				expect(stored).toMatchObject({ ok: true, value: { state: "effect_pending", runtimeGeneration: 7 } });
				return { ok: true, value: accepted(request) };
			},
		});
		const request = invocation();
		const first = await runtime.execute(request);
		expect(first).toMatchObject({ ok: true, value: { state: "succeeded", effect: { result: { status: "succeeded" } } } });
		const replay = await runtime.execute(request);
		expect(replay).toEqual(first);
		expect(calls).toBe(1);
		expect(events).toMatchObject({ requested: 1, terminal: 1 });
	});

	it("repairs terminal event acknowledgement loss without repeating the external effect", async () => {
		const repository = new MemoryRemoteExecutionAuthorityRepository();
		const events = new Events();
		events.failTerminalOnce = true;
		let calls = 0;
		const request = invocation();
		const first = await service({
			repository,
			events,
			execute: async (value) => {
				calls += 1;
				return { ok: true, value: accepted(value) };
			},
		}).execute(request);
		expect(first).toMatchObject({ ok: false, error: { code: "durable_write_failed" } });
		expect(await repository.load(request.authorityId, request.tenantId, request.requestId))
			.toMatchObject({ ok: true, value: { state: "terminal_pending" } });

		const resumed = await service({
			repository,
			events,
			execute: async () => {
				throw new Error("effect must not repeat");
			},
		}).execute(request);
		expect(resumed).toMatchObject({ ok: true, value: { state: "succeeded" } });
		expect(calls).toBe(1);
		expect(events.terminal).toBe(2);
	});

	it("quarantines unknown outcomes and rejects changed input or old generation replay", async () => {
		const repository = new MemoryRemoteExecutionAuthorityRepository();
		const events = new Events();
		const request = invocation();
		const uncertain = await service({
			repository,
			events,
			execute: async () => ({
				ok: false,
				error: {
					code: "unavailable",
					retryable: true,
					reasonDigest: canonicalDigest("ack lost"),
				},
			}),
		}).execute(request);
		expect(uncertain).toMatchObject({ ok: false, error: { code: "reconciliation_required", outcomeCertain: false } });
		expect(await repository.load(request.authorityId, request.tenantId, request.requestId))
			.toMatchObject({ ok: true, value: { state: "reconciliation_required" } });

		const changed = { ...request, egressPolicyDigest: "f".repeat(64) };
		expect(await service({
			repository,
			events,
			execute: async () => { throw new Error("must not execute"); },
		}).execute(changed)).toMatchObject({ ok: false, error: { code: "conflict" } });
		expect(await service({
			repository,
			events,
			generation: 8,
			execute: async () => { throw new Error("must not execute"); },
		}).execute(request)).toMatchObject({ ok: false, error: { code: "conflict" } });
	});

	it("reopens a file authority record with 0600 data and fails closed on corruption/cross-tenant lookup", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-remote-authority-"));
		roots.push(root);
		const repository = new FileRemoteExecutionAuthorityRepository(root);
		const events = new Events();
		const request = invocation();
		const completed = await service({
			repository,
			events,
			execute: async (value) => ({ ok: true, value: accepted(value) }),
		}).execute(request);
		expect(completed).toMatchObject({ ok: true, value: { state: "succeeded" } });

		const reopened = new FileRemoteExecutionAuthorityRepository(root);
		expect(await reopened.load(request.authorityId, request.tenantId, request.requestId))
			.toMatchObject({ ok: true, value: { state: "succeeded", revision: 4 } });
		expect(await reopened.load(
			request.authorityId,
			createRuntimeId("tenant", "foreign"),
			request.requestId,
		)).toMatchObject({ ok: false, error: { code: "not_found" } });

		const directories = await readdir(root);
		const files = (await Promise.all(directories.map(async (directory) =>
			(await readdir(join(root, directory))).map((file) => join(root, directory, file)),
		))).flat().filter((file) => file.endsWith(".json"));
		expect(files).toHaveLength(1);
		expect((await stat(files[0]!)).mode & 0o777).toBe(0o600);
		const original = await readFile(files[0]!, "utf8");
		await writeFile(files[0]!, `${original.slice(0, -1)}x`, { mode: 0o600 });
		expect(await reopened.load(request.authorityId, request.tenantId, request.requestId))
			.toMatchObject({ ok: false, error: { code: "corrupt_record" } });
	});
});
