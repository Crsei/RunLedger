import { describe, expect, it, vi } from "vitest";
import { canonicalDigest } from "../../../src/runtime/protocol/v3/canonical-json.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/v3/ids.ts";
import {
	createAuthorityTenantEventStreamRef,
	createSessionEventStreamRef,
	type EventCursor,
} from "../../../src/runtime/protocol/v3/events.ts";
import {
	SessionRuntimeRegistry,
	type CandidateAuthorityBinding,
	type ManagedSessionRuntime,
	type RuntimeGenerationTransitionPort,
} from "../../../src/runtime/control-plane/session-registry.ts";
import { ShutdownCoordinator } from "../../../src/runtime/control-plane/shutdown.ts";
import { controlPlaneFailure } from "../../../src/runtime/control-plane/errors.ts";

const SESSION_ONE = createRuntimeId("session", "one");
const SESSION_TWO = createRuntimeId("session", "two");
const AUTHORITY_ID = createRuntimeId("authority", "replacement-registry");
const TENANT_ID = createRuntimeId("tenant", "replacement-registry");
const AUTHORITY_STREAM = createAuthorityTenantEventStreamRef({ authorityId: AUTHORITY_ID, tenantId: TENANT_ID });

function runtime(sessionId: typeof SESSION_ONE, teardown: () => Promise<void>): ManagedSessionRuntime {
	return {
		sessionId,
		head: () => null,
		teardown: async () => {
			await teardown();
			return { ok: true, value: undefined };
		},
	};
}

function authorityCursor(sequence: number, seed: string): EventCursor {
	return {
		stream: AUTHORITY_STREAM,
		sequence,
		eventId: createRuntimeId("event", seed),
		eventHash: canonicalDigest({ sequence, seed }),
	};
}

function binding(generation: number): CandidateAuthorityBinding {
	return {
		runtimeId: createRuntimeId("runtime", `candidate-${generation}`),
		generation,
		compositionReceiptId: createRuntimeId("compositionReceipt", `candidate-${generation}`),
		compositionDigest: canonicalDigest({ generation, kind: "composition" }),
		fencingIntentDigest: canonicalDigest({ generation, kind: "fencing-intent" }),
	};
}

function governedRuntime(
	sessionId: typeof SESSION_ONE,
	generation: number,
	order: string[],
	teardownResult: () => ReturnType<typeof controlPlaneFailure<void>> | { ok: true; value: undefined } = () => ({
		ok: true,
		value: undefined,
	}),
): ManagedSessionRuntime {
	return {
		sessionId,
		head: () => {
			order.push(`probe:${generation}`);
			return null;
		},
		authorityBinding: () => {
			order.push(`binding:${generation}`);
			return binding(generation);
		},
		teardown: async () => {
			order.push(`drain:${generation}`);
			return teardownResult();
		},
	};
}

type TransitionFault = {
	stage: "prepare" | "writer_fencing" | "activation";
	generation: number;
	effect: "none" | "uncertain";
};

