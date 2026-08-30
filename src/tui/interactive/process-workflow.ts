/**
 * S7 拆分:process workflow —— Host-owned managed process list/terminal。
 */

import type { ExecutionId } from "../../runtime/protocol/ids.ts";
import type { InteractiveModePorts } from "./types.ts";

function isSafeExecutionId(value: string): boolean {
	return /^execution_[A-Za-z0-9._~-]{1,128}$/u.test(value);
}

export class ProcessWorkflow {
	private readonly port: InteractiveModePorts;

	public constructor(port: InteractiveModePorts) {
		this.port = port;
	}

	/** R9:打开 Host-owned managed process list；没有 facade 时保持显式不可用。 */
	public openProcessList(): void {
		const overlay = this.port.processOverlayComponent;
		if (!overlay) {
			this.port.showNotice("Managed process view is unavailable in this session.", "error");
			return;
		}
		this.port.showOverlayModal(overlay, { anchor: "center" }, "process");
		void overlay.openList();
	}

	/** R9:按 safe execution id 打开 terminal overlay，不连接 raw PTY endpoint。 */
	public openProcessTerminal(executionId: string): void {
		const overlay = this.port.processOverlayComponent;
		if (!overlay || !isSafeExecutionId(executionId)) {
			this.port.showNotice("A valid managed execution id is required.", "error");
			return;
		}
		this.port.showOverlayModal(overlay, { anchor: "center" }, "process");
		void overlay.openTerminal(executionId as ExecutionId);
	}

	/** 仅暴露给测试/上层 command router 的状态查询，不暴露 backend。 */
	public isProcessOverlayOpen(): boolean {
		return this.port.processOverlaySnapshot() ?? false;
	}
}
