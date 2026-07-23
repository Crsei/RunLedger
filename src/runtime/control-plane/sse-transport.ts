/** HTTP/SSE 的无监听 adapter contract；首版强制 loopback/local socket。 */

import { isAbsolute } from "node:path";
import { canonicalJson } from "../protocol/v3/canonical-json.ts";
import type { ControlPlaneResult } from "./errors.ts";
import { controlPlaneFailure } from "./errors.ts";
import type { ControlPlaneFrameDispatcher } from "./jsonl-transport.ts";
import { isLoopbackAddress, type PeerConnectionEvidence } from "./local-peer.ts";
import type { ControlPlaneResponse, StableEventDelivery } from "./types.ts";
import { errorResponse, requestIdOf } from "./types.ts";

export type LocalSseBindTarget =
	| { kind: "tcp"; host: string; port: number }
	| { kind: "unix_socket"; path: string; mode: 0o600 | 0o660 }
	| { kind: "named_pipe"; path: string };

export function validateLocalSseBindTarget(target: LocalSseBindTarget): ControlPlaneResult<LocalSseBindTarget> {
	switch (target.kind) {
		case "tcp":
			if (!isLoopbackAddress(target.host)) {
				return controlPlaneFailure("remote_disabled", "Control Plane TCP bind target must be loopback");
			}
			if (!Number.isInteger(target.port) || target.port < 0 || target.port > 65_535) {
				return controlPlaneFailure("invalid_request", "Control Plane TCP port is invalid");
			}
			return { ok: true, value: target };
		case "unix_socket":
			if (!isAbsolute(target.path) || target.path.length > 512) {
				return controlPlaneFailure("invalid_request", "Control Plane Unix socket path must be bounded and absolute");
			}
			return controlPlaneFailure(
				"unsupported_feature",
				"Unix socket listener requires real peer-credential enforcement and is not implemented",
			);
		case "named_pipe":
			if (!/^\\\\\.\\pipe\\[A-Za-z0-9._-]+$/.test(target.path)) {
				return controlPlaneFailure("invalid_request", "Control Plane named pipe path is invalid");
			}
			return controlPlaneFailure(
				"unsupported_feature",
				"named-pipe listener requires real ACL peer identity enforcement and is not implemented",
			);
	}
}

export interface SseAdapterContractOptions {
	target: LocalSseBindTarget;
	dispatcher: ControlPlaneFrameDispatcher;
}

export class SseAdapterContract {
	public readonly target: LocalSseBindTarget;
	readonly #dispatcher: ControlPlaneFrameDispatcher;

	private constructor(options: SseAdapterContractOptions) {
		this.target = options.target;
		this.#dispatcher = options.dispatcher;
	}

	public static create(options: SseAdapterContractOptions): ControlPlaneResult<SseAdapterContract> {
		const target = validateLocalSseBindTarget(options.target);
		return target.ok ? { ok: true, value: new SseAdapterContract(options) } : target;
	}

	/** 实际 HTTP server 只需把已解析 body 交给这里；schema 与 JSONL 完全复用。 */
	public async dispatch(frame: unknown, peer: PeerConnectionEvidence): Promise<ControlPlaneResponse> {
		if (peer.transport !== "sse" || !isLoopbackAddress(peer.remoteAddress)) {
			return errorResponse(requestIdOf(frame), {
				code: "remote_disabled",
				message: "SSE Control Plane accepts loopback peers only",
				retryable: false,
			});
		}
		try {
			return await this.#dispatcher.dispatch(frame);
		} catch (error) {
			return errorResponse(requestIdOf(frame), {
				code: "internal_error",
				message: "Control Plane dispatcher failed",
				retryable: false,
				details: { errorName: error instanceof Error ? error.name : "UnknownError" },
			});
		}
	}

	public encodeEvent(delivery: StableEventDelivery): string {
		return `id: ${delivery.eventId}\nevent: runtime.event\ndata: ${canonicalJson(delivery)}\n\n`;
	}
}
