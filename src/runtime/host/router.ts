/** R2 test-only in-memory Host router with bounded replay/live delivery. */

import { canonicalDigest } from "../protocol/canonical-json.ts";
import { runtimeDigest, type RuntimeDigest } from "../protocol/foundation.ts";
import type { CommandId, ConnectionId, EventId, PrincipalId, SessionId } from "../protocol/ids.ts";
import { claimDriver, createDriverState, authorizeDriverMutation, type DriverState } from "./driver.ts";
import { RUNTIME_HOST_BOUNDS } from "./types.ts";
import { ResidentSessionRegistry, type ResidentSessionEntry } from "./resident-sessions.ts";

export interface HostClientConnection {
	readonly principalId: PrincipalId;
	readonly connectionId: ConnectionId;
}

export interface HostEvent {
	readonly eventId: EventId;
	readonly sessionId: SessionId;
	readonly sequence: number;
	readonly payloadDigest: RuntimeDigest;
	readonly payload: Record<string, unknown>;
}

export type HostSubscriptionFrame =
	| { readonly type: "event"; readonly event: HostEvent }
	| { readonly type: "resync_required"; readonly safeCursor: number };

export interface SubscribeHooks {
	readonly afterRegister?: () => void;
	readonly afterSnapshot?: () => void;
	readonly afterCursorEmitted?: () => void;
}

export interface SubscribeRequest extends HostClientConnection {
	readonly sessionId: SessionId;
	readonly cursor: number;
	readonly hooks?: SubscribeHooks;
}

export type SubscribeResult =
	| { readonly ok: true; readonly subscriptionId: string; readonly cursor: number }
	| { readonly ok: false; readonly code: "session_not_found" | "resync_required"; readonly safeCursor?: number };

export type RouterDriverResult =
	| { readonly ok: true; readonly hostGeneration: number; readonly sessionGeneration: number; readonly driverRevision: number }
	| { readonly ok: false; readonly code: string };

export type RouterMutationResult<T> =
	| { readonly ok: true; readonly value: T; readonly durable: true }
	| { readonly ok: false; readonly code: string };

interface SubscriptionState {
	readonly subscriptionId: string;
	readonly connectionId: ConnectionId;
	readonly principalId: PrincipalId;
	readonly sessionId: SessionId;
	active: boolean;
	queue: HostSubscriptionFrame[];
	pending: HostEvent[];
}

interface CommandResultRecord {
	readonly requestDigest: RuntimeDigest;
	readonly result: unknown;
}

interface SessionRoutingState<T> {
	readonly resident: ResidentSessionEntry<T>;
	driver: DriverState;
	history: HostEvent[];
	commandResults: Map<CommandId, CommandResultRecord>;
}

export interface InMemoryHostRouterOptions {
	readonly maxHistory?: number;
	readonly maxOutbox?: number;
}

/**
 * 该 router 只用于 R2 pure/in-memory composition；它不取得文件锁、不启动
 * Agent、不打开 socket，也不持有真实 process/backend 句柄。
 */
export class InMemoryHostRouter<T extends object = Record<string, unknown>> {
	private readonly sessions = new Map<SessionId, SessionRoutingState<T>>();
	private readonly subscriptions = new Map<string, SubscriptionState>();
	private readonly registry = new ResidentSessionRegistry<T>();
	private readonly maxHistory: number;
	private readonly maxOutbox: number;
	private nextSubscription = 0;

	public constructor(options: InMemoryHostRouterOptions = {}) {
		this.maxHistory = options.maxHistory ?? RUNTIME_HOST_BOUNDS.maxSubscriptionReplay;
		this.maxOutbox = options.maxOutbox ?? RUNTIME_HOST_BOUNDS.maxConnectionOutbox;
		if (!Number.isSafeInteger(this.maxHistory) || this.maxHistory < 1) throw new Error("maxHistory must be positive");
		if (!Number.isSafeInteger(this.maxOutbox) || this.maxOutbox < 1) throw new Error("maxOutbox must be positive");
	}

	public connect(connection: HostClientConnection): HostClientConnection {
		return { ...connection };
	}

	public ensureResidentSession(sessionId: SessionId, factory: () => T): T {
		const resident = this.registry.ensure(sessionId, factory);
		if (!this.sessions.has(sessionId)) {
			this.sessions.set(sessionId, {
				resident,
				driver: createDriverState({ hostGeneration: 1, sessionGeneration: resident.generation }),
				history: [],
				commandResults: new Map(),
			});
		}
		return resident.owner;
	}

	public markSessionActiveWork(sessionId: SessionId, activeWork: boolean): boolean {
		return this.registry.markActiveWork(sessionId, activeWork);
	}

	public sessionCanUnload(sessionId: SessionId): boolean {
		return this.registry.canUnload(sessionId);
	}

	public claimDriver(
		sessionId: SessionId,
		connection: HostClientConnection & { readonly driverRevision?: number },
		mode: "claim" | "transfer" = "claim",
	): RouterDriverResult {
		const session = this.sessions.get(sessionId);
		if (!session) return { ok: false, code: "session_not_found" };
		const result = claimDriver(session.driver, {
			mode,
			principalId: connection.principalId,
			connectionId: connection.connectionId,
			expectedHostGeneration: session.driver.hostGeneration,
			expectedSessionGeneration: session.driver.sessionGeneration,
			expectedDriverRevision: connection.driverRevision ?? session.driver.driverRevision,
		});
		if (!result.ok) return result;
		session.driver = result.state;
		return {
			ok: true,
			hostGeneration: result.state.hostGeneration,
			sessionGeneration: result.state.sessionGeneration,
			driverRevision: result.state.driverRevision,
		};
	}

