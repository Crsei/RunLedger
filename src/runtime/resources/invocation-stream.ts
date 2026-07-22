/** 动态资源 invocation 的 bounded progress + exactly-one terminal 消费器。 */

import { canonicalDigest } from "../protocol/v3/canonical-json.ts";
import { isRuntimeResourceInvocationFrame } from "./schemas.ts";
import { MAX_RESOURCE_PROGRESS_FRAMES } from "./schemas.ts";
import type {
	ResourcePortError,
	RuntimeResourceInvocationFrame,
	RuntimeToolInvocation,
	RuntimeToolResult,
} from "./types.ts";

export type ResourceInvocationStreamResult =
	| { ok: true; result: RuntimeToolResult }
	| { ok: false; error: ResourcePortError };

function failure(code: ResourcePortError["code"], reason: string): ResourceInvocationStreamResult {
	return {
		ok: false,
		error: {
			code,
			messageDigest: canonicalDigest(reason),
			retryable: false,
		},
	};
}

function frameMatchesInvocation(
	frame: RuntimeResourceInvocationFrame,
	invocation: RuntimeToolInvocation,
): boolean {
	return (
		frame.authorityId === invocation.authorityId &&
		frame.tenantId === invocation.tenantId &&
		frame.principalId === invocation.principalId &&
		frame.requestId === invocation.requestId &&
		frame.handshakeDigest === invocation.handshake.handshakeDigest &&
		frame.invocationSequence === invocation.invocationSequence
	);
}

/**
 * adapter stream 只能发有限 progress，随后恰好一个 terminal。缺失、重复、
 * terminal 后 progress、sequence 缺口或 stale handshake 全部 fail closed。
 */
export async function consumeResourceInvocation(
	invocation: RuntimeToolInvocation,
	frames: AsyncIterable<RuntimeResourceInvocationFrame>,
): Promise<ResourceInvocationStreamResult> {
	let expectedSequence = invocation.invocationSequence;
	let terminal: RuntimeToolResult | undefined;
	let frameCount = 0;
	for await (const frame of frames) {
		frameCount += 1;
		if (frameCount > MAX_RESOURCE_PROGRESS_FRAMES + 1) {
			return failure("conflict", "resource invocation exceeded the bounded progress limit");
		}
		if (!isRuntimeResourceInvocationFrame(frame) || !frameMatchesInvocation(frame, invocation)) {
			return failure("invalid_request", "resource invocation frame is invalid or stale");
		}
		if (terminal) return failure("conflict", "resource invocation emitted data after terminal");
		if (frame.sequence !== expectedSequence) {
			return failure("conflict", "resource invocation frame sequence is discontinuous");
		}
		expectedSequence += 1;
		if (frame.kind === "terminal") terminal = frame.result;
	}
	return terminal
		? { ok: true, result: terminal }
		: failure("unavailable", "resource invocation ended without a terminal frame");
}
