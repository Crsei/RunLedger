/** Production-only connect-or-spawn coordination for the resident Runtime Host. */

import type { HostEndpointRecord } from "../storage/host/endpoint-store.ts";
import type { HostFrameEnvelope } from "../runtime/host/types.ts";

export interface HostConnectionAttempt {
	readonly kind: "jsonl" | "fake";
	readonly id: string;
	readonly close?: () => Promise<void>;
	readonly request?: (frame: HostFrameEnvelope) => Promise<HostFrameEnvelope>;
	readonly onEvent?: (listener: (frame: HostFrameEnvelope) => void) => () => void;
	readonly notify?: (frame: HostFrameEnvelope) => void;
}

export type HostConnectionResult =
	| { readonly ok: true; readonly connection: HostConnectionAttempt }
	| {
			readonly ok: false;
			readonly code: "unreachable" | "peer_attestation_required" | "host_configuration_conflict";
			readonly retryable: boolean;
	  };

export type HostSpawnResult =
	| {
			readonly ok?: true;
			readonly endpoint: HostEndpointRecord;
			readonly connection: HostConnectionAttempt;
			readonly close: () => Promise<void>;
	  }
	| { readonly ok: false; readonly code: "peer_attestation_required" | "host_configuration_conflict" | "host_startup_timeout"; };

export interface RuntimeHostLauncherOptions {
	readonly endpoint: {
		read(): Promise<HostEndpointRecord | undefined>;
		remove(): Promise<void>;
	};
	readonly writer: {
		state(): Promise<"active" | "absent" | "unknown">;
	};
	readonly election: {
		acquire(): Promise<
			| { readonly ok: true; readonly release: () => Promise<void> }
			| { readonly ok: false; readonly code: "startup_election_lost" }
		>;
	};
	readonly connector: {
		connect(endpoint: HostEndpointRecord): Promise<HostConnectionResult>;
	};
	readonly spawner: {
		spawn(input: { readonly hostGeneration: number }): Promise<HostSpawnResult>;
	};
	readonly expectedCompatibilityDigest: { readonly digest: string };
	readonly wait?: {
		readonly timeoutMs?: number;
		readonly intervalMs?: number;
	};
	readonly clock?: () => number;
	readonly delay?: (durationMs: number) => Promise<void>;
}

export type RuntimeHostLaunchResult =
	| {
			readonly ok: true;
			readonly startedHost: boolean;
			readonly endpoint: HostEndpointRecord;
			readonly connection: HostConnectionAttempt;
			readonly close: () => Promise<void>;
	  }
	| {
			readonly ok: false;
			readonly code:
				| "active_writer_unreachable"
				| "host_configuration_conflict"
				| "peer_attestation_required"
				| "host_startup_timeout"
				| "writer_state_unknown"
				| "endpoint_unavailable";
	  };

const DEFAULT_WAIT_TIMEOUT_MS = 10_000;
const DEFAULT_WAIT_INTERVAL_MS = 25;

