/** 单包阶段的实际依赖边界；先消除反向依赖，再执行物理拆包。 */
import { readFileSync, readdirSync } from "node:fs";
import { posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

interface ImportEdge { readonly from: string; readonly to: string; readonly value: boolean }

function sourceEdges(sources: ReadonlyMap<string, string>): ImportEdge[] {
	const edges: ImportEdge[] = [];
	for (const [file, text] of sources) {
		const ast = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
		for (const statement of ast.statements) {
			if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) continue;
			const specifier = statement.moduleSpecifier;
			if (specifier === undefined || !ts.isStringLiteral(specifier)) continue;
			let typeOnly = false;
			if (ts.isImportDeclaration(statement)) {
				const clause = statement.importClause;
				typeOnly = clause?.isTypeOnly === true || (clause?.name === undefined && clause?.namedBindings !== undefined
					&& ts.isNamedImports(clause.namedBindings) && clause.namedBindings.elements.length > 0
					&& clause.namedBindings.elements.every((item) => item.isTypeOnly));
			} else {
				typeOnly = statement.isTypeOnly || (statement.exportClause !== undefined && ts.isNamedExports(statement.exportClause)
					&& statement.exportClause.elements.length > 0 && statement.exportClause.elements.every((item) => item.isTypeOnly));
			}
			const target = specifier.text.startsWith(".") ? posix.normalize(posix.join(posix.dirname(file), specifier.text)) : specifier.text;
			edges.push({ from: file, to: target, value: !typeOnly });
		}
	}
	return edges;
}

export function scanPackageBoundarySources(sources: ReadonlyMap<string, string>): string[] {
	const edges = sourceEdges(sources);
	const problems = new Set<string>();
	for (const edge of edges) {
		if (edge.from.startsWith("src/auth/") && edge.to.startsWith("src/storage/")) problems.add(`auth-storage: ${edge.from} -> ${edge.to}`);
        if (edge.from.startsWith("src/storage/") && edge.to.startsWith("src/tui/")) problems.add(`storage-ui: ${edge.from} -> ${edge.to}`);
		if (edge.from.startsWith("src/contracts/") && !edge.to.startsWith("src/contracts/") && edge.to !== "typebox") problems.add(`contract-dependency: ${edge.from} -> ${edge.to}`);
		if (edge.value && edge.from.startsWith("src/tui/") && edge.from !== "src/tui/index.ts" && edge.to === "src/tui/index.ts") problems.add(`internal-barrel: ${edge.from}`);
	}
	const adjacency = new Map<string, string[]>();
	for (const edge of edges) {
		if (edge.value && edge.from.startsWith("src/tui/") && edge.to.startsWith("src/tui/")) {
			const next = adjacency.get(edge.from) ?? [];
			next.push(edge.to);
			adjacency.set(edge.from, next);
		}
	}
	const visited = new Set<string>();
	const active = new Set<string>();
	const stack: string[] = [];
	function visit(file: string): void {
		if (active.has(file)) { problems.add(`tui-cycle: ${[...stack.slice(stack.indexOf(file)), file].join(" -> ")}`); return; }
		if (visited.has(file)) return;
		visited.add(file); active.add(file); stack.push(file);
		for (const next of adjacency.get(file) ?? []) visit(next);
		stack.pop(); active.delete(file);
	}
	for (const file of adjacency.keys()) visit(file);
	return [...problems].sort();
}

export function readPackageSources(root: string): Map<string, string> {
	return new Map(readdirSync(resolve(root, "src"), { recursive: true }).filter((path): path is string => typeof path === "string" && path.endsWith(".ts"))
		.map((path) => [`src/${path.replaceAll("\\", "/")}`, readFileSync(resolve(root, "src", path), "utf8")]));
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
 const problems = scanPackageBoundarySources(readPackageSources(process.cwd()));
 if (problems.length > 0) {
  for (const problem of problems) process.stderr.write(`${problem}\n`);
  process.exitCode = 1;
 } else process.stdout.write("package boundary check passed\n");
}