function durableTransitions(order: string[], fault?: TransitionFault): RuntimeGenerationTransitionPort {
	return {
		prepare: async ({ candidate }) => {
			order.push(`prepare:${candidate.generation}`);
			if (fault?.stage === "prepare" && fault.generation === candidate.generation) {
				return controlPlaneFailure("adapter_unavailable", "prepare fault", false, undefined, fault.effect);
			}
			return {
				ok: true,
				value: {
					replacementId: createRuntimeId("command", `replacement-${candidate.generation}`),
					candidateRuntimeId: candidate.runtimeId,
					candidateGeneration: candidate.generation,
					durableCursor: authorityCursor(candidate.generation * 4, `prepare-${candidate.generation}`),
				},
			};
		},
		rotateWriterFence: async ({ candidate }) => {
			order.push(`fence:${candidate.generation}`);
			if (fault?.stage === "writer_fencing" && fault.generation === candidate.generation) {
				return controlPlaneFailure("adapter_unavailable", "writer fencing fault", false, undefined, fault.effect);
			}
			return {
				ok: true,
				value: {
					candidateRuntimeId: candidate.runtimeId,
					candidateGeneration: candidate.generation,
					receiptId: createRuntimeId("receipt", `fencing-${candidate.generation}`),
					receiptDigest: canonicalDigest({ generation: candidate.generation, kind: "fencing-receipt" }),
				},
			};
		},
		activate: async ({ candidate, prepared }) => {
			order.push(`activate:${candidate.generation}`);
			if (fault?.stage === "activation" && fault.generation === candidate.generation) {
				return controlPlaneFailure("adapter_unavailable", "activation fault", false, undefined, fault.effect);
			}
			return {
				ok: true,
				value: {
					replacementId: prepared.replacementId,
					activeRuntimeId: candidate.runtimeId,
					activeGeneration: candidate.generation,
					durableCursor: authorityCursor(candidate.generation * 4 + 1, `activate-${candidate.generation}`),
				},
			};
		},
		recordFailure: async ({ candidate, phase, outcomeCertain }) => {
			order.push(`failure:${phase}:${candidate.generation}:${outcomeCertain}`);
			return { ok: true, value: undefined };
		},
	};
}

function governedFactory(
	order: string[],
	firstTeardown: () => ReturnType<typeof controlPlaneFailure<void>> | { ok: true; value: undefined } = () => ({
		ok: true,
		value: undefined,
	}),
) {
	let generation = 0;
	const create = (sessionId: typeof SESSION_ONE) => {
		generation += 1;
		order.push(`create:${generation}`);
		return governedRuntime(
			sessionId,
			generation,
			order,
			generation === 1 ? firstTeardown : undefined,
		);
	};
	return {
		start: async () => ({ ok: true as const, value: create(generation === 0 ? SESSION_ONE : SESSION_TWO) }),
		resume: async (sessionId: typeof SESSION_ONE) => ({ ok: true as const, value: create(sessionId) }),
		fork: async () => ({ ok: true as const, value: create(SESSION_TWO) }),
	};
}

