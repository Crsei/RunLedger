/**
 * Typed CLI/TUI control-plane vocabulary.
 *
 * This module is deliberately pure: it only maps bounded user input to a
 * Host operation.  Authentication, driver fencing, durable command intent
 * and domain revision checks remain owned by the resident Host.
 */

import { runtimeDigest } from "../runtime/protocol/foundation.ts";
import { parseFeatureSelection } from "../extensions/plugins/features.ts";

export type ControlGroup =
	| "security"
	| "worktree"
	| "plugin"
	| "marketplace"
	| "skill"
	| "hook"
	| "mcp"
	| "plan"
	| "compact"
	| "context"
	| "dump"
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
	"marketplace",
	"skill",
	"hook",
	"mcp",
	"plan",
	"compact",
	"context",
	"dump",
	"memory",
	"remember",
]);

const DEFAULT_ACTIONS: Readonly<Record<ControlGroup, string>> = {
	security: "inspect",
	worktree: "list",
	plugin: "list",
	marketplace: "discover",
	skill: "list",
	hook: "list",
	mcp: "list",
	plan: "inspect",
	compact: "run",
	context: "inspect",
	dump: "inspect",
	memory: "search",
	remember: "propose",
};

const ACTIONS: Readonly<Record<ControlGroup, ReadonlySet<string>>> = {
	security: new Set(["inspect"]),
	worktree: new Set(["list", "inspect", "create", "resume", "release"]),
	plugin: new Set(["list", "inspect", "reload", "enable", "disable", "trust", "untrust", "distribution", "doctor", "install", "uninstall", "link", "upgrade", "config", "features"]),
	marketplace: new Set(["discover", "add", "remove", "update", "upgrade", "autoUpdate"]),
	skill: new Set(["list", "provider", "trust", "untrust"]),
	hook: new Set(["list"]),
	mcp: new Set(["list", "inspect", "doctor", "restart"]),
	plan: new Set(["inspect", "list", "enter", "reenter", "exit", "activate", "write", "request_approval", "approve", "reject", "changes_requested", "cancel", "settle_exit", "export", "handoff"]),
	compact: new Set(["run", "list"]),
	context: new Set(["inspect", "assemble"]),
	dump: new Set(["inspect", "request", "system", "assembled", "base"]),
	memory: new Set(["search", "get", "projection", "approve", "reject", "revoke"]),
	remember: new Set(["propose"]),
};

const MUTATIONS = new Set([
	"worktree.create", "worktree.resume", "worktree.release",
	"plugin.reload", "plugin.enable", "plugin.disable", "plugin.trust", "plugin.untrust",
	// P6 分发动词：安装/卸载/链接/升级只落盘与记账,不授予启用或信任(D7)。
	"plugin.install", "plugin.uninstall", "plugin.link", "plugin.upgrade",
	"marketplace.add", "marketplace.remove", "marketplace.update", "marketplace.upgrade",
	"skill.trust", "skill.untrust",
	"mcp.restart",
	"plan.enter", "plan.reenter", "plan.exit", "plan.activate", "plan.write", "plan.approve", "plan.reject", "plan.changes_requested", "plan.request_approval", "plan.cancel", "plan.settle_exit", "plan.export", "plan.handoff",
	"compact.run", "context.assemble",
	"remember.propose", "memory.approve", "memory.reject", "memory.revoke",
]);

