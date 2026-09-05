// 上游声明固定模块名 web-tree-sitter；别名运行时使用相同的 Parser/Language/Node API。
declare module "web-tree-sitter-bash" {
	export { Language, Parser, type Node } from "web-tree-sitter";
}
