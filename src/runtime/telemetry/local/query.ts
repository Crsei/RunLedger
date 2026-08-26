import { existsSync } from "node:fs";
import { lstat, readdir, readFile } from "node:fs/promises";
import * as path from "node:path";
import type { EffectiveRecordingConfig } from "../../../storage/settings-manager.ts";
import { openSessionDatabase } from "../../../storage/session-store/database.ts";
import { checkStoreCompatibility } from "../../../storage/session-store/schema-compatibility.ts";
import { SessionStore } from "../../../storage/session-store/session-store.ts";
import { runtimeWorkspacePlatform } from "../../../workspace/runtime-platform.ts";
import type { RunledgerLayout } from "../../contracts/storage-layout.ts";
import { isRuntimeId, type SessionId, type TraceId } from "../../protocol/ids.ts";
import { TraceEventStoreCorruptionError, JsonlTraceEventStore } from "../../trace/event-store.ts";
import type { TraceEvent } from "../../trace/types.ts";
import {
	emptySessionTelemetryReport,
	projectSessionTelemetryAggregate,
	type SessionTelemetryReport,
	type TelemetryCoverageReason,
	type TelemetrySourceState,
} from "./report.ts";
import { LOCAL_TELEMETRY_TRANSPORT_INVENTORY, createProductionTransportCoverageRegistry } from "./coverage.ts";
import { readSessionTraceIndex } from "./trace-index.ts";

export interface TelemetrySessionCatalogEntry {
	readonly sessionId: SessionId;
	readonly createdAtMs: number;
	readonly updatedAtMs: number;
}

export interface TelemetrySessionCatalogReader {
	list(): Promise<readonly TelemetrySessionCatalogEntry[]>;
}

export interface LocalTelemetryQueryOptions {
	readonly layout: RunledgerLayout;
	readonly recording?: EffectiveRecordingConfig;
	readonly sessionCatalog?: TelemetrySessionCatalogReader;
	readonly now?: () => Date;
	readonly environment?: Readonly<Record<string, string | undefined>>;
}

export type TelemetryReportRequest =
	| { readonly sessionId: SessionId }
	| { readonly latest: true };

export type TelemetryQueryErrorCode =
	| "invalid_session_id"
	| "session_not_found"
	| "no_sessions"
	| "session_store_unavailable"
	| "trace_storage_unavailable";

export type TelemetryQueryResult =
	| { readonly ok: true; readonly report: SessionTelemetryReport }
	| { readonly ok: false; readonly code: TelemetryQueryErrorCode };

export interface TelemetryStatusReport {
	readonly format: "runledger.telemetry.status";
	readonly recording: {
		readonly mode: EffectiveRecordingConfig["mode"];
		readonly failurePolicy: EffectiveRecordingConfig["failurePolicy"];
	};
	readonly localStore: { readonly state: "readable" | "missing" | "unavailable" };
	readonly transportCoverage: readonly {
		readonly transport: string;
		readonly state: "declared" | "unavailable";
		readonly owner: string;
		readonly boundary: string;
	}[];
	readonly memory: {
		readonly runtime: "available";
		readonly managedProcessTree: "available" | "platform_unsupported";
	};
	readonly otelExporter: { readonly state: "disabled" | "configured" };
}

export interface LocalTelemetryQuery {
	report(request: TelemetryReportRequest): Promise<TelemetryQueryResult>;
	status(): Promise<TelemetryStatusReport>;
}

export function createLocalTelemetryQuery(options: LocalTelemetryQueryOptions): LocalTelemetryQuery {
	const recording: EffectiveRecordingConfig = options.recording ?? { mode: "off", failurePolicy: "best_effort" };
	const catalog = options.sessionCatalog ?? createCanonicalSessionCatalogReader(options.layout);
	const now = options.now ?? (() => new Date());
	const fallbackCandidates = new Map<SessionId, readonly TraceFileCandidate[]>();
	const transportCoverage = createProductionTransportCoverageRegistry();
	return {
		report: async (request) => {
			let entries: readonly TelemetrySessionCatalogEntry[];
			try {
				entries = await catalog.list();
			} catch {
				return { ok: false, code: "session_store_unavailable" };
			}
			const session = resolveSession(entries, request);
			if (!session.ok) return session;
			try {
				return { ok: true, report: await projectSessionFromTraceFiles(options.layout, session.sessionId, recording.mode, now, fallbackCandidates) };
			} catch {
				return { ok: false, code: "trace_storage_unavailable" };
			}
		},
		status: async () => {
			let localStore: TelemetryStatusReport["localStore"] = { state: "missing" };
			try {
				await catalog.list();
				localStore = { state: "readable" };
			} catch {
				localStore = { state: existsSync(options.layout.database) ? "unavailable" : "missing" };
			}
			const environment = options.environment ?? process.env;
			const exporterConfigured = environment.OTEL_SDK_DISABLED !== "true" && typeof environment.OTEL_EXPORTER_OTLP_ENDPOINT === "string" && environment.OTEL_EXPORTER_OTLP_ENDPOINT.length > 0;
			return {
				format: "runledger.telemetry.status",
				recording: { mode: recording.mode, failurePolicy: recording.failurePolicy },
				localStore,
				transportCoverage: LOCAL_TELEMETRY_TRANSPORT_INVENTORY.map((entry) => ({
					...entry,
					state: transportCoverage.get(entry.transport)?.state === "measured" ? "declared" as const : "unavailable" as const,
				})),
				memory: { runtime: "available", managedProcessTree: runtimeWorkspacePlatform() === "linux" ? "available" : "platform_unsupported" },
				otelExporter: { state: exporterConfigured ? "configured" : "disabled" },
			};
		},
	};
}

