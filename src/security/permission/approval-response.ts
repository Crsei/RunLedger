/** Security-private approval reverse-response codec；不扩张 Runtime 公共事件。 */

import type { PrincipalId } from "../../runtime/contracts/public.ts";
import type { PermissionPromptResponse } from "../types.ts";

const NETWORK_PROTOCOLS = new Set(["http", "https", "socks5-tcp", "socks5-udp"]);
const SIMPLE_TOKEN = /^[A-Za-z0-9_./:@%+=,-]+$/u;

export function decodePermissionPromptResponse(
	body: Readonly<Record<string, unknown>>,
	decidedBy: PrincipalId,
): PermissionPromptResponse | undefined {
	if (body.ok !== true || typeof body.decision !== "string") return undefined;
	switch (body.decision) {
		case "allow-once":
		case "allow-session":
		case "cancel":
			return { decision: body.decision, decidedBy };
		case "deny":
			return { decision: "deny", decidedBy, ...(boundedString(body.reason, 512) ? { reason: body.reason } : {}) };
		case "allow-with-prefix-rule": {
			const prefixRule = body.prefixRule;
			if (!Array.isArray(prefixRule) || prefixRule.length === 0 || prefixRule.length > 64 ||
				!prefixRule.every((token) => typeof token === "string" && SIMPLE_TOKEN.test(token))) return undefined;
			return { decision: body.decision, prefixRule: [...prefixRule] as string[], decidedBy };
		}
		case "allow-with-network-rule": {
			if (!boundedString(body.host, 512) || body.host.includes("/") || body.host.includes("\0") || body.host.includes("://") || body.host.includes("@")) return undefined;
			if (typeof body.protocol !== "string" || !NETWORK_PROTOCOLS.has(body.protocol)) return undefined;
			if (body.port !== undefined && (!Number.isSafeInteger(body.port) || (body.port as number) < 1 || (body.port as number) > 65_535)) return undefined;
			return {
				decision: body.decision,
				host: body.host,
				protocol: body.protocol as "http" | "https" | "socks5-tcp" | "socks5-udp",
				...(body.port === undefined ? {} : { port: body.port as number }),
				decidedBy,
			};
		}
		default:
			return undefined;
	}
}

function boundedString(value: unknown, maxLength: number): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}
