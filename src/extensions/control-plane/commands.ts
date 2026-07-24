/** 与现有 flags 并存的 Extension subcommand 判别式 parser。 */

export interface ExtensionCommandFlags {
	json: boolean;
	yes?: boolean;
	digest?: string;
}

export type ExtensionCommand =
	| ({ kind: "inspect" } & ExtensionCommandFlags)
	| ({ kind: "trust-list" } & ExtensionCommandFlags)
	| ({ kind: "trust-grant" | "trust-revoke"; resourceId: string } & ExtensionCommandFlags)
	| ({ kind: "plugin-list" | "skill-list" | "hook-list" | "mcp-list" } & ExtensionCommandFlags)
	| ({ kind: "plugin-show" | "plugin-validate" | "plugin-enable" | "plugin-disable" | "plugin-trust" | "plugin-untrust" | "skill-show" | "skill-validate" | "hook-validate" | "hook-enable" | "hook-disable" | "mcp-doctor" | "mcp-enable" | "mcp-disable" | "mcp-login" | "mcp-logout"; resourceId?: string } & ExtensionCommandFlags)
	| ({ kind: "plugin-install" | "plugin-update"; locatorPath: string } & ExtensionCommandFlags)
	| ({ kind: "plugin-uninstall"; packageName: string; version: string } & ExtensionCommandFlags)
	| ({ kind: "plugin-rollback"; packageName: string; fromVersion: string } & ExtensionCommandFlags);

export type ExtensionCommandParseResult =
	| { ok: true; command: ExtensionCommand }
	| { ok: false; message: string }
	| { ok: false; passthrough: true };

const subcommands = new Set(["inspect", "trust", "plugin", "skill", "hook", "mcp"]);

interface ParsedTokens {
	positionals: string[];
	json: boolean;
	yes: boolean;
	digest?: string;
	locator?: string;
	version?: string;
	from?: string;
	error?: string;
}

function tokens(argv: readonly string[]): ParsedTokens {
	const parsed: ParsedTokens = { positionals: [], json: false, yes: false };
	for (let index = 0; index < argv.length; index += 1) {
		const value = argv[index];
		if (!value) continue;
		if (value === "--json") {
			parsed.json = true;
			continue;
		}
		if (value === "--yes") {
			parsed.yes = true;
			continue;
		}
		if (value === "--digest" || value === "--locator" || value === "--version" || value === "--from") {
			const next = argv[index + 1];
			if (!next || next.startsWith("--")) {
				parsed.error = `${value} requires a value`;
				return parsed;
			}
			index += 1;
			if (value === "--digest") parsed.digest = next;
			if (value === "--locator") parsed.locator = next;
			if (value === "--version") parsed.version = next;
			if (value === "--from") parsed.from = next;
			continue;
		}
		if (value.startsWith("--")) {
			parsed.error = `unknown Extension option: ${value}`;
			return parsed;
		}
		parsed.positionals.push(value);
	}
	return parsed;
}

function flags(parsed: ParsedTokens): ExtensionCommandFlags {
	return {
		json: parsed.json,
		yes: parsed.yes,
		...(parsed.digest ? { digest: parsed.digest } : {}),
	};
}

export function parseExtensionCommand(argv: readonly string[]): ExtensionCommandParseResult {
	const domain = argv[0];
	if (!domain || !subcommands.has(domain)) return { ok: false, passthrough: true };
	const parsed = tokens(argv.slice(1));
	if (parsed.error) return { ok: false, message: parsed.error };
	const [action, value, ...extra] = parsed.positionals;
	const common = flags(parsed);
	if (domain === "inspect") {
		return parsed.positionals.length === 0
			? { ok: true, command: { kind: "inspect", ...common } }
			: { ok: false, message: "inspect accepts only --json" };
	}
	if (domain === "trust") {
		if (action === "list" && !value && extra.length === 0) return { ok: true, command: { kind: "trust-list", ...common } };
		if ((action === "grant" || action === "revoke") && value && extra.length === 0) {
			return { ok: true, command: { kind: action === "grant" ? "trust-grant" : "trust-revoke", resourceId: value, ...common } };
		}
		return { ok: false, message: "usage: trust list|grant|revoke <qualified-resource-id> [--json] [--yes --digest <sha256>]" };
	}
	if (domain === "plugin" && (action === "install" || action === "update")) {
		if (!parsed.locator || value || extra.length > 0) return { ok: false, message: `usage: plugin ${action} --locator <file> [--yes --digest <sha256>] [--json]` };
		return { ok: true, command: { kind: action === "install" ? "plugin-install" : "plugin-update", locatorPath: parsed.locator, ...common } };
	}
	if (domain === "plugin" && action === "uninstall") {
		if (!value || !parsed.version || extra.length > 0) return { ok: false, message: "usage: plugin uninstall <package> --version <exact> [--yes --digest <sha256>] [--json]" };
		return { ok: true, command: { kind: "plugin-uninstall", packageName: value, version: parsed.version, ...common } };
	}
	if (domain === "plugin" && action === "rollback") {
		if (!value || !parsed.from || extra.length > 0) return { ok: false, message: "usage: plugin rollback <package> --from <exact> [--yes --digest <sha256>] [--json]" };
		return { ok: true, command: { kind: "plugin-rollback", packageName: value, fromVersion: parsed.from, ...common } };
	}
	const allowed: Readonly<Record<string, readonly string[]>> = {
		plugin: ["list", "show", "validate", "enable", "disable", "trust", "untrust"],
		skill: ["list", "show", "validate"],
		hook: ["list", "validate", "enable", "disable"],
		mcp: ["list", "doctor", "enable", "disable", "login", "logout"],
	};
	if (!action || !allowed[domain]?.includes(action)) return { ok: false, message: `unknown ${domain} subcommand` };
	if (action === "list") {
		return !value && extra.length === 0
			? { ok: true, command: { kind: `${domain}-list` as "plugin-list" | "skill-list" | "hook-list" | "mcp-list", ...common } }
			: { ok: false, message: `${domain} list accepts no resource identity` };
	}
	if (extra.length > 0) return { ok: false, message: `${domain} ${action} accepts at most one qualified resource identity` };
	return {
		ok: true,
		command: {
			kind: `${domain}-${action}` as Extract<ExtensionCommand, { resourceId?: string }>["kind"],
			...(value ? { resourceId: value } : {}),
			...common,
		} as ExtensionCommand,
	};
}
