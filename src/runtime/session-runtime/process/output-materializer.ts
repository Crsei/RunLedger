/**
 * S3 拆分:进程输出物化与 Trace 录制/收尾、恢复读回。
 *
 * 每个 executionId:attemptId 至多一个 recorder,terminal 时 finishRun 一次;
 * finish 任务并发去重,失败后从任务表清理以便重试。
 */

import { createRuntimeId } from "../../protocol/ids.ts";
import { runtimeDigest } from "../../protocol/foundation.ts";
import type { RuntimeTraceRecorder } from "../../trace/recorder.ts";
import type { TraceRecorderFactory } from "../../trace/composition.ts";
import type { ExecutionHandleRef, ManagedProcessSummary } from "../../process/types.ts";
import type { ProcessOutputMaterializationRecord } from "../../process/output-artifact.ts";
import { FileProcessOutputStore, type ProcessOutputReadResult } from "../../../storage/process/output-store.ts";
import type { SessionProcessCompositionOptions } from "./composition.ts";

export class SessionProcessOutputMaterializer {
	private readonly options: SessionProcessCompositionOptions;
	private readonly storageKey: string;
	private readonly processTraceRecorders = new Map<string, Promise<RuntimeTraceRecorder | undefined>>();
	private readonly processTraceTerminalTasks = new Map<string, Promise<void>>();
	private readonly finishedProcessTraces = new Set<string>();

	public constructor(options: SessionProcessCompositionOptions, storageKey: string) {
		this.options = options;
		this.storageKey = storageKey;
	}

	public async recordOutputMaterialization(handle: ExecutionHandleRef, record: ProcessOutputMaterializationRecord): Promise<void> {
		const content = record.materialization.traceContent;
		if (record.mode === "off" || content === undefined) return;
		const factory = this.options.traceRecorderFactory;
		if (factory === undefined) {
			if (this.options.recordingFailurePolicy === "fail_closed") throw new Error("Session process Trace recorder is unavailable");
			return;
		}
		const key = `${handle.executionId}:${handle.attemptId}`;
		let recorderPromise = this.processTraceRecorders.get(key);
		if (recorderPromise === undefined) {
			const traceId = createRuntimeId("trace", runtimeDigest({
				sessionId: this.options.fence.sessionId,
				ownerGeneration: handle.sessionGeneration,
				executionId: handle.executionId,
				attemptId: handle.attemptId,
			}).digest.slice(0, 64));
			recorderPromise = factory.create({
				sessionId: this.options.fence.sessionId,
				ownerGeneration: this.options.fence.generation,
				traceId,
			}).catch((error: unknown) => {
				if (this.options.recordingFailurePolicy === "fail_closed") throw error;
				return undefined;
			});
			this.processTraceRecorders.set(key, recorderPromise);
		}
		const recorder = await recorderPromise;
		if (recorder === undefined) {
			if (this.options.recordingFailurePolicy === "fail_closed") throw new Error("Session process Trace recorder is unavailable");
			return;
		}
		await recorder.recordManagedProcessOutput({
			executionId: handle.executionId,
			attemptId: handle.attemptId,
			mode: record.mode,
			sourceDigest: record.sourceDigest,
			recordDigest: record.recordDigest,
			outputContent: content,
		});
	}

	public async finishProcessTrace(summary: ManagedProcessSummary): Promise<void> {
		const key = `${summary.handle.executionId}:${summary.handle.attemptId}`;
		if (this.finishedProcessTraces.has(key)) return;
		let task = this.processTraceTerminalTasks.get(key);
		if (task === undefined) {
			task = (async () => {
				const recorderPromise = this.processTraceRecorders.get(key);
				if (recorderPromise === undefined) return;
				const recorder = await recorderPromise;
				if (recorder === undefined) return;
				await recorder.finishRun(processTraceTerminal(summary.state));
				this.processTraceRecorders.delete(key);
				this.finishedProcessTraces.add(key);
			})();
			this.processTraceTerminalTasks.set(key, task);
		}
		try {
			await task;
		} finally {
			this.processTraceTerminalTasks.delete(key);
		}
	}

	public async readRecoveredOutput(
		handle: ExecutionHandleRef,
		cursor: { readonly sequence: number; readonly byteOffset: number },
		maxBytes: number,
	): Promise<ProcessOutputReadResult> {
		return new FileProcessOutputStore({
			layout: this.options.layout,
			workspaceStorageKey: this.storageKey,
			executionId: handle.executionId,
			attemptId: handle.attemptId,
		}).read(cursor, maxBytes);
	}
}

function processTraceTerminal(state: ManagedProcessSummary["state"]): Parameters<RuntimeTraceRecorder["finishRun"]>[0] {
	switch (state) {
		case "completed":
			return { phase: "finished" };
		case "failed":
		case "timed_out":
			return {
				phase: "failed",
				error: {
					code: state === "failed" ? "process_failed" : "process_timed_out",
					message: state === "failed" ? "managed process failed" : "managed process timed out",
					outcomeCertain: true,
				},
			};
		case "killed":
			return {
				phase: "interrupted",
				error: { code: "process_killed", message: "managed process was killed", outcomeCertain: true },
			};
		case "lost":
		case "uncertain":
			return {
				phase: "interrupted",
				error: {
					code: state === "lost" ? "process_lost" : "process_uncertain",
					message: state === "lost" ? "managed process was lost" : "managed process outcome is uncertain",
					outcomeCertain: false,
				},
			};
		case "queued":
		case "starting":
		case "running":
		case "backgrounded":
			return {
				phase: "interrupted",
				error: { code: "process_interrupted", message: "managed process was interrupted", outcomeCertain: false },
			};
	}
}
