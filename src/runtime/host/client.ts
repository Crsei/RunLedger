/** R2 typed in-memory remote facade; production transport is intentionally not wired yet. */

import type { EventId, SessionId } from "../protocol/ids.ts";
import type {
	HostClientConnection,
	HostEvent,
	HostSubscriptionFrame,
	InMemoryHostRouter,
	SubscribeResult,
} from "./router.ts";

interface ClientSubscriptionState {
	readonly seenEventIds: Set<EventId>;
	cursor: number;
}

export class InMemoryHostClient<T extends object = Record<string, unknown>> {
	private readonly subscriptions = new Map<string, ClientSubscriptionState>();
	private readonly router: InMemoryHostRouter<T>;
	private readonly connection: HostClientConnection;

	public constructor(router: InMemoryHostRouter<T>, connection: HostClientConnection) {
		this.router = router;
		this.connection = connection;
	}

	public subscribe(sessionId: SessionId, cursor: number): SubscribeResult {
		const result = this.router.subscribe({ ...this.connection, sessionId, cursor });
		if (result.ok) {
			this.subscriptions.set(result.subscriptionId, { seenEventIds: new Set(), cursor });
		}
		return result;
	}

	public consume(subscriptionId: string, frames: readonly HostSubscriptionFrame[]): readonly HostEvent[] {
		const state = this.subscriptions.get(subscriptionId);
		if (!state) return [];
		const events: HostEvent[] = [];
		for (const frame of frames) {
			if (frame.type === "resync_required") {
				state.cursor = frame.safeCursor;
				continue;
			}
			if (state.seenEventIds.has(frame.event.eventId)) continue;
			if (frame.event.sequence > state.cursor + 1) continue;
			state.seenEventIds.add(frame.event.eventId);
			state.cursor = Math.max(state.cursor, frame.event.sequence);
			events.push(frame.event);
		}
		return events;
	}

	public drain(subscriptionId: string): readonly HostEvent[] {
		return this.consume(subscriptionId, this.router.drain(subscriptionId));
	}

	public cursor(subscriptionId: string): number | undefined {
		return this.subscriptions.get(subscriptionId)?.cursor;
	}

	public detach(subscriptionId: string): boolean {
		this.subscriptions.delete(subscriptionId);
		return this.router.detach(subscriptionId);
	}
}
