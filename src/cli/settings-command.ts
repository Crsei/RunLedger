/** `runledger settings` 的薄 CLI adapter；authority 仍由 SettingsService 持有。 */

import type { RunledgerLayout } from "../runtime/contracts/storage-layout.ts";
import {
	SettingsCommandError,
	SettingsService,
	parseSettingCliValue,
} from "../storage/settings-service.ts";
import { getSettingsPath, SettingsStorageError } from "../storage/settings-manager.ts";

export function settingsCommandHelp(): string {
	return "Usage: runledger settings list|get|set|reset [--json] [--workspace-key <key>] [path] [value]";
}

function writeJson(value: unknown): void {
	process.stdout.write(`${JSON.stringify(value)}\n`);
}

export async function runSettingsCommand(
	argv: readonly string[],
	options: { readonly layout: RunledgerLayout },
): Promise<void> {
	const parsed = parseSettingsCommandArgs(argv);
	const workspaceKey = parsed.workspaceKey;
	if (workspaceKey !== undefined) {
		try {
			getSettingsPath({ layout: options.layout, workspaceKey });
		} catch (error) {
			if (error instanceof SettingsStorageError && error.code === "invalid_workspace_key") {
				throw new SettingsCommandError("invalid_workspace_key", workspaceKey, error.message);
			}
			throw error;
		}
	}
	const positional = parsed.positional;
	const action = positional[0];
	const service = new SettingsService({
		layout: options.layout,
		...(workspaceKey === undefined ? {} : { workspaceKey }),
	});
	if (action === "list") {
		const items = await service.list();
		if (parsed.json) {
			writeJson(items);
			return;
		}
		for (const item of items) process.stdout.write(`${item.path}\tdefault=${String(item.defaultValue)}\tapply=${item.apply}\n`);
		return;
	}
	if (action === "get" || action === "set" || action === "reset") {
		const path = positional[1];
		if (path === undefined) throw new SettingsCommandError("invalid_value", "", `${settingsCommandHelp()}: path is required`);
		const result = action === "get"
			? await service.get(path)
			: action === "reset"
				? await service.reset(path)
				: positional[2] === undefined
					? (() => { throw new SettingsCommandError("invalid_value", path, "set requires a value"); })()
					: await service.set(path, parseSettingCliValue(positional[2]));
		if (parsed.json) {
			writeJson(result);
			return;
		}
		process.stdout.write(`${result.path}=${String(result.value)} (${result.source})\n`);
		return;
	}
	throw new SettingsCommandError("invalid_value", "", settingsCommandHelp());
}

interface ParsedSettingsCommandArgs {
	readonly json: boolean;
	readonly workspaceKey?: string;
	readonly positional: readonly string[];
}

function parseSettingsCommandArgs(argv: readonly string[]): ParsedSettingsCommandArgs {
	const positional: string[] = [];
	let json = false;
	let workspaceKey: string | undefined;
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		if (argument === "--json") {
			json = true;
			continue;
		}
		if (argument === "--workspace-key") {
			const value = argv[index + 1];
			if (value === undefined || value.startsWith("--")) {
				throw new SettingsCommandError("invalid_value", "workspaceKey", `${settingsCommandHelp()}: workspace key is required`);
			}
			workspaceKey = value;
			index += 1;
			continue;
		}
		if (argument.startsWith("--workspace-key=")) {
			const value = argument.slice("--workspace-key=".length);
			if (value.length === 0) {
				throw new SettingsCommandError("invalid_value", "workspaceKey", `${settingsCommandHelp()}: workspace key is required`);
			}
			workspaceKey = value;
			continue;
		}
		if (argument.startsWith("--")) {
			throw new SettingsCommandError("invalid_value", argument, settingsCommandHelp());
		}
		positional.push(argument);
	}
	return { json, ...(workspaceKey === undefined ? {} : { workspaceKey }), positional };
}
