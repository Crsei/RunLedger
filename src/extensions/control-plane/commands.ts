/** 与现有 flags 并存的 extension subcommand 判别式 parser。 */

export type ExtensionCommand =
	| { kind: "inspect"; json: boolean }
	| { kind: "trust-list"; json: boolean }
	| { kind: "trust-grant" | "trust-revoke"; resourceId: string; json: boolean }
	| { kind: "plugin-list" | "skill-list" | "hook-list" | "mcp-list"; json: boolean }
	| { kind: "plugin-show" | "plugin-validate" | "plugin-enable" | "plugin-disable" | "plugin-trust" | "plugin-untrust" | "skill-show" | "skill-validate" | "hook-validate" | "hook-enable" | "hook-disable" | "mcp-doctor" | "mcp-enable" | "mcp-disable"; resourceId?: string; json: boolean };

export type ExtensionCommandParseResult = { ok: true; command: ExtensionCommand } | { ok: false; message: string } | { ok: false; passthrough: true };

const subcommands = new Set(["inspect", "trust", "plugin", "skill", "hook", "mcp"]);

export function parseExtensionCommand(argv: readonly string[]): ExtensionCommandParseResult {
	const [domain, action, value, ...rest] = argv;
	if (!domain || !subcommands.has(domain)) return { ok: false, passthrough: true };
	const json = argv.includes("--json");
	const positional = [action, value, ...rest].filter((item): item is string => Boolean(item && item !== "--json"));
	if (domain === "inspect") return positional.length === 0 ? { ok: true, command: { kind: "inspect", json } } : { ok: false, message: "inspect accepts only --json" };
	if (domain === "trust") {
		if (positional[0] === "list" && positional.length === 1) return { ok: true, command: { kind: "trust-list", json } };
		if ((positional[0] === "grant" || positional[0] === "revoke") && positional.length === 2 && positional[1]) return { ok: true, command: { kind: positional[0] === "grant" ? "trust-grant" : "trust-revoke", resourceId: positional[1], json } };
		return { ok: false, message: "usage: trust list|grant|revoke <qualified-resource-id> [--json]" };
	}
	const allowed: Readonly<Record<string, readonly string[]>> = { plugin: ["list", "show", "validate", "enable", "disable", "trust", "untrust"], skill: ["list", "show", "validate"], hook: ["list", "validate", "enable", "disable"], mcp: ["list", "doctor", "enable", "disable"] };
	if (!action || !allowed[domain]?.includes(action)) return { ok: false, message: `unknown ${domain} subcommand` };
	if (action === "list") return positional.length === 1 ? { ok: true, command: { kind: `${domain}-list` as ExtensionCommand["kind"], json } as ExtensionCommand } : { ok: false, message: `${domain} list accepts only --json` };
	if (positional.length > 2) return { ok: false, message: `${domain} ${action} accepts at most one qualified resource identity` };
	return { ok: true, command: { kind: `${domain}-${action}` as ExtensionCommand["kind"], ...(positional[1] ? { resourceId: positional[1] } : {}), json } as ExtensionCommand };
}
