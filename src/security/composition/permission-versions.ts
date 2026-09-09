import { AsyncLocalStorage } from "node:async_hooks";
import { runtimeDigest } from "../../runtime/protocol/foundation.ts";
import type { ExecutionEnv } from "../../runtime/execution-env.ts";
import { isPolicyChanged, policyChanged, throwPolicyFailure } from "../policy-revision.ts";
import type { SecurityPolicyRevisionPort } from "../policy-revision.ts";
import type { SecurityConfigDocument, SecurityErrorCode, SecurityResult, SecuritySnapshot } from "../types.ts";
import type { SessionSecurityComposition, SessionSecurityRevisionComposition } from "./session-security.ts";

export interface PreparedPermissionUpdate {
	readonly snapshot: SecuritySnapshot;
	verifySaved(): Promise<boolean>;
	/** 必须先持久提交应用记录；发布与解除 admission 屏障不跨 await。 */
	publish(): void;
	discard(): Promise<void>;
	block(): void;
}

interface Revision {
	readonly snapshot: SecuritySnapshot;
	readonly controller: AbortController;
	readonly composition: SessionSecurityRevisionComposition;
	users: number;
	retired: boolean;
	closed: boolean;
}

export function permissionConfigurationDigest(snapshot: SecuritySnapshot) {
	const { policyDigest: _digest, createdAt: _time, securityRevision: _revision, ...configuration } = snapshot;
	return runtimeDigest(configuration);
}

function versionedSnapshot(snapshot: SecuritySnapshot, revision: number): SecuritySnapshot {
	const { policyDigest: _digest, ...body } = snapshot;
	const versioned = { ...body, securityRevision: revision };
	return Object.freeze({ ...versioned, policyDigest: runtimeDigest(versioned) });
}

function failure(code: SecurityErrorCode, message: string): SecurityResult<never> {
	return { ok: false, error: { code, message, retryable: false } };
}

