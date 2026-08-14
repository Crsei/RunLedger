import type { CanonicalSimpleCommand } from "./types.ts";

const REINTERPRETING_BUILTINS = new Set([
	".",
	"eval",
	"exec",
	"source",
	"trap",
]);
const SHELL_KEYWORDS = new Set([
	"case",
	"do",
	"done",
	"elif",
	"else",
	"esac",
	"fi",
	"for",
	"function",
	"if",
	"in",
	"select",
	"then",
	"time",
	"until",
	"while",
]);

export type BashSemanticResult =
	| { ok: true; command: CanonicalSimpleCommand }
	| { ok: false; reasonCode: string };

function optionValue(
	args: readonly string[],
	index: number,
): { next: number } | undefined {
	return args[index + 1] === undefined ? undefined : { next: index + 2 };
}

function unwrapEnv(args: readonly string[]): number | undefined {
	let index = 0;
	while (index < args.length) {
		const value = args[index]!;
		if (value === "--") return index + 1;
		if (/^[A-Za-z_][A-Za-z0-9_]*=/u.test(value)) {
			index += 1;
			continue;
		}
		if (value === "-i" || value === "--ignore-environment") {
			index += 1;
			continue;
		}
		if (value === "-u" || value === "--unset") {
			const next = optionValue(args, index);
			if (!next) return undefined;
			index = next.next;
			continue;
		}
		if (value.startsWith("--unset=")) {
			index += 1;
			continue;
		}
		if (value.startsWith("-")) return undefined;
		break;
	}
	return index;
}

function unwrapTimeout(args: readonly string[]): number | undefined {
	let index = 0;
	while (index < args.length) {
		const value = args[index]!;
		if (value === "--") {
			index += 1;
			break;
		}
		if (["--foreground", "--preserve-status", "--verbose"].includes(value)) {
			index += 1;
			continue;
		}
		if (value === "-k" || value === "--kill-after" || value === "-s" || value === "--signal") {
			const next = optionValue(args, index);
			if (!next) return undefined;
			index = next.next;
			continue;
		}
		if (value.startsWith("--kill-after=") || value.startsWith("--signal=")) {
			index += 1;
			continue;
		}
		if (value.startsWith("-")) return undefined;
		break;
	}
	if (!args[index] || !/^(?:[0-9]+(?:\.[0-9]+)?|[0-9]*\.[0-9]+)[smhd]?$/u.test(args[index]!)) {
		return undefined;
	}
	return index + 1;
}

function unwrapNice(args: readonly string[]): number | undefined {
	let index = 0;
	while (index < args.length) {
		const value = args[index]!;
		if (value === "--") return index + 1;
		if (value === "-n" || value === "--adjustment") {
			const next = optionValue(args, index);
			if (!next) return undefined;
			index = next.next;
			continue;
		}
		if (value.startsWith("--adjustment=") || /^-[0-9]+$/u.test(value)) {
			index += 1;
			continue;
		}
		if (value.startsWith("-")) return undefined;
		break;
	}
	return index;
}

function unwrapStdbuf(args: readonly string[]): number | undefined {
	let index = 0;
	while (index < args.length) {
		const value = args[index]!;
		if (value === "--") return index + 1;
		if (/^-[ioe].+$/u.test(value) || /^--(?:input|output|error)=.+$/u.test(value)) {
			index += 1;
			continue;
		}
		if (value.startsWith("-")) return undefined;
		break;
	}
	return index;
}

function unwrapSimple(args: readonly string[], allowed: readonly string[]): number | undefined {
	let index = 0;
	while (index < args.length) {
		const value = args[index]!;
		if (value === "--") return index + 1;
		if (allowed.includes(value)) {
			index += 1;
			continue;
		}
		if (value.startsWith("-")) return undefined;
		break;
	}
	return index;
}

function unwrap(command: CanonicalSimpleCommand): BashSemanticResult {
	let executable = command.executable;
	let args = [...command.arguments];
	for (let depth = 0; depth < 8; depth += 1) {
		let offset: number | undefined;
		if (executable === "env") offset = unwrapEnv(args);
		else if (executable === "timeout") offset = unwrapTimeout(args);
		else if (executable === "nice") offset = unwrapNice(args);
		else if (executable === "stdbuf") offset = unwrapStdbuf(args);
		else if (executable === "nohup") offset = unwrapSimple(args, []);
		else if (executable === "time") offset = unwrapSimple(args, ["-p"]);
		else return { ok: true, command: { ...command, executable, arguments: args } };
		if (offset === undefined || !args[offset]) {
			return { ok: false, reasonCode: "bash_wrapper_invalid" };
		}
		executable = args[offset]!;
		args = args.slice(offset + 1);
	}
	return { ok: false, reasonCode: "bash_wrapper_depth" };
}

export function applyBashSemantics(
	command: CanonicalSimpleCommand,
): BashSemanticResult {
	const unwrapped = unwrap(command);
	if (!unwrapped.ok) return unwrapped;
	const current = unwrapped.command;
	const executable = current.executable;
	if (REINTERPRETING_BUILTINS.has(executable)) {
		return { ok: false, reasonCode: "bash_reinterpreting_builtin" };
	}
	if (SHELL_KEYWORDS.has(executable)) {
		return { ok: false, reasonCode: "bash_keyword_executable" };
	}
	if (
		(executable === "test" || executable === "[") &&
		current.arguments.includes("-v")
	) {
		return { ok: false, reasonCode: "bash_indirect_variable_test" };
	}
	if (executable === "printf" && current.arguments.includes("-v")) {
		return { ok: false, reasonCode: "bash_indirect_variable_printf" };
	}
	if (
		executable === "read" &&
		current.arguments.some((argument) => argument === "-a" || argument === "-A")
	) {
		return { ok: false, reasonCode: "bash_indirect_variable_read" };
	}
	if (
		current.arguments.some((argument) =>
			/^\/proc\/(?:self|[0-9]+)\/environ$/u.test(argument) ||
			/^\/proc\/(?:self|[0-9]+)\/cmdline$/u.test(argument)
		)
	) {
		return { ok: false, reasonCode: "bash_process_environment_read" };
	}
	if (executable === "jq") {
		if (
			current.arguments.some((argument) =>
				argument === "--run-tests" ||
				argument === "-L" ||
				argument.startsWith("--library-path=") ||
				/\bsystem\s*\(/u.test(argument)
			)
		) {
			return { ok: false, reasonCode: "bash_jq_dynamic_execution" };
		}
	}
	return { ok: true, command: current };
}