function resolveSession(
	entries: readonly TelemetrySessionCatalogEntry[],
	request: TelemetryReportRequest,
): { readonly ok: true; readonly sessionId: SessionId } | { readonly ok: false; readonly code: TelemetryQueryErrorCode } {
	if ("sessionId" in request) {
		if (!isRuntimeId(request.sessionId, "session")) return { ok: false, code: "invalid_session_id" };
		return entries.some((entry) => entry.sessionId === request.sessionId)
			? { ok: true, sessionId: request.sessionId }
			: { ok: false, code: "session_not_found" };
	}
	if (entries.length === 0) return { ok: false, code: "no_sessions" };
	const latest = [...entries].sort((left, right) => right.updatedAtMs - left.updatedAtMs || right.createdAtMs - left.createdAtMs || left.sessionId.localeCompare(right.sessionId))[0]!;
	return { ok: true, sessionId: latest.sessionId };
}

async function projectSessionFromTraceFiles(
	layout: RunledgerLayout,
	sessionId: SessionId,
	recordingMode: EffectiveRecordingConfig["mode"],
	now: () => Date,
	fallbackCache: Map<SessionId, readonly TraceFileCandidate[]>,
): Promise<SessionTelemetryReport> {
	if (recordingMode === "off") {
		return emptySessionTelemetryReport(sessionId, { state: "recording_off", reason: "recording_disabled", recordingMode, generatedAt: now().toISOString() });
	}
	let indexed: readonly TraceFileCandidate[] | undefined;
	try {
		const entries = await readSessionTraceIndex(layout, sessionId);
		if (entries !== undefined) indexed = entries.map((entry) => ({ ...entry, indexed: true }));
	} catch {
		// 派生索引损坏不改变 totals；下面回退 canonical Event Store 扫描。
	}
	const cached = fallbackCache.get(sessionId);
	let candidates = indexed === undefined ? cached : mergeTraceCandidates(cached ?? [], indexed);
	if (candidates === undefined) {
		candidates = await scanTraceCandidatesForSession(layout.events, sessionId);
		fallbackCache.set(sessionId, candidates);
	}
	let traces;
	try {
		traces = await replayTraceCandidates(candidates, sessionId);
	} catch (error) {
		if (!(error instanceof DerivedTraceIndexMismatch)) throw error;
		const fallback = await scanTraceCandidatesForSession(layout.events, sessionId);
		fallbackCache.set(sessionId, fallback);
		traces = await replayTraceCandidates(fallback, sessionId);
	}
	const result = projectSessionTelemetryAggregate({ sessionId, traces, recordingMode, generatedAt: now().toISOString() });
	if (!result.ok) return emptySessionTelemetryReport(sessionId, { state: "tampered", reason: "trace_tampered", recordingMode, generatedAt: now().toISOString(), traceIds: traces.map((trace) => trace.traceId) });
	return result.report;
}

interface TraceFileCandidate {
	readonly traceId: TraceId;
	readonly filePath: string;
	readonly indexed: boolean;
	readonly knownTampered?: boolean;
}

class DerivedTraceIndexMismatch extends Error {}

function mergeTraceCandidates(left: readonly TraceFileCandidate[], right: readonly TraceFileCandidate[]): readonly TraceFileCandidate[] {
	const merged = new Map<TraceId, TraceFileCandidate>();
	for (const candidate of [...left, ...right]) merged.set(candidate.traceId, candidate);
	return [...merged.values()].sort((a, b) => a.traceId.localeCompare(b.traceId));
}

