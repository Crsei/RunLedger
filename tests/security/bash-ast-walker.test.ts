import { describe, expect, it } from "vitest";
import {
	classifySerializedBashAst,
	precheckBashCommand,
	type SerializedBashAstNode,
} from "../../src/security/permission/bash-ast/index.ts";

const PARSER_DIGEST = "a".repeat(64);

function node(
	type: string,
	text: string,
	children: readonly SerializedBashAstNode[] = [],
	field?: string,
): SerializedBashAstNode {
	return {
		type,
		startIndex: 0,
		endIndex: text.length,
		text,
		children,
		...(field ? { field } : {}),
	};
}

describe("Bash AST allowlist walker", () => {
	it("resolves a static assignment without leaking branch-local scope", () => {
		const root = node("program", "", [
			node("variable_assignment", "CMD=git", [
				node("variable_name", "CMD", [], "name"),
				node("word", "git", [], "value"),
			]),
			node("command", "$CMD status", [
				node("command_name", "$CMD", [
					node("simple_expansion", "$CMD", [
						node("variable_name", "CMD"),
					]),
				]),
				node("word", "status"),
			]),
		]);
		expect(classifySerializedBashAst(root, "", PARSER_DIGEST)).toMatchObject({
			kind: "simple",
			commands: [{ executable: "git", arguments: ["status"] }],
		});
	});

	it("rejects unknown nodes and sensitive assignment names", () => {
		expect(classifySerializedBashAst(
			node("program", "", [node("function_definition", "f() { :; }")]),
			"",
			PARSER_DIGEST,
		)).toMatchObject({
			kind: "too-complex",
			reasonCode: "bash_unknown_node",
			nodeType: "function_definition",
		});
		expect(classifySerializedBashAst(
			node("program", "", [
				node("variable_assignment", "PS4=secret", [
					node("variable_name", "PS4", [], "name"),
					node("word", "secret", [], "value"),
				]),
			]),
			"",
			PARSER_DIGEST,
		)).toMatchObject({
			kind: "too-complex",
			reasonCode: "bash_sensitive_assignment",
		});
	});

	it.each([
		["x".repeat(10_001), "bash_command_oversize"],
		["git\u00a0status", "bash_unicode_whitespace"],
		["git\\ status", "bash_escape_whitespace_ambiguity"],
		["=git status", "bash_cross_shell_ambiguity"],
		["git\0status", "bash_control_character"],
	] as const)("precheck rejects ambiguous input with %s", (command, reasonCode) => {
		expect(precheckBashCommand(command, PARSER_DIGEST)).toMatchObject({
			kind: "too-complex",
			reasonCode,
		});
	});
});
