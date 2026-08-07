/**
 * R3:OwnerFence 与 auth token 的纯契约工具(06 §4.5/§4.6/§5.3)。
 *
 * - authToken 每个 generation 32 字节随机值,hex 编码 64 字符;只允许出现在
 *   owner row(BLOB)与当前进程内存;
 * - handshake/token 校验使用 constant-time compare,防止同用户恶意进程时序侧信道;
 * - staleness 判定冻结为 SESSION_OWNER_HEARTBEAT_PARAMS 参数。
 */

import { randomBytes, timingSafeEqual } from "node:crypto";
import { SESSION_OWNER_AUTH_TOKEN_BYTES, SESSION_OWNER_HEARTBEAT_PARAMS, type OwnerFence } from "./types.ts";
import { createRuntimeId, type RuntimeInstanceId, type SessionId } from "../protocol/ids.ts";

/** 生成 32-byte 随机 auth token 的 hex 编码(64 字符)。只存 owner row + 内存。 */
export function generateOwnerAuthToken(): string {
	return randomBytes(SESSION_OWNER_AUTH_TOKEN_BYTES).toString("hex");
}

/**
 * §4.6 constant-time compare:两者必须都是 64 位 hex,否则直接失败;
 * 不泄露部分匹配长度,不进入日志。
 */
export function ownerTokenConstantTimeEqual(actual: string, expected: string): boolean {
	if (actual.length !== 64 || expected.length !== 64) return false;
	const a = Buffer.from(actual, "hex");
	const b = Buffer.from(expected, "hex");
	if (a.length !== b.length) return false;
	return timingSafeEqual(a, b);
}

/** 新 runtimeId 或按 sessionId 派生确定性 runtimeId(测试/重启恢复用)。 */
export function createOwnerRuntimeId(seed: string): RuntimeInstanceId {
	return createRuntimeId("runtime", seed);
}

/** §5.3:heartbeat 是否已 stale。 */
export function isHeartbeatStale(
	heartbeatAtMs: number | undefined,
	nowMs: number,
	staleThresholdMs: number = SESSION_OWNER_HEARTBEAT_PARAMS.staleThresholdMs,
): boolean {
	if (heartbeatAtMs === undefined) return true;
	return nowMs - heartbeatAtMs > staleThresholdMs;
}

export interface OwnerFenceWithToken {
	readonly fence: OwnerFence;
	readonly authTokenHex: string;
}

export function createFence(sessionId: SessionId, runtimeId: RuntimeInstanceId, generation: number): OwnerFence {
	return { sessionId, runtimeId, generation };
}

export { SESSION_OWNER_HEARTBEAT_PARAMS };