describe("session replacement fencing", () => {
	it("prepares the candidate before tearing down the old runtime and invalidates the old handle only on commit", async () => {
		const order: string[] = [];
		let next = 0;
		const registry = new SessionRuntimeRegistry({
			start: async () => {
				next += 1;
				const sessionId = next === 1 ? SESSION_ONE : SESSION_TWO;
				return { ok: true, value: runtime(sessionId, async () => { order.push(`teardown:${sessionId}`); }) };
			},
			resume: async (sessionId) => {
				order.push(`prepare:${sessionId}`);
				return { ok: true, value: runtime(sessionId, async () => { order.push(`teardown:${sessionId}`); }) };
			},
			fork: async () => ({ ok: true, value: runtime(SESSION_TWO, async () => undefined) }),
		});
		const first = await registry.start();
		if (!first.ok) throw new Error("first start failed");
		const oldHandle = first.value.handle;
		order.length = 0;
		const resumed = await registry.resume(SESSION_TWO);
		expect(resumed).toMatchObject({ ok: true, value: { sessionId: SESSION_TWO, recovery: "resumed" } });
		expect(order).toEqual([`prepare:${SESSION_TWO}`, `teardown:${SESSION_ONE}`]);
		expect(registry.validate(oldHandle)).toMatchObject({ ok: false, error: { code: "stale_session_handle" } });
		if (resumed.ok) expect(registry.validate(resumed.value.handle).ok).toBe(true);
	});

	it("保留 teardown failure 的 paused 投影并在显式 reconcile 前关闭 replacement gate", async () => {
		let teardownAttempts = 0;
		let starts = 0;
		const failedRuntime: ManagedSessionRuntime = {
			sessionId: SESSION_ONE,
			head: () => null,
			teardown: async () => {
				teardownAttempts += 1;
				return teardownAttempts === 1
					? controlPlaneFailure("recovery_required", "teardown uncertain", false, undefined, "uncertain")
					: { ok: true, value: undefined };
			},
		};
		const registry = new SessionRuntimeRegistry({
			start: async () => {
				starts += 1;
				return { ok: true, value: starts === 1 ? failedRuntime : runtime(SESSION_TWO, async () => undefined) };
			},
			resume: async () => ({
				ok: true,
				value: runtime(SESSION_TWO, async () => undefined),
			}),
			fork: async () => ({ ok: true, value: runtime(SESSION_TWO, async () => undefined) }),
		}, () => new Date("2026-07-22T00:00:00.000Z"));
		const first = await registry.start();
		if (!first.ok) throw new Error("first start failed");
		expect(await registry.resume(SESSION_TWO)).toMatchObject({ ok: false, effect: "uncertain" });
		expect(registry.validate(first.value.handle)).toMatchObject({ ok: false, error: { code: "stale_session_handle" } });
		const activated = registry.current();
		expect(activated?.runtime.sessionId).toBe(SESSION_TWO);
		if (!activated) throw new Error("activated candidate is missing");
		expect(registry.validate(activated.handle)).toMatchObject({ ok: false, error: { code: "recovery_required" } });
		expect(registry.replacementFailure()).toMatchObject({
			status: "paused",
			phase: "teardown_failed",
			previousSessionId: SESSION_ONE,
			attemptedRecovery: "resumed",
		});
		expect(await registry.start()).toMatchObject({ ok: false, error: { code: "recovery_required" } });
		expect(await registry.reconcileReplacementFailure()).toMatchObject({ ok: true });
		expect(registry.validate(activated.handle)).toMatchObject({ ok: true });
		expect(teardownAttempts).toBe(2);
	});

	it("candidate prepare failure leaves the old runtime and handle intact", async () => {
		let starts = 0;
		let oldTeardowns = 0;
		const registry = new SessionRuntimeRegistry({
			start: async () => {
				starts += 1;
				return starts === 1
					? { ok: true, value: runtime(SESSION_ONE, async () => { oldTeardowns += 1; }) }
					: controlPlaneFailure("adapter_unavailable", "new runtime failed");
			},
			resume: async () => controlPlaneFailure("adapter_unavailable", "resume failed"),
			fork: async () => controlPlaneFailure("adapter_unavailable", "fork failed"),
		});
		const first = await registry.start();
		if (!first.ok) throw new Error("first start failed");
		expect(await registry.start()).toMatchObject({ ok: false, error: { code: "adapter_unavailable" } });
		expect(registry.replacementFailure()).toBeUndefined();
		expect(registry.current()?.runtime.sessionId).toBe(SESSION_ONE);
		expect(registry.validate(first.value.handle).ok).toBe(true);
		expect(oldTeardowns).toBe(0);
	});

	it("contains a thrown candidate preparation and reopens the old handle", async () => {
		let starts = 0;
		const previous = runtime(SESSION_ONE, async () => undefined);
		const registry = new SessionRuntimeRegistry({
			start: async () => {
				starts += 1;
				if (starts === 1) return { ok: true, value: previous };
				throw new Error("candidate factory crashed");
			},
			resume: async () => ({ ok: true, value: runtime(SESSION_TWO, async () => undefined) }),
			fork: async () => ({ ok: true, value: runtime(SESSION_TWO, async () => undefined) }),
		});
		const first = await registry.start();
		if (!first.ok) throw new Error("first start failed");
		expect(await registry.start()).toMatchObject({
			ok: false,
			effect: "none",
			error: { code: "adapter_unavailable" },
		});
		expect(registry.validate(first.value.handle).ok).toBe(true);
	});

	it("rejects a candidate that aliases the active runtime without tearing it down", async () => {
		let teardowns = 0;
		const shared = runtime(SESSION_ONE, async () => { teardowns += 1; });
		const registry = new SessionRuntimeRegistry({
			start: async () => ({ ok: true, value: shared }),
			resume: async () => ({ ok: true, value: shared }),
			fork: async () => ({ ok: true, value: shared }),
		});
		const first = await registry.start();
		if (!first.ok) throw new Error("first start failed");
		expect(await registry.resume(SESSION_ONE)).toMatchObject({
			ok: false,
			error: { code: "adapter_contract_violation" },
		});
		expect(registry.validate(first.value.handle).ok).toBe(true);
		expect(teardowns).toBe(0);
	});

	it("contains candidate head inspection failures before authority activation", async () => {
		const previous = runtime(SESSION_ONE, async () => undefined);
		let cleanup = 0;
		const invalid: ManagedSessionRuntime = {
			sessionId: SESSION_TWO,
			head: () => { throw new Error("head unavailable"); },
			teardown: async () => {
				cleanup += 1;
				return { ok: true, value: undefined };
			},
		};
		let starts = 0;
		const registry = new SessionRuntimeRegistry({
			start: async () => ({ ok: true, value: ++starts === 1 ? previous : invalid }),
			resume: async () => ({ ok: true, value: invalid }),
			fork: async () => ({ ok: true, value: invalid }),
		});
		const first = await registry.start();
		if (!first.ok) throw new Error("first start failed");
		expect(await registry.start()).toMatchObject({ ok: false, error: { code: "adapter_contract_violation" } });
		expect(cleanup).toBe(1);
		expect(registry.validate(first.value.handle)).toMatchObject({ ok: true });
		expect(registry.replacementFailure()).toBeUndefined();
	});

	it("blocks the old generation when invalid candidate cleanup is uncertain", async () => {
		const previous = runtime(SESSION_ONE, async () => undefined);
		let cleanup = 0;
		const wrongStream = createSessionEventStreamRef({
			authorityId: createRuntimeId("authority", "replacement"),
			tenantId: createRuntimeId("tenant", "replacement"),
		}, SESSION_ONE);
		const invalid: ManagedSessionRuntime = {
			sessionId: SESSION_TWO,
			head: () => ({
				stream: wrongStream,
				sequence: 0,
				eventId: createRuntimeId("event", "replacement-wrong-stream"),
				eventHash: "d".repeat(64),
			}),
			teardown: async () => {
				cleanup += 1;
				return cleanup === 1
					? controlPlaneFailure("recovery_required", "candidate cleanup uncertain", false, undefined, "uncertain")
					: { ok: true, value: undefined };
			},
		};
		let starts = 0;
		const registry = new SessionRuntimeRegistry({
			start: async () => ({ ok: true, value: ++starts === 1 ? previous : invalid }),
			resume: async () => ({ ok: true, value: invalid }),
			fork: async () => ({ ok: true, value: invalid }),
		});
		const first = await registry.start();
		if (!first.ok) throw new Error("first start failed");
		expect(await registry.start()).toMatchObject({ ok: false, effect: "uncertain" });
		expect(registry.replacementFailure()).toMatchObject({ phase: "create_failed", status: "paused" });
		expect(registry.validate(first.value.handle)).toMatchObject({ ok: false, error: { code: "recovery_required" } });
		expect(await registry.reconcileReplacementFailure()).toMatchObject({ ok: true });
		expect(registry.validate(first.value.handle)).toMatchObject({ ok: true });
		expect(cleanup).toBe(2);
	});
});

