import { applyBashSemantics } from "./semantics.ts";
import type {
	BashAstClassification,
	CanonicalBashAssignment,
	CanonicalBashRedirect,
	CanonicalSimpleCommand,
	SerializedBashAstNode,
} from "./types.ts";

type WalkResult<T> =
	| { ok: true; value: T }
	| { ok: false; reasonCode: string; nodeType?: string };

const CONTAINER_NODES = new Set([
	"program",
	"list",
	"pipeline",
	"subshell",
	"if_statement",
	"else_clause",
	"while_statement",
	"until_statement",
	"for_statement",
	"do_group",
	"comment",
]);
const WORD_NODES = new Set([
	"word",
	"number",
	"raw_string",
	"string_content",
]);
const ARITHMETIC_NODES = new Set([
	"arithmetic_expansion",
	"binary_expression",
	"unary_expression",
	"parenthesized_expression",
	"number",
	"variable_name",
]);
const SENSITIVE_ASSIGNMENTS = new Set([
	"BASH_ENV",
	"ENV",
	"IFS",
	"LD_PRELOAD",
	"PATH",
	"PS4",
	"SHELLOPTS",
]);

interface Scope {
	values: Map<string, string>;
}

function sourceText(node: SerializedBashAstNode, source: string): string {
	return node.text ?? source.slice(node.startIndex, node.endIndex);
}

function childField(
	node: SerializedBashAstNode,
	field: string,
): SerializedBashAstNode | undefined {
	return node.children.find((child) => child.field === field);
}

function word(
	node: SerializedBashAstNode,
	source: string,
	scope: Scope,
): WalkResult<string> {
	if (WORD_NODES.has(node.type)) return { ok: true, value: sourceText(node, source) };
	if (node.type === "command_name") {
		const child = node.children[0];
		return child
			? word(child, source, scope)
			: { ok: false, reasonCode: "bash_dynamic_executable", nodeType: node.type };
	}
	if (node.type === "simple_expansion") {
		const variable = node.children.find((child) => child.type === "variable_name");
		const name = variable ? sourceText(variable, source) : "";
		const value = scope.values.get(name);
		return value === undefined
			? { ok: false, reasonCode: "bash_dynamic_expansion", nodeType: node.type }
			: { ok: true, value };
	}
	if (node.type === "string" || node.type === "concatenation") {
		let value = "";
		for (const child of node.children) {
			const part = word(child, source, scope);
			if (!part.ok) return part;
			value += part.value;
		}
		return { ok: true, value };
	}
	if (node.type === "arithmetic_expansion") {
		if (!arithmeticIsStatic(node)) {
			return { ok: false, reasonCode: "bash_dynamic_arithmetic", nodeType: node.type };
		}
		return { ok: true, value: sourceText(node, source) };
	}
	return { ok: false, reasonCode: "bash_dynamic_word", nodeType: node.type };
}

function arithmeticIsStatic(node: SerializedBashAstNode): boolean {
	if (!ARITHMETIC_NODES.has(node.type)) return false;
	if (node.type === "variable_name") return false;
	return node.children.every(arithmeticIsStatic);
}

function assignment(
	node: SerializedBashAstNode,
	source: string,
	scope: Scope,
): WalkResult<CanonicalBashAssignment> {
	const nameNode = childField(node, "name") ??
		node.children.find((child) => child.type === "variable_name");
	if (!nameNode) {
		return { ok: false, reasonCode: "bash_assignment_name", nodeType: node.type };
	}
	const name = sourceText(nameNode, source);
	if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name) || SENSITIVE_ASSIGNMENTS.has(name)) {
		return { ok: false, reasonCode: "bash_sensitive_assignment", nodeType: node.type };
	}
	const valueNode = childField(node, "value") ??
		node.children.find((child) => child !== nameNode);
	if (!valueNode) {
		scope.values.set(name, "");
		return { ok: true, value: { name, value: "" } };
	}
	const parsed = word(valueNode, source, scope);
	if (!parsed.ok) return parsed;
	scope.values.set(name, parsed.value);
	return { ok: true, value: { name, value: parsed.value } };
}

function redirect(
	node: SerializedBashAstNode,
	source: string,
	scope: Scope,
): WalkResult<CanonicalBashRedirect> {
	if (node.type !== "file_redirect") {
		return { ok: false, reasonCode: "bash_redirect_unsupported", nodeType: node.type };
	}
	const destination = childField(node, "destination") ?? node.children.at(-1);
	if (!destination) {
		return { ok: false, reasonCode: "bash_redirect_missing", nodeType: node.type };
	}
	const path = word(destination, source, scope);
	if (!path.ok) return path;
	const prefix = sourceText(node, source).slice(0, Math.max(0, destination.startIndex - node.startIndex));
	const operation = prefix.includes(">>")
		? "append" as const
		: prefix.includes("<")
			? "read" as const
			: "write" as const;
	return { ok: true, value: { operation, path: path.value } };
}

