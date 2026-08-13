/**
 * Typed CLI/TUI control-plane vocabulary.
 *
 * This module is deliberately pure: it only maps bounded user input to a
 * Host operation.  Authentication, driver fencing, durable command intent
 * and domain revision checks remain owned by the resident Host.
 */

import { runtimeDigest } from "../runtime/protocol/foundation.ts";
import { isRuntimeEventRangeRef } from "../runtime/protocol/schemas.ts";

export type ControlGroup =
	| "security"
	| "worktree"
	| "plugin"
	| "skill"
	| "hook"
	| "mcp"
	| "plan"
	| "compact"
	| "context"
	| "memory"
	| "remember";

export interface ControlCommand {
	readonly group: ControlGroup;
	readonly action: string;
	readonly args: readonly string[];
	readonly mutation: boolean;
}

export interface ControlCommandParseFailure {
	readonly ok: false;
	readonly error: string;
}

export interface ControlCommandParseSuccess {
	readonly ok: true;
	readonly command: ControlCommand;
}

export type ControlCommandParseResult = ControlCommandParseSuccess | ControlCommandParseFailure;

export interface HostControlRequest {
	readonly operation: string;
	readonly body: Record<string, unknown>;
	readonly mutation: boolean;
}

const GROUPS: ReadonlySet<string> = new Set<ControlGroup>([
	"security",
	"worktree",
	"plugin",
	"skill",
	"hook",
	"mcp",
	"plan",
	"compact",
	"context",
	"memory",
	"remember",
]);

const DEFAULT_ACTIONS: Readonly<Record<ControlGroup, string>> = {
	security: "inspect",
	worktree: "list",
	plugin: "list",
	skill: "list",
	hook: "list",
	mcp: "list",
	plan: "inspect",
	compact: "run",
	context: "inspect",
	memory: "search",
	remember: "propose",
};

const ACTIONS: Readonly<Record<ControlGroup, ReadonlySet<string>>> = {
	security: new Set(["inspect"]),
	worktree: new Set(["list", "inspect", "create", "resume", "release"]),
	plugin: new Set(["list", "inspect", "reload", "enable", "disable", "trust", "untrust"]),
	skill: new Set(["list", "provider", "trust", "untrust"]),
	hook: new Set(["list"]),
	mcp: new Set(["list", "inspect", "doctor", "restart"]),
	plan: new Set(["inspect", "enter", "activate", "write", "approve", "cancel"]),
	compact: new Set(["run", "list"]),
	context: new Set(["inspect", "assemble"]),
	memory: new Set(["search", "get", "projection", "approve", "reject", "revoke"]),
	remember: new Set(["propose"]),
};

const MUTATIONS = new Set([
	"worktree.create", "worktree.resume", "worktree.release",
	"plugin.reload", "plugin.enable", "plugin.disable", "plugin.trust", "plugin.untrust",
	"skill.trust", "skill.untrust",
	"plan.enter", "plan.activate", "plan.write", "plan.approve", "plan.cancel",
	"compact.run", "context.assemble",
	"memory.propose", "memory.approve", "memory.reject", "memory.revoke",
]);

