/** Binds the resident extension snapshot fence to the Host-owned Agent run. */

import type { AgentEvent } from "../runtime/types.ts";
import type { ExtensionReloadResult } from "./host-manager.ts";
import type { ExtensionSnapshot } from "./snapshot.ts";

export interface ExtensionTurnLifecycleManager {
	beginTurn(): ExtensionSnapshot;
	endTurn(): Promise<ExtensionReloadResult | undefined>;
}

export interface ExtensionTurnLifecycleOptions {
	readonly manager: ExtensionTurnLifecycleManager;
	readonly onIdleReload?: (result: ExtensionReloadResult) => Promise<void> | void;
}

/**
 * Agent events are the only safe lifecycle seam available to a resident
 * session. Duplicate start/end notifications are ignored so a snapshot can
 * never be swapped in the middle of one Agent run.
 */
export class ExtensionTurnLifecycle {
	readonly #manager: ExtensionTurnLifecycleManager;
	readonly #onIdleReload: ExtensionTurnLifecycleOptions["onIdleReload"];
	#active = false;

	public constructor(options: ExtensionTurnLifecycleOptions) {
		this.#manager = options.manager;
		this.#onIdleReload = options.onIdleReload;
	}

	public async handle(event: AgentEvent): Promise<void> {
		if (event.type === "agent_start") {
			if (!this.#active) {
				this.#manager.beginTurn();
				this.#active = true;
			}
			return;
		}
		if (event.type !== "agent_end" || !this.#active) return;
		this.#active = false;
		const result = await this.#manager.endTurn();
		if (result !== undefined) await this.#onIdleReload?.(result);
	}
}
