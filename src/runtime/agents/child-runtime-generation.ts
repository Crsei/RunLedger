/** Child runtime generation replacement：先提交新authority，再drain旧host。 */

import { canonicalDigest } from "../protocol/v3/canonical-json.ts";
import { createRuntimeId } from "../protocol/v3/ids.ts";
import type { AgentResult } from "./types.ts";
import type {
	ChildRuntimeDescriptorV2,
	ChildRuntimeReplacementReceipt,
} from "./child-runtime-contracts.ts";

export interface ChildRuntimeGenerationHandle {
	handleId: string;
	agentId: ChildRuntimeReplacementReceipt["agentId"];
	sessionId: ChildRuntimeReplacementReceipt["sessionId"];
	runtimeId: ChildRuntimeDescriptorV2["runtimeId"];
	generation: number;
	descriptorDigest: string;
	handleDigest: string;
}

export interface ChildRuntimeGenerationAuthority {
	revision: number;
	active: ChildRuntimeGenerationHandle;
	previous: readonly ChildRuntimeGenerationHandle[];
	authorityDigest: string;
}

export interface ChildRuntimeGenerationStorePort {
	load(
		agentId: ChildRuntimeGenerationHandle["agentId"],
	): Promise<AgentResult<ChildRuntimeGenerationAuthority | undefined>>;
	compareAndSwap(
		agentId: ChildRuntimeGenerationHandle["agentId"],
		expectedRevision: number,
		next: ChildRuntimeGenerationAuthority,
	): Promise<AgentResult<"committed" | "conflict">>;
}

export function childRuntimeGenerationHandle(input: {
	handleId: string;
	agentId: ChildRuntimeGenerationHandle["agentId"];
	sessionId: ChildRuntimeGenerationHandle["sessionId"];
	descriptor: ChildRuntimeDescriptorV2;
	generation: number;
}): ChildRuntimeGenerationHandle {
	const body = {
		handleId: input.handleId,
		agentId: input.agentId,
		sessionId: input.sessionId,
		runtimeId: input.descriptor.runtimeId,
		generation: input.generation,
		descriptorDigest: input.descriptor.descriptorDigest,
	};
	return { ...body, handleDigest: canonicalDigest(body) };
}

function authorityDigest(
	authority: Omit<ChildRuntimeGenerationAuthority, "authorityDigest">,
): string {
	return canonicalDigest(authority);
}

