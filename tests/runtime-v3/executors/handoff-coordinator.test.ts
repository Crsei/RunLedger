import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalDigest } from "../../../src/runtime/protocol/v3/canonical-json.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/v3/ids.ts";
import {
	createDurableSessionHandoffIntent,
	DurableSessionHandoffCoordinator,
	FileSessionHandoffAuthority,
	MemorySessionHandoffAuthority,
	type DurableSessionHandoffIntent,
	type SessionHandoffAuthorityPort,
	type SessionHandoffLifecycleEventPort,
} from "../../../src/runtime/executors/handoff-coordinator.ts";
import type { ExecutorPortResult, SessionHandoffPort } from "../../../src/runtime/executors/ports.ts";
import { handoff, handoffReceipt } from "./helpers.ts";

const roots: string[] = [];

function intent(): DurableSessionHandoffIntent {
	const manifest = handoff();
	const value = createDurableSessionHandoffIntent({
		manifest,
		sourceRuntimeGeneration: 4,
		targetAuthorityId: createRuntimeId("authority", "handoff-target"),
		targetTenantId: manifest.tenantId,
		targetRuntimeId: createRuntimeId("runtime", "handoff-target"),
		targetRuntimeGeneration: 5,
		attestationReceiptId: createRuntimeId("receipt", "handoff-attestation"),
		attestationReceiptDigest: canonicalDigest("handoff-attestation"),
		sourceFenceIntentDigest: canonicalDigest("handoff-source-fence"),
	});
	if (!value.ok) throw new Error(value.error.reasonDigest);
	return value.value;
}

class Lifecycle implements SessionHandoffLifecycleEventPort {
	public readonly order: string[] = [];
	public failCommitOnce = false;

	private ok(seed: string): ExecutorPortResult<{ eventDigest: string }> {
		return { ok: true, value: { eventDigest: canonicalDigest(seed) } };
	}

	public async recordRequested() {
		this.order.push("requested");
		return this.ok("handoff-requested");
	}

	public async recordCommitted() {
		this.order.push("committed");
		if (this.failCommitOnce) {
			this.failCommitOnce = false;
			return {
				ok: false as const,
				error: {
					code: "durable_write_failed" as const,
					retryable: true,
					reasonDigest: canonicalDigest("handoff commit ack lost"),
					outcomeCertain: false,
				},
			};
		}
		return this.ok("handoff-committed");
	}

	public async recordFailed() {
		this.order.push("failed");
		return this.ok("handoff-failed");
	}
}

function coordinator(options: {
	authority?: SessionHandoffAuthorityPort;
	lifecycle?: Lifecycle;
	transport: SessionHandoffPort;
	order?: string[];
}) {
	const order = options.order ?? [];
	return {
		authority: options.authority ?? new MemorySessionHandoffAuthority(),
		lifecycle: options.lifecycle ?? new Lifecycle(),
		order,
		create(authority: SessionHandoffAuthorityPort, lifecycle: Lifecycle) {
			return new DurableSessionHandoffCoordinator({
				authority,
				lifecycle,
				transport: options.transport,
				attestor: {
					verify: async (value) => ({
						ok: true,
						value: { receiptDigest: value.attestationReceiptDigest },
					}),
				},
				generations: { current: async () => ({ ok: true, value: 4 }) },
				sourceFence: {
					fenceAndDrain: async () => {
						order.push("source_fenced");
						return {
							ok: true,
							value: {
								receiptId: createRuntimeId("receipt", "handoff-source-fenced"),
								receiptDigest: canonicalDigest("handoff-source-fenced"),
							},
						};
					},
				},
			});
		},
	};
}

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("durable session handoff coordinator", () => {
	it("commits target authority before fencing and draining the source runtime", async () => {
		const order: string[] = [];
		let transfers = 0;
		const fixture = coordinator({
			order,
			transport: {
				transfer: async (manifest) => {
					transfers += 1;
					order.push("target_accepted");
					return { ok: true, value: handoffReceipt(manifest) };
				},
			},
		});
		const runtime = fixture.create(fixture.authority, fixture.lifecycle);
		const result = await runtime.handoff(intent());
		expect(result).toMatchObject({ ok: true, value: { terminal: { transferReceipt: { status: "accepted" } } } });
		expect(transfers).toBe(1);
		expect(order).toEqual(["target_accepted", "source_fenced"]);
		expect(fixture.lifecycle.order).toEqual(["requested", "committed"]);
	});

	it("replays a persisted target receipt after commit-event ack loss without transferring twice", async () => {
		let transfers = 0;
		const authority = new MemorySessionHandoffAuthority();
		const lifecycle = new Lifecycle();
		lifecycle.failCommitOnce = true;
		const fixture = coordinator({
			authority,
			lifecycle,
			transport: {
				transfer: async (manifest) => {
					transfers += 1;
					return { ok: true, value: handoffReceipt(manifest) };
				},
			},
		});
		const runtime = fixture.create(authority, lifecycle);
		const value = intent();
		expect(await runtime.handoff(value)).toMatchObject({ ok: false, error: { code: "durable_write_failed" } });
		expect(await runtime.handoff(value)).toMatchObject({ ok: true });
		expect(transfers).toBe(1);
		expect(fixture.order).toEqual(["source_fenced"]);
	});

	it("quarantines unknown transfer outcomes and never fences the source", async () => {
		const fixture = coordinator({
			transport: {
				transfer: async () => {
					throw new Error("transfer ack lost");
				},
			},
		});
		const runtime = fixture.create(fixture.authority, fixture.lifecycle);
		expect(await runtime.handoff(intent())).toMatchObject({
			ok: false,
			error: { code: "reconciliation_required", outcomeCertain: false },
		});
		expect(fixture.order).toEqual([]);
		expect(fixture.lifecycle.order).toEqual(["requested", "failed"]);
		expect(await runtime.handoff(intent())).toMatchObject({
			ok: false,
			error: { code: "reconciliation_required" },
		});
	});

	it("reopens a completed file authority without repeating transfer or source fencing", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-handoff-authority-"));
		roots.push(root);
		const lifecycle = new Lifecycle();
		const order: string[] = [];
		let transfers = 0;
		const firstAuthority = new FileSessionHandoffAuthority(root);
		const fixture = coordinator({
			authority: firstAuthority,
			lifecycle,
			order,
			transport: {
				transfer: async (manifest) => {
					transfers += 1;
					return { ok: true, value: handoffReceipt(manifest) };
				},
			},
		});
		const value = intent();
		expect(await fixture.create(firstAuthority, lifecycle).handoff(value)).toMatchObject({ ok: true });
		const reopened = new FileSessionHandoffAuthority(root);
		expect(await fixture.create(reopened, lifecycle).handoff(value)).toMatchObject({ ok: true });
		expect(transfers).toBe(1);
		expect(order).toEqual(["source_fenced"]);
		const scope = (await readdir(root))[0]!;
		const files = await readdir(join(root, scope));
		expect(files).toHaveLength(1);
		expect((await stat(join(root, scope, files[0]!))).mode & 0o777).toBe(0o600);
	});
});
