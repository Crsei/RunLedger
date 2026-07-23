/** Session restore 的不可序列化依赖注册与可持久化 identity/generation 绑定。 */

import { canonicalDigest } from "../protocol/v3/canonical-json.ts";

export const SESSION_RESTORE_DEPENDENCY_SCHEMA_VERSION = 1 as const;

export const SESSION_RESTORE_DEPENDENCY_KINDS = [
	"model",
	"tool",
	"resource",
	"provider",
] as const;

export type SessionRestoreDependencyKind =
	(typeof SESSION_RESTORE_DEPENDENCY_KINDS)[number];

export interface SessionRestoreDependencyBinding {
	kind: SessionRestoreDependencyKind;
	identity: string;
	generation: number;
	/** 只驻留内存，永不进入 snapshot 或 canonical event。 */
	handle: unknown;
}

export interface SessionRestoreDependencySnapshotEntry {
	kind: SessionRestoreDependencyKind;
	identity: string;
	generation: number;
	bindingDigest: string;
}

export interface SessionRestoreDependencySnapshot {
	schemaVersion: typeof SESSION_RESTORE_DEPENDENCY_SCHEMA_VERSION;
	entries: readonly SessionRestoreDependencySnapshotEntry[];
	snapshotDigest: string;
}

export type SessionRestoreDependencyRegistrar = (
) => Promise<readonly SessionRestoreDependencyBinding[]>;

export type SessionRestoreDependencyErrorCode =
	| "registration_failed"
	| "invalid_registration"
	| "duplicate_dependency"
	| "snapshot_corrupted"
	| "snapshot_missing"
	| "identity_mismatch"
	| "generation_mismatch";

export class SessionRestoreDependencyError extends Error {
	public readonly code: SessionRestoreDependencyErrorCode;

	public constructor(
		code: SessionRestoreDependencyErrorCode,
		message: string,
		options: ErrorOptions = {},
	) {
		super(message, options);
		this.name = "SessionRestoreDependencyError";
		this.code = code;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
	const actual = Object.keys(value).sort();
	const expected = [...keys].sort();
	return actual.length === expected.length &&
		actual.every((key, index) => key === expected[index]);
}

function isDigest(value: unknown): value is string {
	return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function isKind(value: unknown): value is SessionRestoreDependencyKind {
	return typeof value === "string" &&
		(SESSION_RESTORE_DEPENDENCY_KINDS as readonly string[]).includes(value);
}

function validIdentity(value: unknown): value is string {
	return typeof value === "string" && value.length >= 1 && value.length <= 512;
}

function validGeneration(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

function bindingBody(
	binding: Pick<SessionRestoreDependencyBinding, "kind" | "identity" | "generation">,
): Omit<SessionRestoreDependencySnapshotEntry, "bindingDigest"> {
	return {
		kind: binding.kind,
		identity: binding.identity,
		generation: binding.generation,
	};
}

function entryKey(
	entry: Pick<SessionRestoreDependencySnapshotEntry, "kind" | "identity">,
): string {
	return `${entry.kind}\u0000${entry.identity}`;
}

function validateBinding(binding: unknown): asserts binding is SessionRestoreDependencyBinding {
	if (
		!isRecord(binding) ||
		!hasExactKeys(binding, ["kind", "identity", "generation", "handle"]) ||
		!isKind(binding.kind) ||
		!validIdentity(binding.identity) ||
		!validGeneration(binding.generation) ||
		binding.handle === undefined
	) {
		throw new SessionRestoreDependencyError(
			"invalid_registration",
			"session restore dependency registration is invalid",
		);
	}
}

function snapshotBody(
	entries: readonly SessionRestoreDependencySnapshotEntry[],
): Omit<SessionRestoreDependencySnapshot, "snapshotDigest"> {
	return {
		schemaVersion: SESSION_RESTORE_DEPENDENCY_SCHEMA_VERSION,
		entries,
	};
}

export function isSessionRestoreDependencySnapshot(
	value: unknown,
): value is SessionRestoreDependencySnapshot {
	if (
		!isRecord(value) ||
		!hasExactKeys(value, ["schemaVersion", "entries", "snapshotDigest"]) ||
		value.schemaVersion !== SESSION_RESTORE_DEPENDENCY_SCHEMA_VERSION ||
		!Array.isArray(value.entries) ||
		value.entries.length > 4096 ||
		!isDigest(value.snapshotDigest)
	) return false;

	let previousKey: string | undefined;
	for (const candidate of value.entries) {
		if (
			!isRecord(candidate) ||
			!hasExactKeys(candidate, ["kind", "identity", "generation", "bindingDigest"]) ||
			!isKind(candidate.kind) ||
			!validIdentity(candidate.identity) ||
			!validGeneration(candidate.generation) ||
			!isDigest(candidate.bindingDigest)
		) return false;
		const body = bindingBody({
			kind: candidate.kind,
			identity: candidate.identity,
			generation: candidate.generation,
		});
		if (candidate.bindingDigest !== canonicalDigest(body)) return false;
		const key = entryKey({ kind: candidate.kind, identity: candidate.identity });
		if (previousKey !== undefined && key <= previousKey) return false;
		previousKey = key;
	}

	const body = snapshotBody(value.entries as readonly SessionRestoreDependencySnapshotEntry[]);
	return value.snapshotDigest === canonicalDigest(body);
}

export function createSessionRestoreDependencySnapshot(
	bindings: readonly SessionRestoreDependencyBinding[],
): SessionRestoreDependencySnapshot {
	const entries = bindings.map((binding) => {
		validateBinding(binding);
		const body = bindingBody(binding);
		return Object.freeze({
			...body,
			bindingDigest: canonicalDigest(body),
		});
	}).sort((left, right) => entryKey(left).localeCompare(entryKey(right)));

	for (let index = 1; index < entries.length; index += 1) {
		if (entryKey(entries[index]!) === entryKey(entries[index - 1]!)) {
			throw new SessionRestoreDependencyError(
				"duplicate_dependency",
				`duplicate session restore dependency ${entries[index]!.kind}:${entries[index]!.identity}`,
			);
		}
	}

	const frozenEntries = Object.freeze(entries);
	const body = snapshotBody(frozenEntries);
	return Object.freeze({
		...body,
		snapshotDigest: canonicalDigest(body),
	});
}

export class SessionRestoreDependencyRegistry {
	public readonly snapshot: SessionRestoreDependencySnapshot;
	readonly #bindings: ReadonlyMap<string, SessionRestoreDependencyBinding>;

	public constructor(bindings: readonly SessionRestoreDependencyBinding[]) {
		this.snapshot = createSessionRestoreDependencySnapshot(bindings);
		this.#bindings = new Map(bindings.map((binding) => [
			entryKey(binding),
			Object.freeze({ ...binding }),
		]));
	}

