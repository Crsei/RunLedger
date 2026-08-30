/**
 * S3 拆分:lost/uncertain 恢复投影与收尾。
 *
 * Takeover/恢复只结算 durable projection,绝不按 PID/PTY handle 重连或
 * 猜测进程;recoverUnattached 的 Trace 物化失败在 fail_closed 下抛错。
 */

import type { RunledgerLayout } from "../../contracts/storage-layout.ts";
import type { ProcessManager } from "../../process/manager.ts";
import type { ManagedProcessSummary } from "../../process/types.ts";
import { FileProcessOutputStore } from "../../../storage/process/output-store.ts";
import type { RecordingFailurePolicy } from "../../../storage/settings-manager.ts";
import type { ManagedProcessBackendPort } from "../../../storage/process/control-plane.ts";
import type { ManagedProcessControlPlane } from "../../../storage/process/control-plane.ts";

export interface ProcessRecoveryPort {
	readonly manager: ProcessManager;
	readonly plane: ManagedProcessControlPlane;
	readonly backend: ManagedProcessBackendPort;
	readonly storageKey: string;
	readonly layout: RunledgerLayout;
	readonly recordingFailurePolicy: RecordingFailurePolicy | undefined;
	readonly finishProcessTrace: (summary: ManagedProcessSummary) => Promise<void>;
}

/** Takeover 只结算 durable projection；绝不按 PID/PTY handle 重连。 */
export async function recoverUnattachedProcesses(port: ProcessRecoveryPort): ReturnType<ProcessManager["recoverUnattached"]> {
	const recovered = await port.manager.recoverUnattached();
	for (const result of recovered) {
		if (!result.ok) continue;
		const output = new FileProcessOutputStore({
			layout: port.layout,
			workspaceStorageKey: port.storageKey,
			executionId: result.handle.executionId,
			attemptId: result.handle.attemptId,
		});
		if (!await port.plane.materializeRecoveredOutput(result.handle, output)) {
			if (port.recordingFailurePolicy === "fail_closed") {
				throw new Error("Session recovered process Trace materialization failed");
			}
			continue;
		}
		await port.finishProcessTrace(result.summary);
	}
	return recovered;
}

export function hasProcessRecoveryUncertainty(port: Pick<ProcessRecoveryPort, "manager" | "backend">): boolean {
	return port.manager.handles().some((handle) => {
		const result = port.manager.query(handle);
		if (!result.ok) return true;
		return result.summary.state === "lost" || result.summary.state === "uncertain" ||
			(port.backend.control(handle) === undefined && !isTerminalSummary(result.summary));
	});
}

export function isTerminalSummary(summary: ManagedProcessSummary): boolean {
	return summary.terminal !== undefined;
}
