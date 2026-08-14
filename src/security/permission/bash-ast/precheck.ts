import {
	BASH_AST_COMMAND_MAX_CHARS,
	type BashAstClassification,
} from "./types.ts";

const NON_ASCII_WHITESPACE = /[\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]/u;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;
const BACKSLASH_WHITESPACE = /\\[ \t\r\n\v\f]/u;
const ZSH_AMBIGUITY = /(?:^|[\s;|&()])(?:~\[|=[A-Za-z_])/u;

export function precheckBashCommand(
	command: string,
	parserDigest: string,
): BashAstClassification | undefined {
	if (command.length === 0) {
		return { kind: "too-complex", reasonCode: "bash_empty_command", parserDigest };
	}
	if (command.length > BASH_AST_COMMAND_MAX_CHARS) {
		return { kind: "too-complex", reasonCode: "bash_command_oversize", parserDigest };
	}
	if (CONTROL.test(command)) {
		return { kind: "too-complex", reasonCode: "bash_control_character", parserDigest };
	}
	if (NON_ASCII_WHITESPACE.test(command)) {
		return { kind: "too-complex", reasonCode: "bash_unicode_whitespace", parserDigest };
	}
	if (BACKSLASH_WHITESPACE.test(command)) {
		return { kind: "too-complex", reasonCode: "bash_escape_whitespace_ambiguity", parserDigest };
	}
	if (ZSH_AMBIGUITY.test(command)) {
		return { kind: "too-complex", reasonCode: "bash_cross_shell_ambiguity", parserDigest };
	}
	return undefined;
}