	public mutate<TValue>(
		sessionId: SessionId,
		connection: HostClientConnection & { readonly driverRevision?: number },
		request: {
			readonly commandId: CommandId;
			readonly requestDigest: RuntimeDigest;
			readonly apply: () => TValue;
		},
	): RouterMutationResult<TValue> {
		const session = this.sessions.get(sessionId);
		if (!session) return { ok: false, code: "session_not_found" };
		const authorization = authorizeDriverMutation(session.driver, {
			principalId: connection.principalId,
			connectionId: connection.connectionId,
			expectedHostGeneration: session.driver.hostGeneration,
			expectedSessionGeneration: session.driver.sessionGeneration,
			expectedDriverRevision: connection.driverRevision ?? session.driver.driverRevision,
		});
		if (!authorization.ok) return authorization;
		const prior = session.commandResults.get(request.commandId);
		if (prior) {
			if (prior.requestDigest.digest !== request.requestDigest.digest) return { ok: false, code: "command_id_conflict" };
			return { ok: true, value: prior.result as TValue, durable: true };
		}
		const value = request.apply();
		session.commandResults.set(request.commandId, { requestDigest: request.requestDigest, result: value });
		return { ok: true, value, durable: true };
	}

	public publish(sessionId: SessionId, payload: Record<string, unknown>, eventId?: EventId): HostEvent {
		const session = this.sessions.get(sessionId);
		if (!session) throw new Error("session_not_found");
		const sequence = (session.history.at(-1)?.sequence ?? 0) + 1;
		const event: HostEvent = {
			eventId: eventId ?? (`event_host_${sessionId}_${sequence}`.replace(/[^A-Za-z0-9._~-]/g, "_") as EventId),
			sessionId,
			sequence,
			payloadDigest: runtimeDigest(payload),
			payload,
		};
		session.history.push(event);
		while (session.history.length > this.maxHistory) session.history.shift();
		for (const subscription of this.subscriptions.values()) {
			if (subscription.sessionId !== sessionId) continue;
			if (!subscription.active) {
				if (subscription.pending.length >= this.maxOutbox) {
					subscription.pending = [];
					subscription.queue = [{ type: "resync_required", safeCursor: sequence }];
				} else {
					subscription.pending.push(event);
				}
				continue;
			}
			this.enqueue(subscription, event, sequence);
		}
		return event;
	}

	public subscribe(request: SubscribeRequest): SubscribeResult {
		const session = this.sessions.get(request.sessionId);
		if (!session) return { ok: false, code: "session_not_found" };
		const earliest = session.history[0]?.sequence ?? 1;
		if (request.cursor < earliest - 1) return { ok: false, code: "resync_required", safeCursor: earliest - 1 };
		const subscription: SubscriptionState = {
			subscriptionId: `subscription-${++this.nextSubscription}`,
			connectionId: request.connectionId,
			principalId: request.principalId,
			sessionId: request.sessionId,
			active: false,
			queue: [],
			pending: [],
		};
		this.subscriptions.set(subscription.subscriptionId, subscription);
		request.hooks?.afterRegister?.();
		const head = session.history.at(-1)?.sequence ?? request.cursor;
		const replay = session.history.filter((event) => event.sequence > request.cursor && event.sequence <= head);
		if (replay.length > this.maxOutbox) {
			this.subscriptions.delete(subscription.subscriptionId);
			return { ok: false, code: "resync_required", safeCursor: head };
		}
		request.hooks?.afterSnapshot?.();
		// 注册后、head 捕获前到达的事件已经包含在 replay 中；只有 head
		// 之后的 pending 才能在 live 激活时排出，避免重复交付。
		subscription.pending = subscription.pending.filter((event) => event.sequence > head);
		subscription.queue.push(...replay.map((event) => ({ type: "event" as const, event })));
		request.hooks?.afterCursorEmitted?.();
		subscription.active = true;
		if (subscription.pending.length > 0) {
			const pending = subscription.pending.sort((left, right) => left.sequence - right.sequence);
			for (const event of pending) this.enqueue(subscription, event, event.sequence);
			subscription.pending = [];
		}
		return { ok: true, subscriptionId: subscription.subscriptionId, cursor: head };
	}

	public drain(subscriptionId: string): readonly HostSubscriptionFrame[] {
		const subscription = this.subscriptions.get(subscriptionId);
		if (!subscription) return [];
		const frames = subscription.queue;
		subscription.queue = [];
		return frames;
	}

	public detach(subscriptionId: string): boolean {
		return this.subscriptions.delete(subscriptionId);
	}

	private enqueue(subscription: SubscriptionState, event: HostEvent, safeCursor: number): void {
		if (subscription.queue.length >= this.maxOutbox) {
			subscription.queue = [{ type: "resync_required", safeCursor }];
			subscription.active = false;
			return;
		}
		subscription.queue.push({ type: "event", event });
	}
}

export function eventPayloadDigest(payload: Record<string, unknown>): RuntimeDigest {
	return { algorithm: "sha256", digest: canonicalDigest(payload) as RuntimeDigest["digest"] };
}
