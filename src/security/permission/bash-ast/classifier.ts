import { randomBytes } from "node:crypto";
import { canonicalDigest } from "../../../runtime/contracts/public.ts";
import { analyzeShellCommand } from "../shell-analyzer.ts";
import { resolveBashAstAssets } from "./assets.ts";
import { BashAstWorkerPool } from "./parser.ts";
import type {
	BashAnalyzerResolution,
	BashAstClassification,
	BashSecurityAnalysis,
	BashSecurityAnalyzerMode,
	BashSecurityAnalyzerPort,
	BashSecurityAnalyzerStatus,
	BashShadowTelemetryPort,
} from "./types.ts";
import {
	BASH_GRAMMAR_REVISION,
	BASH_GRAMMAR_WASM_SHA256,
	BASH_PARSER_DIGEST,
	TREE_SITTER_RUNTIME_WASM_SHA256,
} from "./types.ts";

export interface BashSecurityAnalyzerOptions {
	pool?: BashAstWorkerPool;
	telemetry?: BashShadowTelemetryPort;
	telemetrySalt?: string;
	resolution?: BashAnalyzerResolution;
}

function reasonCode(classification: BashAstClassification): string | undefined {
	return classification.kind === "simple" ? undefined : classification.reasonCode;
}

export class BashSecurityAnalyzer implements BashSecurityAnalyzerPort {
	readonly #pool: BashAstWorkerPool;
	readonly #telemetry?: BashShadowTelemetryPort;
	readonly #telemetrySalt: string;
	readonly #ownsPool: boolean;
	readonly #resolution: BashAnalyzerResolution;
	readonly #metrics = {
		total: 0,
		simple: 0,
		tooComplex: 0,
		unavailable: 0,
		shadowMatches: 0,
		shadowDifferences: 0,
	};
	#lastFailure?: string;
	#closed = false;

	public constructor(options: BashSecurityAnalyzerOptions = {}) {
		this.#pool = options.pool ?? new BashAstWorkerPool();
		this.#ownsPool = options.pool === undefined;
		this.#telemetry = options.telemetry;
		this.#telemetrySalt = options.telemetrySalt ?? randomBytes(32).toString("hex");
		this.#resolution = options.resolution ?? {
			mode: "legacy",
			source: "default",
			configDigest: canonicalDigest({ resolved: "legacy", source: "default" }),
		};
	}

	public async analyze(
		command: string,
		mode: BashSecurityAnalyzerMode,
	): Promise<BashSecurityAnalysis> {
		if (mode === "legacy") {
			this.#metrics.total += 1;
			return {
				mode,
				legacyKind: analyzeShellCommand(command).analysis,
			};
		}
		if (mode === "ast") {
			const result = await this.#pool.classify(command);
			this.#recordClassification(result.classification);
			return { mode, ast: result.classification, metrics: result.metrics };
		}
		const legacy = analyzeShellCommand(command);
		const result = await this.#pool.classify(command);
		this.#recordClassification(result.classification);
		const matches = result.classification.kind === "simple" &&
			result.classification.commands.length === legacy.segments.length &&
			result.classification.commands.every((item, index) =>
				item.executable === legacy.segments[index]?.executable
			);
		if (matches) this.#metrics.shadowMatches += 1;
		else this.#metrics.shadowDifferences += 1;
		try {
			await this.#telemetry?.record({
				protocolVersion: 1,
				commandDigest: canonicalDigest({
					salt: this.#telemetrySalt,
					command,
				}),
				mode: "shadow",
				legacyKind: legacy.analysis,
				astKind: result.classification.kind,
				commandCountMatches: result.classification.kind === "simple"
					? result.classification.commands.length === legacy.segments.length
					: false,
				categoryMatches: result.classification.kind === "simple"
					? result.classification.commands.every((item, index) =>
						item.executable === legacy.segments[index]?.executable
					)
					: false,
				...(reasonCode(result.classification)
					? { reasonCode: reasonCode(result.classification) }
					: {}),
				durationBucket: result.metrics.durationBucket,
				nodeCountBucket: result.metrics.nodeCountBucket,
				...(result.classification.kind === "parse-unavailable" &&
						result.classification.parserDigest === undefined
					? {}
					: { parserDigest: result.classification.parserDigest }),
			});
		} catch {
			// Shadow telemetry 是 best-effort，绝不改变 legacy 授权结果。
		}
		return {
			mode,
			legacyKind: legacy.analysis,
			ast: result.classification,
			metrics: result.metrics,
		};
	}

	public initialize(): Promise<boolean> {
		return this.#pool.initialize();
	}

	#recordClassification(classification: BashAstClassification): void {
		this.#metrics.total += 1;
		if (classification.kind === "simple") {
			this.#metrics.simple += 1;
			return;
		}
		if (classification.kind === "too-complex") {
			this.#metrics.tooComplex += 1;
		} else {
			this.#metrics.unavailable += 1;
		}
		this.#lastFailure = classification.reasonCode.slice(0, 128);
	}

	public async status(): Promise<BashSecurityAnalyzerStatus> {
		const assets = this.#closed ? undefined : await resolveBashAstAssets();
		return {
			resolvedMode: this.#resolution.mode,
			source: this.#resolution.source,
			configDigest: this.#resolution.configDigest,
			parserDigest: assets?.parserDigest ?? BASH_PARSER_DIGEST,
			grammarRevision: BASH_GRAMMAR_REVISION,
			grammarWasmDigest: BASH_GRAMMAR_WASM_SHA256,
			runtimeWasmDigest: TREE_SITTER_RUNTIME_WASM_SHA256,
			workerHealth: this.#closed
				? "closed"
				: !assets
					? "unavailable"
					: this.#metrics.unavailable > 0
						? "degraded"
						: "ready",
			...(this.#lastFailure ? { lastFailure: this.#lastFailure } : {}),
			metrics: { ...this.#metrics },
		};
	}

	public async close(): Promise<void> {
		this.#closed = true;
		if (this.#ownsPool) await this.#pool.close();
	}
}
