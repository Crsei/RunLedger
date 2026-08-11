import { isDangerousExecCommand } from "../security/permission/exec-prefix-rule.ts";
import { normalizeNetworkApprovalKey } from "../security/network/network-approval.ts";
import type { AccessRequest } from "../security/types.ts";

export interface ApprovalReverseRequestView {
	readonly toolName: string;
	readonly summary: string;
	readonly cwd?: string;
	readonly expiresAt?: string;
	readonly requests?: readonly AccessRequest[];
}

export type ApprovalDecision =
	| { readonly decision: "allow-once" | "allow-session" | "deny" | "cancel" }
	| { readonly decision: "allow-with-prefix-rule"; readonly prefixRule: readonly string[] }
	| { readonly decision: "allow-with-network-rule"; readonly host: string; readonly protocol: "http" | "https" | "socks5-tcp" | "socks5-udp"; readonly port?: number };

export interface ApprovalChoice {
	readonly id: string;
	readonly decision: ApprovalDecision;
	readonly label: string;
	readonly description: string;
}

export function parseApprovalReverseRequest(body: Record<string, unknown>): ApprovalReverseRequestView | undefined {
	if (body.requestType !== "permission") return undefined;
	if (!isBoundedString(body.toolName, 128) || !isBoundedString(body.summary, 512)) return undefined;
	if (body.cwd !== undefined && !isBoundedString(body.cwd, 1_024)) return undefined;
	if (body.expiresAt !== undefined && !isBoundedString(body.expiresAt, 64)) return undefined;
	const requests = body.requests === undefined ? undefined : parseAccessRequests(body.requests);
	if (body.requests !== undefined && requests === undefined) return undefined;
	return {
		toolName: body.toolName,
		summary: body.summary,
		...(body.cwd === undefined ? {} : { cwd: body.cwd }),
		...(body.expiresAt === undefined ? {} : { expiresAt: body.expiresAt }),
		...(requests === undefined ? {} : { requests }),
	};
}

export function approvalDecisionBody(decision: ApprovalDecision | "allow-once" | "deny" | "cancel"): Record<string, unknown> {
	return typeof decision === "string" ? { ok: true, decision } : { ok: true, ...decision };
}

export function approvalChoices(view: ApprovalReverseRequestView | undefined): readonly ApprovalChoice[] {
	if (view === undefined) return [];
	const choices: ApprovalChoice[] = [
		{ id: "allow-once", decision: { decision: "allow-once" }, label: "Allow once", description: view.cwd === undefined ? "Permit this request once" : `Permit once in ${view.cwd}` },
		{ id: "deny", decision: { decision: "deny" }, label: "Deny", description: "Reject without executing" },
		{ id: "allow-session", decision: { decision: "allow-session" }, label: "Allow for session", description: "Permit this exact request for this session" },
	];
	const shell = view.requests?.length === 1 && view.requests[0]?.kind === "shell" ? view.requests[0] : undefined;
	const prefixRule = shell === undefined ? undefined : exactExecPrefix(shell.command);
	if (prefixRule !== undefined) choices.push({
		id: "allow-prefix",
		decision: { decision: "allow-with-prefix-rule", prefixRule },
		label: "Allow command rule",
		description: `Permit commands beginning with: ${prefixRule.join(" ")}`,
	});
	const network = view.requests?.length === 1 && view.requests[0]?.kind === "network" ? view.requests[0] : undefined;
	if (network?.protocol !== undefined) {
		const key = normalizeNetworkApprovalKey({ host: network.host, protocol: network.protocol, ...(network.port === undefined ? {} : { port: network.port }) });
		if (key !== undefined) choices.push({
			id: "allow-network",
			decision: { decision: "allow-with-network-rule", ...key },
			label: "Allow network endpoint",
			description: `Permit ${key.protocol}://${key.host}:${key.port} for this session`,
		});
	}
	choices.push({ id: "cancel", decision: { decision: "cancel" }, label: "Cancel", description: "Cancel this approval request" });
	return choices;
}

function isBoundedString(value: unknown, maxLength: number): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}

function exactExecPrefix(command: string): readonly string[] | undefined {
	if (isDangerousExecCommand(command) || command.includes("\0") || /(?:<<|>>|[<>;|&`\n]|\$\()/u.test(command)) return undefined;
	const tokens = command.trim().split(/\s+/u);
	return tokens.length > 0 && tokens.every((token) => /^[A-Za-z0-9_./:@%+=,-]+$/u.test(token)) ? tokens : undefined;
}

function parseAccessRequests(value: unknown): readonly AccessRequest[] | undefined {
	if (!Array.isArray(value) || value.length === 0 || value.length > 128) return undefined;
	const requests: AccessRequest[] = [];
	for (const item of value) {
		if (!isRecord(item) || typeof item.kind !== "string") return undefined;
		if (item.kind === "shell" && isBoundedString(item.command, 8_192) && isBoundedString(item.cwd, 1_024) && (item.analysis === "known" || item.analysis === "unknown")) {
			requests.push({ kind: "shell", command: item.command, cwd: item.cwd, analysis: item.analysis });
			continue;
		}
		if (item.kind === "network" && (item.operation === "connect" || item.operation === "fetch") && isBoundedString(item.host, 512) &&
			(item.protocol === undefined || item.protocol === "http" || item.protocol === "https" || item.protocol === "socks5-tcp" || item.protocol === "socks5-udp") &&
			(item.port === undefined || Number.isSafeInteger(item.port))) {
			requests.push({ kind: "network", operation: item.operation, host: item.host, ...(item.protocol === undefined ? {} : { protocol: item.protocol }), ...(item.port === undefined ? {} : { port: item.port as number }) });
			continue;
		}
		if (item.kind === "filesystem" && (item.operation === "read" || item.operation === "write" || item.operation === "delete") && isBoundedString(item.path, 4_096)) {
			requests.push({ kind: "filesystem", operation: item.operation, path: item.path });
			continue;
		}
		if (item.kind === "worktree" && (item.operation === "create" || item.operation === "remove" || item.operation === "apply" || item.operation === "gc") && isBoundedString(item.target, 4_096)) {
			requests.push({ kind: "worktree", operation: item.operation, target: item.target });
			continue;
		}
		if (item.kind === "tool" && isBoundedString(item.toolName, 128) && (item.provider === undefined || isBoundedString(item.provider, 128))) {
			requests.push({ kind: "tool", toolName: item.toolName, ...(item.provider === undefined ? {} : { provider: item.provider }) });
			continue;
		}
		return undefined;
	}
	return requests;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
