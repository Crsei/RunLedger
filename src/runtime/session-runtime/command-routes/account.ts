import type { AuthType } from "../../../auth/types.ts";
import { createReverseRequestAuthInteraction } from "../credential-reverse-request.ts";
import type { SessionCommandPort, SessionCommandRouteTable } from "../command-routes.ts";

export function createAccountCommandRoutes(port: SessionCommandPort): Pick<SessionCommandRouteTable, "logout" | "login"> {
	return {
		logout: async (request) => {
			if (port.domain === undefined) return { ok: false, code: "domain_unavailable" };
			const providerId = String(request.body.providerId ?? "");
			if (providerId.length === 0) return { ok: false, code: "invalid_input" };
			await port.domain.controller.logout(providerId);
			return { ok: true, kind: "logout", result: {} };
		},
		login: async (request, meta) => {
			if (port.domain === undefined) return { ok: false, code: "domain_unavailable" };
			const providerId = String(request.body.providerId ?? "");
			if (providerId.length === 0 || (request.body.authType !== "api_key" && request.body.authType !== "oauth")) {
				return { ok: false, code: "invalid_input" };
			}
			const interaction = createReverseRequestAuthInteraction({ sender: port.server, connectionId: meta.connectionId });
			try {
				await port.withHumanInputWait(`credential-${request.commandId}`, "credential", () => port.domain!.controller.login(providerId, request.body.authType as AuthType, interaction));
			} catch (error) {
				return { ok: false, code: "login_failed", detail: error instanceof Error ? error.message.slice(0, 200) : undefined };
			}
			return { ok: true, kind: "login", result: { providers: await port.domain.controller.getProviderStatuses() } };
		},
	};
}
