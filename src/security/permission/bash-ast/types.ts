export const BASH_AST_COMMAND_MAX_CHARS = 10_000;
export const BASH_AST_DEADLINE_MS = 50;
/** Session composition / fresh replacement worker 的初始化上限，不计入单次 parse 预算。 */
export const BASH_AST_WORKER_STARTUP_DEADLINE_MS = 1_000;
export const BASH_AST_NODE_LIMIT = 50_000;
export const BASH_AST_WORKER_POOL_MAX = 2;
export const BASH_AST_DETAIL_MAX_CHARS = 2_048;

export const BASH_GRAMMAR_REVISION =
	"801326684a26ffc4e749bb016c50c6c30bdfa345";
export const BASH_GRAMMAR_WASM_SHA256 =
	"8292919c88a0f7d3fb31d0cd0253ca5a9531bc1ede82b0537f2c63dd8abe6a7a";
export const TREE_SITTER_RUNTIME_WASM_SHA256 =
	"715cae35f31b7b03a13592bc5ac9039d5c6d2c2bda9f9e0c2b8abab77b3f64cc";
export const BASH_PARSER_DIGEST =
	"cc228d357506ee221fb19ac58d8f7a8d0e9d8b45b37b91166f3a13055b6ef387";

export type BashSecurityAnalyzerMode = "legacy" | "shadow" | "ast";

export interface CanonicalBashAssignment {
	name: string;
	value?: string;
}

export interface CanonicalBashRedirect {
	operation: "read" | "write" | "append";
	path: string;
}

export interface CanonicalSimpleCommand {
	executable: string;
	arguments: readonly string[];
	assignments: readonly CanonicalBashAssignment[];
	redirects: readonly CanonicalBashRedirect[];
}

export type BashAstClassification =
	| {
			kind: "simple";
			commands: readonly CanonicalSimpleCommand[];
			parserDigest: string;
	  }
	| {
			kind: "too-complex";
			reasonCode: string;
			nodeType?: string;
			parserDigest: string;
	  }
	| {
			kind: "parse-unavailable";
			reasonCode: string;
			parserDigest?: string;
	  };

export interface BashAstClassificationMetrics {
	durationBucket: string;
	nodeCountBucket: string;
	nodeCount: number;
}

export interface BashAstClassificationResult {
	classification: BashAstClassification;
	metrics: BashAstClassificationMetrics;
}

export interface SerializedBashAstNode {
	type: string;
	startIndex: number;
	endIndex: number;
	field?: string;
	text?: string;
	children: readonly SerializedBashAstNode[];
}

export interface BashAstAssetPaths {
	runtimeWasm: string;
	grammarWasm: string;
	parserDigest: string;
}

export interface BashShadowTelemetryRecord {
	protocolVersion: 1;
	commandDigest: string;
	mode: "shadow";
	legacyKind: "known" | "unknown";
	astKind: "simple" | "too-complex" | "parse-unavailable";
	commandCountMatches: boolean;
	categoryMatches: boolean;
	reasonCode?: string;
	durationBucket: string;
	nodeCountBucket: string;
	parserDigest?: string;
}

export interface BashShadowTelemetryPort {
	record(record: BashShadowTelemetryRecord): Promise<void>;
}

export interface BashClassificationAuditRecord {
	protocolVersion: 1;
	sessionId: string;
	toolCallId: string;
	requestDigest: string;
	commandDigest: string;
	accessRequestsDigest: string;
	mode: "shadow" | "ast";
	classification: BashAstClassification["kind"];
	configDigest: string;
	parserDigest?: string;
	reasonCode?: string;
	legacyKind?: "known" | "unknown";
	durationBucket: string;
	nodeCountBucket: string;
	authorizationOutcome: "allow" | "deny";
	approvalReceiptId?: string;
}

export interface BashClassificationAuditLinkRecord {
	protocolVersion: 1;
	sessionId: string;
	requestDigest: string;
	constraintSnapshotDigest: string;
	sandboxReceiptDigest?: string;
}

export interface BashClassificationAuditPort {
	record(record: BashClassificationAuditRecord): Promise<void>;
	link?(record: BashClassificationAuditLinkRecord): Promise<void>;
}

export interface BashAnalyzerResolution {
	mode: BashSecurityAnalyzerMode;
	source: "default" | "user" | "project" | "cli" | "managed";
	configDigest: string;
}

export interface BashSecurityAnalysis {
	mode: BashSecurityAnalyzerMode;
	legacyKind?: "known" | "unknown";
	ast?: BashAstClassification;
	metrics?: BashAstClassificationMetrics;
}

export interface BashSecurityAnalyzerStatus {
	resolvedMode: BashSecurityAnalyzerMode;
	source: BashAnalyzerResolution["source"];
	configDigest: string;
	parserDigest: string;
	grammarRevision: string;
	grammarWasmDigest: string;
	runtimeWasmDigest: string;
	workerHealth: "ready" | "degraded" | "unavailable" | "closed";
	lastFailure?: string;
	metrics: {
		total: number;
		simple: number;
		tooComplex: number;
		unavailable: number;
		shadowMatches: number;
		shadowDifferences: number;
	};
}

export interface BashSecurityAnalyzerPort {
	initialize?(): Promise<boolean>;
	analyze(command: string, mode: BashSecurityAnalyzerMode): Promise<BashSecurityAnalysis>;
	status?(): Promise<BashSecurityAnalyzerStatus>;
	close?(): Promise<void>;
}