export class MemoryChildRuntimeGenerationStore
	implements ChildRuntimeGenerationStorePort {
	readonly #records = new Map<
		ChildRuntimeGenerationHandle["agentId"],
		ChildRuntimeGenerationAuthority
	>();

	public seed(record: ChildRuntimeGenerationAuthority): void {
		this.#records.set(record.active.agentId, structuredClone(record));
	}

	public load(
		agentId: ChildRuntimeGenerationHandle["agentId"],
	): Promise<AgentResult<ChildRuntimeGenerationAuthority | undefined>> {
		return Promise.resolve({
			ok: true,
			value: structuredClone(this.#records.get(agentId)),
		});
	}

	public compareAndSwap(
		agentId: ChildRuntimeGenerationHandle["agentId"],
		expectedRevision: number,
		next: ChildRuntimeGenerationAuthority,
	): Promise<AgentResult<"committed" | "conflict">> {
		const current = this.#records.get(agentId);
		if ((current?.revision ?? 0) !== expectedRevision) {
			return Promise.resolve({ ok: true, value: "conflict" });
		}
		this.#records.set(agentId, structuredClone(next));
		return Promise.resolve({ ok: true, value: "committed" });
	}
}

export class ChildRuntimeGenerationCoordinator {
	readonly #store: ChildRuntimeGenerationStorePort;
	readonly #clock: () => Date;

	public constructor(options: {
		store: ChildRuntimeGenerationStorePort;
		clock?: () => Date;
	}) {
		this.#store = options.store;
		this.#clock = options.clock ?? (() => new Date());
	}

	public async validateHandle(
		handle: ChildRuntimeGenerationHandle,
	): Promise<AgentResult<void>> {
		const loaded = await this.#store.load(handle.agentId);
		if (!loaded.ok) return loaded;
		const active = loaded.value?.active;
		if (
			!active ||
			active.handleDigest !== handle.handleDigest ||
			active.runtimeId !== handle.runtimeId ||
			active.generation !== handle.generation
		) {
			return {
				ok: false,
				error: {
					code: "reference_unavailable",
					message: "child runtime handle is fenced by a newer generation",
					retryable: false,
				},
			};
		}
		return { ok: true, value: undefined };
	}

	public async replace(input: {
		previous: ChildRuntimeGenerationHandle;
		replacement: ChildRuntimeGenerationHandle;
		authorityCommitCursor: ChildRuntimeReplacementReceipt["authorityCommitCursor"];
		drainPrevious(): Promise<void>;
	}): Promise<AgentResult<ChildRuntimeReplacementReceipt>> {
		const loaded = await this.#store.load(input.previous.agentId);
		if (!loaded.ok) return loaded;
		const current = loaded.value;
		if (
			!current ||
			current.active.handleDigest !== input.previous.handleDigest ||
			input.replacement.agentId !== input.previous.agentId ||
			input.replacement.sessionId !== input.previous.sessionId ||
			input.replacement.generation !== input.previous.generation + 1 ||
			input.replacement.runtimeId === input.previous.runtimeId
		) {
			return {
				ok: false,
				error: {
					code: "revision_conflict",
					message: "child runtime replacement does not extend current authority",
					retryable: false,
				},
			};
		}
		const body = {
			revision: current.revision + 1,
			active: input.replacement,
			previous: [...current.previous, input.previous],
		};
		const next: ChildRuntimeGenerationAuthority = {
			...body,
			authorityDigest: authorityDigest(body),
		};
		const committed = await this.#store.compareAndSwap(
			input.previous.agentId,
			current.revision,
			next,
		);
		if (!committed.ok) return committed;
		if (committed.value === "conflict") {
			return {
				ok: false,
				error: {
					code: "revision_conflict",
					message: "child runtime authority changed during replacement",
					retryable: true,
				},
			};
		}
		let drainStatus: ChildRuntimeReplacementReceipt["drainStatus"] = "completed";
		try {
			await input.drainPrevious();
		} catch {
			drainStatus = "reconciliation_required";
		}
		const committedAt = this.#clock().toISOString();
		const receiptBody = {
			receiptId: createRuntimeId(
				"receipt",
				`child-replacement-${canonicalDigest(next).slice(0, 48)}`,
			),
			agentId: input.previous.agentId,
			sessionId: input.previous.sessionId,
			previousRuntimeId: input.previous.runtimeId,
			replacementRuntimeId: input.replacement.runtimeId,
			previousGeneration: input.previous.generation,
			replacementGeneration: input.replacement.generation,
			authorityCommitCursor: input.authorityCommitCursor,
			drainStatus,
			committedAt,
		};
		return {
			ok: true,
			value: {
				...receiptBody,
				receiptDigest: canonicalDigest(receiptBody),
			},
		};
	}
}

export function createInitialChildRuntimeGenerationAuthority(input: {
	handle: ChildRuntimeGenerationHandle;
}): ChildRuntimeGenerationAuthority {
	const { handleDigest, ...bodyForDigest } = input.handle;
	if (
		input.handle.generation !== 1 ||
		!/^[a-f0-9]{64}$/u.test(input.handle.descriptorDigest) ||
		handleDigest !== canonicalDigest(bodyForDigest)
	) {
		throw new TypeError("initial child runtime generation handle is invalid");
	}
	const body = { revision: 1, active: input.handle, previous: [] as const };
	return { ...body, authorityDigest: authorityDigest(body) };
}