describe("durable runtime generation transitions", () => {
	it("orders candidate probe, durable prepare, writer fencing, activation, authority swap, then old drain", async () => {
		const order: string[] = [];
		const registry = new SessionRuntimeRegistry(governedFactory(order), {
			transition: durableTransitions(order),
			requireDurableTransition: true,
			handleIdFactory: () => {
				order.push(`swap:${order.some((entry) => entry === "activate:2") ? 2 : 1}`);
				return `handle-${order.length}`;
			},
		});
		const first = await registry.start();
		if (!first.ok) throw new Error("first governed start failed");
		order.length = 0;
		const replaced = await registry.resume(SESSION_TWO);
		expect(replaced).toMatchObject({ ok: true, value: { sessionId: SESSION_TWO, handle: { generation: 2 } } });
		expect(order).toEqual([
			"create:2",
			"probe:2",
			"binding:2",
			"prepare:2",
			"fence:2",
			"activate:2",
			"swap:2",
			"drain:1",
		]);
		expect(registry.validate(first.value.handle)).toMatchObject({ ok: false, error: { code: "stale_session_handle" } });
	});

	it("keeps the old runtime usable when prepare fails with a confirmed none effect", async () => {
		const order: string[] = [];
		const registry = new SessionRuntimeRegistry(governedFactory(order), {
			transition: durableTransitions(order, { stage: "prepare", generation: 2, effect: "none" }),
			requireDurableTransition: true,
		});
		const first = await registry.start();
		if (!first.ok) throw new Error("first governed start failed");
		order.length = 0;
		expect(await registry.resume(SESSION_TWO)).toMatchObject({ ok: false, effect: "none" });
		expect(order).toEqual(["create:2", "probe:2", "binding:2", "prepare:2", "drain:2"]);
		expect(registry.validate(first.value.handle)).toMatchObject({ ok: true });
		expect(registry.current()?.runtime.sessionId).toBe(SESSION_ONE);
		expect(registry.replacementFailure()).toBeUndefined();
	});

	it("records a confirmed fencing failure before cleanup and preserves the old authority", async () => {
		const order: string[] = [];
		const registry = new SessionRuntimeRegistry(governedFactory(order), {
			transition: durableTransitions(order, { stage: "writer_fencing", generation: 2, effect: "none" }),
			requireDurableTransition: true,
		});
		const first = await registry.start();
		if (!first.ok) throw new Error("first governed start failed");
		order.length = 0;
		expect(await registry.resume(SESSION_TWO)).toMatchObject({ ok: false, effect: "none" });
		expect(order).toEqual([
			"create:2",
			"probe:2",
			"binding:2",
			"prepare:2",
			"fence:2",
			"failure:writer_fencing:2:true",
			"drain:2",
		]);
		expect(registry.validate(first.value.handle)).toMatchObject({ ok: true });
	});

	it.each(["prepare", "activation"] as const)(
		"closes the recovery gate when %s has an uncertain outcome",
		async (stage) => {
			const order: string[] = [];
			const registry = new SessionRuntimeRegistry(governedFactory(order), {
				transition: durableTransitions(order, { stage, generation: 2, effect: "uncertain" }),
				requireDurableTransition: true,
			});
			const first = await registry.start();
			if (!first.ok) throw new Error("first governed start failed");
			order.length = 0;
			expect(await registry.resume(SESSION_TWO)).toMatchObject({ ok: false, effect: "uncertain" });
			expect(registry.validate(first.value.handle)).toMatchObject({ ok: false, error: { code: "recovery_required" } });
			expect(await registry.start()).toMatchObject({ ok: false, error: { code: "recovery_required" } });
			expect(await registry.reconcileReplacementFailure()).toMatchObject({
				ok: false,
				effect: "uncertain",
				error: { code: "recovery_required" },
			});
			expect(order).not.toContain("drain:1");
			expect(order).not.toContain("drain:2");
			if (stage === "activation") {
				expect(order).toContain("failure:activation:2:false");
				expect(order).not.toContain("swap:2");
			}
		},
	);

	it("never revives the old handle when the in-process swap fails after durable activation", async () => {
		const order: string[] = [];
		let handleCalls = 0;
		const registry = new SessionRuntimeRegistry(governedFactory(order), {
			transition: durableTransitions(order),
			requireDurableTransition: true,
			handleIdFactory: () => {
				handleCalls += 1;
				order.push(`swap:${handleCalls}`);
				if (handleCalls === 2) throw new Error("swap fault");
				return `handle-${handleCalls}`;
			},
		});
		const first = await registry.start();
		if (!first.ok) throw new Error("first governed start failed");
		order.length = 0;
		expect(await registry.resume(SESSION_TWO)).toMatchObject({
			ok: false,
			effect: "uncertain",
			error: { code: "recovery_required" },
		});
		expect(order).toEqual([
			"create:2",
			"probe:2",
			"binding:2",
			"prepare:2",
			"fence:2",
			"activate:2",
			"swap:2",
			"failure:authority_swap:2:true",
			"probe:1",
		]);
		expect(registry.validate(first.value.handle)).toMatchObject({ ok: false, error: { code: "stale_session_handle" } });
		expect(registry.current()).toBeUndefined();
	});

	it("keeps only the activated candidate current when old-runtime drain fails", async () => {
		const order: string[] = [];
		const registry = new SessionRuntimeRegistry(governedFactory(
			order,
			() => controlPlaneFailure("recovery_required", "old drain fault", false, undefined, "uncertain"),
		), {
			transition: durableTransitions(order),
			requireDurableTransition: true,
		});
		const first = await registry.start();
		if (!first.ok) throw new Error("first governed start failed");
		order.length = 0;
		expect(await registry.resume(SESSION_TWO)).toMatchObject({ ok: false, effect: "uncertain" });
		expect(order).toEqual([
			"create:2",
			"probe:2",
			"binding:2",
			"prepare:2",
			"fence:2",
			"activate:2",
			"drain:1",
			"failure:old_runtime_drain:2:true",
			"probe:1",
			"probe:2",
		]);
		expect(registry.validate(first.value.handle)).toMatchObject({ ok: false, error: { code: "stale_session_handle" } });
		expect(registry.current()?.runtime.sessionId).toBe(SESSION_TWO);
		const current = registry.current();
		if (!current) throw new Error("activated candidate is missing");
		expect(registry.validate(current.handle)).toMatchObject({ ok: false, error: { code: "recovery_required" } });
	});

	it("requires an explicit durable transition when production mode is requested", () => {
		expect(() => new SessionRuntimeRegistry(governedFactory([]), {
			requireDurableTransition: true,
		})).toThrow(/requires durable generation transitions/u);
	});
});