export async function connectOrSpawnHost(options: RuntimeHostLauncherOptions): Promise<RuntimeHostLaunchResult> {
	const now = options.clock ?? Date.now;
	const delay = options.delay ?? ((durationMs: number) => new Promise<void>((resolve) => setTimeout(resolve, durationMs)));
	const timeoutMs = options.wait?.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
	const intervalMs = options.wait?.intervalMs ?? DEFAULT_WAIT_INTERVAL_MS;
	if (!isBoundedWait(timeoutMs, intervalMs)) return { ok: false, code: "host_startup_timeout" };

	let published: HostEndpointRecord | undefined;
	try {
		published = await options.endpoint.read();
	} catch {
		return { ok: false, code: "endpoint_unavailable" };
	}
	if (published !== undefined) {
		const existing = await tryConnectExisting(options, published);
		if (existing !== undefined) return existing;
	}

	let election;
	try {
		election = await options.election.acquire();
	} catch {
		return { ok: false, code: "endpoint_unavailable" };
	}
	if (!election.ok) return waitForWinner(options, now, delay, timeoutMs, intervalMs);

	try {
		const raced = await options.endpoint.read();
		if (raced !== undefined) {
			const connected = await tryConnectExisting(options, raced);
			if (connected !== undefined) return connected;
			const writerState = await options.writer.state();
			if (writerState === "active") return { ok: false, code: "active_writer_unreachable" };
			if (writerState === "unknown") return { ok: false, code: "writer_state_unknown" };
			// `stale` is an admission observation, not a persisted endpoint state:
			// a ready endpoint becomes stale only after the connection attempt failed
			// and the writer fence confirmed that no Host still owns the workspace.
			if (raced.state !== "ready") return waitForWinner(options, now, delay, timeoutMs, intervalMs);
			try {
				await options.endpoint.remove();
			} catch {
				return { ok: false, code: "endpoint_unavailable" };
			}
		}

		const generation = (raced?.hostGeneration ?? published?.hostGeneration ?? 0) + 1;
		const spawned = await options.spawner.spawn({ hostGeneration: generation });
		if (spawned.ok === false) return spawned;
		if (spawned.endpoint.compatibilityDigest.digest !== options.expectedCompatibilityDigest.digest) {
			await spawned.close().catch(() => undefined);
			return { ok: false, code: "host_configuration_conflict" };
		}
		return {
			ok: true,
			startedHost: true,
			endpoint: spawned.endpoint,
			connection: spawned.connection,
			close: spawned.close,
		};
	} finally {
		await election.release().catch(() => undefined);
	}
}

async function tryConnectExisting(
	options: RuntimeHostLauncherOptions,
	endpoint: HostEndpointRecord,
): Promise<RuntimeHostLaunchResult | undefined> {
	if (endpoint.compatibilityDigest.digest !== options.expectedCompatibilityDigest.digest) {
		return { ok: false, code: "host_configuration_conflict" };
	}
	if (endpoint.state !== "ready") return undefined;
	let connection: HostConnectionResult;
	try {
		connection = await options.connector.connect(endpoint);
	} catch {
		return undefined;
	}
	if (connection.ok) {
		return { ok: true, startedHost: false, endpoint, connection: connection.connection, close: connection.connection.close ?? (async () => {}) };
	}
	if (!connection.retryable) {
		return connection.code === "host_configuration_conflict"
			? { ok: false, code: "host_configuration_conflict" }
			: { ok: false, code: "peer_attestation_required" };
	}
	return undefined;
}

async function waitForWinner(
	options: RuntimeHostLauncherOptions,
	now: () => number,
	delay: (durationMs: number) => Promise<void>,
	timeoutMs: number,
	intervalMs: number,
): Promise<RuntimeHostLaunchResult> {
	const deadline = now() + timeoutMs;
	while (now() < deadline) {
		let endpoint: HostEndpointRecord | undefined;
		try {
			endpoint = await options.endpoint.read();
		} catch {
			return { ok: false, code: "endpoint_unavailable" };
		}
		if (endpoint !== undefined) {
			const connected = await tryConnectExisting(options, endpoint);
			if (connected?.ok) return connected;
			if (connected && connected.code !== "host_startup_timeout") return connected;
			if (endpoint.state === "ready") {
				const writerState = await options.writer.state();
				if (writerState === "active") return { ok: false, code: "active_writer_unreachable" };
				if (writerState === "unknown") return { ok: false, code: "writer_state_unknown" };
			}
		}
		await delay(intervalMs);
	}
	return { ok: false, code: "host_startup_timeout" };
}

function isBoundedWait(timeoutMs: number, intervalMs: number): boolean {
	return Number.isSafeInteger(timeoutMs) && timeoutMs >= 1 && timeoutMs <= 300_000 &&
		Number.isSafeInteger(intervalMs) && intervalMs >= 1 && intervalMs <= timeoutMs;
}
