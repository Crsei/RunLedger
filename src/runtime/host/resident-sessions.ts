/** Host-owned resident session routing cache; durable truth remains outside this map. */

import type { SessionId } from "../protocol/ids.ts";

export interface ResidentSessionEntry<T> {
	readonly sessionId: SessionId;
	readonly generation: number;
	readonly owner: T;
	activeWork: boolean;
}

export class ResidentSessionRegistry<T> {
	private readonly entries = new Map<SessionId, ResidentSessionEntry<T>>();

	public ensure(sessionId: SessionId, factory: () => T): ResidentSessionEntry<T> {
		const existing = this.entries.get(sessionId);
		if (existing) return existing;
		const created: ResidentSessionEntry<T> = {
			sessionId,
			generation: 1,
			owner: factory(),
			activeWork: false,
		};
		this.entries.set(sessionId, created);
		return created;
	}

	public get(sessionId: SessionId): ResidentSessionEntry<T> | undefined {
		return this.entries.get(sessionId);
	}

	public markActiveWork(sessionId: SessionId, activeWork: boolean): boolean {
		const entry = this.entries.get(sessionId);
		if (!entry) return false;
		entry.activeWork = activeWork;
		return true;
	}

	public canUnload(sessionId: SessionId): boolean {
		return this.entries.get(sessionId)?.activeWork === false;
	}

	public removeIfIdle(sessionId: SessionId): boolean {
		const entry = this.entries.get(sessionId);
		if (!entry || entry.activeWork) return false;
		return this.entries.delete(sessionId);
	}

	public size(): number {
		return this.entries.size;
	}
}
