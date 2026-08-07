/**
 * R4:connection-scoped driver 状态机(06 §6.4)。
 *
 * - RuntimeServer 内存中同一时刻只允许一个 authenticated connection 持有
 *   driver role;SQLite 不保存跨 connection 仍有效的 driver_client_id;
 * - disconnect/takeover 强制 driver = NONE 并产生 revision 事件(durable,
 *   driver.claimed / driver.released / driver.reset_on_takeover);
 * - 本模块是纯状态机,不持有 socket/DB;持久化由 RuntimeServer 用 OwnerFence
 *   经 SessionStore.appendDriverEvent 完成。
 */

import type { ConnectionId } from "../protocol/ids.ts";

export type DriverEventType = "driver.claimed" | "driver.released" | "driver.reset_on_takeover";

export interface DriverHolder {
	readonly connectionId: ConnectionId;
	readonly clientId: string;
}

export interface DriverStateSnapshot {
	/** undefined 表示 driver = NONE(owner 内存中)。 */
	readonly driver: DriverHolder | undefined;
	readonly driverRevision: number;
	/** §3/§6.4:只用于 audit display,不能授予 driver authority。 */
	readonly lastDriverClientId: string | undefined;
}

export type DriverTransition =
	| { readonly kind: "claim"; readonly holder: DriverHolder }
	| { readonly kind: "release"; readonly holder: DriverHolder }
	| { readonly kind: "reset_on_takeover" };

export type DriverTransitionResult =
	| {
			readonly ok: true;
			readonly eventType: DriverEventType;
			readonly nextRevision: number;
	  }
	| { readonly ok: false; readonly code: "driver_revision_conflict" };

const INITIAL_STATE: DriverStateSnapshot = { driver: undefined, driverRevision: 0, lastDriverClientId: undefined };

export function initialDriverState(): DriverStateSnapshot {
	return { ...INITIAL_STATE };
}

/**
 * §6.4 唯一转移函数:
 * - claim:当前无 driver 或同 connection 幂等;被其他 connection 持有 → 冲突;
 * - release:只有当前 holder 可以释放;owner 内存中 driver 强制 NONE;
 * - reset_on_takeover:owner crash/takeover 后从 NONE 开始,旧 clientId 只留 audit。
 */
export function applyDriverTransition(state: DriverStateSnapshot, transition: DriverTransition): DriverTransitionResult {
	switch (transition.kind) {
		case "claim": {
			if (state.driver !== undefined && state.driver.connectionId !== transition.holder.connectionId) {
				return { ok: false, code: "driver_revision_conflict" };
			}
			const nextRevision = state.driverRevision + 1;
			return {
				ok: true,
				eventType: "driver.claimed",
				nextRevision,
			};
		}
		case "release": {
			if (state.driver === undefined || state.driver.connectionId !== transition.holder.connectionId) {
				return { ok: false, code: "driver_revision_conflict" };
			}
			return { ok: true, eventType: "driver.released", nextRevision: state.driverRevision + 1 };
		}
		case "reset_on_takeover": {
			if (state.driver === undefined && state.driverRevision === 0) {
				return { ok: false, code: "driver_revision_conflict" };
			}
			return { ok: true, eventType: "driver.reset_on_takeover", nextRevision: state.driverRevision + 1 };
		}
	}
}
