/** Host 内显式 driver 的纯 generation/revision fencing。 */

import type { ConnectionId, PrincipalId } from "../protocol/ids.ts";

export interface DriverRef {
	readonly principalId: PrincipalId;
	readonly connectionId: ConnectionId;
}

export interface DriverState {
	readonly hostGeneration: number;
	readonly sessionGeneration: number;
	readonly driverRevision: number;
	readonly driver?: DriverRef;
}

export interface DriverFenceInput {
	readonly principalId: PrincipalId;
	readonly connectionId: ConnectionId;
	readonly expectedHostGeneration: number;
	readonly expectedSessionGeneration: number;
	readonly expectedDriverRevision: number;
}

export type DriverErrorCode =
	| "host_generation_conflict"
	| "session_generation_conflict"
	| "driver_revision_conflict"
	| "driver_already_claimed"
	| "driver_not_claimed"
	| "observer_mutation_forbidden"
	| "driver_not_active";

export type DriverResult =
	| { readonly ok: true; readonly state: DriverState }
	| { readonly ok: false; readonly code: DriverErrorCode };

export function createDriverState(input: {
	hostGeneration: number;
	sessionGeneration: number;
}): DriverState {
	return {
		hostGeneration: input.hostGeneration,
		sessionGeneration: input.sessionGeneration,
		driverRevision: 0,
	};
}

function checkFence(state: DriverState, input: DriverFenceInput): DriverResult | undefined {
	if (input.expectedHostGeneration !== state.hostGeneration) return { ok: false, code: "host_generation_conflict" };
	if (input.expectedSessionGeneration !== state.sessionGeneration) return { ok: false, code: "session_generation_conflict" };
	if (input.expectedDriverRevision !== state.driverRevision) return { ok: false, code: "driver_revision_conflict" };
	return undefined;
}

export function claimDriver(
	state: DriverState,
	input: DriverFenceInput & {
		readonly mode: "claim" | "transfer";
		readonly nextDriver?: DriverRef;
	},
): DriverResult {
	const fenceError = checkFence(state, input);
	if (fenceError) return fenceError;
	if (input.mode === "claim" && state.driver) return { ok: false, code: "driver_already_claimed" };
	if (input.mode === "transfer" && !state.driver) return { ok: false, code: "driver_not_claimed" };
	if (
		input.mode === "transfer" &&
		state.driver &&
		(state.driver.principalId !== input.principalId || state.driver.connectionId !== input.connectionId)
	) {
		return { ok: false, code: "observer_mutation_forbidden" };
	}
	const nextDriver = input.mode === "transfer" && input.nextDriver
		? input.nextDriver
		: { principalId: input.principalId, connectionId: input.connectionId };
	return {
		ok: true,
		state: {
			...state,
			driver: nextDriver,
			driverRevision: state.driverRevision + 1,
		},
	};
}

export function authorizeDriverMutation(state: DriverState, input: DriverFenceInput): DriverResult {
	const fenceError = checkFence(state, input);
	if (fenceError) return fenceError;
	if (!state.driver) return { ok: false, code: "driver_not_active" };
	if (state.driver.principalId !== input.principalId || state.driver.connectionId !== input.connectionId) {
		return { ok: false, code: "observer_mutation_forbidden" };
	}
	return { ok: true, state };
}

export function releaseDriver(state: DriverState, input: DriverFenceInput): DriverResult {
	const authorization = authorizeDriverMutation(state, input);
	if (!authorization.ok) return authorization;
	return {
		ok: true,
		state: {
			...state,
			driver: undefined,
			driverRevision: state.driverRevision + 1,
		},
	};
}