describe("bounded daemon shutdown", () => {
	it("can close the mutation gate before drain and runs the authority finalizer last", async () => {
		const order: string[] = [];
		const shutdown = new ShutdownCoordinator();
		shutdown.register({
			id: "session-writer",
			kind: "writer",
			drain: async () => { order.push("writer"); },
		});
		shutdown.registerFinalizer({
			id: "authority-writer",
			finalize: async (report) => {
				order.push(`finalizer:${report.outcomes.map((outcome) => outcome.id).join(",")}`);
			},
		});
		expect(shutdown.prepare()).toEqual({ ok: true, value: undefined });
		expect(shutdown.assertMutationOpen()).toMatchObject({ ok: false });
		expect(order).toEqual([]);
		const report = await shutdown.begin(1_000);
		expect(order).toEqual(["writer", "finalizer:session-writer"]);
		expect(report.recoveryRequired).toBe(false);
	});

	it("closes the mutation gate before draining and reports timeout recovery state", async () => {
		vi.useFakeTimers();
		try {
			const shutdown = new ShutdownCoordinator(() => new Date("2026-07-22T00:00:00.000Z"));
			let gateObserved = true;
			shutdown.register({
				id: "writer",
				kind: "writer",
				drain: async () => {
					gateObserved = shutdown.acceptsMutations();
				},
			});
			shutdown.register({
				id: "tool",
				kind: "tool",
				drain: async (signal) => new Promise((_resolve, reject) => {
					signal.addEventListener("abort", () => reject(new Error("deadline")), { once: true });
				}),
			});
			const pending = shutdown.begin(25);
			expect(shutdown.assertMutationOpen()).toMatchObject({ ok: false, error: { code: "daemon_shutting_down" } });
			await vi.advanceTimersByTimeAsync(25);
			const report = await pending;
			expect(gateObserved).toBe(false);
			expect(report.recoveryRequired).toBe(true);
			expect(report.outcomes).toEqual(expect.arrayContaining([
				expect.objectContaining({ id: "writer", status: "drained" }),
				expect.objectContaining({ id: "tool", status: "timed_out" }),
			]));
		} finally {
			vi.useRealTimers();
		}
	});
});