/** Returns undefined when argv is an ordinary prompt/forward-compatible positional. */
export function parseControlCommand(positional: readonly string[]): ControlCommandParseResult | undefined {
	const rawGroup = positional[0];
	if (rawGroup === undefined || !GROUPS.has(rawGroup)) return undefined;
	const group = rawGroup as ControlGroup;
	const rawAction = positional[1] ?? DEFAULT_ACTIONS[group];
	if (!ACTIONS[group].has(rawAction)) return { ok: false, error: `unsupported ${group} action: ${rawAction}` };
	const args = positional.slice(2);
	const key = `${group}.${rawAction}`;
	if ((group === "plugin" && ["enable", "disable", "trust", "untrust"].includes(rawAction)) && args.length < 1) {
		return { ok: false, error: `${rawAction} requires a plugin id` };
	}
	if (group === "skill" && (rawAction === "trust" || rawAction === "untrust") && args.length < 1) {
		return { ok: false, error: `${rawAction} requires a skill id` };
	}
	if (group === "skill" && rawAction === "provider") {
		const sub = args[0];
		if (sub === undefined || !["list", "enable", "disable"].includes(sub)) return { ok: false, error: "provider requires list|enable|disable" };
		if ((sub === "enable" || sub === "disable") && args.length < 2) return { ok: false, error: `${sub} requires a provider id` };
		const scope = args.find((arg) => arg.startsWith("--scope="));
		if (scope !== undefined && scope !== "--scope=user" && scope !== "--scope=workspace") return { ok: false, error: "scope must be user or workspace" };
	}
	if (group === "worktree" && rawAction === "create" && args.length < 2) return { ok: false, error: "create requires a source cwd and label" };
	if (group === "memory" && rawAction === "get" && args.length < 1) return { ok: false, error: "get requires a memory id" };
	if (group === "memory" && rawAction === "search" && args.length < 1) return { ok: false, error: "search requires a query" };
	if (group === "remember" && args.length < 1) return { ok: false, error: "remember requires a proposal text" };
	if (group === "plan" && rawAction === "write" && args.length < 1) return { ok: false, error: "write requires plan text" };
	if (group === "plan" && rawAction === "approve" && args.length < 1) return { ok: false, error: "approve requires an approval id" };
	if (group === "memory" && rawAction === "approve" && args.length < 2) return { ok: false, error: "approve requires a proposal id and approval reference JSON" };
	if (group === "memory" && (rawAction === "reject" || rawAction === "revoke") && args.length < 1) return { ok: false, error: `${rawAction} requires an id` };
	if (group === "worktree" && rawAction === "release" && args[0] !== "confirm") return { ok: false, error: "release requires the explicit confirm token" };
	if (group === "compact" && rawAction === "run") {
		if (args.length < 2) return { ok: false, error: "compact run requires a JSON source range and transcript" };
		let sourceRange: unknown;
		try { sourceRange = JSON.parse(args[0]!) as unknown; } catch { return { ok: false, error: "compact run source range must be valid JSON" }; }
		if (!isRuntimeEventRangeRef(sourceRange)) return { ok: false, error: "compact run source range is invalid" };
	}
	if (group === "context" && rawAction === "assemble") {
		if (args.length < 2) return { ok: false, error: "context assemble requires request JSON and sources JSON" };
		try {
			const sources = JSON.parse(args[1]!) as unknown;
			JSON.parse(args[0]!);
			if (!Array.isArray(sources)) return { ok: false, error: "context assemble sources must be a JSON array" };
		} catch { return { ok: false, error: "context assemble arguments must be valid JSON" }; }
	}
	const skillProviderAction = group === "skill" && rawAction === "provider" ? args[0] : undefined;
	const mutation = skillProviderAction === "enable" || skillProviderAction === "disable" ? true : MUTATIONS.has(key);
	return { ok: true, command: { group, action: rawAction, args, mutation } };
}

