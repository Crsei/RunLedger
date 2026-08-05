/** Binds the resident extension snapshot fence to the Host-owned Agent run. */

import type { AgentEvent } from "../runtime/types.ts";
import type { ExtensionReloadResult } from "./host-manager.ts";
import type { ExtensionSnapshot } from "./snapshot.ts";
import type { HookEventName } from "./hooks/types.ts";

export interface ExtensionHookRuntimeResult {
	readonly decision: "allow" | "deny" | "aborted";
	readonly blocked: boolean;
	readonly finalInput: unknown;
	readonly requiresRevalidation: boolean;
	readonly requiresAuthorization: boolean;
	readonly additionalContext: readonly string[];
}

export interface ExtensionHookRuntime {
	run(input: {
		readonly event: HookEventName;
		readonly sessionId: string;
		readonly snapshotId: string;
		readonly input: unknown;
		readonly matcherValue?: string;
		readonly signal?: AbortSignal;
	}): Promise<ExtensionHookRuntimeResult>;
}

export interface ExtensionTurnLifecycleManager {
	beginTurn(): ExtensionSnapshot;
	endTurn(): Promise<ExtensionReloadResult | undefined>;
	currentHooks?(): readonly import("./hooks/types.ts").HookDefinition[];
}

export interface ExtensionTurnLifecycleOptions {
	readonly manager: ExtensionTurnLifecycleManager;
	readonly onIdleReload?: (result: ExtensionReloadResult) => Promise<void> | void;
	readonly hookRuntime?: ExtensionHookRuntime;
	readonly sessionId?: string;
}

/**
 * Agent events are the only safe lifecycle seam available to a resident
 * session. Duplicate start/end notifications are ignored so a snapshot can
 * never be swapped in the middle of one Agent run.
 */
export class ExtensionTurnLifecycle {
	readonly #manager: ExtensionTurnLifecycleManager;
	readonly #onIdleReload: ExtensionTurnLifecycleOptions["onIdleReload"];
	readonly #hookRuntime: ExtensionHookRuntime | undefined;
	readonly #sessionId: string | undefined;
	#active = false;
	#snapshotId: string | undefined;

	public constructor(options: ExtensionTurnLifecycleOptions) {
		this.#manager = options.manager;
		this.#onIdleReload = options.onIdleReload;
		this.#hookRuntime = options.hookRuntime;
		this.#sessionId = options.sessionId;
	}

	public snapshotId(): string | undefined {
		return this.#snapshotId;
	}

	/**
	 * Starts a resident turn before Agent.prompt. SessionStart is an admission
	 * barrier, not an observer callback: a denied lifecycle hook must prevent the
	 * Agent from entering the model/tool loop.
	 */
	public async admitTurn(): Promise<void> {
		if (this.#active) return;
		const snapshot = this.#manager.beginTurn();
		this.#snapshotId = snapshot.snapshotId;
		this.#active = true;
		try {
			const result = await this.#runHook("SessionStart", { sessionId: this.#sessionId, snapshotId: this.#snapshotId });
			if (result?.blocked || result?.decision === "deny" || result?.decision === "aborted") {
				await this.cancelTurn();
				throw new Error("SessionStart hook denied turn admission");
			}
		} catch (error) {
			if (this.#active) await this.cancelTurn();
			throw error;
		}
	}

	/** Releases a pre-admitted turn when prompt validation or Agent startup fails. */
	public async cancelTurn(): Promise<void> {
		if (!this.#active) return;
		this.#active = false;
		this.#snapshotId = undefined;
		const result = await this.#manager.endTurn();
		if (result !== undefined) await this.#onIdleReload?.(result);
	}

	public async handle(event: AgentEvent): Promise<void> {
		if (event.type === "agent_start") {
			await this.admitTurn();
			return;
		}
		if (event.type !== "agent_end" || !this.#active) return;
		const snapshotId = this.#snapshotId;
		try {
			await this.#runHook("SessionEnd", { sessionId: this.#sessionId, snapshotId });
		} finally {
			this.#active = false;
			this.#snapshotId = undefined;
			const result = await this.#manager.endTurn();
			if (result !== undefined) await this.#onIdleReload?.(result);
		}
	}

	async #runHook(event: HookEventName, input: unknown): Promise<ExtensionHookRuntimeResult | undefined> {
		if (this.#hookRuntime === undefined || this.#sessionId === undefined || this.#snapshotId === undefined) return undefined;
		return this.#hookRuntime.run({ event, sessionId: this.#sessionId, snapshotId: this.#snapshotId, input });
	}
}
