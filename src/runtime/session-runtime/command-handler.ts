/** Session command facade:统一 driver fence 后经唯一表驱动路由分发。 */

import { SESSION_MUTATING_COMMAND_KINDS, type SessionCommandRequest, type SessionCommandResult } from "../session-server/runtime-server.ts";
import {
	createSessionCommandRoutes,
	isSessionCommandKind,
	type SessionCommandMeta,
	type SessionCommandPort,
	type SessionCommandRouteTable,
} from "./command-routes.ts";

const LOCAL_MUTATING_KINDS = new Set([
	"prompt",
	"steer",
	"follow_up",
	"clear_queues",
	"select_model",
	"set_thinking",
	"logout",
	"login",
	"editor_activity",
	"domain_command",
]);

export class SessionCommandHandler {
	private readonly routes: SessionCommandRouteTable;

	public constructor(port: SessionCommandPort) {
		this.routes = createSessionCommandRoutes(port);
	}

	public isMutatingKind(kind: string): boolean {
		return (SESSION_MUTATING_COMMAND_KINDS as readonly string[]).includes(kind) || LOCAL_MUTATING_KINDS.has(kind);
	}

	public async handleCommand(request: SessionCommandRequest, meta: SessionCommandMeta): Promise<SessionCommandResult> {
		if (this.isMutatingKind(request.kind) && !meta.isDriver) {
			return { ok: false, code: "observer_mutation_forbidden" };
		}
		if (!isSessionCommandKind(request.kind)) return { ok: false, code: "unknown_command" };
		return this.routes[request.kind](request, meta);
	}
}

export type { SessionCommandPort } from "./command-routes.ts";
export { objectValue, safeJson } from "./command-values.ts";