export function controlCommandRequest(command: ControlCommand): HostControlRequest {
	const key = `${command.group}.${command.action}`;
	const body: Record<string, unknown> = {};
	switch (key) {
		case "plugin.enable":
		case "plugin.disable":
		case "plugin.trust":
		case "plugin.untrust":
			body.pluginId = command.args[0];
			break;
		case "skill.trust":
		case "skill.untrust":
			body.skillId = command.args[0];
			break;
		case "skill.provider": {
			const sub = command.args[0];
			if (sub === "enable" || sub === "disable") {
				body.providerId = command.args[1];
				const scope = command.args.find((arg) => arg.startsWith("--scope="));
				if (scope === "--scope=workspace") body.scope = "workspace";
			}
			break;
		}
		case "worktree.create":
			body.sourceCwd = command.args[0];
			body.label = command.args[1];
			break;
		case "worktree.release":
			body.confirm = command.args[0] === "confirm";
			if (command.args.length > 1) body.reason = command.args.slice(1).join(" ");
			break;
		case "memory.search":
			body.query = command.args.join(" ");
			break;
		case "memory.projection":
			break;
		case "memory.get":
			body.memoryId = command.args[0];
			break;
		case "remember.propose": {
			const text = command.args.join(" ");
			const digest = runtimeDigest(text);
			body.scope = "workspace";
			body.title = text.slice(0, 256);
			body.content = text;
			body.sourceKind = "user";
			body.sourceRef = { subjectKind: "content", digest, mediaType: "text/plain", size: Buffer.byteLength(text, "utf8") };
			body.sourceDigest = digest;
			break;
		}
		case "plan.write":
			body.content = command.args.join(" ");
			break;
		case "plan.activate":
			body.content = command.args.join(" ");
			break;
		case "plan.approve":
			body.approvalId = command.args[0];
			body.decision = "approved";
			break;
		case "compact.run":
			body.reason = "manual";
			body.sourceRange = JSON.parse(command.args[0]!) as unknown;
			body.transcript = command.args.slice(1).join(" ");
			break;
		case "context.assemble":
			body.request = JSON.parse(command.args[0]!) as unknown;
			body.sources = JSON.parse(command.args[1]!) as unknown;
			break;
		case "memory.approve":
			body.proposalId = command.args[0];
			body.approvalRef = JSON.parse(command.args[1]!) as unknown;
			break;
		case "memory.reject":
			body.proposalId = command.args[0];
			break;
		case "memory.revoke":
			body.memoryId = command.args[0];
			break;
		case "mcp.restart":
			if (command.args[0] !== undefined) body.serverId = command.args[0];
			break;
	}
	return {
		operation: key === "remember.propose" ? "memory.propose" : key === "plan.approve" ? "plan.resolve_approval" : key === "skill.provider" ? `skill.provider.${command.args[0] ?? "list"}` : key,
		body,
		mutation: command.mutation,
	};
}

/** Query used to obtain the current Host-owned domain revision before a mutation. */
export function controlCommandQueryOperation(command: ControlCommand): string | undefined {
	if (!command.mutation) return undefined;
	if (command.group === "worktree") return "worktree.inspect";
	if (command.group === "plugin") return "plugin.list";
	if (command.group === "skill") return "skill.list";
	if (command.group === "mcp") return "mcp.list";
	if (command.group === "plan") return "plan.inspect";
	if (command.group === "compact") return "compaction.list";
	if (command.group === "context") return "context.inspect";
	if (command.group === "memory" || command.group === "remember") return "memory.inspect";
	return undefined;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function integerValue(value: unknown): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
}

/** Adds only the expected revisions owned by the Host/domain contract. */
export function controlCommandBody(command: ControlCommand, domainRevision: number, inspectedBody: Record<string, unknown> = {}): Record<string, unknown> {
	const request = controlCommandRequest(command);
	const body: Record<string, unknown> = { ...request.body };
	if (command.mutation) body.expectedDomainRevision = domainRevision;
	if (command.group === "plan") {
		const state = objectValue(inspectedBody.state);
		const revision = integerValue(state?.revision);
		if (revision !== undefined && ["enter", "activate", "write", "approve", "cancel"].includes(command.action)) body.expectedRevision = revision;
		const plan = objectValue(state?.plan);
		const planRevision = integerValue(plan?.revision);
		if (command.action === "write" && planRevision !== undefined) body.expectedPlanRevision = planRevision;
		if (command.action === "approve" && planRevision !== undefined && objectValue(plan)?.digest !== undefined) {
			body.expectedPlanRevision = planRevision;
			body.expectedPlanDigest = objectValue(plan)?.digest;
		}
	}
	return body;
}

export function controlCommandHelp(): string {
	return [
		"Control commands are executed by the authenticated resident Host:",
		"  runledger security inspect",
		"  runledger worktree list|inspect|create|resume|release confirm",
		"  runledger plugin list|inspect|reload|enable|disable|trust|untrust [plugin-id]",
		"  runledger skill list|provider list|provider enable|disable <provider-id> [--scope user|workspace]|trust|untrust <skill-id>",
		"  runledger hook list   runledger mcp list|inspect|doctor|restart [server-id]",
		"  runledger plan inspect|enter|activate|write|approve <approval-id>|cancel",
		"  runledger compact list|run '<source-range-json>' <transcript>",
		"  runledger memory search|get|approve|reject|revoke   runledger remember <text>",
	].join("\n");
}