/** Returns undefined when argv is an ordinary prompt/forward-compatible positional. */
export function parseControlCommand(positional: readonly string[]): ControlCommandParseResult | undefined {
	const rawGroup = positional[0];
	if (rawGroup === undefined || !GROUPS.has(rawGroup)) return undefined;
	const group = rawGroup as ControlGroup;
	const rawAction = group === "remember" ? "propose" : positional[1] ?? DEFAULT_ACTIONS[group];
	if (!ACTIONS[group].has(rawAction)) return { ok: false, error: `unsupported ${group} action: ${rawAction}` };
	const args = positional.slice(group === "remember" && positional[1] !== "propose" ? 1 : 2);
	const key = `${group}.${rawAction}`;
	if (group === "dump" && args.length > 0) return { ok: false, error: "Usage: runledger dump [request|system|assembled|base]" };
	if ((group === "plugin" && ["enable", "disable", "trust", "untrust", "uninstall"].includes(rawAction)) && args.length < 1) {
		return { ok: false, error: `${rawAction} requires a plugin id` };
	}
	if (group === "plugin" && (rawAction === "install" || rawAction === "upgrade") && args.length < 1) {
		return { ok: false, error: `${rawAction} requires an install spec (name, name@marketplace, name[features])` };
	}
	if (group === "plugin" && rawAction === "link" && args.length < 2) {
		return { ok: false, error: "link requires a plugin id and a local path" };
	}
	if (group === "plugin" && rawAction === "config") {
		const sub = args[0];
		if (sub !== undefined && sub !== "read" && sub !== "set") return { ok: false, error: "config requires read|set" };
		if (sub === "set" && args.length < 4) return { ok: false, error: "config set requires a plugin id, a setting name and a value" };
	}
	if (group === "plugin" && rawAction === "features") {
		const sub = args[0];
		if (sub !== undefined && sub !== "read" && sub !== "set") return { ok: false, error: "features requires read|set" };
		if (sub === "set") {
			if (args.length < 3) return { ok: false, error: "features set requires a plugin id and a selection (* | none | a,b)" };
			const parsed = parseFeatureSelection(args[2] ?? "");
			if (!parsed.ok) return { ok: false, error: parsed.message };
		}
	}
	if (group === "marketplace") {
		if (rawAction === "autoUpdate" && args[0] !== undefined && args[0] !== "off" && args[0] !== "notify" && args[0] !== "auto") {
			return { ok: false, error: "autoUpdate requires off, notify or auto" };
		}
		if (rawAction === "add" && args.length < 3) return { ok: false, error: "marketplace add requires a name, source type and source uri" };
		if ((rawAction === "remove" || rawAction === "update" || rawAction === "upgrade") && args.length < 1) {
			return { ok: false, error: `marketplace ${rawAction} requires a marketplace name` };
		}
	}
	if (["plugin.install", "plugin.upgrade", "plugin.uninstall", "plugin.link", "marketplace.add"].includes(`${group}.${rawAction}`)) {
		const scope = args.find((arg) => arg.startsWith("--scope="));
		if (scope !== undefined && scope !== "--scope=user" && scope !== "--scope=workspace") {
			return { ok: false, error: "scope must be user or workspace" };
		}
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
	if (group === "plan" && ["approve", "reject", "changes_requested"].includes(rawAction) && args.length < 1) return { ok: false, error: `${rawAction} requires an approval id` };
	if (group === "memory" && rawAction === "approve" && args.length < 2) return { ok: false, error: "approve requires a proposal id and approval reference JSON" };
	if (group === "memory" && (rawAction === "reject" || rawAction === "revoke") && args.length < 1) return { ok: false, error: `${rawAction} requires an id` };
	if (group === "worktree" && rawAction === "release" && args[0] !== "confirm") return { ok: false, error: "release requires the explicit confirm token" };
	if (group === "compact" && rawAction === "run") {
		if (args.some((arg) => arg.startsWith("--") && arg !== "--strategy=single-pass" && arg !== "--strategy=hierarchical" && arg !== "--strategy=handoff" && arg !== "--strategy=openai-responses-native")) return { ok: false, error: "compact run accepts --strategy=single-pass|hierarchical|handoff|openai-responses-native and optional focus text" };
		if (args.filter((arg) => arg.startsWith("--strategy=")).length > 1) return { ok: false, error: "compact strategy must be specified once" };
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
	// `plugin config`/`plugin features` 与 `skill provider` 都是带子动作的复合动词：
	// 读/写由子动作决定，因此不能只看动词名是否在 MUTATIONS 里。
	const pluginConfigAction = group === "plugin" && rawAction === "config" ? args[0] ?? "read" : undefined;
	const pluginFeaturesAction = group === "plugin" && rawAction === "features" ? args[0] ?? "read" : undefined;
	// `marketplace autoUpdate` 省略模式是读当前配置，给出模式才是 mutation。
	const marketplaceAutoUpdateAction = group === "marketplace" && rawAction === "autoUpdate" ? (args[0] === undefined ? "read" : "set") : undefined;
	const mutation = skillProviderAction === "enable" || skillProviderAction === "disable"
		? true
		: pluginConfigAction !== undefined
			? pluginConfigAction === "set"
			: pluginFeaturesAction !== undefined
				? pluginFeaturesAction === "set"
				: marketplaceAutoUpdateAction !== undefined
					? marketplaceAutoUpdateAction === "set"
					: MUTATIONS.has(key);
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
		case "plugin.uninstall":
			body.pluginId = command.args[0];
			break;
		case "plugin.install":
		case "plugin.upgrade":
			body.spec = command.args.filter((arg) => !arg.startsWith("--")).join(" ");
			break;
		case "plugin.link":
			body.pluginId = command.args[0];
			body.localPath = command.args[1];
			break;
		case "plugin.config": {
			// `config set <id> <key> <value>`：值以字符串传入，由声明式 schema 负责
			// 类型/范围/枚举校验（owner 侧不做第二次解释）。
			if (command.args[0] === "set") {
				body.pluginId = command.args[1];
				body.values = { [command.args[2] ?? ""]: command.args[3] };
			}
			break;
		}
		case "plugin.features": {
			// `features set <id> <selection>`：`*` = 声明默认值、`none` = 全关、
			// 其余为逗号分隔的精确集合。解析已在词表层校验过。
			if (command.args[0] === "set") {
				body.pluginId = command.args[1];
				const parsed = parseFeatureSelection(command.args[2] ?? "");
				if (parsed.ok) body.enabledFeatures = parsed.selection;
			}
			break;
		}
		case "marketplace.add":
			body.name = command.args[0];
			body.sourceType = command.args[1];
			body.sourceUri = command.args[2];
			break;
		case "marketplace.remove":
		case "marketplace.update":
			body.name = command.args[0];
			break;
		case "marketplace.upgrade":
			// `marketplace.upgrade [name]`:省略名字表示对全部已注册 marketplace 生效。
			if (command.args[0] !== undefined) body.marketplace = command.args[0];
			break;
		case "marketplace.autoUpdate":
			// `marketplace autoUpdate <off|notify|auto>`:省略模式走 discover 读当前值。
			if (command.args[0] !== undefined) body.mode = command.args[0];
			break;
		case "skill.trust":
		case "skill.untrust":
			body.skillId = command.args[0];
			break;
		case "dump.inspect":
		case "dump.request":
		case "dump.system":
		case "dump.assembled":
		case "dump.base":
			body.view = command.action === "inspect" ? "request" : command.action;
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
			if (command.args.length > 0) body.content = command.args.join(" ");
			break;
		case "plan.approve":
		case "plan.reject":
		case "plan.changes_requested":
			body.approvalId = command.args[0];
			body.decision = command.action === "reject" ? "rejected"
				: command.action === "changes_requested" ? "changes_requested" : "approved";
			if (command.args.length > 1) body.feedback = command.args.slice(1).join(" ");
			break;
		case "compact.run":
			if (command.args.some((arg) => arg.startsWith("--strategy="))) body.strategy = command.args.find((arg) => arg.startsWith("--strategy="))!.slice("--strategy=".length);
			if (command.args.some((arg) => !arg.startsWith("--strategy="))) body.focus = command.args.filter((arg) => !arg.startsWith("--strategy=")).join(" ");
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
		operation: key === "security.inspect" ? "session.security.inspect"
			: key === "plugin.distribution" ? "plugin.distribution.list"
			: key === "plugin.doctor" ? "plugin.doctor"
			: key === "plugin.config" ? (command.args[0] === "set" ? "plugin.config.write" : "plugin.config.read")
			: key === "plugin.features" ? (command.args[0] === "set" ? "plugin.features.write" : "plugin.features.read")
			: key === "marketplace.discover" ? "marketplace.discover"
			// `key` 用 CLI 词表里的 camelCase 动作名；协议侧 operation 必须是全小写。
			: key === "marketplace.autoUpdate" ? (command.args[0] === undefined ? "marketplace.discover" : "marketplace.auto_update")
			: command.group === "dump" ? "session.request.inspect"
			: key === "compact.list" ? "compaction.list"
			: key === "plugin.reload" ? "extension.reload"
			: key === "remember.propose" ? "memory.propose"
			: (key === "plan.approve" || key === "plan.reject" || key === "plan.changes_requested") ? "plan.resolve_approval"
			: key === "skill.provider" ? `skill.provider.${command.args[0] ?? "list"}` : key,
		body,
		mutation: command.mutation,
	};
}

/** Query used to obtain the current Host-owned domain revision before a mutation. */
export function controlCommandQueryOperation(command: ControlCommand): string | undefined {
	if (!command.mutation) return undefined;
	if (command.group === "worktree") return "worktree.inspect";
	// 分发 mutation 的 revision 来源是分发账本视图,而不是声明式快照。
	if (command.group === "plugin") {
		if (command.action === "list") return "plugin.list";
		// config 的写入以分发账本视图为 revision 来源，和 install/uninstall 一致。
		return "plugin.distribution.list";
	}
	if (command.group === "marketplace") return "marketplace.discover";
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
	if (command.mutation && command.group !== "plan") body.expectedDomainRevision = domainRevision;
	if (command.group === "plan") {
		const state = objectValue(inspectedBody.state);
		const revision = integerValue(state?.revision);
		if (revision !== undefined && command.mutation) body.expectedRevision = revision;
		const plan = objectValue(state?.plan);
		const planRevision = integerValue(plan?.revision);
		if (["write", "activate"].includes(command.action) && planRevision !== undefined) body.expectedPlanRevision = planRevision;
		if (["approve", "reject", "changes_requested", "request_approval"].includes(command.action) && planRevision !== undefined && objectValue(plan)?.digest !== undefined) {
			body.expectedPlanRevision = planRevision;
			body.expectedPlanDigest = objectValue(plan)?.digest;
		}
	}
	return body;
}

export function controlCommandHelp(): string {
	return [
		"Control commands use the authenticated Session Owner's negotiated capabilities.",
		"Availability depends on the current Session; unavailable operations return a nonzero exit code:",
		"  runledger security inspect",
		"  runledger worktree list|inspect|create|resume|release confirm",
		"  runledger plugin list|inspect|reload|enable|disable|trust|untrust [plugin-id]",
		"  runledger plugin distribution   plugin doctor   plugin config [read|set <plugin-id> <key> <value>]",
		"  runledger plugin features [read|set <plugin-id> <*|none|feature,...>]",
		"    feature selection only narrows the declared set; it never enables or trusts a plugin.",
		"  runledger plugin install <spec>|upgrade <spec>|uninstall <plugin-id>|link <plugin-id> <path> [--scope user|workspace]",
		"    install/upgrade only write to the package store; enable and trust stay separate decisions.",
		"  runledger marketplace discover|add <name> <github|git|url|local> <uri>|remove <name>|update <name>|upgrade [name]",
		"  runledger marketplace autoUpdate [off|notify|auto]   (user settings; auto only refreshes catalogs)",
		"  runledger skill list|provider list|provider enable|disable <provider-id> [--scope user|workspace]|trust|untrust <skill-id>",
		"    Standard Sessions currently support user-scoped provider policy; workspace scope is unavailable.",
		"  runledger hook list   runledger mcp list|inspect|doctor|restart [server-id]",
		"    plugin inspect / mcp inspect are unavailable in standard Sessions; use plugin list / mcp list|doctor.",
		"  runledger plan inspect|list|enter|reenter|exit|activate [body]|write <body>|request_approval|approve|reject|changes_requested <approval-id> [feedback]|cancel|settle_exit|export|handoff",
		"  runledger compact list|run [--strategy=single-pass|hierarchical|handoff|openai-responses-native] [focus]",
		"  runledger dump [request|system|assembled|base]   (raw content to stdout; metadata to stderr)",
		"  runledger memory search|get|approve|reject|revoke   runledger remember <text>",
		"    worktree, context and memory/remember mutations are unavailable in standard Sessions.",
	].join("\n");
}
