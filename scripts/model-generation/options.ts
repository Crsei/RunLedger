/**
 * S9 拆分:generator CLI 参数解析。
 */

import { resolve } from "path";

export interface GeneratorOptions {
	strict: boolean;
	jsonOnly: boolean;
	jsonOutputDir: string | undefined;
	pretty: boolean;
	source: "remote" | "frozen";
	frozenInput: string | undefined;
}

export function readGeneratorOptions(args: string[]): GeneratorOptions {
	let strict = false;
	let jsonOnly = false;
	let jsonOutputDir: string | undefined;
	let pretty = false;
	let source: "remote" | "frozen" = "remote";
	let frozenInput: string | undefined;

	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (arg === "--strict") {
			strict = true;
			continue;
		}
		if (arg === "--json-only") {
			jsonOnly = true;
			continue;
		}
		if (arg === "--pretty") {
			pretty = true;
			continue;
		}
		if (arg === "--json-output") {
			const value = args[++index];
			if (!value) throw new Error("--json-output requires a directory");
			jsonOutputDir = resolve(value);
			continue;
		}
		if (arg === "--source") {
			const value = args[++index];
			if (value !== "remote" && value !== "frozen") throw new Error("--source requires remote or frozen");
			source = value;
			continue;
		}
		if (arg === "--frozen-input") {
			const value = args[++index];
			if (!value) throw new Error("--frozen-input requires a file");
			frozenInput = resolve(value);
			continue;
		}
		throw new Error(`Unknown argument: ${arg}`);
	}

	if (jsonOnly && !jsonOutputDir) throw new Error("--json-only requires --json-output");
	if (source === "frozen" && !frozenInput) throw new Error("--source frozen requires --frozen-input");
	if (source === "remote" && frozenInput) throw new Error("--frozen-input requires --source frozen");
	return { strict, jsonOnly, jsonOutputDir, pretty, source, frozenInput };
}
