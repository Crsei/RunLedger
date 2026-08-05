import * as path from "node:path";
import { runtimePathFlavor as runtimePlatformPathFlavor } from "../../workspace/runtime-platform.ts";
import { lstat, readdir } from "node:fs/promises";
import {
	recordingConfigDigest,
	type EffectiveRecordingConfig,
} from "../../storage/settings-manager.ts";
import {
	isContainedRuntimePath,
	traceEventRelativeLocator,
	type RunledgerLayout,
	type RuntimePathFlavor,
} from "../contracts/storage-layout.ts";
import { createRuntimeId, type TraceId } from "../protocol/ids.ts";
import { FileArtifactStore } from "./artifact-store.ts";
import { JsonlTraceEventStore } from "./event-store.ts";
import {
	RuntimeTraceRecorder,
	type TraceRecordingDiagnostic,
} from "./recorder.ts";

export interface TraceRecorderFactoryInput {
	readonly sessionId: string;
	/** Optional stable identity for Host-owned work that may be materialized after restart. */
	readonly traceId?: TraceId;
}

export interface TraceRecorderFactory {
	create(input: TraceRecorderFactoryInput): Promise<RuntimeTraceRecorder | undefined>;
}

export interface LocalTraceRecorderFactoryOptions {
	readonly layout: RunledgerLayout;
	readonly config: EffectiveRecordingConfig;
	readonly redactionPolicyDigest?: string;
	readonly now?: () => Date;
	readonly createTraceId?: () => TraceId;
	readonly onDiagnostic?: (diagnostic: TraceRecordingDiagnostic) => void;
}

export class TraceStorageSecurityError extends Error {
	public readonly code = "trace_storage_symlink" as const;

	public constructor() {
		super("trace storage path contains a symbolic link");
		this.name = "TraceStorageSecurityError";
	}
}

/** 将用户级 recording 配置绑定到唯一 canonical user-home layout。 */
export function createLocalTraceRecorderFactory(
	options: LocalTraceRecorderFactoryOptions,
): TraceRecorderFactory {
	const now = options.now ?? (() => new Date());
	const createTraceId = options.createTraceId ?? (() => createRuntimeId("trace") as TraceId);
	const onDiagnostic = options.onDiagnostic ?? defaultDiagnosticSink;

	return {
		create: async (input) => {
			if (options.config.mode === "off") return undefined;
			const traceId = input.traceId ?? createTraceId();
			await assertNoSymlinkComponents(options.layout.home, options.layout.events);
			const createdAt = now().toISOString();
			const relativeLocator = traceEventRelativeLocator(traceId, createdAt);
			const filePath = input.traceId === undefined
				? path.resolve(options.layout.home, relativeLocator)
				: await findExistingTraceEventFile(options.layout.events, traceId) ?? path.resolve(options.layout.home, relativeLocator);
			const flavor: RuntimePathFlavor = runtimePlatformPathFlavor();
			if (!isContainedRuntimePath(options.layout.home, filePath, flavor)) {
				throw new Error("trace event path escapes RunLedger home");
			}
			await assertNoSymlinkComponents(options.layout.home, filePath);
			if (options.config.mode === "events_and_artifacts") {
				await assertNoSymlinkComponents(options.layout.home, options.layout.artifacts);
				await assertNoSymlinkComponents(options.layout.home, options.layout.artifactMetadata);
			}
			const eventStore = new JsonlTraceEventStore({ filePath, traceId });
			const artifactStore = options.config.mode === "events_and_artifacts"
				? new FileArtifactStore({
					dataRoot: options.layout.artifacts,
					metadataRoot: options.layout.artifactMetadata,
				})
				: undefined;
			return new RuntimeTraceRecorder({
				eventStore,
				...(artifactStore === undefined ? {} : { artifactStore }),
				traceId,
				redactionPolicyDigest: options.redactionPolicyDigest ?? "policy_trace_v1",
				mode: options.config.mode,
				failurePolicy: options.config.failurePolicy,
				onDiagnostic,
				metadata: {
					recordingMode: options.config.mode,
					failurePolicy: options.config.failurePolicy,
					recordingConfigDigest: recordingConfigDigest(options.config),
				},
			});
		},
	};
}

async function findExistingTraceEventFile(eventsRoot: string, traceId: TraceId): Promise<string | undefined> {
	let years;
	try {
		years = await readdir(eventsRoot, { withFileTypes: true });
	} catch (error) {
		if (isNotFound(error)) return undefined;
		throw error;
	}
	for (const year of years) {
		if (!year.isDirectory() || !/^\d{4}$/u.test(year.name)) continue;
		let months;
		try {
			months = await readdir(path.join(eventsRoot, year.name), { withFileTypes: true });
		} catch (error) {
			if (isNotFound(error)) continue;
			throw error;
		}
		for (const month of months) {
			if (!month.isDirectory() || !/^\d{2}$/u.test(month.name)) continue;
			let days;
			try {
				days = await readdir(path.join(eventsRoot, year.name, month.name), { withFileTypes: true });
			} catch (error) {
				if (isNotFound(error)) continue;
				throw error;
			}
			for (const day of days) {
				if (!day.isDirectory() || !/^\d{2}$/u.test(day.name)) continue;
				const candidate = path.join(eventsRoot, year.name, month.name, day.name, `${traceId}.jsonl`);
				try {
					const stat = await lstat(candidate);
					if (stat.isSymbolicLink()) throw new TraceStorageSecurityError();
					if (stat.isFile()) return candidate;
				} catch (error) {
					if (error instanceof TraceStorageSecurityError) throw error;
					if (!isNotFound(error)) throw error;
				}
			}
		}
	}
	return undefined;
}

async function assertNoSymlinkComponents(home: string, target: string): Promise<void> {
	const relative = path.relative(home, target);
	let current = home;
	for (const segment of relative.split(path.sep).filter((value) => value.length > 0)) {
		current = path.join(current, segment);
		try {
			if ((await lstat(current)).isSymbolicLink()) throw new TraceStorageSecurityError();
		} catch (error) {
			if (error instanceof TraceStorageSecurityError) throw error;
			if (isNotFound(error)) break;
			throw error;
		}
	}
}

function isNotFound(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function defaultDiagnosticSink(diagnostic: TraceRecordingDiagnostic): void {
	process.stderr.write(`[runledger] ${diagnostic.code}\n`);
}
