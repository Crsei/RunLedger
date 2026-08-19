/** 保守 shell 分类器；无法可靠拆链时返回 unknown。 */

import { posix } from "node:path";

export interface ShellSegment {
	readonly raw: string;
	readonly executable: string;
	readonly arguments: readonly string[];
}

export interface ShellAnalysis {
	readonly analysis: "known" | "unknown";
	readonly segments: readonly ShellSegment[];
	readonly reasonCodes: readonly string[];
}

const WRAPPERS = new Set(["env", "timeout", "nice", "ionice", "stdbuf"]);
const UNSAFE_WRAPPERS = new Set(["sudo", "xargs", "nohup", "tee", "bash", "dash", "ksh", "sh", "zsh"]);
const SHELLS = new Set(["bash", "dash", "ksh", "sh", "zsh"]);
const PRIVILEGE_WRAPPERS = new Set(["sudo", "doas"]);
const KNOWN_EXECUTABLES = new Set([
	"astro-ls", "awk", "basename", "bash-language-server", "biome", "cat", "cd", "clangd", "cmp", "command", "cut", "deno", "diff", "dirname", "echo", "env", "false", "fd", "find",
	"git", "gopls", "grep", "head", "ls", "marksman", "nice", "node", "perl", "printf", "pylsp", "pyright-langserver", "pwd", "rg", "rm", "ruff", "rust-analyzer", "sed", "sort", "stdbuf", "svelte-language-server", "svelteserver", "swiftlint", "tail",
	"tailwindcss-language-server", "timeout", "tr", "true", "typescript-language-server", "uniq", "uname", "vscode-css-language-server", "vscode-eslint-language-server", "vscode-html-language-server", "vscode-json-language-server", "vue-language-server", "wc", "which", "xargs", "yaml-language-server", "yes",
]);

function executableName(value: string): string {
	const normalized = value.replaceAll("\\", "/");
	return normalized.slice(normalized.lastIndexOf("/") + 1);
}

function splitWords(segment: string): string[] | undefined {
	const words: string[] = [];
	let current = "";
	let quote: "single" | "double" | undefined;
	let escaped = false;
	for (const character of segment) {
		if (escaped) {
			current += character;
			escaped = false;
			continue;
		}
		if (character === "\\" && quote !== "single") {
			escaped = true;
			continue;
		}
		if (character === "'" && quote !== "double") {
			quote = quote === "single" ? undefined : "single";
			continue;
		}
		if (character === '"' && quote !== "single") {
			quote = quote === "double" ? undefined : "double";
			continue;
		}
		if (/\s/u.test(character) && quote === undefined) {
			if (current) words.push(current);
			current = "";
			continue;
		}
		current += character;
	}
	if (escaped || quote !== undefined) return undefined;
	if (current) words.push(current);
	return words;
}

function splitSegments(command: string): { readonly segments: readonly string[]; readonly unknown: boolean } {
	const segments: string[] = [];
	let current = "";
	let quote: "single" | "double" | undefined;
	let escaped = false;
	let unknown = false;
	for (let index = 0; index < command.length; index += 1) {
		const character = command[index]!;
		const next = command[index + 1];
		if (escaped) {
			current += character;
			escaped = false;
			continue;
		}
		if (character === "\\" && quote !== "single") {
			current += character;
			escaped = true;
			continue;
		}
		if (character === "'" && quote !== "double") {
			quote = quote === "single" ? undefined : "single";
			current += character;
			continue;
		}
		if (character === '"' && quote !== "single") {
			quote = quote === "double" ? undefined : "double";
			current += character;
			continue;
		}
		if (quote === undefined && character === "&" && next !== "&") unknown = true;
		if (quote === undefined && (character === "<" || character === ">" || character === "`")) unknown = true;
		if (quote === undefined && character === "$" && next === "(") unknown = true;
		const doubleSeparator = quote === undefined && ((character === "&" && next === "&") || (character === "|" && next === "|"));
		const singleSeparator = quote === undefined && (character === ";" || character === "|" || character === "\n");
		if (doubleSeparator || singleSeparator) {
			if (current.trim()) segments.push(current.trim());
			current = "";
			if (doubleSeparator) index += 1;
			continue;
		}
		current += character;
	}
	if (quote !== undefined || escaped) unknown = true;
	if (current.trim()) segments.push(current.trim());
	return { segments, unknown };
}

function normalizeSegment(raw: string): ShellSegment | undefined {
	const words = splitWords(raw);
	if (!words || words.length === 0) return undefined;
	let index = 0;
	while (index < words.length && /^[A-Za-z_][A-Za-z0-9_]*=.*/u.test(words[index]!)) index += 1;
	while (index < words.length && WRAPPERS.has(words[index]!)) {
		const wrapper = words[index]!;
		index += 1;
		if (wrapper === "env") {
			while (index < words.length && (words[index]!.startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=.*/u.test(words[index]!))) index += 1;
			continue;
		}
		while (index < words.length && words[index]!.startsWith("-")) {
			const option = words[index]!;
			index += 1;
			if (["-k", "--kill-after", "-s", "--signal", "-n", "--adjustment", "-c", "--class", "-p", "--pid"].includes(option)) index += 1;
		}
		if (wrapper === "timeout") index += 1;
	}
	const executable = words[index];
	if (!executable) return undefined;
	return { raw, executable: executableName(executable), arguments: words.slice(index + 1) };
}