function command(
	node: SerializedBashAstNode,
	source: string,
	scope: Scope,
	redirects: readonly CanonicalBashRedirect[] = [],
): WalkResult<CanonicalSimpleCommand | undefined> {
	const assignments: CanonicalBashAssignment[] = [];
	const args: string[] = [];
	let executable: string | undefined;
	for (const child of node.children) {
		if (child.type === "variable_assignment") {
			const parsed = assignment(child, source, scope);
			if (!parsed.ok) return parsed;
			assignments.push(parsed.value);
			continue;
		}
		if (child.type === "command_name") {
			const parsed = word(child, source, scope);
			if (!parsed.ok) return parsed;
			executable = parsed.value;
			continue;
		}
		if (child.type === "file_redirect") {
			const parsed = redirect(child, source, scope);
			if (!parsed.ok) return parsed;
			redirects = [...redirects, parsed.value];
			continue;
		}
		const parsed = word(child, source, scope);
		if (!parsed.ok) return parsed;
		args.push(parsed.value);
	}
	if (!executable) return assignments.length > 0
		? { ok: true, value: undefined }
		: { ok: false, reasonCode: "bash_dynamic_executable", nodeType: node.type };
	const semantic = applyBashSemantics({
		executable,
		arguments: args,
		assignments,
		redirects,
	});
	return semantic.ok
		? { ok: true, value: semantic.command }
		: { ok: false, reasonCode: semantic.reasonCode, nodeType: node.type };
}

function walk(
	node: SerializedBashAstNode,
	source: string,
	scope: Scope,
	commands: CanonicalSimpleCommand[],
): WalkResult<void> {
	if (node.type === "comment") return { ok: true, value: undefined };
	if (node.type === "command" || node.type === "declaration_command" || node.type === "test_command") {
		const parsed = command(node, source, scope);
		if (!parsed.ok) return parsed;
		if (parsed.value) commands.push(parsed.value);
		return { ok: true, value: undefined };
	}
	if (node.type === "variable_assignment") {
		const parsed = assignment(node, source, scope);
		return parsed.ok ? { ok: true, value: undefined } : parsed;
	}
	if (node.type === "redirected_statement") {
		const body = childField(node, "body") ??
			node.children.find((child) => child.type !== "file_redirect");
		if (!body) {
			return { ok: false, reasonCode: "bash_redirect_body_missing", nodeType: node.type };
		}
		const redirects: CanonicalBashRedirect[] = [];
		for (const child of node.children.filter((candidate) => candidate !== body)) {
			const parsed = redirect(child, source, scope);
			if (!parsed.ok) return parsed;
			redirects.push(parsed.value);
		}
		const firstCommand = commands.length;
		const parsed = walk(body, source, scope, commands);
		if (!parsed.ok) return parsed;
		const lastCommand = commands.length - 1;
		if (lastCommand < firstCommand) {
			return {
				ok: false,
				reasonCode: "bash_redirect_body_missing",
				nodeType: body.type,
			};
		}
		const target = commands[lastCommand]!;
		commands[lastCommand] = {
			...target,
			redirects: [...target.redirects, ...redirects],
		};
		return { ok: true, value: undefined };
	}
	if (!CONTAINER_NODES.has(node.type)) {
		return { ok: false, reasonCode: "bash_unknown_node", nodeType: node.type };
	}
	const isolated = node.type === "subshell" ||
		node.type === "if_statement" ||
		node.type === "else_clause" ||
		node.type === "while_statement" ||
		node.type === "until_statement" ||
		node.type === "for_statement";
	const childScope: Scope = isolated
		? { values: new Map(scope.values) }
		: scope;
	for (const child of node.children) {
		if (node.type === "for_statement" && child.field === "variable") continue;
		if (node.type === "for_statement" && child.field === "value") {
			const parsed = word(child, source, childScope);
			if (!parsed.ok) return parsed;
			continue;
		}
		const result = walk(child, source, childScope, commands);
		if (!result.ok) return result;
	}
	return { ok: true, value: undefined };
}

export function classifySerializedBashAst(
	root: SerializedBashAstNode,
	source: string,
	parserDigest: string,
): BashAstClassification {
	const commands: CanonicalSimpleCommand[] = [];
	const result = walk(root, source, { values: new Map() }, commands);
	if (!result.ok) {
		return {
			kind: "too-complex",
			reasonCode: result.reasonCode,
			...(result.nodeType ? { nodeType: result.nodeType } : {}),
			parserDigest,
		};
	}
	return commands.length > 0
		? { kind: "simple", commands, parserDigest }
		: { kind: "too-complex", reasonCode: "bash_no_executable", parserDigest };
}
