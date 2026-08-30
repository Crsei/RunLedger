/**
 * S3 拆分:pipe/PTY 后端选择。
 *
 * 同一 ExecutionHandleRef 上唯一 backend 选择点:pty 请求走 PTY 后端,
 * 其余走 pipe 后端;control/handles 合并两个后端的视图。不持有进程状态。
 */

import type {
	ManagedProcessBackendControl,
	ManagedProcessBackendPort,
} from "../../../storage/process/control-plane.ts";
import type { BackendSpawnInput, BackendSpawnReceipt } from "../../process/manager.ts";
import type { ExecutionHandleRef } from "../../process/types.ts";

export class SessionCompositeProcessBackend implements ManagedProcessBackendPort {
	private readonly pipe: ManagedProcessBackendPort;
	private readonly pty: ManagedProcessBackendPort | undefined;

	public constructor(pipe: ManagedProcessBackendPort, pty: ManagedProcessBackendPort | undefined) {
		this.pipe = pipe;
		this.pty = pty;
	}

	public async spawn(input: BackendSpawnInput): Promise<BackendSpawnReceipt> {
		if (input.request.backend === "pty") {
			if (this.pty === undefined) throw new Error("PTY backend is unavailable");
			return this.pty.spawn(input);
		}
		return this.pipe.spawn(input);
	}

	public control(handle: ExecutionHandleRef): ManagedProcessBackendControl | undefined {
		return this.pty?.control(handle) ?? this.pipe.control(handle);
	}

	public handles(): readonly ExecutionHandleRef[] {
		return [...(this.pty?.handles?.() ?? []), ...(this.pipe.handles?.() ?? [])];
	}
}