/** LSP transport 将 stderr 与 stdout 汇入同一受治理输出流，只允许丢弃 stderr。 */
function stripSafeStderrRedirect(command: string): string {
	const match = /(?:^|\s)2\s*>\s*\/dev\/null\s*$/u.exec(command);
	return match === null ? command : command.slice(0, match.index).trimEnd();
}

export function analyzeShellCommand(command: string): ShellAnalysis {
	const reasons: string[] = [];
	if (!command.trim() || command.length > 65_536 || command.includes("\0")) return { analysis: "unknown", segments: [], reasonCodes: ["invalid_command"] };
	const split = splitSegments(stripSafeStderrRedirect(command));
	if (split.unknown) reasons.push("unsupported_shell_syntax");
	if (/<<-?\s*[A-Za-z_][A-Za-z0-9_]*/u.test(command)) reasons.push("heredoc");
	const segments: ShellSegment[] = [];
	for (const raw of split.segments) {
		const normalized = normalizeSegment(raw);
		if (!normalized) {
			reasons.push("unparseable_segment");
			continue;
		}
		segments.push(normalized);
		if (UNSAFE_WRAPPERS.has(normalized.executable)) reasons.push(`unsafe_wrapper:${normalized.executable}`);
		if (!KNOWN_EXECUTABLES.has(normalized.executable)) reasons.push(`unknown_executable:${normalized.executable}`);
		if (normalized.executable === "rg" && normalized.arguments.some((argument) => argument === "--pre" || argument.startsWith("--pre="))) reasons.push("rg_preprocessor");
	}
	if (segments.length === 0) reasons.push("empty_segments");
	return { analysis: reasons.length === 0 ? "known" : "unknown", segments, reasonCodes: [...new Set(reasons)].sort() };
}

function unwrapPrivilege(tokens: readonly string[]): readonly string[] {
	if (!PRIVILEGE_WRAPPERS.has(executableName(tokens[0] ?? ""))) return tokens;
	let index = 1;
	while (index < tokens.length) {
		if (tokens[index] === "--") return tokens.slice(index + 1);
		if (!tokens[index]!.startsWith("-")) return tokens.slice(index);
		index += 1;
	}
	return [];
}

function shellArgument(tokens: readonly string[]): string | undefined {
	for (let index = 1; index + 1 < tokens.length; index += 1) {
		if (tokens[index] === "-c" || tokens[index] === "--command") return tokens[index + 1];
		if (tokens[index]!.startsWith("-c") && tokens[index]!.length > 2) return tokens[index]!.slice(2);
	}
	return undefined;
}

function recursiveRootDelete(argumentsValue: readonly string[]): boolean {
	const recursive = argumentsValue.some((argument) => argument === "--recursive" || /^-[^-]*r/u.test(argument));
	if (!recursive) return false;
	return argumentsValue.filter((argument) => !argument.startsWith("-")).some((target) => posix.resolve(target) === "/" || target === "/*" || target === "/**");
}

function commandHardline(tokensValue: readonly string[], depth: number): string | undefined {
	if (depth > 4 || tokensValue.length === 0) return undefined;
	const tokens = unwrapPrivilege(tokensValue);
	if (tokens.length === 0) return undefined;
	const executable = executableName(tokens[0]!);
	const args = tokens.slice(1);
	if (SHELLS.has(executable)) {
		const nested = shellArgument(tokens);
		if (nested) return hardlineShellDenialReason(nested, depth + 1);
	}
	if (executable === "rm" && recursiveRootDelete(args)) return "system_root_delete";
	if (/^(?:mkfs(?:\..+)?|mke2fs)$/u.test(executable) || executable === "wipefs" && args.includes("-a")) return "filesystem_format";
	if (executable === "kill" && args.includes("-1")) return "kill_all";
	if (executable === "killall5" || executable === "pkill" && args.some((argument) => argument === "-1" || argument === ".*")) return "kill_all";
	if (["halt", "poweroff", "reboot", "shutdown"].includes(executable)) return "system_shutdown";
	if (executable === "find") {
		const execIndex = args.findIndex((argument) => argument === "-exec" || argument === "-execdir");
		if (execIndex >= 0) {
			const end = args.findIndex((argument, index) => index > execIndex && (argument === ";" || argument === "+"));
			const nested = args.slice(execIndex + 1, end < 0 ? undefined : end);
			return commandHardline(nested, depth + 1);
		}
	}
	return undefined;
}

export function hardlineShellDenialReason(command: string, depth = 0): string | undefined {
	if (depth > 4 || !command.trim() || command.includes("\0")) return undefined;
	const compact = command.replaceAll(/\s+/gu, "");
	if (compact.includes(":(){:|:&};:")) return "fork_bomb";
	const analysis = analyzeShellCommand(command);
	for (const segment of analysis.segments) {
		const reason = commandHardline([segment.executable, ...segment.arguments], depth);
		if (reason) return reason;
	}
	return undefined;
}