	public size(): number {
		return this.#bindings.size;
	}

	public get(kind: SessionRestoreDependencyKind, identity: string): unknown {
		return this.#bindings.get(entryKey({ kind, identity }))?.handle;
	}
}

export async function registerSessionRestoreDependencies(
	registrar?: SessionRestoreDependencyRegistrar,
): Promise<SessionRestoreDependencyRegistry> {
	if (!registrar) return new SessionRestoreDependencyRegistry([]);
	try {
		return new SessionRestoreDependencyRegistry(await registrar());
	} catch (cause) {
		if (cause instanceof SessionRestoreDependencyError) throw cause;
		throw new SessionRestoreDependencyError(
			"registration_failed",
			"session restore dependency registration failed",
			{ cause },
		);
	}
}

export function verifySessionRestoreDependencies(
	expected: SessionRestoreDependencySnapshot | undefined,
	actual: SessionRestoreDependencyRegistry,
): void {
	if (expected === undefined) {
		if (actual.size() === 0) return;
		throw new SessionRestoreDependencyError(
			"snapshot_missing",
			"session snapshot does not bind the registered restore dependencies",
		);
	}
	if (!isSessionRestoreDependencySnapshot(expected)) {
		throw new SessionRestoreDependencyError(
			"snapshot_corrupted",
			"session restore dependency snapshot is invalid",
		);
	}

	const actualByKey = new Map(actual.snapshot.entries.map((entry) => [entryKey(entry), entry]));
	if (expected.entries.length !== actual.snapshot.entries.length) {
		throw new SessionRestoreDependencyError(
			"identity_mismatch",
			"registered session restore dependency identities do not match the snapshot",
		);
	}
	for (const entry of expected.entries) {
		const candidate = actualByKey.get(entryKey(entry));
		if (!candidate) {
			throw new SessionRestoreDependencyError(
				"identity_mismatch",
				`registered session restore dependency ${entry.kind}:${entry.identity} is missing`,
			);
		}
		if (candidate.generation !== entry.generation) {
			throw new SessionRestoreDependencyError(
				"generation_mismatch",
				`registered session restore dependency ${entry.kind}:${entry.identity} has generation ${candidate.generation}, expected ${entry.generation}`,
			);
		}
		if (candidate.bindingDigest !== entry.bindingDigest) {
			throw new SessionRestoreDependencyError(
				"identity_mismatch",
				`registered session restore dependency ${entry.kind}:${entry.identity} identity digest does not match`,
			);
		}
	}
}