/** 稳定工具端口切换不可变组合；只有最终 dispatch 已开始的操作可以留在旧版本。 */
export async function createPermissionVersions(input: {
	readonly initial: SecuritySnapshot;
	readonly initialRevision: number;
	readonly load: (document?: SecurityConfigDocument) => Promise<SecuritySnapshot>;
	readonly assemble: (snapshot: SecuritySnapshot, revision: SecurityPolicyRevisionPort) => Promise<SessionSecurityRevisionComposition>;
}): Promise<SessionSecurityComposition> {
	let current: Revision;
	let updating = false;
	let blocked = false;
	let closed = false;
	let admissions = 0;
	const readyWaiters = new Set<() => void>();
	const admissionWaiters = new Set<() => void>();
	const revisions = new Set<Revision>();
	const closing = new Set<Promise<void>>();
	const frozenRevision = new AsyncLocalStorage<number>();

	function wake(waiters: Set<() => void>): void {
		for (const resolve of waiters) resolve();
		waiters.clear();
	}
	function dispose(revision: Revision): void {
		if (!revision.retired || revision.users !== 0 || revision.closed) return;
		revision.closed = true;
		revisions.delete(revision);
		const task = revision.composition.close().catch(() => undefined);
		closing.add(task);
		void task.then(() => closing.delete(task));
	}
	function guard(revision: Revision, admission = false): SecurityResult<void> {
		if (closed || blocked) return failure("security_update_failed", "Session permission state is unavailable; reconnect to recover");
		return (admission && updating) || revision !== current ? policyChanged() : { ok: true, value: undefined };
	}
	async function assemble(snapshot: SecuritySnapshot, number: number): Promise<Revision> {
		const controller = new AbortController();
		let revision: Revision;
		const composition = await input.assemble(versionedSnapshot(snapshot, number), {
			signal: controller.signal,
			check: () => guard(revision),
			checkAdmission: () => guard(revision, true),
			acquireAdmission: () => {
				const checked = guard(revision, true);
				if (!checked.ok) return checked;
				admissions += 1;
				let released = false;
				return { ok: true, value: () => {
					if (released) return;
					released = true;
					admissions -= 1;
					if (admissions === 0) wake(admissionWaiters);
				} };
			},
		});
		revision = { snapshot: composition.snapshot, controller, composition, users: 0, retired: false, closed: false };
		revisions.add(revision);
		return revision;
	}
	async function ready(signal?: AbortSignal): Promise<void> {
		while (updating && !blocked && !closed) {
			await new Promise<void>((resolve, reject) => {
				const finish = (): void => { signal?.removeEventListener("abort", abort); resolve(); };
				const abort = (): void => {
					readyWaiters.delete(finish);
					signal?.removeEventListener("abort", abort);
					reject(Object.assign(new Error("Operation cancelled before permission update completed"), { code: "approval_cancelled" }));
				};
				readyWaiters.add(finish);
				if (signal?.aborted) abort();
				else signal?.addEventListener("abort", abort, { once: true });
			});
		}
		if (signal?.aborted) throw Object.assign(new Error("Operation cancelled"), { code: "approval_cancelled" });
		if (blocked || closed) throwPolicyFailure(failure("security_update_failed", "Session permission state requires recovery"));
	}
	async function run<T>(operation: (composition: SessionSecurityRevisionComposition) => Promise<T>, signal?: AbortSignal): Promise<T> {
		const frozen = frozenRevision.getStore();
		for (let retry = 0; retry < 32; retry += 1) {
			await ready(signal);
			const revision = current;
			if (frozen !== undefined && frozen !== revision.snapshot.securityRevision) throwPolicyFailure(policyChanged());
			revision.users += 1;
			try { return await operation(revision.composition); }
			catch (error) { if (frozen !== undefined || !isPolicyChanged(error) || signal?.aborted) throw error; }
			finally { revision.users -= 1; dispose(revision); }
		}
		throw Object.assign(new Error("Permissions changed too often to admit the operation"), { code: "security_update_in_progress" });
	}
	async function runResult<T>(operation: (composition: SessionSecurityRevisionComposition) => Promise<SecurityResult<T>>, signal?: AbortSignal): Promise<SecurityResult<T>> {
		try {
			return await run(async (composition) => {
				const result = await operation(composition);
				if (!result.ok && result.error.code === "security_policy_changed") throwPolicyFailure(result);
				return result;
			}, signal);
		} catch {
			return failure(signal?.aborted ? "approval_cancelled" : "security_update_failed", "Session permissions could not authorize the operation");
		}
	}

	current = await assemble(input.initial, input.initialRevision);
	const executionEnv: ExecutionEnv = {
		cwd: current.composition.executionEnv.cwd,
		fs: {
			readFile: (path) => run((version) => version.executionEnv.fs.readFile(path)),
			writeFile: (path, data) => run((version) => version.executionEnv.fs.writeFile(path, data)),
			stat: (path) => run((version) => version.executionEnv.fs.stat(path)),
			readdir: (path) => run((version) => version.executionEnv.fs.readdir(path)),
			mkdir: (path, options) => run((version) => version.executionEnv.fs.mkdir(path, options)),
			rm: (path, options) => run((version) => version.executionEnv.fs.rm(path, options)),
			rename: (from, to) => run((version) => version.executionEnv.fs.rename(from, to)),
		},
		network: { request: (request, signal) => run((version) => version.executionEnv.network!.request(request, signal), signal) },
		shell: { exec: (command, options) => run((version) => version.executionEnv.shell.exec(command, options), options?.signal) },
	};
	return {
		get applicationState() { return closed || blocked ? "recovery_required" : updating ? "updating" : "applied"; },
		capturePermissionScope: () => {
			const captured = current.snapshot.securityRevision!;
			return <T>(operation: () => Promise<T>): Promise<T> => frozenRevision.run(captured, operation);
		},
		get snapshot() { return current.snapshot; },
		get sandboxCapability() { return current.composition.sandboxCapability; },
		workspaceStorageKey: current.composition.workspaceStorageKey,
		executionEnv,
		authorizationPolicy: current.composition.authorizationPolicy,
		managedProcess: { prepare: (request, signal) => runResult((version) => version.managedProcess.prepare(request, signal), signal) },
		permissionRequester: { request: (request, signal) => runResult((version) => version.permissionRequester.request(request, signal), signal) },
		get bashAnalyzer() { return current.composition.bashAnalyzer; },
		prepareUpdate: async (document, expectedRevision) => {
			if (closed || blocked) return failure("security_update_failed", "Session permission state requires recovery");
			if (updating) return failure("security_update_in_progress", "Another permission update is in progress");
			if (current.snapshot.securityRevision !== expectedRevision) return failure("revision_conflict", "Session permission revision changed");
			updating = true;
			let candidate: Revision;
			try {
				if (admissions > 0) await new Promise<void>((resolve) => admissionWaiters.add(resolve));
				const snapshot = await input.load(document);
				if (document.profile !== undefined && snapshot.profile.name !== document.profile) {
					updating = false; wake(readyWaiters);
					return failure("policy_denied", "The requested preset is restricted by workspace or CLI policy");
				}
				candidate = await assemble(snapshot, expectedRevision + 1);
			} catch {
				updating = false; wake(readyWaiters);
				return failure("invalid_config", "The requested permission configuration could not be prepared");
			}
			let settled = false;
			return { ok: true, value: {
				snapshot: candidate.snapshot,
				verifySaved: async () => permissionConfigurationDigest(await input.load()).digest === permissionConfigurationDigest(candidate.snapshot).digest,
				publish: () => {
					if (settled || closed || blocked) throw new Error("Permission update is no longer publishable");
					settled = true;
					const previous = current;
					current = candidate;
					updating = false;
					previous.retired = true;
					previous.controller.abort({ code: "security_policy_changed" });
					wake(readyWaiters);
					dispose(previous);
				},
				discard: async () => {
					if (settled) return;
					settled = true;
					candidate.retired = true; dispose(candidate);
					updating = false; wake(readyWaiters);
				},
				block: () => {
					if (settled) return;
					settled = true;
					candidate.retired = true; dispose(candidate);
					blocked = true;
					current.controller.abort({ code: "security_update_failed" });
					wake(readyWaiters);
				},
			} };
		},
		close: async () => {
			closed = true;
			wake(readyWaiters);
			for (const revision of revisions) {
				revision.retired = true;
				revision.controller.abort({ code: "approval_cancelled" });
				dispose(revision);
			}
			await Promise.all(closing);
		},
	};
}
