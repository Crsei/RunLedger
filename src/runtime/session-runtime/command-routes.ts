import type { SessionStore } from "../../storage/session-store/session-store.ts";
import type { ConnectionId, SessionId } from "../protocol/ids.ts";
import type { OwnerFence } from "../session-owner/types.ts";
import type { SessionCommandRequest, SessionCommandResult, SessionControllerEvent, SessionRuntimeServer } from "../session-server/runtime-server.ts";
import type { RecoveryBarrier, RecoveryDecision } from "./recovery-barrier.ts";
import type { SessionDomainRouter } from "./domain-router.ts";
import type { HumanWaitReason } from "./run-timing.ts";
import type { SessionDomainPort, SessionRuntimeState } from "./session-runtime.ts";
import { createConversationCommandRoutes } from "./command-routes/conversation.ts";
import { createModelCommandRoutes } from "./command-routes/model.ts";
import { createAccountCommandRoutes } from "./command-routes/account.ts";
import { createDomainCommandRoutes } from "./command-routes/domain.ts";
import { createRecoveryCommandRoutes } from "./command-routes/recovery.ts";

export const SESSION_COMMAND_ROUTE_GROUPS = {
	conversation: ["prompt", "steer", "follow_up", "clear_queues", "interrupt"],
	model: ["provider_status", "models", "select_model", "set_thinking", "editor_activity"],
	account: ["logout", "login"],
	domain: ["domain_query", "domain_command"],
	recovery: ["recovery_explain", "recovery_assess", "recovery_verify", "recovery_abort", "recovery_resume"],
} as const;

export const SESSION_COMMAND_KINDS = [
	...SESSION_COMMAND_ROUTE_GROUPS.conversation,
	...SESSION_COMMAND_ROUTE_GROUPS.model,
	...SESSION_COMMAND_ROUTE_GROUPS.account,
	...SESSION_COMMAND_ROUTE_GROUPS.domain,
	...SESSION_COMMAND_ROUTE_GROUPS.recovery,
] as const;

export type SessionCommandKind = (typeof SESSION_COMMAND_KINDS)[number];
export type SessionCommandMeta = { readonly connectionId: ConnectionId; readonly clientId: string; readonly isDriver: boolean };
export type SessionCommandRoute = (request: SessionCommandRequest, meta: SessionCommandMeta) => Promise<SessionCommandResult>;
export type SessionCommandRouteTable = Readonly<Record<SessionCommandKind, SessionCommandRoute>>;

export interface SessionCommandPort {
	readonly store: SessionStore;
	readonly domain: SessionDomainPort | undefined;
	readonly domainRouter: SessionDomainRouter;
	readonly fence: OwnerFence;
	readonly sessionId: SessionId;
	readonly server: SessionRuntimeServer;
	readonly barrier: RecoveryBarrier;
	readonly state: () => SessionRuntimeState;
	readonly emit: (event: SessionControllerEvent) => void;
	readonly withHumanInputWait: <T>(waitId: string, reason: HumanWaitReason, operation: () => Promise<T>) => Promise<T>;
	readonly invalidateIdleRecap: () => void;
	readonly handleEditorActivity: (empty: boolean) => void;
	readonly recoveryAssess: () => { readonly ok: true; readonly barrierState: "closed" | "open"; readonly unresolvedRemaining: number };
	readonly recoveryDecide: (decision: RecoveryDecision) => { readonly ok: boolean; readonly code?: string; readonly state: SessionRuntimeState };
	readonly unresolvedAttemptsCount: () => number;
}

export function isSessionCommandKind(kind: string): kind is SessionCommandKind {
	return (SESSION_COMMAND_KINDS as readonly string[]).includes(kind);
}

export function createSessionCommandRoutes(port: SessionCommandPort): SessionCommandRouteTable {
	return {
		...createConversationCommandRoutes(port),
		...createModelCommandRoutes(port),
		...createAccountCommandRoutes(port),
		...createDomainCommandRoutes(port),
		...createRecoveryCommandRoutes(port),
	};
}