async function scanTraceCandidatesForSession(root: string, sessionId: SessionId): Promise<readonly TraceFileCandidate[]> {
	const result: TraceFileCandidate[] = [];
	for (const filePath of await collectTraceFiles(root)) {
		const traceId = traceIdFromFile(filePath);
		if (traceId === undefined) continue;
		try {
			const store = new JsonlTraceEventStore({ filePath, traceId, createDirectories: false });
			const events = await store.events();
			if (traceBelongsToSession(events, sessionId)) result.push({ traceId, filePath, indexed: false });
		} catch (error) {
			if (!(error instanceof TraceEventStoreCorruptionError)) throw error;
			const hint = await traceFileSessionHint(filePath, sessionId);
			if (hint !== "different_session") result.push({ traceId, filePath, indexed: false, knownTampered: true });
		}
	}
	return result;
}

async function replayTraceCandidates(
	candidates: readonly TraceFileCandidate[],
	sessionId: SessionId,
): Promise<Array<{ readonly traceId: TraceId; readonly events?: readonly TraceEvent[]; readonly state?: "available" | "missing" | "tampered" }>> {
	const traces: Array<{ readonly traceId: TraceId; readonly events?: readonly TraceEvent[]; readonly state?: "available" | "missing" | "tampered" }> = [];
	for (const candidate of candidates) {
		if (candidate.knownTampered === true) {
			traces.push({ traceId: candidate.traceId, state: "tampered" });
			continue;
		}
		try {
			const info = await lstat(candidate.filePath);
			if (info.isSymbolicLink() || !info.isFile()) throw new DerivedTraceIndexMismatch();
			const store = new JsonlTraceEventStore({ filePath: candidate.filePath, traceId: candidate.traceId, createDirectories: false });
			const events = await store.events();
			if (!traceBelongsToSession(events, sessionId)) {
				if (candidate.indexed) throw new DerivedTraceIndexMismatch();
				continue;
			}
			traces.push({ traceId: candidate.traceId, events, state: "available" });
		} catch (error) {
			if (error instanceof DerivedTraceIndexMismatch) throw error;
			if (error instanceof TraceEventStoreCorruptionError) {
				traces.push({ traceId: candidate.traceId, state: "tampered" });
				continue;
			}
			if (candidate.indexed && isNotFound(error)) throw new DerivedTraceIndexMismatch();
			throw error;
		}
	}
	return traces;
}

function traceIdFromFile(filePath: string): TraceId | undefined {
	const name = path.basename(filePath, ".jsonl");
	return isRuntimeId(name, "trace") ? name as TraceId : undefined;
}

function traceBelongsToSession(events: readonly TraceEvent[], sessionId: SessionId): boolean {
	return events.some((event) => event.observation?.correlation.sessionId === sessionId || event.metadata?.sessionId === sessionId);
}

async function traceFileSessionHint(filePath: string, sessionId: SessionId): Promise<"requested_session" | "different_session" | "unknown"> {
	try {
		const firstLine = (await readFile(filePath, "utf8")).split(/\r?\n/u).find((line) => line.length > 0);
		if (firstLine === undefined) return "unknown";
		const value = JSON.parse(firstLine) as { readonly metadata?: { readonly sessionId?: unknown } };
		return value.metadata?.sessionId === sessionId ? "requested_session" : "different_session";
	} catch {
		return "unknown";
	}
}

async function collectTraceFiles(root: string): Promise<readonly string[]> {
	const result: string[] = [];
	if (!existsSync(root)) return result;
	const walk = async (directory: string, depth: number): Promise<void> => {
		const entries = await readdir(directory, { withFileTypes: true });
		for (const entry of entries) {
			const target = path.join(directory, entry.name);
			const info = await lstat(target);
			if (info.isSymbolicLink()) throw new Error("trace storage contains a symbolic link");
			if (entry.isDirectory() && depth < 3) {
				await walk(target, depth + 1);
			} else if (entry.isFile() && depth === 3 && entry.name.endsWith(".jsonl")) {
				result.push(target);
			}
		}
	};
	await walk(root, 0);
	result.sort((left, right) => left.localeCompare(right));
	return result;
}

function isNotFound(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && (error as { readonly code?: unknown }).code === "ENOENT";
}

function createCanonicalSessionCatalogReader(layout: RunledgerLayout): TelemetrySessionCatalogReader {
	return {
		list: async () => {
			const db = openSessionDatabase(layout.database, { readOnly: true });
			try {
				const compatibility = checkStoreCompatibility(db);
				if (!compatibility.ok || compatibility.header.admission !== "ready") throw new Error("session store is unavailable");
				return new SessionStore(db).listSessions().map((entry) => ({
					sessionId: entry.sessionId as SessionId,
					createdAtMs: entry.createdAtMs,
					updatedAtMs: entry.updatedAtMs,
				}));
			} finally {
				db.close();
			}
		},
	};
}

export function telemetryCoverageReasonForSource(state: TelemetrySourceState): TelemetryCoverageReason {
	return state === "tampered" ? "trace_tampered" : state === "missing" ? "trace_missing" : state === "recording_off" ? "recording_disabled" : "sample_failed";
}
