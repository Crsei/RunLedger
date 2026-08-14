import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { parentPort, workerData } from "node:worker_threads";
import { Language, Parser, type Node } from "web-tree-sitter";
import { classifySerializedBashAst } from "./walker.ts";
import { precheckBashCommand } from "./precheck.ts";
import {
	BASH_AST_DEADLINE_MS,
	BASH_AST_NODE_LIMIT,
	BASH_GRAMMAR_WASM_SHA256,
	BASH_PARSER_DIGEST,
	TREE_SITTER_RUNTIME_WASM_SHA256,
	type BashAstClassification,
	type SerializedBashAstNode,
} from "./types.ts";
import {
	BASH_AST_WORKER_PROTOCOL_VERSION,
	type BashAstWorkerData,
	type BashAstWorkerRequest,
	type BashAstWorkerResponse,
} from "./worker-protocol.ts";

function durationBucket(durationMs: number): string {
	if (durationMs <= 5) return "0-5ms";
	if (durationMs <= 10) return "6-10ms";
	if (durationMs <= 25) return "11-25ms";
	if (durationMs <= 50) return "26-50ms";
	return "over-50ms";
}

function nodeCountBucket(nodeCount: number): string {
	if (nodeCount <= 100) return "0-100";
	if (nodeCount <= 1_000) return "101-1000";
	if (nodeCount <= 10_000) return "1001-10000";
	if (nodeCount <= BASH_AST_NODE_LIMIT) return "10001-50000";
	return "over-50000";
}

function safeWorkerData(value: unknown): BashAstWorkerData | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const candidate = value as Partial<BashAstWorkerData>;
	if (
		candidate.protocolVersion !== BASH_AST_WORKER_PROTOCOL_VERSION ||
		typeof candidate.assets !== "object" ||
		candidate.assets === null ||
		typeof candidate.assets.runtimeWasm !== "string" ||
		typeof candidate.assets.grammarWasm !== "string" ||
		candidate.assets.parserDigest !== BASH_PARSER_DIGEST
	) return undefined;
	return candidate as BashAstWorkerData;
}

async function exactDigest(path: string, expected: string): Promise<boolean> {
	try {
		return createHash("sha256").update(await readFile(path)).digest("hex") === expected;
	} catch {
		return false;
	}
}

function serialize(
	node: Node,
	state: { count: number; invalid?: { reasonCode: string; nodeType?: string } },
	field?: string,
): SerializedBashAstNode | undefined {
	state.count += 1;
	if (state.count > BASH_AST_NODE_LIMIT) {
		state.invalid = { reasonCode: "bash_node_budget" };
		return undefined;
	}
	if (node.isError || node.isMissing) {
		state.invalid = {
			reasonCode: node.isMissing ? "bash_missing_node" : "bash_error_node",
			nodeType: node.type,
		};
		return undefined;
	}
	const children: SerializedBashAstNode[] = [];
	for (let index = 0; index < node.namedChildCount; index += 1) {
		const child = node.namedChild(index);
		if (!child) continue;
		const serialized = serialize(
			child,
			state,
			node.fieldNameForNamedChild(index) ?? undefined,
		);
		if (!serialized || state.invalid) return undefined;
		children.push(serialized);
	}
	const retainText = children.length === 0 ||
		node.type === "file_redirect" ||
		node.type === "arithmetic_expansion";
	return {
		type: node.type,
		startIndex: node.startIndex,
		endIndex: node.endIndex,
		...(field ? { field } : {}),
		...(retainText ? { text: node.text } : {}),
		children,
	};
}

function response(
	requestId: string,
	classification: BashAstClassification,
	nodeCount: number,
	startedAt: number,
): BashAstWorkerResponse {
	const durationMs = performance.now() - startedAt;
	return {
		protocolVersion: 1,
		type: "result",
		requestId,
		result: {
			classification,
			metrics: {
				durationBucket: durationBucket(durationMs),
				nodeCountBucket: nodeCountBucket(nodeCount),
				nodeCount,
			},
		},
	};
}

function validRequest(value: unknown): value is BashAstWorkerRequest {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const candidate = value as Partial<BashAstWorkerRequest>;
	return candidate.protocolVersion === 1 &&
		candidate.type === "classify" &&
		typeof candidate.requestId === "string" &&
		typeof candidate.command === "string";
}

async function start(): Promise<void> {
	const data = safeWorkerData(workerData);
	const port = parentPort;
	if (!data || !port) return;
	const exact = await Promise.all([
		exactDigest(data.assets.runtimeWasm, TREE_SITTER_RUNTIME_WASM_SHA256),
		exactDigest(data.assets.grammarWasm, BASH_GRAMMAR_WASM_SHA256),
	]);
	if (!exact.every(Boolean)) {
		port.postMessage({
			protocolVersion: 1,
			type: "failed",
			reasonCode: "bash_wasm_hash_mismatch",
		} satisfies BashAstWorkerResponse);
		return;
	}
	try {
		await Parser.init({ locateFile: () => data.assets.runtimeWasm });
		const language = await Language.load(data.assets.grammarWasm);
		const parser = new Parser();
		parser.setLanguage(language);
		port.postMessage({
			protocolVersion: 1,
			type: "ready",
		} satisfies BashAstWorkerResponse);
		port.on("message", (value: unknown) => {
			if (!validRequest(value)) {
				port.postMessage({
					protocolVersion: 1,
					type: "failed",
					reasonCode: "bash_worker_protocol",
				} satisfies BashAstWorkerResponse);
				return;
			}
			const startedAt = performance.now();
			const prechecked = precheckBashCommand(
				value.command,
				data.assets.parserDigest,
			);
			if (prechecked) {
				port.postMessage(response(value.requestId, prechecked, 0, startedAt));
				return;
			}
			let tree;
			try {
				tree = parser.parse(value.command, null, {
					progressCallback: () => {
						if (performance.now() - startedAt > BASH_AST_DEADLINE_MS) {
							throw new Error("bash_parse_deadline");
						}
					},
				});
			} catch {
				parser.reset();
				port.postMessage(response(value.requestId, {
					kind: "too-complex",
					reasonCode: "bash_parse_deadline",
					parserDigest: data.assets.parserDigest,
				}, 0, startedAt));
				return;
			}
			if (!tree) {
				port.postMessage(response(value.requestId, {
					kind: "too-complex",
					reasonCode: "bash_parse_deadline",
					parserDigest: data.assets.parserDigest,
				}, 0, startedAt));
				return;
			}
			const state: {
				count: number;
				invalid?: { reasonCode: string; nodeType?: string };
			} = { count: 0 };
			const root = serialize(tree.rootNode, state);
			let classification: BashAstClassification;
			if (!root || state.invalid) {
				classification = {
					kind: "too-complex",
					reasonCode: state.invalid?.reasonCode ?? "bash_ast_serialization",
					...(state.invalid?.nodeType
						? { nodeType: state.invalid.nodeType }
						: {}),
					parserDigest: data.assets.parserDigest,
				};
			} else {
				classification = classifySerializedBashAst(
					root,
					value.command,
					data.assets.parserDigest,
				);
			}
			tree.delete();
			port.postMessage(
				response(value.requestId, classification, state.count, startedAt),
			);
		});
	} catch {
		port.postMessage({
			protocolVersion: 1,
			type: "failed",
			reasonCode: "bash_parser_initialization",
		} satisfies BashAstWorkerResponse);
	}
}

void start();
